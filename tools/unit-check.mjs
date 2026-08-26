#!/usr/bin/env node
/**
 * IS THE VENDORED UNIT STILL VENDORABLE?
 *
 *     node tools/unit-check.mjs
 *
 * WHY THIS FILE EXISTS. ADR 0001 decides that the engine and the deck are copied
 * out of this repository into a second product by pinned tag plus SHA-256, and
 * that both sit behind a Host seam so neither knows which Host it runs under.
 * That property has exactly one enemy: a single `chrome.` added to a unit file
 * during ordinary work on the extension, where it works perfectly. Nothing in
 * this repository would go red — the extension IS a Chrome extension — and the
 * cost lands months later, in another repository, as a module that throws at
 * import with no clue in the message about which line put it there.
 *
 * `extension/unit.json` is the declaration; this file is the gate. It reads; it
 * writes nothing, exactly as `tools/tree-check.mjs` does, and it reuses that
 * file's four crawl regexes rather than inventing a second dialect for the same
 * question — plus one tree-check does not have and does not need, documented
 * where `refsOf` is defined.
 *
 * WHAT IT ASSERTS, and why each one is here rather than assumed:
 *
 *   1. The declaration is well formed: every path it names is on disk, and no
 *      path is claimed by two roles at once.
 *   2. Every reference in the closure resolves — tree-check's assertion, run
 *      from the unit's entries rather than from the manifest's.
 *   3. The closure is not empty. A crawl that stops after two files answers
 *      "no `chrome.` found" perfectly and means nothing; the count is asserted
 *      against a floor and printed.
 *   4. The closure contains every path ADR 0001 decision 3 lists — as a PRESENCE
 *      assertion against the declaration, because a crawl cannot reach five of
 *      those files at all and a gate derived from the crawl would silently drop
 *      them. Four have no importer (the three worklets and
 *      `engine/pitchbank.js`); the fifth, `workers/workerbackend.js`, has
 *      exactly one, and it is `offscreen/host.js` — a hole, which is the one
 *      edge the crawl must not follow. All five are seeded as `roots`.
 *   5. Comments stripped, no unit file reaches for `chrome`.
 *   6. The only ways out of the closure are the declared holes and the one
 *      declared Host read. A REFERENCE here is an `import`, an `export … from`,
 *      a `new URL('./x', import.meta.url)` — the form `new Worker` and every
 *      node-only fixture read take — or, in markup, `src=` / `href=`.
 *   7. Every tracked file under `extension/` is classified exactly once — unit,
 *      hole, Host or explicitly neither. A new file lands on one side of the
 *      seam or the gate asks which.
 *   8. Each hole's declared `duty` is a real interface: `shared/host.js` exports
 *      the matching `*_DUTIES` list, and the unit checks a Host against it by
 *      that name at boot. `unit.json` is the first thing a second Host reads;
 *      a rename on either side must not leave it naming an interface that is
 *      gone.
 *   9. The suites that verify the unit are declared, on disk, AT THE PATH THE
 *      STEP REALLY RUNS, on the right side of the seam, and honest about what
 *      they read across it — BOTH WAYS since #11 was reviewed: a declared read
 *      is really made, and a read really made is declared. `--unit` (#11) is
 *      the plan `extension/unit.json` declares, so a suite is gated by being in
 *      that list and by nothing else.
 *  10. ...and the list and `tools/verify.mjs` name the same steps, BOTH WAYS: no
 *      declared id that is not a step (it would silently drop out of `--unit`),
 *      no step that the declaration never classified (it would silently never
 *      join it), and no step classified twice — `suites` and `otherSteps`
 *      contradicting each other is the same defect as a file claimed by two
 *      roles, one level up. `--self-check` asserts the first two against the
 *      real array; this is the copy that runs in CI.
 *  11. A suite that is ALSO this Host's conformance suite says so. `test.js`'s
 *      `group('host')` stubs `globalThis.chrome` and asserts about
 *      `extension/offscreen/host.js` and `extension/ui/host.js` by name: claims
 *      about THIS Host's platform, not about the unit. The entry declares
 *      `hostConformance`, and the gate holds it both ways — declared and the
 *      suite really stubs the platform, stubs it and the suite really declared.
 *      Without that, `--unit`'s largest step reads as a claim about the unit
 *      alone, and a second Host that supplies its own holes takes assertion
 *      failures it has no way to have predicted from this file.
 *
 * AND THE TWO CONTROLS, WHICH ARE THE POINT. Assertion 5 is a search that finds
 * nothing, and a search that finds nothing is indistinguishable from a search
 * that did not run — this repo has shipped four assertions that failed exactly
 * that way (`AGENTS.md`). So the scanner is pinned from both directions:
 *
 *   POSITIVE — the Host files DO speak `chrome.`, and each one is asserted to,
 *     by name, with its count printed. A scanner that started classifying
 *     everything as prose takes all of them red.
 *   NEGATIVE — three unit files mention `chrome.` in prose, one per comment
 *     dialect, and each is asserted to be seen as prose. A scanner that stopped
 *     stripping takes all three red.
 *
 * Neither control can win by accident, and each fails on the mutation the other
 * cannot see.
 *
 * WHAT THIS GATE CANNOT SEE, stated so nobody reads it as more than it is.
 * `fetch`, the Cache API, `getUserMedia` and `navigator.storage` are not
 * `chrome`. A unit file that opened a socket would pass every assertion below.
 * This gate does not discharge P1; `CONTRIBUTING.md` and review do.
 *
 * A green here does not mean the unit RUNS under a second Host either. The
 * engine builds `SharedArrayBuffer`s directly — `offscreen/engine.js:934` and
 * `:969`, `offscreen/deck.js:382`, `offscreen/live.js:594`,
 * `offscreen/cacheddeck.js:231` — and asserts on the constructor rather than on
 * `crossOriginIsolated`, which is false on an extension page and does not need
 * to be true there (`offscreen/engine.js:105-106`). A Host serving the unit
 * from any other scheme has to arrange COOP/COEP, or the flag, before the
 * engine loads, or it throws where `offscreen/engine.js:895` says it does. That
 * is a Host duty this declaration does not name and no assertion below checks.
 *
 * And a reference that is assembled rather than written stays invisible,
 * because the crawl matches a string literal: `engine/pitchbank.js:1040` reads
 * the worklet's verbatim copy of itself through
 * `path.join(here, '../offscreen/playback-processor.js')`, which is a real
 * unit-to-unit read nothing below follows. Both ends are in the closure anyway;
 * a `path.join` that left it would not be seen.
 *
 * WHY NOT THE STRIPPER THIS REPO ALREADY HAS. Four files carry the same regex
 * pair — `tools/name-check.mjs:63`, `qa/speed-pitch.mjs:444`, `test.js:4562` and
 * `test.js:5833` — and it is right for all four, because all four look only at
 * `.js`. It cannot serve here: `extension/ui/embed.html` is in the closure and
 * mentions `chrome.runtime` and `chrome.storage.local` inside `<!-- -->`, which
 * that pair does not know about, so the deck's own markup would be the gate's
 * first false red. The scanner below handles all three dialects the closure
 * actually uses and tracks string literals rather than guarding one `:` case.
 *
 * ponytail: hand-rolled comment scan rather than a real JS parser, the same
 * trade `tools/svg-check.mjs` documents for XML — Node ships no parser for
 * either and the failure class here is one rule. It tracks strings and template
 * literals so a `//` inside a URL does not open a comment; it does NOT track
 * regex literals, so a regex containing an unescaped `/*` would open a block
 * comment that is not there. There is no such regex in the tree today (checked),
 * and if one ever ships, swap `commentMask` for a real parse. The call shape
 * stays the same. Every other misreading this scanner can make is in the safe
 * direction: it reports prose as executable, which is a red somebody looks at.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

/**
 * A closure smaller than this is a crawl that stopped, not a unit that shrank.
 * ADR 0001 decision 3 names 34 paths today and the closure is 34; the floor sits
 * well below that on purpose, because its job is to catch a broken crawl rather
 * than to pin a file count that legitimately moves.
 */
const MIN_CLOSURE = 25;

/**
 * Same idea one level up: an emptied `required` list makes assertion 4 vacuous.
 *
 * The floor is all it is. `docs/adr/0001-*.md` is never opened by this file —
 * decision 3 is TRANSCRIBED into `unit.json`, and the fidelity of that
 * transcription rests on review, not on this gate. Between the floor and
 * today's 34 there is room to drop up to nine paths from a clause and see
 * nothing but a smaller number in the detail. What catches that instead is the
 * assertion below that every file the crawl reaches is a file some clause
 * names: delete `ui/embed-state.js` from the deck clause and the closure still
 * contains it, so the clauses no longer cover the closure and the gate says so.
 */
