#!/usr/bin/env node
/**
 * U5a's MUTATION BATTERY — the instrument behind every "watched red" claim in
 * `test.js` group('offline'), kept IN THE REPOSITORY rather than in a scratch
 * directory.
 *
 *   node qa/u5a-mutations.mjs            run all of them
 *   node qa/u5a-mutations.mjs --list     what they are, without running anything
 *   node qa/u5a-mutations.mjs --only N7  one of them  (coverage is NOT computed)
 *   node qa/u5a-mutations.mjs --stamp    print the anchored files' hashes NOW
 *   node qa/u5a-mutations.mjs --measure  print each case's OBSERVED red set as a
 *                                        pasteable `expect:` line, for re-cutting
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS COMMITTED. A mutation battery is the only instrument that can see a
 * whole class of change: three commits in this phase moved zero assertions and
 * every one of them mattered, and neither an assertion count nor a coverage diff
 * can distinguish those from a no-op. Two batteries in this build were lost
 * because they lived in a scratch directory, and every "watched red" they
 * justified became an unverifiable claim the moment the process ended.
 *
 * ---------------------------------------------------------------------------
 * IT REPORTS FOUR THINGS PER ANCHOR, AND EACH ONE HIDES A DIFFERENT DEFECT.
 *
 *   MATCHES?   did the anchor still find its text? A NO is a DECAYED INSTRUMENT —
 *              some other slice rewrote the line this patches — and the response
 *              is to RE-CUT it. It is not a coverage loss and must not read as
 *              one.
 *   RED?       did the mutation still make the suite fail? A NO is either decay
 *              or a REAL COVERAGE LOSS, and the response is to find out which.
 *   WHICH?     did it red EXACTLY the assertions this case DECLARES it must, in
 *              BOTH DIRECTIONS? An aggregate cannot see this: coverage migrating
 *              from one mutation to another leaves the union unchanged, so the
 *              total is answering a different question from the one anyone reads
 *              it as. An assertion going red under an UNEXPECTED mutation is as
 *              much a finding as one going red under none.
 *   HOW MANY
 *   STILL RAN? a mutation that makes a block THROW takes every assertion after it
 *              down with it. The group guard converts that crash into one named
 *              red — which is right, and it is NOT the same as coverage. R8 used
 *              to print "1 red" in a row typographically identical to a mutation
 *              that reds one targeted assertion with all 89 running; measured, R8
 *              leaves 10 of 89 running. A case that truncates must SAY SO
 *              (`truncates: true`) and the row prints the survivor count.
 *
 * Measured in this phase: a 30-anchor battery that had reported 51/51 gave 44/51
 * later, and the seven gaps were TEN anchors that no longer matched anything —
 * ten instruments that had silently stopped pointing at their target, reported as
 * if seven assertions had weakened.
 *
 * ---------------------------------------------------------------------------
 * THE COVERAGE CLAIM IS COMPUTED, NOT ASSERTED IN PROSE — and this is the fix for
 * a defect in this slice's own evidence. `test.js` group('offline') carried a
 * header saying "WATCHED RED BY MUTATION — every assertion below". A reviewer
 * applied all 39 committed anchors, captured the FAILING NAMES rather than the
 * counts, unioned them and subtracted from the baseline: EIGHTEEN of sixty-five
 * names never appeared. The header claimed more than the battery did, which is
 * the same defect as a name claiming more than its code checks.
 *
 * So the claim is now a MEASUREMENT with a declared exception list: every
 * assertion in the suite is either named by some case's `expect`, or listed in
 * `NOT_WATCHED` with the reason it cannot be. The battery FAILS if the union and
 * the suite differ IN EITHER DIRECTION — a new assertion nobody anchored, or a
 * declaration for an assertion that no longer exists.
 *
 * AND IT IS NOT PRINTED WHEN IT WAS NOT MEASURED. `--only` runs one case, so the
 * union is meaningless; the report says the coverage pass did not run rather than
 * printing a sentence it did not earn.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STAMP IS, AND WHY IT IS A CONTENT HASH RATHER THAN A COMMIT SHA. The
 * anchors were cut against the files below, at the contents below. A sha would
 * name a commit that a rebase can rewrite — and stamping against an unlanded tip
 * is the failure the stamp exists to prevent — so `base` names the LANDED commit
 * this work is cut from, and each anchored file carries the SHA-256 of its
 * contents at cut time. A file whose hash has moved is a file whose anchors are
 * SUSPECT EVEN WHERE THEY STILL MATCH, and the report says so, per file, before
 * it says anything about reds.
 *
 * `test.js` IS IN THAT LIST EVEN THOUGH NO ANCHOR PATCHES IT. Every red count and
 * every red NAME below is as much a property of the suite as of the code, so a
 * later slice that edits group('offline') changes this battery's meaning while a
 * report stamped only on `offline.js` still prints UNCHANGED. It is the file most
 * likely to move, which is the argument for stamping it and not against.
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
const SC = 'extension/shared/stemcache.js';
const LIVE = 'extension/engine/live.js';
const SUITE = 'test.js';

/**
 * THE STAMP. `base` is the landed commit this branch is cut from; the hashes are
 * the anchored files (and the SUITE) as they stood when the anchors were cut.
 * Update all of them with `--stamp` when you re-cut, and say in the commit
 * message that you did.
 */
