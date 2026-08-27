#!/usr/bin/env node
/**
 * U5a's MUTATION BATTERY — the instrument behind every "watched red" claim in
 * `test.js` group('offline'), kept IN THE REPOSITORY rather than in a scratch
 * directory.
 *
 *   node qa/u5a-mutations.mjs            run all of them
 *   node qa/u5a-mutations.mjs --list     what they are, without running anything
 *   node qa/u5a-mutations.mjs --only N7  one of them
 *   node qa/u5a-mutations.mjs --stamp    print the anchored files' hashes NOW
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS COMMITTED. A mutation battery is the only instrument that can see a
 * whole class of change: three commits in this phase moved zero assertions and
 * every one of them mattered, and neither an assertion count nor a coverage diff
 * can distinguish those from a no-op. Two batteries in this build were lost
 * because they lived in a scratch directory, and every "watched red" they
 * justified became an unverifiable claim the moment the process ended.
 *
 * WHY IT REPORTS TWO THINGS PER ANCHOR, NOT ONE. A battery that prints a pass
 * count collapses two findings that need opposite responses:
 *
 *   MATCHES?  did the anchor still find its text? A NO is a DECAYED INSTRUMENT —
 *             some other slice rewrote the line this patches — and the response
 *             is to RE-CUT it. It is not a coverage loss and must not be read as
 *             one.
 *   RED?      did the mutation still make the suite fail? A NO is either decay or
 *             a REAL COVERAGE LOSS, and the response is to find out which.
 *
 * Measured in this phase: a 30-anchor battery that had reported 51/51 gave 44/51
 * later, and the seven gaps were TEN anchors that no longer matched anything —
 * ten instruments that had silently stopped pointing at their target, reported as
 * if seven assertions had weakened. That is why both columns are printed.
 *
 * WHAT THE STAMP IS, AND WHY IT IS A CONTENT HASH RATHER THAN A COMMIT SHA. The
 * anchors were cut against the files below, at the contents below. A sha would
 * name a commit that a rebase can rewrite — and stamping against an unlanded tip
 * is the failure the stamp exists to prevent — so `base` names the LANDED commit
 * this work is cut from, and each anchored file carries the SHA-256 of its
 * contents at cut time. A file whose hash has moved is a file whose anchors are
 * SUSPECT EVEN WHERE THEY STILL MATCH, and the report says so, per file, before
 * it says anything about reds.
 *
 * SAFETY. Every anchor is applied to the real file — the suite imports it, so a
 * copy would measure the copy — and restored in a `finally`, with a second
 * restore on SIGINT/SIGTERM. It REFUSES TO START if any anchored file has
 * uncommitted changes, because an interrupted run would otherwise be
 * indistinguishable from someone's work in progress.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OFF = 'extension/engine/offline.js';

/**
 * THE STAMP. `base` is the landed commit this branch is cut from; the hashes are
 * the anchored files as they stood when the anchors were cut. Update both with
 * `--stamp` when you re-cut, and say in the commit message that you did.
 */
const CUT = {
  base: '5993d32',
  slice: 'U5a — the ahead-of-time separation runner (#41)',
  files: {
    'extension/engine/offline.js': '101830ea505d7b7ef50d94a86db22fcfcb6df0fda2c8bb481cfbc6c6211e1327',
  },
};

/**
 * Each anchor: `find` must appear EXACTLY ONCE in the file, or the battery
 * refuses it as ambiguous — an anchor that patches the first of several
 * identical lines is an anchor nobody can reason about.
 */
