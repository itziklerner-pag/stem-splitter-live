/**
 * midi.js — the Standard MIDI File writer, the pack layout, the deck's take,
 * and the delivery guard.
 *
 * WHY THIS FILE EXISTS. Four jobs live here and they are here TOGETHER because
 * they are one format: what a `.mid` byte means, which seven of them make a
 * pack, what the deck is holding while the song plays, and whether those bytes
 * may leave the product at all. Splitting them would put the entry names in one
 * file and the guard that checks the entry names in another, which is how the
 * two drift.
 *
 * It is PURE. No DOM, no `chrome.`, no `Blob`, no timer. That is not tidiness:
 * it is what makes the deck's one failable claim — a gap in `MIDI_NOTES.seq`,
 * which means notes are missing and can never be recovered — drivable from
 * `node` in `qa/midi-pack.mjs` instead of only in a browser.
 *
 * ---------------------------------------------------------------------------
 * BIG-ENDIAN, AND THAT IS THE OPPOSITE OF `shared/zip.js`.
 *
 * Every multi-byte field in a Standard MIDI File is BIG-endian; every
 * multi-byte field in a zip is LITTLE-endian. The two byte sinks are therefore
 * separate objects in separate files with different names, neither exported —
 * `BeSink` here, `LeSink` there — and the reason is written down in both
 * places: a shared writer with an endianness flag puts a boolean between a
 * caller and the byte order of the format it is writing, and what that produces
 * is a plausible file no tool can open.
 *
 * ---------------------------------------------------------------------------
 * THE ANTI-DRIFT RULE, AND IT IS LOAD-BEARING.
 *
 * A MIDI track stores DELTA times, and the obvious way to write one is to keep
 * a running "seconds since the last event" and round that to ticks. Do that and
 * every rounding error is permanent and cumulative: at 128 BPM a note grid of
 * 0.7 s is 716.8 ticks, `round()` makes every delta 717, and 3 000 notes later
 * the file is 599.8 ticks — 0.586 s — behind the audio, with each individual
 * delta off by 0.2 ticks, which is 0.195 ms and which no per-event assertion
 * would ever call a defect. Both numbers are measured by the gate, not
 * estimated here.
 *
 *   ABSOLUTE SECONDS -> ABSOLUTE TICKS FIRST. Deltas are `tick[i] - tick[i-1]`
 *   between two numbers that were each rounded from an absolute time.
 *
 * Then no error accumulates: every event is within half a tick of where it
 * belongs no matter how long the song is. `qa/midi-pack.mjs` holds this with a
 * long-track assertion that names the naive method's drift as a COUNT of ticks,
 * and it is a control that can lose — the naive path is written out in the gate
 * and asserted to be wrong.
 *
 * ---------------------------------------------------------------------------
 * THE TEMPO IS A LABEL, NOT A QUANTISER.
 *
 * `tick = round(sec * MIDI_PPQ * bpm / 60)`. At 120 BPM that is 960 ticks per
 * second — 1.04 ms — against an 11.6 ms frame grid upstream, so the tick grid is
 * an order of magnitude finer than anything that can reach it. Changing the
 * tempo therefore moves where the BARLINES fall in a DAW and never moves when a
 * note sounds. Nothing here quantises, and the deck says out loud when the
 * tempo was not detected (`no tempo detected — written at 120`) rather than
 * printing a confident wrong number, which is the rule `bpmPlan`'s header
 * already sets for this product.
 *
 *   covered by  node qa/midi-pack.mjs
 */

import { STEMS } from './config.js';
import { zipEntries } from './zip.js';

// ---------------------------------------------------------------- the format

/** Ticks per quarter note. The `division` field of every file this writes. */
export const MIDI_PPQ = 480;

/** Written when the deck's tempo box never locked. The UI says so when it is used. */
export const MIDI_TEMPO_FALLBACK_BPM = 120;

/**
 * [numerator, denominator]. 4/4 goes on the wire as `04 02 18 08` — numerator,
 * log2 of the denominator, 24 MIDI clocks per metronome click, 8 32nd notes per
 * quarter.
 *
 * ponytail: ceiling — every pack this build writes says 4/4, including the
 * waltzes. Nothing in the product detects a metre, and a metre this writer
 * invented would be a confident wrong number of exactly the kind
 * `MIDI_TEMPO_FALLBACK_BPM` exists to avoid. The cost is bounded and stated:
 * like the tempo, the time signature moves where the BARLINES fall in a DAW and
 * never moves when a note sounds. Upgrade path — take it from a detector the
 * day there is one, and write it beside the tempo; it is one meta event whose
 * bytes this file already emits, and the work is all upstream.
 */
