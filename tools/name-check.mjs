/**
 * No file in the tracked tree names a former product name.
 *
 *   node tools/name-check.mjs
 *
 * The project was called StemDeck, then Stemfold, before it was Stem Splitter
 * Live. The rename crossed matched pairs that fail silently when only half of
 * them lands — the deck/host `postMessage` namespace, the service-worker to
 * content-script message type, the injected element id — so "did the rename
 * finish" is a question worth being able to answer mechanically rather than by
 * grepping again next time somebody wonders.
 *
 * `--sd-` is the StemDeck-era CSS custom-property prefix. It does not spell the
 * old name, which is exactly why it survived the first rename: nothing that
 * greps for a product name finds it.
 *
 * Scope is `git ls-files` — the tracked tree, which is what gets published. The
 * untracked working directory (spike/, out/, models/) is deliberately not
 * checked; it is not shipped and it is full of legitimate historical mentions.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const SELF = 'tools/name-check.mjs';

/**
 * Each banned pattern, with what it was and where it came from.
 *
 * The second group is the same claim about a different kind of stale name: a
 * reference to a document that is not in the published tree. Those are worse
 * than they look, because a reader who follows `HANDOFF.md §7` and finds
 * nothing cannot tell whether the rule was deleted or the file was renamed —
 * and roughly ninety of them survived the first pass over the markdown, because
 * they were all in source comments and nobody greps comments for dead links.
 */
const BANNED = [
  { re: /stemfold/i, what: 'the previous product name' },
  { re: /stemdeck/i, what: 'the product name before that' },
  { re: /--sd-/, what: 'the StemDeck-era CSS custom-property prefix (now --split-)' },

  { re: /\bCLAUDE\.md\b/, what: 'split into CONTRIBUTING.md (rules) and AGENTS.md (assertions)' },
  { re: /\bHANDOFF(\.md)?\b/, what: 'an internal session record, not published' },
  { re: /\bSTATUS\.md\b/, what: 'an internal status report, not published' },
  { re: /\bSCOPE\.md\b|SCOPE §/, what: 'an internal scope document, not published' },
  { re: /\bCODE-REVIEW\b/, what: 'an internal review document — cite the finding id alone' },
  { re: /\bQA-REPORT\b/, what: 'an internal QA report, not published' },
  { re: /\bCEO\b/, what: 'an internal role; product decisions are cited as rulings or as the spec' },
];

/** Binary files have no text to check and reading them proves nothing. */
const BINARY = /\.(png|jpg|jpeg|gif|ico|wasm|onnx|wav|mp3|zip|woff2?)$/i;

/**
 * COMMENTS OUT, for the SIDED block at the bottom only. The BANNED sweep above
 * deliberately reads comments — a dead document cited in a header is exactly the
 * stale reference it is looking for — but every SIDED claim is a claim about
 * CODE, and a doc comment that spells the literal must not satisfy it. Same
 * one-liner as `test.js` and `qa/speed-pitch.mjs`; the `[^:]` is what keeps
 * `https://` from reading as a line comment.
 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let checks = 0, fails = 0;
const ok = (pass, msg) => { checks++; if (!pass) fails++; console.log(`${pass ? 'ok  ' : 'FAIL'} ${msg}`); };

let tracked;
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (e) {
  console.log(`FAIL cannot list the tracked tree: ${e.message}`);
  console.log('\n1 of 1 FAILED');
  process.exit(1);
}

/**
 * A check that cannot look must fail, not pass (AGENTS.md). An empty file list
 * would make every assertion below vacuously true, and the run would report
 * green having read nothing at all.
 */
ok(tracked.length > 20, `git ls-files returned ${tracked.length} tracked files — there is a tree to check`);
if (tracked.length <= 20) { console.log(`\n${fails} of ${checks} FAILED`); process.exit(1); }

