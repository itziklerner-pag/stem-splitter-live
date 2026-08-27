#!/usr/bin/env node
/**
 * Does `extension/` actually load as an extension?
 *
 *     node tools/tree-check.mjs
 *
 * WHY THIS FILE EXISTS. It replaces the seam checks that used to live in
 * `tools/build-embed.mjs`, which laid an `embed/` overlay over `extension/` and
 * asserted the result was coherent. The overlay is gone — `extension/` is the
 * extension — but the failure it guarded against is not: a manifest that names a
 * file nobody moved, or an `import` that survived a rename, produces an
 * extension Chrome refuses to load with a message the next person spends twenty
 * minutes on. Every assertion below is about a fact that is true on disk RIGHT
 * NOW or the tree is broken.
 *
 * It is deliberately NOT a build. It reads; it writes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

let fails = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { fails++; console.error(`FAIL ${what}`); } else console.log(`ok   ${what}`); };

const mfPath = path.join(EXT, 'manifest.json');
if (!fs.existsSync(mfPath)) { console.error('tree-check: no extension/manifest.json'); process.exit(1); }
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));

// ------------------------------------------------------------- the surface
//
// The deck is drawn INTO the page. Both halves of that are manifest facts, and
// either one missing is a build that installs and then does nothing.
ok(!mf.side_panel, 'no side panel is declared — the page IS the surface');
ok(!(mf.permissions || []).includes('sidePanel'), 'and no sidePanel permission is requested for a panel that does not exist');
ok(!!(mf.content_scripts && mf.content_scripts.length), 'a content script is declared — otherwise nothing injects the deck');
ok(!!(mf.web_accessible_resources && mf.web_accessible_resources.length),
  'the deck page is web-accessible — otherwise the page could not load the iframe');

/**
 * ONE DECK, asserted as an ABSENCE and as a PRESENCE.
 *
 * The absence alone would pass on a manifest with no commands at all, which is
 * a build whose only arming gesture is the toolbar click — so assert both.
 */
const cmds = Object.keys(mf.commands || {});
ok(cmds.length === 1 && cmds[0] === 'arm-tab',
  `exactly one arm chord is declared (got [${cmds.join(', ')}]) — a second chord is a second deck`);

/**
 * NO EXPORT. `downloads` is the permission the offline-export build needed, and
 * this build has no code that could use it. A permission a build cannot exercise
 * is a review question at submission time and a lie in the install prompt.
 */
ok(!(mf.permissions || []).includes('downloads'),
  'no downloads permission — nothing in this build writes a file');

// -------------------------------------------------- every named path exists
const named = [
  mf.background && mf.background.service_worker,
  ...(mf.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...(mf.web_accessible_resources || []).flatMap((w) => w.resources || []),
  ...Object.values(mf.icons || {}),
].filter(Boolean);
ok(named.length > 0, 'the manifest names at least one file');
for (const rel of named) {
  ok(fs.existsSync(path.join(EXT, rel)), `manifest names ${rel}, which is on disk`);
}

/**
 * EVERY RELATIVE IMPORT RESOLVES, transitively from the manifest's entry points.
 *
 * This is the check the overlay build most needed and the one most likely to rot
 * now: a rename in `engine/` surfaces as a blank panel in a browser twenty
 * minutes from here, not as an error at the site of the edit.
 *
 * The offscreen document is added by hand because only a runtime
 * `chrome.offscreen.createDocument()` names it — no static reference exists for
 * a crawler to follow, which is exactly why it is the file most likely to be
 * missed.
 */
const OFFSCREEN = 'offscreen/offscreen.html';
ok(fs.existsSync(path.join(EXT, OFFSCREEN)), `${OFFSCREEN} is on disk — the service worker creates it by URL, so nothing static points at it`);

const seen = new Set();
const unresolved = [];
function crawl(rel) {
  rel = path.normalize(rel);
  if (seen.has(rel)) return;
  seen.add(rel);
  const abs = path.join(EXT, rel);
  if (!fs.existsSync(abs) || /\.(png|wasm)$/.test(rel)) return;
  const src = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(rel);
  const refs = [];
  // static + dynamic imports, and re-export-from
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,400}?from\s*['"](\.[^'"]+)['"]/g)) refs.push(m[1]);
  for (const m of src.matchAll(/^import\s*['"](\.[^'"]+)['"]/gm)) refs.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) refs.push(m[1]);
  // html <script src> / <link href>, same-directory only
  if (rel.endsWith('.html')) {
    for (const m of src.matchAll(/(?:src|href)=["'](?!https?:|#|data:)([^"']+)["']/g)) refs.push('./' + m[1]);
  }
  for (const r of refs) {
    const target = path.normalize(path.join(dir, r));
    if (!fs.existsSync(path.join(EXT, target))) unresolved.push(`${rel} -> ${r}`);
    else crawl(target);
  }
}
for (const rel of [...named, OFFSCREEN]) crawl(rel);
ok(unresolved.length === 0, `every relative import and asset reference resolves${unresolved.length ? ` — BROKEN: ${unresolved.join(', ')}` : ` (${seen.size} files crawled)`}`);