export const MIDI_TIME_SIG = [4, 4];

/**
 * DISPLAY ORDER — the order the rack is drawn in, which is the order the pack
 * reads in. It is NOT the wire order (`STEMS` in `shared/config.js`, which is
 * the model's output order and the plane map). `qa/midi-pack.mjs` asserts this
 * is a permutation of `STEMS` AND that it equals the `STEM_ORDER` literal in
 * `ui/embed.js`. Two copies of an order that cannot drift in silence is the
 * only reason two copies are acceptable.
 */
export const PACK_ORDER = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];

/**
 * Channel per stem, 0-BASED ON THE WIRE. Drums is 9, i.e. MIDI channel 10, so a
 * DAW opens it as a kit. The other five take 0..4 in DISPLAY ORDER, skipping 9.
 */
export const MIDI_CHANNEL = Object.freeze({
  vocals: 0, drums: 9, bass: 1, other: 2, guitar: 3, piano: 4,
});

/**
 * General MIDI program per stem, 0-BASED ON THE WIRE (GM number minus one).
 * `drums` is deliberately ABSENT: channel 10 is a kit by definition and a
 * program change there picks a kit VARIANT, which is a claim this build cannot
 * make — it classifies four instruments by band energy and nothing about the
 * kit they came from.
 */
export const MIDI_PROGRAM = Object.freeze({
  vocals: 53,   // GM 54  Voice Oohs
  bass: 33,     // GM 34  Electric Bass (finger)
  other: 48,    // GM 49  String Ensemble 1
  guitar: 27,   // GM 28  Electric Guitar (clean)
  piano: 0,     // GM  1  Acoustic Grand Piano
});

/**
 * The seven entry names, DISPLAY ORDER, combined last. The digit prefix is the
 * deck's fixed left-to-right order — the same identity the strips carry — so
 * the extracted folder reads like the rack.
 */
export const PACK_ENTRIES = Object.freeze([
  '1-vocals.mid', '2-drums.mid', '3-bass.mid',
  '4-other.mid', '5-guitar.mid', '6-piano.mid', 'all.mid',
]);

/** The four bytes every Standard MIDI File starts with. */
const MTHD = [0x4d, 0x54, 0x68, 0x64];

/** C0 and C1 control characters — stripped from a title, refused in a filename. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// ------------------------------------------------------------- the SMF writer

/**
 * Variable-length quantity — MIDI's own integer encoding, seven bits per byte,
 * high bit set on every byte but the last. Four widths, and the boundaries are
 * where an encoder goes wrong: 0x7f/0x80, 0x3fff/0x4000, 0x1fffff/0x200000.
 * 0x0fffffff is the largest the format admits.
 *
 * EXPORTED BECAUSE THE GATE HOLDS IT TO THE SPEC. `qa/midi-pack.mjs` drives all
 * four widths and both sides of all three boundaries directly. The only other
 * way to reach this code is through a delta time, and the third boundary is
 * 2 097 152 ticks — thirty-six minutes into a song at 120 BPM — so "test it
 * through the writer" would mean a fixture nobody would run. THE SINK CALLS
 * THIS ONE FUNCTION rather than carrying its own copy: an exported encoder the
 * writer does not use is a spec test over dead code.
 *
 * @param {number} n 0 .. 0x0fffffff
 * @returns {Uint8Array} 1..4 bytes
 */
export function vlq(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0x0fffffff) {
    throw new RangeError(`vlq: ${n} is not a variable-length quantity (0 .. 268435455)`);
  }
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x4000) return new Uint8Array([0x80 | (n >>> 7), n & 0x7f]);
  if (n < 0x200000) return new Uint8Array([0x80 | (n >>> 14), 0x80 | ((n >>> 7) & 0x7f), n & 0x7f]);
  return new Uint8Array([0x80 | (n >>> 21), 0x80 | ((n >>> 14) & 0x7f), 0x80 | ((n >>> 7) & 0x7f), n & 0x7f]);
}

/**
 * The big-endian byte sink. Growable, because a track's length is not known
 * until its events are written — which is also why each track body is built in
 * its own sink and the `MTrk` length is written over the finished body rather
 * than patched back into the middle of the file.
 */
