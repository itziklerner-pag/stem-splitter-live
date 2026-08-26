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
 * NO `chrome.downloads`, WHICH IS NOT THE SAME CLAIM AS "NO EXPORT" — and the
 * message under this assertion made the wider one until ADR 0002.
 *
 * What is checked has not moved: `downloads` is the permission the offline-export
 * build needed, this build still does not request it, and a permission a build
 * cannot exercise is a review question at submission time and a lie in the
 * install prompt. ADR 0002 decision 1 keeps this assertion byte for byte and
 * narrows only the message, because the assertion was always the sound half.
 *
 * WHAT IT NEVER CHECKED. An extension-origin page can mint a `Blob` and click an
 * `<a download>` with no permission at all, and could have on the day this line
 * was written. Since ADR 0002 the deck does exactly that, once, for one kind of
 * file: `DeckHost.deliver(name, bytes, mime)` hands over a MIDI pack. So the
 * property that actually holds is narrower than the old message claimed —
 * *the extension cannot produce a user-accessible file that reproduces the
 * captured audio* — and a `.mid` carries no samples, no timbre and no
 * performance.
 *
 * WHERE THAT PROPERTY IS ENFORCED, since it is not enforced here:
 * `assertDeliverable` in `extension/shared/midi.js` allows exactly
 * `{application/zip, audio/midi}` and looks INSIDE the zip for `MThd` on every
 * entry, and `qa/midi-pack.mjs` is the gate that can fail — it builds a real
 * pack, and it builds a pack with a WAV in it and asserts the guard refuses it.
 * A grep is defeated by a reference assembled at run time; a capability the
 * browser never granted is not, which is the whole reason the permission stays
 * absent and this assertion stays.
 */
ok(!(mf.permissions || []).includes('downloads'),
  'no downloads permission — this build cannot use chrome.downloads');

/**
 * ...AND THE DECK'S IFRAME IS NOT SANDBOXED, which is the load-bearing fact a
 * hardening pass would break in good faith and in silence.
 *
 * `sandbox` on an iframe is an ALLOWLIST: the attribute drops every capability
 * and hands back only what it names. `allow-downloads` is one of the ones it
 * drops, so `sandbox="allow-scripts allow-same-origin"` on the deck frame — the
 * spelling a hardening pass reaches for, and the one that turns this red — takes
 * the anchor click with it and the pack never leaves. Nothing throws: Chrome
 * logs a line in the frame's own console, which nobody is watching, and the
 * button looks like it did nothing.
 *
 * TWO ASSERTIONS, BECAUSE ONE OF THEM CANNOT LOOK ON ITS OWN. A grep that finds
 * no `sandbox` in a file it failed to find, or in a file that stopped mounting
 * the deck, is a green that means nothing. So the first names the mounter — the
 * declared content script whose source names the deck page — and goes red if
 * there is not exactly one, and the second is the property, over the file the
 * first one found.
 *
 * The needle is deliberately the whole file rather than the `mount()` body: it
 * creates exactly one iframe, so a `sandbox` anywhere in it is about the deck.
 * A mention of the word in prose is not matched (all three spellings are
 * assignments or `setAttribute`), and a false red here is the safe direction —
 * it is a line somebody reads.
 *
 * WHAT IT CANNOT SEE, stated rather than left as an absence: an attribute name
 * assembled from a variable — `el[k] = v`, `setAttribute(k, v)` — is invisible
 * to this, the same blind spot the import crawl below has about a computed
 * specifier. Closing it needs a parser, not a wider regex.
 *
 * WATCHED GOING RED before it was gated, each edit applied alone to
 * `extension/content.js` and reverted:
 *
 *   - `frame.sandbox = 'allow-scripts allow-same-origin'` beside `frame.allow`
 *     — 21 of 22, and the red names the file.
 *   - `frame.setAttribute('sandbox', 'allow-scripts')` — 21 of 22, same red;
 *     the property and the attribute are two spellings of one mistake.
 *   - the mounter no longer naming the deck page (`ui/embed.html` ->
 *     `ui/embed2.html`) — 20 of 22: the control fires first, and the property
 *     below it says NO MOUNTER FOUND rather than reporting a clean scan of
 *     nothing.
 */
const deckPage = (mf.web_accessible_resources || []).flatMap((w) => w.resources || [])
  .find((r) => r.endsWith('.html'));
const mounters = (mf.content_scripts || []).flatMap((c) => c.js || [])
  .filter((rel) => fs.existsSync(path.join(EXT, rel))
    && deckPage && fs.readFileSync(path.join(EXT, rel), 'utf8').includes(deckPage));
ok(mounters.length === 1,
  `exactly one declared content script mounts ${deckPage || 'the deck'} (got [${mounters.join(', ')}])`
  + ' — the file the next assertion is about');

const SANDBOX = /\.sandbox\s*=|setAttribute\(\s*['"`]sandbox['"`]|\bsandbox\s*=\s*['"]/;
const sandboxed = mounters.filter((rel) => SANDBOX.test(fs.readFileSync(path.join(EXT, rel), 'utf8')));
ok(mounters.length > 0 && sandboxed.length === 0,
  `...and it puts no sandbox attribute on the deck iframe${sandboxed.length
    ? ` — SANDBOXED: ${sandboxed.join(', ')}; a sandbox without allow-downloads kills the MIDI handoff (ADR 0002)`
    : mounters.length === 0 ? ' — NO MOUNTER FOUND, so this searched nothing'
      : `  ${mounters.join(', ')} scanned`}`);

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

console.log(fails ? `\n${fails} of ${checks} FAILED` : `\ntree-check: ${checks} checks passed`);
process.exit(fails ? 1 : 0);
