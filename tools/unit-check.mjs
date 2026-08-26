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
 * question.
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
 *      those files at all (the worklets, the inference worker, pitchbank) and a
 *      gate derived from the crawl would silently drop them.
 *   5. Comments stripped, no unit file names `chrome.`.
 *   6. The only references leaving the closure are the declared holes.
 *   7. Every tracked file under `extension/` is classified exactly once — unit,
 *      hole, Host or explicitly neither. A new file lands on one side of the
 *      seam or the gate asks which.
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
 * `chrome.*`. A unit file that opened a socket would pass every assertion below.
 * This gate does not discharge P1; `CONTRIBUTING.md` and review do.
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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

/**
 * A closure smaller than this is a crawl that stopped, not a unit that shrank.
 * ADR 0001 decision 3 names 33 paths today and the closure is 33; the floor sits
 * well below that on purpose, because its job is to catch a broken crawl rather
 * than to pin a file count that legitimately moves.
 */
const MIN_CLOSURE = 25;

/** Same idea one level up: an emptied `required` list makes assertion 4 vacuous. */
const MIN_REQUIRED = 25;

/** ...and the negative control needs a subject. Today the closure carries 29. */
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
 * Every `chrome.` in `src`, each tagged with the line it is on and whether it is
 * prose. `\bchrome\s*\.` rather than the literal so `window.chrome.runtime` and
 * `chrome .runtime` are both seen and `notchrome.foo` is not.
 */
export function chromeSites(src, kind = 'js') {
  const mask = commentMask(src, kind);
  const out = [];
  for (const m of src.matchAll(/\bchrome\s*\./g)) {
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
    'scanner: an unterminated block comment swallows the rest — a broken file is not a green one');
  ok(ex('notchrome.foo; mychrome.bar;') === 0, 'scanner: the word boundary holds — notchrome.foo is not chrome.');
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

ok(entries.length > 0 && roots.length > 0 && holePaths.length > 0
   && hostPaths.length > 0 && externals.length > 0,
  `the declaration names every role  ${entries.length} entries, ${roots.length} roots, `
  + `${holePaths.length} holes, ${externals.length} external, ${hostPaths.length} host`);

const declared = [...entries, ...roots, ...holePaths, ...hostPaths, ...outsidePaths];
const missing = declared.filter((rel) => !fs.existsSync(path.join(EXT, rel)));
ok(missing.length === 0,
  `every path the declaration names is on disk${missing.length ? ` — MISSING: ${missing.join(', ')}` : `  ${declared.length} paths`}`);

const twice = declared.filter((rel, i) => declared.indexOf(rel) !== i);
ok(twice.length === 0,
  `no path is claimed by two roles${twice.length ? ` — DOUBLE-CLAIMED: ${[...new Set(twice)].join(', ')}` : ''}`);

// ------------------------------------------------------------------ the crawl
/**
 * tree-check's four regexes, unchanged: static and dynamic `import`,
 * `export … from`, and — in `.html` only — `src=` / `href=`. Only specifiers
 * starting with `.` are followed, which is the same blind spot tree-check has
 * and the reason `roots` exists in the declaration.
 *
 * Paths are resolved through the real filesystem rather than joined as strings,
 * because `extension/ui/embed-state.js` reaches its self-check fixtures through
 * `../../extension/engine/pitch.js` — a specifier that leaves `extension/` and
 * comes straight back in. tree-check's string join leaves that as a second,
 * differently-spelt copy of a file already in the crawl; here it has to collapse
 * onto `engine/pitch.js` or the closure double-counts and the classification of
 * the same file could differ between its two spellings.
 */
const closure = new Set();
const cameFrom = new Map();       // rel -> the first file that referenced it
const unresolved = [];
const escapes = [];               // a unit file referencing a declared Host file
const holeUses = new Map();       // hole -> [importers]
const externalUses = [];          // { from, target }
const leftTree = [];              // a specifier that escapes extension/ entirely

const isExternal = (rel) => externals.find((e) => rel.startsWith(e.prefix));

function refsOf(rel, src) {
  const refs = [];
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,400}?from\s*['"](\.[^'"]+)['"]/g)) refs.push(m[1]);
  for (const m of src.matchAll(/^import\s*['"](\.[^'"]+)['"]/gm)) refs.push(m[1]);
  for (const m of src.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) refs.push(m[1]);
  if (rel.endsWith('.html')) {
    for (const m of src.matchAll(/(?:src|href)=["'](?!https?:|#|data:)([^"']+)["']/g)) refs.push('./' + m[1]);
  }
  return refs;
}

