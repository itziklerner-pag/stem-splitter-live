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
  base: '5993d32',
  slice: 'U11 / phase4/u11-e1-export / issue #42',
  files: {
    [EXPORT]: '22a3d2105aa625bcb469d0aa960171f7cacfdce3046977fdf5f3cec81f5f1fff',
    [WAV]: 'd9e06b208d4b1051ced3a0b46991b83a3bab397fd21b56dc4b78d1275ae531ac',
    [ENGINE]: '84660beb44179ba0c98ad6adc1fce6c2e322f2b67ae48344fcfddca3d15184b5',
    [SUITE]: '7af0896e17de96c70cab0481c2ae1f3c60ec852c1e471112efddcf89d9e80064',
    [CACHE]: 'afa77f527575a0e48a401cb2618417d963d879c88996a6932e7c34109ff6f578',
  },
};

/**
 * Each anchor: the file, the EXACT text to find (which must occur once), what to
 * put there, and the assertion it is aimed at. `find` strings are deliberately
 * long — a short one matches in three places and patches the wrong one, silently.
 */
export const MUTATIONS = [
  {
    id: 'M1',
    file: EXPORT,
    why: "exportFileNames returns the CALLER'S order instead of STEMS order",
    aims: 'the three STEMS-order assertions',
    find: "  return STEMS.filter((s) => want.has(s)).map((s) => `${t} - ${s}.wav`);",
    to: "  return [...want].map((s) => `${t} - ${s}.wav`);",
  },
  {
    id: 'M2',
    file: EXPORT,
    why: 'safeTitle stops substituting path separators and colons',
    aims: 'A TITLE CANNOT ESCAPE THE CHOSEN FOLDER',
    find: 'const ILLEGAL = /[\\u0000-\\u001f\\u007f/\\\\:*?"<>|]/g;',
    to: 'const ILLEGAL = /[\\u0000-\\u001f\\u007f]/g;',
  },
  {
    id: 'M3',
    file: EXPORT,
    why: 'safeTitle returns a constant — every export is renamed, no title escapes',
    aims: 'the INDEPENDENCE control: an ordinary title is untouched',
    find: "  if (!s) return 'export';\n  return RESERVED.test(s) ? `_${s}` : s;",
    to: "  return 'export';",
  },
  {
    id: 'M4',
    file: EXPORT,
    why: 'safeTitle stops stripping leading and trailing dots, so `..` survives',
    aims: 'the escape assertion, and "a title that reduces to nothing still yields a name"',
    find: "  s = s.replace(/^[.\\s]+/, '').replace(/[.\\s]+$/, '');",
    to: '  s = s;',
  },
  {
    id: 'M5',
    file: EXPORT,
    why: 'the Windows device-name guard never matches',
    aims: 'a Windows DEVICE name is escaped',
    find: 'const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;',
    to: 'const RESERVED = /^(?!)$/;',
  },
  {
    id: 'M6',
    file: EXPORT,
    why: 'the title length cap is effectively removed',
    aims: 'a very long title is cut to fit a 255-byte name',
    find: 'const MAX_TITLE_BYTES = 200;',
    to: 'const MAX_TITLE_BYTES = 1e9;',
  },
  {
    id: 'M7',
    file: EXPORT,
    why: 'a cancelled run CLOSES the destinations instead of aborting them — '
      + 'exactly "cancel stops writing without discarding"',
    aims: 'A CANCELLED EXPORT ABORTS EVERY DESTINATION AND CLOSES NONE; NO PARTIAL FILE IS LEFT',
    find: '      await Promise.all(writers.map((w) => w.abort(reason).catch(() => {})));',
    to: '      await Promise.all(writers.map((w) => w.close().catch(() => {})));',
  },
  {
    id: 'M8',
    file: EXPORT,
    why: 'the cancel flag is never checked, so cancel() does nothing',
    aims: 'every cancellation assertion',
    find: '          if (this.cancelled) {\n            throw new ExportError(\'CANCELLED\', `stopped after ${off} of ${frames} frames — `',
    to: '          if (false) {\n            throw new ExportError(\'CANCELLED\', `stopped after ${off} of ${frames} frames — `',
  },
  {
    id: 'M9',
    file: EXPORT,
    why: 'the six files are written ONE AFTER ANOTHER instead of in lockstep, so a '
      + 'cancel leaves the earlier stems complete on disk',
    aims: 'the six files advance TOGETHER; NO PARTIAL FILE IS LEFT',
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
    find: '      sampleRate: EXPORT_FORMAT.sampleRate, bitDepth: EXPORT_FORMAT.bitDepth, float: true, dither: false, frames,',
    to: '      sampleRate: EXPORT_FORMAT.sampleRate, bitDepth: 16, float: false, dither: false, frames,',
  },
  {
    id: 'M11',
    file: EXPORT,
    why: 'A GAIN IS APPLIED ON THE DELIVERABLE PATH — the defect the whole slice exists '
      + 'to make impossible: a fader that reaches the written file',
    aims: 'THE STEMS ARE THE MODEL’S, UNMODIFIED; the data-chunk byte identity',
    find: '          const bytes = encs[k].chunk(planes, len);',
    to: '          for (let q = 0; q < len; q++) { planes[0][q] *= 0.999; planes[1][q] *= 0.999; }\n'
      + '          const bytes = encs[k].chunk(planes, len);',
  },
  {
    id: 'M12',
    file: EXPORT,
    why: "the file's own header is no longer checked against EXPORT_FORMAT — the manifest row is believed",
    aims: 'a row that says 32 over bytes that are 16 is caught by READING THE FILE’S HEADER',
    find: '      if (r.sampleRate !== EXPORT_FORMAT.sampleRate || r.bitDepth !== EXPORT_FORMAT.bitDepth\n'
      + '        || r.float !== true || r.channels !== EXPORT_FORMAT.channels) {',
    to: '      if (false) {',
  },
  {
    id: 'M13',
    file: EXPORT,
    why: 'the frame count in the manifest is no longer checked against the file',
    aims: 'AN ENTRY THAT DISAGREES WITH ITSELF IS REFUSED',
    find: '      if (r.frames !== frames) {',
    to: '      if (false) {',
  },
  {
    id: 'M14',
    file: EXPORT,
    why: 'a refused exportSink is swallowed and the run carries on with an empty map',
    aims: 'A REFUSED `exportSink` IS AN ERROR, NOT A SILENT NO-OP',
    find: "      throw new ExportError('SINK_REFUSED', `nowhere to write: ${(e && e.message) || e}`);",
    to: '      sinks = {};',
  },
  {
    id: 'M15',
    file: EXPORT,
    why: 'a short sink map is accepted — five of six files, reported as done',
    aims: 'A SINK MAP THAT IS SHORT ONE STEM IS REFUSED',
    find: '    const missing = names.filter((n) => !sinks || !sinks[n] || typeof sinks[n].getWriter !== \'function\');',
    to: '    const missing = [];',
  },
  {
    id: 'M16',
    file: EXPORT,
    why: 'the requested format is silently ignored instead of refused',
    aims: 'A FORMAT OTHER THAN 32-BIT FLOAT IS REFUSED BY NAME',
    find: '      if (bd !== EXPORT_FORMAT.bitDepth || fl !== true) {',
    to: '      if (false) {',
  },
  {
    id: 'M17',
    file: EXPORT,
    why: 'the manifest row’s depth is no longer consulted, so a 16-bit live entry is exportable',
    aims: 'A 16-BIT ENTRY IS NOT A DELIVERABLE',
    find: '    if (entry.depth != null && entry.depth !== EXPORT_FORMAT.bitDepth) {',
    to: '    if (false) {',
  },
  {
    id: 'M18',
    file: EXPORT,
    why: 'a run can be started twice',
    aims: 'A RUN CANNOT BE STARTED TWICE',
    find: "    if (this.started) throw new ExportError('BUSY', 'this export has already run — build a new one');",
    to: '    if (false) { /* nothing */ }',
  },
  {
    id: 'M19',
    file: EXPORT,
    why: 'checkExportCode accepts every code, so the closed vocabulary is not closed',
    aims: 'AN UNKNOWN CODE IS REFUSED; the message names the whole legal set',
    find: '  if (EXPORT_CODES.has(code)) return null;',
    to: '  if (true) return null;',
  },
  {
    id: 'M20',
    file: WAV,
    why: 'the reader answers a DEFAULT format when open() has not run',
    aims: 'a reader that has read no header REPORTS NOTHING rather than a default',
    find: "    if (!this.fmt) throw new Error('wav window: open() has not run — this reader has read no header and knows no format');",
    to: "    if (!this.fmt) return { sampleRate: 44100, bitDepth: 32, float: true, numChannels: 2, blockAlign: 8, bytesPerSample: 4, format: 3 };",
  },
  {
    id: 'M21',
    file: WAV,
    why: 'the windowed reader slurps the WHOLE file and slices it in memory — every sample '
      + 'assertion still passes and the memory claim is gone',
    aims: 'THE BIGGEST SINGLE READ IS ONE WINDOW; the read COUNT scales while the read SIZE does not',
    find: '    const buf = await this.blob.slice(at, at + count * fmt.blockAlign).arrayBuffer();',
    to: '    const whole = await this.blob.slice(0, this.blob.size).arrayBuffer();\n'
      + '    const buf = whole.slice(at, at + count * fmt.blockAlign);',
  },
  {
    id: 'M22',
    file: WAV,
    why: 'the window is read one byte late — plausible audio from the wrong place',
    aims: 'a window in the MIDDLE of the file is the same samples decodeWav reads there; the bit-identity assertions',
    find: '    const at = this.dataOffset + from * fmt.blockAlign;',
    to: '    const at = this.dataOffset + from * fmt.blockAlign + 1;',
  },
  {
    id: 'M23',
    file: WAV,
    why: 'a read past the end comes back SHORT instead of being refused',
    aims: 'a read past the end is REFUSED, naming both counts',
    find: '    if (from + count > this.frames) {',
    to: '    if (false) {',
  },
  {
    id: 'M24',
    file: CACHE,
    why: 'stemFile ignores which stem it was asked for — the six-identical-stems fan-out',
    aims: 'THE STEMS ARE THE MODEL’S, UNMODIFIED (each file against its OWN source)',
    find: '    return (await d.getFileHandle(`${key}.${stem}.wav`)).getFile();',
    to: '    return (await d.getFileHandle(`${key}.${STEMS[0]}.wav`)).getFile();',
  },
  {
    id: 'M25',
    file: ENGINE,
    why: 'the engine stops checking the code it sends on EXPORT_ERROR',
    aims: '`offscreen/engine.js` CHECKS EVERY CODE IT SENDS',
    find: '  checkExportCode(code, `EXPORT_ERROR on deck ${deckId}`);',
    to: '  void deckId;',
  },
  {
    id: 'M26',
    file: EXPORT,
    why: 'the deliverable path imports the mixer, so a fader could reach it',
    aims: 'THE DELIVERABLE PATH IMPORTS NO MIXER, NO DECK AND NO WORKLET',
    find: "import { WavStreamEncoder } from '../shared/wav.js';",
    to: "import { WavStreamEncoder } from '../shared/wav.js';\nimport { dbToGain } from './mixer.js';\nvoid dbToGain;",
  },
  {
    id: 'M27',
    file: EXPORT,
    why: 'the Host is asked TWICE for the same deliverable — the correlation problem the '
      + 'all-six-at-once duty exists to remove',
    aims: 'the Host was asked ONCE, for all six destinations together',
    find: '      sinks = await this.exportSink({ title, files: names.slice() });',
    to: '      sinks = await this.exportSink({ title, files: names.slice() });\n'
      + '      await this.exportSink({ title, files: names.slice() });',
  },
  {
    id: 'M28',
    file: EXPORT,
    why: 'progress reports a 0-based file index into a 1..files range',
    aims: 'every tick names a file within the set it declares',
    find: "          this.#tick('write', k + 1, order.length, done / total, t0);",
    to: "          this.#tick('write', k, order.length, done / total, t0);",
  },
  {
    id: 'M29',
    file: EXPORT,
    why: 'a stem the six-stem contract has no name for is accepted',
    aims: 'A STEM THE SIX-STEM CONTRACT HAS NO NAME FOR IS REFUSED',
    find: '    const unknown = this.stems.filter((s) => !STEMS.includes(s));',
    to: '    const unknown = [];',
  },
  {
    id: 'M30',
    file: EXPORT,
    why: 'a key that names nothing is no longer refused up front',
    aims: 'A KEY THAT NAMES NOTHING IS REFUSED before a single file or destination is opened',
    find: "    if (!entry || typeof entry.key !== 'string') {",
    to: '    if (false) {',
  },
  {
    id: 'M31',
    file: EXPORT,
    why: 'a stem file that will not open is swallowed instead of named',
    aims: 'A STEM FILE THAT WILL NOT OPEN IS A NAMED REFUSAL',
    find: "        throw new ExportError('READ_FAILED', `${entry.key}: the ${stem} stem would not open — ${(e && e.message) || e}`);",
    to: '        r = null;',
  },
  {
    id: 'M32',
    file: CACHE,
    why: 'StemCache.get() stops reading whole files, so the contrast the memory numbers are '
      + 'measured against disappears',
    aims: 'while `StemCache.get()` takes each stem WHOLE, which is why the export does not call it',
    find: '        const w = decodeWav(await f.arrayBuffer());',
    to: '        const w = decodeWav(await f.slice(0, 66).arrayBuffer());',
  },
  {
    id: 'M33',
    file: EXPORT,
    why: 'checkExportCode cries wolf on every LEGAL code — the other direction of M19, and the '
      + 'question a "can it fail?" review never asks: can it PASS?',
    aims: 'EVERY MEMBER OF THE EXPORT VOCABULARY PASSES SILENTLY',
    find: '  if (EXPORT_CODES.has(code)) return null;',
    to: '  if (false) return null;',
  },
  {
    id: 'M34',
    file: EXPORT,
    why: 'the runner throws a code that is not in the declared set — the #29 failure exactly',
    aims: 'EVERY CODE THE RUNNER CAN THROW IS A DECLARED MEMBER',
    find: "    if (this.started) throw new ExportError('BUSY', 'this export has already run — build a new one');",
    to: "    if (this.started) throw new ExportError('ALREADY_RUN', 'this export has already run — build a new one');",
  },
  {
    id: 'M35',
    file: ENGINE,
    why: 'the engine stops wiring EXPORT_CANCEL, so the deck can start an export it cannot stop',
    aims: 'the engine really wires `EXPORT_START` and `EXPORT_CANCEL` to the runner',
    find: "      case 'EXPORT_CANCEL':",
    to: "      case 'EXPORT_ABORT':",
  },
  {
    id: 'M36',
    file: WAV,
    why: 'the reader reports a rate it did not read out of the file',
    aims: 'THE WINDOWED READER REPORTS THE FILE’S OWN FORMAT',
    find: '    this.fmt = fmt;',
    to: '    this.fmt = { ...fmt, sampleRate: 48000 };',
  },
  {
    id: 'M37',
    file: WAV,
    why: 'a wrong number of planes is accepted, so half a window is filled and the rest is stale',
    aims: 'a wrong number of planes is refused rather than filling half a window',
    find: '    if (into.length !== fmt.numChannels) {',
    to: '    if (false) {',
  },
  {
    id: 'M38',
    file: SUITE,
    why: "the header's group list loses `export`, so `node test.js export` would one day assert nothing and exit 0",
    aims: 'THE HEADER’S GROUP LIST IS THE GROUPS THIS FILE ACTUALLY HAS',
    find: " *   export   U11's E1: the six untouched model outputs out of the 32f tier into",
    to: " *   exp0rt   U11's E1: the six untouched model outputs out of the 32f tier into",
  },
];

