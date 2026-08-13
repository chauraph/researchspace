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
 *   {id, op:'decode', key, points, labels, box?, selectedIndex?}
 *     -> {id, ok, decodeMs, bestIndex, scores, maskCount, maskWidth,
 *         maskHeight, regionWidth, regionHeight, logits}
 *        box: optional [x1,y1,x2,y2] in the encoded bitmap's pixel space;
 *        logits: Float32Array (transferred) of maskCount planes of
 *        maskWidth x maskHeight raw mask logits. Geometry is NOT produced
 *        here — SamClientEngine contours the float field, which is both more
 *        accurate than thresholding first and what lets the threshold move
 *        without a re-decode. selectedIndex is the candidate currently shown,
 *        used to keep a refining prompt on the same object.
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
var MEAN = [0.485, 0.456, 0.406];
var STD = [0.229, 0.224, 0.225];

// Must stay in lockstep with scripts/fetch-sam2-models.sh (same pinned
// revisions). Every set is fp16 encoder + fp32 decoder: the fp16/webgpu decoder
// is unusable (IoU 0 — see the plan doc), and that is a property of the export,
// not of the model size.
//
// tiny's dir is '' so that hosts provisioned before the switcher existed keep
// working untouched, and their OPFS cache entries stay valid. Larger sets live
// in a subdirectory because the filenames are identical across sizes.
var DEFAULT_MODEL = 'tiny';
var MODEL_SETS = {
  tiny: {
    dir: '',
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
  },
  small: {
    dir: 'small/',
    encoder: {
      graph: 'vision_encoder_fp16.onnx',
      data: 'vision_encoder_fp16.onnx_data',
      sha256: {
        'vision_encoder_fp16.onnx': 'f236074c31a7ba9d1e00362e8c29cb95bf9dcdd61e208048493902878d9dc4db',
        'vision_encoder_fp16.onnx_data': '557e013522bace72a6b8441f66747f1c4b2a237d1e3c86f84dba86b6d814ec1f',
      },
    },
    decoder: {
      graph: 'prompt_encoder_mask_decoder.onnx',
      data: 'prompt_encoder_mask_decoder.onnx_data',
      sha256: {
        'prompt_encoder_mask_decoder.onnx': '079c59b261f723ff5c6a125e69b0170a957b21c58738c28d2b0394ecd0587d7f',
        'prompt_encoder_mask_decoder.onnx_data': 'f9e59a584ab8ced21fa812c211bc01084204db1c9e92a5ef4fb3a49972b4e864',
      },
    },
  },

  base_plus: {
    dir: 'base_plus/',
    encoder: {
      graph: 'vision_encoder_fp16.onnx',
      data: 'vision_encoder_fp16.onnx_data',
      sha256: {
        'vision_encoder_fp16.onnx': 'cb9324a431bfb78c70e4ead1ffb80766e236b50decd55c236c8eada4f0afde96',
        'vision_encoder_fp16.onnx_data': '78be422d399181ce3af00130409ebe32eb5b95825e7fe290440fbfaac70b99b4',
      },
    },
    decoder: {
      graph: 'prompt_encoder_mask_decoder.onnx',
      data: 'prompt_encoder_mask_decoder.onnx_data',
      sha256: {
        'prompt_encoder_mask_decoder.onnx': 'f39eeec20243ed1c8f2cd013812e77813d937ddbc800fa4bc703761adc7e63cd',
        'prompt_encoder_mask_decoder.onnx_data': '445cd3f72a218815db10e336f4f1c46a6eb2713a0160a85af5365134607f32a7',
      },
    },
  },
};

ort.env.wasm.wasmPaths = ORT_BASE;