const MUTATIONS = [
  // ---------------------------------------------------------------- geometry
  { id: 'N1', file: OFF, what: 'the window count loses its +1',
    find: 'Math.ceil((frames - segment) / stride) + 1)',
    to: 'Math.ceil((frames - segment) / stride))' },
  { id: 'N2', file: OFF, what: 'windows advance by SEGMENT instead of STRIDE',
    find: '  const inputStart = k * p.stride;',
    to: '  const inputStart = k * p.segment;' },
  { id: 'N3', file: OFF, what: 'the FIRST window fades in — its own head ramped to silence',
    find: '        if (!w.first && i < p.overlap) g = this.fi[i];',
    to: '        if (i < p.overlap) g = this.fi[i];' },
  { id: 'N4', file: OFF, what: 'the LAST window fades out — the track ends in a ramp to silence',
    find: '        else if (!w.last && i >= w.fadeOutAt) g = this.fo[i - w.fadeOutAt];',
    to: '        else if (i >= w.fadeOutAt) g = this.fo[i - w.fadeOutAt];' },
  { id: 'N5', file: OFF, what: 'the ramp is the 50 ms SEAM crossfade rather than the overlap',
    find: '    const { fi, fo } = makeFades(plan.overlap, law);',
    to: '    const { fi, fo } = makeFades(2205, law);' },
  { id: 'N6', file: OFF, what: 'equal-power ramps: +3.01 dB through the middle of every join',
    find: '    const { fi, fo } = makeFades(plan.overlap, law);',
    to: "    const { fi, fo } = makeFades(plan.overlap, 'equalPower');" },
  { id: 'N7', file: OFF, what: 'a join OVERWRITES instead of summing — the outgoing half is lost',
    find: '        if (!w.first && i < p.overlap) d[abs] += s[i] * g;',
    to: '        if (!w.first && i < p.overlap) d[abs] = s[i] * g;' },
  { id: 'N9', file: OFF, what: 'the stride validation is dropped — gaps no window covers',
    find: '  if (!(stride > 0 && stride < segment)) {',
    to: '  if (false) {' },
  { id: 'N10', file: OFF, what: 'the window-index validation is dropped',
    find: '  if (!Number.isInteger(k) || k < 0 || k >= p.windows) {',
    to: '  if (false) {' },
  { id: 'N11', file: OFF, what: 'the window-order check is dropped',
    find: '    if (k !== this.next) {',
    to: '    if (false) {' },
  { id: 'N12', file: OFF, what: 'the plane-length check is dropped — a short plane is read past its end',
    find: '      if (s.length < p.segment) {',
    to: '      if (false) {' },
  { id: 'N13', file: OFF, what: 'finish() stops refusing a short run — the tail commits as silence',
    find: '    if (this.next !== this.p.windows) {',
    to: '    if (false) {' },
  { id: 'N14', file: OFF, what: 'bufferRing stops checking that the channels are the same length',
    find: "  if (r.length !== frames) throw new RangeError(`offline: channels differ",
    to: '  if (false) throw new RangeError(`offline: channels differ' },
  { id: 'N15', file: OFF, what: 'the overlap is computed from the seam crossfade, not from the geometry',
    find: '  const overlap = segment - stride;',
    to: '  const overlap = 2205;' },
  { id: 'N16', file: OFF, what: 'THE JOIN BECOMES A BUTT SPLICE — every ramp deleted. The COLA '
      + 'residual IMPROVES to 0.00e+0 under this, which is why the join has its own instrument',
    find: '        let g = 1;',
    to: '        let g = 1;\n        d[abs] = s[i];\n        continue;\n        // eslint-disable-next-line' },
  { id: 'N17', file: OFF, what: 'the ramp reaches unity after 2205 frames and holds — complementary, '
      + 'so COLA still reconstructs and only the join instrument can see it',
    find: '    this.fi = fi; this.fo = fo;',
    to: '    this.fi = fi.map((v, i) => Math.min(1, i / 2205));\n'
      + '    this.fo = fo.map((v, i) => Math.max(0, 1 - i / 2205));' },

  // ------------------------------------------------------------- the runner
  { id: 'R1', file: OFF, what: 'the cancel check between windows is removed',
    find: '    if (cancelled && cancelled()) return { cancelled: true, windows: plan.windows, done, planes: null };\n'
      + '    readWindow(',
    to: '    readWindow(' },
  { id: 'R2', file: OFF, what: 'a cancelled run hands back the PARTIAL planes instead of none',
    find: '    if (cancelled && cancelled()) return { cancelled: true, windows: plan.windows, done, planes: null };\n'
      + '    readWindow(',
    to: '    if (cancelled && cancelled()) return { cancelled: true, windows: plan.windows, done, planes: asm.out };\n'
      + '    readWindow(' },
  { id: 'R3', file: OFF, what: 'progress is emitted only for the last window',
    find: '    if (onProgress) {',
    to: '    if (onProgress && done === plan.windows) {' },
  { id: 'R4', file: OFF, what: 'pct counts windows STARTED rather than finished',
    find: '        pct: done / plan.windows,',
    to: '        pct: (done + 1) / plan.windows,' },
  { id: 'R5', file: OFF, what: 'the ETA averages over the whole plan rather than over what ran',
    find: '        etaMs: done ? Math.round((elapsedMs / done) * (plan.windows - done)) : null,',
    to: '        etaMs: done ? Math.round((elapsedMs / plan.windows) * (plan.windows - done)) : null,' },
  { id: 'R6', file: OFF, what: 'a throwing separator is swallowed and the loop grinds on',
    find: '    } catch (e) {\n'
      + '      // Named with the window, because "the model threw" three layers down is',
    to: '    } catch (e) {\n      continue;\n      // eslint-disable-next-line' },
  { id: 'R7', file: OFF, what: 'the failure no longer names the window',
    find: '      throw new Error(`offline: window ${k} of ${plan.windows} failed to separate: `\n'
      + '        + `${String((e && e.message) || e)}`);',
    to: '      throw new Error(`separation failed: ${String((e && e.message) || e)}`);' },
  { id: 'R8', file: OFF, what: 'every window is folded in as window 0 — the throw that escaped the '
      + 'group and killed the whole file before the group guard existed',
    find: '    asm.add(k, out);',
    to: '    asm.add(0, out);' },
  { id: 'R9', file: OFF, what: 'the separator type check is removed',
    find: "  if (typeof separate !== 'function') {",
    to: '  if (false) {' },
  { id: 'R10', file: OFF, what: 'each window is separated twice — the seam allows it, the count does not',
    find: '      out = await separate(mixL, mixR, k);',
    to: '      out = await separate(mixL, mixR, k);\n      out = await separate(mixL, mixR, k);' },

  // -------------------------------------------------------------- the wiring
  { id: 'W1', file: OFF, what: 'the Source is read TWICE, and the one-shot obligation goes with it',
    find: '    if (read) {',
    to: '    await sourceBytes(token);\n    if (false) {' },
  { id: 'W2', file: OFF, what: 'the capacity refusal is computed and IGNORED, so the model runs for '
      + 'an entry that cannot be stored',
    find: "  if (whyCap) return fail('CACHE_FULL', whyCap);",
    to: "  if (false) return fail('CACHE_FULL', whyCap);" },
  { id: 'W3', file: OFF, what: 'the decode-clock check is dropped — the model is fed the wrong rate',
    find: '  if (track.sampleRate !== SR) {',
    to: '  if (false) {' },
  { id: 'W4', file: OFF, what: 'the file identity refusal is dropped — an empty file is separated',
    find: "  if (whyFile) return fail('SOURCE_REJECTED', whyFile);",
    to: "  if (false) return fail('SOURCE_REJECTED', whyFile);" },
  { id: 'W5', file: OFF, what: 'the key is built by hand instead of from the tier instance, so the '
      + 'key and the bytes can disagree about depth and geometry',
    find: '  const key = cache.keyFor(fileId, hopSeconds);',
    to: '  const key = `${fileId}--legacy`;' },
  { id: 'W6', file: OFF, what: 'a cancelled run does NOT abort the writer, so commit() lands a '
      + 'part-separated track under the whole track’s key',
    find: '  if (res.cancelled) {\n    writer.abort();',
    to: '  if (res.cancelled) {' },
  { id: 'W8', file: OFF, what: 'the commit policy is ignored — a short run becomes an entry',
    find: '  if (whyCommit) {',
    to: '  if (false) {' },
  { id: 'W9', file: OFF, what: 'the progress re-stamp is dropped, so elapsedMs restarts mid-run',
    find: "      onProgress: (p) => emit({ type: 'SEPARATE_PROGRESS', deck, ...p, elapsedMs: now() - t0 }),",
    to: "      onProgress: (p) => emit({ type: 'SEPARATE_PROGRESS', deck, ...p })," },
  { id: 'W10', file: OFF, what: 'progress rides STATE, where push() would coalesce it away',
    find: "    type: 'SEPARATE_PROGRESS', deck, stage, window, windows, pct,",
    to: "    type: 'STATE', deck, stage, window, windows, pct," },
  { id: 'W11', file: OFF, what: 'building the envelope no longer checks the code',
    find: "  checkSeparateCode(code, 'SEPARATE_ERROR');\n  return { type: 'SEPARATE_ERROR', deck, code, message };",
    to: "  return { type: 'SEPARATE_ERROR', deck, code, message };" },
  { id: 'W12', file: OFF, what: 'the vocabulary is opened up — every code is accepted',
    find: '  if (SEPARATE_CODES.has(code)) return null;',
    to: '  return null;' },
  { id: 'W13', file: OFF, what: 'the twelve planes fan out from one — six identical stems, the '
      + 'failure an identity separator cannot see',
    find: '  writer.append(planes, plan.frames);',
    to: '  writer.append(planes.map(() => planes[0]), plan.frames);' },
  { id: 'W15', file: OFF, what: 'the commit stage is never reported, so the wire goes quiet at the '
      + 'longest step of the run',
    find: "  say('commit', plan.windows, plan.windows, 1);",
    to: '  ;' },
];

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const hashOf = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