// --------------------------------------------------------------------- run

const ANSI = /\x1b\[[0-9;]*m/g;

function runSuite() {
  let out;
  try {
    out = execFileSync(process.execPath, ['test.js', 'export'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = `${(e.stdout || '')}${e.stderr || ''}`;
  }
  const clean = out.replace(ANSI, '');
  const reds = clean.split('\n').filter((l) => /^ {2}FAIL /.test(l));
  const summary = clean.match(/^(\d+) passed, (\d+) failed$/m);
  return {
    reds: reds.length,
    first: reds.length ? reds[0].replace(/^ {2}FAIL /, '').slice(0, 92) : '',
    crashed: summary === null,
    passed: summary ? Number(summary[1]) : null,
    failed: summary ? Number(summary[2]) : null,
  };
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
    for (const m of chosen) console.log(`  ${m.id.padEnd(4)} ${m.file}\n       ${m.why}\n       -> aims at: ${m.aims}`);
    return 0;
  }

  const base = runSuite();
  console.log(`  baseline: ${base.passed} passed, ${base.failed} failed${base.crashed ? ' (NO SUMMARY — the suite crashed before the mutations began)' : ''}\n`);
  if (base.crashed || base.failed !== 0) {
    console.log('  \x1b[31mThe tree is not green before the mutations. Fix that first: every number below would be meaningless.\x1b[0m');
    return 2;
  }

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
    rows.push({ id: m.id, match: true, hits, reds: r.reds, crashed: r.crashed, first: r.first, aims: m.aims, file: rel });
    const verdict = r.crashed ? '\x1b[31mCRASH\x1b[0m' : r.reds > 0 ? '\x1b[32mRED  \x1b[0m' : '\x1b[31mGREEN\x1b[0m';
    console.log(`  ${verdict} ${m.id.padEnd(4)} ${String(r.reds).padStart(2)} red  ${m.why}`);
    if (r.reds) console.log(`             first: ${r.first}`);
    if (r.crashed) console.log('             the suite produced NO SUMMARY LINE — a mutation that kills the suite is not a watched red');
  }

  const decayed = rows.filter((r) => !r.match);
  const silent = rows.filter((r) => r.match && !r.crashed && r.reds === 0);
  const crashed = rows.filter((r) => r.crashed);
  const good = rows.filter((r) => r.match && !r.crashed && r.reds > 0);

  console.log(`\n  ${good.length} of ${rows.length} anchors MATCH and RED`);
  if (decayed.length) console.log(`  ${decayed.length} DECAYED (anchor no longer matches): ${decayed.map((r) => r.id).join(', ')}`);
  if (silent.length) console.log(`  ${silent.length} MATCH but produce NO RED — decay or real coverage loss, investigate: ${silent.map((r) => r.id).join(', ')}`);
  if (crashed.length) console.log(`  ${crashed.length} CRASHED the suite rather than reddening it: ${crashed.map((r) => r.id).join(', ')}`);

  // The tree must be exactly as it was found.
  const dirty = Object.keys(ANCHORED_AT.files).filter((rel) => !ANCHORED_AT.files[rel].startsWith('FILL_') && sha(rd(rel)) !== ANCHORED_AT.files[rel]);
  if (dirty.length) console.log(`\n  \x1b[31mLEFT MUTATED: ${dirty.join(', ')} — restore them by hand before doing anything else\x1b[0m`);

  return good.length === rows.length && !dirty.length ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
