#!/usr/bin/env node
/**
 * qa/mutations-u7-live-recording.mjs — U7's mutation battery, in the repository.
 *
 *   node qa/mutations-u7-live-recording.mjs              # every mutation
 *   node qa/mutations-u7-live-recording.mjs M4 M9        # only these
 *   node qa/mutations-u7-live-recording.mjs --list       # anchors only; mutates nothing
 *   node qa/mutations-u7-live-recording.mjs --self-check # prove the battery can say MUTE
 *   node qa/mutations-u7-live-recording.mjs --discover    # print the reds, check nothing
 *   node qa/mutations-u7-live-recording.mjs --coverage   # which U7 assertions no mutation claims
 *   node qa/mutations-u7-live-recording.mjs --table      # regenerate the table in test.js's header
 *
 * WHY THIS FILE EXISTS. `test.js` group('live') carries a mutation table in its
 * header naming, per mutation, the assertions it reddened. That table is a CLAIM
 * ABOUT A TREE, and the tree moves. An anchor patches a specific span of source,
 * and when a later slice rewrites that span the mutation stops applying —
 * SILENTLY, because a search that matches nothing looks exactly like a search
 * that matched and passed. A Phase 4 sweep found a 30-mutation battery that had
 * reported 51/51 scoring 44/51 later, of which SEVEN were dead anchors rather
 * than weak assertions. Two other batteries could not be swept at all: they
 * existed only in an agent transcript, under /tmp. This is U7's battery, checked
 * in, so its numbers can be re-established by anyone.
 *
 * IT REPORTS TWO THINGS SEPARATELY, PER MUTATION, because they need opposite
 * responses:
 *   - does the ANCHOR still match the source?  A miss is a DECAYED INSTRUMENT.
 *     Re-cut it; the assertion may be perfectly healthy.
 *   - does the mutation still RED what it claims?  A matching anchor that no
 *     longer reddens is either a decayed instrument OR A REAL COVERAGE LOSS,
 *     and those are told apart by reading, not by a score.
 * A battery that collapses both into one pass count is how ten dead anchors come
 * to look like seven weak assertions.
 *
 * THE CONTROL RUNS FIRST, AND IT IS NOT DECORATION. Every verdict below is
 * "these assertions went red". If the suite were already red — a broken fixture,
 * a sibling slice mid-landing — every mutation would report RED without having
 * caused anything, and the battery would print a perfect score while measuring
 * nothing. So the unmutated suite is run first and must be FULLY GREEN, and each
 * mutation's red set is compared EXACTLY: an assertion that reddens but is not
 * claimed is reported as loudly as one that is claimed and stays green.
 *
 * `--self-check` closes the other half. It applies a mutation that changes only
 * a comment and requires the battery to report MUTE. A battery that cannot
 * produce a MUTE cannot distinguish a live assertion from a dead one.
 *
 * TWO WAYS TO READ A RUN WRONG, BOTH MET IN THIS SLICE AND BOTH DESIGNED OUT:
 *   - DO NOT decide a run crashed by grepping the output for an error word. It
 *     false-positives on a red whose DETAIL quotes the stack it caught — the
 *     guard working, reported as the guard failing. A crash here is "no summary
 *     line", nothing else.
 *   - DO NOT match reds on the bare string FAIL. It matches PASS lines whose
 *     detail text contains "FAILURE". A red is a line that STARTS with FAIL.
 *
 * THE GROUP GUARD BOUNDS WHAT A RED MEANS. group('live') wraps its body in
 * try/catch, so a mutation that makes the group THROW is converted into ONE
 * named red — `group(live) REACHED ITS LAST ASSERTION` — and every assertion
 * after the throw is ABSENT rather than red. Those mutations are marked
 * `throws: true` below and their `expect` sets are small ON PURPOSE: they are
 * evidence that the guard reports, NOT evidence that the assertions downstream
 * of the throw are watching anything. Never read a `throws` row as coverage of
 * more than it lists.
 *
 * ================= READ THIS BEFORE YOU WRITE ANOTHER BATTERY =================
 * EVERY MUTATION BATTERY IN THIS REPOSITORY MUST DO BOTH OF THE THINGS BELOW.
 * Neither is hygiene. Each is a measured incident in this build.
 *
 * 1. RESTORE ON A SIGNAL, NOT ONLY IN A `finally`. A `finally` does not run when
 *    the process is TERMINATED. This battery takes ~10 minutes; its first full
 *    run was killed by an outer timeout and left `extension/offscreen/live.js`
 *    MUTATED IN THE WORKING TREE, one line different from HEAD, with `git
 *    status` the only thing in the world that would have said so. A tracked
 *    source file silently carrying a deliberate defect is the worst thing a
 *    battery can leave behind: the next gate run measures the mutation and
 *    attributes it to whatever landed last. So: handlers on SIGINT, SIGTERM and
 *    SIGHUP **and** on `uncaughtException`, restoring before exit, and the
 *    restoration VERIFIED BY HASH rather than assumed — see `restoreAll()` and
 *    the `finally` below, which is the shape to copy.
 *
 * 2. ONE BATTERY PER CHECKOUT, EVER. Two batteries in one working tree destroy
 *    it, and the mechanism is exactly the `finally` that makes one battery safe:
 *    each snapshots `before` at ITS OWN start and each faithfully restores to
 *    that snapshot. If the other run's mutation is on disk when your snapshot is
 *    taken, YOUR restore writes THAT MUTATION BACK PERMANENTLY. And `ps` cannot
 *    see it — a battery is a short command run many times, so a process check
 *    between two invocations finds nothing. The check is `git status
 *    --porcelain`, read twice, looking for another agent's uncommitted edits
 *    before you begin (WORKTREES.md 4.5b and 4.11).
 * =============================================================================
 *
 * IT IS DELIBERATELY NOT A verify.mjs STEP, for the same reason. It edits
 * tracked source, and a gate that writes the tree it is gating is a gate that
 * can leave the tree written.
 *
 * EVERY `expect` SET IN THIS FILE WAS MEASURED, NOT REASONED OUT. All fifty
 * rows that existed then were transcribed from one `--discover` run against
 * d85753c at 263 passed / 0 failed, then re-run to confirm. That distinction
 * is the file's whole point,
 * and here is what it bought: NINE OF THE FIFTY hand-written sets were WRONG.
 *   - M20 and M21 declared `{ k: A.drivectl, n: 2 }`. Measured: n is 1, and
 *     both also redden `A.drainrec` and `A.drainflight` (M21 `A.drainaudio`
 *     too). A confident prediction, wrong in the count AND the membership.
 *   - M48, M49 and M50 each declared `[A.perplane]`. Every one also reddens
 *     `A.drainaudio`.
 *   - M1 and M12 were measured correctly in 2026-08 and went stale when the
 *     driven-drain block landed: both now redden drain keys that did not exist
 *     when their rows were written. Nothing was wrong with them; the FILE moved.
 * A hand-written table would have shipped nine wrong rows, each of which reads
 * exactly as authoritative as the forty-one right ones.
 *
 * THE FILE GREW AFTER THAT RUN, AND EVERY NEW ROW WAS MEASURED TOO. The nine
 * driven-drain rows (M39-M47), the three per-plane rows (M48-M50) and the
 * MINOR 6/8 rows (M51-M59) were transcribed from a second `--discover` run at
 * 270 passed / 0 failed, and a THIRD run at the final tree — every one of the
 * 59 rows below — confirmed all of them EXACTLY, both directions: nothing
 * claimed was missing and nothing measured was unclaimed. The numbers in this
 * paragraph are the ones to quote; the 263 in the paragraph above is history.
 *
 * PROVENANCE: EVERY SUBJECT FILE CARRIES THE SHA-256 IT WAS CUT AGAINST, not
 * just a commit id. A commit stamp is a proxy for "the source has not moved"; a
 * content hash IS that, and it stays checkable across a rebase — which matters
 * here because U7 was cut on a branch and rebased onto main once already. The
 * branch base, `main` at 5993d32, is a landed commit and is recorded too.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The landed commit U7 is branched from — `main` at v0.3.0. It is IN HISTORY, so
 * anyone can resolve it (INTEGRATION.md §22). The branch was rebased onto this
 * tip during the repair; the stamps above are CONTENT hashes and survived that
 * rebase, which is exactly why they are content hashes and not commit ids.
 */
const BASE = 'b9dc537';