if (args.includes('--stamp')) {
  for (const f of Object.keys(CUT.files)) console.log(`${f}  ${hashOf(f)}`);
  process.exit(0);
}
if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(4)} ${m.what}`);
  console.log(`\n${MUTATIONS.length} anchors, cut against ${CUT.base}`);
  process.exit(0);
}

/** The suite, run once. Returns {passed, failed, crashed}. */
function runSuite() {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['test.js', 'offline'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // A non-zero exit is what a red suite does; the output is still what matters.
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const m = /(\d+) passed, (\d+) failed/.exec(out.replace(/\[[0-9;]*m/g, ''));
  if (!m) return { passed: 0, failed: 0, crashed: true };
  return { passed: +m[1], failed: +m[2], crashed: false };
}

const files = [...new Set(MUTATIONS.map((m) => m.file))];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files],
  { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) {
  console.error('u5a-mutations: REFUSING TO RUN — these files have uncommitted changes:\n' + dirty
    + '\n  Every anchor is applied to the real file and restored afterwards, so an interrupted run '
    + 'over a dirty tree is indistinguishable from work in progress. Commit or stash first.');
  process.exit(2);
}

// --- the stamp, before anything else: an anchor over a moved file is suspect
console.log(`u5a-mutations — ${CUT.slice}\n  anchors cut against ${CUT.base}\n`);
let moved = 0;
for (const [f, want] of Object.entries(CUT.files)) {
  const got = hashOf(f);
  if (got === want) { console.log(`  UNCHANGED  ${f}`); continue; }
  moved++;
  console.log(`  MOVED      ${f}\n             cut against ${want.slice(0, 12)}, now ${got.slice(0, 12)}`
    + '\n             every anchor over this file is SUSPECT even where it still matches');
}

const base = runSuite();
console.log(`\n  baseline (no mutation): ${base.passed} passed, ${base.failed} failed`
  + `${base.crashed ? '  *** NO SUMMARY LINE — the suite crashed ***' : ''}`);
if (base.failed !== 0 || base.crashed) {
  console.error('\nu5a-mutations: the UNMUTATED suite is not green, so every "red" below would be '
    + 'meaningless. Fix the tree first.');
  process.exit(2);
}

const originals = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]));
const restore = () => { for (const [f, text] of originals) writeFileSync(join(ROOT, f), text); };
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const rows = [];
try {
  for (const m of MUTATIONS) {
    if (only && m.id !== only) continue;
    const src = originals.get(m.file);
    const hits = src.split(m.find).length - 1;
    if (hits !== 1) {
      rows.push({ id: m.id, match: false, reds: null, hits, at: '-', what: m.what });
      continue;
    }
    /**
     * WHERE the anchor landed, printed rather than left to be looked up. An
     * anchor's LOCATION is the thing that decays — a slice that rewrites the
     * lines around it moves this number long before the text stops matching —
     * so a report that names it lets a reader compare two runs directly.
     */
    const at = `${m.file}:${src.slice(0, src.indexOf(m.find)).split('\n').length}`;
    writeFileSync(join(ROOT, m.file), src.replace(m.find, m.to));
    const r = runSuite();
    restore();
    rows.push({ id: m.id, match: true, reds: r.crashed ? 'CRASH' : r.failed, at, what: m.what });
  }
} finally { restore(); }

console.log('\n  id    anchor        result        where                            what it breaks');
console.log('  ----  ------------  ------------  -------------------------------  ' + '-'.repeat(40));
let matched = 0;
let red = 0;
for (const r of rows) {
  if (r.match) matched++;
  const anchor = r.match ? 'MATCHES' : `NO MATCH (${r.hits})`;
  let result;
  if (!r.match) result = 'decayed';
  else if (r.reds === 'CRASH') { result = 'CRASH'; red++; }
  else if (r.reds > 0) { result = `${r.reds} red`; red++; }
  else result = 'STILL GREEN';
  const where = (r.at || '-').replace('extension/engine/', 'e/');
  console.log(`  ${r.id.padEnd(4)}  ${anchor.padEnd(12)}  ${String(result).padEnd(12)}  `
    + `${where.padEnd(31)}  ${r.what.slice(0, 60)}`);
}
console.log(`\n  ${matched} of ${rows.length} anchors still MATCH   ${red} of ${rows.length} still RED`
  + `   (${moved} anchored file(s) moved since the cut)`);
console.log('  An anchor that no longer MATCHES is a decayed instrument — re-cut it.');
console.log('  One that matches and no longer REDS is decay OR a real coverage loss — find out which.');
process.exit(red === rows.length && moved === 0 ? 0 : 1);
