/**
 * THE MIDI PACK GATE — the acceptance gate for ADR 0002 / the owner's ruling R2.
 *
 *     node qa/midi-pack.mjs
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS.
 *
 * This product hands the user exactly one kind of file, permanently: a pack of
 * MIDI transcriptions. Ruling R2 says that is enforced by a gate that can FAIL,
 * in three parts, and all three are below:
 *
 *   1. ONE declared delivery module, whose allowlist is exactly
 *      `{application/zip, audio/midi}` — `extension/shared/midi.js`.
 *   2. A suite that builds a REAL pack and asserts every zip entry begins
 *      `MThd` — §"THE PACK" below.
 *   3. A CONTROL THAT CAN LOSE: the same suite builds a pack containing a WAV
 *      and asserts the guard REJECTS it — §"THE CONTROL THAT MUST LOSE".
 *
 * The WAV in part 3 is a real one from `extension/shared/wav.js::encodeWav`,
 * this repo's own writer, so the control is a genuine file of the wrong kind
 * rather than an invented blob that might be refused for the wrong reason.
 *
 * ---------------------------------------------------------------------------
 * THE BLIND SPOT, STATED HONESTLY, BECAUSE A GATE THAT OVERSELLS ITSELF IS
 * WORSE THAN NO GATE.
 *
 * Everything here is a check on BYTES AT ONE CALL SITE, plus one static read of
 * `ui/host.js`. A reference assembled at runtime — a name built by
 * concatenation, a MIME read out of a variable, a second transport added
 * somewhere this file never looks — defeats a static scan completely, and no
 * amount of grepping fixes that.
 *
 * THAT IS EXACTLY WHY THE `downloads` PERMISSION STAYS ABSENT. The platform
 * withholds what the grep cannot: with no permission there is no
 * `chrome.downloads` to reach for however the reference is spelled, and
 * `tools/tree-check.mjs` asserts the absence. This suite is the SECOND line.
 * The first line is a capability the browser never granted.
 *
 * It follows that a green run here means "the bytes this call site produced are
 * a MIDI pack", never "nothing else can ever leave". Do not quote it as the
 * latter.
 *
 * ---------------------------------------------------------------------------
 * IT CARRIES ITS OWN SMF PARSER, AND THAT IS THE POINT.
 *
 * A writer checked by its own reader checks that the two AGREE, not that the
 * bytes are a Standard MIDI File — the two halves of a codec share their
 * misunderstandings. So `parseSMF` below is written from the format, not from
 * `shared/midi.js`, and it is deliberately STRICT: no running status, no
 * sysex, no meta type this build does not emit, no trailing bytes, no track
 * without an end-of-track, and no note left sounding when a track ends. Each of
 * those refusals is what lets the negative controls go red — a round trip that
 * cannot fail is not measuring anything.
 *
 * The zip half is checked the same way, one level down: `zipEntries` reads the
 * archive back, and the assertions under §"THE ZIP" additionally read the
 * SIGNATURES, THE FLAG WORD AND THE METHOD FIELD BY OFFSET, so an agreement
 * between `zipStore` and `zipEntries` about a wrong byte order still goes red.
 * `unzip -l` compatibility is asserted by structure; shelling out would be a
 * tool this repo does not depend on and a test CI could not run.
 *
 * NOTHING HERE READS A CLOCK. Every claim is a count, a byte or a tick.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { crc32, zipStore, zipEntries } from '../extension/shared/zip.js';
import {
  MIDI_PPQ, MIDI_TEMPO_FALLBACK_BPM, MIDI_TIME_SIG, PACK_ORDER, PACK_ENTRIES,
  MIDI_CHANNEL, MIDI_PROGRAM, DELIVERABLE,
  vlq, writeSMF, packEntries, packName, assertDeliverable, MidiTake,
} from '../extension/shared/midi.js';
import { STEMS } from '../extension/shared/config.js';
import { DECK_HOST_DUTIES } from '../extension/shared/host.js';
import { encodeWav } from '../extension/shared/wav.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0, passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? '\n         ' + detail : ''}`);
};
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const hex = (v) => v.toString(16).padStart(2, '0');
const bytes = (s) => new TextEncoder().encode(s);
const first4 = (b) => Array.from(b.subarray(0, 4), hex).join(' ');
/** Did this throw, and with what? `{ threw: boolean, message: string }`. */
const attempt = (fn) => { try { fn(); return { threw: false, message: '' }; } catch (e) { return { threw: true, message: e.message }; } };

/**
 * Run a reader and, if it throws, hand back an EMPTY result plus the message.
 *
 * This is not an excuse. A reader that cannot get through means every assertion
 * over what it read compares against nothing and goes RED, carrying the throw's
 * own message — which is strictly more useful than the suite dying on line one
 * with a stack trace and no assertion count at all. Measured: with `zip.js`'s
 * `u16` flipped to big-endian, the unguarded version printed a stack trace and
 * zero assertions; the guarded one prints the local-file-header signature it
 * actually found.
 */
let lastReadError = '';
const safe = (fn, empty) => { try { return fn(); } catch (e) { lastReadError = e.message; return empty; } };

/** A track-shaped nothing, so an assertion over a file that would not parse goes red instead of throwing. */
const NO_TRACK = { name: null, tempo: null, timeSig: [0, 0, 0, 0], programs: [], notes: [], ons: 0, offs: 0, endTick: -1 };
const trk = (f, i) => (f && f.tracks && f.tracks[i]) || NO_TRACK;
const NO_FILE = { format: -1, ntrks: -1, division: -1, tracks: [] };
/** `test.js:4675`'s comment stripper, verbatim, so this file reads source the way the unit suite does. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ===========================================================================
// The suite's OWN Standard MIDI File parser. Written from the format.
// ===========================================================================

/**
 * @param {Uint8Array} b
 * @param {string} label  what to call this file in a refusal
 * @returns {{format, ntrks, division, tracks}}
 * @throws {Error} on anything it does not recognise — see the header.
 */
function parseSMF(b, label = 'file') {
  const bad = (m) => { throw new Error(`${label}: ${m}`); };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

  if (b.length < 14) bad(`${b.length} bytes is shorter than a header chunk`);
  if (tag(0) !== 'MThd') bad(`does not begin MThd (${first4(b)})`);
  const hlen = dv.getUint32(4);
  if (hlen !== 6) bad(`header chunk length is ${hlen}, and MThd is 6 by definition`);
  const format = dv.getUint16(8);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (format !== 0 && format !== 1) bad(`format ${format}`);
  if (format === 0 && ntrks !== 1) bad(`format 0 with ${ntrks} tracks`);
  if (division & 0x8000) bad('SMPTE division — this build writes ticks per quarter note');

  const tracks = [];
  let p = 14;
  for (let i = 0; i < ntrks; i++) {
    if (p + 8 > b.length) bad(`track ${i}'s chunk header runs past the end of the file`);
    if (tag(p) !== 'MTrk') bad(`track ${i} does not begin MTrk`);
    const len = dv.getUint32(p + 4);
    if (p + 8 + len > b.length) bad(`track ${i} claims ${len} bytes and only ${b.length - p - 8} are left`);
    tracks.push(parseTrack(b, p + 8, p + 8 + len, i, bad));
    p += 8 + len;
  }
  if (p !== b.length) bad(`${b.length - p} bytes after the last track`);
  return { format, ntrks, division, tracks };
}