const readable = tracked.filter((f) => !BINARY.test(f) && f !== SELF && fs.existsSync(path.join(ROOT, f)));
ok(readable.length > 20, `${readable.length} of them are text files this can actually read`);

for (const { re, what } of BANNED) {
  const hits = [];
  for (const rel of readable) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    src.split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${rel}:${i + 1}`); });
  }
  ok(hits.length === 0, `nothing names ${re.source} — ${what}${
    hits.length ? ` — FOUND IN ${hits.length}: ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ' …' : ''}` : ''}`);
}

/**
 * THE FOUR IPC PAIRS, EACH SIDE NAMED AND EACH SIDE MATCHED AS CODE — and why
 * a whole-tree COUNT cannot carry that claim.
 *
 * These are live IPC identifiers with a sender and a receiver, and the
 * replacement string is asserted PRESENT rather than the old one merely absent:
 * deleting the line is one way to make an "old name is gone" assertion pass, and
 * it is the wrong way, because a tree with neither half present is broken in a
 * way the absence check reads as clean.
 *
 * IT USED TO BE A WHOLE-TREE COUNT, `found >= 2`, AND THAT COULD NOT FAIL. Every
 * one of these literals is named by the GATES and by the docs as well as by the
 * product — `test.js` drives the shipped host and asserts what it stamps on the
 * wire, `tools/embed-smoke.mjs` queries the injected element by id,
 * `docs/ARCHITECTURE.md` spells all four in prose. Measured, by renaming every
 * real site of the host->deck namespace across `content.js` and `ui/host.js`:
 * `'stem-splitter-live-host' appears 3x` stayed green with NEITHER half of the
 * pair left in the extension. A count a suite's own fixtures can satisfy is not
 * evidence about the product.
 *
 * NAMING THE SIDES IS NOT ENOUGH EITHER, AND THE S5 REVIEW PAID FOR BOTH HALVES
 * OF THE FIX:
 *
 *  - COMMENTS ARE STRIPPED FIRST. The first version of this check was a
 *    whole-FILE `includes("'stem-splitter-live'")` on each named side, and BOTH
 *    sides of that pair spell the literal in a doc comment — `ui/host.js`'s
 *    header and `content.js`'s SPEED note. Renaming ONLY the executable literal
 *    on either side left it green, which is the half-landed rename this gate
 *    exists for. A claim a stale comment can satisfy is not a claim about code;
 *    `test.js` and `qa/speed-pitch.mjs` strip for the same reason.
 *  - EACH SIDE MATCHES ITS OWN EXECUTABLE FORM — the sender's `from:`/`type:`
 *    field or the binding it is read out of, the receiver's `!==` guard. A file
 *    that merely mentions the string somewhere is not a file that implements its
 *    half of the pair.
 *
 * KEEP BOTH SIDES SINGLE-QUOTED LITERALS. The forms below are matched as
 * written, so a template string or a computed name is the same as deleting it —
 * loudly, which is the point.
 *
 * FAILS IF IT CANNOT LOOK: a side that is not in the readable tree at all is
 * reported as missing rather than skipped, so moving a file without moving this
 * list is a red and not a silent pass.
 */
const SIDED = [
  {
    s: "'stem-splitter-live'",
    what: 'the deck->host postMessage namespace: the deck stamps it, content.js refuses anything else',
    sides: [
      { rel: 'extension/ui/host.js', form: /=\s*'stem-splitter-live'\s*;/, is: "the deck's one `const NS`" },
      { rel: 'extension/content.js', form: /!==\s*'stem-splitter-live'/, is: "content.js's inbound guard" },
    ],
  },
  {
    s: "'stem-splitter-live-host'",
    what: 'the host->deck postMessage namespace: content.js stamps it, the deck refuses anything else',
    sides: [
      { rel: 'extension/content.js', form: /from:\s*'stem-splitter-live-host'/, is: "content.js's outbound stamp" },
      { rel: 'extension/ui/host.js', form: /!==\s*'stem-splitter-live-host'/, is: "the deck's inbound guard" },
    ],
  },
  {
    s: "'STEM_SPLITTER_LIVE_EMBED'",
    what: 'the SW->content message type: the worker sends it, content.js is the only thing that acts on it',
    sides: [
      { rel: 'extension/sw/service-worker.js', form: /type:\s*'STEM_SPLITTER_LIVE_EMBED'/, is: "the worker's send" },
      { rel: 'extension/content.js', form: /!==\s*'STEM_SPLITTER_LIVE_EMBED'/, is: "content.js's type guard" },
    ],
  },
  /**
   * THE TWO FIELD RENAMES HOST INTERFACE v1 MADE (S11, #12), and they are here
   * rather than in a seam gate because this is the file that knows what a
   * half-landed rename costs. Both cross the Host seam in the direction the
   * seam gates cannot see: `tools/unit-check.mjs` asks whether a unit file
   * reaches for `chrome.`, and neither of these ever did — the leak was a Chrome
   * NOUN on a wire the unit is forbidden to know the Host of, which reads as
   * ordinary JavaScript from both ends.
   *
   * A half-landed rename here is silent in the worst way: `m.sourceToken` is
   * `undefined` if the worker still sends `streamId`, `getUserMedia` is handed
   * `undefined` as its `chromeMediaSourceId`, and the arm gesture fails with a
   * platform error about a constraint rather than about a rename. The
   * `session.armed` half is quieter still — the deck reads `undefined`, decides
   * it is not armed, and paints the not-armed hint over a tab that IS armed.
   */
  {
    s: 'CAPTURE_START.sourceToken',
    what: "the capture token's wire name: the Host mints it, the engine carries it back to captureStream() without looking inside it (v1 froze it; it was Chrome's `streamId`)",
    sides: [
      { rel: 'extension/sw/service-worker.js', form: /type:\s*'CAPTURE_START',\s*sourceToken\b/, is: "the worker's send" },
      { rel: 'extension/offscreen/engine.js', form: /captureStart\(m\.sourceToken\b/, is: "the engine's CAPTURE_START case" },
    ],
  },
  {
    s: 'SESSION.session.armed',
    what: 'the deck\'s "am I armed?": the Host derives a boolean, the deck reads one (v1 froze it; it was `!!session.tabId`, which made a tab id the unit\'s definition of armed)',
    sides: [
      { rel: 'extension/sw/service-worker.js', form: /armed:\s*!!s\.tabId\b/, is: "sessionForDeck()'s derivation" },
      { rel: 'extension/ui/embed.js', form: /armed:\s*m\.session\.armed === true\b/, is: "the deck's SESSION projection" },
    ],
  },
  {
    s: "'stem-splitter-live-deck'",
    what: 'the injected element id: content.js creates it, the browser gate is what looks for it',
    sides: [
      { rel: 'extension/content.js', form: /=\s*'stem-splitter-live-deck'\s*;/, is: "content.js's `const ID`" },
      { rel: 'tools/embed-smoke.mjs', form: /'#stem-splitter-live-deck'/, is: "the smoke gate's selector" },
    ],
  },
];
for (const { s, what, sides } of SIDED) {
  const bad = sides.map((side) => {
    if (!readable.includes(side.rel)) return `${side.rel} — not in the tracked tree at all`;
    const src = strip(fs.readFileSync(path.join(ROOT, side.rel), 'utf8'));
    return side.form.test(src) ? null : `${side.rel} — ${side.is} is gone (no /${side.form.source}/ in its code)`;
  }).filter(Boolean);
  ok(bad.length === 0, `${s} is on BOTH sides, in code — ${what}${
    bad.length ? ` — HALF-LANDED: ${bad.join('; ')}` : ` (${sides.map((x) => x.rel).join(', ')})`}`);
}

console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nname-check: ${checks} checks passed`);
process.exit(fails ? 1 : 0);