/**
 * HOW MANY ASSERTIONS `group('live')` REPORTS WHEN GREEN, pinned so the battery
 * notices the suite growing underneath it. See CROSS-CHECK 2 in the control.
 * 240 at BASE + 6 (finish()'s per-plane publication) + 17 (the driven drain)
 * + 7 (the passthrough-exit and writer-seam fixtures of MINOR 6/8).
 */
const SUITE_ASSERTIONS = 270;

/**
 * HOW MANY ASSERTIONS `group('live')` REPORTED AT THE BRANCH BASE, pinned so
 * the battery can tell a MISSING KEY from a STALE WEIGHT. CROSS-CHECK 2 pins
 * the suite side of the ledger; this pins the map side. 187 was measured once,
 * on b9dc537 (v0.3.0), in review-u7-live-recording.txt: `node test.js live`
 * reported "187 passed, 0 failed" there, and 240 - 187 = 53 is the first U7
 * increment the review reconciles. See CROSS-CHECK 3 in the control.
 */
const BASE_LIVE = 187;

/**
 * The four subject files, each with the SHA-256 of the content the anchors below
 * were cut against. A mismatch does not mean an anchor is dead — it means one
 * MIGHT be, and the per-anchor DECAYED lines are what say which.
 */
const SUBJECTS = {
  E: { path: 'extension/engine/live.js',      sha: 'cbf3c2498172454630d3eb4037442f888f723523e2afa57cd37832af73f8e33c' },
  L: { path: 'extension/offscreen/live.js',   sha: '6737e15e5b770fa1c777c678b1808f38213223568d98f4327064c9dd1bfc1d15' },
  S: { path: 'extension/shared/stemcache.js', sha: 'd5f49c9ac81d0fcd5679fb22d9db92e7c05164a9a5356217a5c9f1cfb8a2746c' },
  D: { path: 'extension/offscreen/deck.js',   sha: '1c6e7336bebe4758aa32f93a6047c25b49b11970457a8c5bd1f800f6535d01b3' },
  /**
   * THE FIXTURE IS A SUBJECT TOO, for the CONTROL assertions and only for them.
   * A control's job is to fail when the fixture degenerates — when the thing it
   * was supposed to create a difference in did not — so the only mutation that
   * can watch one red is a mutation OF THE FIXTURE. Marked `fixture: true` on
   * every row that uses it, because a fixture mutation is evidence about the
   * control and about nothing else.
   */
  F: { path: 'test.js', sha: '2f8f9be57a1e7315f785ebbf3a4f7fa6bfffb0ed518e5f02999580292f0d46c5' },
};

/**
 * The 83 assertions U7 adds to group('live'), by the distinctive substring each
 * is matched on. Six of them are emitted once per (hop, stop-point) pair — three
 * hops x two stop points — so a key marked `x6` names six reds, not one.
 * 83 = SUITE_ASSERTIONS - BASE_LIVE, checked by CROSS-CHECK 3 in the control:
 * the map and the suite are the two halves of one ledger, and a battery that
 * lets them disagree cannot say who is covered.
 */
const A = {
  // the drain recovers the tail — x6 each
  short:      'WITHOUT the drain a recording ends',
  exact:      'THE DRAIN RECOVERS THE LAST BUFFER',
  audio:      'the recovered tail is THE AUDIO, at the right offset',
  // the tail constant, and the join measured on passes that DIFFER
  tailconst:  'every hop in LIVE_HOPS leaves a tail PRIME_TAIL_MAX_SEC can still tolerate',
  join:       'THE DRAIN JOINS WITH A CROSSFADE, NOT A BUTT SPLICE',
  joinctl:    'the two passes really differ across that join',
  // the contiguous pass — pure, over shared/stemcache.js
  deliver:    'a pass that captured audio is DELIVERABLE',
  refuse:     'the ONE refusal is a pass that captured nothing',
  distinct:   'the four reasons READ DIFFERENTLY',
  howmany:    'a drop-ended pass says HOW MANY',
  english:    'it counts in English: ONE dropped chunk',
  clean:      'a pass that ended cleanly carries NO drop count',
  invented:   'AN END REASON THIS UNIT HAS NO WORDING FOR IS REFUSED',
  note0:      'passEndNote() says NOTHING for one',
  // the stop path, read out of the source with comments stripped
  order:      'LivePipeline.stop() RAISES THE FLAG, THEN DRAINS, THEN DROPS THE PLAN',
  ownbufs:    'the drain ALLOCATES its own scratch',
  dispose:    'a DISPOSE stops WITHOUT draining',
  firstwin:   'a DROP that ended the pass survives the stop() that follows it',
  plain:      'an ordinary stop still records itself when nothing ended the pass first',
  skipends:   'skipOne() ENDS THE PASS as well as counting',
  skipcount:  'a PASSTHROUGH SPAN IS COUNTED ON THE PRIME\u2019S WRITER',
  // finish()'s refusals
  twice:      'finish() TWICE is refused',
  chunkafter: 'a chunk after finish() is refused BY NAME',
  gapafter:   'and so is a gap, which has no contiguity check of its own',
  atcommit:   'finish() AT the commit point is refused',
  beyond:     'finish() BEYOND one hop plus the crossfade is refused',
  midfade:    'a drain SHORTER than the crossfade ENDS MID-FADE',
  // finish()'s passthrough EXIT — the passActive branch, driven under
  // 'equalPower' because under the default 'linear' law li IS fi (MINOR 6)
  passctl:    'the linear and equal-power ramps really differ',
  passfi:     'the STEMS fade in on the LINEAR ramp',
  passfade:   'the PASSTHROUGH fades out on the linear lo ramp',
  passend:    'finish() ENDS the passthrough state',
  // the writer seam (ruling 34)
  open:       'attaching a recording writer OPENS the recording',
  accum:      'a running recording ACCUMULATES separated audio',
  primeabort: 'a drop ABANDONS THE PRIME',
  notabort:   'DOES NOT abort the recording',
  reccount:   'the recording IS counted, so its refusal can name how many',
  recclosed:  'the recording is CLOSED at the boundary',
  afterbound: 'a CHUNK that lands after the boundary does not reach it either',
  handback:   'detaching still HANDS IT BACK, drop and all',
  reopen:     'attaching NULL keeps the pass CLOSED',
  recline:    'stats() reports the recording on its OWN line',
  passreset:  'start() resets the previous session’s passEnd',
  // the retained-buffer count (#7)
  bufcount:   'the pipeline holds THE SAME NUMBER OF BUFFERS after 60 s',
  bufctl:     'the recording really advanced over that span',
  /**
   * THE DRAIN, DRIVEN (the repair of the review BLOCKER). Everything above these
   * nine watches `LiveEmitter.finish()` or reads `offscreen/live.js` as TEXT.
   * These nine watch `LivePipeline.drain()` ACTUALLY RUNNING — proven necessary
   * by measurement: over a whole `node test.js live` the drain's body past its
   * guards had executed ZERO times, and nine mutations of it, `if (false) await
   * this.drain()` among them, left the suite at 240 passed / 0 failed.
   */
  drivectl:   'THE DRIVE\u2019S CONTROL',
  drainran:   'THE DRAIN RAN ITS BODY',
  drainrec:   'THE RECORDING GETS THE DRAIN\u2019S PUBLICATION',
  drainaudio: 'AND IT IS THE AUDIO',
  draincache: 'THE PRIME\u2019S CACHE WRITER GETS IT TOO',
  drainring:  'AND THE STEM RING GETS IT',
  drainown:   'THE DRAIN\u2019S SCRATCH IS ITS OWN',
  drainpass:  'THE PASSTHROUGH PLANES ARE LONG ENOUGH',
  drainflight: 'A STOP WITH A CHUNK STILL IN FLIGHT STILL DRAINS',
  /**
   * THE SIX THAT WERE INVISIBLE TO THE COVERAGE TOOL (INTEGRATION §36b). This
   * assertion existed and passed for a whole review cycle while `--coverage`
   * reported `70 of 70 claimed`, because the DENOMINATOR IS THIS MAP: an
   * assertion that is not a key here cannot be counted missing, so it scores as
   * covered by being unknown. The reader hears "the file".
   * It is also the assertion that caught INTEGRATION §36 — it renders from a
   * template literal, `ALL ${STEM_PLANES} STEMS`, so a grep for its rendered
   * text finds nothing in test.js. The needle below is the part that is LITERAL
   * in the source, and the control run now proves it can hit something.
   */
  perplane:   'STEMS plus the passthrough pair',
  // the group guard
  guard:      'group(live) REACHED ITS LAST ASSERTION',
};