function parseTrack(b, start, end, idx, bad) {
  const t = { name: null, tempo: null, timeSig: null, programs: [], notes: [], ons: 0, offs: 0, endTick: 0 };
  const open = new Map();               // channel * 128 + pitch -> the note that is sounding
  let p = start, tick = 0, done = false;

  while (p < end) {
    if (done) bad(`track ${idx} carries ${end - p} bytes after its end-of-track`);
    let v = 0, k = 0;
    for (;;) {
      if (p >= end) bad(`track ${idx} ends inside a delta time`);
      const c = b[p++];
      v = (v * 128) + (c & 0x7f);
      if (!(c & 0x80)) break;
      if (++k > 3) bad(`track ${idx} has a delta time longer than the four bytes the format allows`);
    }
    tick += v;
    if (p >= end) bad(`track ${idx} ends after a delta time with no event`);

    const st = b[p++];
    if (st < 0x80) {
      bad(`track ${idx} at tick ${tick}: 0x${hex(st)} where a status byte belongs — this build emits no running status`);
    }
    if (st === 0xf0 || st === 0xf7) bad(`track ${idx} at tick ${tick}: a sysex event, which this build never writes`);

    if (st === 0xff) {
      if (p >= end) bad(`track ${idx} ends inside a meta event`);
      const type = b[p++];
      let len = 0, kk = 0;
      for (;;) {
        if (p >= end) bad(`track ${idx} ends inside a meta length`);
        const c = b[p++];
        len = (len * 128) + (c & 0x7f);
        if (!(c & 0x80)) break;
        if (++kk > 3) bad(`track ${idx}: meta length longer than four bytes`);
      }
      if (p + len > end) bad(`track ${idx}: meta 0x${hex(type)} claims ${len} bytes and the track ends`);
      const d = b.subarray(p, p + len);
      p += len;
      if (type === 0x03) t.name = new TextDecoder().decode(d);
      else if (type === 0x51) {
        if (len !== 3) bad(`track ${idx}: set-tempo is ${len} bytes, not 3`);
        if (t.tempo !== null) bad(`track ${idx}: a second set-tempo at tick ${tick} — one tempo, at tick 0`);
        if (tick !== 0) bad(`track ${idx}: set-tempo at tick ${tick}, not 0`);
        t.tempo = (d[0] << 16) | (d[1] << 8) | d[2];
      } else if (type === 0x58) {
        if (len !== 4) bad(`track ${idx}: time-signature is ${len} bytes, not 4`);
        t.timeSig = [d[0], 1 << d[1], d[2], d[3]];
      } else if (type === 0x2f) {
        if (len !== 0) bad(`track ${idx}: end-of-track carries ${len} bytes`);
        done = true;
        t.endTick = tick;
      } else {
        bad(`track ${idx}: meta type 0x${hex(type)}, which this build never writes`);
      }
      continue;
    }

    const kind = st & 0xf0, ch = st & 0x0f;
    const n = (kind === 0xc0 || kind === 0xd0) ? 1 : 2;
    if (p + n > end) bad(`track ${idx} ends inside a 0x${hex(st)} event`);
    const d1 = b[p++];
    const d2 = n === 2 ? b[p++] : 0;
    if (d1 > 0x7f || d2 > 0x7f) bad(`track ${idx} at tick ${tick}: a 0x${hex(st)} data byte has its high bit set`);

    if (kind === 0x90 && d2 > 0) {
      const key = ch * 128 + d1;
      if (open.has(key)) bad(`track ${idx} at tick ${tick}: a second note-on for pitch ${d1} on channel ${ch} while it is still sounding`);
      open.set(key, { pitch: d1, vel: d2, channel: ch, onTick: tick, offTick: -1 });
      t.ons++;
    } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
      const key = ch * 128 + d1;
      const note = open.get(key);
      if (!note) bad(`track ${idx} at tick ${tick}: note-off for pitch ${d1} on channel ${ch} with nothing sounding`);
      open.delete(key);
      note.offTick = tick;
      t.notes.push(note);
      t.offs++;
    } else if (kind === 0xc0) {
      t.programs.push({ tick, channel: ch, program: d1 });
    } else {
      bad(`track ${idx} at tick ${tick}: status 0x${hex(st)}, which this build never writes`);
    }
  }
  if (!done) bad(`track ${idx} has no end-of-track`);
  if (open.size) bad(`track ${idx} ends with ${open.size} note(s) still sounding`);
  t.notes.sort((a, c) => a.onTick - c.onTick || a.pitch - c.pitch);
  return t;
}

/** Read a variable-length quantity back. The other half of the `vlq` spec vectors. */
function readVLQ(b, at = 0) {
  let v = 0, p = at;
  for (let k = 0; k < 4; k++) {
    const c = b[p++];
    if (c === undefined) throw new Error('readVLQ: ran off the end');
    v = (v * 128) + (c & 0x7f);
    if (!(c & 0x80)) return { value: v, length: p - at };
  }
  throw new Error('readVLQ: five continuation bytes');
}

// ===========================================================================
head('CRC-32 — the known answer, because a table can be wrong in a way both halves share');
// ===========================================================================

/**
 * `0xCBF43926` over "123456789" is the check value every CRC-32 catalogue
 * publishes. It is here because the zip round trip below CANNOT catch a wrong
 * table: a writer and a reader sharing one bad polynomial agree perfectly.
 * MAKE IT GO RED: change the polynomial in `zip.js` from 0xEDB88320 to
 * 0x04C11DB7 (the unreflected form). The round trip stays green; this line does
 * not.
 */
const KAT = crc32(bytes('123456789'));
ok('crc32("123456789") === 0xCBF43926', KAT === 0xcbf43926,
  `got 0x${KAT.toString(16).toUpperCase()} — the published check value for IEEE 802.3 CRC-32`);
ok('crc32 of nothing is 0', crc32(new Uint8Array(0)) === 0);
const KAT0 = crc32(new Uint8Array([0]));
ok('crc32 of one zero byte === 0xD202EF8D', KAT0 === 0xd202ef8d,
  `got 0x${KAT0.toString(16).toUpperCase()} — a second published vector, so the answer above is not one lucky string`);
ok('crc32 returns an unsigned 32-bit number, never a negative int32',
  crc32(bytes('123456789')) >= 0 && crc32(bytes('The quick brown fox')) >= 0);

// ===========================================================================
head('VLQ — all four widths, and both sides of all three boundaries');
// ===========================================================================

/**
 * The Standard MIDI File spec's own table. A variable-length quantity carries
 * seven bits per byte with the high bit set on every byte but the last, so the
 * widths change at 0x80, 0x4000 and 0x200000 — and an encoder that gets a
 * boundary wrong is off by one byte for a whole class of delta times, which
 * shifts every event after it. Both sides of each boundary are here for that
 * reason; one side alone cannot tell a `<` from a `<=`.
 *
 * MAKE IT GO RED: change `n < 0x80` to `n <= 0x80` in `vlq()` — the 128 row
 * turns into a one-byte 0x00 and this table names it.
 */
const VLQ_VECTORS = [
  [0, '00'], [0x40, '40'], [127, '7f'],
  [128, '81 00'], [0x2000, 'c0 00'], [16383, 'ff 7f'],
  [16384, '81 80 00'], [0x100000, 'c0 80 00'], [2097151, 'ff ff 7f'],
  [2097152, '81 80 80 00'], [0x08000000, 'c0 80 80 00'], [268435455, 'ff ff ff 7f'],
];
for (const [n, want] of VLQ_VECTORS) {
  const got = Array.from(vlq(n), hex).join(' ');
  const back = safe(() => readVLQ(vlq(n)), null);
  ok(`vlq(${n}) === ${want} (${want.split(' ').length} byte${want.length > 2 ? 's' : ''}), and reads back`,
    got === want && back !== null && back.value === n && back.length === want.split(' ').length,
    back === null ? `wrote ${got}, and reading it back failed: ${lastReadError}`
      : `wrote ${got}, read back ${back.value} from ${back.length} byte(s)`);
}
ok('vlq refuses what the format cannot express',
  attempt(() => vlq(-1)).threw && attempt(() => vlq(0x10000000)).threw && attempt(() => vlq(1.5)).threw,
  '-1, 2^28 and 1.5 all throw — a silent truncation here would move every event after it');

// ===========================================================================
head('THE SMF ROUND TRIP — a note list written, parsed back, and balanced');
// ===========================================================================

/**
 * EVERY TICK IN THIS FIXTURE IS WRITTEN OUT BY HAND, not recomputed from the
 * writer's formula. At 120 BPM and 480 PPQ the grid is 960 ticks per second, so
 * `onTick` below is `onSec * 960` done on paper. An expectation computed with
 * the same expression the writer uses is a second copy of the writer, and it
 * passes whatever the writer does.
 *
 * The last two rows are the two cases that are easy to get wrong:
 *   - pitch 21 lasts 0.5 ms, which rounds to ZERO ticks, and the writer's
 *     `offTick = max(offTick, onTick + 1)` rule makes it 2641.
 *   - pitch 108 sits between ticks both ends and must ROUND, not truncate.
 * And the pair at tick 960 is the retrigger rule: pitch 60 goes off at 960 and
 * on again at 960, so the note-off must be written FIRST. If it is not, the
 * parser refuses the file — "a second note-on while it is still sounding".
 */
const KNOWN_BPM = 120;                   // 480 * 120 / 60 = 960 ticks per second
const KNOWN = [
  { pitch: 60, vel: 100, onSec: 0.0, offSec: 0.5, onTick: 0, offTick: 480 },
  { pitch: 64, vel: 90, onSec: 0.5, offSec: 1.0, onTick: 480, offTick: 960 },
  { pitch: 60, vel: 80, onSec: 1.0, offSec: 1.5, onTick: 960, offTick: 1440 },
  { pitch: 67, vel: 1, onSec: 1.0, offSec: 2.75, onTick: 960, offTick: 2640 },
  { pitch: 21, vel: 127, onSec: 2.75, offSec: 2.7505, onTick: 2640, offTick: 2641 },
  { pitch: 108, vel: 64, onSec: 3.3339, offSec: 3.9999, onTick: 3201, offTick: 3840 },
];
const knownFile = writeSMF({
  format: 0, bpm: KNOWN_BPM, name: 'known',
  tracks: [{ channel: 3, program: 27, notes: KNOWN }],
});
const known = safe(() => parseSMF(knownFile, 'the known-note file'), NO_FILE);
const kt = trk(known, 0);