const MIN_REQUIRED = 25;
/**
 * The interfaces `shared/host.js` declares. A parse that found none would wave
 * every duty table through, which is the same green-on-nothing as a crawl that
 * stopped after two files. Five today: EngineHost, Backend, DeckHost, DeckPage,
 * DeckTransport.
 */
const MIN_TYPEDEFS = 5;

/**
 * The three addresses `BUS` declares — engine, deck, host — and the floor on how
 * many modules the literal sweep below reads. Both are here so that a parse
 * which found nothing fails instead of reporting a clean sweep of an empty set.
 */
const BUS_ADDRESSES = 3;
const BUS_SPEAKERS_MIN = 20;

/** ...and the negative control needs a subject. Today the closure carries 31. */
const MIN_PROSE = 10;

let checks = 0, fails = 0;
const ok = (cond, what) => {
  checks++;
  if (!cond) { fails++; console.error(`FAIL ${what}`); } else console.log(`ok   ${what}`);
};
const note = (what) => console.log(`   -  ${what}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// --------------------------------------------------------------- the scanner
/**
 * Which characters of `src` are inside a comment.
 *
 * `kind` picks the dialect, because the three file types in the closure carry
 * `chrome.` in three different kinds of comment and a scanner that knew only
 * one of them would report the other two as executable:
 *
 *   js    `//` to end of line, and `/* … *\/`; strings and template literals are
 *         skipped so a `//` inside one cannot open a comment.
 *   html  `<!-- … -->` only. `extension/ui/embed.html` has one <script> and it
 *         has a `src`, so there is no inline JS to scan. If inline script ever
 *         appears, its `//` comments read as executable — a false red, which is
 *         the direction this is allowed to be wrong in.
 *   css   `/* … *\/` only. `//` is not a comment in CSS.
 *
 * Exported so `demo()` below can pin it without a browser or a fixture file.
 */
export function commentMask(src, kind = 'js') {
  const mask = new Uint8Array(src.length);
  const n = src.length;
  const js = kind === 'js';
  const html = kind === 'html';
  const block = kind !== 'html';
  let i = 0;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (html && c === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const stop = end === -1 ? n : end + 3;
      mask.fill(1, i, stop); i = stop; continue;
    }
    if (block && c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      mask.fill(1, i, stop); i = stop; continue;
    }
    // `\` guards an escaped slash inside a regex literal; `:` guards a bare
    // `https://` that is not in a string. Both can only make this scanner strip
    // LESS than it should, which surfaces as a red rather than as a false green.
    if (js && c === '/' && d === '/' && src[i - 1] !== '\\' && src[i - 1] !== ':') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      mask.fill(1, i, stop); i = stop; continue;
    }
    if (js && (c === "'" || c === '"' || c === '`')) {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        // A quote that never closes on its line was an apostrophe, not a string.
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      i = j; continue;
    }
    i++;
  }
  return mask;
}

const KIND = (rel) => (rel.endsWith('.html') ? 'html' : rel.endsWith('.css') ? 'css' : 'js');

/**
 * Every reach for `chrome` in `src`, each tagged with the line it is on and
 * whether it is prose.
 *
 * `\bchrome\b` rather than `\bchrome\s*\.`, because the dot is not what makes it
 * Host knowledge. `typeof chrome !== 'undefined'` is the single most idiomatic
 * way a shared module finds out which Host it is running under, and it is
 * exactly the thing ADR 0001 decision 4 forbids the unit to know; so are
 * `globalThis.chrome ?? browser` and `const api = chrome`. None of the three has
 * a dot after the identifier. The word boundary still holds `notchrome.foo` out.
 *
 * The one exclusion is the URL spellings — `chrome://` and `chrome-extension://`
 * — which name a scheme rather than the API object and appear in strings the
 * deck legitimately prints (`ui/embed-state.js:1571` tells the user where to
 * rebind the chord). A scheme cannot be called; the object can.
 */
const CHROME = /\bchrome\b(?!\s*[:-])/g;

export function chromeSites(src, kind = 'js') {
  const mask = commentMask(src, kind);
  const out = [];
  for (const m of src.matchAll(CHROME)) {
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      prose: mask[m.index] === 1,
    });
  }
  return out;
}

const executable = (src, kind) => chromeSites(src, kind).filter((s) => !s.prose);
const prose = (src, kind) => chromeSites(src, kind).filter((s) => s.prose);

/**
 * THE SCANNER'S OWN CHECKS. `tools/verify.mjs` calls a suite that exits 0 while
 * asserting nothing VOID; the same rule one level down says the instrument gets
 * checked before it is trusted. Every case below is a shape that appears in the
 * tree or a mistake the scanner could plausibly make.
 */
function demo() {
  const ex = (s, k) => executable(s, k).length;
  const pr = (s, k) => prose(s, k).length;

  ok(ex('chrome.runtime.id;') === 1, 'scanner: a bare chrome.* is executable');
  ok(ex("if (typeof chrome !== 'undefined') hostify();") === 1,
    'scanner: a bare chrome with no dot is a reach too  typeof chrome is how a shared module learns which Host it is under');
  ok(ex('const api = globalThis.chrome ?? browser;') === 1,
    'scanner: globalThis.chrome with no dot after it is a reach  the other idiom for the same question');
  ok(ex('const u = "chrome://extensions/shortcuts"; const v = "chrome-extension://x/y";') === 0,
    'scanner: the URL spellings are NOT a reach — a scheme cannot be called  ui/embed-state.js:1571 prints one');
  ok(ex('// chrome.runtime.id\n') === 0 && pr('// chrome.runtime.id\n') === 1,
    'scanner: a line comment is prose  the offscreen/live.js dialect');
  ok(ex('/* chrome.storage */') === 0, 'scanner: a block comment is prose');
  ok(ex('/**\n * `chrome.tabCapture`, and the engine\'s copy of it\n */\n') === 0,
    'scanner: a JSDoc block is prose, apostrophe and backticks and all  the offscreen/cacheddeck.js dialect');
  ok(ex('const s = `chrome.runtime`;') === 1,
    'scanner: a chrome. inside a string or a template literal reads as EXECUTABLE  conservative by design — a false red gets investigated');
  ok(ex('<!-- chrome.storage.local -->', 'html') === 0 && pr('<!-- chrome.storage.local -->', 'html') === 1,
    'scanner: an HTML comment is prose  the ui/embed.html dialect');
  ok(ex('const u = "https://x/y"; chrome.runtime.id;') === 1,
    'scanner: a // inside a string does not open a comment and swallow the code after it');
  ok(ex('chrome.runtime.id; // and here is why\n') === 1,
    'scanner: code before a trailing comment is still code');
  ok(ex('const re = /\\/\\//; chrome.runtime.id;') === 1,
    'scanner: an escaped slash pair in a regex does not open a comment');
  ok(ex('/* unterminated\nchrome.runtime.id') === 0,
    'scanner: an unterminated block comment swallows the rest — this scanner\'s ONE false-green direction, and nothing here rules it out');
  ok(ex('notchrome.foo; mychrome.bar;') === 0, 'scanner: the word boundary holds — notchrome.foo is not chrome');
  ok(ex('window.chrome.runtime.id;') === 1, 'scanner: window.chrome.* is executable too');
  ok(ex('// chrome.a\nchrome.b;\n/* chrome.c */\nchrome.d;') === 2
    && pr('// chrome.a\nchrome.b;\n/* chrome.c */\nchrome.d;') === 2,
    'scanner: prose and code interleaved are counted apart  2 of each');
  ok(ex('/* a */ chrome.runtime.id; /* b */') === 1,
    'scanner: a comment on each side does not eat what is between them');
  ok(ex('// chrome.a\n', 'css') === 1,
    'scanner: // is NOT a comment in CSS, so a chrome. after one stays executable (the safe direction)');
}

demo();

// -------------------------------------------------------- the declaration
const declPath = path.join(EXT, 'unit.json');
if (!fs.existsSync(declPath)) {
  ok(false, 'extension/unit.json exists — without it there is no declaration to hold the tree to');
  console.log(`\nunit-check: ${checks - fails} passed, ${fails} failed`);
  process.exit(1);
}
const decl = JSON.parse(fs.readFileSync(declPath, 'utf8'));

const P = (xs) => xs.map((x) => (typeof x === 'string' ? x : x.path));
const entries = P(decl.entries || []);
const roots = P(decl.roots || []);
const holes = decl.holes || [];
const holePaths = P(holes);
const hostFiles = decl.host || [];
const hostPaths = P(hostFiles);
const outsidePaths = P(decl.outside || []);
const externals = decl.external || [];
const hostReads = decl.hostReads || [];

