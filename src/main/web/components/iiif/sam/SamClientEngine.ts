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

import { contours } from 'd3-contour';

const WORKER_URL = '/assets/no_auth/sam-worker.js';

/**
 * Largest-first cap on the parts of one mask, matching what the annotation
 * layer will draw. A mask that fragments past this is a bad prompt, not a
 * shape worth storing in full.
 */
const MAX_PARTS = 8;

/** |shoelace| of a closed ring. */
function ringArea(ring: SamRing): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    area += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1];
  }
  return Math.abs(area) / 2;
}

/** A closed ring of points in the encoded bitmap's pixel space. */
export type SamRing = Array<[number, number]>;
/** Outer ring first, then any holes it encloses (even-odd fill). */
export type SamPolygon = SamRing[];

export interface SamDecodeResult {
  /** Predicted IoU per candidate mask. */
  scores: number[];
  /** Which candidate to show; see chooseCandidate() in the worker. */
  bestIndex: number;
  maskCount: number;
  maskWidth: number;
  maskHeight: number;
  /** Extent, in the encoded bitmap's pixels, that the mask grid covers. */
  regionWidth: number;
  regionHeight: number;
  /** maskCount planes of maskWidth x maskHeight raw logits, back to back. */
  logits: Float32Array;
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
   *
   * `selectedIndex` is the candidate the user currently has on screen. On a
   * refining prompt the worker uses it to stay on the same object instead of
   * re-ranking; pass it whenever a mask is already displayed.
   */
  decode(
    key: string,
    points: Array<[number, number]>,
    labels: number[],
    box?: [number, number, number, number],
    selectedIndex?: number | null
  ): Promise<SamDecodeResult> {
    return this.request({ op: 'decode', key, points, labels, box, selectedIndex });
  }

  /**
   * Contour one candidate's logits into polygons, in the encoded bitmap's
   * pixel space. Outer ring first, then the holes it encloses.
   *
   * Marching squares over the float field, interpolating where it crosses
   * `threshold`, rather than thresholding to a binary mask and walking pixel
   * corners. Measured against a rasterised circle, corner-walking a binary
   * grid carries ~0.6px RMS boundary error and interpolating the same binary
   * grid ~0.22px; interpolating the float field removes it altogether. None
   * of that error came from the model.
   *
   * `threshold` is SAM's mask_threshold — 0 by default, and adjustable
   * because it is the cheapest correction available for material the model
   * is not calibrated on. Re-contouring costs no re-decode.
   */
  buildPolygons(result: SamDecodeResult, index: number, threshold = 0): SamPolygon[] {
    const { maskWidth, maskHeight, logits } = result;
    const plane = maskWidth * maskHeight;
    const values = logits.subarray(index * plane, (index + 1) * plane);
    const geometry = contours()
      .size([maskWidth, maskHeight])
      .thresholds([threshold])(values as unknown as number[])[0];
    // d3 places grid element i,j at <i+0.5, j+0.5>, which is the centre of the
    // mask pixel covering [i*mx, (i+1)*mx] — so the scale is a plain multiply.
    const mx = result.regionWidth / maskWidth;
    const my = result.regionHeight / maskHeight;
    const polygons = geometry.coordinates.map((rings) =>
      rings.map((ring) =>
        ring.map(([x, y]) => [x * mx, y * my] as [number, number])
      )
    );
    return polygons
      .sort((a, b) => ringArea(b[0]) - ringArea(a[0]))
      .slice(0, MAX_PARTS);
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