class BeSink {
  constructor(cap = 1024) { this.b = new Uint8Array(cap); this.n = 0; }
  _room(k) {
    if (this.n + k <= this.b.length) return;
    let c = this.b.length * 2;
    while (c < this.n + k) c *= 2;
    const nb = new Uint8Array(c);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
  u8(v) { this._room(1); this.b[this.n++] = v & 0xff; }
  u16(v) { this._room(2); this.b[this.n++] = (v >>> 8) & 0xff; this.b[this.n++] = v & 0xff; }
  u24(v) { this._room(3); this.b[this.n++] = (v >>> 16) & 0xff; this.b[this.n++] = (v >>> 8) & 0xff; this.b[this.n++] = v & 0xff; }
  u32(v) {
    this._room(4);
    this.b[this.n++] = (v >>> 24) & 0xff; this.b[this.n++] = (v >>> 16) & 0xff;
    this.b[this.n++] = (v >>> 8) & 0xff; this.b[this.n++] = v & 0xff;
  }
  raw(a) { this._room(a.length); this.b.set(a, this.n); this.n += a.length; }
  vlq(v) { this.raw(vlq(v)); }
  take() { return this.b.slice(0, this.n); }
}

const UTF8 = new TextEncoder();

/** `FF <type> <len> text` — a text meta event, at whatever delta the caller is at. */
function metaText(t, type, s) {
  const b = UTF8.encode(s);
  t.u8(0xff); t.u8(type); t.vlq(b.length); t.raw(b);
}

/**
 * Write one Standard MIDI File.
 *
 * @param {object} o
 * @param {0|1} o.format  0 = one track; 1 = a meta track and then `o.tracks`
 * @param {number} o.bpm  quarter notes per minute, > 0
 * @param {string} o.name name of the FIRST track WRITTEN — the single track in
 *        format 0, the meta track in format 1. Every track in `o.tracks` that
 *        is not that one takes its own `name`.
 * @param {Array<{name?: string, channel: number, program: number|null,
 *                notes: Array<{pitch, vel, onSec, offSec}>}>} o.tracks
 *        For format 0 there MUST be exactly one; for format 1 the meta track is
 *        written by this function and `o.tracks` are the ones after it.
 * @returns {Uint8Array}
 *
 * The header chunk is ALWAYS 14 bytes — `MThd`, a length of 6, and the three
 * 16-bit fields. A writer that ever emits a different header length has
 * invented a dialect.
 *
 * Event rules, fixed: no running status (every event carries its status byte,
 * which costs one byte per event and removes a whole class of parser
 * disagreement); note-off is `8n pitch 0x40`; at equal ticks note-offs are
 * written BEFORE note-ons so a repeated pitch retriggers instead of being cut
 * by its predecessor's release; `offTick = max(offTick, onTick + 1)` so no note
 * has zero length; `pitch` clamped 0..127, `vel` clamped 1..127; every track
 * ends `00 FF 2F 00`.
 *
 * MUST NOT quantise. MUST NOT sort stems. MUST NOT emit a tempo change beyond
 * the single one at tick 0.
 */
export function writeSMF(o) {
  const format = o.format;
  if (format !== 0 && format !== 1) throw new RangeError(`writeSMF: format ${format} — this writer does 0 and 1`);
  const bpm = o.bpm;
  if (!Number.isFinite(bpm) || bpm <= 0) throw new RangeError(`writeSMF: bpm ${bpm} is not a tempo`);
  const tracks = o.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) throw new RangeError('writeSMF: no tracks');
  if (format === 0 && tracks.length !== 1) {
    throw new RangeError(`writeSMF: format 0 is one track by definition and got ${tracks.length}`);
  }

  // Microseconds per quarter note. The field is 24 bits, so a tempo below
  // ~3.58 BPM cannot be expressed at all — throw rather than truncate.
  const usPerQuarter = Math.round(60e6 / bpm);
  if (usPerQuarter < 1 || usPerQuarter > 0xffffff) {
    throw new RangeError(`writeSMF: ${bpm} BPM is ${usPerQuarter} us/quarter and the field holds 24 bits`);
  }
  const ticksPerSec = MIDI_PPQ * bpm / 60;
  const dd = Math.log2(MIDI_TIME_SIG[1]);
  if (!Number.isInteger(dd)) {
    throw new RangeError(`writeSMF: time signature denominator ${MIDI_TIME_SIG[1]} is not a power of two`);
  }

