/**
 * SAM2 client-side segmentation worker.
 *
 * Deliberately a plain-JS *classic* worker served as a static asset from
 * /assets/no_auth/sam-worker.js (copied there by webpack, see
 * webpack/webpack.config.js) rather than a webpack-bundled module worker:
 * the build's `module: commonjs` forbids `import.meta`, and the dev-server's
 * cross-origin publicPath would make a bundled worker URL unloadable.
 * Keep this file dependency-free; ORT arrives via importScripts below.
 *
 * Numeric contract (execution providers, tensor shapes, preprocessing) is
 * established by probes/tests/sam2-webgpu.standalone.spec.ts — change them
 * together. Key facts from that probe:
 *  - encoder runs on WebGPU (~0.2-0.6s) with a WASM fallback (~8.5s);
 *  - the decoder MUST run on the WASM EP: ORT 1.27's WebGPU EP mis-executes
 *    it (garbage masks, no error). Re-test on ORT upgrades.
 *  - the export resizes to 1024x1024 WITHOUT preserving aspect ratio
 *    (Sam2ImageProcessorFast, default_to_square) — so we stretch, and x/y
 *    map back with independent scale factors.
 *
 * Protocol (postMessage, request/response by id):
 *   {id, op:'init'}                 -> {id, ok, webgpu}
 *   {id, op:'encode', key, bitmap}  -> {id, ok, encodeMs}    (bitmap transferred)
 *   {id, op:'decode', key, points, labels, box?}
 *     -> {id, ok, decodeMs, bestIndex, candidates, maskWidth, maskHeight}
 *        box: optional [x1,y1,x2,y2] in the encoded bitmap's pixel space;
 *        candidates: the model's 3 masks, each {score, polygons, maskBitmap}
 *        with polygons Array<Array<[x,y]>> in the encoded bitmap's pixel
 *        space and maskBitmap an ImageBitmap (transferred) sized
 *        maskWidth x maskHeight; bestIndex = argmax score.
 *   {id, op:'release', key} / {id, op:'releaseAll'} -> {id, ok}
 * Unsolicited: {event:'progress', file, loaded, total} during model download.
 */
/* eslint-disable no-restricted-globals */
'use strict';

importScripts('/assets/no_auth/ort/ort.all.min.js');

var ORT_BASE = '/assets/no_auth/ort/';
var MODEL_BASE = '/assets/models/sam2/'; // AssetFilter -> runtime storage, auth-gated
var OPFS_DIR = 'sam2-models';
var INPUT_SIZE = 1024;
var MASK_SIZE = 256;
var MEAN = [0.485, 0.456, 0.406];
var STD = [0.229, 0.224, 0.225];

// Must stay in lockstep with scripts/fetch-sam2-models.sh (same pinned revision).
var MODELS = {
  encoder: {
    graph: 'vision_encoder_fp16.onnx',
    data: 'vision_encoder_fp16.onnx_data',
    sha256: {
      'vision_encoder_fp16.onnx': '7773e79d589dada8e1e630cc7eb18b17b2c5b4faeb1eaab5ebf9df618ecbd50a',
      'vision_encoder_fp16.onnx_data': 'a4dd3759e9b6a476d991fb3493787992e78777e51462695e1bede71ae258103e',
    },
  },
  decoder: {
    graph: 'prompt_encoder_mask_decoder.onnx',
    data: 'prompt_encoder_mask_decoder.onnx_data',
    sha256: {
      'prompt_encoder_mask_decoder.onnx': '874414704c5d686db7d206a35f6e15d26563d50c8c4468fccc6739bd7e491dcf',
      'prompt_encoder_mask_decoder.onnx_data': 'e9874d900dd4134ed60eab1e97910327c2419e0b2954485d8fd6e7f1a1470f47',
    },
  },
};

ort.env.wasm.wasmPaths = ORT_BASE;

var state = {
  initPromise: null,
  encoderSession: null,
  decoderSession: null,
  webgpu: false,
  // key -> {embeddings: {name: ort.Tensor}, width, height} in source-bitmap px
  embeddings: new Map(),
};

// ---------------------------------------------------------------------------
// Model files: fetch with progress -> sha256 verify -> OPFS cache
// ---------------------------------------------------------------------------

function toHex(buffer) {
  var bytes = new Uint8Array(buffer);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return hex;
}

async function sha256Hex(arrayBuffer) {
  return toHex(await crypto.subtle.digest('SHA-256', arrayBuffer));
}