const CUT = {
  base: '5993d32',
  slice: 'U5a — the ahead-of-time separation runner (#41)',
  files: {
    'extension/engine/offline.js': '__OFF__',
    'extension/shared/stemcache.js': '__SC__',
    'extension/engine/live.js': '__LIVE__',
    'test.js': '__SUITE__',
  },
};

/**
 * DECLARED NOT WATCHED, WITH THE REASON. Anything in the suite that no anchor
 * reds must appear here or the coverage pass fails. A reason of the shape "it is
 * a control" is legitimate — a control asserts that the instrument can say the
 * OTHER thing, and a mutation that reds it would be a mutation that broke the
 * control rather than the code.
 */
const NOT_WATCHED = [
  { key: 'THE HEADER’S GROUP LIST IS THE GROUPS THIS FILE ACTUALLY HAS',
    why: 'not in group(offline) at all — it runs unconditionally and is U0-era; no anchor over '
      + 'this slice’s files can reach it, and it is counted here only because it prints in the '
      + 'same run' },
];

/**
 * Each anchor: `find` must appear EXACTLY ONCE in the file, or the battery
 * refuses it as ambiguous — an anchor that patches the first of several
 * identical lines is an anchor nobody can reason about.
 *
 * `expect` names the assertions this case MUST red, by a substring unique to one
 * assertion in the suite. A key that matches zero or several names is itself a
 * failure: the declaration decayed.
 *
 * `truncates: true` says this mutation makes a block throw, so the group guard
 * fires and the assertions after it never run. The row prints how many survived.
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
  { id: 'N18', file: OFF, what: 'THE PLANE-COUNT GUARD IS DROPPED — the assertion that named it used '
      + 'to pass anyway, because the loop then dies on undefined.length, which is also a throw',
    find: '    if (src.length !== this.out.length) {',
    to: '    if (false) {' },
  { id: 'N19', file: OFF, what: 'the stride refusal becomes BLANKET — one frame inside the segment '
      + 'is refused too, which only the control assertion can see',
    find: '  if (!(stride > 0 && stride < segment)) {',
    to: '  if (!(stride > 0 && stride < segment - 1)) {' },

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
    to: '    asm.add(0, out);',
    truncates: true },
  { id: 'R9', file: OFF, what: 'the separator type check is removed',
    find: "  if (typeof separate !== 'function') {",
    to: '  if (false) {' },
  { id: 'R10', file: OFF, what: 'each window is separated twice — the seam allows it, the count does not',
    find: '      out = await separate(mixL, mixR, k);',
    to: '      out = await separate(mixL, mixR, k);\n      out = await separate(mixL, mixR, k);' },
  { id: 'R11', file: OFF, what: 'a finished run reports done: 0, so the caller cannot tell it finished',
    find: '  return { cancelled: false, windows: plan.windows, done, planes: asm.finish() };',
    to: '  return { cancelled: false, windows: plan.windows, done: 0, planes: asm.finish() };' },

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
  { id: 'W16', file: OFF, what: 'a cancelled run APPENDS AND COMMITS what it has — the stem files '
      + 'land under the whole track’s key, which the old "nothing landed" assertion could not see '
      + 'because it compared against a null key',
    find: '  if (res.cancelled) {\n    writer.abort();',
    to: '  if (res.cancelled) {\n    writer.append(Array.from({ length: STEMS.length * 2 }, '
      + '() => new Float32Array(plan.frames)), plan.frames);' },
  { id: 'W17', file: OFF, what: 'SEPARATE_DONE is never emitted — the run succeeds in silence',
    find: "  emit({\n    type: 'SEPARATE_DONE',",
    to: "  if (false) emit({\n    type: 'SEPARATE_DONE'," },
  { id: 'W18', file: OFF, what: 'the progress payload loses etaMs, one of the five fields state.job '
      + 'never wrote',
    find: '    elapsedMs: now() - t0, etaMs: null,\n  });',
    to: '    elapsedMs: now() - t0,\n  });' },
  { id: 'W19', file: OFF, what: 'an unreadable Source raises the WRONG code — a receiver offers the '
      + 'wrong action for it',
    find: "    return fail('SOURCE_UNREADABLE', `the Host could not hand over this file: ${why(e)}`);",
    to: "    return fail('CACHE_FULL', `the Host could not hand over this file: ${why(e)}`);" },
  { id: 'W20', file: OFF, what: 'a failed decode raises SOURCE_UNREADABLE instead of DECODE_FAILED',
    find: "    return fail('DECODE_FAILED', `this file could not be decoded: ${why(e)}`);",
    to: "    return fail('SOURCE_UNREADABLE', `this file could not be decoded: ${why(e)}`);" },
  { id: 'W21', file: OFF, what: 'an unreadable TIER is assumed empty instead of refused, so the '
      + 'capacity question is answered by a guess',
    find: '    entries = await cache.list();',
    to: '    entries = await cache.list().catch(() => []);' },
  { id: 'W22', file: OFF, what: 'a failed WRITE is reported as COMMIT_REFUSED — the UI then offers '
      + 'Retry for the one thing retrying cannot fix, or withholds it from the one it can',
    find: "    return fail('COMMIT_FAILED', `the entry could not be written: ${why(e)}`);",
    to: "    return fail('COMMIT_REFUSED', `the entry could not be written: ${why(e)}`);" },
  { id: 'W23', file: OFF, what: 'a failure is returned but never put ON THE WIRE — the caller is '
      + 'told and the receiver waits for ever',
    find: '    emit(separateError(deck, code, message));',
    to: '    ;' },
  { id: 'W24', file: OFF, what: 'a LEGAL code is reported too — the check fires on everything, so '
      + 'the console line stops meaning anything',
    find: '  if (SEPARATE_CODES.has(code)) return null;',
    to: '  if (SEPARATE_CODES.has(code) && false) return null;' },
  { id: 'W25', file: OFF, what: 'the envelope REWRITES the message, taking the user’s actual problem '
      + 'off the screen and replacing it with a second failure',
    find: "  return { type: 'SEPARATE_ERROR', deck, code, message };",
    to: "  return { type: 'SEPARATE_ERROR', deck, code, message: 'unknown separation error' };" },
  { id: 'W26', file: OFF, what: 'a declared code is removed from the set',
    find: "  'COMMIT_REFUSED', 'COMMIT_FAILED', 'CANCELLED',",
    to: "  'COMMIT_REFUSED', 'COMMIT_FAILED'," },
  { id: 'W27', file: OFF, what: 'THE PINS ARE NOT THREADED TO THE COMMIT — a pinned entry is evicted '
      + 'by the very put that follows it, and it goes FIRST because LRU takes the oldest',
    find: '    committed = await writer.commit(cache, pins);',
    to: '    committed = await writer.commit(cache);' },
  { id: 'W28', file: OFF, what: 'the malformed-decode guard RETHROWS, so a decoder that returns '
      + 'mismatched channels rejects out of the runner with nothing on the wire — the shape the '
      + 'guard exists to prevent, and it kills the block',
    find: "    return fail('DECODE_FAILED', `the decoder produced audio the geometry cannot use: ${why(e)}`);",
    to: '    throw e;',
    truncates: true },

  // ------------------------------------------ what the engine hands over (D6)
  { id: 'E1', file: OFF, what: 'the slot lets TWO runs start — the capacity question becomes '
      + 'unanswerable and the peak memory doubles',
    find: '    if (this.job) {',
    to: '    if (false) {' },
  { id: 'E2', file: OFF, what: 'a cancel ignores which deck it names, so cancelling deck B stops '
      + 'deck A',
    find: '    if (!this.job || this.job.deck !== deck) return false;',
    to: '    if (!this.job) return false;' },
  { id: 'E3', file: OFF, what: 'the slot is released by ANY job — a late finally from a finished run '
      + 'frees the slot a new run is holding',
    find: '    if (this.job === job) this.job = null;',
    to: '    this.job = null;' },
  { id: 'E4', file: OFF, what: 'a per-message geometry override is honoured, so causal stems land in '
      + 'a directory whose keys say offline',
    find: '  if (asked == null || asked === tierGeometry) return null;',
    to: '  return null;' },
  { id: 'E5', file: OFF, what: 'a MONO file up-mixes to a silent right channel instead of the same '
      + 'signal',
    find: '  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;',
    to: '  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : new Float32Array(buf.length);' },
  { id: 'E6', file: OFF, what: 'a decode that produced nothing is accepted rather than thrown',
    find: '  if (!buf || !(buf.length > 0) || !(buf.numberOfChannels > 0)) {',
    to: '  if (false) {' },
  { id: 'E7', file: OFF, what: 'an ahead-of-time window is given a FINITE budget, which is what makes '
      + 'it demotable by the GPU scheduler',
    find: '      res = await infer(mix, out, Infinity);',
    to: '      res = await infer(mix, out, 1950);' },
  { id: 'E8', file: OFF, what: 'a demotion is folded in as audio — it carries none, so the track gets '
      + 'undefined',
    find: '    if (res && res.demoted) {',
    to: '    if (false) {' },
  { id: 'E9', file: OFF, what: 'the buffers are not re-owned after a failure, so the next window '
      + 'meets a detached ArrayBuffer',
    find: '      mix = new ArrayBuffer(2 * segment * 4);\n      out = new ArrayBuffer(planes * segment * 4);\n      throw e;',
    to: '      throw e;' },
  { id: 'E10', file: OFF, what: 'a separator built with no infer is accepted, and fails at the first '
      + 'window instead of at the door',
    find: "  if (typeof infer !== 'function') {",
    to: '  if (false) {' },
  { id: 'E11', file: OFF, what: 'every plane view is the FIRST plane — twelve copies of one stem, '
      + 'read straight off the lent-back buffer',
    find: '    for (let i = 0; i < planes; i++) planeViews.push(stems.subarray(i * segment, (i + 1) * segment));',
    to: '    for (let i = 0; i < planes; i++) planeViews.push(stems.subarray(0, segment));' },

  // --------------------------------------------------- the tier it writes to
  { id: 'S1', file: SC, what: 'put() stops threading the pins to evict — the same defect as W27, one '
      + 'layer down, and either alone is enough to lose a pinned entry',
    find: '    return this.evict(pins);',
    to: '    return this.evict();' },
  { id: 'S2', file: SC, what: 'the manifest records depth 16 for a 32-bit-float entry — the key still '
      + 'says d32f, so the entry and its own record disagree',
    find: '      depth: this.depth, geometry: this.geometry, drops: 0, ...meta,',
    to: '      depth: 16, geometry: this.geometry, drops: 0, ...meta,' },
  { id: 'S3', file: SC, what: 'every tier writes its stems into the LIVE directory — the 32f entry '
      + 'lands where a 16-bit causal one lives',
    find: '      await writeFile(d, `${key}.${s}.wav`, wav);',
    to: '      await writeFile(await dir(CACHE_DIR), `${key}.${s}.wav`, wav);' },
  { id: 'S4', file: SC, what: 'the stem files drop the key from their names, so two entries in one '
      + 'tier overwrite each other',
    find: '      await writeFile(d, `${key}.${s}.wav`, wav);',
    to: '      await writeFile(d, `${s}.wav`, wav);' },

  // ----------------------------------------- the join it borrows from `live`
  { id: 'L1', file: LIVE, what: 'makeFades stops being complementary — fi+fo no longer sums to one, '
      + 'so the offline weighting silently needs a division it does not do',
    find: '    else { fi[i] = u; fo[i] = 1 - u; }',
    to: '    else { fi[i] = u; fo[i] = 1 - u * 0.5; }' },
];

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const measure = args.includes('--measure');
const hashOf = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');
const strip = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');

if (args.includes('--stamp')) {
  for (const f of Object.keys(CUT.files)) console.log(`    '${f}': '${hashOf(f)}',`);
  process.exit(0);
}
if (args.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(4)} ${m.what}`);
  console.log(`\n${MUTATIONS.length} anchors, cut against ${CUT.base}`);
  process.exit(0);
}

/**
 * The suite, run once. Returns the summary AND the NAMES, because a count cannot
 * tell coverage that MIGRATED between two mutations from coverage that is intact
 * — the union is the same either way.
 */