ok('the header chunk is 14 bytes and says format 0, 1 track, division 480',
  knownFile.length > 14 && known.format === 0 && known.ntrks === 1 && known.division === MIDI_PPQ,
  `MThd ${first4(knownFile)} · format ${known.format} · ntrks ${known.ntrks} · division ${known.division}`);
ok('the track carries its name, one tempo at tick 0, and 4/4',
  kt.name === 'known' && kt.tempo === Math.round(60e6 / KNOWN_BPM)
  && kt.timeSig[0] === MIDI_TIME_SIG[0] && kt.timeSig[1] === MIDI_TIME_SIG[1] && kt.timeSig[2] === 24 && kt.timeSig[3] === 8,
  `name ${JSON.stringify(kt.name)} · tempo ${kt.tempo} us/quarter (want ${Math.round(60e6 / KNOWN_BPM)}) · ${kt.timeSig.join(' ')}`);
ok('one program change, on the track\'s own channel',
  kt.programs.length === 1 && kt.programs[0].program === 27 && kt.programs[0].channel === 3,
  JSON.stringify(kt.programs));

const kBad = KNOWN.map((w, i) => {
  const g = kt.notes[i];
  if (!g) return `note ${i} is missing`;
  if (g.pitch !== w.pitch) return `note ${i} pitch ${g.pitch} want ${w.pitch}`;
  if (g.vel !== w.vel) return `note ${i} velocity ${g.vel} want ${w.vel}`;
  if (g.channel !== 3) return `note ${i} channel ${g.channel} want 3`;
  if (g.onTick !== w.onTick) return `note ${i} onTick ${g.onTick} want ${w.onTick}`;
  if (g.offTick !== w.offTick) return `note ${i} offTick ${g.offTick} want ${w.offTick}`;
  return null;
}).filter(Boolean);
ok(`every one of the ${KNOWN.length} notes comes back at the tick it was written to, with its pitch and velocity`,
  kt.notes.length === KNOWN.length && kBad.length === 0,
  kBad.length ? kBad.join('; ')
    : `ticks ${kt.notes.map((n) => `${n.onTick}..${n.offTick}`).join(' ')} · pitches ${kt.notes.map((n) => n.pitch).join(' ')}`);
ok('note-ons and note-offs BALANCE, and nothing is left sounding at the end of the track',
  kt.ons === KNOWN.length && kt.offs === KNOWN.length,
  `${kt.ons} on, ${kt.offs} off — the parser refuses a track that ends with a note still down, so this is a count AND a structural refusal`);
ok('a note shorter than one tick still gets one tick, not zero',
  kt.notes.length === KNOWN.length && kt.notes[4].offTick - kt.notes[4].onTick === 1,
  kt.notes.length === KNOWN.length
    ? `pitch 21 ran 0.5 ms and came back as ${kt.notes[4].onTick}..${kt.notes[4].offTick} — a zero-length note is legal MIDI and silent, which is worse than wrong`
    : `the file did not parse: ${lastReadError}`);

/**
 * THE RETRIGGER RULE, on its own fixture because it needs a COLLISION: the same
 * pitch going off and on again at the same tick. Written note-off first, a
 * player retriggers the note; written note-on first, the release that follows
 * one byte later kills the note that just started, and the second note is
 * SILENT in every host — a wrong file that looks right in a text dump.
 *
 * MAKE IT GO RED: flip `a.kind - b.kind` to `b.kind - a.kind` in
 * `writeNotes`'s sort. (Measured: without a same-pitch collision in the
 * fixture, that mutation is invisible — the first version of this suite had the
 * repeated pitch at a tick where nothing else ended, and scored 86/86 against a
 * writer that cut every retriggered note.)
 */
const RETRIGGER = [
  { pitch: 60, vel: 100, onSec: 0.0, offSec: 0.5 },
  { pitch: 60, vel: 80, onSec: 0.5, offSec: 1.0 },
  { pitch: 60, vel: 60, onSec: 1.0, offSec: 1.5 },
];
const retrigFile = writeSMF({ format: 0, bpm: 120, name: 'retrigger', tracks: [{ channel: 0, program: null, notes: RETRIGGER }] });
const retrig = safe(() => parseSMF(retrigFile, 'the retrigger file'), NO_FILE);
const rt = trk(retrig, 0);
ok('a repeated pitch RETRIGGERS: at each shared tick the note-off is written before the note-on',
  rt.notes.length === 3 && rt.notes.every((n, i) => n.onTick === i * 480 && n.offTick === (i + 1) * 480)
  && rt.notes.map((n) => n.vel).join() === '100,80,60',
  rt.notes.length === 3
    ? `three notes on pitch 60 back to back at ticks ${rt.notes.map((n) => `${n.onTick}..${n.offTick}`).join(' ')}`
    : `the parser refused the file — note-on before note-off at a shared tick: ${lastReadError}`);

/**
 * NEGATIVE CONTROL. Flip the high bit off the FIRST note-on status byte in the
 * track — 0x93 becomes 0x13, which is a data byte where a status byte belongs.
 * The parser must refuse it. A round trip that cannot go red is not measuring
 * anything, so the byte is chosen deliberately rather than at random: a flip
 * inside a velocity or a name would still be a legal file.
 */
const flipAt = knownFile.indexOf(0x93, 14);
const flipped = knownFile.slice();
flipped[flipAt] ^= 0x80;
const flipRes = attempt(() => parseSMF(flipped, 'the corrupted file'));
ok('NEGATIVE CONTROL — one flipped status byte inside the event data and the parse THROWS',
  flipAt > 14 && flipRes.threw,
  `byte ${flipAt}: 0x93 -> 0x${hex(flipped[flipAt])} · ${flipRes.threw ? flipRes.message : 'PARSED CLEANLY, so the round trip above proves nothing'}`);
ok('NEGATIVE CONTROL — a truncated file THROWS rather than returning what it managed to read',
  attempt(() => parseSMF(knownFile.slice(0, knownFile.length - 4), 'a truncated file')).threw,
  attempt(() => parseSMF(knownFile.slice(0, knownFile.length - 4), 'a truncated file')).message);
ok('NEGATIVE CONTROL — bytes that are not an SMF at all THROW',
  attempt(() => parseSMF(bytes('RIFF....WAVEfmt '), 'a WAV')).threw);

// ===========================================================================
head('THE ANTI-DRIFT RULE — absolute ticks over a long track, with the naive method as the control');
// ===========================================================================

/**
 * THE CLAIM. A MIDI track stores DELTA times. Convert ABSOLUTE seconds to
 * ABSOLUTE ticks and subtract, and no error accumulates. Round each DELTA in
 * seconds and add them up, and every rounding error is permanent.
 *
 * THE FIXTURE. 3 000 notes on a 0.7 s grid at 128 BPM. 480 * 128 / 60 = 1024
 * ticks per second exactly, so the true position of note `i` is `i * 716.8`
 * ticks — a number that is never an integer for odd `i`, which is what makes
 * the two methods separate at all.
 *
 * THE MEASUREMENT IS A COUNT OF TICKS, not a clock (AGENTS.md). The writer must
 * be within HALF A TICK of the true position at every one of the 3 000 notes.
 * The naive method is 0.2 ticks further out per note and ends 600 ticks —
 * 0.586 s — late, which is audible drift that no single delta is wrong enough
 * to explain.
 *
 * MAKE IT GO RED: in `writeNotes`, keep a running `lastSec` and write
 * `round((n.onSec - lastSec) * ticksPerSec)` as the delta. Every assertion
 * above stays green — the short fixture is only three seconds long — and the
 * first line below goes red with a 600-tick error.
 */
const DRIFT_BPM = 128;
const DRIFT_TPS = 1024;                    // 480 * 128 / 60, exact
const DRIFT_N = 3000;
const DRIFT_STEP = 0.7;                    // seconds -> 716.8 ticks, never an integer
const driftNotes = Array.from({ length: DRIFT_N }, (_, i) => ({
  pitch: 60 + (i % 12), vel: 64, onSec: i * DRIFT_STEP, offSec: i * DRIFT_STEP + 0.35,
}));
const driftFile = writeSMF({ format: 0, bpm: DRIFT_BPM, name: 'drift', tracks: [{ channel: 0, program: 0, notes: driftNotes }] });
const drift = trk(safe(() => parseSMF(driftFile, 'the long track'), NO_FILE), 0);
const byOn = drift.notes.slice().sort((a, b) => a.onTick - b.onTick);

