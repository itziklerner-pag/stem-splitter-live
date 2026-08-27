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
 * IT IS DELIBERATELY NOT A verify.mjs STEP. It edits tracked source. A gate that
 * writes the tree it is gating is a gate that can leave the tree written. Every
 * file is restored in a `finally` and the restoration is verified by hash before
 * the process exits.
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

/** The landed commit U7 was branched from. Its own commits are not landed yet. */
const BASE = '5993d32';

/**
 * The four subject files, each with the SHA-256 of the content the anchors below
 * were cut against. A mismatch does not mean an anchor is dead — it means one
 * MIGHT be, and the per-anchor DECAYED lines are what say which.
 */
const SUBJECTS = {
  E: { path: 'extension/engine/live.js',      sha: 'cbf3c2498172454630d3eb4037442f888f723523e2afa57cd37832af73f8e33c' },
  L: { path: 'extension/offscreen/live.js',   sha: '5d61e4e324827eb77e84076f6bf770f1ab9c189d569ea6a8f03531583e45a833' },
  S: { path: 'extension/shared/stemcache.js', sha: 'd5f49c9ac81d0fcd5679fb22d9db92e7c05164a9a5356217a5c9f1cfb8a2746c' },
  D: { path: 'extension/offscreen/deck.js',   sha: '5330c458b77bc26f70738f0f0d0845517c715aca842a3ef1ad59a5f2cbeb896b' },
  /**
   * THE FIXTURE IS A SUBJECT TOO, for the CONTROL assertions and only for them.
   * A control's job is to fail when the fixture degenerates — when the thing it
   * was supposed to create a difference in did not — so the only mutation that
   * can watch one red is a mutation OF THE FIXTURE. Marked `fixture: true` on
   * every row that uses it, because a fixture mutation is evidence about the
   * control and about nothing else.
   */
  F: { path: 'test.js', sha: '440fddd6851f61d123946b1e51d3ca1c8cce671f8ae3ca517befa1b776b93b04' },
};

/**
 * The 53 assertions U7 adds to group('live'), by the distinctive substring each
 * is matched on. Six of them are emitted once per (hop, stop-point) pair — three
 * hops x two stop points — so a key marked `x6` names six reds, not one.
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
  ownbufs:    'the drain never borrows the in-flight scratch',
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
  // the writer seam (ruling 34)
  open:       'attaching a recording writer OPENS the recording',
  accum:      'a running recording ACCUMULATES separated audio',
  primeabort: 'a drop ABANDONS THE PRIME',
  notabort:   'DOES NOT abort the recording',
  reccount:   'the recording IS counted, so its refusal can name how many',
  recclosed:  'the recording is CLOSED at the boundary',
  afterbound: 'a CHUNK that lands after the boundary does not reach it either',
  handback:   'detaching still HANDS IT BACK, drop and all',
  // the retained-buffer count (#7)
  bufcount:   'the pipeline holds THE SAME NUMBER OF BUFFERS after 60 s',
  bufctl:     'the recording really advanced over that span',
  // the group guard
  guard:      'group(live) REACHED ITS LAST ASSERTION',
};

/** Keys emitted once per (hop, stop-point) pair: six reds each, not one. */
const SIXFOLD = new Set([A.short, A.exact, A.audio]);

/**
 * `expect` is the EXACT set of assertion KEYS the mutation must redden — not a
 * subset. An unclaimed red is reported too, because a mutation that reddens more
 * than its table entry says means the table is wrong about what the assertion
 * covers.
 */