function runSuite() {
  let out = '';
  try {
    out = execFileSync(process.execPath, ['test.js', 'offline'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // A non-zero exit is what a red suite does; the output is still what matters.
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  const clean = strip(out);
  const names = { pass: [], fail: [] };
  for (const line of clean.split('\n')) {
    const m = /^ {2}(PASS|FAIL) (.*)$/.exec(line);
    if (m) names[m[1] === 'PASS' ? 'pass' : 'fail'].push(m[2].trim());
  }
  const m = /(\d+) passed, (\d+) failed/.exec(clean);
  if (!m) return { passed: 0, failed: 0, crashed: true, names };
  return { passed: +m[1], failed: +m[2], crashed: false, names };
}

/**
 * An assertion NAME as printed carries its detail text; the `expect` keys are
 * substrings of the name. Resolve a key to the one baseline line it names, and
 * refuse a key that names none or several — a declaration nobody can resolve is
 * a declaration that has decayed.
 */
function resolve(key, baseline) {
  const hits = baseline.filter((n) => n.includes(key));
  return { key, hits };
}

const files = [...new Set(MUTATIONS.map((m) => m.file))];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...files, SUITE],
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
  console.log(`  MOVED      ${f}\n             cut against ${String(want).slice(0, 12)}, now ${got.slice(0, 12)}`
    + '\n             every anchor over this file is SUSPECT even where it still matches');
}

const base = runSuite();
const baseNames = base.names.pass.concat(base.names.fail);
const baseRan = base.passed + base.failed;
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
      rows.push({ id: m.id, match: false, hits, at: '-', m });
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
    rows.push({ id: m.id, match: true, at, m, r, ran: r.passed + r.failed });
  }
} finally { restore(); }