  const chunks = [];
  if (format === 1) {
    // Track 0 is meta ONLY: the file's name, the one tempo, the time signature.
    // A DAW shows it as a conductor track; notes in it are what makes some
    // hosts refuse to import a type-1 file at all.
    const t = new BeSink(64);
    t.vlq(0); metaText(t, 0x03, String(o.name));
    t.vlq(0); t.u8(0xff); t.u8(0x51); t.u8(0x03); t.u24(usPerQuarter);
    t.vlq(0); t.u8(0xff); t.u8(0x58); t.u8(0x04); t.u8(MIDI_TIME_SIG[0]); t.u8(dd); t.u8(24); t.u8(8);
    t.vlq(0); t.u8(0xff); t.u8(0x2f); t.u8(0x00);
    chunks.push(t.take());
  }
  for (let i = 0; i < tracks.length; i++) {
    const tr = tracks[i];
    const name = String((format === 0 && i === 0) ? o.name : tr.name);
    const t = new BeSink(1024);
    t.vlq(0); metaText(t, 0x03, name);
    if (format === 0) {
      // A type-0 file has one track, so its tempo and metre live there or
      // nowhere. In format 1 they are already in track 0, and repeating them
      // here would be the second tempo event this writer must not emit.
      t.vlq(0); t.u8(0xff); t.u8(0x51); t.u8(0x03); t.u24(usPerQuarter);
      t.vlq(0); t.u8(0xff); t.u8(0x58); t.u8(0x04); t.u8(MIDI_TIME_SIG[0]); t.u8(dd); t.u8(24); t.u8(8);
    }
    const ch = tr.channel;
    if (!Number.isInteger(ch) || ch < 0 || ch > 15) throw new RangeError(`writeSMF: channel ${ch} on track "${name}"`);
    if (tr.program != null) {
      if (!Number.isInteger(tr.program) || tr.program < 0 || tr.program > 127) {
        throw new RangeError(`writeSMF: program ${tr.program} on track "${name}"`);
      }
      t.vlq(0); t.u8(0xc0 | ch); t.u8(tr.program);
    }
    writeNotes(t, tr.notes || [], ch, ticksPerSec, name);
    t.vlq(0); t.u8(0xff); t.u8(0x2f); t.u8(0x00);
    chunks.push(t.take());
  }

  const out = new BeSink(chunks.reduce((a, c) => a + c.length + 8, 14));
  out.raw(Uint8Array.from(MTHD)); out.u32(6);
  out.u16(format); out.u16(chunks.length); out.u16(MIDI_PPQ);
  for (const c of chunks) { out.raw(UTF8.encode('MTrk')); out.u32(c.length); out.raw(c); }
  return out.take();
}

/**
 * Notes -> events, and THIS is where the anti-drift rule lives.
 *
 * Both endpoints of every note are converted from ABSOLUTE seconds to ABSOLUTE
 * ticks before anything is sorted, and the delta written to the file is the
 * difference between two absolute ticks. Nothing accumulates. See the file
 * header for what the other way costs.
 */
function writeNotes(t, notes, ch, ticksPerSec, trackName) {
  const ev = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (!Number.isFinite(n.onSec) || !Number.isFinite(n.offSec) || n.onSec < 0) {
      throw new RangeError(`writeSMF: track "${trackName}" note ${i} runs [${n.onSec}, ${n.offSec}] — a time this writer cannot place`);
    }
    const onTick = Math.round(n.onSec * ticksPerSec);
    let offTick = Math.round(n.offSec * ticksPerSec);
    if (offTick <= onTick) offTick = onTick + 1;   // a zero-length note is legal and silent, which is worse than wrong
    const pitch = Math.min(127, Math.max(0, Math.round(n.pitch) || 0));
    const vel = Math.min(127, Math.max(1, Math.round(n.vel) || 1));
    ev.push({ tick: onTick, kind: 1, pitch, vel, i });
    ev.push({ tick: offTick, kind: 0, pitch, vel: 0x40, i });
  }
  // Note-offs first at equal ticks (kind 0 before kind 1); then by pitch, then
  // by the order the notes arrived, so two runs over the same take produce
  // byte-identical files and a diff in the gate is a defect rather than a sort.
  ev.sort((a, b) => a.tick - b.tick || a.kind - b.kind || a.pitch - b.pitch || a.i - b.i);
  let last = 0;
  for (const e of ev) {
    t.vlq(e.tick - last);
    last = e.tick;
    t.u8((e.kind ? 0x90 : 0x80) | ch);
    t.u8(e.pitch);
    t.u8(e.vel);
  }
}

// ------------------------------------------------------------------- the pack

