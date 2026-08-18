#!/usr/bin/env bash
# Vendors ONNX Runtime Web from npm into extension/vendor/ort/.
# Run once, and again whenever ORT is upgraded. The output is gitignored
# (.gitignore excludes **/vendor/ and *.wasm) — it is reproducible from a
# pinned version + hashes, so it does not belong in the repo.
#
# Why this build (spike/FINDINGS.md §8.4):
#   ort.all.bundle.min.mjs + ort-wasm-simd-threaded.jsep.wasm covers BOTH the
#   WebGPU EP and the threaded WASM fallback from one ~26.5 MiB payload.
#   The .bundle. variants inline the Emscripten *glue*, not the wasm binary —
#   but R0 found the glue .mjs is still fetched dynamically in some paths, so we
#   copy the whole ort-wasm-simd-threaded.* set and point wasmPaths at the
#   DIRECTORY (a {wasm: <file url>} map fails with "w is not a function").
#   Threading also spawns a proxy worker from the same directory.
set -euo pipefail

V=1.27.0
DEST="$(cd "$(dirname "$0")/.." && pwd)/extension/vendor/ort"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$DEST"

echo "fetching onnxruntime-web@$V from npm…"
curl -fsSL "https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-$V.tgz" | tar xz -C "$TMP"

cp "$TMP/package/dist/ort.all.bundle.min.mjs" "$DEST/"
cp "$TMP"/package/dist/ort-wasm-simd-threaded.jsep.* "$DEST/"
cp "$TMP"/package/dist/ort-wasm-simd-threaded.mjs "$DEST/" 2>/dev/null || true
echo "$V" > "$DEST/VERSION"

# Pinned hashes measured in Phase 0 (spike/FINDINGS.md §8.4).
verify() {
  local f="$1" want="$2"
  local got; got=$(shasum -a 256 "$DEST/$f" | cut -d' ' -f1)
  if [ "$got" != "$want" ]; then
    echo "HASH MISMATCH $f" >&2; echo "  want $want" >&2; echo "  got  $got" >&2; exit 1
  fi
  echo "  ok $f  $(du -h "$DEST/$f" | cut -f1)"
}
verify ort.all.bundle.min.mjs           e1f340eef7b46a331aa7c2c9aa313cfd47b83f2a1892f4016ecfade0d3005036
verify ort-wasm-simd-threaded.jsep.wasm 78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48

echo "vendored ORT $V -> $DEST"
