#!/usr/bin/env node
/**
 * qa/mutations-u1-wavstream.mjs — U1's mutation battery, in the repository.
 *
 *   node qa/mutations-u1-wavstream.mjs             # every mutation
 *   node qa/mutations-u1-wavstream.mjs M13 M15     # only these
 *   node qa/mutations-u1-wavstream.mjs --list      # anchors only; mutates nothing
 *   node qa/mutations-u1-wavstream.mjs --self-check # prove the battery can say MUTE
 *   node qa/mutations-u1-wavstream.mjs --table     # emit the table for test.js's header
 *
 * WHY THIS FILE EXISTS. `test.js` group('wavstream') carries a mutation table in
 * its header naming, per mutation, the assertions it reddened. That table is a
 * CLAIM ABOUT A TREE, and the tree moves. An anchor patches a specific span of
 * source, and when a later slice rewrites that span the mutation stops applying
 * — SILENTLY, because a search that matches nothing looks exactly like a search
 * that matched and passed. A Phase 4 sweep found two upstream batteries that had
 * decayed exactly that way, ten dead anchors reading as a 44/51 score rather
 * than as ten instruments that had stopped pointing at anything. U1's battery
 * could not be swept at all: it existed only in an agent transcript. This is
 * that battery, checked back in, so the numbers can be re-established by anyone.
 *
 * IT REPORTS TWO THINGS SEPARATELY, PER MUTATION, because they need opposite
 * responses:
 *   - does the ANCHOR still match the source?  A miss is a DECAYED INSTRUMENT.
 *     Re-cut it; the assertion may be perfectly healthy.
 *   - does the mutation still RED what it claims?  A matching anchor that no
 *     longer reddens is either a decayed instrument OR A REAL COVERAGE LOSS,
 *     and those are told apart by reading, not by a score.
 * A battery that collapses both into one pass count is how ten dead anchors
 * come to look like seven weak assertions.
 *
 * THE CONTROL RUNS FIRST, AND IT IS NOT DECORATION. Every verdict below is
 * "these assertions went red". If the suite were already red — a broken fixture,
 * a missing import, a sibling slice mid-landing — every mutation would report
 * RED without having caused anything, and the battery would print a perfect
 * score while measuring nothing. So the unmutated suite is run first and must be
 * FULLY GREEN, and each mutation's red set is compared EXACTLY: an assertion
 * that reddens but is not claimed is reported as loudly as one that is claimed
 * and stays green.
 *
 * `--self-check` closes the other half. It applies a mutation that changes only
 * a comment and requires the battery to report MUTE. A battery that cannot
 * produce a MUTE cannot distinguish a live assertion from a dead one.
 *
 * IT DRIVES THE SUITE THE ASSERTIONS ACTUALLY LIVE IN. `wavstream` is a group in
 * the root `test.js`, which verify.mjs runs as step `unit`. A battery re-run
 * through the wrong runner reports a clean green and means nothing.
 *
 * IT IS DELIBERATELY NOT A verify.mjs STEP. It edits tracked source. A gate that
 * writes the tree it is gating is a gate that can leave the tree written, and
 * `tools/verify.mjs`'s "WHAT IS STILL NOT GATED, AND WHY" note carries the
 * entry saying so. Every file is restored in a `finally` and the restoration is
 * verified by hash before the process exits.
 *
 * EVERY ANCHOR IS STAMPED WITH THE LANDED COMMIT IT WAS CUT AGAINST (`cut`), so
 * decay is checkable by anyone rather than something someone has to notice. The
 * stamp names a commit that is IN HISTORY: a stamp pointing at a branch tip that
 * was rebased away is the exact failure the stamp exists to prevent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'extension/shared/wav.js';

/**
 * M1-M12 were cut against 1040de1 — the commit that added WavStreamEncoder,
 * WavSyncWriter and group('wavstream'). M13-M15 were cut against 0fb693a, the
 * review follow-up that added the three sync/no-clip assertions. Both are on
 * main. The `file:line` in test.js's table was written pre-0fb693a for M1-M12
 * and is therefore ELEVEN LINES SHORT for those twelve — 0fb693a inserted an
 * eleven-line paragraph at the top of wav.js. That is a stale coordinate, not a
 * decayed anchor: all fifteen anchors are text, and all fifteen still match.
 * `--table` prints the coordinates as they are NOW.
 */
