/**
 * U11's MUTATION BATTERY — the instrument behind every "watched red" claim in
 * `test.js` group('export').
 *
 *     node qa/u11-export-mutations.mjs           # run them all
 *     node qa/u11-export-mutations.mjs --list    # just the table
 *     node qa/u11-export-mutations.mjs M7 M9     # named anchors only
 *
 * WHY IT IS IN THE REPOSITORY AND NOT IN A SCRATCH DIRECTORY. A "watched red"
 * is a measurement, and a measurement whose instrument was thrown away cannot be
 * repeated, re-run against a later tree, or disputed. Two batteries were lost in
 * this build because they lived in /tmp. This one is committed beside the suite
 * it tests, named for its slice.
 *
 * WHY IT IS NOT A `tools/verify.mjs` STEP, and this is deliberate rather than an
 * omission: it EDITS THE WORKING TREE. A gate that mutates its own subject is a
 * gate that can leave the tree mutated when it is interrupted, and on a machine
 * where several agents share a checkout that is somebody else's afternoon. It
 * restores in a `finally` and on every signal it can catch, and it is still run
 * by hand.
 *
 * ---------------------------------------------------------------------------
 * A BATTERY IS ONLY VALID AGAINST THE SOURCE IT WAS CUT FOR, and nothing
 * announces when that stops being true. A thirty-mutation battery in this build
 * reported 51/51 at branch time and 44/51 later; the seven gaps were not weak
 * assertions but TEN DEAD ANCHORS — later slices had rewritten the exact lines
 * they patched, and the battery reported them as "not matching", which is the
 * shape of a test that has quietly stopped testing.
 *
 * SO THIS ONE REPORTS TWO THINGS PER ANCHOR, NEVER ONE NUMBER:
 *
 *   MATCH   does the anchor still find its text, exactly once?
 *           NO  -> the INSTRUMENT decayed. Re-cut the anchor. It says nothing
 *                  about coverage.
 *   RED     with the mutation applied, does group('export') go red?
 *           NO  -> either the instrument decayed in a way that still matched, or
 *                  coverage was really lost. INVESTIGATE before re-cutting.
 *
 * A pass count alone collapses those two into one figure, which is exactly how
 * ten dead anchors read as "44 of 51".
 *
 * AND THE ANCHORS CARRY THE CONTENT THEY WERE CUT AGAINST — `ANCHORED_AT` below
 * holds one SHA-256 per file. A commit SHA would not survive the rebase every
 * branch in this phase goes through, and stamping against an unlanded tip is the
 * failure the stamp exists to prevent; a file hash survives both and is
 * checkable by anyone, so the run says DRIFTED before it says anything else.
 *
 * HOW A RED IS COUNTED. Lines matching `^  FAIL ` after ANSI is stripped —
 * line-anchored, because a matcher on the bare word FAIL also catches PASS lines
 * whose detail text says "FAILURE", and a battery that manufactures reds is
 * worth less than no battery. A run that produces no summary line at all is
 * reported as CRASHED and is NOT counted as a red: a mutation that takes the
 * suite down proves the suite can die, not that an assertion can fail.
 *
 * ---------------------------------------------------------------------------
 * A COUNT OF REDS IS NOT A MEASUREMENT OF COVERAGE, which is why every anchor
 * below carries `reds` — THE EXACT SET OF ASSERTIONS IT MUST TURN RED — and the
 * run fails the case if the observed set differs IN EITHER DIRECTION.
 *
 * WHAT A COUNT CANNOT SEE. This battery used to print "38 of 38 anchors MATCH
 * and RED" and that figure survives coverage MIGRATING between anchors: an
 * assertion stops noticing the mutation aimed at it, some other assertion starts
 * noticing a mutation it was never about, both anchors still report ">= 1 red",
 * and the total is unchanged. Both halves matter:
 *
 *   MISSING   the assertion this mutation exists to exercise did not fire. The
 *             coverage claim for it is void, whatever the total says.
 *   EXTRA     something else fired. Either the mutation is broader than its
 *             description — so the anchor is measuring a different defect from
 *             the one it names — or an assertion has started answering a
 *             question that is not its own. Both are found the same way and both
 *             need looking at; an "at least these" comparison finds neither.
 *
 * AN ASSERTION IS IDENTIFIED BY THE FIRST `KEY_LEN` CHARACTERS of its line, and
 * THE BASELINE RUN REFUSES TO PROCEED IF TWO ASSERTIONS SHARE A KEY. That is
 * this suite's own rule turned on the instrument: two assertions that produce an
 * identical observation are one assertion, and a battery that cannot tell them
 * apart would report a watched red it never watched. (Measured in this slice:
 * `export`'s row-depth guard and its file-header guard both threw WRONG_TIER
 * with "16-bit" in the message, and the assertion between them was untested
 * while it sat green. See test.js's header.)
 *
 * `blockThrew` lines are keys like any other. A mutation that kills a BLOCK is
 * not the same event as a mutation that reds an ASSERTION — the block's death
 * takes every later assertion in it out of the run — so the block-death line
 * appears in `reds` explicitly wherever it is expected.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const wr = (rel, s) => fs.writeFileSync(path.join(ROOT, rel), s);
const sha = (s) => createHash('sha256').update(s).digest('hex');

const EXPORT = 'extension/engine/export.js';
const WAV = 'extension/shared/wav.js';
const ENGINE = 'extension/offscreen/engine.js';
const CACHE = 'extension/shared/stemcache.js';
const SUITE = 'test.js';

/**
 * PROVENANCE. `base` is the LANDED commit this slice was cut from — it is in
 * history and anyone can resolve it. `files` is what actually protects the
 * battery: the SHA-256 of each anchored file as the anchors were cut. When one
 * of these drifts, the anchors below describe a file that no longer exists in
 * that form and the run says so first.
 */