// The count is checked BEFORE the walk, not only in the assertion: `drift` is a
// `safe(...)` over `NO_TRACK`, and indexing 3 000 notes out of an empty list
// throws a TypeError that takes the whole suite down with no assertion count at
// all. A read that failed must make THIS line red and let the rest of the file
// run — the same argument `safe` itself is written on.
//
// WATCHED IT FAIL: `parseSMF`'s `hlen !== 6` flipped to `!== 7`, so every parse
// in the file throws. Without the guard the run ended in
// `TypeError: Cannot read properties of undefined (reading 'onTick')` with a
// partial count and no summary; with it, the same break prints
// `FAIL all 3000 onsets land within half a tick ... 0 of 3000 notes came back`
// and the suite runs to the end at 70 passed, 18 failed. Reverted, 88/0.
let worst = 0, worstAt = -1;
if (byOn.length === DRIFT_N) {
  for (let i = 0; i < DRIFT_N; i++) {
    const err = Math.abs(byOn[i].onTick - i * DRIFT_STEP * DRIFT_TPS);
    if (err > worst) { worst = err; worstAt = i; }
  }
}
// The control, written out here rather than described: round each delta in
// seconds and accumulate, exactly as the wrong implementation would.
let naive = 0;
for (let i = 1; i < DRIFT_N; i++) naive += Math.round(DRIFT_STEP * DRIFT_TPS);
const naiveErr = Math.abs(naive - (DRIFT_N - 1) * DRIFT_STEP * DRIFT_TPS);

ok(`all ${DRIFT_N} onsets land within half a tick of true position over ${((DRIFT_N - 1) * DRIFT_STEP).toFixed(1)} s`,
  byOn.length === DRIFT_N && worst <= 0.5,
  byOn.length === DRIFT_N
    ? `worst error ${worst.toFixed(3)} ticks at note ${worstAt} (${(worst / DRIFT_TPS * 1000).toFixed(3)} ms) — the last note is at tick ${byOn[DRIFT_N - 1].onTick}`
    : `${byOn.length} of ${DRIFT_N} notes came back, so NO onset was measured: ${lastReadError}`);
ok('THE CONTROL THAT MUST LOSE — accumulating rounded deltas in seconds fails the same test',
  naiveErr > 0.5 && Math.abs(naiveErr - (DRIFT_N - 1) * 0.2) < 1e-6,
  `naive drift ${naiveErr.toFixed(1)} ticks = ${(naiveErr / DRIFT_TPS).toFixed(3)} s by note ${DRIFT_N} (${DRIFT_N - 1} deltas x 0.2), ` +
  `against ${worst.toFixed(3)} for the shipped writer. ` +
  `Each individual naive delta is wrong by 0.2 ticks = 0.195 ms, which no per-event assertion would ever call a defect`);
ok(`and the long track is still balanced: ${DRIFT_N} on, ${DRIFT_N} off`,
  drift.ons === DRIFT_N && drift.offs === DRIFT_N, `${drift.ons} on, ${drift.offs} off`);
ok('a delta long enough to need four VLQ bytes survives the round trip',
  (() => {
    const far = writeSMF({ format: 0, bpm: 120, name: 'far', tracks: [{ channel: 0, program: null, notes: [{ pitch: 60, vel: 64, onSec: 2185, offSec: 2186 }] }] });
    // `safe`, not a bare parse: a file this line cannot READ must make this line
    // red, not take the suite down before the zip section has run. Watched it
    // fail under the same `hlen !== 7` break as the drift walk above — FAIL,
    // not a stack trace.
    const t = trk(safe(() => parseSMF(far, 'the far note'), NO_FILE), 0);
    return t.notes.length === 1 && t.notes[0].onTick === 2185 * 960;
  })(),
  'onset at 2185 s is tick 2 097 600, past the 2 097 152 boundary where a VLQ grows its fourth byte');

// ===========================================================================
head('THE ZIP — a multi-entry archive, re-parsed, every entry compared and every CRC verified');
// ===========================================================================

const ZIP_FIXTURE = [
  { name: 'a.bin', bytes: bytes('hello zip') },
  { name: 'b.bin', bytes: new Uint8Array(0) },
  { name: 'c.bin', bytes: Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff) },
];
const arc = zipStore(ZIP_FIXTURE);
const back = safe(() => zipEntries(arc), []);
const sameBytes = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
ok('three entries in, three entries out, in the order they were given',
  back.length === 3 && back.every((e, i) => e.name === ZIP_FIXTURE[i].name),
  back.length ? `${back.map((e) => `${e.name}:${e.bytes.length}B`).join(' ')} · archive ${arc.length} bytes`
    : `the archive would not parse: ${lastReadError}`);
/**
 * THE COUNT IS PART OF THE CLAIM. `back` is a `safe(...)` with `[]` for a
 * default, and `[].every(...)` is `true` — so without `back.length` this line
 * reported "every entry came back identical" on a run where NO entry came back
 * at all. AGENTS.md: an assertion that passes because a value was never recorded
 * is worse than no assertion.
 *
 * WATCHED IT FAIL: with `zip.js`'s `u16` written big-endian
 * (`this.b[this.p++] = (v >>> 8) & 0xff; this.b[this.p++] = v & 0xff;`),
 * `zipEntries` throws `the directory calls it "a.bin…" and its local header
 * calls it "…"` and `back` is `[]`. Before this fix that run printed PASS here;
 * after it, FAIL with "the archive would not parse, so NOTHING was compared".
 * Reverted, 88/0.
 */
ok(`all ${ZIP_FIXTURE.length} entries were READ BACK, and every one's bytes are identical, including the empty one`,
  back.length === ZIP_FIXTURE.length && back.every((e, i) => sameBytes(e.bytes, ZIP_FIXTURE[i].bytes)),
  back.length ? `${back.map((e) => `${e.name}:${e.bytes.length}B`).join(' ')} compared byte for byte`
    : `the archive would not parse, so NOTHING was compared: ${lastReadError}`);
/**
 * THE STRUCTURE, READ BY OFFSET. `zipStore` and `zipEntries` agreeing proves
 * they agree; these read the bytes the way a third-party extractor does.
 */
const adv = new DataView(arc.buffer, arc.byteOffset, arc.byteLength);

/** Offset of entry `i`'s local file header, recomputed here rather than read from the writer. */
function off(i) {
  let o = 0;
  for (let k = 0; k < i; k++) o += 30 + ZIP_FIXTURE[k].name.length + ZIP_FIXTURE[k].bytes.length;
  return o;
}

ok('the CRC stored in each local header is the CRC of that entry\'s bytes',
  ZIP_FIXTURE.every((e, i) => adv.getUint32(off(i) + 14, true) === crc32(e.bytes)),
  ZIP_FIXTURE.map((e, i) => `${e.name}:0x${adv.getUint32(off(i) + 14, true).toString(16).padStart(8, '0')}`).join(' ')
  + ' — read out of the header at offset 14 and recomputed here, so a writer that stored a constant would go red');
ok('local file header: signature 0x04034b50, version 20, method 0 (STORED)',
  adv.getUint32(0, true) === 0x04034b50 && adv.getUint16(4, true) === 20 && adv.getUint16(8, true) === 0,
  `sig 0x${adv.getUint32(0, true).toString(16).padStart(8, '0')} · version ${adv.getUint16(4, true)} · method ${adv.getUint16(8, true)}`);
ok('general-purpose bit 3 is 0 in every header — the CRC and the sizes are known before the data is written',
  ZIP_FIXTURE.every((_, i) => (adv.getUint16(off(i) + 6, true) & 0x0008) === 0),
  `flags ${ZIP_FIXTURE.map((_, i) => '0x' + adv.getUint16(off(i) + 6, true).toString(16).padStart(4, '0')).join(' ')} — ` +
  'a writer that set bit 3 would be promising a data descriptor that is not there');
ok('the ASCII names carry flags 0x0000, and a non-ASCII name sets bit 11 (UTF-8)',
  ZIP_FIXTURE.every((_, i) => adv.getUint16(off(i) + 6, true) === 0x0000)
  && new DataView(zipStore([{ name: 'strauß.bin', bytes: bytes('x') }]).buffer).getUint16(6, true) === 0x0800,
  'the seven pack names are ASCII by construction, so the pack is flag-free; a UTF-8 name flagged as CP437 is mojibake in every extractor');
ok('the DOS timestamp is FIXED at 1980-01-01, so two runs are byte-identical',
  adv.getUint16(10, true) === 0x0000 && adv.getUint16(12, true) === 0x0021
  && sameBytes(zipStore(ZIP_FIXTURE), arc),
  'a diff in this gate is a defect rather than a clock');
ok('the end-of-central-directory record counts the entries and points at the directory',
  (() => {
    const e = arc.length - 22;
    const cdOff = adv.getUint32(e + 16, true);
    return adv.getUint32(e, true) === 0x06054b50 && adv.getUint16(e + 10, true) === 3
      && adv.getUint32(cdOff, true) === 0x02014b50;
  })(),
  `EOCD at ${arc.length - 22} · ${adv.getUint16(arc.length - 22 + 10, true)} entries · central directory at ${adv.getUint32(arc.length - 22 + 16, true)}`);

/**
 * NEGATIVE CONTROLS for the container. A reader that returned a partial list
 * would let the delivery guard vouch for bytes it never saw, so each of these
 * must THROW, not degrade.
 */
