#!/usr/bin/env bash
# Downloads the pinned model weights (~109 MB). Not committed: `.gitignore`
# excludes *.onnx, so the repo carries the PIN and never redistributes the file.
#
#   bash tools/fetch-model.sh
#
# The extension fetches the same URL at runtime and hash-verifies it the same
# way. This script exists so the browser gate (`tools/embed-smoke.mjs`) and the
# parity gate (`tools/model-parity.mjs`) can seed from disk instead of pulling
# 109 MB on every run.
#
# THE PIN IS DERIVED, NEVER RE-TYPED. `extension/shared/config.js` is the single
# source of truth for URL / SHA-256 / byte count, and `tools/host.mjs` owns the
# local filename. A second literal in this file is how the copies scattered
# through tools/ drifted last time, so there is not one here. If node cannot
# read them, this script stops.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PIN=$(REPO_ROOT="$ROOT" node -e '
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const root = process.env.REPO_ROOT;
  const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
  Promise.all([mod("extension/shared/config.js"), mod("tools/host.mjs")])
    .then(([cfg, host]) => {
      const m = cfg.MODEL;
      if (!m || !m.url) throw new Error("config.js exports no MODEL.url");
      if (!/^[0-9a-f]{64}$/.test(String(m.sha256))) throw new Error("MODEL.sha256 is not a sha256");
      if (!(Number(m.bytes) > 0)) throw new Error("MODEL.bytes is not a positive integer");
      if (!host.MODEL_SEED_REL) throw new Error("host.mjs exports no MODEL_SEED_REL");
      process.stdout.write([m.url, m.sha256, m.bytes, host.MODEL_SEED_REL].join("\t"));
    })
    .catch((e) => { console.error("cannot read the model pin: " + e.message); process.exit(1); });
') || { echo "FATAL: could not derive the pin from extension/shared/config.js" >&2; exit 1; }

IFS=$'\t' read -r M_URL M_SHA M_BYTES M_REL <<< "$PIN"
[ -n "${M_URL:-}" ] && [ -n "${M_SHA:-}" ] && [ -n "${M_BYTES:-}" ] && [ -n "${M_REL:-}" ] \
  || { echo "FATAL: the pin came back incomplete: '$PIN'" >&2; exit 1; }

DEST="$ROOT/$M_REL"
mkdir -p "$(dirname "$DEST")"

sha () { shasum -a 256 "$1" | cut -d' ' -f1; }
size () { wc -c < "$1" | tr -d ' '; }

echo "pin: $M_REL"
echo "     $M_URL"
echo "     sha256 $M_SHA  ($M_BYTES B)"

if [ -f "$DEST" ] && [ "$(sha "$DEST")" = "$M_SHA" ]; then
  echo "ok   already on disk, hash matches"
  exit 0
fi
[ -f "$DEST" ] && echo "stale $(basename "$DEST") ($(size "$DEST") B) — refetching" >&2

# Download to `.part` and rename only after BOTH checks pass, so an interrupted
# or corrupt fetch cannot leave a plausible-looking file behind. A wrong file
# under the right name does not fail where the mistake was made: the extension
# reports an unexplained SHA-256 mismatch one browser launch later.
if ! curl -fL --progress-bar -o "$DEST.part" "$M_URL"; then
  rm -f "$DEST.part"
  echo "DOWNLOAD FAILED: $M_URL" >&2
  exit 1
fi

GOT_B=$(size "$DEST.part")
if [ "$GOT_B" != "$M_BYTES" ]; then
  rm -f "$DEST.part"
  echo "SIZE MISMATCH: got $GOT_B B, want $M_BYTES B" >&2
  echo "  the pin in extension/shared/config.js and the bytes at $M_URL disagree." >&2
  exit 1
fi

GOT_SHA=$(sha "$DEST.part")
if [ "$GOT_SHA" != "$M_SHA" ]; then
  rm -f "$DEST.part"
  echo "HASH MISMATCH:" >&2
  echo "  got  $GOT_SHA" >&2
  echo "  want $M_SHA" >&2
  echo "  nothing was written. Do NOT work around this by editing the hash." >&2
  exit 1
fi

mv "$DEST.part" "$DEST"
echo "ok   $M_REL  ($(du -h "$DEST" | cut -f1))"