/** Keys emitted once per (hop, stop-point) pair: six reds each, not one. */
const SIXFOLD = new Set([A.short, A.exact, A.audio, 'STEMS plus the passthrough pair']);
/** Keys emitted once per stop point in the driven-drain block: two reds each. */
const TWOFOLD = new Set([A.drivectl, A.drainran, A.drainrec, A.drainaudio,
  A.draincache, A.drainring, A.drainown, A.drainpass]);

/**
 * `expect` is the EXACT set of assertion KEYS the mutation must redden — not a
 * subset. An unclaimed red is reported too, because a mutation that reddens more
 * than its table entry says means the table is wrong about what the assertion
 * covers.
 *
 * AN ENTRY MAY BE `{ k, n }` INSTEAD OF A BARE KEY, and that form is the one
 * that carries a real finding rather than a convenience. A key emitted twice —
 * once per stop point — whose mutation reddens only ONE of the two is telling
 * you the defect is reachable at only one geometry: `this.passL` is `H` frames,
 * so borrowing it is harmless on a mid-hop drain and fatal on the worst case.
 * Writing `{ k: A.drainpass, n: 1 }` states that; writing `A.drainpass` would
 * demand two reds and score the mutation MUTE for being honest.
 */
const MUTATIONS = [
  // ---------------------------------------------------------------- engine/live.js
  {
    id: 'M1', file: 'E',
    what: 'finish() reads the WRONG PART of the model output (offset off by the crossfade)',
    find: '    const o = p.L - len;',
    with: '    const o = p.L - len - X;',
    expect: [A.audio, A.passfi, A.drainaudio, A.drainring],
  },
  {
    id: 'M2', file: 'E',
    what: 'finish() leaves the commit point one frame short of the capture',
    find: '    this.commit = inputEnd;',
    with: '    this.commit = inputEnd - 1;',
    expect: [A.exact, A.twice],
  },
  {
    id: 'M3', file: 'E',
    what: 'finish() BUTT-SPLICES: no crossfade against the held tail (xf = 0)',
    find: '    const xf = (this.haveTail || this.passActive) ? Math.min(X, len) : 0;',
    with: '    const xf = 0;',
    expect: [A.join, A.midfade, A.passfi, A.passfade],
    note: 'THE ROW WORTH READING TWICE. Under the identity model of the residual assertions '
      + 'above, the held tail and the final pass are the SAME samples, so complementary linear '
      + 'ramps sum to a no-op and their absence reconstructs perfectly: this defect leaves the '
      + 'residual at -inf dB with every one of those 18 assertions GREEN. Only the DELTA-step '
      + 'instrument, whose two passes differ by a known constant, can see it.',
  },
  {
    id: 'M4', file: 'E',
    what: 'finish() may be called twice — the second call publishes again',
    find: '    if (this.finished) {\n      throw new Error(`live: finish() twice',
    with: '    if (false) {\n      throw new Error(`live: finish() twice',
    expect: [A.twice],
  },
  {
    id: 'M5', file: 'E',
    what: 'chunk() after finish() reports non-contiguity instead of naming the real cause',
    find: '    if (this.finished) {\n      throw new Error(`live: chunk ${k} after finish()',
    with: '    if (false) {\n      throw new Error(`live: chunk ${k} after finish()',
    expect: [A.chunkafter],
  },
  {
    id: 'M6', file: 'E',
    what: 'gap() after finish() appends unseparated audio to a finished recording',
    find: '    if (this.finished) {\n      throw new Error(`live: gap after finish()',
    with: '    if (false) {\n      throw new Error(`live: gap after finish()',
    expect: [A.gapafter],
  },
  {
    id: 'M7', file: 'E',
    what: 'finish() AT the commit point publishes a zero-length span instead of refusing',
    find: '    if (len <= 0) {\n      throw new Error(`live: finish() at ${inputEnd}',
    with: '    if (false) {\n      throw new Error(`live: finish() at ${inputEnd}',
    expect: [A.atcommit],
  },
  {
    id: 'M8', file: 'E',
    what: 'finish() accepts a span longer than one hop plus the crossfade',
    find: '    if (len > p.H + X) {',
    with: '    if (false) {',
    expect: [A.beyond],
  },
  {
    id: 'M9', file: 'E',
    what: 'finish() compresses a whole crossfade into a short drain (makeFades(len)) '
      + 'instead of ending mid-fade',
    find: '    const xf = (this.haveTail || this.passActive) ? Math.min(X, len) : 0;\n'
      + '    const fi = this.passActive ? this.li : this.fi;\n    const fo = this.fo;',
    with: '    const xf = (this.haveTail || this.passActive) ? Math.min(X, len) : 0;\n'
      + '    const sh = makeFades(Math.max(1, Math.min(X, len)), this.law);\n'
      + '    const fi = this.passActive ? this.li : sh.fi;\n    const fo = sh.fo;',
    expect: [A.midfade],
  },
  {
    id: 'M10', file: 'E',
    what: 'finish() keeps the tail, so a second join could be published over frames already in the file',
    find: '    this.haveTail = false;\n    this.finished = true;',
    with: '    this.finished = true;',
    expect: [],
    note: 'Kept as a NEGATIVE result rather than deleted: `haveTail` after `finished` is '
      + 'unreachable while M4’s guard stands, so nothing observes it. It is defence in depth, '
      + 'not a covered line, and the table says so instead of implying coverage it does not have.',
  },
  // ---------------------------------------------------------------- offscreen/live.js
  {
    id: 'M11', file: 'L',
    what: 'stop() drains BEFORE it raises the flag, so the pump can fire underneath the drain',
    find: '    this.stopped = true;\n    // First-writer-wins',
    with: '    // First-writer-wins',
    expect: [A.order],
    tail: {
      find: '    this.recOpen = false;\n    this.status = \'idle\';',
      with: '    this.recOpen = false;\n    this.stopped = true;\n    this.status = \'idle\';',
    },
    note: 'The flag is moved to AFTER the drain rather than deleted, because deleting it alone '
      + 'would test a different claim. Cut once as an insertion between `if (drain) await ...;` and '
      + 'its `else`, which is a SYNTAX ERROR: the run CRASHED, the battery scored it MUTE, and a '
      + 'crash is not a red. That is what the crash/red distinction in this header is for.',
  },
  {
    id: 'M12', file: 'L',
    what: 'drain() borrows the pipeline’s in-flight mixBuf instead of allocating its own',
    find: '    const mixBuf = new ArrayBuffer(2 * SEGMENT * 4);',
    with: '    const mixBuf = this.mixBuf;',
    expect: [A.ownbufs, A.drainown, A.drainflight],
  },
  {
    id: 'M13', file: 'L',
    what: 'endPass() is LAST-writer-wins, so the stop() after a drop overwrites its reason',
    find: '    if (this.passEnd !== null) return;\n    this.passEnd = reason;',
    with: '    this.passEnd = reason;',
    expect: [A.firstwin],
  },
  {
    id: 'M14', file: 'L',
    what: 'skipOne() abandons the prime WITHOUT ending the pass — the recording runs on past the gap',
    find: "    this.endPass('drop');",
    with: '',
    expect: [A.skipends, A.recclosed, A.afterbound, A.recline],
  },
  {
    id: 'M15', file: 'L',
    what: 'skipOne() aborts the prime without COUNTING the drop',
    find: '      this.cacheWriter.noteDrop();\n      this.cacheWriter.abort();',
    with: '      this.cacheWriter.abort();',
    expect: [A.skipcount, A.primeabort],
  },
  {
    id: 'M16', file: 'L',
    what: 'a drop ABORTS THE RECORDING as well as the prime — one writer, both rules',
    find: '    if (this.recWriter) this.recWriter.noteDrop();',
    with: '    if (this.recWriter) { this.recWriter.noteDrop(); this.recWriter.abort(); }',
    expect: [A.notabort, A.handback],
  },
  {
    id: 'M17', file: 'L',
    what: 'a drop does not COUNT on the recording, so its refusal cannot say how many',
    find: '    if (this.recWriter) this.recWriter.noteDrop();',
    with: '',
    expect: [A.reccount, A.recline],
  },
  {
    id: 'M18', file: 'L',
    what: 'endPass(\'drop\') does not CLOSE the recording, so audio after the gap is appended to it',
    find: "    if (reason === 'drop') this.recOpen = false;",
    with: '',
    expect: [A.recclosed, A.afterbound, A.recline],
  },
  {
    id: 'M19', file: 'L',
    what: 'runChunk() ignores recOpen — the boundary closes nothing',
    find: '    if (this.recWriter && this.recOpen) this.recWriter.append(e.planes, e.len);\n\n    // A4:',
    with: '    if (this.recWriter) this.recWriter.append(e.planes, e.len);\n\n    // A4:',
    expect: [A.afterbound],
  },
  {
    id: 'M20', file: 'L',
    what: 'runChunk() never appends to the recording — nothing is ever recorded',
    find: '    if (this.recWriter && this.recOpen) this.recWriter.append(e.planes, e.len);\n\n    // A4:',
    with: '\n    // A4:',
    expect: [A.accum, A.afterbound, A.handback, A.bufctl, A.drivectl, A.drainrec, A.drainflight],
  },
  {
    id: 'M21', file: 'L',
    what: 'attachRecWriter() attaches the writer but leaves the recording CLOSED',
    find: '  attachRecWriter(w) { this.recWriter = w || null; this.recOpen = !!w; }',
    with: '  attachRecWriter(w) { this.recWriter = w || null; }',
    expect: [A.open, A.accum, A.afterbound, A.handback, A.bufctl, A.drivectl, A.drainrec,
      A.drainaudio, A.drainflight],
  },
  {
    id: 'M22', file: 'L',
    what: 'detachRecWriter() DISCARDS the writer instead of handing it back',
    find: '  detachRecWriter() { const w = this.recWriter; this.recWriter = null; this.recOpen = false; return w; }',
    with: '  detachRecWriter() { this.recWriter = null; this.recOpen = false; return null; }',
    expect: [A.handback],
  },
  {
    id: 'M23', file: 'L',
    what: 'the pipeline RETAINS every published buffer instead of streaming it — RAM grows with duration',
    find: '    if (this.recWriter && this.recOpen) this.recWriter.append(e.planes, e.len);\n\n    // A4:',
    with: '    if (this.recWriter && this.recOpen) { this.recWriter.append(e.planes, e.len);\n'
      + '      (this.recKept || (this.recKept = [])).push(e.planes.map((q) => q.slice(0, e.len))); }\n\n    // A4:',
    expect: [A.bufcount],
    note: 'The defect #7’s acceptance criterion exists for: buffer the recording in RAM and write '
      + 'it at the end. The count goes UP, which is the direction that matters — break it and the '
      + 'number gets WORSE, not better.',
  },
  {
    id: 'M24', file: 'D',
    what: 'dispose() awaits a full drain — a teardown blocks on one more inference',
    find: '    await this.live.stop({ drain: false }).catch(() => {});',
    with: '    await this.live.stop().catch(() => {});',
    expect: [A.dispose],
  },
  // ---------------------------------------------------------------- shared/stemcache.js
  {
    id: 'M25', file: 'S',
    what: 'recordingRefusal() refuses a drop-ended pass instead of delivering what it captured',
    find: "  if (!(pass.frames > 0)) {",
    with: "  if (pass.drops > 0) return 'the recording has a gap';\n  if (!(pass.frames > 0)) {",
    expect: [A.deliver, A.refuse],
  },
  {
    id: 'M26', file: 'S',
    what: 'recordingRefusal() delivers a pass that captured NOTHING',
    find: "  if (!(pass.frames > 0)) {",
    with: '  if (false) {',
    expect: [A.refuse],
  },
  {
    id: 'M27', file: 'S',
    what: 'a seek and a drop are worded ALIKE — the shared mechanism flattens the difference',
    find: "  seek: 'the playhead moved, which ends a contiguous pass',",
    with: "  seek: 'the machine could not keep up, so the pass ends where the stems do',",
    expect: [A.distinct],
  },
  {
    id: 'M28', file: 'S',
    what: 'an end reason this unit has no wording for is ACCEPTED',
    find: '  if (pass.endedBy && !PASS_END[pass.endedBy]) {',
    with: '  if (false) {',
    expect: [A.invented],
  },
  {
    id: 'M29', file: 'S',
    what: 'passEndNote() builds a sentence with a hole in it for an unknown reason',
    find: '  if (!pass || !pass.endedBy || !PASS_END[pass.endedBy]) return null;',
    with: '  if (!pass || !pass.endedBy) return null;',
    expect: [A.note0],
  },
  {
    id: 'M30', file: 'S',
    what: 'passEndNote() drops the count, so a drop-ended pass cannot say how many',
    find: '  const dropped = pass.drops > 0',
    with: '  const dropped = false',
    expect: [A.howmany, A.english],
  },
  {
    id: 'M31', file: 'S',
    what: 'passEndNote() prints "(0 dropped chunks)" on a clean pass — a fault report where there is no fault',
    find: '  const dropped = pass.drops > 0',
    with: '  const dropped = pass.drops >= 0',
    expect: [A.clean],
  },
  {
    id: 'M32', file: 'S',
    what: 'passEndNote() does not pluralise — "1 dropped chunks"',
    find: "${pass.drops === 1 ? '' : 's'}",
    with: 's',
    expect: [A.english],
  },
  {
    id: 'M33', file: 'S',
    what: 'PRIME_TAIL_MAX_SEC is cut below the tail the shipping ladder leaves (6.0 -> 2.0 s)',
    find: 'export const PRIME_TAIL_MAX_SEC = 6.0;',
    with: 'export const PRIME_TAIL_MAX_SEC = 2.0;',
    expect: [A.tailconst],
    note: 'The worst shipping hop leaves H + X = 3.95 s of tail. A tolerance below that would make '
      + 'EVERY prime at that hop refuse, with nothing else in the tree to say why — which is the '
      + 'coupling this assertion exists to hold, between a constant here and the ladder in config.js.',
  },
  {
    id: 'M35', file: 'L',
    what: 'endPass() silently ignores an ordinary stop, so a clean pass records no reason at all',
    find: '    this.passEnd = reason;',
    with: "    this.passEnd = reason === 'stopped' ? null : reason;",
    expect: [A.plain],
  },
  {
    id: 'M36', file: 'L',
    what: 'skipOne() counts the drop but never ABANDONS the prime — a gap is cached as a track',
    find: '      this.cacheWriter.noteDrop();\n      this.cacheWriter.abort();',
    with: '      this.cacheWriter.noteDrop();',
    expect: [A.skipends, A.skipcount, A.primeabort, A.recline],
  },
  {
    id: 'M37', file: 'E',
    what: 'makeLivePlan() holds back ONE FRAME MORE than the crossfade, so the shortfall '
      + 'stops being the one the geometry predicts',
    find: '  const X = Math.round((xfadeMs / 1000) * SR);',
    with: '  const X = Math.round((xfadeMs / 1000) * SR) + 1;',
    expect: [A.short],
    note: 'Cut here rather than on `chunkPlan`\u2019s `emitTo`. That anchor was tried first and is '
      + 'the wrong instrument: it breaks the causal geometry itself, THROWS inside group(live), and '
      + 'the guard converts the whole thing into one red — 11 passed, 5 failed — without ever '
      + 'reaching the assertion it was cut for. A mutation that takes the suite down measures '
      + 'nothing. This one keeps the plan self-consistent and moves only the quantity the assertion '
      + 'recomputes independently from SEAM_XFADE_MS.',
  },
  {
    id: 'M38', file: 'F', fixture: true,
    what: 'THE JOIN FIXTURE DEGENERATES: both passes carry the same constant, so there is no step to smooth',
    find: '    const pass = (n) => { for (let q = 0; q < STEM_PLANES; q++) src[q].fill(DELTA * n); };',
    with: '    const pass = (n) => { for (let q = 0; q < STEM_PLANES; q++) src[q].fill(DELTA); void n; };',
    expect: [A.join, A.joinctl],
    note: 'The control and the assertion it guards go red TOGETHER, which is the point: with the two '
      + 'passes identical the crossfade is arithmetically a no-op and the join assertion is measuring '
      + 'nothing. A control that stayed green here would be the blind gate §12 describes.',
  },
  // ------------------------------------------- offscreen/live.js drain(), DRIVEN
  /**
   * THE NINE THE REVIEW FOUND UNWATCHED. Every one of these left the suite at
   * 240 passed / 0 failed before the driven-drain block existed, because the
   * only things looking at `drain()` were two regexes over its source text.
   *
   * ALL NINE SCORE RED, MEASURED. Their sets were transcribed from `--discover`
   * like every other row here — and unusually, all nine hand-written predictions
   * turned out to match what was measured, which is exactly the claim nobody is
   * entitled to make in advance: the same batch of predictions got M20, M21 and
   * M48-M50 wrong. `263 passed / 0 failed` is the PRECONDITION; THESE NINE REDS,
   * plus M48-M50's three, ARE THE MEASUREMENT that closes the review's blocker.
   */
  {
    id: 'M39', file: 'L',
    what: 'THE FEATURE IS SWITCHED OFF: stop() never calls drain() at all',
    find: '    if (drain) await this.drain();',
    with: '    if (false) await this.drain();',
    expect: [A.drainran, A.drainrec, A.drainaudio, A.draincache, A.drainring, A.drainpass,
      A.drainflight],
    note: 'The mutation the whole repair is measured against. `if (false)` leaves the `else if` '
      + 'attached, so it is the feature removed rather than a syntax error — and the drain is then '
      + 'COUNTED as abandoned, which is the honest half of the defect still working.',
  },
  {
    id: 'M40', file: 'L',
    what: 'drain() never appends its publication to the RECORDING — this slice’s headline claim, deleted',
    find: '      // boundary, and these frames are after it.\n'
      + '      if (this.recWriter && this.recOpen) this.recWriter.append(e.planes, e.len);',
    with: '      // boundary, and these frames are after it.',
    expect: [A.drainrec, A.drainaudio, A.drainflight],
  },
  {
    id: 'M41', file: 'L',
    what: 'drain() never appends its publication to the PRIME',
    find: '      if (this.cacheWriter) this.cacheWriter.append(e.planes, e.len);\n'
      + '      // AND IT BELONGS TO THE RECORDING',
    with: '      // AND IT BELONGS TO THE RECORDING',
    expect: [A.draincache],
  },
  {
    id: 'M42', file: 'L',
    what: 'drain() borrows the pipeline’s outBuf — `infer` DETACHES it and every later session throws',
    find: '    const outBuf = new ArrayBuffer(STEMS.length * 2 * SEGMENT * 4);',
    with: '    const outBuf = this.outBuf;',
    expect: [A.drainown, A.drainflight],
    note: 'The `ownbufs` regex above watches the mixBuf line only, so this half of the same rule '
      + 'had nothing at all on it. With a chunk in flight the borrowed buffer is already detached '
      + 'and the fake worker’s structuredClone throws — which is the real crash, not a wrong number.',
  },
  {
    id: 'M43', file: 'L',
    what: 'drain() borrows the H-frame chunk scratch for the passthrough span it can publish H + X of',
    find: '    const passL = new Float32Array(len), passR = new Float32Array(len);',
    with: '    const passL = this.passL, passR = this.passR;',
    expect: [{ k: A.drainran, n: 1 }, { k: A.drainrec, n: 1 }, { k: A.drainaudio, n: 1 },
      { k: A.draincache, n: 1 }, { k: A.drainring, n: 1 }, { k: A.drainpass, n: 1 }],
    note: 'ONE OF TWO, AND THAT IS THE FINDING. `this.passL` is H frames; a mid-hop drain publishes '
      + 'fewer than H and is unharmed, while the worst case publishes H + X - 1 and `readWindow`’s '
      + '`dstL.set` throws out of bounds. So the defect exists at one geometry only, which is exactly '
      + 'what the two stop points are for and what the `{ k, n }` form records.',
  },
  {
    id: 'M44', file: 'L',
    what: 'drain() does not record drainedFrames — a drain that did nothing looks identical',
    find: '    this.drainedFrames = e.len;',
    with: '',
    expect: [A.drainran, A.drainflight],
  },
  {
    id: 'M45', file: 'L',
    what: 'drain() files the tail but never PUBLISHES it — the deck never plays what it recorded',
    find: '      if (!this.out.write(e.from, e.planes, e.len)) this.overruns++;\n'
      + '      /**\n       * THE RECOVERY IS RECORDED ON THE LINE THAT MAKES IT TRUE',
    with: '      /**\n       * THE RECOVERY IS RECORDED ON THE LINE THAT MAKES IT TRUE',
    expect: [A.drainring],
  },
  {
    id: 'M46', file: 'L',
    what: 'stop() closes the recording BEFORE the drain, so the drain’s publication never reaches it',
    find: '    if (drain) await this.drain();\n'
      + '    else if (this.plan && this.out && this.emitter && !this.emitter.finished) {\n'
      + "      this.drainAbandoned++;\n"
      + "      this.drainWhy = 'teardown: a document going away may not wait for an inference';\n"
      + '    }\n'
      + "    // AFTER the drain, not before: on a clean stop the drain's publication is\n"
      + '    // the last thing the recording is owed.\n'
      + '    this.recOpen = false;',
    with: '    this.recOpen = false;\n'
      + '    if (drain) await this.drain();\n'
      + '    else if (this.plan && this.out && this.emitter && !this.emitter.finished) {\n'
      + "      this.drainAbandoned++;\n"
      + "      this.drainWhy = 'teardown: a document going away may not wait for an inference';\n"
      + '    }',
    expect: [A.drainrec, A.drainaudio, A.drainflight],
    note: 'An ORDERING defect with no line missing: every statement `stop()` had it still has, in a '
      + 'different order. Nothing that reads source text can see this one.',
  },
  {
    id: 'M47', file: 'L',
    what: 'drain() reads the model window one hop early — the recorded tail is plausible and wrong',
    find: '    readWindow(ring, this.baseFrame + F - SEGMENT, SEGMENT,',
    with: '    readWindow(ring, this.baseFrame + F - SEGMENT - p.H, SEGMENT,',
    expect: [A.drainaudio, A.drainring],
    note: 'THE DEFECT THAT SOUNDS FINE. Every count stays right — the frames arrive, the writers '
      + 'are appended to, `drainedFrames` is exact — and the audio is a hop old. Only a content '
      + 'assertion over a signal that VARIES can see it, which is why the fixture’s model is the '
      + 'identity over noise and not a constant.',
  },
  {
    id: 'M34', file: 'E',
    what: 'THE GROUP GUARD: finish() throws unconditionally, so group(live) never reaches its end',
    find: '    if (this.finished) {\n      throw new Error(`live: finish() twice',
    with: '    if (true) {\n      throw new Error(`live: finish() twice',
    throws: true,
    expect: [A.guard],
    note: 'A `throws` row is evidence the GUARD reports, NOT that anything downstream of the throw '
      + 'is watching. Everything after the throw is ABSENT, and an absent assertion reads as green: '
      + 'that is the guard’s measured bound, not a gap in this battery.',
  },
  // ------------------------------- engine/live.js finish(), THE PER-PLANE PUBLISH
  /**
   * THE THREE THAT WERE MISSING. `finish()` separates and publishes TWELVE stem
   * planes plus the passthrough pair, and until these three existed the only
   * assertion watching that loop was itself unwatched (see A.perplane). Each of
   * these keeps the publication the right SHAPE — `planes.length` stays
   * RING_PLANES — and corrupts only WHICH audio lands in each plane, which is
   * the failure a length check cannot see.
   */
  {
    id: 'M48', file: 'E',
    what: 'finish() separates every stem from STEM PLANE 0 — twelve planes, one stem\u2019s audio',
    find: '      const s = src[q], d = planes[q], t = this.tail[q];',
    with: '      const s = src[0], d = planes[q], t = this.tail[q];',
    expect: [A.drainaudio, A.perplane],
  },
  {
    id: 'M49', file: 'E',
    what: 'finish() crossfades EVERY stem against tail plane 0, so eleven planes join against the wrong tail',
    find: '        for (let i = 0; i < xf; i++) d[i] = t[i] * fo[i] + s[o + i] * fi[i];\n'
      + '        for (let i = xf; i < len; i++) d[i] = s[o + i];\n      }\n    }\n'
      + '    const pl = planes[PASS_PLANE_L]',
    with: '        for (let i = 0; i < xf; i++) d[i] = this.tail[0][i] * fo[i] + s[o + i] * fi[i];\n'
      + '        for (let i = xf; i < len; i++) d[i] = s[o + i];\n      }\n    }\n'
      + '    const pl = planes[PASS_PLANE_L]',
    expect: [A.drainaudio, A.perplane],
    note: 'Only the JOIN is corrupted, so this reddens on the geometry where a drain HAS a tail '
      + 'to join against and is invisible where `xf` is 0 — the `{ k, n }` form records which.',
  },
  {
    id: 'M50', file: 'E',
    what: 'finish() publishes ONLY the first stem plane — the other eleven go out as silence',
    find: '    for (let q = 0; q < STEM_PLANES; q++) {\n'
      + '      const s = src[q], d = planes[q], t = this.tail[q];',
    with: '    for (let q = 0; q < 1; q++) {\n'
      + '      const s = src[q], d = planes[q], t = this.tail[q];',
    expect: [A.drainaudio, A.perplane],
  },
  // ------------------------- engine/live.js finish(), THE PASSTHROUGH EXIT (MINOR 6)
  /**
   * THE BRANCH NOTHING DROVE. `finish()`'s `passActive` path had no fixture on
   * it until MINOR 6: a gap() leaves passActive true, and the drain's finish()
   * must then fade the stems IN against the passthrough fading OUT. Three
   * defects there stayed green at 240 passed / 0 failed. The fixture runs the
   * emitter under 'equalPower' on purpose — under the default 'linear' law,
   * `li` IS `fi` (the same array) and the `this.passActive ? this.li : this.fi`
   * choice is unobservable by construction; see A.passctl, whose mutation is
   * M59, a mutation OF THE CONSTRUCTOR'S `lin`, because only a fixture mutation
   * can watch a control.
   */
  {
    id: 'M51', file: 'E',
    what: 'finish() fades the stems in on the equalPower ramp even through a passthrough exit',
    find: '    const xf = (this.haveTail || this.passActive) ? Math.min(X, len) : 0;\n'
      + '    const fi = this.passActive ? this.li : this.fi;\n'
      + '    const fo = this.fo;',
    with: '    const xf = (this.haveTail || this.passActive) ? Math.min(X, len) : 0;\n'
      + '    const fi = this.fi;\n'
      + '    const fo = this.fo;',
    expect: [A.passfi],
  },
  {
    id: 'M52', file: 'E',
    what: 'finish() publishes SILENCE in the passthrough planes — the mix that was playing just dies',
    find: '    const pl = planes[PASS_PLANE_L], pr = planes[PASS_PLANE_R];\n'
      + '    if (this.passActive) {\n'
      + '      for (let i = 0; i < xf; i++) { pl[i] = mixL[i] * this.lo[i]; pr[i] = mixR[i] * this.lo[i]; }',
    with: '    const pl = planes[PASS_PLANE_L], pr = planes[PASS_PLANE_R];\n'
      + '    if (this.passActive) {\n'
      + '      for (let i = 0; i < xf; i++) { pl[i] = 0; pr[i] = 0; }',
    expect: [A.passfade],
  },
  {
    id: 'M53', file: 'E',
    what: 'finish() does not END the passthrough state — a finished emitter is still in pass',
    find: '      this.passActive = false;\n    }\n    // NOTHING IS HELD BACK',
    with: '    }\n    // NOTHING IS HELD BACK',
    expect: [A.passend],
    note: 'The observable is the FIELD: once finished, no publishing path can run, so the state '
      + 'read is the only witness. Named honestly as a state read in the assertion text.',
  },
  // ------------------------- offscreen/live.js, THE WRITER SEAM AND SESSION STATE (MINOR 8)
  {
    id: 'M54', file: 'L',
    what: 'attachRecWriter(null) re-OPENS the recording — a pass the drop boundary closed takes appends again',
    find: '  attachRecWriter(w) { this.recWriter = w || null; this.recOpen = !!w; }',
    with: '  attachRecWriter(w) { this.recWriter = w || null; this.recOpen = true; }',
    expect: [A.reopen],
  },
  {
    id: 'M55', file: 'L',
    what: 'stats() does not report the recording on its own line — the two artefacts collapse into one',
    find: '      recording: this.recWriter\n'
      + '        ? { open: this.recOpen, frames: this.recWriter.frames, drops: this.recWriter.drops, endedBy: this.passEnd }\n'
      + '        : null,\n',
    with: '      // the recording: member was deleted by M55\n',
    expect: [A.recline],
  },
  {
    id: 'M56', file: 'L',
    what: 'start() keeps the previous session’s passEnd — a new pass inherits the old end reason',
    find: '    this.passEnd = null;\n    this.lastHealthAt = performance.now();',
    with: '    this.lastHealthAt = performance.now();',
    expect: [A.passreset],
  },
  // ------------------------- the retained-buffer walk, ITS WIDENING (D4)
  /**
   * THE WALK MUST SEE THE SHAPES IT CLAIMS TO WALK. Until D4 the walk entered
   * only plain arrays and plain objects, so a future pipeline that retained
   * publications on a CLASS INSTANCE (the emitter) or in a Map was invisible to
   * it — the count stayed flat while RAM grew. These two put the accumulation
   * in exactly those shapes; the widened walk must still find them.
   */
  {
    id: 'M57', file: 'L',
    what: 'the pipeline retains every publication ON THE EMITTER — a class instance the old walk never entered',
    find: '    if (this.recWriter && this.recOpen) this.recWriter.append(e.planes, e.len);\n\n    // A4:',
    with: '    if (this.recWriter && this.recOpen) { this.recWriter.append(e.planes, e.len);\n'
      + '      (this.emitter.kept || (this.emitter.kept = [])).push(e.planes.map((q) => q.slice(0, e.len))); }\n'
      + '\n    // A4:',
    expect: [A.bufcount],
  },
  {
    id: 'M58', file: 'L',
    what: 'the pipeline retains every publication IN A MAP — a shape the old walk could not enter',
    find: '    if (this.recWriter && this.recOpen) this.recWriter.append(e.planes, e.len);\n\n    // A4:',
    with: '    if (this.recWriter && this.recOpen) { this.recWriter.append(e.planes, e.len);\n'
      + '      (this.keptMap || (this.keptMap = new Map())).set(this.keptMap.size, '
      + 'e.planes.map((q) => q.slice(0, e.len))); }\n'
      + '\n    // A4:',
    expect: [A.bufcount],
  },
  {
    id: 'M59', file: 'E',
    what: 'the passthrough join uses the seam law — li and fi are one ramp, and the passActive choice is unobservable',
    find: '    const lin = makeFades(plan.X, \'linear\');',
    with: '    const lin = makeFades(plan.X, law);',
    expect: [A.passctl],
    note: 'A CONTROL is watched by a mutation OF THE FIXTURE and of nothing else: this changes the '
      + 'constructor’s `lin` so that under \'equalPower\' li IS fi and the MINOR 6 fixture has '
      + 'nothing to tell apart. The control reddens; nothing else observes li differently.',
  },
];

