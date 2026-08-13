/**
 * SAM2 client-side feasibility probe — phase 1 of docs/features/sam2-client-side-plan.md.
 *
 * Needs no ResearchSpace stack and no network: it serves onnxruntime-web and the
 * SAM2.1 hiera-tiny ONNX models (runtime-data/assets/no_auth/models/sam2/, see the plan
 * doc for the download script) from disk via route interception on a synthetic
 * https:// origin, so WebGPU gets a secure context inside Playwright's Chromium.
 *
 * Prints, never asserts: adapter info, session-create / encode / decode timings
 * for fp32 and fp16, and a sanity check that a click inside a drawn ellipse
 * yields a mask whose bounding box matches the ellipse.
 *
 * Go/no-go numbers (plan doc): encoder < ~4 s, decoder < ~100 ms on WebGPU.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';

// Headless Chromium defaults WebGPU to SwiftShader (software — minutes per
// encode and broken numerics). Force the real GPU through ANGLE/Metal.
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
const ORT_DIST = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist');
const MODELS = path.join(__dirname, '..', '..', 'runtime-data', 'assets', 'no_auth', 'models', 'sam2');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.onnx_data': 'application/octet-stream',
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>sam2 probe</title></head><body>
<script src="/ort/ort.all.min.js"></script>
<script>
window.probe = async function (variant, encEp, decEp) {
  const out = { variant, encEp, decEp };
  const say = (m) => console.log('[probe] ' + m);
  const t = () => performance.now();
  const suffix = variant === 'fp16' ? '_fp16' : '';

  // --- WebGPU availability -------------------------------------------------
  out.hasNavigatorGpu = !!navigator.gpu;
  out.crossOriginIsolated = self.crossOriginIsolated;
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter();
    out.adapter = adapter ? {
      // info fields vary by Chromium version; take what exists
      ...(adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
                           device: adapter.info.device, description: adapter.info.description } : {}),
      fp16: adapter.features.has('shader-f16'),
    } : null;
    say('adapter: ' + JSON.stringify(out.adapter));
  }

  ort.env.wasm.wasmPaths = '/ort/';

  const fetchBuf = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());

  // --- test image: gradient bg + red ellipse + blue rect -------------------
  const S = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, '#c8c8b4'); grad.addColorStop(1, '#787887');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, S, S);
  const ellipse = { cx: 340, cy: 420, rx: 190, ry: 130 };
  ctx.fillStyle = '#b03028';
  ctx.beginPath();
  ctx.ellipse(ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry, 0, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#2850a0';
  ctx.fillRect(640, 700, 260, 200);
  out.ellipse = ellipse;

  // --- preprocess: (x/255 - mean) / std, CHW -------------------------------
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const rgba = ctx.getImageData(0, 0, S, S).data;
  const pixels = new Float32Array(3 * S * S);
  let t0 = t();
  for (let i = 0, n = S * S; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      pixels[c * n + i] = (rgba[i * 4 + c] / 255 - mean[c]) / std[c];
    }
  }
  out.preprocessMs = t() - t0;

  // --- sessions ------------------------------------------------------------
  // decEp/encEp values: 'webgpu' | 'wasm', with modifiers:
  //   'webgpu-fixed' = webgpu + freeDimensionOverrides (dynamic-shape bug probe)
  //   'wasm-quant'   = wasm + the int8-quantized decoder export
  const mkSession = async (name, ep, dimOverrides) => {
    if (ep === 'wasm-quant') { name = name.replace(suffix, '') + '_quantized'; ep = 'wasm'; }
    if (ep === 'wasm-mt') {
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
      ep = 'wasm';
    } else if (ep === 'wasm') {
      ort.env.wasm.numThreads = 1;
    }
    const fixed = ep === 'webgpu-fixed';
    const opts = {
      executionProviders: [fixed ? 'webgpu' : ep],
      externalData: [{ data: await fetchBuf('/models/' + name + '.onnx_data'),
                       path: name + '.onnx_data' }],
    };
    if (fixed && dimOverrides) opts.freeDimensionOverrides = dimOverrides;
    return ort.InferenceSession.create('/models/' + name + '.onnx', opts);
  };

  t0 = t();
  const encoder = await mkSession('vision_encoder' + suffix, encEp, { batch_size: 1 });
  out.encoderCreateMs = t() - t0;
  say('encoder session (' + encEp + ') created in ' + Math.round(out.encoderCreateMs) + 'ms');
  t0 = t();
  const decoder = await mkSession('prompt_encoder_mask_decoder' + suffix, decEp,
    { batch_size: 1, num_points_per_image: 1, num_boxes_per_image: 0 });
  out.decoderCreateMs = t() - t0;
  say('decoder session (' + decEp + ') created in ' + Math.round(out.decoderCreateMs) + 'ms');
  out.encoderIO = { in: encoder.inputNames, out: encoder.outputNames };
  out.decoderIO = { in: decoder.inputNames, out: decoder.outputNames };

  // --- encode: cold + warm -------------------------------------------------
  const feed = { pixel_values: new ort.Tensor('float32', pixels, [1, 3, S, S]) };
  say('encoding (cold)...');
  t0 = t();
  let enc = await encoder.run(feed);
  out.encodeColdMs = t() - t0;
  say('cold encode ' + Math.round(out.encodeColdMs) + 'ms');
  t0 = t();
  enc = await encoder.run(feed);
  out.encodeWarmMs = t() - t0;
  say('warm encode ' + Math.round(out.encodeWarmMs) + 'ms');
  out.embeddingShapes = Object.fromEntries(encoder.outputNames.map(n => [n, enc[n].dims]));

  // --- decode: point inside the ellipse, several runs ----------------------
  const clickX = ellipse.cx, clickY = ellipse.cy;
  const decodeFeed = {
    input_points: new ort.Tensor('float32', new Float32Array([clickX, clickY]), [1, 1, 1, 2]),
    input_labels: new ort.Tensor('int64', new BigInt64Array([1n]), [1, 1, 1]),
    input_boxes: new ort.Tensor('float32', new Float32Array(0), [1, 0, 4]),
    'image_embeddings.0': enc['image_embeddings.0'],
    'image_embeddings.1': enc['image_embeddings.1'],
    'image_embeddings.2': enc['image_embeddings.2'],
  };
  const decodeTimes = [];
  let dec;
  for (let i = 0; i < 6; i++) {
    t0 = t();
    dec = await decoder.run(decodeFeed);
    decodeTimes.push(t() - t0);
  }
  out.decodeMs = decodeTimes.map(x => Math.round(x * 10) / 10);
  out.maskShape = dec.pred_masks.dims;
  out.iouScores = Array.from(dec.iou_scores.data).map(x => Math.round(x * 1000) / 1000);
  out.objectScore = Array.from(dec.object_score_logits.data);

  // --- sanity: bbox of best mask vs the drawn ellipse ----------------------
  const dims = dec.pred_masks.dims;                       // [1, 1, 3, H, W]
  const H = dims[dims.length - 2], W = dims[dims.length - 1];
  const best = out.iouScores.indexOf(Math.max(...out.iouScores));
  out.bestMask = best;
  const data = dec.pred_masks.data;
  const off = best * H * W;
  let minX = W, minY = H, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[off + y * W + x] > 0) {
        count++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  // IoU of the predicted mask against the analytically-known ellipse, in mask space
  const msx = W / S, msy = H / S;
  let inter = 0, union = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const predicted = data[off + y * W + x] > 0;
      const dx = (x / msx - ellipse.cx) / ellipse.rx, dy = (y / msy - ellipse.cy) / ellipse.ry;
      const truth = dx * dx + dy * dy <= 1;
      if (predicted && truth) inter++;
      if (predicted || truth) union++;
    }
  }
  const sx = S / W, sy = S / H;                           // mask space -> image space
  out.mask = {
    pixelFraction: Math.round((count / (H * W)) * 1000) / 1000,
    ellipseIoU: union ? Math.round((inter / union) * 1000) / 1000 : 0,
    bboxImageSpace: maxX < 0 ? null :
      [Math.round(minX * sx), Math.round(minY * sy), Math.round(maxX * sx), Math.round(maxY * sy)],
    expectedBbox: [ellipse.cx - ellipse.rx, ellipse.cy - ellipse.ry,
                   ellipse.cx + ellipse.rx, ellipse.cy + ellipse.ry],
  };

  encoder.release(); decoder.release();
  return out;
};
</script></body></html>`;

test('sam2 webgpu feasibility', async ({ page }) => {
  test.setTimeout(900_000);
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[probe]') || msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`  [browser ${msg.type()}] ${text.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 300)}`));
  page.on('crash', () => console.log('  [crash] page crashed'));

  // A real localhost server: route.fulfill dies on >100MB bodies (CDP message
  // size), and localhost is a secure context so WebGPU is still available.
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    // COOP/COEP make the page crossOriginIsolated so multi-threaded WASM works;
    // everything is same-origin here so require-corp costs nothing.
    const isolation = {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    };
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', ...isolation });
      return res.end(PAGE);
    }
    let file: string | undefined;
    if (pathname.startsWith('/ort/')) {
      file = path.resolve(ORT_DIST, pathname.slice('/ort/'.length));
      if (!file.startsWith(ORT_DIST + path.sep)) file = undefined;
    } else if (pathname.startsWith('/models/')) {
      file = path.resolve(MODELS, pathname.slice('/models/'.length));
      if (!file.startsWith(MODELS + path.sep)) file = undefined;
    }
    if (!file || !fs.existsSync(file)) {
      console.log(`  [404] ${pathname}`);
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = pathname.includes('.onnx_data') ? '.onnx_data' : path.extname(pathname);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', ...isolation });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html`);

    const runs: Array<[string, string, string]> = [
      // Baseline: decoder on wasm is numerically correct (ellipseIoU ~0.978).
      ['fp32', 'webgpu', 'wasm'],
      // The bug: same decoder on the WebGPU EP returns garbage (iou_scores ~0,
      // mask ~= whole image, ellipseIoU ~0). Keep both rows side by side so a
      // future onnxruntime-web bump can be checked by rerunning this probe.
      ['fp32', 'webgpu', 'webgpu'],
    ];
    for (const [variant, encEp, decEp] of runs) {
      console.log(`\n===== SAM2.1 hiera-tiny ${variant} enc=${encEp} dec=${decEp} =====`);
      try {
        const r = await page.evaluate(
          ([v, e, d]) => (window as any).probe(v, e, d), [variant, encEp, decEp]);
        console.log(JSON.stringify(r, null, 2));
      } catch (e: any) {
        console.log(`  FAILED: ${String(e.message ?? e).slice(0, 500)}`);
      }
    }
  } finally {
    server.close();
  }
});