async function opfsDir() {
  var root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

async function opfsRead(name) {
  try {
    var dir = await opfsDir();
    var handle = await dir.getFileHandle(name);
    var file = await handle.getFile();
    return await file.arrayBuffer();
  } catch (e) {
    return null;
  }
}

async function opfsWrite(name, buffer) {
  var dir = await opfsDir();
  var handle = await dir.getFileHandle(name, { create: true });
  var writable = await handle.createWritable();
  await writable.write(buffer);
  await writable.close();
}

async function fetchWithProgress(name) {
  var response = await fetch(MODEL_BASE + name, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(
      'Fetching ' + name + ' failed with HTTP ' + response.status +
      ' — are the models provisioned? (scripts/fetch-sam2-models.sh)'
    );
  }
  var total = Number(response.headers.get('content-length')) || 0;
  var reader = response.body.getReader();
  var chunks = [];
  var loaded = 0;
  var lastReport = 0;
  for (;;) {
    var step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    loaded += step.value.byteLength;
    var now = performance.now();
    if (now - lastReport > 250) {
      lastReport = now;
      self.postMessage({ event: 'progress', file: name, loaded: loaded, total: total });
    }
  }
  self.postMessage({ event: 'progress', file: name, loaded: loaded, total: total });
  var out = new Uint8Array(loaded);
  var offset = 0;
  for (var i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  return out.buffer;
}

/** Cached-or-fetched model file as ArrayBuffer, sha256-verified on the fetch path. */
async function getModelFile(name, expectedSha) {
  // OPFS content was verified when written; a partial write is the residual
  // risk, so verify cheaply by re-hashing only if sizes look wrong is not
  // possible without a manifest — re-hash always: ~67MB hashes in well under
  // a second with SubtleCrypto and only happens once per session.
  var cached = await opfsRead(name);
  if (cached && (await sha256Hex(cached)) === expectedSha) {
    return cached;
  }
  var fetched = await fetchWithProgress(name);
  var hash = await sha256Hex(fetched);
  if (hash !== expectedSha) {
    throw new Error('sha256 mismatch for ' + name + ': got ' + hash + ' — truncated download or wrong model revision on the server');
  }
  try {
    await opfsWrite(name, fetched);
  } catch (e) {
    // OPFS is an optimization; quota failure must not break segmentation.
  }
  return fetched;
}

async function createSession(model, executionProviders) {
  var graphBuffer = await getModelFile(model.graph, model.sha256[model.graph]);
  var dataBuffer = await getModelFile(model.data, model.sha256[model.data]);
  return ort.InferenceSession.create(graphBuffer, {
    executionProviders: executionProviders,
    // .onnx_data sibling resolved by filename, provided as bytes:
    externalData: [{ data: new Uint8Array(dataBuffer), path: model.data }],
  });
}

async function init() {
  if (!state.initPromise) {
    state.initPromise = (async function () {
      var encoderError = null;
      if (self.navigator && navigator.gpu) {
        try {
          state.encoderSession = await createSession(MODELS.encoder, ['webgpu']);
          state.webgpu = true;
        } catch (e) {
          encoderError = e;
        }
      }
      if (!state.encoderSession) {
        try {
          state.encoderSession = await createSession(MODELS.encoder, ['wasm']);
        } catch (e) {
          throw encoderError || e;
        }
      }
      // Decoder pinned to WASM — see header comment.
      state.decoderSession = await createSession(MODELS.decoder, ['wasm']);
    })();
  }
  await state.initPromise;
  return { webgpu: state.webgpu };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function preprocess(bitmap) {
  var canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Stretch to square — matches the export's Sam2ImageProcessorFast.
  ctx.drawImage(bitmap, 0, 0, INPUT_SIZE, INPUT_SIZE);
  var rgba = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  var n = INPUT_SIZE * INPUT_SIZE;
  var pixels = new Float32Array(3 * n);
  for (var i = 0; i < n; i++) {
    for (var c = 0; c < 3; c++) {
      pixels[c * n + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return new ort.Tensor('float32', pixels, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

async function encode(key, bitmap) {
  await init();
  var t0 = performance.now();
  var pixelValues = preprocess(bitmap);
  var outputs = await state.encoderSession.run({ pixel_values: pixelValues });
  release(key);
  state.embeddings.set(key, {
    embeddings: {
      'image_embeddings.0': outputs['image_embeddings.0'],
      'image_embeddings.1': outputs['image_embeddings.1'],
      'image_embeddings.2': outputs['image_embeddings.2'],
    },
    width: bitmap.width,
    height: bitmap.height,
  });
  bitmap.close();
  return { encodeMs: performance.now() - t0 };
}

function release(key) {
  var entry = state.embeddings.get(key);
  if (entry) {
    Object.keys(entry.embeddings).forEach(function (name) {
      entry.embeddings[name].dispose && entry.embeddings[name].dispose();
    });
    state.embeddings.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Decode: points (source px) -> best mask -> polygons (source px) + preview
// ---------------------------------------------------------------------------

async function decode(key, points, labels, box) {
  var entry = state.embeddings.get(key);
  if (!entry) {
    throw new Error('no embedding for key ' + key + ' — encode() first (or the viewport changed)');
  }
  var t0 = performance.now();

  // source px -> encoder-input px (independent x/y stretch)
  var sx = INPUT_SIZE / entry.width;
  var sy = INPUT_SIZE / entry.height;
  var pointData = new Float32Array(points.length * 2);
  var labelData = new BigInt64Array(labels.length);
  for (var i = 0; i < points.length; i++) {
    pointData[i * 2] = points[i][0] * sx;
    pointData[i * 2 + 1] = points[i][1] * sy;
    labelData[i] = BigInt(labels[i]);
  }
  var boxData = box
    ? new Float32Array([box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy])
    : new Float32Array(0);

  var outputs = await state.decoderSession.run({
    input_points: new ort.Tensor('float32', pointData, [1, 1, points.length, 2]),
    input_labels: new ort.Tensor('int64', labelData, [1, 1, points.length]),
    input_boxes: new ort.Tensor('float32', boxData, [1, box ? 1 : 0, 4]),
    'image_embeddings.0': entry.embeddings['image_embeddings.0'],
    'image_embeddings.1': entry.embeddings['image_embeddings.1'],
    'image_embeddings.2': entry.embeddings['image_embeddings.2'],
  });

  var iou = outputs.iou_scores.data;      // [1, 1, 3]
  var maskData = outputs.pred_masks.data; // [1, 1, 3, 256, 256] logits
  var mx = entry.width / MASK_SIZE;
  var my = entry.height / MASK_SIZE;

  var candidates = [];
  var maskBitmaps = [];
  var best = 0;
  for (var m = 0; m < 3; m++) {
    if (iou[m] > iou[best]) best = m;
    var offset = m * MASK_SIZE * MASK_SIZE;
    var binary = new Uint8Array(MASK_SIZE * MASK_SIZE);
    for (var p = 0; p < binary.length; p++) {
      binary[p] = maskData[offset + p] > 0 ? 1 : 0;
    }
    var polygons = traceContours(binary, MASK_SIZE, MASK_SIZE).map(function (loop) {
      return simplify(loop, 0.7).map(function (pt) {
        return [pt[0] * mx, pt[1] * my];
      });
    });
    candidates.push({ score: iou[m], polygons: polygons });
    maskBitmaps.push(renderMaskPreview(binary));
  }

  return {
    result: {
      decodeMs: performance.now() - t0,
      bestIndex: best,
      candidates: candidates,
      maskWidth: MASK_SIZE,
      maskHeight: MASK_SIZE,
    },
    maskBitmaps: maskBitmaps,
  };
}

/** Semi-transparent preview bitmap of the binary mask (scaled up by the caller). */
function renderMaskPreview(binary) {
  var canvas = new OffscreenCanvas(MASK_SIZE, MASK_SIZE);
  var ctx = canvas.getContext('2d');
  var image = ctx.createImageData(MASK_SIZE, MASK_SIZE);
  for (var i = 0; i < binary.length; i++) {
    if (binary[i]) {
      image.data[i * 4] = 30;      // r
      image.data[i * 4 + 1] = 136; // g
      image.data[i * 4 + 2] = 229; // b
      image.data[i * 4 + 3] = 120; // a
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.transferToImageBitmap();
}

// ---------------------------------------------------------------------------
// Contours: marching squares over the binary mask, outer loops only.
// Replaces the server tool's OpenCV findContours+approxPolyDP (`approx_points`).
// ---------------------------------------------------------------------------

var MIN_LOOP_AREA = 12; // mask px^2; drops speckle the decoder sometimes emits

function traceContours(grid, width, height) {
  // Walk pixel-edge boundaries keeping the filled region on the LEFT of the
  // walking direction. On screen (y-down) that traces outer boundaries
  // counter-clockwise — NEGATIVE shoelace area — and holes with positive
  // area; holes are discarded by the sign filter.
  var at = function (x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return grid[y * width + x];
  };
  var visited = new Uint8Array((width + 1) * (height + 1));
  var loops = [];

  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      // Left-boundary pixel: its top-left corner has a downward boundary edge.
      if (at(x, y) === 1 && at(x - 1, y) === 0 && !visited[y * (width + 1) + x]) {
        var loop = walkBoundary(x, y, at, visited, width);
        if (loop && -signedArea(loop) >= MIN_LOOP_AREA) {
          loops.push(loop);
        }
      }
    }
  }
  // Largest first; cap to a sane number of parts for one annotation.
  loops.sort(function (a, b) { return signedArea(a) - signedArea(b); });
  return loops.slice(0, 8);
}

/**
 * Follow boundary edges from the top-left corner of left-boundary pixel
 * (startX, startY). Positions are corner coordinates; directions 0=up,
 * 1=right, 2=down, 3=left. From a corner, direction d is walkable iff it
 * keeps a filled pixel on the left and an empty one on the right:
 *   up:    TL && !TR      right: TR && !BR
 *   down:  BR && !BL      left:  BL && !TL
 * where TL=at(x-1,y-1) TR=at(x,y-1) BL=at(x-1,y) BR=at(x,y).
 * Exactly one direction qualifies except at saddle corners; there we prefer
 * the left turn, which keeps saddles as two separate loops.
 */
function walkBoundary(startX, startY, at, visited, width) {
  var x = startX, y = startY, dir = 2; // down along the pixel's left edge
  var loop = [];
  var guard = 0;
  do {
    if (guard++ > 300000) return null; // malformed grid; refuse to hang
    if (dir === 2) visited[y * (width + 1) + x] = 1;
    loop.push([x, y]);
    if (dir === 0) y -= 1;
    else if (dir === 1) x += 1;
    else if (dir === 2) y += 1;
    else x -= 1;
    if (x === startX && y === startY) break;
    var tl = at(x - 1, y - 1), tr = at(x, y - 1), bl = at(x - 1, y), br = at(x, y);
    var walkable = [tl && !tr, tr && !br, br && !bl, bl && !tl];
    // try left turn, then straight, then right turn (left of dir d is (d+3)%4)
    var candidates = [(dir + 3) % 4, dir, (dir + 1) % 4];
    var next = -1;
    for (var i = 0; i < candidates.length; i++) {
      if (walkable[candidates[i]]) { next = candidates[i]; break; }
    }
    if (next === -1) return null; // disconnected edge graph: malformed grid
    dir = next;
  } while (true);
  return loop;
}

function signedArea(loop) {
  var area = 0;
  for (var i = 0; i < loop.length; i++) {
    var j = (i + 1) % loop.length;
    area += loop[i][0] * loop[j][1] - loop[j][0] * loop[i][1];
  }
  return area / 2;
}

/** Ramer–Douglas–Peucker on a closed loop (split at the two farthest points). */
function simplify(loop, epsilon) {
  if (loop.length < 8) return loop;
  var half = Math.floor(loop.length / 2);
  var first = rdp(loop.slice(0, half + 1), epsilon);
  var second = rdp(loop.slice(half).concat([loop[0]]), epsilon);
  return first.slice(0, -1).concat(second.slice(0, -1));
}

function rdp(points, epsilon) {
  if (points.length < 3) return points;
  var start = points[0], end = points[points.length - 1];
  var maxDist = 0, index = 0;
  for (var i = 1; i < points.length - 1; i++) {
    var d = pointLineDistance(points[i], start, end);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist <= epsilon) return [start, end];
  var left = rdp(points.slice(0, index + 1), epsilon);
  var right = rdp(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

function pointLineDistance(p, a, b) {
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  var t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------

self.onmessage = function (event) {
  var msg = event.data;
  Promise.resolve()
    .then(function () {
      switch (msg.op) {
        case 'init':
          return init();
        case 'encode':
          return encode(msg.key, msg.bitmap);
        case 'decode':
          return decode(msg.key, msg.points, msg.labels, msg.box);
        case 'release':
          release(msg.key);
          return {};
        case 'releaseAll':
          Array.from(state.embeddings.keys()).forEach(release);
          return {};
        default:
          throw new Error('unknown op ' + msg.op);
      }
    })
    .then(function (value) {
      if (value && value.maskBitmaps) {
        // Attach one bitmap per candidate and transfer them all.
        value.result.candidates.forEach(function (candidate, index) {
          candidate.maskBitmap = value.maskBitmaps[index];
        });
        var reply = { id: msg.id, ok: true };
        Object.assign(reply, value.result);
        self.postMessage(reply, value.maskBitmaps);
      } else {
        var plain = { id: msg.id, ok: true };
        Object.assign(plain, value);
        self.postMessage(plain);
      }
    })
    .catch(function (error) {
      self.postMessage({ id: msg.id, ok: false, error: String((error && error.message) || error) });
    });
};