const CUT_A = '1040de1';   // feat(wav): write a WAV a chunk at a time, without holding the file
const CUT_B = '0fb693a';   // test(wav): assert the sync writer at the depth the cache actually writes

/**
 * The most recent revision at which the WHOLE battery was confirmed valid —
 * every anchor matching AND every mutation reddening exactly what it claims.
 * Move this only after a run. A stamp advanced by hand makes decay look checked.
 */
const CONFIRMED = '5993d32';

/** The eighteen assertions in group('wavstream'), by the prefix each is matched on. */
const A = {
  id32f:      '32f: the streamed file is byte-identical to encodeWav',
  noclip:     '32f: the STREAMED bytes preserve out-of-range samples',
  id16:       '16-bit PCM: the streamed file is byte-identical to encodeWav',
  id24pad:    '24-bit mono, odd frame count: byte-identical INCLUDING the RIFF pad byte',
  headerfinal:'the header is complete and FINAL on the first chunk',
  bytelength: 'the finished byte length is known before any audio is written',
  longwrite:  'a LONG write is refused, naming both counts',
  shortwrite: 'a SHORT write is refused at end(), naming both counts',
  ceiling:    'the 4 GiB RIFF ceiling is refused at construction',
  pipe:       'pipeTo drives a real WritableStream to the same bytes',
  pipeabort:  'pipeTo ABORTS the sink on a short source rather than closing it',
  sync32f:    'WavSyncWriter patches the three lengths at close',
  sync16:     'WavSyncWriter at 16-bit',
  syncpad:    'WavSyncWriter pads an ODD payload at close',
  syncceil:   'WavSyncWriter refuses the 4 GiB ceiling BEFORE it writes a byte',
  defaults:   'with NO options both writers resolve the same format',
  dither:     'the 16-bit dither default is resolved the same way',
  planes:     'passing the planes where the channel COUNT goes is a named refusal',
};

/**
 * `expect` is the EXACT set of assertions the mutation must redden. Not a subset
 * — an unclaimed red is reported too, because a mutation that reddens more than
 * its table entry says means the table is wrong about what the assertion covers.
 */
