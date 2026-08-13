#!/usr/bin/env bash
# Provision the SAM2 client-side segmentation models.
#
# See docs/features/sam2-client-side-plan.md. The platform owns this recipe;
# the downloaded bytes are third-party artifacts (Meta SAM 2.1, Apache-2.0,
# onnx-community ONNX export) and live in the runtime layer, outside git.
#
# Idempotent: files that already exist with the right sha256 are skipped.
#
# Usage: fetch-sam2-models.sh [--model tiny|small|base_plus|all] [TARGET_DIR]
#
# The runtime layer is not in the same place on every host, so the target is
# an argument. Precedence: the argument, then $SAM2_MODEL_DIR, then the dev
# runtime layer next to this repo. On a deployment host pass that instance's
# runtime assets directory, e.g.
#
#   scripts/fetch-sam2-models.sh /srv/researchspace/runtime-data/assets/models/sam2
#
# --model picks the set (default tiny, the only one the tool loads unless a
# user opts into a bigger one). tiny lands in TARGET_DIR itself so that hosts
# provisioned before the switcher existed keep working; every other set lands
# in a subdirectory of the same name, matching sam.worker.js.
#
#   scripts/fetch-sam2-models.sh --model small      # adds ~102 MB under small/
#   scripts/fetch-sam2-models.sh --model base_plus  # adds ~174 MB
#   scripts/fetch-sam2-models.sh --model all        # ~365 MB in total
set -euo pipefail

usage() {
  # Everything between the shebang and the first line of code, unprefixed —
  # so the help text cannot drift out of step with the header comment.
  sed -e '1d' -e '/^[^#]/,$d' "$0" | sed 's/^#\{1,\} \{0,1\}//'
  exit "${1:-0}"
}

MODEL=tiny
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --model) MODEL="${2:-}"; shift; shift || true ;;
    --model=*) MODEL="${1#--model=}"; shift ;;
    -*) echo "Unknown option: $1" >&2; usage 1 ;;
    *) break ;;
  esac
done

case "$MODEL" in
  tiny|small|base_plus|all) ;;
  *) echo "Unknown model \"$MODEL\" — expected tiny, small, base_plus or all." >&2; usage 1 ;;
esac

if [ "$#" -gt 1 ]; then
  echo "Expected at most one target directory, got $#." >&2
  usage 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-${SAM2_MODEL_DIR:-$REPO_ROOT/runtime-data/assets/models/sam2}}"

# file  sha256  size-in-bytes, per set.
# (tiny is the revision validated by probes/tests/sam2-webgpu.standalone.spec.ts;
# fp16 encoder + fp32 decoder throughout — the fp16/webgpu decoder is unusable
# at any size, see plan doc. These hashes must match sam.worker.js exactly.)
MANIFEST_tiny="\
vision_encoder_fp16.onnx 7773e79d589dada8e1e630cc7eb18b17b2c5b4faeb1eaab5ebf9df618ecbd50a 314925
vision_encoder_fp16.onnx_data a4dd3759e9b6a476d991fb3493787992e78777e51462695e1bede71ae258103e 67005504
prompt_encoder_mask_decoder.onnx 874414704c5d686db7d206a35f6e15d26563d50c8c4468fccc6739bd7e491dcf 213114
prompt_encoder_mask_decoder.onnx_data e9874d900dd4134ed60eab1e97910327c2419e0b2954485d8fd6e7f1a1470f47 20958208"

MANIFEST_small="\
vision_encoder_fp16.onnx f236074c31a7ba9d1e00362e8c29cb95bf9dcdd61e208048493902878d9dc4db 422501
vision_encoder_fp16.onnx_data 557e013522bace72a6b8441f66747f1c4b2a237d1e3c86f84dba86b6d814ec1f 81182784
prompt_encoder_mask_decoder.onnx 079c59b261f723ff5c6a125e69b0170a957b21c58738c28d2b0394ecd0587d7f 213114
prompt_encoder_mask_decoder.onnx_data f9e59a584ab8ced21fa812c211bc01084204db1c9e92a5ef4fb3a49972b4e864 20958208"

MANIFEST_base_plus="\
vision_encoder_fp16.onnx cb9324a431bfb78c70e4ead1ffb80766e236b50decd55c236c8eada4f0afde96 643078
vision_encoder_fp16.onnx_data 78be422d399181ce3af00130409ebe32eb5b95825e7fe290440fbfaac70b99b4 152780640
prompt_encoder_mask_decoder.onnx f39eeec20243ed1c8f2cd013812e77813d937ddbc800fa4bc703761adc7e63cd 213114
prompt_encoder_mask_decoder.onnx_data 445cd3f72a218815db10e336f4f1c46a6eb2713a0160a85af5365134607f32a7 20958208"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if ! mkdir -p "$DEST" 2>/dev/null; then
  echo "Cannot create $DEST — check the path and write permissions." >&2
  echo "On a deployment host the runtime layer is usually owned by the service user." >&2
  exit 1
fi
# Absolute, so a relative argument still reports where the bytes actually went.
DEST="$(cd "$DEST" && pwd)"
echo "Target: $DEST"

# tiny stays at the root of DEST; anything else gets its own subdirectory,
# because the filenames are identical across model sizes.
fetch_set() {
  local model="$1" base manifest dir
  case "$model" in
    tiny)
      base="https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/main/onnx"
      manifest="$MANIFEST_tiny"; dir="$DEST" ;;
    small)
      base="https://huggingface.co/onnx-community/sam2.1-hiera-small-ONNX/resolve/main/onnx"
      manifest="$MANIFEST_small"; dir="$DEST/small" ;;
    base_plus)
      base="https://huggingface.co/onnx-community/sam2.1-hiera-base-plus-ONNX/resolve/main/onnx"
      manifest="$MANIFEST_base_plus"; dir="$DEST/base_plus" ;;
  esac
  mkdir -p "$dir"
  echo "--- $model -> $dir"
  while read -r file want_hash want_size; do
    target="$dir/$file"
    if [ -f "$target" ] && [ "$(sha256 "$target")" = "$want_hash" ]; then
      echo "ok       $file (already present)"
      continue
    fi
    echo "fetching $file ($want_size bytes)..."
    curl -fL --retry 3 -o "$target.tmp" "$base/$file"
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
  done <<< "$manifest"
}

if [ "$MODEL" = all ]; then
  fetch_set tiny
  fetch_set small
  fetch_set base_plus
else
  fetch_set "$MODEL"
fi

echo "All SAM2 model files verified."