const bitrot = arc.slice();
bitrot[off(0) + 30 + ZIP_FIXTURE[0].name.length] ^= 0x01;     // one bit of entry a.bin's DATA
const rotRes = attempt(() => zipEntries(bitrot));
ok('NEGATIVE CONTROL — one flipped bit in a stored entry and zipEntries THROWS a CRC mismatch',
  rotRes.threw && /CRC mismatch/.test(rotRes.message) && /a\.bin/.test(rotRes.message),
  rotRes.threw ? rotRes.message : 'IT PARSED — the CRC is being written and never checked');
ok('NEGATIVE CONTROL — a truncated archive THROWS',
  attempt(() => zipEntries(arc.slice(0, arc.length - 1))).threw,
  attempt(() => zipEntries(arc.slice(0, arc.length - 1))).message);
ok('NEGATIVE CONTROL — bytes that are not a zip THROW',
  attempt(() => zipEntries(bytes('MThd not a zip at all'))).threw,
  attempt(() => zipEntries(bytes('MThd not a zip at all'))).message);

// ===========================================================================
head('THE PACK — seven files, DISPLAY ORDER, and every entry begins MThd');
// ===========================================================================

/**
 * A REAL take, fed the way the engine feeds one: three `MIDI_NOTES` payloads
 * covering all six stems, with WIRE-ORDER `stem` names (`STEMS`), which is NOT
 * the order the pack is written in. The third payload's last note runs PAST its
 * span's end — a note is delivered in the hop it CLOSED in, not the one it
 * started in, and `spanFrom/spanTo` describe COVERAGE rather than the extent of
 * the notes in the message.
 */
const PACK_BPM = 128;
const TPS = MIDI_PPQ * PACK_BPM / 60;      // 1024
const take = new MidiTake();
const feed = [
  { v: 1, type: 'MIDI_NOTES', deck: 'A', seq: 1, spanFrom: 0, spanTo: 2, covered: true, notes: [
    { stem: 'drums', pitch: 36, vel: 110, onSec: 0.25, offSec: 0.31 },
    { stem: 'bass', pitch: 40, vel: 77, onSec: 0.5, offSec: 1.2 },
    { stem: 'vocals', pitch: 64, vel: 88, onSec: 1.0, offSec: 1.75 },
  ] },
  { v: 1, type: 'MIDI_NOTES', deck: 'A', seq: 2, spanFrom: 2, spanTo: 4, covered: true, notes: [
    { stem: 'other', pitch: 55, vel: 60, onSec: 2.117, offSec: 2.9 },
    { stem: 'guitar', pitch: 52, vel: 95, onSec: 2.6, offSec: 3.4 },
    { stem: 'piano', pitch: 72, vel: 40, onSec: 3.0, offSec: 3.999 },
  ] },
  { v: 1, type: 'MIDI_NOTES', deck: 'A', seq: 3, spanFrom: 4, spanTo: 6, covered: true, notes: [
    { stem: 'drums', pitch: 38, vel: 100, onSec: 4.25, offSec: 4.31 },
    { stem: 'vocals', pitch: 67, vel: 70, onSec: 5.5, offSec: 6.4 },
  ] },
];
const feedVerdicts = feed.map((m) => take.accept(m));
ok('three in-order MIDI_NOTES payloads are accepted and the take is not bad',
  feedVerdicts.every((v) => v === 'ok') && !take.bad && take.count === 8,
  `${feedVerdicts.join(' ')} · ${take.count} notes · covered ${take.coveredSec}s · perStem ${JSON.stringify(take.perStem())}`);

const entries = packEntries(take, { bpm: PACK_BPM });
const zip = zipStore(entries);
const readBack = safe(() => zipEntries(zip), []);

ok('exactly 7 entries, named exactly PACK_ENTRIES, in that order',
  readBack.length === 7 && readBack.every((e, i) => e.name === PACK_ENTRIES[i]),
  readBack.map((e) => e.name).join(' '));
/**
 * THE RULING'S PART 2, AND IT CARRIES ITS OWN COUNT. `readBack` is a
 * `safe(...)` with `[]` for a default and `[].every(...)` is `true`, so a reader
 * that THROWS used to produce a PASS on the one assertion R2 names. A gate that
 * reports "every entry is a MIDI file" over zero entries is the exact shape
 * AGENTS.md calls worse than no assertion, and it was sitting on the deliverable
 * promise itself.
 *
 * WATCHED IT FAIL: same break as §"THE ZIP" above — `zip.js`'s `u16` written
 * big-endian. `zipEntries(zip)` throws, `readBack` is `[]`, and the old form
 * printed `PASS EVERY entry's bytes begin MThd` with an EMPTY detail line. With
 * the count in, the same run prints FAIL and names the throw. Reverted, green.
 */
ok(`all ${PACK_ENTRIES.length} entries were READ BACK, and EVERY one's bytes begin MThd (the ruling's part 2)`,
  readBack.length === PACK_ENTRIES.length && readBack.every((e) => first4(e.bytes) === '4d 54 68 64'),
  readBack.length ? readBack.map((e) => `${e.name}:${first4(e.bytes)}`).join(' · ')
    : `the pack would not parse, so NOTHING was inspected: ${lastReadError}`);
const accept = attempt(() => assertDeliverable(packName('Some Song'), zip, 'application/zip'));
ok('the delivery guard accepts the real pack and returns true',
  !accept.threw && assertDeliverable(packName('Some Song'), zip, 'application/zip') === true,
  `${JSON.stringify(packName('Some Song'))} · ${zip.length} bytes · ${accept.threw ? accept.message : 'accepted'}`);

// ---- the seven files, read back one at a time
const parsed = PACK_ENTRIES.map((n, i) => (readBack[i] ? safe(() => parseSMF(readBack[i].bytes, n), NO_FILE) : NO_FILE));
ok('the six per-stem files are format 0, one track, division 480',
  parsed.slice(0, 6).every((f) => f.format === 0 && f.ntrks === 1 && f.division === MIDI_PPQ),
  parsed.slice(0, 6).map((f, i) => `${PACK_ENTRIES[i]} f${f.format}/${f.ntrks}/${f.division}`).join(' '));
ok('all.mid is format 1 with SEVEN tracks — a meta track and then six named ones — at division 480',
  parsed[6].format === 1 && parsed[6].ntrks === 7 && parsed[6].division === MIDI_PPQ
  && trk(parsed[6], 0).notes.length === 0 && trk(parsed[6], 0).name === 'Stem Splitter Live'
  && PACK_ORDER.every((s, i) => trk(parsed[6], i + 1).name === s),
  `format ${parsed[6].format} · ntrks ${parsed[6].ntrks} · tracks ${parsed[6].tracks.map((t) => t.name).join(', ')}`);
ok(`every file carries one set-tempo of ${Math.round(60e6 / PACK_BPM)} us/quarter at tick 0, and 4/4`,
  parsed.slice(0, 6).every((f) => trk(f, 0).tempo === Math.round(60e6 / PACK_BPM) && trk(f, 0).timeSig[0] === 4 && trk(f, 0).timeSig[1] === 4)
  && trk(parsed[6], 0).tempo === Math.round(60e6 / PACK_BPM)
  && PACK_ORDER.every((_, i) => trk(parsed[6], i + 1).tempo === null),
  `${PACK_BPM} BPM -> ${Math.round(60e6 / PACK_BPM)} us/quarter; in all.mid the tempo is in track 0 ONLY and the six stem tracks carry none`);
ok('the tempo fallback is written when the deck never locked one',
  trk(safe(() => parseSMF(packEntries(take, { bpm: null })[0].bytes, 'fallback'), NO_FILE), 0).tempo === Math.round(60e6 / MIDI_TEMPO_FALLBACK_BPM),
  `bpm null -> ${MIDI_TEMPO_FALLBACK_BPM} BPM -> ${Math.round(60e6 / MIDI_TEMPO_FALLBACK_BPM)} us/quarter, and the deck says so in the fine line`);

// ---- channels, programs and the notes themselves
const wanted = (stem) => take.notes.filter((n) => n.stem === stem)
  .map((n) => ({ pitch: n.pitch, vel: n.vel, onTick: Math.round(n.onSec * TPS), offTick: Math.max(Math.round(n.offSec * TPS), Math.round(n.onSec * TPS) + 1) }))
  .sort((a, b) => a.onTick - b.onTick || a.pitch - b.pitch);