const MUTATIONS = [
  {
    id: 'M1', cut: CUT_A,
    what: 'chunk() interleaves the channels in reverse order',
    find: 'writeFrames(new DataView(out.buffer), 0, this.fmt, channels, len);\n    this.written += len;',
    with: 'writeFrames(new DataView(out.buffer), 0, this.fmt, channels.slice().reverse(), len);\n    this.written += len;',
    expect: [A.id32f, A.noclip, A.id16, A.pipe],
    note: 'Sizing the chunk buffer by bytesPerSample instead of blockAlign is also red, '
      + 'but as a DataView overflow that ends the run before the assertion reports.',
  },
  {
    id: 'M2', cut: CUT_A,
    what: 'header() declares the frames written SO FAR instead of the frames promised',
    find: 'header() { return wavHeader(this.fmt, this.frames); }',
    with: 'header() { return wavHeader(this.fmt, this.written); }',
    expect: [A.id32f, A.noclip, A.id16, A.id24pad, A.headerfinal, A.pipe, A.defaults],
  },
  {
    id: 'M3', cut: CUT_A,
    what: 'end() stops refusing a short write',
    find: 'if (this.written !== this.frames) {\n      throw new RangeError(`wav stream: ${this.written} of ${this.frames} frames written — `',
    with: 'if (false) {\n      throw new RangeError(`wav stream: ${this.written} of ${this.frames} frames written — `',
    expect: [A.shortwrite, A.pipeabort],
  },
  {
    id: 'M4', cut: CUT_A,
    what: 'chunk() stops refusing a long write',
    find: 'if (this.written + len > this.frames) {',
    with: 'if (false) {',
    expect: [A.longwrite],
  },
  {
    id: 'M5', cut: CUT_A,
    what: 'end() never emits the RIFF pad byte',
    find: 'return (this.dataSize & 1) ? new Uint8Array(1) : NO_BYTES;',
    with: 'return NO_BYTES;',
    expect: [A.id24pad],
  },
  {
    id: 'M6', cut: CUT_A,
    what: 'the constructor computes the finished length without the 4 GiB refusal',
    find: 'this.byteLength = 8 + riffSizeFor(this.fmt, this.dataSize);',
    with: 'this.byteLength = 8 + (this.fmt.headerSize - 8) + this.dataSize + (this.dataSize & 1);',
    expect: [A.ceiling],
  },
  {
    id: 'M7', cut: CUT_A,
    what: 'WavSyncWriter.close never patches the data-chunk size',
    find: '    this.handle.write(u32(dataSize), { at: dataSizeAt(this.fmt) });\n',
    with: '',
    expect: [A.sync32f, A.sync16, A.syncpad],
  },
  {
    id: 'M8', cut: CUT_A,
    what: 'WavSyncWriter.append checks the 4 GiB ceiling AFTER it writes instead of before',
    find: '    riffSizeFor(this.fmt, (this.frames + len) * this.fmt.blockAlign);\n    if (channels.length !== this.fmt.numChannels) {',
    with: '    if (channels.length !== this.fmt.numChannels) {',
    expect: [A.syncceil],
  },
  {
    id: 'M9', cut: CUT_A,
    what: 'the 16-bit dither default is dropped',
    find: 'const dither = opts.dither ?? (bitDepth === 16 && !isFloat);',
    with: 'const dither = opts.dither ?? false;',
    expect: [A.dither],
  },
  {
    id: 'M10', cut: CUT_A,
    what: 'the constructor stops refusing planes where the channel COUNT goes',
    find: '    if (!Number.isInteger(numChannels) || numChannels < 1) {\n      const got',
    with: '    if (false) {\n      const got',
    expect: [A.planes],
  },
  {
    id: 'M11', cut: CUT_A,
    what: 'byteLength forgets the header bytes (the ceiling still refused)',
    find: 'this.byteLength = 8 + riffSizeFor(this.fmt, this.dataSize);',
    with: 'riffSizeFor(this.fmt, this.dataSize); this.byteLength = 8 + this.dataSize;',
    expect: [A.bytelength],
  },
  {
    id: 'M12', cut: CUT_A,
    what: 'pipeTo closes the sink on a refusal instead of aborting it',
    find: 'await w.abort(err).catch(() => {});',
    with: 'await w.close().catch(() => {});',
    expect: [A.pipeabort],
  },
  {
    id: 'M13', cut: CUT_B,
    what: "dataSizeAt is wrong for PCM ONLY, float untouched — the review's own mutation",
    find: 'const dataSizeAt = (fmt) => fmt.headerSize - 4;',
    with: 'const dataSizeAt = (fmt) => fmt.headerSize - 4 + (fmt.factSize ? 0 : 2);',
    expect: [A.sync16, A.syncpad],
    note: 'Before the 16-bit and odd-payload assertions existed this left the whole group '
      + 'GREEN while every 16-bit and 24-bit cache file carried a data-chunk size of zero. '
      + 'It is reproduced here because it is the mutation this suite used to survive.',
  },
  {
    id: 'M14', cut: CUT_B,
    what: 'close() never writes the pad byte for an odd payload',
    find: '    if (dataSize & 1) { this.handle.write(new Uint8Array(1), { at: this.at }); this.at += 1; }\n',
    with: '',
    expect: [A.syncpad],
  },
  {
    id: 'M15', cut: CUT_B,
    what: 'the float path clamps to ±1.0 the way every fixed-point path does',
    find: 'for (let c = 0; c < numChannels; c++) { dv.setFloat32(p, channels[c][i], true); p += 4; }',
    with: 'for (let c = 0; c < numChannels; c++) { dv.setFloat32(p, Math.max(-1, Math.min(1, channels[c][i])), true); p += 4; }',
    expect: [A.noclip],
    note: "Also reds two assertions in group('window') — the transitive coverage the shared "
      + "writeFrames loop buys, observed rather than assumed: node test.js window.",
  },
];

