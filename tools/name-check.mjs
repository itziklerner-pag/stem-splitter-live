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
 * The rename's replacement strings, asserted PRESENT rather than merely
 * asserting the old ones absent. Deleting the line is one way to make an
 * "old name is gone" assertion pass, and it is the wrong way — these are live
 * IPC identifiers with a sender and a receiver, and a tree with neither half
 * present is broken in a way the absence check reads as clean.
 */
const PAIRED = [
  { s: "'stem-splitter-live-deck'", n: 2, what: 'the injected element id (content.js + the smoke gate)' },
  { s: "'stem-splitter-live-host'", n: 2, what: 'the host->deck postMessage namespace (sender + guard)' },
  { s: "'STEM_SPLITTER_LIVE_EMBED'", n: 2, what: 'the SW->content message type (sender + receiver)' },
];
const all = readable.map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
for (const { s, n, what } of PAIRED) {
  const found = all.split(s).length - 1;
  ok(found >= n, `${s} appears ${found}x (need >= ${n}) — ${what}`);
}

console.log(fails ? `\n${fails} of ${checks} FAILED` : `\nname-check: ${checks} checks passed`);
process.exit(fails ? 1 : 0);