/**
 * The inert edit `--self-check` uses: a comment, and nothing else. The suite
 * must stay GREEN and the mutation must score MUTE.
 */
const INERT = {
  id: 'M0', file: 'E',
  what: 'a comment is edited and nothing else — the suite MUST stay green',
  find: '/** set by `finish()`; nothing may be published after the last publication */',
  with: '/** set by `finish()` (self-check: this comment was edited); nothing may be published after */',
  expect: [A.exact],
};

// --------------------------------------------------------------------------

/**
 * THE SYNTAX ERROR `--self-check` uses. NIT 10 / INTEGRATION \u00a730: `MUTE` is a
 * real verdict meaning THIS MUTATION IS UNCOVERABLE, and a self-check that only
 * proves the battery can PRINT the word proves nothing — a CRASHED run scores
 * MUTE by the same path an inert edit does, so a battery that had silently lost
 * the ability to run the suite at all would pass its own self-check with every
 * row MUTE. Requiring a CLEAN run before scoring MUTE is half the fix; this is
 * the other half, and it must be checked in the same command or the pair can
 * drift apart.
 */
const CRASHER = {
  id: 'MX', file: 'E',
  what: 'an unbalanced paren \u2014 the suite cannot even parse, and this MUST read as CRASHED, never as MUTE',
  find: '    const xf = (this.haveTail || this.passActive) ? Math.min(X, len) : 0;',
  with: '    const xf = (this.haveTail || this.passActive ? Math.min(X, len) : 0;',
  expect: [],
};

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const selfCheck = argv.includes('--self-check');
const discover = argv.includes('--discover');
const coverage = argv.includes('--coverage');
const tableOnly = argv.includes('--table');
const only = argv.filter((a) => !a.startsWith('--'));
const chosen = selfCheck ? [INERT, CRASHER] : (only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS);

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const read = (k) => readFileSync(join(ROOT, SUBJECTS[k].path), 'utf8');
const write = (k, s) => writeFileSync(join(ROOT, SUBJECTS[k].path), s);
const lineOf = (src, find) => src.slice(0, src.indexOf(find)).split('\n').length;
/** Two path components, because BOTH `engine/live.js` and `offscreen/live.js` are subjects. */
const shortPath = (p) => p.split('/').slice(-2).join('/').replace(/^extension\//, '');

function headRev() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return '(no git)'; }
}