/**
 * The seven files of a pack.
 *
 * @param {MidiTake} take
 * @param {{bpm: number|null}} o  `null` -> MIDI_TEMPO_FALLBACK_BPM
 * @returns {Array<{name: string, bytes: Uint8Array}>} exactly 7, in PACK_ENTRIES order
 * @throws {Error} if the take holds NO notes at all.
 *
 * THE EMPTY TAKE IS REFUSED, and that is a product decision rather than a
 * defensive check: a zip of seven empty files is a confident-looking nothing,
 * and this deck's rule is that a blank beats a plausible wrong answer. The row
 * has an `empty` state with no Save button for exactly this case, so the throw
 * is the second line and the UI is the first.
 *
 * A stem with no notes DOES still get its file and its track: the pack's shape
 * is the same seven files every time, and an empty track is the honest encoding
 * of "this stem produced nothing".
 *
 * Six per-stem files are SMF TYPE 0 — one track carrying name, tempo, time
 * signature, the program change and the notes. A single-stem file has exactly
 * one thing in it, and written as type 1 it would carry an empty tempo track
 * that every DAW shows as a blank lane. `all.mid` is SMF TYPE 1 — track 0 is
 * meta only and then six named tracks in PACK_ORDER, one channel each.
 */
export function packEntries(take, o) {
  if (!take.count) {
    throw new Error('packEntries: this take holds no notes — a zip of seven empty files is a confident-looking nothing');
  }
  const bpm = (o && o.bpm != null) ? o.bpm : MIDI_TEMPO_FALLBACK_BPM;

  const byStem = new Map(PACK_ORDER.map((s) => [s, []]));
  for (const n of take.notes) {
    const bucket = byStem.get(n.stem);
    if (!bucket) {
      // Not a defensive check: PACK_ORDER *is* the pack, so a note tagged with
      // a stem the pack has no file for would vanish silently while the
      // coverage figure went on counting it.
      throw new Error(`packEntries: a note is tagged stem "${n.stem}", which is not one of ${PACK_ORDER.join(', ')}`);
    }
    bucket.push(n);
  }
  const track = (s) => ({
    name: s,
    channel: MIDI_CHANNEL[s],
    program: Object.prototype.hasOwnProperty.call(MIDI_PROGRAM, s) ? MIDI_PROGRAM[s] : null,
    notes: byStem.get(s),
  });

  const out = PACK_ORDER.map((s, i) => ({
    name: PACK_ENTRIES[i],
    bytes: writeSMF({ format: 0, bpm, name: s, tracks: [track(s)] }),
  }));
  out.push({
    name: PACK_ENTRIES[6],
    bytes: writeSMF({ format: 1, bpm, name: 'Stem Splitter Live', tracks: PACK_ORDER.map(track) }),
  });
  return out;
}

/**
 * `{title} (MIDI).zip` from `session.title`.
 *
 * The nine characters replaced are the ones Windows refuses in a filename;
 * everything else a video title carries is legal on every platform this runs
 * on. Control characters go entirely — a title with a newline in it would
 * produce a `download` attribute that reads as two lines in the browser's own
 * UI — and a leading dot goes because it hides the file on unix.
 *
 * @param {string|null|undefined} title
 * @returns {string}
 */