const noteProblems = [];
for (let i = 0; i < PACK_ORDER.length; i++) {
  const stem = PACK_ORDER[i];
  const want = wanted(stem);
  for (const [where, tr] of [[PACK_ENTRIES[i], trk(parsed[i], 0)], ['all.mid', trk(parsed[6], i + 1)]]) {
    if (tr.notes.length !== want.length) { noteProblems.push(`${where}/${stem}: ${tr.notes.length} notes, want ${want.length}`); continue; }
    tr.notes.forEach((g, k) => {
      const w = want[k];
      if (g.pitch !== w.pitch || g.vel !== w.vel || g.onTick !== w.onTick || g.offTick !== w.offTick) {
        noteProblems.push(`${where}/${stem}[${k}]: ${g.pitch}/${g.vel}/${g.onTick}..${g.offTick} want ${w.pitch}/${w.vel}/${w.onTick}..${w.offTick}`);
      }
      if (g.channel !== MIDI_CHANNEL[stem]) noteProblems.push(`${where}/${stem}[${k}]: channel ${g.channel} want ${MIDI_CHANNEL[stem]}`);
    });
  }
}
ok('every note comes back on the right channel at the right tick, in its own file AND inside all.mid',
  noteProblems.length === 0 && take.count === 8,
  noteProblems.length ? noteProblems.join('; ')
    : `${take.count} notes across ${PACK_ORDER.length} stems, each compared twice (once per file) on pitch, velocity, channel and both ticks`);
ok('drums is on channel 9 (MIDI channel 10) and carries NO program change',
  MIDI_CHANNEL.drums === 9 && trk(parsed[1], 0).programs.length === 0
  && trk(parsed[6], 2).programs.length === 0
  && trk(parsed[1], 0).notes.length > 0 && trk(parsed[1], 0).notes.every((n) => n.channel === 9),
  'channel 10 is a kit by definition; a program change there picks a kit VARIANT, which is a claim this build cannot make');
ok('each of the other five stems carries exactly one program change, with the value in MIDI_PROGRAM',
  PACK_ORDER.every((s, i) => {
    if (s === 'drums') return true;
    const a = trk(parsed[i], 0).programs, b = trk(parsed[6], i + 1).programs;
    return a.length === 1 && b.length === 1 && a[0].program === MIDI_PROGRAM[s] && b[0].program === MIDI_PROGRAM[s]
      && a[0].channel === MIDI_CHANNEL[s];
  }),
  PACK_ORDER.filter((s) => s !== 'drums').map((s) => `${s}=GM${MIDI_PROGRAM[s] + 1}`).join(' '));
ok('a stem with no notes still gets its file and its track',
  (() => {
    const one = new MidiTake();
    one.accept({ seq: 1, spanFrom: 0, spanTo: 1, covered: true, notes: [{ stem: 'piano', pitch: 60, vel: 64, onSec: 0.5, offSec: 0.9 }] });
    const e = packEntries(one, { bpm: 120 });
    const p = e.map((x) => safe(() => parseSMF(x.bytes, x.name), NO_FILE));
    // EVERY ONE OF THE SEVEN MUST PARSE FIRST. `NO_FILE` carries an empty track,
    // so "0 notes" is what a file that would not parse looks like as well as what
    // an empty stem looks like — checking the note count alone would report
    // coverage on five files it never read. `ntrks === 1` is the discriminator
    // (NO_FILE's is -1), and the piano track is asserted to have KEPT its one
    // note, so "all seven are empty" cannot pass either.
    //
    // WATCHED IT FAIL, on a break that DISCRIMINATES: `packEntries` changed to
    // write `new Uint8Array(0)` for a stem with no notes — the plausible
    // "why write a file with nothing in it" defect, which is precisely what this
    // line claims cannot happen. The old form printed PASS (five NO_FILEs each
    // report 0 notes, and `all.mid` still parsed, so its `ntrks === 7` conjunct
    // held); this form prints FAIL. Reverted, 88/0.
    return e.length === 7
      && p.slice(0, 5).every((f) => f.ntrks === 1 && trk(f, 0).notes.length === 0)
      && trk(p[5], 0).notes.length === 1
      && p[6].ntrks === 7 && trk(p[6], 6).notes.length === 1;
  })(),
  'the pack is the same seven files every time — an empty track is the honest encoding of "this stem produced nothing", and PACK_ORDER[5] = piano still carries the one note that was fed');
ok('the pack is deterministic: the same take twice is byte-identical',
  sameBytes(zipStore(packEntries(take, { bpm: PACK_BPM })), zip));
ok('packName sanitises a title into one filename',
  packName('Artist / Track: "Live" <2026>') === 'Artist Track Live 2026 (MIDI).zip'
  && packName(null) === 'stem-splitter-live (MIDI).zip'
  && packName('   ') === 'stem-splitter-live (MIDI).zip'
  && packName('...hidden') === 'hidden (MIDI).zip'
  && packName('x'.repeat(200)).length === 80 + ' (MIDI).zip'.length,
  `${JSON.stringify(packName('Artist / Track: "Live" <2026>'))} · empty -> ${JSON.stringify(packName(''))} · 200 chars -> ${packName('x'.repeat(200)).length} code units`);

// ===========================================================================
head('THE CONTROL THAT MUST LOSE — a real WAV inside the pack, and the guard refusing it');
// ===========================================================================

/**
 * The ruling's part 3. THIS IS THE ASSERTION THAT GOES RED IF
 * `assertDeliverable` EVER DEGENERATES TO `return true`, so the discrimination
 * is printed as the evidence: the same seven-entry archive, one entry's bytes
 * different, accepted in one direction and refused in the other.
 *
 * The WAV is written by `extension/shared/wav.js::encodeWav` — this repo's own
 * writer — so the refusal is about a genuine audio file rather than about a
 * blob that happens not to look like anything.
 */
const wav = new Uint8Array(encodeWav([Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 8) * 0.5)],
  { sampleRate: 44100, bitDepth: 16, float: false, dither: false }));
const poisoned = entries.map((e, i) => (i === 3 ? { name: PACK_ENTRIES[3], bytes: wav } : e));
const poisonedZip = zipStore(poisoned);
const poisonedBack = safe(() => zipEntries(poisonedZip), []);
ok('the poisoned archive is still a WELL-FORMED zip with seven entries',
  poisonedBack.length === 7 && poisonedBack.every((e, i) => e.name === PACK_ENTRIES[i]),
  `so the refusal below is about the CONTENT, not about a broken container · ${PACK_ENTRIES[3]} is ${first4(wav)} = "RIFF"`);
const refusal = attempt(() => assertDeliverable(packName('Some Song'), poisonedZip, 'application/zip'));
ok('the delivery guard REFUSES the pack with a WAV in it, and names the entry',
  refusal.threw && /4-other\.mid/.test(refusal.message),
  `accepted: ${JSON.stringify(packName('Some Song'))} + the real pack -> true\n         ` +
  `refused:  the same name + the same seven entry names, one entry RIFF -> ${refusal.threw ? refusal.message : 'RETURNED TRUE, and the allowlist is decoration'}`);

// ===========================================================================
head('THE EXTENSION IS NOT THE EVIDENCE — the magic is, and the MIME is exact');
// ===========================================================================

const midiWav = attempt(() => assertDeliverable('take.mid', wav, 'audio/midi'));
ok('a `.mid` full of RIFF is refused on its magic',
  midiWav.threw && /MThd/.test(midiWav.message),
  midiWav.threw ? midiWav.message : 'ACCEPTED on the strength of its name alone');
/**
 * ZIP SLIP. `zipStore` refuses to WRITE a name with a path in it, so this
 * archive is hand-patched: `1-vocals.mid` becomes `../ocals.mid` in both the
 * local header and the central directory — the same length, so every offset and
 * every CRC in the archive stays valid and the container still parses. The
 * guard vouches for bytes it did not write, and an entry that extracts outside
 * the folder the user picked is not what the archive presents itself as.
 */
const slipped = zip.slice();
const SLIP_FROM = bytes('1-vocals.mid'), SLIP_TO = bytes('../ocals.mid');
let slipHits = 0;
for (let i = 0; i + SLIP_FROM.length <= slipped.length; i++) {
  if (SLIP_FROM.every((v, k) => slipped[i + k] === v)) { slipped.set(SLIP_TO, i); slipHits++; }
}
const slipRes = attempt(() => assertDeliverable('p.zip', slipped, 'application/zip'));
// Read back ONCE, through `safe`. "the archive is intact" is half the claim, so
// it is asserted as a COUNT rather than left to a bare `zipEntries` that would
// throw the suite over before the MIME section ran. WATCHED IT FAIL: with
// `zip.js`'s `u16` written big-endian the pre-sweep version of this file died
// HERE — `Error: zipEntries: the directory calls it "../ocals.mid…"` thrown out
// of the assertion's own condition, at `qa/midi-pack.mjs:747`, with no summary
// line and the whole MIME section never reached. Now it is one red among
// eighteen and the count still prints.
const slipBack = safe(() => zipEntries(slipped), []);
ok('a zip entry whose name carries a path is refused, even though the archive is intact',
  slipHits === 2 && slipBack.length === 7 && slipRes.threw && /\.\.\/ocals\.mid/.test(slipRes.message),
  `patched ${slipHits} copies of the name (local header + central directory), archive still parses to ${slipBack.length} entries · ` +
  (slipBack.length ? '' : `THE PATCHED ARCHIVE NO LONGER PARSES (${lastReadError}), so the refusal below is about a broken container · `) +
  (slipRes.threw ? slipRes.message : 'ACCEPTED — the pack would extract outside the folder the user picked'));