/**
 * Run group('live') and return which named assertions FAILED.
 * A crash is NOT a red: it is a run that reported nothing, and treating it as
 * evidence is how a mutation that takes the suite down gets scored as coverage.
 * A crash is the ABSENCE OF A SUMMARY LINE — never an error word in the output,
 * which a red's own detail text can legitimately contain.
 */
function runSuite() {
  let out = '';
  try {
    out = execFileSync('node', ['test.js', 'live'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
  const summary = (clean.match(/^\d+ passed, \d+ failed$/m) || [null])[0];
  // A red is a line that STARTS with FAIL. Matching the bare word anywhere
  // catches PASS lines whose detail contains "FAILURE".
  const fails = clean.split('\n').filter((l) => l.trim().startsWith('FAIL '))
    .map((l) => l.trim().slice(5).trim());
  // The GREENS, for the control's needle check. A key that matches no PASS line
  // in an unmutated run is a needle that cannot hit anything, and every MUTE it
  // ever scores is unfalsifiable.
  const passes = clean.split('\n').filter((l) => l.trim().startsWith('PASS '))
    .map((l) => l.trim().slice(5).trim());
  return {
    crashed: summary === null,
    fails,
    passes,
    passed: summary ? Number(summary.split(' ')[0]) : -1,
    failed: summary ? Number(summary.split(', ')[1].split(' ')[0]) : -1,
    summary: summary || 'NO SUMMARY LINE — the run ended without reporting: '
      + clean.trim().split('\n').filter(Boolean).slice(-2).join(' | '),
  };
}

/** How many reds a key is expected to produce: six for the per-hop loop keys. */
const weight = (key) => (SIXFOLD.has(key) ? 6 : TWOFOLD.has(key) ? 2 : 1);
const matched = (fails, key) => fails.filter((f) => f.includes(key)).length;
/** An `expect` entry, normalised: a bare key means "all of them". */
const exp = (e) => (typeof e === 'string' ? { k: e, n: weight(e) } : e);

const HEAD = headRev();

if (coverage) {
  const claimed = new Set();
  for (const m of MUTATIONS) for (const e of m.expect) claimed.add(exp(e).k);
  const all = Object.entries(A);
  const un = all.filter(([, v]) => !claimed.has(v));
  let total = 0, covered = 0;
  for (const [, v] of all) { total += weight(v); if (claimed.has(v)) covered += weight(v); }
  console.log(`\n  ${covered} of ${total} U7 assertions are claimed by at least one mutation`);
  for (const [k, v] of un) console.log(`  ${C.r}UNCLAIMED${C.x} ${k.padEnd(11)} ${v}`);
  process.exit(un.length ? 1 : 0);
}

if (tableOnly) {
  /**
   * The table `test.js` group('live') carries in its header, regenerated from
   * this file so the two cannot drift into disagreement by hand. `file:line` is
   * where the MUTATION was made, never where the red appeared.
   */
  const KEY = Object.fromEntries(Object.entries(A).map(([k, v]) => [v, k]));
  for (const m of MUTATIONS) {
    const src = read(m.file);
    const hits = src.split(m.find).length - 1;
    const at = hits === 1 ? lineOf(src, m.find) : '???';
    const where = `${shortPath(SUBJECTS[m.file].path)}:${at}`;
    const reds = m.expect.length
      ? m.expect.map((e) => {
        const { k, n } = exp(e);
        return KEY[k] + (n > 1 ? ` x${n}` : '') + (n !== weight(k) ? ` of ${weight(k)}` : '');
      }).join(', ')
      : 'NOTHING — recorded as a negative result';
    console.log(`   *   ${m.id.padEnd(4)} ${where.padEnd(24)} ${m.what}`);
    console.log(`   *   ${' '.repeat(30)}-> ${reds}`);
  }
  process.exit(0);
}

console.log(`\n${C.b}U7 mutation battery — group('live') in test.js${C.x}`);
for (const [k, s] of Object.entries(SUBJECTS)) {
  const now = sha(read(k));
  const state = !s.sha ? `${C.y}(no stamp yet)${C.x}`
    : now === s.sha ? `${C.g}matches its stamp${C.x}`
      : `${C.y}MOVED since the anchors were cut${C.x}`;
  console.log(`  subject ${k}         ${s.path.padEnd(30)} ${state}`);
}
console.log(`  branch base       ${BASE}   ${C.d}(landed on main)${C.x}`);
console.log(`  running against   ${HEAD}`);
console.log(`  driving           node test.js live   ${C.d}(verify.mjs step: unit)${C.x}\n`);

const before = {};
for (const k of Object.keys(SUBJECTS)) before[k] = read(k);
const beforeHash = {};
for (const k of Object.keys(SUBJECTS)) beforeHash[k] = sha(before[k]);

/**
 * RESTORE ON A SIGNAL, NOT ONLY ON A THROW — measured, not anticipated. A
 * `finally` does not run when the process is TERMINATED, and this battery takes
 * ~7 minutes: the first full run of it was killed by an outer timeout and left
 * `extension/offscreen/live.js` MUTATED IN THE WORKING TREE, one line different
 * from HEAD, with nothing to say so. A tracked source file silently carrying a
 * deliberate defect is the worst thing this file could leave behind — the next
 * gate run measures the mutation and attributes it to whatever landed last.
 */
const restoreAll = () => {
  for (const k of Object.keys(SUBJECTS)) {
    try { if (read(k) !== before[k]) write(k, before[k]); } catch { /* nothing better to do */ }
  }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(130); });
}
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(2); });
let applied = 0, decayed = 0, bit = 0, mute = 0, controlOk = false;
/** `--self-check` scores its two cases itself; the generic loop cannot tell them apart. */
const selfRuns = {};