ok(entries.length > 0 && roots.length > 0 && holePaths.length > 0
   && hostPaths.length > 0 && externals.length > 0,
  `the declaration names every role  ${entries.length} entries, ${roots.length} roots, `
  + `${holePaths.length} holes, ${externals.length} external, ${hostPaths.length} host`);

const declared = [...entries, ...roots, ...holePaths, ...hostPaths, ...outsidePaths];
const missing = declared.filter((rel) => !fs.existsSync(path.join(EXT, rel)));
ok(missing.length === 0,
  `every path the declaration names is on disk${missing.length ? ` — MISSING: ${missing.join(', ')}` : `  ${declared.length} paths`}`);
if (missing.length) {
  // A PRECONDITION, NOT AN ASSERTION AMONG OTHERS. The control loops below read
  // every declared hole and Host file by name, and a read of a path that is not
  // there throws an ENOENT trace OVER the assertion that already knows the
  // answer — the run stops mid-suite, the summary line never prints, and a
  // one-word typo in the declaration reads as a crash. Stop here instead, with
  // the verdict this assertion just gave.
  console.log(`\nunit-check: ${checks - fails} passed, ${fails} failed`);
  process.exit(1);
}

const twice = declared.filter((rel, i) => declared.indexOf(rel) !== i);
ok(twice.length === 0,
  `no path is claimed by two roles${twice.length ? ` — DOUBLE-CLAIMED: ${[...new Set(twice)].join(', ')}` : ''}`);

// ------------------------------------------------------------------ the crawl
/**
 * tree-check's four regexes, unchanged: static and dynamic `import`,
 * `export … from`, and — in `.html` only — `src=` / `href=`. Only specifiers
 * starting with `.` are followed, which is the same blind spot tree-check has.
 *
 * PLUS A FIFTH THIS GATE NEEDS AND tree-check DOES NOT:
 * `new URL('./x', import.meta.url)`. tree-check asks whether `extension/` loads
 * as an extension, and by the time a `new URL` is evaluated it already has. This
 * file asks what TRAVELS, and that form is how a module names a sibling file it
 * does not import: `offscreen/deck.js:161` starts the inference worker with it,
 * and `ui/embed-state.js` reads three fixtures with it. Without the fifth regex
 * the header's claim 6 would be import-only while saying "reference" — a unit
 * file could load a Host file into a `new Worker` and this gate would be green.
 *
 * Each reference carries HOW it was made, because the two are not the same
 * promise. An `import` of a Host file is a module the unit cannot run without.
 * A `new URL` read of one is data, and can be declared (`hostReads`) — see the
 * two assertions below, which is which.
 *
 * Specifiers are normalised LEXICALLY, by `path.resolve` + `path.relative`,
 * because `extension/ui/embed-state.js` reaches its self-check fixtures through
 * `../../extension/engine/pitch.js` — a specifier that leaves `extension/` and
 * comes straight back in. tree-check's string join leaves that as a second,
 * differently-spelt copy of a file already in the crawl; here it has to collapse
 * onto `engine/pitch.js` or the closure double-counts and the classification of
 * the same file could differ between its two spellings. Lexical is the whole of
 * it: no `realpath`, so a declared path behind a SYMLINK is not canonicalised
 * and would be classified under the spelling it was written with.
 */
const closure = new Set();
const cameFrom = new Map();       // rel -> the first file that referenced it
const unresolved = [];
const escapes = [];               // { from, target, via } — a unit file reaching a Host file
const readUses = [];              // `${from} -> ${target}` for each DECLARED Host read
const holeUses = new Map();       // hole -> [importers]
const externalUses = [];          // { from, target }
const leftTree = [];              // a specifier that escapes extension/ entirely

/** A file with no source in it: nothing to scan, nothing to follow. */
const UNREADABLE = /\.(png|wasm)$/;

const isExternal = (rel) => externals.find((e) => rel.startsWith(e.prefix));

function refsOf(rel, src) {
  const refs = [];
  const push = (spec, via) => refs.push({ spec, via });
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,400}?from\s*['"](\.[^'"]+)['"]/g)) push(m[1], 'import');
  for (const m of src.matchAll(/^import\s*['"](\.[^'"]+)['"]/gm)) push(m[1], 'import');
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) push(m[1], 'import');
  for (const m of src.matchAll(/new\s+URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g)) push(m[1], 'url');
  if (rel.endsWith('.html')) {
    for (const m of src.matchAll(/(?:src|href)=["'](?!https?:|#|data:)([^"']+)["']/g)) push('./' + m[1], 'markup');
  }
  return refs;
}

function crawl(rel) {
  if (closure.has(rel)) return;
  closure.add(rel);
  const abs = path.join(EXT, rel);
  if (!fs.existsSync(abs) || UNREADABLE.test(rel)) return;
  const src = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(rel);
  for (const { spec, via } of refsOf(rel, src)) {
    const absTarget = path.resolve(EXT, dir, spec);
    const target = path.relative(EXT, absTarget);
    if (target.startsWith('..')) { leftTree.push(`${rel} -> ${spec}`); continue; }
    if (!cameFrom.has(target)) cameFrom.set(target, rel);
    if (holePaths.includes(target)) {
      holeUses.set(target, [...(holeUses.get(target) || []), rel]);
      continue;                                    // the seam. Do not descend.
    }
    if (isExternal(target)) { externalUses.push({ from: rel, target }); continue; }
    if (hostPaths.includes(target)) {
      // A Host file. Declared as data in `hostReads` it is allowed and counted;
      // anything else is an escape, and the crawl stops either way — a Host file
      // must not enter the closure, which is why the partition below can never
      // be the assertion that catches this one.
      if (via === 'url' && hostReads.some((r) => r.from === rel && r.path === target)) {
        readUses.push(`${rel} -> ${target}`);
      } else {
        escapes.push({ from: rel, target, via });
      }
      continue;
    }
    if (!fs.existsSync(absTarget)) { unresolved.push(`${rel} -> ${spec}`); continue; }
    crawl(target);
  }
}

for (const rel of [...entries, ...roots]) crawl(rel);

ok(unresolved.length === 0,
  `every reference in the closure resolves${unresolved.length ? ` — BROKEN: ${unresolved.join(', ')}` : ''}`);
ok(leftTree.length === 0,
  `no reference escapes extension/${leftTree.length ? ` — ESCAPED: ${leftTree.join(', ')}` : ''}`);
ok(closure.size >= MIN_CLOSURE,
  `the crawl reached the unit, not a corner of it  ${closure.size} files from `
  + `${entries.length} entries + ${roots.length} roots, floor ${MIN_CLOSURE}`);

// ------------------------------------------- the only way out is a declared hole
const show = (xs) => xs.map((e) => `${e.from} -${e.via}-> ${e.target}`).join(', ');
const loaded = escapes.filter((e) => e.via !== 'url');
ok(loaded.length === 0,
  `nothing in the unit imports a Host file${loaded.length ? ` — ESCAPED: ${show(loaded)}` : `  the only way out is a hole`}`);

/**
 * ...AND THE OTHER HALF OF THE SAME QUESTION, which is import-only assertions'
 * blind spot. `new URL('../speed.js', import.meta.url)` is not an import and no
 * import-shaped regex sees it, but a vendoring product that copies the unit gets
 * the read and not the file: ENOENT, in a message naming a file that was never
 * supposed to travel. So a Host file read as DATA is allowed only where
 * `unit.json` says so, by name, with the argument in its `why`.
 */
const dataReads = escapes.filter((e) => e.via === 'url');
ok(dataReads.length === 0,
  `...and the only Host file it reads as data is a declared one${dataReads.length
    ? ` — UNDECLARED READ: ${show(dataReads)}` : `  ${readUses.join(', ') || 'it reads none'}`}`);

for (const r of hostReads) {
  ok(hostPaths.includes(r.path),
    `the declared read ${r.from} -> ${r.path} names a Host file  a read of a unit file is not an exception, it is the closure`);
  ok(readUses.includes(`${r.from} -> ${r.path}`),
    `...and the unit really makes it  ${readUses.includes(`${r.from} -> ${r.path}`)
      ? 'found in the crawl' : 'NOT FOUND — the declaration outlived the code it excuses'}`);
}

for (const h of holes) {
  const users = holeUses.get(h.path) || [];
  ok(users.length > 0,
    `the ${h.duty} hole is real: ${h.path} is imported by the unit  ${users.join(', ') || 'NOBODY'}`);
}