if (measure) {
  console.log('\n  --measure: the OBSERVED red set per case, as pasteable declarations\n');
  for (const r of rows) {
    if (!r.match) { console.log(`  // ${r.id}: NO MATCH (${r.hits})`); continue; }
    const keys = r.r.names.fail.map((n) => `'${n.split('  ')[0].slice(0, 58).replace(/'/g, "\\'")}'`);
    console.log(`  ${r.id}: expect: [${keys.join(', ')}]${r.ran < baseRan ? `, truncates: true // ${r.ran}/${baseRan} ran` : ''}`);
  }
  process.exit(0);
}

// --- resolve every declaration against the baseline, both directions --------
const declared = new Set();
const badKeys = [];
for (const m of MUTATIONS) {
  for (const key of (m.expect || [])) {
    const { hits } = resolve(key, baseNames);
    if (hits.length !== 1) badKeys.push(`${m.id} expect ${JSON.stringify(key)} names ${hits.length} assertions`);
    else declared.add(hits[0]);
  }
}
for (const nw of NOT_WATCHED) {
  const { hits } = resolve(nw.key, baseNames);
  if (hits.length !== 1) badKeys.push(`NOT_WATCHED ${JSON.stringify(nw.key)} names ${hits.length} assertions`);
  else declared.add(hits[0]);
}

console.log('\n  id    anchor        reds          ran     where                     what it breaks');
console.log('  ----  ------------  ------------  ------  ------------------------  ' + '-'.repeat(38));
let matched = 0;
let red = 0;
let asDeclared = 0;
const problems = [];
for (const r of rows) {
  const m = r.m;
  if (!r.match) {
    problems.push(`${r.id}: ANCHOR NO LONGER MATCHES (${r.hits} hits) — a decayed instrument; re-cut it`);
    console.log(`  ${r.id.padEnd(4)}  ${`NO MATCH (${r.hits})`.padEnd(12)}  ${'decayed'.padEnd(12)}  `
      + `${'-'.padEnd(6)}  ${'-'.padEnd(24)}  ${m.what.slice(0, 38)}`);
    continue;
  }
  matched++;
  const observed = new Set(r.r.names.fail);
  const want = new Set();
  for (const key of (m.expect || [])) {
    const { hits } = resolve(key, baseNames);
    if (hits.length === 1) want.add(hits[0]);
  }
  const missing = [...want].filter((n) => !observed.has(n));
  const extra = [...observed].filter((n) => !want.has(n));
  if (observed.size) red++;
  const okSet = !missing.length && !extra.length && want.size > 0;
  if (okSet) asDeclared++;
  if (!observed.size) problems.push(`${r.id}: MATCHES but NO LONGER REDS — decay OR a real coverage loss; find out which`);
  else if (!want.size) problems.push(`${r.id}: reds ${observed.size} assertion(s) but DECLARES NONE — add an expect set`);
  else {
    for (const n of missing) problems.push(`${r.id}: DECLARED red did NOT fail — "${n.split('  ')[0].slice(0, 60)}"`);
    for (const n of extra) problems.push(`${r.id}: UNDECLARED red — "${n.split('  ')[0].slice(0, 60)}"`);
  }
  const truncated = r.ran < baseRan;
  if (truncated && !m.truncates) problems.push(`${r.id}: TRUNCATES the suite (${r.ran} of ${baseRan} ran) and does not declare it`);
  if (!truncated && m.truncates) problems.push(`${r.id}: declares truncates:true but all ${r.ran} assertions ran`);
  const where = (r.at || '-').replace('extension/engine/', 'e/').replace('extension/shared/', 's/');
  console.log(`  ${r.id.padEnd(4)}  ${'MATCHES'.padEnd(12)}  `
    + `${`${observed.size} red${okSet ? '' : ' !'}`.padEnd(12)}  `
    + `${`${r.ran}/${baseRan}${truncated ? '*' : ''}`.padEnd(6)}  ${where.padEnd(24)}  ${m.what.slice(0, 38)}`);
}

console.log(`\n  ${matched} of ${rows.length} anchors MATCH   ${red} of ${rows.length} RED   `
  + `${asDeclared} of ${rows.length} RED EXACTLY AS DECLARED   `
  + `(${moved} anchored file(s) moved since the cut)`);
console.log('  * in the "ran" column: the mutation made a block throw, the group guard converted it '
  + 'to one named\n    red, and the assertions after it DID NOT RUN. That is a report, not coverage.');

// --- the coverage claim, computed, and only when it was measured ------------
const full = !only;
if (!full) {
  console.log('\n  COVERAGE NOT COMPUTED — this was a --only run, so the union of the expect sets is '
    + 'a\n  claim about one case rather than about the suite. Run the whole battery for it.');
} else {
  const unwatched = baseNames.filter((n) => !declared.has(n));
  const ghosts = [...declared].filter((n) => !baseNames.includes(n));
  console.log(`\n  COVERAGE: ${declared.size} of ${baseNames.length} assertions in the suite are `
    + `named by a declaration\n  (${NOT_WATCHED.length} of them as NOT WATCHED, with a reason).`);
  for (const n of unwatched) problems.push(`COVERAGE: no case declares "${n.split('  ')[0].slice(0, 60)}" and it is not in NOT_WATCHED`);
  for (const n of ghosts) problems.push(`COVERAGE: a declaration names "${n.slice(0, 60)}", which the suite no longer prints`);
  for (const b of badKeys) problems.push(`COVERAGE: ${b}`);
  if (!unwatched.length && !ghosts.length && !badKeys.length) {
    console.log('  Every assertion the suite prints is either watched red by a named case or '
      + 'declared\n  unwatchable with its reason. Both directions checked.');
  }
}

if (problems.length) {
  console.log('\n  PROBLEMS');
  for (const p of problems) console.log(`    - ${p}`);
}
console.log('\n  An anchor that no longer MATCHES is a decayed instrument — re-cut it.');
console.log('  One that matches and no longer REDS is decay OR a real coverage loss — find out which.');
console.log('  One that reds a DIFFERENT SET than it declares is coverage that MOVED, which no '
  + 'aggregate can see.');
process.exit(problems.length === 0 && moved === 0 ? 0 : 1);