const wavMime = attempt(() => assertDeliverable('x.wav', wav, 'audio/wav'));
ok('audio/wav is refused on the MIME, before anything else is looked at',
  wavMime.threw && /not a deliverable type/.test(wavMime.message), wavMime.message);
ok('the allowlist is exactly {application/zip, audio/midi}',
  JSON.stringify(Object.keys(DELIVERABLE).sort()) === JSON.stringify(['application/zip', 'audio/midi']),
  `MAKE IT GO RED: add one key to DELIVERABLE in shared/midi.js. Today: ${Object.keys(DELIVERABLE).join(', ')}`);
ok('a MIME with parameters, a wildcard, or the wrong case is not the allowlist',
  ['application/zip; charset=binary', 'application/*', 'Application/Zip', 'application/x-zip-compressed', ''].every(
    (m) => attempt(() => assertDeliverable('p.zip', zip, m)).threw),
  'the check is an exact string against a key, so none of the five near-misses gets through');
ok('the name is checked too: wrong extension, a path separator, a leading dot, a control character, over 120 units',
  [['p.mid', zip, 'application/zip'], ['../p.zip', zip, 'application/zip'], ['.p.zip', zip, 'application/zip'],
    ['p .zip', zip, 'application/zip'], [`${'n'.repeat(120)}.zip`, zip, 'application/zip']]
    .every(([n, b, m]) => attempt(() => assertDeliverable(n, b, m)).threw),
  'a name is a name — it is checked because it becomes a filename, not because it proves anything about the bytes');
ok('empty bytes, a non-Uint8Array and an empty archive are all refused',
  attempt(() => assertDeliverable('p.zip', new Uint8Array(0), 'application/zip')).threw
  && attempt(() => assertDeliverable('p.zip', 'not bytes', 'application/zip')).threw
  && attempt(() => assertDeliverable('p.zip', null, 'application/zip')).threw);

// ===========================================================================
head('THE ORDER CANNOT DRIFT — two copies of one order, held together');
// ===========================================================================

/**
 * There are two stem orders in this build. WIRE ORDER (`STEMS`, in
 * `shared/config.js`) is the model's output order and the plane map; DISPLAY
 * ORDER is the order the rack is drawn in and the order the pack reads in.
 * `PACK_ORDER` is the second copy of the second one, and two copies are only
 * acceptable because these assertions make them unable to drift in silence.
 */
ok('PACK_ORDER is a permutation of STEMS — same six names, different order',
  PACK_ORDER.length === STEMS.length && STEMS.every((s) => PACK_ORDER.includes(s))
  && new Set(PACK_ORDER).size === PACK_ORDER.length,
  `wire ${STEMS.join(' ')} · display ${PACK_ORDER.join(' ')}`);

const embedSrc = strip(fs.readFileSync(path.join(ROOT, 'extension/ui/embed.js'), 'utf8'));
const embedLit = /const STEM_ORDER = \[([^\]]*)\]/.exec(embedSrc);
const embedOrder = embedLit ? Array.from(embedLit[1].matchAll(/'([a-z]+)'/g), (m) => m[1]) : null;
ok('PACK_ORDER equals the STEM_ORDER literal in ui/embed.js',
  embedOrder !== null && embedOrder.join() === PACK_ORDER.join(),
  embedOrder === null ? 'no STEM_ORDER literal in extension/ui/embed.js — the deck reordered the rack and this file could not see it'
    : `embed.js ${embedOrder.join(' ')} · midi.js ${PACK_ORDER.join(' ')}`);
ok('each entry name carries its own stem, numbered in the order the strips are drawn',
  PACK_ORDER.every((s, i) => PACK_ENTRIES[i] === `${i + 1}-${s}.mid`) && PACK_ENTRIES[6] === 'all.mid'
  && PACK_ENTRIES.length === 7,
  PACK_ENTRIES.join(' '));
ok('every stem has a channel, they are distinct, and only drums is on 9',
  PACK_ORDER.every((s) => Number.isInteger(MIDI_CHANNEL[s]))
  && new Set(PACK_ORDER.map((s) => MIDI_CHANNEL[s])).size === 6
  && PACK_ORDER.filter((s) => MIDI_CHANNEL[s] === 9).join() === 'drums',
  PACK_ORDER.map((s) => `${s}:${MIDI_CHANNEL[s]}`).join(' '));

// ===========================================================================
head('THE SEQ GAP — the one claim in this feature that can actually fail');
// ===========================================================================

/** A `MIDI_NOTES` payload with one note in it, at `seq`. */
const msg = (seq, from = seq - 1, to = seq, covered = true, notes = [{ stem: 'bass', pitch: 40, vel: 64, onSec: from + 0.1, offSec: from + 0.5 }]) =>
  ({ seq, spanFrom: from, spanTo: to, covered, notes: covered ? notes : [] });

const good = new MidiTake();
const goodV = [1, 2, 3].map((s) => good.accept(msg(s)));
ok('CONTROL — seq 1, 2, 3 all return ok and the take is NOT bad',
  goodV.join() === 'ok,ok,ok' && good.bad === false && good.why === null,
  `${goodV.join(' ')} · bad=${good.bad}. Without this half, a \`bad\` hardwired to true would pass the other half`);

const gapped = new MidiTake();
const gapV = [1, 2, 4].map((s) => gapped.accept(msg(s)));
ok('seq 1, 2, 4 — the third returns "gap" and the take latches bad',
  gapV.join() === 'ok,ok,gap' && gapped.bad === true && /seq 4 arrived where 3/.test(gapped.why || ''),
  `${gapV.join(' ')} · why: ${gapped.why}`);
const after = gapped.accept(msg(5));
ok('...and seq 5 arriving in order does NOT unlatch it',
  after === 'ok' && gapped.bad === true,
  `accept(5) -> ${after}, bad still ${gapped.bad}. A take the deck cannot vouch for does not become vouchable by later messages arriving in order`);
ok('...and the reason kept is the FIRST one, not the latest complaint',
  /seq 4 arrived where 3/.test(gapped.why || ''), gapped.why);

const flushGap = new MidiTake();
[1, 2, 3].forEach((s) => flushGap.accept(msg(s)));
const fg = flushGap.flushed({ seq: 9 });
ok('MIDI_FLUSHED saying seq 9 over a take holding 1..3 returns "gap" and latches bad',
  fg === 'gap' && flushGap.bad === true,
  `${fg} · why: ${flushGap.why}. This is the second carrier of seq, and it is what catches a LOST LAST MESSAGE — the one a gap cannot catch, because there is no later message to be out of step with`);
const flushOk = new MidiTake();
[1, 2, 3].forEach((s) => flushOk.accept(msg(s)));
ok('CONTROL — MIDI_FLUSHED saying seq 3 over the same take returns ok and leaves it good',
  flushOk.flushed({ seq: 3 }) === 'ok' && flushOk.bad === false,
  'so the flush check can win as well as lose');
const unreadable = new MidiTake();
ok('a payload this take cannot READ latches bad too, naming what was wrong',
  unreadable.accept({ seq: 1, spanFrom: 0, spanTo: 2, covered: true, notes: [{ stem: 'kazoo', pitch: 60, vel: 64, onSec: 0.5, offSec: 1 }] }) === 'gap'
  && unreadable.bad === true && /kazoo/.test(unreadable.why || ''),
  unreadable.why);
const badSpan = new MidiTake();
ok('...and so does a span that is not a stretch of the video',
  badSpan.accept({ seq: 1, spanFrom: 5, spanTo: 1, covered: true, notes: [] }) === 'gap' && badSpan.bad,
  badSpan.why);
const lyingSpan = new MidiTake();
ok('...and so does covered:false arriving with notes in it',
  lyingSpan.accept({ seq: 1, spanFrom: 0, spanTo: 2, covered: false, notes: [{ stem: 'bass', pitch: 40, vel: 64, onSec: 0.5, offSec: 1 }] }) === 'gap'
  && lyingSpan.bad,
  lyingSpan.why);
const faulted = new MidiTake();
faulted.fault('MIDI_ERROR WORKER_FAILED');
ok('fault() latches bad with a reason the row can put in its title',
  faulted.bad === true && faulted.why === 'MIDI_ERROR WORKER_FAILED');

// ===========================================================================
head('COVERAGE — uncovered is not silence, and last pass wins');
// ===========================================================================

/**
 * `LiveEmitter.gap()` ZEROES the twelve stem planes, so a reader that did not
 * know that would emit a confident "no notes" over audible music. The take's
 * job is to keep the two apart: a span nobody could read must not look like a
 * span where nothing was playing. If `coveredSec` counted both, the coverage
 * figure would be a lie in the safe-looking direction — the direction nobody
 * investigates.
 */