try {
  if (!listOnly) {
    const c = runSuite();
    controlOk = !c.crashed && c.fails.length === 0;
    console.log(`  ${controlOk ? `${C.g}CONTROL${C.x}` : `${C.r}CONTROL${C.x}`} unmutated: ${c.summary}`);
    if (controlOk) {
      /**
       * CROSS-CHECK 1 (INTEGRATION §36) — EVERY NEEDLE MUST BE ABLE TO HIT
       * SOMETHING. A key is matched against the suite's own GREEN output and
       * must appear exactly `weight(key)` times. A key whose assertion text
       * drifted matches zero PASS lines and would then match zero FAIL lines
       * too, so every mutation claiming it scores MUTE — an unfalsifiable
       * verdict that reads as "uncoverable" rather than "broken instrument".
       * This is the check that would have caught `ALL 12 STEMS` in one run.
       */
      const bad = [];
      for (const [k, v] of Object.entries(A)) {
        const n = c.passes.filter((l) => l.includes(v)).length;
        if (n !== weight(v)) bad.push(`A.${k} matched ${n} green lines, weight says ${weight(v)}`);
      }
      /**
       * CROSS-CHECK 2 (INTEGRATION §36b) — THE MAP MUST KEEP UP WITH THE SUITE.
       * The denominator `--coverage` divides by is this file's `A` map, not the
       * file it claims to measure, so an assertion nobody registered scores as
       * covered by being unknown. There is no way to tell from here WHICH
       * assertions are U7's, but there is a way to notice that the number
       * changed: pin it. Anyone who adds or removes an assertion in
       * group('live') is now forced back here to say whether it needs a key.
       */
      if (c.passed !== SUITE_ASSERTIONS) {
        bad.push(`group('live') reports ${c.passed} assertions, this battery was calibrated against `
          + `${SUITE_ASSERTIONS} — an assertion was added or removed. If it is a U7 assertion it needs `
          + `a key in \`A\` and a mutation watching it, or --coverage will score it covered by not `
          + `knowing about it. Then update SUITE_ASSERTIONS.`);
      }
      /**
       * CROSS-CHECK 3 (U7 task) — THE MAP'S WEIGHTED TOTAL MUST EQUAL THE SUITE
       * DELTA OVER THE BRANCH BASE. CROSS-CHECK 2 pins the suite side of the
       * ledger; this pins the map side. The map is the CLAIM — every assertion
       * keyed, with its geometry multiplicity — and the delta is the FACT. If
       * they disagree, either an assertion was added to group('live') without a
       * key (which --coverage cannot see, because it divides by this same map)
       * or a weight stopped matching its fixture loops. The coverage branch
       * computes the same total; the control is where it is ENFORCED.
       */
      let mapTotal = 0;
      for (const [, v] of Object.entries(A)) mapTotal += weight(v);
      if (mapTotal !== SUITE_ASSERTIONS - BASE_LIVE) {
        bad.push(`the A map's weighted total (${mapTotal}) does not equal the suite delta over the `
          + `branch base (${SUITE_ASSERTIONS} - ${BASE_LIVE} = ${SUITE_ASSERTIONS - BASE_LIVE}) — `
          + `either an assertion was added without a key, or a weight stopped matching its loops`);
      }
      if (bad.length) {
        controlOk = false;
        console.log(`\n  ${C.r}THE BATTERY DOES NOT AGREE WITH THE SUITE${C.x}`);
        for (const b of bad) console.log(`    ${C.r}\u2022${C.x} ${b}`);
        console.log(`\n  ${C.r}REFUSING TO RUN${C.x} — every verdict below would be measured with an`);
        console.log(`  instrument that disagrees with the thing it is measuring.\n`);
        process.exitCode = 2;
        throw new Error('battery/suite disagreement');
      }
    }
    if (!controlOk) {
      for (const f of c.fails) console.log(`          already red: ${f.slice(0, 140)}`);
      console.log(`\n  ${C.r}REFUSING TO RUN${C.x} — the suite is not green before any mutation, so every`);
      console.log(`  RED below would be a red this battery did not cause. Fix the tree first.\n`);
      process.exitCode = 2;
      throw new Error('control failed');
    }
    console.log('');
  }

  for (const m of chosen) {
    const src = before[m.file];
    const hits = src.split(m.find).length - 1;
    const tailHits = m.tail ? src.split(m.tail.find).length - 1 : 1;
    if (hits !== 1 || tailHits !== 1) {
      decayed++;
      const state = hits === 0 || tailHits === 0 ? 'DECAYED  ' : 'AMBIGUOUS';
      console.log(`  ${C.r}${state}${C.x} ${m.id.padEnd(4)} ${m.what}`);
      console.log(`            anchor matched ${hits}${m.tail ? `/${tailHits}` : ''} times in `
        + `${SUBJECTS[m.file].path} — RE-CUT IT against ${HEAD}`);
      continue;
    }
    applied++;
    const at = lineOf(src, m.find);
    const where = `${shortPath(SUBJECTS[m.file].path)}:${at}`;
    if (listOnly) {
      console.log(`  ${C.g}APPLIES ${C.x} ${m.id.padEnd(4)} ${where.padEnd(24)} ${m.what}`);
      continue;
    }

    let mutated = src.replace(m.find, m.with);
    if (m.tail) mutated = mutated.replace(m.tail.find, m.tail.with);
    if (mutated === src) {
      mute++;
      console.log(`  ${C.r}INERT   ${C.x} ${m.id.padEnd(4)} ${m.what}`);
      console.log(`            the replacement is byte-identical to the anchor — this mutation changes nothing`);
      continue;
    }
    write(m.file, mutated);
    const r = runSuite();
    write(m.file, src);
    if (selfCheck) selfRuns[m.id] = r;

    if (discover) {
      console.log(`  ${C.y}DISCOVER${C.x} ${m.id.padEnd(4)} ${where.padEnd(24)} ${m.what}`);
      console.log(`            ${r.summary}${r.crashed ? `  ${C.r}CRASHED${C.x}` : ''}`);
      const keys = Object.entries(A).filter(([, v]) => matched(r.fails, v))
        .map(([k, v]) => `A.${k}${matched(r.fails, v) > 1 ? `x${matched(r.fails, v)}` : ''}`);
      console.log(`            expect: [${keys.join(', ')}]`);
      for (const f of r.fails) {
        if (!Object.values(A).some((v) => f.includes(v))) console.log(`            ${C.r}UNMAPPED RED:${C.x} ${f.slice(0, 160)}`);
      }
      continue;
    }

    const want = m.expect.map(exp);
    const missing = want.filter((e) => matched(r.fails, e.k) !== e.n);
    const unexpected = r.fails.filter((f) => !want.some((e) => f.includes(e.k)));
    const ok = !r.crashed && missing.length === 0 && unexpected.length === 0
      && (m.expect.length === 0 ? r.fails.length === 0 : r.fails.length > 0);
    if (ok) bit++; else mute++;
    const verdict = m.expect.length === 0
      ? (ok ? `${C.y}NO RED  ${C.x}` : `${C.r}MUTE    ${C.x}`)
      : (ok ? `${C.g}RED     ${C.x}` : `${C.r}MUTE    ${C.x}`);
    console.log(`  ${verdict} ${m.id.padEnd(4)} ${where.padEnd(24)} ${m.what}`);
    console.log(`            ${r.summary}${m.throws ? `   ${C.y}(throws — the guard reports; the rest never ran)${C.x}` : ''}`);
    if (missing.length) {
      console.log(`            ${C.r}CLAIMED BUT DID NOT RED AS CLAIMED:${C.x} `
        + missing.map((e) => `${e.k} (${matched(r.fails, e.k)} red, ${e.n} claimed)`).join(' | '));
    }
    if (unexpected.length) {
      console.log(`            ${C.r}RED BUT NOT CLAIMED:${C.x} ${unexpected.map((f) => f.slice(0, 110)).join(' | ')}`);
    }
    if (m.expect.length && !r.crashed && r.fails.length === 0) {
      console.log(`            ${C.r}NOTHING WENT RED${C.x} — the assertion this claims to cover is not watching this line`);
    }
  }
} finally {
  for (const k of Object.keys(SUBJECTS)) {
    if (read(k) !== before[k]) write(k, before[k]);
    if (sha(read(k)) !== beforeHash[k]) {
      console.log(`\n${C.r}FAILED TO RESTORE ${SUBJECTS[k].path}${C.x} — check git status before doing anything else\n`);
      process.exitCode = 2;
    }
  }
}