function crawl(rel) {
  if (closure.has(rel)) return;
  closure.add(rel);
  const abs = path.join(EXT, rel);
  if (!fs.existsSync(abs) || /\.(png|wasm)$/.test(rel)) return;
  const src = fs.readFileSync(abs, 'utf8');
  const dir = path.dirname(rel);
  for (const r of refsOf(rel, src)) {
    const absTarget = path.resolve(EXT, dir, r);
    const target = path.relative(EXT, absTarget);
    if (target.startsWith('..')) { leftTree.push(`${rel} -> ${r}`); continue; }
    if (!cameFrom.has(target)) cameFrom.set(target, rel);
    if (holePaths.includes(target)) {
      holeUses.set(target, [...(holeUses.get(target) || []), rel]);
      continue;                                    // the seam. Do not descend.
    }
    if (isExternal(target)) { externalUses.push({ from: rel, target }); continue; }
    if (hostPaths.includes(target)) { escapes.push(`${rel} -> ${target}`); continue; }
    if (!fs.existsSync(absTarget)) { unresolved.push(`${rel} -> ${r}`); continue; }
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
ok(escapes.length === 0,
  `nothing in the unit imports a Host file${escapes.length ? ` — ESCAPED: ${escapes.join(', ')}` : `  the only way out is a hole`}`);

for (const h of holes) {
  const users = holeUses.get(h.path) || [];
  ok(users.length > 0,
    `the ${h.duty} hole is real: ${h.path} is imported by the unit  ${users.join(', ') || 'NOBODY'}`);
}

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
  note(fs.existsSync(path.join(EXT, e.prefix))
    ? `extension/${e.prefix} is present — not in git by design, not part of the unit`
    : `extension/${e.prefix} is ABSENT (not in git by design) — run \`bash ${e.fetch}\` before loading unpacked`);
}

// ------------------------------------- ADR 0001 decision 3, as a presence check
const lsFiles = (rel) => execFileSync('git', ['ls-files', `extension/${rel}`], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((p) => p.replace(/^extension\//, ''));

const requiredAll = [];
for (const clause of decl.required || []) {
  const paths = clause.dir ? lsFiles(clause.dir) : clause.paths;
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

// ------------------------------------------------ comments stripped, no chrome.
const speaking = [];
let proseInClosure = 0;
for (const rel of [...closure].sort()) {
  const abs = path.join(EXT, rel);
  if (!fs.existsSync(abs) || /\.(png|wasm)$/.test(rel)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const kind = KIND(rel);
  const ex = executable(src, kind);
  proseInClosure += prose(src, kind).length;
  if (ex.length) speaking.push(`${rel}:${ex.map((s) => s.line).join(',')}`);
}
ok(speaking.length === 0,
  `no file in the unit names chrome.${speaking.length ? ` — SPEAKS CHROME: ${speaking.join(' · ')}` : `  ${closure.size} files scanned, comments stripped`}`);

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
 * the seam and nothing says so — which is how five files ended up unreachable
 * from tree-check's crawl without anybody deciding they should be.
 */
const tracked = execFileSync('git', ['ls-files', 'extension'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean)
  .map((p) => p.replace(/^extension\//, ''))
  .filter((p) => !p.startsWith('vendor/') && !/\.(png|wasm)$/.test(p));
const classified = new Set([...closure, ...holePaths, ...hostPaths, ...outsidePaths]);
const orphans = tracked.filter((p) => !classified.has(p));
ok(orphans.length === 0,
  `every tracked file under extension/ is unit, hole, Host or declared neither${orphans.length
    ? ` — UNCLASSIFIED: ${orphans.join(', ')}` : `  ${tracked.length} files`}`);

const both = [...closure].filter((p) => hostPaths.includes(p) || outsidePaths.includes(p));
ok(both.length === 0,
  `nothing is both unit and Host${both.length ? ` — BOTH: ${both.map((p) => `${cameFrom.get(p) || '?'} -> ${p}`).join(', ')}` : ''}`);

console.log(`\nunit-check: ${checks - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