export const ANCHORED_AT = {
  base: 'd0ab7fc',
  slice: 'U11 / phase4/u11-e1-export / issue #42, re-stamped after the rebase onto v0.3.1 — all 49 anchors re-verified as matching and reddening exactly, so nothing needed re-cutting',
  files: {
    [EXPORT]: 'b6c953f2ca7d409efc4178a22dd52209049aa9331202eae7932f810796c7b758',
    [WAV]: 'd9e06b208d4b1051ced3a0b46991b83a3bab397fd21b56dc4b78d1275ae531ac',
    [ENGINE]: '84660beb44179ba0c98ad6adc1fce6c2e322f2b67ae48344fcfddca3d15184b5',
    [SUITE]: 'd04e404335a45d0856585fa4289a6c1d87946cd29cd15f6b715214be29d42411',
    [CACHE]: 'afa77f527575a0e48a401cb2618417d963d879c88996a6932e7c34109ff6f578',
  },
};

/**
 * Each anchor: the file, the EXACT text to find (which must occur once), what to
 * put there, the assertion it is aimed at, and `reds` — THE EXACT SET OF
 * ASSERTIONS THE MUTATION MUST TURN RED, each identified by the first `KEY_LEN`
 * characters of its line. `find` strings are deliberately long: a short one
 * matches in three places and patches the wrong one, silently.
 *
 * `reds` IS COMPARED BOTH WAYS. A declared assertion that does not fire is
 * MISSING (the coverage claim for it is void); an assertion that fires and is
 * not declared is EXTRA (the mutation is broader than its description, or an
 * assertion has started answering someone else's question). Either fails the
 * case. `aims` is prose for a reader; `reds` is the measurement.
 *
 * A block-death line — `<block> — the block ran to its end without throwing` —
 * is a key like any other and is listed explicitly where a mutation is expected
 * to kill a block. It is not interchangeable with an assertion red: the block's
 * death takes every later assertion in that block out of the run, which is why
 * the sets for M3, M27 and M36 are as large as they are.
 */
