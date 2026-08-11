/**
 * Phase-2 probe for the SAM2 client-side engine (docs/features/sam2-client-side-plan.md).
 *
 * Drives the *built* worker asset (src/main/webapp/assets/no_auth/sam-worker.js —
 * run `npm run prod` or `npm run dev` first) over its postMessage protocol,
 * serving the ORT runtime and the models exactly at the URLs the worker uses
 * in production (/assets/no_auth/ort/, /assets/models/sam2/). No RS stack.
 *
 * Prints, never asserts: init/encode/decode timings, download progress event
 * count, polygon geometry vs a known ellipse in a NON-square viewport (the
 * stretch-mapping case), negative-point behaviour, and OPFS warm-start.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      '--use-angle=metal',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--disable-software-rasterizer',
    ],
  },
});

const REPO = path.join(__dirname, '..', '..');
const NO_AUTH = path.join(REPO, 'src', 'main', 'webapp', 'assets', 'no_auth');
const MODELS = path.join(REPO, 'runtime-data', 'assets', 'models', 'sam2');

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>sam2 worker probe</title></head><body>
<script>
window.probe = async function () {
  const out = {};
  const say = (m) => console.log('[probe] ' + m);
  const t = () => performance.now();

  const W = 900, H = 620; // deliberately non-square: exercises x/y stretch mapping
  const ellipse = { cx: 300, cy: 260, rx: 170, ry: 110 };
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#c8c8b4'); grad.addColorStop(1, '#787887');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#b03028';
  ctx.beginPath();
  ctx.ellipse(ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#2850a0';
  ctx.fillRect(620, 420, 220, 150);

  const mkWorker = () => {
    const worker = new Worker('/assets/no_auth/sam-worker.js');
    let nextId = 1;
    const pending = new Map();
    let progressEvents = 0;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.event === 'progress') { progressEvents++; return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error));
    };
    worker.onerror = (e) => say('worker error: ' + e.message);
    const call = (msg, transfer) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage(Object.assign({ id }, msg), transfer || []);
    });
    return { worker, call, progress: () => progressEvents };
  };

  // --- cold worker: download -> init -> encode -> decode -------------------
  const a = mkWorker();
  let t0 = t();
  const initReply = await a.call({ op: 'init' });
  out.initMs = Math.round(t() - t0);
  out.webgpu = initReply.webgpu;
  out.downloadProgressEvents = a.progress();
  say('init ' + out.initMs + 'ms, webgpu=' + out.webgpu + ', progress events=' + out.downloadProgressEvents);

  const bitmap = await createImageBitmap(canvas);
  t0 = t();
  const enc = await a.call({ op: 'encode', key: 'v1', bitmap }, [bitmap]);
  out.encodeMs = Math.round(enc.encodeMs);
  say('encode ' + out.encodeMs + 'ms');

  const times = [];
  let dec;
  for (let i = 0; i < 4; i++) {
    t0 = t();
    dec = await a.call({ op: 'decode', key: 'v1', points: [[ellipse.cx, ellipse.cy]], labels: [1] });
    times.push(Math.round(t() - t0));
  }
  out.decodeMs = times;
  out.score = Math.round(dec.score * 1000) / 1000;
  out.polygonCount = dec.polygons.length;
  out.polygonPoints = dec.polygons.map((p) => p.length);
  out.maskPreview = dec.maskBitmap ? dec.maskBitmap.width + 'x' + dec.maskBitmap.height : null;
  if (dec.polygons.length) {
    const xs = dec.polygons[0].map((p) => p[0]), ys = dec.polygons[0].map((p) => p[1]);
    out.polygonBbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
    out.expectedBbox = [ellipse.cx - ellipse.rx, ellipse.cy - ellipse.ry, ellipse.cx + ellipse.rx, ellipse.cy + ellipse.ry];
  }

  // negative point on the rectangle must not grow the mask toward it
  const neg = await a.call({ op: 'decode', key: 'v1',
    points: [[ellipse.cx, ellipse.cy], [730, 495]], labels: [1, 0] });
  out.negativeScore = Math.round(neg.score * 1000) / 1000;
  out.negativePolygonCount = neg.polygons.length;

  // decode against an unknown key must fail cleanly
  out.badKeyError = await a.call({ op: 'decode', key: 'nope', points: [[1, 1]], labels: [1] })
    .then(() => 'NO ERROR (bad)', (e) => String(e.message).slice(0, 60));

  // --- warm start: fresh worker, models should come from OPFS --------------
  a.worker.terminate();
  const b = mkWorker();
  t0 = t();
  await b.call({ op: 'init' });
  out.warmInitMs = Math.round(t() - t0);
  out.warmProgressEvents = b.progress(); // expect 0: no re-download
  say('warm init ' + out.warmInitMs + 'ms, progress events=' + out.warmProgressEvents);
  b.worker.terminate();

  return out;
};
</script></body></html>`;

const MIME: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
};

test('sam2 built worker end-to-end', async ({ page }) => {
  test.setTimeout(300_000);
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[probe]') || msg.type() === 'error') {
      console.log(`  [browser ${msg.type()}] ${text.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 300)}`));

  for (const [label, file] of [
    ['worker', path.join(NO_AUTH, 'sam-worker.js')],
    ['ort', path.join(NO_AUTH, 'ort', 'ort.all.min.js')],
    ['model', path.join(MODELS, 'vision_encoder_fp16.onnx')],
  ]) {
    console.log(`  [precheck] ${label}: ${fs.existsSync(file) ? 'present' : 'MISSING — ' + file}`);
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGE);
    }
    let file: string | undefined;
    if (pathname.startsWith('/assets/no_auth/')) {
      file = path.resolve(NO_AUTH, pathname.slice('/assets/no_auth/'.length));
      if (!file.startsWith(NO_AUTH + path.sep)) file = undefined;
    } else if (pathname.startsWith('/assets/models/sam2/')) {
      file = path.resolve(MODELS, pathname.slice('/assets/models/sam2/'.length));
      if (!file.startsWith(MODELS + path.sep)) file = undefined;
    }
    if (!file || !fs.existsSync(file)) {
      console.log(`  [404] ${pathname}`);
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = pathname.includes('.onnx_data') ? '.onnx_data' : path.extname(pathname);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    const result = await page.evaluate(() => (window as any).probe());
    console.log(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log(`  FAILED: ${String(e.message ?? e).slice(0, 500)}`);
  } finally {
    server.close();
  }
});