const MUTATIONS = [
  // ---------------------------------------------------------------- engine/live.js
  {
    id: 'M1', file: 'E',
    what: 'finish() reads the WRONG PART of the model output (offset off by the crossfade)',
    find: '    const o = p.L - len;',
    with: '    const o = p.L - len - X;',
    expect: [A.audio],
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
    expect: [A.join, A.midfade],
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
    expect: [A.ownbufs],
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
    expect: [A.skipends, A.recclosed, A.afterbound],
  },
  {
    id: 'M15', file: 'L',
    what: 'skipOne() aborts the prime without COUNTING the drop',
    find: '      this.cacheWriter.noteDrop();\n      this.cacheWriter.abort();',
    with: '      this.cacheWriter.abort();',
    expect: [A.primeabort, A.skipcount],
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
    expect: [A.reccount],
  },
  {
    id: 'M18', file: 'L',
    what: 'endPass(\'drop\') does not CLOSE the recording, so audio after the gap is appended to it',
    find: "    if (reason === 'drop') this.recOpen = false;",
    with: '',
    expect: [A.recclosed, A.afterbound],
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
    expect: [A.accum, A.afterbound, A.handback, A.bufctl],
  },
  {
    id: 'M21', file: 'L',
    what: 'attachRecWriter() attaches the writer but leaves the recording CLOSED',
    find: '  attachRecWriter(w) { this.recWriter = w || null; this.recOpen = !!w; }',
    with: '  attachRecWriter(w) { this.recWriter = w || null; }',
    expect: [A.open, A.accum, A.afterbound, A.handback, A.bufctl],
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
    expect: [A.skipends, A.skipcount, A.primeabort],
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
];

/** The inert edit `--self-check` uses: a comment, and nothing else. */
const INERT = {
  id: 'M0', file: 'E',
  what: 'a comment is edited and nothing else — the suite MUST stay green',
  find: '/** set by `finish()`; nothing may be published after the last publication */',
  with: '/** set by `finish()` (self-check: this comment was edited); nothing may be published after */',
  expect: [A.exact],
};

// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const selfCheck = argv.includes('--self-check');
const discover = argv.includes('--discover');
const coverage = argv.includes('--coverage');
const tableOnly = argv.includes('--table');
const only = argv.filter((a) => !a.startsWith('--'));
const chosen = selfCheck ? [INERT] : (only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS);

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
  return {
    crashed: summary === null,
    fails,
    passed: summary ? Number(summary.split(' ')[0]) : -1,
    failed: summary ? Number(summary.split(', ')[1].split(' ')[0]) : -1,
    summary: summary || 'NO SUMMARY LINE — the run ended without reporting: '
      + clean.trim().split('\n').filter(Boolean).slice(-2).join(' | '),
  };
}

/** How many reds a key is expected to produce: six for the per-hop loop keys. */
const weight = (key) => (SIXFOLD.has(key) ? 6 : 1);
const matched = (fails, key) => fails.filter((f) => f.includes(key)).length;

const HEAD = headRev();

if (coverage) {
  const claimed = new Set();
  for (const m of MUTATIONS) for (const e of m.expect) claimed.add(e);
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
      ? m.expect.map((e) => KEY[e] + (weight(e) > 1 ? ` x${weight(e)}` : '')).join(', ')
      : 'NOTHING — recorded as a negative result';
    console.log(` *   ${m.id.padEnd(4)} ${where.padEnd(24)} ${m.what}`);
    console.log(` *   ${' '.repeat(30)}-> ${reds}`);
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

try {
  if (!listOnly) {
    const c = runSuite();
    controlOk = !c.crashed && c.fails.length === 0;
    console.log(`  ${controlOk ? `${C.g}CONTROL${C.x}` : `${C.r}CONTROL${C.x}`} unmutated: ${c.summary}`);
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

    const missing = m.expect.filter((e) => matched(r.fails, e) !== weight(e));
    const unexpected = r.fails.filter((f) => !m.expect.some((e) => f.includes(e)));
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
        + missing.map((e) => `${e} (${matched(r.fails, e)} of ${weight(e)})`).join(' | '));
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
  const pass = mute === 1 && bit === 0 && decayed === 0 && controlOk;
  console.log(`\n  ${pass ? `${C.g}SELF-CHECK PASSED${C.x}` : `${C.r}SELF-CHECK FAILED${C.x}`} — an inert edit was scored `
    + `${bit ? 'RED' : 'MUTE'}, and the battery ${pass ? 'can therefore say MUTE' : 'CANNOT DISTINGUISH a live assertion from a dead one'}\n`);
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