/**
 * THE DUTY NAME IS THE FIRST THING A SECOND HOST READS, and until now it was a
 * string in a JSON file that nothing tied to the interface it names. Rename
 * `DeckHost` on either side and the declaration would go on naming an interface
 * that is gone, in the one document a vendoring product opens first.
 *
 * Two claims, not one: `shared/host.js` publishes the duty list, and the unit
 * checks a Host against it BY THAT NAME at boot — `assertHost(host, …,
 * 'DeckHost')`. The second is the one that would survive a copied-and-renamed
 * export, and it names its entry point, which is what AGENTS.md asks of an
 * assertion about a function with more than one caller. `assertHost` has four:
 * `offscreen/engine.js:89` ('EngineHost') and `ui/embed.js:118` ('DeckHost')
 * are the two a hole is declared for; `ui/embed.js:119` checks 'DeckHost.page'
 * and `shared/host.js:764` is `assertHostOption` delegating. The regex requires
 * the closing quote straight after the duty, so 'DeckHost.page' is not
 * 'DeckHost'.
 */
const ifacePath = path.join(EXT, 'shared/host.js');
const ifaceSrc = fs.existsSync(ifacePath) ? fs.readFileSync(ifacePath, 'utf8') : '';
const closureSrc = new Map();
for (const rel of [...closure].sort()) {
  const abs = path.join(EXT, rel);
  if (fs.existsSync(abs) && !UNREADABLE.test(rel)) closureSrc.set(rel, fs.readFileSync(abs, 'utf8'));
}
for (const h of holes) {
  const list = `${h.duty.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_DUTIES`;
  ok(new RegExp(`export const ${list}\\b`).test(ifaceSrc),
    `the ${h.path} hole names an interface that exists: shared/host.js exports ${list}`);
  const bootsites = [...closureSrc].filter(([, src]) => new RegExp(`assertHost\\([^)]*'${h.duty}'\\)`).test(src));
  ok(bootsites.length > 0,
    `...and the unit checks a Host against it at boot  ${bootsites.map(([rel]) => rel).join(', ') || `NOBODY calls assertHost(…, '${h.duty}')`}`);
}

/* ------------------------------------------------- the frozen bus addresses
 * THE ADDRESS SET IS DECLARED ONCE AND NOBODY SPELLS IT.
 *
 * `shared/host.js` exports `BUS` — the three addresses the unit's own protocol
 * uses — and Host interface v1 (S11) made every context read its own out of it
 * instead of writing a literal. That is not tidiness. Before it, the addresses
 * lived as eleven string literals across five files on both sides of the seam,
 * and there was no way to change one: edit the unit's and the service worker
 * goes on broadcasting to an address nobody listens on, which is an arm gesture
 * that silently stops arming — a broadcast nobody hears looks exactly like one
 * that worked.
 *
 * THE ASSERTION IS THE ABSENCE, NOT THE PRESENCE, and that is what gives it
 * teeth. "`BUS.engine` is `'off'`" is a fact about a constant that nothing can
 * contradict; "no file addresses the bus with a literal" is a claim about every
 * file that speaks it, and it goes red the moment somebody adds a sixth one back
 * — which is precisely how the seam would rot.
 *
 * COMMENTS ARE STRIPPED, by the same scanner the `chrome.` sweep uses, because
 * the freeze block in `shared/host.js` and the note in `sw/service-worker.js`
 * both spell the old literals ON PURPOSE, to say what changed.
 *
 * `'tab'` IS NOT IN THE SET and is not looked for. It addresses `content.js` —
 * Host to Host, a message the unit never sees — so `BUS` deliberately has no
 * word for it and a literal there is correct.
 * -------------------------------------------------------------------------- */
const busMatch = ifaceSrc.match(/export const BUS = Object\.freeze\(\{([\s\S]*?)\}\);/);
const busAddrs = busMatch ? [...busMatch[1].matchAll(/^\s{2}(\w+): '([^']+)'/gm)].map(([, k, v]) => ({ k, v })) : [];
ok(busAddrs.length === BUS_ADDRESSES,
  `shared/host.js declares the bus addresses the unit's protocol uses${busAddrs.length === BUS_ADDRESSES
    ? `  ${busAddrs.map((a) => `${a.k}='${a.v}'`).join(', ')}`
    : ` — EXPECTED ${BUS_ADDRESSES}, PARSED ${busAddrs.length}; without them the sweep below compares nothing`}`);

/**
 * Everything that speaks the bus: the unit, the two holes, and the Host files
 * `unit.json` declares. Read from the declaration rather than from a list here,
 * so a new Host context lands in this sweep by being classified at all.
 */
const busSpeakers = [
  ...[...closureSrc.keys()],
  ...holes.map((h) => h.path),
  ...(decl.host || []).map((h) => h.path),
].filter((rel) => /\.js$/.test(rel));
/**
 * BOTH FORMS AN ADDRESS TAKES IN CODE, and the second one is the half that was
 * missing when this was first written: the STAMP (`to: 'off'`) and the GUARD
 * (`m.to !== 'sw'`). A sweep that saw only stamps went green on a context whose
 * inbound filter still compared against a literal — which is the side that goes
 * DEAF rather than mute, and therefore the quieter of the two failures.
 */
const litAddr = new RegExp(
  `(?:\\b(?:to|from):\\s*|\\.(?:to|from)\\s*[!=]==?\\s*)'(?:${busAddrs.map((a) => a.v).join('|')})'`, 'g');