/**
 * The self-check's mutation. It edits a COMMENT and nothing else, so the suite
 * must stay green and the battery must report MUTE. Its `expect` is deliberately
 * a real assertion: if the battery reported RED for this, every RED above would
 * be worthless.
 */
const INERT = {
  id: 'NULL', cut: CONFIRMED,
  what: 'a comment is edited and nothing else — the suite MUST stay green',
  find: '// wav.js — RIFF/WAVE writer + minimal reader.',
  with: '// wav.js (self-check: this comment was edited) — RIFF/WAVE writer + minimal reader.',
  expect: [A.id32f],
};

// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const selfCheck = argv.includes('--self-check');
const tableOnly = argv.includes('--table');
const only = argv.filter((a) => !a.startsWith('--'));
const chosen = selfCheck ? [INERT] : (only.length ? MUTATIONS.filter((m) => only.includes(m.id)) : MUTATIONS);

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const read = () => readFileSync(join(ROOT, SRC), 'utf8');
const write = (s) => writeFileSync(join(ROOT, SRC), s);

function head() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return '(no git)'; }
}

/** 1-based line of the anchor's first character, for the table's `file:line`. */
const lineOf = (src, find) => src.slice(0, src.indexOf(find)).split('\n').length;

/**
 * Run group('wavstream') and return which named assertions FAILED.
 * A crash is NOT a red: it is a run that reported nothing, and treating it as
 * evidence is how a mutation that takes the suite down gets scored as coverage.
 */