/**
 * THE VENDORED RUNTIME is not in git (`.gitignore` excludes `**​/vendor/`), so
 * its absence is a SKIP-worthy fact rather than a broken tree — but it must be
 * reported, not silently passed over. A tree-check that says nothing about the
 * 26 MB the extension cannot run without is a check that reports coverage it
 * does not have.
 */
const vendor = path.join(EXT, 'vendor', 'ort');
ok(true, fs.existsSync(vendor)
  ? 'extension/vendor/ort is present — the tree is loadable in Chrome as-is'
  : 'extension/vendor/ort is ABSENT (not in git by design) — run `bash tools/fetch-vendor.sh` before loading unpacked');

/**
 * NOTHING NAMES THE DELETED SURFACES. The console, the overlay directory and the
 * export path were removed together; a live reference to any of them is code
 * that will throw rather than a stale comment, so this is a grep with teeth.
 */
const GONE = ['console-full.js', 'console-full.html', 'ui/console.js', 'ui/console.html', 'offscreen/probe.js'];
const stale = [];
for (const rel of seen) {
  if (/\.(png|wasm)$/.test(rel)) continue;
  const src = fs.readFileSync(path.join(EXT, rel), 'utf8');
  for (const g of GONE) {
    // getURL('...') and import paths are executable references; prose is not.
    const re = new RegExp(`(?:getURL\\(|from\\s*|src=|href=)['"\`][^'"\`]*${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    if (re.test(src)) stale.push(`${rel} -> ${g}`);
  }
}
ok(stale.length === 0, `no file loads a deleted surface${stale.length ? ` — BROKEN: ${stale.join(', ')}` : ''}`);

/**
 * THE VERSION LIVES IN TWO FILES AND NOTHING MADE THEM AGREE. `package.json`
 * and `extension/manifest.json` both carry it, a release bumps both by hand, and
 * until this assertion existed no gate compared them: v0.1.0 and v0.2.0 happened
 * to match because someone remembered, and a release that forgot would have
 * shipped an extension announcing the previous version with nothing red.
 *
 * IT COMPARES THE TWO FILES TO EACH OTHER AND NEVER EITHER TO A LITERAL. A
 * literal here would be a THIRD place the version lives, so the next release
 * would have three to remember instead of two — which is this defect again, one
 * level up. There is deliberately no expected value in this file.
 */
const pkgPath = path.join(ROOT, 'package.json');
const pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
ok(typeof pkgVersion === 'string' && /^\d+\.\d+\.\d+$/.test(pkgVersion)
   && typeof mf.version === 'string' && /^\d+\.\d+\.\d+$/.test(mf.version)
   && pkgVersion === mf.version,
  `package.json and extension/manifest.json declare the SAME version  `
  + `package.json=${pkgVersion}, manifest.json=${mf.version}`);

console.log(fails ? `\n${fails} of ${checks} FAILED` : `\ntree-check: ${checks} checks passed`);
process.exit(fails ? 1 : 0);
