#!/usr/bin/env bash
# Provision the SAM2 client-side segmentation models.
#
# See docs/features/sam2-client-side-plan.md. The platform owns this recipe;
# the downloaded bytes are third-party artifacts (Meta SAM 2.1, Apache-2.0,
# onnx-community ONNX export) and live in the runtime layer, outside git.
#
# Idempotent: files that already exist with the right sha256 are skipped.
# Override the target directory with SAM2_MODEL_DIR (default: the dev
# runtime layer next to this repo). On the deployment host, point it at the
# instance's runtime-data/assets/models/sam2.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${SAM2_MODEL_DIR:-$REPO_ROOT/runtime-data/assets/models/sam2}"
BASE="https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx"

# file  sha256  size-in-bytes
# (pinned to the revision validated by probes/tests/sam2-webgpu.standalone.spec.ts;
# fp16 encoder + fp32 decoder — the fp16/webgpu decoder is unusable, see plan doc)
MANIFEST="\
vision_encoder_fp16.onnx 7773e79d589dada8e1e630cc7eb18b17b2c5b4faeb1eaab5ebf9df618ecbd50a 314925
vision_encoder_fp16.onnx_data a4dd3759e9b6a476d991fb3493787992e78777e51462695e1bede71ae258103e 67005504
prompt_encoder_mask_decoder.onnx 874414704c5d686db7d206a35f6e15d26563d50c8c4468fccc6739bd7e491dcf 213114
prompt_encoder_mask_decoder.onnx_data e9874d900dd4134ed60eab1e97910327c2419e0b2954485d8fd6e7f1a1470f47 20958208"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$DEST"
echo "Target: $DEST"

while read -r file want_hash want_size; do
  target="$DEST/$file"
  if [ -f "$target" ] && [ "$(sha256 "$target")" = "$want_hash" ]; then
    echo "ok       $file (already present)"
    continue
  fi
  echo "fetching $file ($want_size bytes)..."
  curl -fL --retry 3 -o "$target.tmp" "$BASE/$file"
  got_size=$(wc -c < "$target.tmp" | tr -d ' ')
  got_hash=$(sha256 "$target.tmp")
  if [ "$got_size" != "$want_size" ] || [ "$got_hash" != "$want_hash" ]; then
    echo "FAILED   $file: size=$got_size (want $want_size) sha256=$got_hash (want $want_hash)" >&2
    echo "         A mismatch usually means the upstream repo moved; re-pin via the plan doc." >&2
    rm -f "$target.tmp"
    exit 1
  fi
  mv "$target.tmp" "$target"
  echo "ok       $file"
done <<< "$MANIFEST"

echo "All SAM2 model files verified."
