/**
 * Main-thread facade over the SAM2 segmentation worker.
 *
 * The worker (sam.worker.js in this directory) is a plain-JS classic worker
 * served as a static asset — webpack copies it to /assets/no_auth/sam-worker.js
 * (see webpack/webpack.config.js) so its URL is same-origin in dev and prod
 * and no `import.meta` is needed under this build's `module: commonjs`.
 *
 * Consumers: ImageRegionEditor exposes the singleton as `window.RsSamEngine`
 * for the plain-JS Mirador tool ($.SamLocal). Coordinate contract: encode()
 * takes an ImageBitmap; decode() takes/returns coordinates in that bitmap's
 * own pixel space — mapping to OSD viewport space is the caller's business.
 *
 * Feature plan: docs/features/sam2-client-side-plan.md.
 */

const WORKER_URL = '/assets/no_auth/sam-worker.js';

export interface SamMaskCandidate {
  /** Model confidence (predicted IoU) of this mask. */
  score: number;
  /** Closed polygons in the encoded bitmap's pixel space, largest first. */
  polygons: Array<Array<[number, number]>>;
  /** Low-res translucent preview of the mask; scale to the full bitmap when painting. */
  maskBitmap: ImageBitmap;
}

export interface SamDecodeResult {
  /** SAM2 always proposes 3 masks; bestIndex is the argmax-score one. */
  candidates: SamMaskCandidate[];
  bestIndex: number;
  maskWidth: number;
  maskHeight: number;
  decodeMs: number;
}

export interface SamModelDownloadProgress {
  file: string;
  loaded: number;
  total: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export class SamClientEngine {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initResult: Promise<{ webgpu: boolean }> | undefined;

  /** Fires during the one-time model download (~88MB); use for progress UI. */
  onDownloadProgress: ((progress: SamModelDownloadProgress) => void) | undefined;

  /**
   * True when the engine can plausibly run here: a real WebGPU adapter is
   * present. Deliberately cheap — no worker spawn, no model download — so it
   * can gate the Mirador toolbar at page setup. The heavy initialization
   * (worker, ~88MB model fetch, ORT sessions) happens lazily on first
   * encode(); if ORT then fails despite the adapter, the tool surfaces the
   * error in its status pill at the moment of use.
   */
  isAvailable(): Promise<boolean> {
    const gpu = (navigator as any).gpu;
    if (!gpu) {
      return Promise.resolve(false);
    }
    return Promise.resolve(gpu.requestAdapter())
      .then((adapter: unknown) => !!adapter)
      .catch(() => false);
  }

  /**
   * Compute and cache (worker-side) the embedding for a viewport snapshot.
   * The bitmap is transferred and unusable afterwards. `key` identifies the
   * viewport state; re-encoding an existing key replaces it.
   */
  encode(key: string, bitmap: ImageBitmap): Promise<{ encodeMs: number }> {
    return this.init().then(() => this.request({ op: 'encode', key, bitmap }, [bitmap]));
  }

  /**
   * Run the prompt decoder against a cached embedding. Points (and the
   * optional box [x1,y1,x2,y2]) are in the encoded bitmap's pixel space;
   * labels: 1 = include, 0 = exclude.
   */
  decode(
    key: string,
    points: Array<[number, number]>,
    labels: number[],
    box?: [number, number, number, number]
  ): Promise<SamDecodeResult> {
    return this.request({ op: 'decode', key, points, labels, box });
  }

  /** Drop one cached embedding (call when the viewport pans/zooms). */
  release(key: string): Promise<void> {
    return this.worker ? this.request({ op: 'release', key }) : Promise.resolve();
  }

  /** Drop everything (call when the region editor unmounts). */
  releaseAll(): Promise<void> {
    return this.worker ? this.request({ op: 'releaseAll' }) : Promise.resolve();
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = undefined;
      this.initResult = undefined;
      this.pending.forEach((request) => request.reject(new Error('SamClientEngine disposed')));
      this.pending.clear();
    }
  }

  private init(): Promise<{ webgpu: boolean }> {
    if (!this.initResult) {
      this.initResult = this.request<{ webgpu: boolean }>({ op: 'init' });
    }
    return this.initResult;
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(WORKER_URL);
      this.worker.onmessage = (event: MessageEvent) => {
        const message = event.data;
        if (message.event === 'progress') {
          if (this.onDownloadProgress) {
            this.onDownloadProgress(message as SamModelDownloadProgress);
          }
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) {
          return;
        }
        this.pending.delete(message.id);
        if (message.ok) {
          request.resolve(message);
        } else {
          request.reject(new Error(message.error));
        }
      };
      this.worker.onerror = (event: ErrorEvent) => {
        // A worker-level error (e.g. the static asset missing) fails all
        // in-flight requests; init() failure then makes isAvailable() false.
        const error = new Error('sam worker error: ' + event.message);
        this.pending.forEach((request) => request.reject(error));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private request<T>(message: object, transfer: Transferable[] = []): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...message }, transfer);
    });
  }
}

let singleton: SamClientEngine | undefined;

/** Shared engine instance; also what ImageRegionEditor puts on window.RsSamEngine. */
export function getSamClientEngine(): SamClientEngine {
  if (!singleton) {
    singleton = new SamClientEngine();
  }
  return singleton;
}