export const MUTATIONS = [
  {
    id: 'M1',
    file: EXPORT,
    why: "exportFileNames returns the CALLER'S order instead of STEMS order",
    aims: 'the three STEMS-order assertions',
    reds: [
      "...and the CALLER'S order is ignored: a reversed request",
      "...and a SUBSET is still in `STEMS` order, so index 0 is",
    ],
    find: "  return STEMS.filter((s) => want.has(s)).map((s) => `${t} - ${s}.wav`);",
    to: "  return [...want].map((s) => `${t} - ${s}.wav`);",
  },
  {
    id: 'M2',
    file: EXPORT,
    why: 'safeTitle stops substituting path separators and colons',
    aims: 'A TITLE CANNOT ESCAPE THE CHOSEN FOLDER',
    reds: [
      "A TITLE CANNOT ESCAPE THE CHOSEN FOLDER — every base nam",
      "...a title that reduces to nothing still yields a name, ",
      "...and the sanitised title travels WITH the plan, becaus",
      "export — the whole path, end to end — the block ran to i",
    ],
    find: 'const ILLEGAL = /[\\u0000-\\u001f\\u007f/\\\\:*?"<>|]/g;',
    to: 'const ILLEGAL = /[\\u0000-\\u001f\\u007f]/g;',
  },
  {
    id: 'M3',
    file: EXPORT,
    why: 'safeTitle returns a constant — every export is renamed, no title escapes',
    aims: 'the INDEPENDENCE control: an ordinary title is untouched',
    reds: [
      "SIX FILES, ONE PER STEM, IN `STEMS` ORDER  [entry point:",
      "...and a SUBSET is still in `STEMS` order, so index 0 is",
      "...and an ORDINARY title is untouched, so the rule above",
      "...a title that reduces to nothing still yields a name, ",
      "...a Windows DEVICE name is escaped — `NUL` accepts ever",
      "...AND SO IS `<device>.<anything>`: NUL.wav, NUL.txt and",
      "...while a base that only LOOKS like a device is untouch",
      "...and the sanitised title travels WITH the plan, becaus",
      "export — the whole path, end to end — the block ran to i",
      "export — a cancelled export — the block ran to its end w",
      "A SINK MAP THAT IS SHORT ONE STEM IS REFUSED — five of s",
      "...and the destinations the Host DID open are aborted, s",
      "export — every refusal — the block ran to its end withou",
    ],
    find: "  if (!s) return 'export';\n  return RESERVED.test(s) ? `_${s}` : s;",
    to: "  return 'export';",
  },
  {
    id: 'M4',
    file: EXPORT,
    why: 'safeTitle stops stripping leading and trailing dots, so `..` survives',
    aims: 'the escape assertion, and "a title that reduces to nothing still yields a name"',
    reds: [
      "A TITLE CANNOT ESCAPE THE CHOSEN FOLDER — every base nam",
      "...a title that reduces to nothing still yields a name, ",
    ],
    find: "  s = s.replace(/^[.\\s]+/, '').replace(/[.\\s]+$/, '');",
    to: '  s = s;',
  },
  {
    id: 'M5',
    file: EXPORT,
    why: 'the Windows device-name guard never matches',
    aims: 'a Windows DEVICE name is escaped',
    reds: [
      "...a Windows DEVICE name is escaped — `NUL` accepts ever",
      "...AND SO IS `<device>.<anything>`: NUL.wav, NUL.txt and",
    ],
    find: 'const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)/i;',
    to: 'const RESERVED = /^(?!)$/;',
  },
  {
    id: 'M6',
    file: EXPORT,
    why: 'the title length cap is effectively removed',
    aims: 'a very long title is cut to fit a 255-byte name',
    reds: [
      "...and a very long title is cut to fit a 255-BYTE name, ",
    ],
    find: 'const MAX_TITLE_BYTES = 200;',
    to: 'const MAX_TITLE_BYTES = 1e9;',
  },
  {
    id: 'M7',
    file: EXPORT,
    why: 'a cancelled run CLOSES the destinations instead of aborting them — '
      + 'exactly "cancel stops writing without discarding"',
    aims: 'A CANCELLED EXPORT ABORTS EVERY DESTINATION AND CLOSES NONE; NO PARTIAL FILE IS LEFT',
    reds: [
      "A CANCELLED EXPORT ABORTS EVERY DESTINATION AND CLOSES N",
      "A DESTINATION THAT REJECTS MID-WRITE IS A NAMED REFUSAL ",
      "A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES IS A NA",
      "...and a track past the 4 GiB RIFF ceiling is refused BY",
    ],
    find: '      await Promise.all(writers.map(async (w) => { try { await w.abort(reason); } catch { /* already errored */ } }));',
    to: '      await Promise.all(writers.map(async (w) => { try { await w.close(); } catch { /* already errored */ } }));',
  },
  {
    id: 'M8',
    file: EXPORT,
    why: 'the cancel flag is never checked, so cancel() does nothing',
    aims: 'every cancellation assertion',
    reds: [
      "A CANCELLED EXPORT ABORTS EVERY DESTINATION AND CLOSES N",
      "...and the run really was under way when it was cancelle",
      "...NO PARTIAL FILE IS LEFT: not one destination holds a ",
      "...and it fails by NAME, on the declared vocabulary, rat",
    ],
    find: '          if (this.cancelled) {\n            throw new ExportError(\'CANCELLED\', `stopped after ${off} of ${frames} frames — `',
    to: '          if (false) {\n            throw new ExportError(\'CANCELLED\', `stopped after ${off} of ${frames} frames — `',
  },
  {
    id: 'M9',
    file: EXPORT,
    why: 'the six files are written ONE AFTER ANOTHER instead of in lockstep, so a '
      + 'cancel leaves the earlier stems complete on disk',
    aims: 'the six files advance TOGETHER; NO PARTIAL FILE IS LEFT',
    reds: [
      "...because the six files advance TOGETHER, never one fin",
    ],
    find: '      for (let off = 0; off < frames; off += this.chunkFrames) {\n'
      + '        const len = Math.min(this.chunkFrames, frames - off);\n'
      + '        for (let k = 0; k < order.length; k++) {',
    to: '      for (let k = 0; k < order.length; k++) {\n'
      + '        for (let off = 0; off < frames; off += this.chunkFrames) {\n'
      + '          const len = Math.min(this.chunkFrames, frames - off);',
  },
  {
    id: 'M10',
    file: EXPORT,
    why: 'the encoder is built at 16-bit PCM while everything else still says 32f',
    aims: 'EVERY FILE SAYS 32-BIT FLOAT … IN ITS OWN HEADER; the bit-identity assertions',
    reds: [
      "...and EXPORT_DONE.bytes IS the number of bytes that rea",
      "EVERY FILE SAYS 32-BIT FLOAT, 44 100 Hz, STEREO IN ITS O",
      "THE STEMS ARE THE MODEL’S, UNMODIFIED: every sample of e",
      "...INCLUDING the out-of-range samples — no clamp, no res",
      "...and the DATA CHUNK is byte-identical to the cache fil",
    ],
    find: '        sampleRate: EXPORT_FORMAT.sampleRate, bitDepth: EXPORT_FORMAT.bitDepth, float: true, dither: false, frames,',
    to: '        sampleRate: EXPORT_FORMAT.sampleRate, bitDepth: 16, float: false, dither: false, frames,',
  },
  {
    id: 'M11',
    file: EXPORT,
    why: 'A GAIN IS APPLIED ON THE DELIVERABLE PATH — the defect the whole slice exists '
      + 'to make impossible: a fader that reaches the written file',
    aims: 'THE STEMS ARE THE MODEL’S, UNMODIFIED; the data-chunk byte identity',
    reds: [
      "THE STEMS ARE THE MODEL’S, UNMODIFIED: every sample of e",
      "...INCLUDING the out-of-range samples — no clamp, no res",
      "...and the DATA CHUNK is byte-identical to the cache fil",
    ],
    find: '          const bytes = encs[k].chunk(planes, len);',
    to: '          for (let q = 0; q < len; q++) { planes[0][q] *= 0.999; planes[1][q] *= 0.999; }\n'
      + '          const bytes = encs[k].chunk(planes, len);',
  },
  {
    id: 'M12',
    file: EXPORT,
    why: "the file's own header is no longer checked against EXPORT_FORMAT — the manifest row is believed",
    aims: 'a row that says 32 over bytes that are 16 is caught by READING THE FILE’S HEADER',
    reds: [
      "...and a row that says 32 over bytes that are 16 is caug",
    ],
    find: '      if (r.sampleRate !== EXPORT_FORMAT.sampleRate || r.bitDepth !== EXPORT_FORMAT.bitDepth\n'
      + '        || r.float !== true || r.channels !== EXPORT_FORMAT.channels) {',
    to: '      if (false) {',
  },
  {
    id: 'M13',
    file: EXPORT,
    why: 'the frame count in the manifest is no longer checked against the file',
    aims: 'AN ENTRY THAT DISAGREES WITH ITSELF IS REFUSED',
    reds: [
      "AN ENTRY THAT DISAGREES WITH ITSELF IS REFUSED — neither",
    ],
    find: '      if (r.frames !== frames) {',
    to: '      if (false) {',
  },
  {
    id: 'M14',
    file: EXPORT,
    why: 'a refused exportSink is swallowed and the run carries on with an empty map',
    aims: 'A REFUSED `exportSink` IS AN ERROR, NOT A SILENT NO-OP',
    reds: [
      "A REFUSED `exportSink` IS AN ERROR, NOT A SILENT NO-OP  ",
      "...and every declared member is REACHABLE, so the vocabu",
    ],
    find: "      throw new ExportError('SINK_REFUSED', `nowhere to write: ${(e && e.message) || e}`);",
    to: '      sinks = {};',
  },
  {
    id: 'M15',
    file: EXPORT,
    why: 'a short sink map is accepted — five of six files, reported as done',
    aims: 'A SINK MAP THAT IS SHORT ONE STEM IS REFUSED',
    reds: [
      "A SINK MAP THAT IS SHORT ONE STEM IS REFUSED — five of s",
    ],
    find: '    const missing = names.filter((n) => !sinks || !sinks[n] || typeof sinks[n].getWriter !== \'function\');',
    to: '    const missing = [];',
  },
  {
    id: 'M16',
    file: EXPORT,
    why: 'the requested format is silently ignored instead of refused',
    aims: 'A FORMAT OTHER THAN 32-BIT FLOAT IS REFUSED BY NAME',
    reds: [
      "A FORMAT OTHER THAN 32-BIT FLOAT IS REFUSED BY NAME rath",
    ],
    find: '      if (bd !== EXPORT_FORMAT.bitDepth || fl !== true) {',
    to: '      if (false) {',
  },
  {
    id: 'M17',
    file: EXPORT,
    why: 'the manifest row’s depth is no longer consulted, so a 16-bit live entry is exportable',
    aims: 'A 16-BIT ENTRY IS NOT A DELIVERABLE',
    reds: [
      "A 16-BIT ENTRY IS NOT A DELIVERABLE — exporting one woul",
    ],
    find: '    if (entry.depth != null && entry.depth !== EXPORT_FORMAT.bitDepth) {',
    to: '    if (false) {',
  },
  {
    id: 'M18',
    file: EXPORT,
    why: 'a run can be started twice',
    aims: 'A RUN CANNOT BE STARTED TWICE',
    reds: [
      "A RUN CANNOT BE STARTED TWICE — two runs would write win",
    ],
    find: "    if (this.started) throw new ExportError('BUSY', 'this export has already run — build a new one');",
    to: '    if (false) { /* nothing */ }',
  },
  {
    id: 'M19',
    file: EXPORT,
    why: 'checkExportCode accepts every code, so the closed vocabulary is not closed',
    aims: 'AN UNKNOWN CODE IS REFUSED; the message names the whole legal set',
    reds: [
      "AN UNKNOWN CODE IS REFUSED rather than accepted in silen",
      "...and the message names the offending value, the entry ",
    ],
    find: '  if (EXPORT_CODES.has(code)) return null;',
    to: '  if (true) return null;',
  },
  {
    id: 'M20',
    file: WAV,
    why: 'the reader answers a DEFAULT format when open() has not run',
    aims: 'a reader that has read no header REPORTS NOTHING rather than a default',
    reds: [
      "...a reader that has read no header REPORTS NOTHING rath",
    ],
    find: "    if (!this.fmt) throw new Error('wav window: open() has not run — this reader has read no header and knows no format');",
    to: "    if (!this.fmt) return { sampleRate: 44100, bitDepth: 32, float: true, numChannels: 2, blockAlign: 8, bytesPerSample: 4, format: 3 };",
  },
  {
    id: 'M21',
    file: WAV,
    why: 'the windowed reader slurps the WHOLE file and slices it in memory — every sample '
      + 'assertion still passes and the memory claim is gone',
    aims: 'THE BIGGEST SINGLE READ IS ONE WINDOW; the read COUNT scales while the read SIZE does not',
    reds: [
      "THE BIGGEST SINGLE READ IS ONE WINDOW, AND IT DOES NOT G",
      "...and the audio is read EXACTLY ONCE end to end, so tha",
      "...and the read COUNT scales while the read SIZE does no",
    ],
    find: '    const buf = await this.blob.slice(at, at + count * fmt.blockAlign).arrayBuffer();',
    to: '    const whole = await this.blob.slice(0, this.blob.size).arrayBuffer();\n'
      + '    const buf = whole.slice(at, at + count * fmt.blockAlign);',
  },
  {
    id: 'M22',
    file: WAV,
    why: 'the window is read one byte late — plausible audio from the wrong place',
    aims: 'a window in the MIDDLE of the file is the same samples decodeWav reads there; the bit-identity assertions',
    reds: [
      "THE PLAN THE HOST RECEIVES IS A COPY — a Host that rewri",
      "THE RUN COMPLETES over a real StemCache in the 32f tier ",
      "...EXPORT_DONE reports exactly the names the Host was gi",
      "...and EXPORT_DONE.bytes IS the number of bytes that rea",
      "EVERY FILE SAYS 32-BIT FLOAT, 44 100 Hz, STEREO IN ITS O",
      "THE STEMS ARE THE MODEL’S, UNMODIFIED: every sample of e",
      "...INCLUDING the out-of-range samples — no clamp, no res",
      "...and the DATA CHUNK is byte-identical to the cache fil",
      "...two exports of the same entry are byte-identical — th",
      "...and a SUCCESSFUL export closes every destination exac",
      "PROGRESS IS ONE MESSAGE PER STEM PER WINDOW, plus one fo",
      "...pct never goes backwards and ends at exactly 1  0.016",
      "...while the format it DOES write is accepted, so the re",
      "A RUN CANNOT BE STARTED TWICE — two runs would write win",
      "THE BIGGEST SINGLE READ IS ONE WINDOW, AND IT DOES NOT G",
      "...and the audio is read EXACTLY ONCE end to end, so tha",
      "...and the read COUNT scales while the read SIZE does no",
      "...and a window in the MIDDLE of the file is the same sa",
    ],
    find: '    const at = this.dataOffset + from * fmt.blockAlign;',
    to: '    const at = this.dataOffset + from * fmt.blockAlign + 1;',
  },
  {
    id: 'M23',
    file: WAV,
    why: 'a read past the end comes back SHORT instead of being refused',
    aims: 'a read past the end is REFUSED, naming both counts',
    reds: [
      "...and a read past the end is REFUSED, naming both count",
    ],
    find: '    if (from + count > this.frames) {',
    to: '    if (false) {',
  },
  {
    id: 'M24',
    file: CACHE,
    why: 'stemFile ignores which stem it was asked for — the six-identical-stems fan-out',
    aims: 'THE STEMS ARE THE MODEL’S, UNMODIFIED (each file against its OWN source)',
    reds: [
      "THE STEMS ARE THE MODEL’S, UNMODIFIED: every sample of e",
    ],
    find: '    return (await d.getFileHandle(`${key}.${stem}.wav`)).getFile();',
    to: '    return (await d.getFileHandle(`${key}.${STEMS[0]}.wav`)).getFile();',
  },
  {
    id: 'M25',
    file: ENGINE,
    why: 'the engine stops checking the code it sends on EXPORT_ERROR',
    aims: '`offscreen/engine.js` CHECKS EVERY CODE IT SENDS',
    reds: [
      "...AND `offscreen/engine.js` CHECKS EVERY CODE IT SENDS:",
    ],
    find: '  checkExportCode(code, `EXPORT_ERROR on deck ${deckId}`);',
    to: '  void deckId;',
  },
  {
    id: 'M26',
    file: EXPORT,
    why: 'the deliverable path imports the mixer, so a fader could reach it',
    aims: 'THE DELIVERABLE PATH IMPORTS NO MIXER, NO DECK AND NO WORKLET',
    reds: [
      "THE DELIVERABLE PATH IMPORTS NO MIXER, NO DECK AND NO WO",
    ],
    find: "import { WavStreamEncoder } from '../shared/wav.js';",
    to: "import { WavStreamEncoder } from '../shared/wav.js';\nimport { dbToGain } from './mixer.js';\nvoid dbToGain;",
  },
  {
    id: 'M27',
    file: EXPORT,
    why: 'the Host is asked TWICE for the same deliverable — the correlation problem the '
      + 'all-six-at-once duty exists to remove',
    aims: 'the Host was asked ONCE, for all six destinations together',
    reds: [
      "...the Host was asked ONCE, for all six destinations tog",
      "...and the sanitised title travels WITH the plan, becaus",
      "...and EXPORT_DONE.bytes IS the number of bytes that rea",
      "export — the whole path, end to end — the block ran to i",
      "A CANCELLED EXPORT ABORTS EVERY DESTINATION AND CLOSES N",
      "...and the run really was under way when it was cancelle",
      "...and the destinations the Host DID open are aborted, s",
      "A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES IS A NA",
      "...and a track past the 4 GiB RIFF ceiling is refused BY",
    ],
    find: '      sinks = await this.exportSink({ title, files: names.slice() });',
    to: '      sinks = await this.exportSink({ title, files: names.slice() });\n'
      + '      await this.exportSink({ title, files: names.slice() });',
  },
  {
    id: 'M28',
    file: EXPORT,
    why: 'progress reports a 0-based file index into a 1..files range',
    aims: 'every tick names a file within the set it declares',
    reds: [
      "...and every tick names a file within the set it declare",
    ],
    find: "          this.#tick('write', k + 1, order.length, done / total, t0);",
    to: "          this.#tick('write', k, order.length, done / total, t0);",
  },
  {
    id: 'M29',
    file: EXPORT,
    why: 'a stem the six-stem contract has no name for is accepted',
    aims: 'A STEM THE SIX-STEM CONTRACT HAS NO NAME FOR IS REFUSED',
    reds: [
      "A STEM THE SIX-STEM CONTRACT HAS NO NAME FOR IS REFUSED,",
    ],
    find: '    const unknown = this.stems.filter((s) => !STEMS.includes(s));',
    to: '    const unknown = [];',
  },
  {
    id: 'M30',
    file: EXPORT,
    why: 'a key that names nothing is no longer refused up front',
    aims: 'A KEY THAT NAMES NOTHING IS REFUSED before a single file or destination is opened',
    reds: [
      "A KEY THAT NAMES NOTHING IS REFUSED before a single file",
    ],
    find: "    if (!entry || typeof entry.key !== 'string') {",
    to: '    if (false) {',
  },
  {
    id: 'M31',
    file: EXPORT,
    why: 'a stem file that will not open is swallowed instead of named',
    aims: 'A STEM FILE THAT WILL NOT OPEN IS A NAMED REFUSAL',
    reds: [
      "A STEM FILE THAT WILL NOT OPEN IS A NAMED REFUSAL, and n",
    ],
    find: "        throw new ExportError('READ_FAILED', `${entry.key}: the ${stem} stem would not open — ${(e && e.message) || e}`);",
    to: '        r = null;',
  },
  {
    id: 'M32',
    file: CACHE,
    why: 'StemCache.get() stops reading whole files, so the contrast the memory numbers are '
      + 'measured against disappears',
    aims: 'while `StemCache.get()` takes each stem WHOLE, which is why the export does not call it',
    reds: [
      "...while `StemCache.get()` takes each stem WHOLE, which ",
    ],
    find: '        const w = decodeWav(await f.arrayBuffer());',
    to: '        const w = decodeWav(await f.slice(0, 66).arrayBuffer());',
  },
  {
    id: 'M33',
    file: EXPORT,
    why: 'checkExportCode cries wolf on every LEGAL code — the other direction of M19, and the '
      + 'question a "can it fail?" review never asks: can it PASS?',
    aims: 'EVERY MEMBER OF THE EXPORT VOCABULARY PASSES SILENTLY',
    reds: [
      "EVERY MEMBER OF THE EXPORT VOCABULARY PASSES SILENTLY  [",
    ],
    find: '  if (EXPORT_CODES.has(code)) return null;',
    to: '  if (false) return null;',
  },
  {
    id: 'M34',
    file: EXPORT,
    why: 'the runner throws a code that is not in the declared set — the #29 failure exactly',
    aims: 'EVERY CODE THE RUNNER CAN THROW IS A DECLARED MEMBER',
    reds: [
      "A RUN CANNOT BE STARTED TWICE — two runs would write win",
      "EVERY CODE THE RUNNER CAN THROW IS A DECLARED MEMBER  [e",
    ],
    find: "    if (this.started) throw new ExportError('BUSY', 'this export has already run — build a new one');",
    to: "    if (this.started) throw new ExportError('ALREADY_RUN', 'this export has already run — build a new one');",
  },
  {
    id: 'M35',
    file: ENGINE,
    why: 'the engine stops wiring EXPORT_CANCEL, so the deck can start an export it cannot stop',
    aims: 'the engine really wires `EXPORT_START` and `EXPORT_CANCEL` to the runner',
    reds: [
      "...and the engine really wires `EXPORT_START` and `EXPOR",
    ],
    find: "      case 'EXPORT_CANCEL':",
    to: "      case 'EXPORT_ABORT':",
  },
  {
    id: 'M36',
    file: WAV,
    why: 'the reader reports a rate it did not read out of the file',
    aims: 'THE WINDOWED READER REPORTS THE FILE’S OWN FORMAT',
    reds: [
      "THE RUN COMPLETES over a real StemCache in the 32f tier ",
      "...the Host was asked ONCE, for all six destinations tog",
      "...and the sanitised title travels WITH the plan, becaus",
      "...EXPORT_DONE reports exactly the names the Host was gi",
      "export — the whole path, end to end — the block ran to i",
      "export — a cancelled export — the block ran to its end w",
      "A REFUSED `exportSink` IS AN ERROR, NOT A SILENT NO-OP  ",
      "A SINK MAP THAT IS SHORT ONE STEM IS REFUSED — five of s",
      "...and the destinations the Host DID open are aborted, s",
      "...while the format it DOES write is accepted, so the re",
      "AN ENTRY THAT DISAGREES WITH ITSELF IS REFUSED — neither",
      "A STEM FILE THAT WILL NOT OPEN IS A NAMED REFUSAL, and n",
      "export — every refusal — the block ran to its end withou",
      "THE BIGGEST SINGLE READ IS ONE WINDOW, AND IT DOES NOT G",
      "...and the audio is read EXACTLY ONCE end to end, so tha",
      "...and the read COUNT scales while the read SIZE does no",
      "THE WINDOWED READER REPORTS THE FILE’S OWN FORMAT  [entr",
    ],
    find: '    this.fmt = fmt;',
    to: '    this.fmt = { ...fmt, sampleRate: 48000 };',
  },
  {
    id: 'M37',
    file: WAV,
    why: 'a wrong number of planes is accepted, so half a window is filled and the rest is stale',
    aims: 'a wrong number of planes is refused rather than filling half a window',
    reds: [
      "...and a wrong number of planes is refused rather than f",
    ],
    find: '    if (into.length !== fmt.numChannels) {',
    to: '    if (false) {',
  },
  {
    id: 'M38',
    file: SUITE,
    why: "the header's group list loses `export`, so `node test.js export` would one day assert nothing and exit 0",
    aims: 'THE HEADER’S GROUP LIST IS THE GROUPS THIS FILE ACTUALLY HAS',
    reds: [
      "THE HEADER’S GROUP LIST IS THE GROUPS THIS FILE ACTUALLY",
    ],
    find: " *   export   U11's E1: the six untouched model outputs out of the 32f tier into",
    to: " *   exp0rt   U11's E1: the six untouched model outputs out of the 32f tier into",
  },
  {
    id: 'M39',
    file: EXPORT,
    why: 'THE DEFECT ITSELF: the device guard goes back to matching only a title that IS the device, so NUL.wav, Con.Fusion, nul.02, com1.set, aux.1, lpt1.x and prn.mix all reach Windows unescaped and every byte goes to the null device while EXPORT_DONE names six files',
    aims: '...AND SO IS `<device>.<anything>`',
    reds: [
      "...AND SO IS `<device>.<anything>`: NUL.wav, NUL.txt and",
    ],
    find: 'const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)/i;',
    to: 'const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;',
  },
  {
    id: 'M40',
    file: EXPORT,
    why: 'the other direction of M39: the guard escapes EVERY title containing a dot, so `a.b.c` and `a.con` are renamed for no reason',
    aims: 'the lookalike control, and the ordinary-title control',
    reds: [
      "...and an ORDINARY title is untouched, so the rule above",
      "...while a base that only LOOKS like a device is untouch",
    ],
    find: 'const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)/i;',
    to: 'const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)|\\./i;',
  },
  {
    id: 'M41',
    file: EXPORT,
    why: 'taking the writers and building the encoders throws PAST the abort again — a raw TypeError/RangeError escapes the closed vocabulary and every writable the Host just opened is left neither closed nor aborted',
    aims: 'A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES; the 4 GiB ceiling',
    reds: [
      "A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES IS A NA",
      "...and a track past the 4 GiB RIFF ceiling is refused BY",
    ],
    find: "    } catch (e) {\n      await abortAll(e);\n      throw new ExportError('WRITE_FAILED', `${entry.key}: the destinations could not be prepared — `",
    to: "    } catch (e) {\n      throw e;\n      // eslint-disable-next-line no-unreachable\n      throw new ExportError('WRITE_FAILED', `${entry.key}: the destinations could not be prepared — `",
  },
  {
    id: 'M42',
    file: EXPORT,
    why: 'the abort reaches only the destinations a writer was taken for, so the ones the Host opened and the run never got to are left open',
    aims: 'A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES (the abort counts)',
    reds: [
      "A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES IS A NA",
    ],
    find: "      await Promise.all(names.slice(writers.length).map(async (n) => {\n        try { await sinks[n].abort(reason); } catch { /* locked above, or already errored */ }\n      }));",
    to: '      /* the destinations that never got a writer are left alone */',
  },
  {
    id: 'M43',
    file: EXPORT,
    why: 'EXPORT_DONE.bytes stops counting the audio — the wire field reports a constant',
    aims: '...and EXPORT_DONE.bytes IS the number of bytes that reached the destinations',
    reds: [
      "...and EXPORT_DONE.bytes IS the number of bytes that rea",
    ],
    find: '          this.bytes += bytes.byteLength;',
    to: '          this.bytes += 0;',
  },
  {
    id: 'M44',
    file: EXPORT,
    why: 'EXPORT_DONE.bytes under-reports by the six headers — a plausible number that is wrong by 348 bytes',
    aims: '...and EXPORT_DONE.bytes IS the number of bytes that reached the destinations',
    reds: [
      "...and EXPORT_DONE.bytes IS the number of bytes that rea",
    ],
    find: '      for (const [i, w] of writers.entries()) { await w.write(encs[i].header()); this.bytes += encs[i].headerSize; }',
    to: '      for (const [i, w] of writers.entries()) { await w.write(encs[i].header()); }',
  },
  {
    id: 'M45',
    file: EXPORT,
    why: 'etaMs reports 0 rather than null while there is nothing to divide by, so the read tick renders as "finished" the moment the folder dialog opens',
    aims: '...and etaMs is `null` until something is done and a NUMBER afterwards',
    reds: [
      "...and etaMs is `null` until something is done and a NUM",
    ],
    find: '      etaMs: pct > 0 ? Math.round(elapsedMs * (1 - pct) / pct) : null,',
    to: '      etaMs: pct > 0 ? Math.round(elapsedMs * (1 - pct) / pct) : 0,',
  },
  {
    id: 'M46',
    file: EXPORT,
    why: 'an export of no stems loses its named refusal and runs — the Host is asked to open zero destinations',
    aims: 'AN EXPORT OF NO STEMS IS REFUSED',
    reds: [
      "AN EXPORT OF NO STEMS IS REFUSED — an empty list is not ",
    ],
    find: "    if (!order.length) {\n      throw new ExportError('BAD_STEM', 'an export of no stems is not a smaller export');\n    }",
    to: '    if (false) { /* an export of no stems is allowed to run */ }',
  },
  {
    id: 'M47',
    file: EXPORT,
    why: 'a manifest length that is 0 or fractional is no longer refused up front, so the run opens six readers to discover it',
    aims: 'A LENGTH THAT IS NOT A POSITIVE INTEGER IS REFUSED',
    reds: [
      "A LENGTH THAT IS NOT A POSITIVE INTEGER IS REFUSED — nei",
    ],
    find: '    if (!Number.isInteger(frames) || frames <= 0) {',
    to: '    if (false) {',
  },
  {
    id: 'M49',
    file: EXPORT,
    why: 'the live names array is handed to the Host instead of a copy, so a Host that sorts or de-duplicates `plan.files` rewrites the run\'s own names',
    aims: 'THE PLAN THE HOST RECEIVES IS A COPY',
    reds: [
      "THE PLAN THE HOST RECEIVES IS A COPY — a Host that rewri",
    ],
    find: '      sinks = await this.exportSink({ title, files: names.slice() });',
    to: '      sinks = await this.exportSink({ title, files: names });',
  },
  {
    id: 'M48',
    file: EXPORT,
    why: 'the cancel check before the folder dialog is dropped, so a cancelled run still opens a dialog and six destinations',
    aims: 'A CANCEL THAT LANDS BEFORE THE FOLDER DIALOG',
    reds: [
      "A CANCEL THAT LANDS BEFORE THE FOLDER DIALOG STOPS THE R",
    ],
    find: "    if (this.cancelled) throw new ExportError('CANCELLED', 'the export was stopped before anything was opened');",
    to: '    /* no pre-sink cancel check */',
  },
];