var state = {
  modelId: DEFAULT_MODEL,
  initPromise: null,
  encoderSession: null,
  decoderSession: null,
  webgpu: false,
  // key -> {embeddings: {name: ort.Tensor}, width, height} in source-bitmap px
  embeddings: new Map(),
  // Binary masks of the previous decode, so a refining click can stay on the
  // object it was refining rather than re-running argmax (chooseCandidate).
  lastBinaries: null,
  lastBinariesKey: null,
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

async function fetchWithProgress(path, name) {
  var response = await fetch(MODEL_BASE + path, { credentials: 'same-origin' });
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

/**
 * Cached-or-fetched model file as ArrayBuffer, sha256-verified on the fetch
 * path. `dir` selects the model set; the OPFS key carries it too, so two sets
 * that share a filename cannot collide in the cache.
 */
async function getModelFile(dir, name, expectedSha) {
  var path = dir + name;
  var cacheName = dir.replace('/', '-') + name;
  // OPFS content was verified when written; a partial write is the residual
  // risk, so verify cheaply by re-hashing only if sizes look wrong is not
  // possible without a manifest — re-hash always: ~67MB hashes in well under
  // a second with SubtleCrypto and only happens once per session.
  var cached = await opfsRead(cacheName);
  if (cached && (await sha256Hex(cached)) === expectedSha) {
    return cached;
  }
  var fetched = await fetchWithProgress(path, name);
  var hash = await sha256Hex(fetched);
  if (hash !== expectedSha) {
    throw new Error('sha256 mismatch for ' + path + ': got ' + hash + ' — truncated download or wrong model revision on the server');
  }
  try {
    await opfsWrite(cacheName, fetched);
  } catch (e) {
    // OPFS is an optimization; quota failure must not break segmentation.
  }
  return fetched;
}

async function createSession(set, part, executionProviders) {
  var model = set[part];
  var graphBuffer = await getModelFile(set.dir, model.graph, model.sha256[model.graph]);
  var dataBuffer = await getModelFile(set.dir, model.data, model.sha256[model.data]);
  return ort.InferenceSession.create(graphBuffer, {
    executionProviders: executionProviders,
    // .onnx_data sibling resolved by filename, provided as bytes:
    externalData: [{ data: new Uint8Array(dataBuffer), path: model.data }],
  });
}

async function init() {
  if (!state.initPromise) {
    var set = MODEL_SETS[state.modelId];
    state.initPromise = (async function () {
      var encoderError = null;
      if (self.navigator && navigator.gpu) {
        try {
          state.encoderSession = await createSession(set, 'encoder', ['webgpu']);
          state.webgpu = true;
        } catch (e) {
          encoderError = e;
        }
      }
      if (!state.encoderSession) {
        try {
          state.encoderSession = await createSession(set, 'encoder', ['wasm']);
        } catch (e) {
          throw encoderError || e;
        }
      }
      // Decoder pinned to WASM — see header comment.
      state.decoderSession = await createSession(set, 'decoder', ['wasm']);
    })();
  }
  await state.initPromise;
  return { webgpu: state.webgpu, model: state.modelId };
}

/**
 * Switch model sets. Embeddings are tensors produced BY the old encoder and
 * meaningless to the new one, so they are dropped rather than kept: a stale
 * embedding decoded against a different decoder is silent nonsense, not an
 * error. The caller must re-encode.
 */
async function setModel(id) {
  if (!MODEL_SETS[id]) {
    throw new Error('Unknown model "' + id + '" — expected one of ' + Object.keys(MODEL_SETS).join(', '));
  }
  if (id === state.modelId && state.initPromise) {
    return { webgpu: state.webgpu, model: state.modelId, changed: false };
  }
  // Wait for any in-flight init before tearing its sessions down.
  if (state.initPromise) {
    try { await state.initPromise; } catch (e) { /* replacing it anyway */ }
  }
  [state.encoderSession, state.decoderSession].forEach(function (session) {
    if (session && session.release) {
      try { session.release(); } catch (e) { /* best effort */ }
    }
  });
  state.encoderSession = null;
  state.decoderSession = null;
  state.initPromise = null;
  state.webgpu = false;
  state.embeddings.clear();
  state.lastBinaries = null;
  state.lastBinariesKey = null;
  state.modelId = id;
  var ready = await init();
  return { webgpu: ready.webgpu, model: state.modelId, changed: true };
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

async function decode(key, points, labels, box, selectedIndex) {
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
  var maskData = outputs.pred_masks.data; // [1, 1, n, h, w] logits
  // P20: the graph declares pred_masks' trailing dims dynamic
  // (Slicepred_masks_dim_3/4), so read them rather than trusting MASK_SIZE —
  // a re-export that changes them would otherwise silently read garbage.
  var dims = outputs.pred_masks.dims;
  var maskW = dims[dims.length - 1];
  var maskH = dims[dims.length - 2];
  var maskCount = Math.min(iou.length, dims[dims.length - 3]);
  var planeSize = maskW * maskH;

  // The logits go to the main thread untouched, and the contour is taken from
  // them there. Thresholding here and tracing the resulting binary was the
  // dominant source of boundary error: against a rasterised circle it cost
  // ~0.6px RMS, all of it binarisation, none of it the model. Contouring the
  // float field removes that. It also puts the threshold on the main thread,
  // where it can be moved without a re-decode.
  var logits = new Float32Array(maskCount * planeSize);
  logits.set(maskData.subarray(0, maskCount * planeSize));

  // Binary masks are still needed here, but only to compare candidates
  // against the previously selected one (P1).
  var binaries = [];
  for (var m = 0; m < maskCount; m++) {
    var offset = m * planeSize;
    var binary = new Uint8Array(planeSize);
    for (var p = 0; p < planeSize; p++) {
      binary[p] = logits[offset + p] > 0 ? 1 : 0;
    }
    binaries.push(binary);
  }

  var best = chooseCandidate(iou, binaries, key, points.length, !!box, selectedIndex);
  state.lastBinaries = binaries;
  state.lastBinariesKey = key;

  return {
    result: {
      decodeMs: performance.now() - t0,
      bestIndex: best,
      scores: Array.prototype.slice.call(iou, 0, maskCount),
      maskCount: maskCount,
      maskWidth: maskW,
      maskHeight: maskH,
      // Engine-space extent the mask covers, so the main thread can scale
      // contour coordinates without knowing anything about the region.
      regionWidth: entry.width,
      regionHeight: entry.height,
      logits: logits,
    },
    transfer: [logits.buffer],
  };
}

/**
 * Which of the ambiguity masks to surface (P1).
 *
 * Upstream resolves this in SamOnnxModel.select_masks by reweighting the IoU
 * scores so a single click keeps the ambiguity masks while two or more points
 * collapse onto the decoder's dedicated single-mask token. That token is not
 * reachable here: this export emits only the three multimask outputs — the
 * slice SAM2 takes when multimask_output=True — so the mechanism has to
 * differ even though the intent carries over. Once the prompt stops being
 * ambiguous we stop re-ranking and stay on whatever the user was already
 * refining, identified by overlap with the mask they last had selected.
 * Re-running argmax on every added point is what makes a correcting click
 * jump to a different object.
 */
function chooseCandidate(iou, binaries, key, pointCount, hasBox, selectedIndex) {
  var argmax = 0;
  for (var i = 1; i < iou.length; i++) {
    if (iou[i] > iou[argmax]) argmax = i;
  }
  // A fresh prompt (hover, first click, a new drag-box) is genuinely
  // ambiguous — rank it, and let M cycle. Only a *continued* prompt sticks.
  var refining = pointCount >= 2 || (hasBox && pointCount >= 1);
  if (!refining || selectedIndex === null || selectedIndex === undefined) {
    return argmax;
  }
  if (state.lastBinariesKey !== key || !state.lastBinaries) {
    return argmax;
  }
  var reference = state.lastBinaries[selectedIndex];
  if (!reference) {
    return argmax;
  }
  var best = argmax;
  var bestScore = 0;
  for (var m = 0; m < binaries.length; m++) {
    var score = maskIou(binaries[m], reference);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

/** IoU of two equally-sized binary masks; 0 when they cannot be compared. */
function maskIou(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  var intersection = 0, union = 0;
  for (var i = 0; i < a.length; i++) {
    if (a[i] & b[i]) intersection++;
    if (a[i] | b[i]) union++;
  }
  return union ? intersection / union : 0;
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
          return decode(msg.key, msg.points, msg.labels, msg.box, msg.selectedIndex);
        case 'setModel':
          return setModel(msg.model);
        case 'release':
          release(msg.key);
          return {};
        case 'releaseAll':
          Array.from(state.embeddings.keys()).forEach(release);
          return {};
        default:
          // Almost always a cached worker script from an older build rather
          // than a real bug — say so, because the file is invisible to the user.
          throw new Error('unknown op ' + msg.op
            + ' — this worker build predates it; reload the page to pick up the current one');
      }
    })
    .then(function (value) {
      var reply = { id: msg.id, ok: true };
      if (value && value.result) {
        Object.assign(reply, value.result);
        self.postMessage(reply, value.transfer || []);
      } else {
        Object.assign(reply, value);
        self.postMessage(reply);
      }
    })
    .catch(function (error) {
      self.postMessage({ id: msg.id, ok: false, error: String((error && error.message) || error) });
    });
};