export function packName(title) {
  let s = String(title == null ? '' : title);
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  s = s.replace(/[/\\:*?"<>|]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '');
  s = s.slice(0, 80).trim();        // 80 code units, then trim whatever the cut left
  if (!s) s = 'stem-splitter-live';
  return `${s} (MIDI).zip`;
}

// ------------------------------------------------------------- the deck's take

/** Merge `[a, b)` into a sorted, disjoint span list. Touching spans merge. */
function unionSpan(list, a, b) {
  const out = [];
  let lo = a, hi = b, i = 0;
  for (; i < list.length && list[i][1] < lo; i++) out.push(list[i]);
  for (; i < list.length && list[i][0] <= hi; i++) { lo = Math.min(lo, list[i][0]); hi = Math.max(hi, list[i][1]); }
  out.push([lo, hi]);
  for (; i < list.length; i++) out.push(list[i]);
  return out;
}

/** Remove `[a, b)` from a sorted, disjoint span list. */
function subtractSpan(list, a, b) {
  const out = [];
  for (const [x, y] of list) {
    if (y <= a || x >= b) { out.push([x, y]); continue; }
    if (x < a) out.push([x, a]);
    if (y > b) out.push([b, y]);
  }
  return out;
}

const spanSec = (list) => list.reduce((t, [a, b]) => t + (b - a), 0);

/**
 * THE DECK HOLDS THE TAKE. This class is where.
 *
 * Everything about a take that can be decided without a DOM is decided here, so
 * that the one claim in this feature that can actually fail is gated under
 * `node`: `MIDI_NOTES.seq` is monotonic and gapless per take, and a gap means
 * the deck is missing notes it can never recover. The deck must SAY so rather
 * than paper over it — hence a latch that never unlatches, because a take the
 * deck cannot vouch for does not become vouchable by later messages arriving in
 * order.
 */
export class MidiTake {
  constructor() {
    this._notes = [];
    this._cov = [];       // sorted, disjoint [a, b) in SOURCE seconds
    this._unc = [];
    this._seq = 0;
    this._bad = false;
    this._why = null;
    this._sorted = true;
  }

  /**
   * One `MIDI_NOTES` payload (§4.2 of the wire).
   * @returns {'ok'|'gap'} `'gap'` the FIRST time a seq is skipped.
   *
   * A payload this take cannot READ is treated exactly like a gap: the return
   * type has two values on purpose and both outcomes mean the same thing to the
   * deck — the take is untrustworthy and the row must say so.
   *
   * A span that OVERLAPS one already held (a backward seek replayed) REPLACES
   * it: every held note whose `onSec` lies in `[spanFrom, spanTo)` is dropped
   * before the new notes are added. Last pass wins, which is what the FAQ
   * already tells people to do.
   */
  accept(msg) {
    if (!msg || typeof msg !== 'object') return this._unreadable('a MIDI_NOTES message that is not an object');
    const step = this._seqStep(msg.seq, 'MIDI_NOTES');
    const from = msg.spanFrom, to = msg.spanTo;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || from < 0) {
      return this._unreadable(`MIDI_NOTES seq ${msg.seq} spans [${from}, ${to}], which is not a stretch of the video`);
    }
    if (typeof msg.covered !== 'boolean') {
      return this._unreadable(`MIDI_NOTES seq ${msg.seq} does not say whether its span was covered`);
    }
    if (!Array.isArray(msg.notes)) return this._unreadable(`MIDI_NOTES seq ${msg.seq} carries no notes array`);
    const notes = msg.notes;
    if (!msg.covered && notes.length) {
      // `notes` is [] whenever `covered` is false. An engine that sends notes
      // for a span it says it could not read is wrong about one of the two and
      // there is no way to tell which.
      return this._unreadable(`MIDI_NOTES seq ${msg.seq} says covered:false and carries ${notes.length} note${notes.length === 1 ? '' : 's'}`);
    }
    for (const n of notes) {
      const why = badNote(n);
      if (why) return this._unreadable(`MIDI_NOTES seq ${msg.seq} carries a note that ${why}`);
    }

    if (to > from) {
      this._notes = this._notes.filter((n) => !(n.onSec >= from && n.onSec < to));
      // COVERAGE IS LAST-PASS-WINS TOO. Two spans of the SAME kind union, which
      // is the ordinary case and the one the contract fixes. The MIXED case is
      // the one a seek makes — a covered span replayed as passthrough — and its
      // notes have just been dropped, so leaving the span in `coveredSpans`
      // would keep a coverage figure counting seconds whose notes are gone.
      // That is a lie in the safe-looking direction, so each span joins its own
      // list and leaves the other.
      if (msg.covered) { this._cov = unionSpan(this._cov, from, to); this._unc = subtractSpan(this._unc, from, to); }
      else { this._unc = unionSpan(this._unc, from, to); this._cov = subtractSpan(this._cov, from, to); }
    }
    for (const n of notes) {
      this._notes.push({ stem: n.stem, pitch: n.pitch, vel: n.vel, onSec: n.onSec, offSec: n.offSec });
    }
    if (notes.length) this._sorted = false;
    return step;
  }

  /**
   * One `MIDI_FLUSHED` payload. The deck holds a complete take iff it holds
   * every seq `1..seq`, so this is the second carrier of the same number and
   * the place a lost LAST message is caught — the one a gap in `seq` cannot
   * catch, because there is no later message to be out of step with it.
   * @returns {'ok'|'gap'}
   */
  flushed(msg) {
    if (!msg || typeof msg !== 'object') return this._unreadable('a MIDI_FLUSHED message that is not an object');
    const seq = msg.seq;
    if (!Number.isInteger(seq) || seq < 0) return this._unreadable(`MIDI_FLUSHED seq ${seq} is not a sequence number`);
    if (seq !== this._seq) {
      this._latch(`MIDI_FLUSHED says the take ended at seq ${seq}; this deck holds up to ${this._seq}`);
      return 'gap';
    }
    return this._bad ? 'gap' : 'ok';
  }

  /** Latch `bad` with a reason the row can put in its `title`. */
  fault(why) { this._latch(String(why)); }

  get bad() { return this._bad; }
  get why() { return this._why; }

  /** Closed notes, source seconds, sorted by onSec. */
  get notes() {
    if (!this._sorted) {
      this._notes.sort((a, b) => a.onSec - b.onSec
        || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
        || a.pitch - b.pitch);
      this._sorted = true;
    }
    return this._notes;
  }

  get count() { return this._notes.length; }
  get coveredSpans() { return this._cov.map((s) => s.slice()); }
  get coveredSec() { return spanSec(this._cov); }
  get uncoveredSpans() { return this._unc.map((s) => s.slice()); }

  /**
   * Sum of `uncoveredSpans`. The twin of `coveredSec`, and the two have to be
   * distinguishable or the coverage figure is a lie in the safe-looking
   * direction: a passthrough span that added to neither would read as a stretch
   * of the video where nothing happened to be playing.
   */
  get uncoveredSec() { return spanSec(this._unc); }

  /** `{ drums: n, bass: n, ... }` — every WIRE-ORDER key, zeros included. */
  perStem() {
    const o = {};
    for (const s of STEMS) o[s] = 0;
    for (const n of this._notes) if (o[n.stem] !== undefined) o[n.stem]++;
    return o;
  }

  _seqStep(seq, what) {
    const want = this._seq + 1;
    if (!Number.isInteger(seq) || seq < 1) {
      this._latch(`${what} arrived with seq ${seq}, which is not a sequence number`);
      return 'gap';
    }
    if (seq === want) { this._seq = seq; return 'ok'; }
    this._seq = Math.max(this._seq, seq);
    this._latch(`${what} seq ${seq} arrived where ${want} was expected — the notes in between are gone and cannot be asked for again`);
    return 'gap';
  }

  _unreadable(why) { this._latch(why); return 'gap'; }

  /** FIRST reason wins: `why` is the reason `bad` latched, not the latest complaint. */
  _latch(why) {
    if (!this._bad) { this._bad = true; this._why = why; }
  }
}

/** @returns {string|null} what is wrong with this wire note, or null. */
function badNote(n) {
  if (!n || typeof n !== 'object') return 'is not an object';
  if (typeof n.stem !== 'string' || !STEMS.includes(n.stem)) return `names stem ${JSON.stringify(n.stem)}`;
  if (!Number.isInteger(n.pitch) || n.pitch < 0 || n.pitch > 127) return `has pitch ${n.pitch}`;
  if (!Number.isInteger(n.vel) || n.vel < 1 || n.vel > 127) return `has velocity ${n.vel}`;
  // THE SPAN IS DELIBERATELY NOT CHECKED HERE. `offSec` may legitimately exceed
  // `spanTo` — a note is delivered in the hop it CLOSED in, not the hop it
  // started in — and `onSec` sits on a 1 ms grid that can round onto the
  // boundary, so containment would fault a whole take over arithmetic the wire
  // format itself specifies.
  if (!Number.isFinite(n.onSec) || !Number.isFinite(n.offSec) || n.onSec < 0 || n.offSec <= n.onSec) {
    return `runs [${n.onSec}, ${n.offSec}]`;
  }
  return null;
}

// --------------------------------------------------------- the delivery guard

/**
 * THE ALLOWLIST. Exactly two types, and nothing widens it (ADR 0002 / the
 * owner's ruling R2). `application/zip` is the pack; `audio/midi` is a single
 * `.mid` handed over on its own, which nothing does today and which is in the
 * list because it is the only OTHER thing this product could ever hand back.
 *
 * Widening this object turns `qa/midi-pack.mjs` red.
 */
export const DELIVERABLE = Object.freeze({
  'application/zip': '.zip',
  'audio/midi': '.mid',
});

/**
 * Decide whether these bytes may leave the product.
 *
 * THE UNIT DECIDES IDENTITY, THE HOST DOES THE TRANSPORT — the same split
 * `shared/config.js`'s model pin makes against `offscreen/host-pin.js`, and for
 * the same reason: a check that lives in a Host is a check a second Host can
 * forget to make.
 *
 * @param {string} name
 * @param {Uint8Array} bytes
 * @param {string} mime
 * @returns {true}
 * @throws {Error} naming the FIRST thing that was wrong, and for a zip naming
 *         the offending ENTRY.
 *
 * IT THROWS SYNCHRONOUSLY and it is not swallowed. A refusal here is the call
 * site being wrong about bytes it produced itself — the same shape as DeckHost
 * rule 5's area refusal — so it is loud on purpose and it fires where the
 * mistake is.
 *
 * THE EXTENSION IS NOT THE EVIDENCE, THE MAGIC IS. Both are checked, so a
 * `.mid` full of RIFF is refused. A guard that trusted the name would pass any
 * file at all once it had been renamed, which is exactly the mistake a caller
 * assembling an archive is most likely to make.
 *
 * THE BLIND SPOT, STATED BESIDE IT: this is a check on bytes at ONE call site.
 * A reference assembled at runtime defeats a static scan, which is exactly why
 * the `downloads` permission stays ABSENT — the platform withholds what the
 * grep cannot. This guard is the second line, not the first.
 */
export function assertDeliverable(name, bytes, mime) {
  if (typeof mime !== 'string' || !Object.prototype.hasOwnProperty.call(DELIVERABLE, mime)) {
    throw new Error(`assertDeliverable: ${JSON.stringify(mime)} is not a deliverable type — this product hands over `
      + `${Object.keys(DELIVERABLE).join(' and ')} and nothing else`);
  }
  const ext = DELIVERABLE[mime];
  if (typeof name !== 'string' || !name.endsWith(ext)) {
    throw new Error(`assertDeliverable: ${JSON.stringify(name)} is not a ${ext} name for ${mime}`);
  }
  if (name.length > 120) throw new Error(`assertDeliverable: the name is ${name.length} code units and the limit is 120`);
  if (/[/\\]/.test(name)) throw new Error(`assertDeliverable: ${JSON.stringify(name)} contains a path separator`);
  if (CONTROL.test(name)) throw new Error(`assertDeliverable: ${JSON.stringify(name)} contains a control character`);
  if (name.startsWith('.')) throw new Error(`assertDeliverable: ${JSON.stringify(name)} starts with a dot`);
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`assertDeliverable: ${JSON.stringify(name)} carries ${bytes === null ? 'null' : typeof bytes}, not bytes`);
  }
  if (bytes.length === 0) throw new Error(`assertDeliverable: ${JSON.stringify(name)} is empty`);

  if (mime === 'audio/midi') {
    if (!isSMF(bytes)) throw new Error(`assertDeliverable: ${JSON.stringify(name)} does not begin MThd (${magic(bytes)})`);
    return true;
  }
  const entries = zipEntries(bytes);          // throws, naming what was wrong
  if (!entries.length) throw new Error(`assertDeliverable: ${JSON.stringify(name)} is an archive with nothing in it`);
  for (const e of entries) {
    // A NAME WITH A PATH IN IT NEVER LEAVES. `zipStore` refuses to write one,
    // so a pack built here cannot contain one — but this guard vouches for
    // whatever bytes it is handed, and an entry called `../x.mid` is the
    // decades-old zip-slip trap: it extracts outside the folder the user chose.
    // Refusing it costs one line and is the same decision as refusing a `.mid`
    // full of RIFF — the archive is not what it presents itself as.
    if (/[/\\]/.test(e.name) || e.name.startsWith('.')) {
      throw new Error(`assertDeliverable: zip entry "${e.name}" carries a path — a pack that extracts outside the folder the user picked is not something this product hands over`);
    }
    if (!e.name.endsWith('.mid')) {
      throw new Error(`assertDeliverable: zip entry "${e.name}" is not a .mid — this product delivers MIDI and nothing else`);
    }
    if (!isSMF(e.bytes)) {
      throw new Error(`assertDeliverable: zip entry "${e.name}" does not begin MThd (${magic(e.bytes)}) — the extension is not the evidence, the magic is`);
    }
  }
  return true;
}

/** Does this begin `4D 54 68 64`? */
function isSMF(b) {
  return b.length >= 4 && b[0] === MTHD[0] && b[1] === MTHD[1] && b[2] === MTHD[2] && b[3] === MTHD[3];
}

/** The first four bytes, so a refusal is something a reader can act on. */
function magic(b) {
  return Array.from(b.subarray(0, 4), (v) => v.toString(16).padStart(2, '0')).join(' ') || 'empty';
}