const spellers = [];
for (const rel of busSpeakers) {
  const abs = path.join(EXT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const hits = [...src.matchAll(litAddr)].map((m) => m[0]);
  if (hits.length) spellers.push(`${rel} (${[...new Set(hits)].join(', ')})`);
}
ok(busAddrs.length > 0 && busSpeakers.length >= BUS_SPEAKERS_MIN && spellers.length === 0,
  `...and no context addresses the bus with a literal — every one reads BUS${
    busAddrs.length === 0 ? ' — NO ADDRESSES PARSED, so this searched for nothing'
      : busSpeakers.length < BUS_SPEAKERS_MIN ? `  — ONLY ${busSpeakers.length} files scanned, floor ${BUS_SPEAKERS_MIN}`
        : spellers.length ? `  — SPELLED: ${spellers.join('; ')}`
          : `  ${busSpeakers.length} unit, hole and Host modules scanned, comments stripped`}`);

/* -------------------------------------------- the frozen surface, both halves
 * THE TYPEDEF AND THE DUTY TABLE ARE ONE INTERFACE WRITTEN TWICE, and until Host
 * interface v1 (S11) nothing held them together.
 *
 * `shared/host.js` declares each Host as a JSDoc `@typedef` — which is
 * documentation and runs nowhere, because there is no type checker in this
 * build — and again as a frozen `*_DUTIES` table, which is the half `assertHost`
 * actually enforces. A duty added to the typedef and forgotten in the table is
 * a duty the unit calls and no boot check asks for: exactly the late
 * `host.x is not a function` at a user gesture that `assertHost` exists to move
 * earlier, reintroduced by an edit that looks complete. A duty in the table and
 * not in the typedef is the other half — a Host is refused at boot for a duty
 * that is documented nowhere, and the error names a sentence rather than a
 * contract.
 *
 * THE NAMESPACE EXCEPTION IS ENCODED, NOT LISTED. `DeckHost.page` and
 * `DeckHost.transport` are genuinely absent from `DECK_HOST_DUTIES`, because
 * `assertHost` requires `typeof host[k] === 'function'` and they are objects;
 * each is gated by its OWN table at the deck's boot. So the rule below is not
 * "except page and transport" — an allow-list would go stale the first time a
 * third namespace appeared. It is: a property is in its interface's table, OR
 * its declared type names another typedef IN THIS FILE that has a table of its
 * own. Add a namespace with no table and this goes red without being edited.
 * -------------------------------------------------------------------------- */
const tableKeys = (name) => {
  const m = ifaceSrc.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`));
  return m ? [...m[1].matchAll(/^\s{2}(\w+):/gm)].map((x) => x[1]) : null;
};
const TABLE_OF = (typeName) => `${typeName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_DUTIES`;

/**
 * Every `@typedef {object} X` in the interface, with the `@property` names that
 * follow it up to the end of its comment block. Text, because the typedefs are
 * comments: there is nothing to import.
 */
const typedefs = [...ifaceSrc.matchAll(/@typedef \{object\} (\w+)([\s\S]*?)\*\//g)]
  .map(([, name, body]) => ({
    name,
    props: [...body.matchAll(/@property \{([\s\S]*?)\}\s*(\w+)\s*$/gm)].map(([, type, prop]) => ({ prop, type })),
  }));

// FAILS WHEN IT CANNOT LOOK: a parse that found no typedefs would wave every
// interface through, and a parse that found no properties would wave every duty
// through. Both are the shape of a green that read nothing.
ok(typedefs.length >= MIN_TYPEDEFS,
  `shared/host.js declares the interfaces this gate compares  ${typedefs.length} typedefs, floor ${MIN_TYPEDEFS}: ${typedefs.map((t) => t.name).join(', ')}`);

for (const t of typedefs) {
  const table = tableKeys(TABLE_OF(t.name));
  if (!table) { ok(false, `${t.name} has no ${TABLE_OF(t.name)} in shared/host.js — the typedef is documentation nothing enforces`); continue; }
  const named = new Set(typedefs.map((x) => x.name));
  // A namespace property: its declared type is another typedef here, and that
  // typedef has a table. `{DeckTransport|null}` counts — `null` is the Host
  // declaring it has none, which `assertHostOption` is what checks.
  const isNamespace = (type) => type.split('|').map((x) => x.trim())
    .filter((x) => x !== 'null' && x !== 'undefined')
    .every((x) => named.has(x) && tableKeys(TABLE_OF(x)));
  const undocumented = table.filter((k) => !t.props.some((p) => p.prop === k));
  const unchecked = t.props.filter((p) => !table.includes(p.prop) && !isNamespace(p.type)).map((p) => p.prop);
  ok(t.props.length > 0 && undocumented.length === 0 && unchecked.length === 0,
    `${t.name} is one interface, not two: every duty ${TABLE_OF(t.name)} names is documented and every documented duty is checked${
      t.props.length === 0 ? '  — NO @property PARSED, so this compared nothing'
        : unchecked.length ? `  — DOCUMENTED BUT UNCHECKED: ${unchecked.join(', ')} (in the typedef, in no duty table, and not a declared namespace)`
          : undocumented.length ? `  — CHECKED BUT UNDOCUMENTED: ${undocumented.join(', ')} (in ${TABLE_OF(t.name)}, in no @property)`
            : `  ${t.props.length} properties, ${table.length} duties`}`);
}

/* ------------------------------------------------------- extension/unit.sha256
 * ONE SHA-256 PER UNIT FILE, AND IT DESCRIBES THIS TREE.
 *
 * ADR 0001 decision 3 vendors the unit "by pinned tag plus SHA-256";
 * `tools/unit-hash.mjs` writes the sums file and `docs/VENDORING.md` is what a
 * copy follows. The failure this is here for is the quiet one: the sums file
 * goes STALE. Somebody edits a unit file, the tree is green, the tag is cut, and
 * a vendoring product's `shasum -c` fails on a file that is not corrupt at all —
 * or, worse, a file is added to the unit, nobody re-runs the generator, and the
 * copy verifies 34 of 35 files and calls it verified.
 *
 * THE PATH SET IS COMPARED AGAINST THE CRAWL, not against the generator.
 * `tools/unit-hash.mjs` derives its list from `unit.json`'s `required` clauses;
 * this compares against `closure`, which is what the crawl actually reached from
 * the entries. The two agree only because the two assertions above make them —
 * so importing the generator here would replace a cross-check with a tautology.
 *
 * WHAT AN ABSENT SUMS FILE DOES, measured rather than assumed: the run stops
 * before it reaches here, on "every path the declaration names is on disk", and
 * `unit.sha256` is declared in `unit.json`'s `outside` list. That is the right
 * red in the right place, and it is why the first assertion below is worded for
 * a file that is present and EMPTY — which is the case that does reach here, and
 * which was watched go red on all three.
 * -------------------------------------------------------------------------- */
const SUMS = 'extension/unit.sha256';
const sumsAbs = path.join(ROOT, SUMS);
const sumsBody = fs.existsSync(sumsAbs) ? fs.readFileSync(sumsAbs, 'utf8') : '';
const sumLines = sumsBody.split('\n').filter(Boolean);
const parsed = sumLines.map((l) => /^([0-9a-f]{64})  (\S.*)$/.exec(l)).filter(Boolean)
  .map(([, digest, rel]) => ({ digest, rel }));
ok(sumLines.length > 0 && parsed.length === sumLines.length,
  `${SUMS} is present and every line is \`shasum -c\` format${sumLines.length === 0
    ? ' — EMPTY OR ABSENT, so a copy would verify nothing and report success'
    : parsed.length !== sumLines.length ? `  — ${sumLines.length - parsed.length} unparseable line(s); shasum -c exits non-zero on one`
      : `  ${parsed.length} lines`}`);

const wantPaths = [...[...closure].map((p) => `extension/${p}`), 'extension/unit.json'].sort();
const gotPaths = parsed.map((x) => x.rel).sort();
const unhashed = wantPaths.filter((p) => !gotPaths.includes(p));
const overhashed = gotPaths.filter((p) => !wantPaths.includes(p));
ok(unhashed.length === 0 && overhashed.length === 0,
  `...and it covers the unit exactly — every file the crawl reaches, plus unit.json itself${
    unhashed.length ? `  — UNHASHED: ${unhashed.join(', ')} (run \`node tools/unit-hash.mjs\`)` : ''}${
    overhashed.length ? `  — HASHED BUT NOT UNIT: ${overhashed.join(', ')}` : ''}${
    unhashed.length || overhashed.length ? '' : `  ${gotPaths.length} files`}`);

const staleSums = parsed.filter(({ digest, rel }) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return true;
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== digest;
});
ok(parsed.length > 0 && staleSums.length === 0,
  `...and every recorded digest is the file on disk${parsed.length === 0
    ? ' — NOTHING TO COMPARE, which is not the same as nothing having changed'
    : staleSums.length ? `  — STALE: ${staleSums.map((x) => x.rel).join(', ')} (run \`node tools/unit-hash.mjs\`)`
      : `  ${parsed.length} digests recomputed`}`);

const undeclaredExternal = externalUses.filter((u) => !externals.some((e) => e.entry === u.target));
ok(undeclaredExternal.length === 0,
  `every reference out to a vendored runtime is declared${undeclaredExternal.length
    ? ` — UNDECLARED: ${undeclaredExternal.map((u) => `${u.from} -> ${u.target}`).join(', ')}`
    : `  ${externalUses.map((u) => `${u.from} -> ${u.target}`).join(', ')}`}`);

for (const e of externals) {
  const script = path.join(ROOT, e.fetch);
  const body = fs.existsSync(script) ? fs.readFileSync(script, 'utf8') : '';
  ok(body.includes(e.prefix),
    `${e.fetch} is the recipe for ${e.prefix}, and names it  a vendoring product runs the script rather than copying the drop`);
  /**
   * TWO KINDS OF EXTERNAL, and this note used to know about one.
   *
   * `vendor/ort/` is fetched and gitignored, so its absence is a fact worth
   * reporting rather than a broken tree. `models/` is COMMITTED (ADR 0002): the
   * Basic Pitch weights are Apache-2.0, so this repository is allowed to carry
   * them and does. Printing `not in git by design` over bytes that ARE in git is
   * the small lie this file exists to stop, one level down — so the entry's own
   * `committed` flag picks the sentence, and a committed entry that is missing is
   * a BROKEN CHECKOUT rather than a step somebody has not run yet.
   */
  const there = fs.existsSync(path.join(EXT, e.prefix));
  note(e.committed
    ? (there
      ? `extension/${e.prefix} is present and IS in git — it travels with the copy (${e.fetch})`
      : `extension/${e.prefix} is ABSENT but is committed — this checkout is broken, not incomplete; see ${e.fetch}`)
    : (there
      ? `extension/${e.prefix} is present — not in git by design, not part of the unit`
      : `extension/${e.prefix} is ABSENT (not in git by design) — run \`bash ${e.fetch}\` before loading unpacked`));
}

// ------------------------------------- ADR 0001 decision 3, as a presence check
/**
 * `git ls-files`, minus the two things that are in the tree but outside this
 * question: anything under a declared `external` prefix, and the icon PNGs,
 * which carry no source to classify.
 *
 * ONE predicate, used by the `dir` clauses here AND by the partition at the end
 * of the file. They disagreed until this line existed, and a `dir` clause that
 * expanded to a file the partition had filtered out would demand a binary in the
 * closure that no crawl could ever put there — a false red, read as a seam
 * breach.
 *
 * The `external` half is belt and braces TODAY and says so: `extension/vendor/`
 * is gitignored, so `git ls-files` never offers it — the predicate reads from
 * the declaration rather than testing a hard-coded `vendor/` so that a drop
 * which IS committed, under whatever prefix `unit.json` gives it, needs no
 * change here.
 *
 * `.wasm` is deliberately NOT filtered here. A wasm decoder dropped under
 * `extension/` outside a declared `external` prefix is exactly the file a second
 * Host must be told whether to copy, and the partition is where it gets asked.
 * Only the crawl skips it, because there is nothing in it to read.
 */