if (listOnly) {
  console.log(`\n  ${applied} of ${chosen.length} anchors apply, ${decayed} decayed. Nothing was mutated.\n`);
  process.exitCode = decayed ? 1 : 0;
} else if (discover) {
  console.log('');
} else if (selfCheck) {
  /**
   * TWO CASES, AND THE SECOND IS THE ONE THAT MAKES THE FIRST MEAN ANYTHING.
   * Scoring `mute === 1` alone passed on a CRASH, because `ok` is false whenever
   * `r.crashed`, so a mutation that took the suite down scored MUTE exactly like
   * an inert one. Since §30 made MUTE mean DECLARED UNCOVERABLE, that made every
   * MUTE in the table untrustworthy: a battery that had lost the ability to run
   * the suite would self-check green with the whole table MUTE.
   */
  const ri = selfRuns[INERT.id];
  const rx = selfRuns[CRASHER.id];
  const inertClean = !!ri && !ri.crashed && ri.fails.length === 0;
  const crasherCrashed = !!rx && rx.crashed;
  // NOT `mute === 1`: the generic loop scores BOTH cases MUTE — that conflation
  // IS the defect. The two cases are scored from their own runs; `bit === 0` is
  // kept only to catch an inert edit somehow scoring RED, which would mean the
  // suite is not deterministic and neither verdict means anything.
  const pass = bit === 0 && decayed === 0 && controlOk && inertClean && crasherCrashed;
  console.log('');
  console.log(`  ${inertClean ? `${C.g}\u2713${C.x}` : `${C.r}\u2717${C.x}`} the inert edit ran CLEAN and was scored MUTE  `
    + `${ri ? ri.summary : 'DID NOT RUN'}`);
  console.log(`  ${crasherCrashed ? `${C.g}\u2713${C.x}` : `${C.r}\u2717${C.x}`} the syntax error was seen as CRASHED, not scored MUTE  `
    + `${rx ? (rx.crashed ? 'no summary line — the run reported nothing' : rx.summary) : 'DID NOT RUN'}`);
  console.log(`\n  ${pass ? `${C.g}SELF-CHECK PASSED${C.x}` : `${C.r}SELF-CHECK FAILED${C.x}`} — the battery can say MUTE, `
    + `${pass ? 'and it can tell an inert mutation from a dead run' : 'BUT IT CANNOT TELL AN INERT MUTATION FROM A DEAD RUN — every MUTE in the table is unfalsifiable'}\n`);
  process.exitCode = pass ? 0 : 1;
} else {
  console.log(`\n  ${applied} of ${chosen.length} anchors applied, ${decayed} decayed, ${bit} behaved as tabulated, ${mute} did not`);
  if (decayed === 0 && mute === 0 && controlOk) {
    console.log(`  ${C.g}BATTERY VALID against ${HEAD}${C.x} — every anchor matches and every mutation reddens EXACTLY what it claims\n`);
  } else {
    console.log(`  ${C.r}BATTERY NOT VALID against ${HEAD}${C.x} — re-cut the anchors above and correct the table in test.js\n`);
    process.exitCode = 1;
  }
}