function runSuite() {
  let out = '', code = 0;
  try {
    out = execFileSync('node', ['test.js', 'wavstream'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    code = e.status ?? 1;
  }
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
  const summary = (clean.match(/^\d+ passed, \d+ failed$/m) || [null])[0];
  const fails = clean.split('\n').filter((l) => l.trim().startsWith('FAIL'))
    .map((l) => l.trim().slice(5).split('  [')[0].trim());
  const passed = summary ? Number(summary.split(' ')[0]) : -1;
  return {
    crashed: summary === null,
    fails, passed, code,
    summary: summary || 'NO SUMMARY LINE — the run ended without reporting: '
      + clean.trim().split('\n').filter(Boolean).slice(-2).join(' | '),
  };
}

const HEAD = head();

if (tableOnly) {
  const src = read();
  for (const m of MUTATIONS) {
    const hits = src.split(m.find).length - 1;
    console.log(` *   ${m.id.padEnd(3)} wav.js:${hits === 1 ? lineOf(src, m.find) : '??? ANCHOR DECAYED'}  ${m.what}`);
    console.log(` *                   -> ${m.expect.length} red: ${m.expect.join('; ')}`);
  }
  process.exit(0);
}

console.log(`\n${C.b}U1 mutation battery — group('wavstream') in test.js${C.x}`);
console.log(`  subject           ${SRC}`);
console.log(`  anchors cut at    ${CUT_A} (M1-M12), ${CUT_B} (M13-M15)   ${C.d}both landed on main${C.x}`);
console.log(`  last confirmed    ${CONFIRMED}${HEAD === CONFIRMED ? '' : `   ${C.y}<- the tree has moved since; decay is possible${C.x}`}`);
console.log(`  running against   ${HEAD}`);
console.log(`  driving           node test.js wavstream   ${C.d}(verify.mjs step: unit)${C.x}\n`);

const before = read();
const beforeHash = sha(before);
let applied = 0, decayed = 0, bit = 0, mute = 0, controlOk = false, refused = false;

try {
  // ---- THE CONTROL. Every verdict below is "this went red"; that claim is
  // worthless unless the unmutated suite is green first.
  if (!listOnly) {
    const c = runSuite();
    controlOk = !c.crashed && c.fails.length === 0 && c.code === 0;
    console.log(`  ${controlOk ? `${C.g}CONTROL${C.x}` : `${C.r}CONTROL${C.x}`} unmutated: ${c.summary}`);
    if (!controlOk) {
      for (const f of c.fails) console.log(`          already red: ${f}`);
      console.log(`\n  ${C.r}REFUSING TO SCORE${C.x} — the suite is not green before any mutation, so every`);
      console.log(`  RED below would be a red this battery did not cause. Fix the tree first.\n`);
      process.exitCode = 2;
      refused = true;
    } else {
      console.log('');
    }
  }

  for (const m of refused ? [] : chosen) {
    const hits = before.split(m.find).length - 1;
    if (hits !== 1) {
      decayed++;
      const state = hits === 0 ? 'DECAYED  ' : 'AMBIGUOUS';
      console.log(`  ${C.r}${state}${C.x} ${m.id.padEnd(4)} ${m.what}`);
      console.log(`            anchor cut at ${m.cut} matched ${hits} times in ${SRC} — RE-CUT IT against ${HEAD}`);
      continue;
    }
    applied++;
    const at = lineOf(before, m.find);
    if (listOnly) {
      console.log(`  ${C.g}APPLIES ${C.x} ${m.id.padEnd(4)} ${SRC.split('/').pop()}:${at}  ${m.what}`);
      continue;
    }

    const mutated = before.replace(m.find, m.with);
    if (mutated === before) {
      mute++;
      console.log(`  ${C.r}INERT   ${C.x} ${m.id.padEnd(4)} ${m.what}`);
      console.log(`            the replacement is byte-identical to the anchor — this mutation changes nothing`);
      continue;
    }
    write(mutated);
    const r = runSuite();
    write(before);

    const missing = m.expect.filter((e) => !r.fails.some((f) => f.startsWith(e)));
    const unexpected = r.fails.filter((f) => !m.expect.some((e) => f.startsWith(e)));
    const ok = !r.crashed && missing.length === 0 && unexpected.length === 0 && r.fails.length > 0;
    if (ok) bit++; else mute++;
    console.log(`  ${ok ? `${C.g}RED     ${C.x}` : `${C.r}MUTE    ${C.x}`} ${m.id.padEnd(4)} ${SRC.split('/').pop()}:${at}  ${m.what}`);
    console.log(`            ${r.summary}`);
    for (const f of r.fails) console.log(`            ${C.d}red:${C.x} ${f}`);
    if (missing.length) console.log(`            ${C.r}CLAIMED BUT STAYED GREEN:${C.x} ${missing.join(' | ')}`);
    if (unexpected.length) console.log(`            ${C.r}RED BUT NOT CLAIMED:${C.x} ${unexpected.join(' | ')}`);
    if (!r.crashed && r.fails.length === 0) console.log(`            ${C.r}NOTHING WENT RED${C.x} — the assertion this claims to cover is not watching this line`);
  }
} finally {
  // Put it back, and PROVE it went back rather than assuming the write landed.
  write(before);
  if (sha(read()) !== beforeHash) {
    console.log(`\n${C.r}FAILED TO RESTORE ${SRC}${C.x} — check git status before doing anything else\n`);
    process.exitCode = 2;
  }
}

if (refused) {
  // The refusal already said everything; a summary line here would look like a score.
} else if (listOnly) {
  console.log(`\n  ${applied} of ${chosen.length} anchors apply, ${decayed} decayed. Nothing was mutated.\n`);
  process.exitCode = decayed ? 1 : 0;
} else if (selfCheck) {
  const pass = mute === 1 && bit === 0 && decayed === 0 && controlOk;
  console.log(`\n  ${pass ? `${C.g}SELF-CHECK PASSED${C.x}` : `${C.r}SELF-CHECK FAILED${C.x}`} — an inert edit was scored `
    + `${bit ? 'RED' : 'MUTE'}, and the battery ${pass ? 'can therefore say MUTE' : 'CANNOT DISTINGUISH a live assertion from a dead one'}\n`);
  process.exitCode = pass ? 0 : 1;
} else {
  console.log(`\n  ${applied} of ${chosen.length} anchors applied, ${decayed} decayed, ${bit} bit, ${mute} did not bite`);
  if (decayed === 0 && mute === 0 && controlOk) {
    console.log(`  ${C.g}BATTERY VALID against ${HEAD}${C.x} — every anchor matches and every mutation reddens EXACTLY what it claims\n`);
  } else {
    console.log(`  ${C.r}BATTERY NOT VALID against ${HEAD}${C.x} — re-cut the anchors above and correct the table in test.js\n`);
    process.exitCode = 1;
  }
}