const NOT_SOURCE = /\.png$/;
const inScope = (p) => !isExternal(p) && !NOT_SOURCE.test(p);
const lsFiles = (rel) => execFileSync('git', ['ls-files', `extension/${rel}`], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((p) => p.replace(/^extension\//, '')).filter(inScope);

// Fail closed rather than throw: a clause with neither `dir` nor `paths` used to
// die on `paths.length` three lines down, which is a stack trace where the
// assertion under it already has the answer.
const malformed = (decl.required || []).filter((c) => !c.dir && !Array.isArray(c.paths));
ok(malformed.length === 0,
  `every ADR 0001 decision 3 clause declares a dir or a path list${malformed.length
    ? ` — MALFORMED: ${malformed.map((c) => `"${c.adr}"`).join(', ')}` : `  ${plural((decl.required || []).length, 'clause')}`}`);

const requiredAll = [];
for (const clause of decl.required || []) {
  const paths = clause.dir ? lsFiles(clause.dir) : (clause.paths || []);
  // A `dir` clause that expands to nothing is the VOID case wearing a green
  // tick: the glob is wrong, not the directory empty.
  ok(paths.length > 0, `ADR 0001 decision 3 — "${clause.adr}" names at least one path  ${plural(paths.length, 'path')}`);
  requiredAll.push(...paths);
  const absent = paths.filter((p) => !closure.has(p));
  ok(absent.length === 0,
    `the closure contains "${clause.adr}"${absent.length ? ` — MISSING: ${absent.join(', ')}` : `  ${plural(paths.length, 'path')}`}`);
}
ok(requiredAll.length >= MIN_REQUIRED,
  `ADR 0001 decision 3 is transcribed, not emptied  ${requiredAll.length} required paths, floor ${MIN_REQUIRED}`);

/**
 * ...AND THE CLAUSES COVER THE CLOSURE, which is the half a floor cannot carry.
 * The floor above catches an emptied list; this catches a narrowed one — delete
 * `ui/embed-state.js` from the deck clause and the crawl still reaches it
 * through `ui/embed.js`, so it is a unit file no clause names, and the ADR
 * transcription has quietly stopped describing what ships.
 *
 * It is also the gate on the other direction: a new file that a unit file
 * imports joins the closure by itself, and this is what makes somebody add it to
 * the declaration — or decide it is a Host file — rather than let it travel
 * unnamed. The two whole-directory clauses mean `engine/` and `shared/` are
 * automatic; `offscreen/` and `ui/` are the ones with files on both sides.
 */
const unnamed = [...closure].filter((p) => !requiredAll.includes(p)).sort();
ok(unnamed.length === 0,
  `every file the crawl reaches is a file ADR 0001 decision 3 names${unnamed.length
    ? ` — NAMED BY NO CLAUSE: ${unnamed.join(', ')}`
    : `  ${closure.size} in the closure, ${requiredAll.length} required`}`);

// ------------------------------------------------ comments stripped, no chrome.
const speaking = [];
let proseInClosure = 0;
for (const [rel, src] of closureSrc) {
  const kind = KIND(rel);
  const ex = executable(src, kind);
  proseInClosure += prose(src, kind).length;
  if (ex.length) speaking.push(`${rel}:${ex.map((s) => s.line).join(',')}`);
}
ok(speaking.length === 0,
  `no file in the unit reaches for chrome${speaking.length ? ` — SPEAKS CHROME: ${speaking.join(' · ')}` : `  ${closureSrc.size} files scanned, comments stripped`}`);

// NEGATIVE CONTROL. If the scanner stopped stripping, every one of these turns
// red — and the assertion above would have turned red with them, which is the
// only reason it can be trusted when it is green.
const DIALECTS = [
  ['offscreen/live.js', '// line comment'],
  ['offscreen/cacheddeck.js', '/* JSDoc */'],
  ['ui/embed.html', '<!-- HTML -->'],
];
for (const [rel, dialect] of DIALECTS) {
  const src = fs.existsSync(path.join(EXT, rel)) ? fs.readFileSync(path.join(EXT, rel), 'utf8') : '';
  const kind = KIND(rel);
  const p = prose(src, kind).length, x = executable(src, kind).length;
  ok(closure.has(rel) && p > 0 && x === 0,
    `${rel} discusses chrome. in prose and stays green  ${dialect}, ${p} mentions, 0 executable`);
}
ok(proseInClosure >= MIN_PROSE,
  `the unit really does talk about chrome. in prose — the control has a subject  ${proseInClosure} mentions, floor ${MIN_PROSE}`);

// POSITIVE CONTROL. If the scanner started calling everything prose, every
// `speaksChrome: true` line below turns red. It can lose: a Host file that
// genuinely stopped speaking chrome. is a file that belongs in the unit.
for (const h of [...holes, ...hostFiles]) {
  const src = fs.readFileSync(path.join(EXT, h.path), 'utf8');
  const kind = KIND(h.path);
  const ex = executable(src, kind);
  if (h.speaksChrome) {
    ok(ex.length > 0,
      `control: the Host file ${h.path} DOES speak chrome. — the scanner can see one  ${ex.length} executable references`);
  } else {
    ok(ex.length === 0,
      `the Host file ${h.path} is quiet${ex.length ? ` — SPEAKS CHROME at ${ex.map((s) => s.line).join(',')}` : '  0 executable references'}`);
  }
}

// ------------------------------------------------- every file lands on one side
/**
 * The partition. Without it a new file under `extension/` joins neither side of
 * the seam and nothing says so — which is how nine real extension files ended up
 * unreachable from tree-check's crawl without anybody deciding they should be.
 *
 * `inScope` is the same predicate the `dir` clauses expand through, so the two
 * cannot drift; what it leaves out, and why, is documented where it is defined.
 */
const tracked = lsFiles('');
const classified = new Set([...closure, ...holePaths, ...hostPaths, ...outsidePaths]);
const orphans = tracked.filter((p) => !classified.has(p));
ok(orphans.length === 0,
  `every tracked file under extension/ is unit, hole, Host or declared neither${orphans.length
    ? ` — UNCLASSIFIED: ${orphans.join(', ')}` : `  ${tracked.length} files`}`);

/**
 * WHAT THIS ONE CAN ACTUALLY CATCH, because its name used to promise more.
 * The Host half is unfalsifiable on its own: `crawl()` tests `hostPaths` BEFORE
 * it descends and records an escape instead, so a declared Host file can only
 * reach the closure by also being an entry or a root — and `no path is claimed
 * by two roles` fires on that first, in the same run. The `outside` half is the
 * half that fires alone: a unit file importing `./dev/selftest.mjs` or
 * `../unit.json` is not a Host file, nothing above rejects it, and the suite
 * that verifies the unit is not part of the unit it verifies.
 */
const both = [...closure].filter((p) => hostPaths.includes(p) || outsidePaths.includes(p));
ok(both.length === 0,
  `nothing in the unit is also declared Host or declared outside it${both.length
    ? ` — BOTH: ${both.map((p) => `${cameFrom.get(p) || '?'} -> ${p}`).join(', ')}` : ''}`);

// -------------------------------------- the suites that verify it, and the runner
/**
 * A COPY THAT NOBODY CAN RUN A SUITE OVER IS NOT A VENDORED UNIT, IT IS A ZIP.
 *
 * Everything above asks whether the unit still comes OUT of this repository.
 * This asks the question `unit.json` gained a `suites` list to answer (#11):
 * once it is out, what says it works? `node tools/verify.mjs --unit` builds its
 * plan by reading that list, so a suite is part of the unit's gate by being
 * declared here and by nothing else — which is exactly why the declaration and
 * the runner have to be held together.
 *
 * THE DIVISION OF LABOUR WITH `--self-check`, because both places assert about
 * this list and they are not the same claim. `--self-check` has the real `steps`
 * array in memory and asserts that the plan `unitPlan()` BUILDS is the manifest's
 * list — the strongest form, and unfoolable. It is also run by nothing
 * automatic: `.github/workflows/verify.yml` runs `--quick`, and `--quick` does
 * not run `--self-check`. So the same agreement is asserted HERE, from the
 * manifest's side, by reading the runner as text — weaker, and gated. Two
 * instruments, one property, and the gated one is the one that survives.
 *
 * Reading `tools/verify.mjs` as TEXT rather than importing it: importing it runs
 * it. It reaps browsers and spawns a plan at module scope. `test.js` reads
 * `ui/embed.js` the same way and for the same kind of reason.
 */
const SUITES = decl.suites || [];
const RUNNERS = decl.runners || [];
const runnable = [...SUITES, ...RUNNERS];

ok(SUITES.length > 0 && RUNNERS.length > 0,
  `the declaration names the suites that verify the unit, and the files that run them  `
  + `${plural(SUITES.length, 'suite')}, ${plural(RUNNERS.length, 'runner')}`);

/**
 * REPO-RELATIVE, not `extension/`-relative like every other path in this file,
 * and the `doc` block says so: eight of these fourteen live outside
 * `extension/` — a suite is not a thing Chrome loads. Resolved from ROOT for
 * that reason.
 */
const missingRun = runnable.map((s) => s.path).filter((p) => !fs.existsSync(path.join(ROOT, p)));
ok(missingRun.length === 0,
  `every suite and runner the declaration names is on disk${missingRun.length
    ? ` — MISSING: ${missingRun.join(', ')}` : `  ${plural(runnable.length, 'path')}, repo-relative`}`);

/**
 * WHICH SIDE OF THE SEAM A SUITE MAY SIT ON. Six of the twelve are unit files
 * that self-check under plain node, so they are in the closure; one
 * (`ui/dev/selftest.mjs`) is declared `outside`. What no suite in this list may
 * be is a Host file: `extension/autonav.js` and `extension/speed.js` are also
 * green plain-node suites, and putting either in the unit's plan would have
 * `--unit` reporting on the extension's content scripts. That is the mistake
 * this catches, and it is an easy one to make — they are fast and they pass.
 */
const wrongSide = SUITES
  .filter((s) => s.path.startsWith('extension/'))
  .map((s) => ({ s, rel: s.path.slice('extension/'.length) }))
  .filter(({ rel }) => !closure.has(rel) && !outsidePaths.includes(rel));
ok(wrongSide.length === 0,
  `every suite under extension/ is a unit file or declared outside the unit — never a Host file${wrongSide.length
    ? ` — WRONG SIDE: ${wrongSide.map(({ s }) => s.path).join(', ')}`
    : `  ${SUITES.filter((s) => s.path.startsWith('extension/')).length} of ${SUITES.length}`}`);

/**
 * WHAT A SUITE REACHES FOR ACROSS THE SEAM, declared per suite because it is
 * real rather than because it is fine — the same rule `hostReads` above states
 * for the one unit file that does it. Three suites verify the seam from BOTH
 * sides: `test.js` reads this Host's `ui/host.js` and `offscreen/host.js` to
 * check that every duty the unit reaches for is declared, and `host-pin.js` for
 * the model origin; `qa/speed-pitch.mjs` reads the two content scripts because
 * the key-lock ruling spans the deck and the page. Those halves are about THIS
 * Host and do not travel, and a copy that runs `--unit` without them gets a red
 * naming the file — which is what S11's vendoring instructions have to reckon
 * with, and why the list is here in machine-readable form rather than in prose.
 *
 * `reads` is spelt `extension/`-relative like every other path in this file,
 * which is also what makes the first assertion possible: everything it can name
 * is already declared above as a hole or as Host.
 */
const declaredReads = runnable.flatMap((s) => (s.reads || []).map((p) => ({ from: s.path, path: p })));
const notHost = declaredReads.filter((r) => !hostPaths.includes(r.path) && !holePaths.includes(r.path));
ok(notHost.length === 0,
  `every file a suite declares it reads across the seam is a declared Host file or a declared hole${notHost.length
    ? ` — NOT DECLARED HOST: ${notHost.map((r) => `${r.from} -> ${r.path}`).join(', ')}`
    : `  ${plural(declaredReads.length, 'read')} from ${new Set(declaredReads.map((r) => r.from)).size} suites`}`);

/**
 * ...AND THE SUITE STILL MAKES THE READ, AND MAKES NO OTHER. Held BOTH WAYS
 * since the review of #11, because one way is not a gate. Declared-therefore-
 * real catches a `reads` entry that outlived the code that earned it. Real-
 * therefore-declared is the direction that ROTS: a suite acquires a new Host
 * read during ordinary work, nothing goes red, and the list S11 writes
 * `docs/VENDORING.md` from is quietly short. That is the same silent-green
 * shape `--unit`'s step ids are held against below, and the same one the
 * `hostReads` crawl above already closes for the unit's own files
 * (`UNDECLARED READ`). Measured before it was closed: deleting `"content.js"`
 * from `speed-pitch`'s `reads` — a read that genuinely happens, at
 * `qa/speed-pitch.mjs:113` — left this file at 75 of 75, exit 0.
 *
 * A READ POSITION, NOT A MENTION. The needle is the path inside a string
 * literal that a file-opening call is looking at: `import(`, `from`,
 * `new URL(`, `readFile[Sync](`, `require(`, or a `join(`/`resolve(` whose
 * remaining arguments are literal — which is how all six of these are written
 * (`await import('./extension/ui/host.js')`, `join(EXT, 'content.js')`,
 * `new URL('../speed.js', import.meta.url)`). Matching a bare mention instead
 * would be wrong in both directions at once: `test.js` names `content.js` and
 * `ui/welcome.js` inside assertion strings it never opens (:5296, :7249), so
 * the completeness half would demand two false declarations, and the staleness
 * half would accept a suite that had stopped reading a file it still talks
 * about — measured on the shipped tree, splitting only the `readFileSync`
 * literal at `qa/speed-pitch.mjs:130` left the old needle green at 75 of 75,
 * because the failure message at :156 still said `extension/speed.js`. That
 * mutation goes red now.
 *
 * A literal is matched by SUFFIX (`l === p || l.endsWith('/' + p)`) because
 * `reads` is spelt `extension/`-relative and the call sites are relative to
 * wherever they sit. The basename alone would not do: `ui/host.js` and
 * `offscreen/host.js` share one, and a suite that read only the first would
 * vouch for both.
 *
 * COMMENTS STRIPPED, with this file's own scanner — the one `demo()` pins at
 * the top. A claim a doc comment can satisfy is not a claim, and every one of
 * these files discusses the seam in prose at length.
 *
 * WHICH HALF IS THE CONTROL. The completeness half is a search that finds
 * nothing, and this file's standing rule is that such a search must be pinned
 * from the other side or it is indistinguishable from a search that did not
 * run. It is: a `READ_CALL` that matched nothing at all would take the
 * STALENESS half red on all seven declared reads at once, and that half prints
 * every one of them by name. Breaking the needle cannot go quiet.
 *
 * WHAT IT STILL DOES NOT CARRY, MEASURED RATHER THAN REASONED ABOUT: a path
 * assembled from a VARIABLE is invisible in both directions — `join(EXT, name)`
 * matches nothing here, and `test.js` walks `extension/` wholesale for its last
 * grep exactly that way. A suite that started reading a Host file through a
 * computed path would still go undeclared. That is the blind spot this file's
 * header already owns about `engine/pitchbank.js:1040`, it is one the crawl
 * above shares, and closing it needs a parser rather than a tighter regex. The
 * honest fix if it ever matters is to declare the call site.
 */
const codeOnly = (src, kind) => {
  const m = commentMask(src, kind);
  const out = [];
  for (let i = 0; i < src.length; i++) if (!m[i]) out.push(src[i]);
  return out.join('');
};
const suiteCode = new Map();
for (const s of runnable) {
  const abs = path.join(ROOT, s.path);
  if (fs.existsSync(abs)) suiteCode.set(s.path, codeOnly(fs.readFileSync(abs, 'utf8'), KIND(s.path)));
}

/** Everything a `reads` entry may name, and everything the scan looks for. */
const SEAM = [...hostPaths, ...holePaths];
const READ_CALL = /(?:\bimport\s*\(|\bfrom\s+|\bnew\s+URL\s*\(|\breadFileSync\s*\(|\breadFile\s*\(|\brequire\s*\(|\b(?:join|resolve)\s*\([^)'"`]*)\s*['"`]([^'"`]+)['"`]/g;
const realReads = new Map(runnable.map((s) => {
  const lits = [...(suiteCode.get(s.path) || '').matchAll(READ_CALL)].map((m) => m[1]);
  return [s.path, SEAM.filter((t) => lits.some((l) => l === t || l.endsWith(`/${t}`)))];
}));

const stale = declaredReads.filter((r) => !(realReads.get(r.from) || []).includes(r.path));
ok(declaredReads.length > 0 && stale.length === 0,
  `...and every one of them is really read by the suite that declares it${stale.length
    ? ` — NOT IN A READ POSITION, the declaration outlived the code: ${stale.map((r) => `${r.from} -> ${r.path}`).join(', ')}`
    : `  ${declaredReads.map((r) => `${r.from} -> ${r.path}`).join(', ')}`}`);

const undeclaredRead = runnable.flatMap((s) => (realReads.get(s.path) || [])
  .filter((t) => !(s.reads || []).includes(t))
  .map((t) => `${s.path} -> ${t}`));
ok(undeclaredRead.length === 0,
  `...and no suite reads across the seam without declaring it — the list a copy is told to carry cannot be short${undeclaredRead.length
    ? ` — UNDECLARED READ: ${undeclaredRead.join(', ')}; add each to that suite's "reads" in extension/unit.json`
    : `  ${runnable.length} suites and runners scanned in read position`}`);

/**
 * ...AND A SUITE THAT IS ALSO THIS HOST'S CONFORMANCE SUITE SAYS SO. This is
 * the finding that mattered most about #11 as delivered: `unit` is the largest
 * step in `--unit`, and it is two suites in one file. `test.js`'s
 * `group('host')` (4570-7397, 122 of the file's 583 `ok(` sites) installs a
 * Chrome platform at :4950 and asserts that THIS Host's `offscreen/host.js` and
 * `ui/host.js` behave — a claim about the Host, not about the unit.
 *
 * Nothing else here can see that. `offscreen/host.js` and `ui/host.js` are
 * HOLES: a second product MUST supply its own, so the reads above succeed and
 * `reads` reports nothing missing. What a copy actually gets is assertion
 * failures about a platform it does not have — measured, by replacing
 * `extension/offscreen/host.js:58` `send()` with a contract-satisfying
 * non-Chrome implementation (same envelope, same undefined return, same
 * swallowed delivery failure, over a plain bus): step `unit` goes to
 * `610 passed, 2 failed`, both reds naming `send()`. No ENOENT anywhere.
 *
 * `otherSteps` cannot express it, because `unit` is genuinely both. So the
 * entry declares it and the gate holds the declaration to the code both ways.
 * The needle is `globalThis.chrome`: installing a platform is the sharp,
 * checkable act, and it is what makes those assertions unpassable off Chrome. A
 * suite that instead asserts about a Host file by READING it is caught by
 * `reads` above — between them the two mechanisms are covered.
 */
const CHROME_STUB = 'globalThis.chrome';
const undeclaredConf = runnable
  .filter((s) => (suiteCode.get(s.path) || '').includes(CHROME_STUB) && !s.hostConformance)
  .map((s) => s.path);
ok(undeclaredConf.length === 0,
  `every suite that installs this Host's platform declares itself a Host-conformance suite${undeclaredConf.length
    ? ` — STUBS ${CHROME_STUB} AND DOES NOT SAY SO: ${undeclaredConf.join(', ')}; add "hostConformance" to its entry in extension/unit.json`
    : `  ${runnable.filter((s) => s.hostConformance).length} of ${runnable.length}: `
      + `${runnable.filter((s) => s.hostConformance).map((s) => s.path).join(', ')}`}`);

const declaredConf = runnable.filter((s) => s.hostConformance);
const idleConf = declaredConf.filter((s) => {
  const code = suiteCode.get(s.path) || '';
  const g = s.hostConformance.group;
  return !code.includes(CHROME_STUB) || (g && !code.includes(`group('${g}')`));
}).map((s) => `${s.path}${s.hostConformance.group ? ` group('${s.hostConformance.group}')` : ''}`);
ok(declaredConf.length > 0 && idleConf.length === 0,
  `...and every declared one really does, in the assertion group it names${declaredConf.length === 0
    ? ' — NONE DECLARED, so the assertion above has nothing to be the other half of'
    : idleConf.length
      ? ` — DECLARED BUT NOT FOUND: ${idleConf.join(', ')}`
      : `  ${declaredConf.map((s) => `${s.path} group('${s.hostConformance.group}')`).join(', ')}`}`);

/**
 * THE MANIFEST AND THE RUNNER NAME THE SAME STEPS. A `suites` entry whose step
 * id no step has is not an error anywhere: `--unit` filters, a filter cannot
 * report a miss, and the run prints the same green over a smaller plan. The
 * other direction is the one that rots — a new plain-node suite added to
 * `steps` by someone with no reason to think about vendoring, which `--unit`
 * then never runs.
 *
 * The `steps` literal is sliced out of the runner's source by its opening line
 * and its closing `\n];`, comments stripped first so a step id quoted in prose
 * cannot join the list. Over-collecting is caught by the second assertion (the
 * ids in `--self-check`'s own fixtures — 'e2e', 'audible', 'wire-abort' — are
 * classified by nothing) and under-collecting by the first. The control is that
 * the slice contains THIS step: unit-check is in the runner's plan, and a scan
 * that came back with an empty or wrong region loses it.
 */
const runnerSrc = codeOnly(fs.readFileSync(path.join(ROOT, 'tools/verify.mjs'), 'utf8'), 'js');
const stepsAt = runnerSrc.indexOf('\nconst steps = [');
const stepsEnd = stepsAt < 0 ? -1 : runnerSrc.indexOf('\n];', stepsAt);
const stepsSrc = stepsAt < 0 || stepsEnd < 0 ? '' : runnerSrc.slice(stepsAt, stepsEnd);
const idHits = [...stepsSrc.matchAll(/\bid:\s*'([\w-]+)'/g)];
const stepIds = idHits.map((m) => m[1]);
ok(stepIds.includes('unit-check'),
  `control: the runner's step list was really found and read  ${stepIds.length
    ? `${plural(stepIds.length, 'step')} in tools/verify.mjs, this one among them`
    : 'NOTHING EXTRACTED — the `const steps = [` slice missed, so the assertions below prove nothing'}`);

/**
 * ...AND A SUITE'S `path` IS THE FILE ITS STEP REALLY RUNS. Without this the
 * paths are decoration: `--unit` runs each step's own `args` out of
 * `tools/verify.mjs` and never looks at `path`, so a wrong-but-existing one is
 * silently green — measured, before this was here: pointing `pitch` at
 * `extension/engine/chroma.js` left the file at 75 of 75, exit 0. It matters
 * because S11 is instructed to copy these paths verbatim to build the vendored
 * copy; a copy assembled from a decorative list is missing a file it will only
 * discover at `MODULE_NOT_FOUND`.
 *
 * The region for a step is from its `id:` to the next one, so a step with no
 * `args` cannot borrow its neighbour's. Every one of the eleven `suites` steps
 * is a one-line `{ id, title, args: ['<path>'] }` today; a step whose command
 * grows past a single literal argument would need this to grow with it, and
 * would say so by going red rather than by drifting.
 */
const stepArg = new Map(idHits.map((m, i) => {
  const region = stepsSrc.slice(m.index, i + 1 < idHits.length ? idHits[i + 1].index : stepsSrc.length);
  const a = /\bargs:\s*\[\s*'([^']+)'/.exec(region);
  return [m[1], a ? a[1] : null];
}));
const wrongPath = SUITES.filter((s) => stepIds.includes(s.step) && stepArg.get(s.step) !== s.path);
ok(wrongPath.length === 0,
  `...and every suite's declared path is the file its step really runs${wrongPath.length
    ? ` — NOT WHAT THE STEP RUNS: ${wrongPath.map((s) => `${s.step} runs ${stepArg.get(s.step) || 'no literal args'}, declared ${s.path}`).join('; ')}`
    : `  ${SUITES.length} paths pinned to their step's argv`}`);

const declaredSteps = [...SUITES.map((s) => s.step), ...(decl.otherSteps || []).map((s) => s.step)];

/**
 * A PARTITION, NOT TWO OPINIONS. The two assertions below make the
 * classification TOTAL; this one makes it DISJOINT, which is the same defect
 * one level up from `no path is claimed by two roles` and `nothing in the unit
 * is also declared Host` above. A step in `suites` AND in `otherSteps` passed
 * every instrument here and in `--self-check` — measured: adding
 * `{"step":"tree","path":"tools/tree-check.mjs"}` to `suites` while leaving
 * `tree` in `otherSteps` left this file at 75 of 75 and `--self-check` green,
 * with `--unit` then running tree-check inside a vendored copy, over the
 * `otherSteps` line that says tree-check cannot run in one.
 *
 * It lives here rather than in `--self-check` because it is a claim about the
 * manifest alone — no `steps` array is needed to see it — and because this is
 * the copy CI runs.
 */
const dupSteps = [...new Set(declaredSteps.filter((id, i) => declaredSteps.indexOf(id) !== i))];
ok(dupSteps.length === 0,
  `no step is classified twice — "suites" and "otherSteps" partition the runner's plan${dupSteps.length
    ? ` — CLASSIFIED TWICE: ${dupSteps.join(', ')}; a step is the unit's or it is not`
    : `  ${declaredSteps.length} ids, all distinct`}`);
const noSuchStep = declaredSteps.filter((id) => !stepIds.includes(id));
ok(noSuchStep.length === 0,
  `every step id the declaration names is a step tools/verify.mjs has${noSuchStep.length
    ? ` — NO SUCH STEP: ${noSuchStep.join(', ')}` : `  ${declaredSteps.length} ids`}`);

const unclassifiedSteps = stepIds.filter((id) => !declaredSteps.includes(id));
ok(unclassifiedSteps.length === 0,
  `...and every step tools/verify.mjs runs is classified — the unit's, or named in otherSteps${unclassifiedSteps.length
    ? ` — UNCLASSIFIED: ${unclassifiedSteps.join(', ')}; add each to "suites" or to "otherSteps" in extension/unit.json`
    : `  ${stepIds.length} steps, ${SUITES.length} of them the unit's`}`);

console.log(`\nunit-check: ${checks - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