const unc = new MidiTake();
unc.accept({ seq: 1, spanFrom: 0, spanTo: 5, covered: false, notes: [] });
ok('a covered:false span with no notes adds to uncoveredSec and NOT to coveredSec',
  unc.coveredSec === 0 && unc.uncoveredSec === 5 && unc.count === 0 && !unc.bad,
  `covered ${unc.coveredSec}s · uncovered ${unc.uncoveredSec}s · spans ${JSON.stringify(unc.uncoveredSpans)}`);
const quiet = new MidiTake();
quiet.accept({ seq: 1, spanFrom: 0, spanTo: 5, covered: true, notes: [] });
ok('CONTROL — the SAME span with covered:true and no notes adds to coveredSec',
  quiet.coveredSec === 5 && quiet.uncoveredSec === 0 && quiet.count === 0,
  `covered ${quiet.coveredSec}s · uncovered ${quiet.uncoveredSec}s. "nothing played here" and "nobody could read this" must be distinguishable, ` +
  'and this pair is the only thing that makes them so');

const replay = new MidiTake();
replay.accept({ seq: 1, spanFrom: 10, spanTo: 20, covered: true, notes: [
  { stem: 'vocals', pitch: 60, vel: 64, onSec: 11, offSec: 12 },
  { stem: 'vocals', pitch: 62, vel: 64, onSec: 13, offSec: 14 },
] });
replay.accept({ seq: 2, spanFrom: 10, spanTo: 20, covered: true, notes: [
  { stem: 'vocals', pitch: 67, vel: 64, onSec: 15, offSec: 16 },
] });
ok('LAST PASS WINS — a replayed span replaces its notes and does not double-count its seconds',
  replay.count === 1 && replay.notes[0].pitch === 67 && replay.coveredSec === 10,
  `${replay.count} note (want 1, not 3) · covered ${replay.coveredSec}s (want 10, not 20) · spans ${JSON.stringify(replay.coveredSpans)}`);
const reseek = new MidiTake();
reseek.accept({ seq: 1, spanFrom: 10, spanTo: 20, covered: true, notes: [{ stem: 'vocals', pitch: 60, vel: 64, onSec: 11, offSec: 12 }] });
reseek.accept({ seq: 2, spanFrom: 10, spanTo: 20, covered: false, notes: [] });
ok('a covered span replayed as PASSTHROUGH gives its seconds back',
  reseek.count === 0 && reseek.coveredSec === 0 && reseek.uncoveredSec === 10,
  `covered ${reseek.coveredSec}s · uncovered ${reseek.uncoveredSec}s · ${reseek.count} notes. ` +
  'The notes were dropped by the replay, so a coverage figure that kept counting those seconds would be counting seconds whose notes are gone');
const merge = new MidiTake();
merge.accept({ seq: 1, spanFrom: 0, spanTo: 2, covered: true, notes: [] });
merge.accept({ seq: 2, spanFrom: 2, spanTo: 4, covered: true, notes: [] });
merge.accept({ seq: 3, spanFrom: 6, spanTo: 8, covered: true, notes: [] });
ok('touching spans merge and a hole stays a hole',
  merge.coveredSec === 6 && JSON.stringify(merge.coveredSpans) === JSON.stringify([[0, 4], [6, 8]]),
  `${JSON.stringify(merge.coveredSpans)} — a seek forwards leaves a hole in the rail, and the hole is the message`);

// ===========================================================================
head('THE EMPTY TAKE IS REFUSED — a blank beats a plausible wrong answer');
// ===========================================================================

const emptyTake = new MidiTake();
emptyTake.accept({ seq: 1, spanFrom: 0, spanTo: 30, covered: true, notes: [] });
const emptyRes = attempt(() => packEntries(emptyTake, { bpm: 120 }));
ok('packEntries THROWS on a take with no notes at all',
  emptyRes.threw && emptyTake.coveredSec === 30,
  `30 s covered and 0 notes -> ${emptyRes.message}`);
const oneNote = new MidiTake();
oneNote.accept({ seq: 1, spanFrom: 0, spanTo: 30, covered: true, notes: [{ stem: 'piano', pitch: 60, vel: 64, onSec: 1, offSec: 2 }] });
ok('CONTROL — a take with exactly ONE note does not throw, and still gets all seven files',
  attempt(() => packEntries(oneNote, { bpm: 120 })).threw === false && packEntries(oneNote, { bpm: 120 }).length === 7,
  'the refusal is about nothing at all, not about "not much" — the deck has an `empty` state with no Save button for the first case');

// ===========================================================================
head('THE GUARD IS NOT DECORATION — the seam, read from both sides');
// ===========================================================================

/**
 * `ui/host.js::deliver` is where bytes become a file on the user's disk. The
 * guard is the unit's, the transport is the Host's, and a guard the transport
 * can SKIP is decoration — so this reads the Host as text and checks that
 * `assertDeliverable(` runs before the first `new Blob(`.
 *
 * IT MUST FAIL WHEN IT CANNOT LOOK. The read below is unguarded: if
 * `ui/host.js` is missing, `readFileSync` throws and this suite dies red. That
 * is the right outcome — a missing Host is not an excuse from the check.
 *
 * THE THREE-STATE VERDICT, and why it is not an `!x || check` in disguise.
 * `deliver` is a duty of the DeckHost interface, and a duty exists in two
 * places at once: declared in `DECK_HOST_DUTIES` (`shared/host.js`, the unit's
 * own seam declaration) and implemented in `ui/host.js` (this Host). The claim
 * asserted here is that those two AGREE, and that where the duty exists the
 * guard runs first:
 *
 *   absent      declared no,  implemented no   -> PASS. No transport exists, so
 *                                                no bytes can leave by this
 *                                                route at all. A coherent tree.
 *   half-landed declared XOR implemented       -> FAIL. Either the deck reaches
 *                                                for a duty no Host implements
 *                                                (`assertHost` refuses at boot)
 *                                                or this Host has a route out
 *                                                that the freeze does not name.
 *   unguarded   both, Blob before the guard    -> FAIL. This is the one the
 *                                                assertion exists for.
 *   guarded     both, guard before the Blob    -> PASS.
 *
 * The excuse is therefore read from a DIFFERENT FILE than the one under test,
 * which is what AGENTS.md's independence rule asks for — and both directions
 * can lose. MAKE IT GO RED, either way: add `deliver` to `DECK_HOST_DUTIES`
 * without implementing it, or implement it with the `new Blob(...)` above the
 * `assertDeliverable(...)`.
 */
const hostSrc = strip(fs.readFileSync(path.join(ROOT, 'extension/ui/host.js'), 'utf8'));
ok('extension/ui/host.js is readable and is this Host',
  /export const host\s*=/.test(hostSrc),
  `${hostSrc.length} bytes after comments are stripped — if this file were missing, readFileSync above would have taken the whole suite down, which is the point`);

const declared = Object.prototype.hasOwnProperty.call(DECK_HOST_DUTIES, 'deliver');
const body = memberBody(hostSrc, 'deliver');
const implemented = body !== null;
const guardAt = implemented ? body.indexOf('assertDeliverable(') : -1;
const blobAt = implemented ? body.indexOf('new Blob(') : -1;
const verdict = (!declared && !implemented) ? 'absent'
  : (declared !== implemented) ? 'half-landed'
    : (guardAt >= 0 && (blobAt < 0 || guardAt < blobAt)) ? 'guarded' : 'unguarded';
ok('the delivery duty is declared iff it is implemented, and where it is implemented the guard runs before the first Blob',
  verdict === 'absent' || verdict === 'guarded',
  `verdict: ${verdict} — DECK_HOST_DUTIES ${declared ? 'declares' : 'does not declare'} deliver; ui/host.js ${implemented ? 'implements' : 'does not implement'} it` +
  (implemented ? ` · assertDeliverable( at ${guardAt}, new Blob( at ${blobAt}` : '') +
  (verdict === 'absent' ? '\n         nothing can leave the product by this route yet; when the duty lands, this line checks the ORDER of the two calls' : ''));

/** The body of `name(...) { ... }` in an object literal, braces matched. `null` if there is none. */
function memberBody(src, name) {
  const m = new RegExp(`(^|[^\\w.])${name}\\s*\\(`, 'm').exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log('\x1b[2m  Three kinds of red live in this file and they have different fixes:\n' +
    '   · a FORMAT red — a VLQ vector, a CRC, a tick, a zip offset — is this repo\'s\n' +
    '     bytes disagreeing with a published spec. The spec wins.\n' +
    '   · an ALLOWLIST red is the product decision moving: `DELIVERABLE` grew a type,\n' +
    '     or the guard stopped refusing something. That is ADR 0002 changing, and it\n' +
    '     needs the owner\'s ruling before it needs a code fix.\n' +
    '   · a SEAM red — the last section — is `shared/host.js` and `ui/host.js`\n' +
    '     disagreeing about whether this product can hand a file over at all.\x1b[0m');
}
process.exit(failed ? 1 : 0);