// --------------------------------------------------------------------- run

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * How many characters of an assertion's line identify it. Long enough that no
 * two differ only past it — CHECKED, not assumed, on every run — and short
 * enough that `reds` below stays readable. Measured at the stamp: all 66
 * assertions in group('export') are distinct within the first 40.
 */
const KEY_LEN = 56;
const keyOf = (line) => line.replace(/^ {2}(PASS|FAIL) /, '').slice(0, KEY_LEN);

/**
 * A WALL-CLOCK CEILING, because a mutation can make the suite RUN AWAY rather
 * than fail. Measured: the anchor that builds the encoder at 16 bit takes the
 * 4 GiB-ceiling fixture under the ceiling, and the run then walks six million
 * windows — `execFileSync` with no timeout waits for it forever, and a battery
 * that hangs leaves the tree MUTATED. A timeout is reported as its own verdict:
 * a mutation that hangs the suite has not been watched red either.
 */
const SUITE_TIMEOUT_MS = 120_000;

function runSuite() {
  let out, timedOut = false;
  try {
    out = execFileSync(process.execPath, ['test.js', 'export'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SUITE_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
  } catch (e) {
    timedOut = e.killed === true || e.signal === 'SIGKILL';
    out = `${(e.stdout || '')}${e.stderr || ''}`;
  }
  const clean = out.replace(ANSI, '');
  const lines = clean.split('\n');
  const reds = lines.filter((l) => /^ {2}FAIL /.test(l));
  const greens = lines.filter((l) => /^ {2}PASS /.test(l));
  const summary = clean.match(/^(\d+) passed, (\d+) failed$/m);
  return {
    reds: reds.length,
    keys: reds.map(keyOf),
    allKeys: [...greens, ...reds].map(keyOf),
    first: reds.length ? reds[0].replace(/^ {2}FAIL /, '').slice(0, 92) : '',
    crashed: summary === null,
    timedOut,
    passed: summary ? Number(summary[1]) : null,
    failed: summary ? Number(summary[2]) : null,
  };
}

/** Set difference both ways, in the order the suite printed them. */
function compare(want, got) {
  const w = new Set(want), g = new Set(got);
  return { missing: want.filter((k) => !g.has(k)), extra: got.filter((k) => !w.has(k)) };
}

function main() {
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const only = args.filter((a) => !a.startsWith('--'));
  const chosen = only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS;

  console.log(`u11-export-mutations — ${chosen.length} anchor(s), cut against ${ANCHORED_AT.base} (${ANCHORED_AT.slice})\n`);

  // --- provenance, before anything else ---------------------------------
  const drift = [];
  for (const [rel, want] of Object.entries(ANCHORED_AT.files)) {
    const got = sha(rd(rel));
    if (want.startsWith('FILL_')) { drift.push(`${rel}: the stamp was never filled in (${got.slice(0, 12)})`); continue; }
    if (got !== want) drift.push(`${rel}: DRIFTED — stamped ${want.slice(0, 12)}, now ${got.slice(0, 12)}`);
  }
  if (drift.length) {
    console.log('  \x1b[33mPROVENANCE\x1b[0m — the anchored files are not the ones the anchors were cut against:');
    for (const d of drift) console.log(`    ${d}`);
    console.log('    Anchors that still MATCH are still measuring; ones that do not have DECAYED and must be re-cut.\n');
  } else {
    console.log(`  provenance: all ${Object.keys(ANCHORED_AT.files).length} anchored files match the stamp\n`);
  }

  if (list) {
    for (const m of chosen) {
      console.log(`  ${m.id.padEnd(4)} ${m.file}\n       ${m.why}\n       -> aims at: ${m.aims}`);
      const want = m.reds || [];
      if (!want.length) console.log('       -> DECLARES NO EXPECTED SET — its red count would be a number, not a measurement');
      else for (const k of want) console.log(`       -> must red: ${JSON.stringify(k)}`);
    }
    return 0;
  }

  const base = runSuite();
  console.log(`  baseline: ${base.passed} passed, ${base.failed} failed${base.crashed ? ' (NO SUMMARY — the suite crashed before the mutations began)' : ''}`);
  if (base.crashed || base.failed !== 0) {
    console.log('  \x1b[31mThe tree is not green before the mutations. Fix that first: every number below would be meaningless.\x1b[0m');
    return 2;
  }

  /**
   * THE INSTRUMENT'S OWN PRECONDITION. Every assertion must be distinguishable
   * from every other by its key, or a `reds` set below is a claim about a name
   * two assertions share — the same failure this suite records for two guards
   * with one observation, one level further out. It is checked here and it stops
   * the run.
   */
  const dupes = base.allKeys.filter((k, i) => base.allKeys.indexOf(k) !== i);
  if (dupes.length) {
    console.log(`\n  \x1b[31mTWO ASSERTIONS SHARE A KEY at ${KEY_LEN} characters — this battery cannot tell them apart,\x1b[0m`);
    console.log('  \x1b[31mso every `reds` set below is ambiguous. Lengthen KEY_LEN or reword one of them:\x1b[0m');
    for (const d of [...new Set(dupes)]) console.log(`    ${JSON.stringify(d)}`);
    return 2;
  }
  console.log(`  ${base.allKeys.length} assertions, all distinct within ${KEY_LEN} characters\n`);

  const rows = [];
  for (const m of chosen) {
    const rel = m.file;
    const before = rd(rel);
    const hits = before.split(m.find).length - 1;
    if (hits !== 1) {
      rows.push({ id: m.id, match: false, hits, reds: 0, crashed: false, first: '', aims: m.aims, file: rel });
      console.log(`  \x1b[33mDECAY\x1b[0m ${m.id.padEnd(4)} anchor matched ${hits} time(s) in ${rel} — it points at nothing. The instrument decayed; re-cut it.`);
      continue;
    }
    let r;
    try {
      wr(rel, before.replace(m.find, m.to));
      r = runSuite();
    } finally {
      wr(rel, before);
    }
    const want = m.reds || [];
    const { missing, extra } = compare(want, r.keys);
    const setOk = !r.crashed && !r.timedOut && missing.length === 0 && extra.length === 0 && want.length > 0;
    rows.push({
      id: m.id, match: true, hits, reds: r.reds, crashed: r.crashed, timedOut: r.timedOut,
      first: r.first, aims: m.aims, file: rel, missing, extra, declared: want.length, setOk,
    });
    const verdict = r.timedOut ? '\x1b[31mHANG \x1b[0m'
      : r.crashed ? '\x1b[31mCRASH\x1b[0m'
        : setOk ? '\x1b[32mRED  \x1b[0m' : '\x1b[31mWRONG\x1b[0m';
    console.log(`  ${verdict} ${m.id.padEnd(4)} ${String(r.reds).padStart(2)} red / ${String(want.length).padStart(2)} declared  ${m.why}`);
    if (r.timedOut) console.log(`             the suite did not finish inside ${SUITE_TIMEOUT_MS} ms — a mutation that hangs the suite is not a watched red`);
    if (r.crashed && !r.timedOut) console.log('             the suite produced NO SUMMARY LINE — a mutation that kills the suite is not a watched red');
    if (!want.length) console.log('             this anchor DECLARES NO EXPECTED SET, so its red count is a number and not a measurement');
    for (const k of missing) console.log(`             \x1b[31mMISSING\x1b[0m the declared assertion did not fire: ${JSON.stringify(k)}`);
    for (const k of extra) console.log(`             \x1b[31mEXTRA  \x1b[0m an assertion fired that this anchor does not claim: ${JSON.stringify(k)}`);
  }

  const decayed = rows.filter((r) => !r.match);
  const undeclared = rows.filter((r) => r.match && !r.declared);
  const crashed = rows.filter((r) => r.crashed || r.timedOut);
  const wrongSet = rows.filter((r) => r.match && r.declared && !r.crashed && !r.timedOut && !r.setOk);
  const good = rows.filter((r) => r.setOk);

  console.log(`\n  ${good.length} of ${rows.length} anchors MATCH and RED EXACTLY THE ASSERTIONS THEY DECLARE`);
  if (decayed.length) console.log(`  ${decayed.length} DECAYED (anchor no longer matches): ${decayed.map((r) => r.id).join(', ')}`);
  if (undeclared.length) console.log(`  ${undeclared.length} DECLARE NO EXPECTED SET, so nothing was measured for them: ${undeclared.map((r) => r.id).join(', ')}`);
  if (wrongSet.length) {
    console.log(`  ${wrongSet.length} RED THE WRONG SET — coverage has moved, or the anchor is broader than its description: ${wrongSet.map((r) => r.id).join(', ')}`);
    console.log('     A total would have counted every one of these as a watched red.');
  }
  if (crashed.length) console.log(`  ${crashed.length} CRASHED or HUNG the suite rather than reddening it: ${crashed.map((r) => r.id).join(', ')}`);

  // The tree must be exactly as it was found.
  const dirty = Object.keys(ANCHORED_AT.files).filter((rel) => !ANCHORED_AT.files[rel].startsWith('FILL_') && sha(rd(rel)) !== ANCHORED_AT.files[rel]);
  if (dirty.length) console.log(`\n  \x1b[31mLEFT MUTATED: ${dirty.join(', ')} — restore them by hand before doing anything else\x1b[0m`);

  return good.length === rows.length && !dirty.length ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
