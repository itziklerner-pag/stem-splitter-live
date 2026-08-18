/**
 * The key-detection tap — the offscreen main thread's window onto the `other`
 * stem, and the only place the engine ever forms an opinion about key.
 *
 * `chroma.js` is pure maths: spectra in, key names out. This file is the half
 * that has to know about the product — which plane, which end of the ring, how
 * often, and what to do when the audio it wanted has already been overwritten.
 *
 *   stem ring plane 4/5 (`other`)          upstream of the pitch shifter
 *     -> readStemWindow()                  absolute, non-destructive, REFUSABLE
 *     -> Hann + rfft (engine/fft.js)       16384 points, 2.69 Hz/bin
 *     -> foldChroma + accumulator          ~10 Hz, one frame one vote
 *     -> correlateKey + createKeyDisplay   ~2 Hz, with hysteresis
 *     -> { state, concertTonic, mode, confidence }
 *
 * `node extension/engine/keytap.js` runs the checks.
 *
 * -------------------------------------------------------------- THE TAP POINT
 *
 * `other`, and UPSTREAM of the pitch shifter. Both halves are product rulings and
 * neither is re-litigated here; what is written down is why each one is not
 * arbitrary, because both are invisible in review if they are wrong.
 *
 * WHY `other` AND NOT THE MIX. chroma.js's own `drums-collapse-confidence`
 * measures it: drums at +3.5 dB RMS over the harmonic content take a clean
 * F# minor from a confidence that clears the display gate to one that does not.
 * A drum kit is broadband, so it lifts all twelve bins together and flattens the
 * chroma toward uniform — and a flat chroma has no argmax, which is the one
 * failure mode `correlateKey` is allowed to answer `null` to. Only this product
 * can take that tap, because only this product has the stems.
 *
 * WHY UPSTREAM OF THE SHIFTER. So the composition is EXPLICIT. The engine never
 * touches OUR transpose; `displayKey` adds that shift, once, at one call site.
 * Tapping downstream would bake the shift into the chroma and adding it again
 * would double-count — same feature, opposite sign, and BOTH look correct in
 * review. chroma.js's header says the same thing from the other end and
 * `transpose-composition` is the assertion that will not let the tap move
 * silently.
 *
 * WHAT THAT DOES *NOT* MEAN. THE ENGINE REPORTS THE KEY THAT IS PLAYING — that
 * sentence is the contract and it has not moved. What has moved is what it
 * costs, and this paragraph is the second correction it has had, so read the
 * history rather than only the conclusion:
 *
 *   - it once read "the engine reports the RECORDING's own key", which the
 *     shipped code contradicted. Corrected 2026-08-16;
 *   - the correction then said the SPEED control clears `preservesPitch`, so at
 *     any rate other than 1 the audio ENTERING the ring is transposed by
 *     `12*log2(rate)` and `concertTonic` is the sounding tonic of transposed
 *     audio. **That is no longer true.** RULED 2026-08-17: SPEED IS
 *     PITCH-PRESERVING. `speed.js`'s `SPEED_KEY_LOCK` is written to
 *     `video.preservesPitch` on every rate write, so the audio entering the ring
 *     is at the recording's own pitch AT EVERY RATE.
 *
 * So the two readings now COINCIDE — the sounding tonic and the recording's
 * tonic are the same number at 0.50x as at 2.00x — and this tap needs no rate
 * term, which is why there is none in the code. `qa/speed-pitch.mjs` is the gate
 * that keeps it that way, and it asserts the engine reads no page rate at all.
 *
 * WHAT DOES STILL MOVE WITH THE RATE IS THE TEMPO, and that is correct and
 * unchanged: `bpmtap.js` reads the same ring and reports the played tempo, which
 * a rate change scales. Speed moves the tempo, TRANSPOSE moves the key, and
 * after the ruling those are the only two things either of them does.
 *
 * The paragraph that used to sit here — offering the recording's tonic as
 * `concertTonic - 12*log2(rate)` for a downstream surface — is DELETED rather
 * than kept, because under key lock that expression is wrong by exactly the
 * amount it used to correct.
 *
 * ------------------------------------------------- WHICH END OF THE RING
 *
 * The WRITE pointer, walked forward by a cursor, not the read pointer.
 *
 * The key is a property of the TRACK, not of the playhead, so there is no
 * correctness argument for the read pointer — and there is a real product
 * argument against it. `DISPLAY_POLICY.minListenSec` is 8 s of music; anchoring
 * at the read pointer would start that clock only when playback ARMS, which at
 * hop 1.95 is ~3.4 s after LIVE_START, so the key would appear ~11.5 s in.
 * Anchoring at the write pointer overlaps the listening window with the priming
 * window and the label is usually up by the time the first sound is.
 *
 * THE CURSOR IS WHY THIS IS NOT JUST `writeFrames()`. A live deck publishes ONE
 * HOP at a time — the write pointer stands still for 1.95 s and then jumps
 * ~86 000 frames — so sampling "the newest window" at 10 Hz would analyse one
 * 371 ms window per hop and throw away 80 % of the audio. The cursor advances by
 * a fixed 4410 frames per accepted window and catches up at up to 4x real time,
 * so every part of the track is seen exactly once. That last clause is the point
 * and it is asserted: `never-counts-the-same-audio-twice`. Without it a PAUSED
 * cached deck would re-analyse its last window ten times a second and drive the
 * confidence up on four seconds of audio.
 *
 * ------------------------------------------ REFUSING RATHER THAN GUESSING
 *
 * `readStemWindow` returns false when the span it was asked for is not there —
 * before frame 0, past the write pointer, or already lapped by the producer. The
 * accumulator is NOT fed on a false. AGENTS.md, "an assertion must FAIL when it
 * cannot look", one level down into the product: a key computed from a window
 * that was half old audio and half new is a real-looking answer to a question
 * nobody asked, and nothing downstream could ever tell it apart from a good one.
 *
 * The two refusals are counted SEPARATELY on purpose. `earlyWindows` is the
 * startup ramp and is expected. `staleWindows` is the producer lapping the
 * consumer, which cannot happen with an 11.89 s ring and a 371 ms window and
 * therefore means something is badly wrong — lumping them into one counter would
 * hide the second inside the first.
 *
 * And `state: 'none'` is a first-class answer. It means the tap has not counted
 * a single frame — silence, or every window refused. It is deliberately NOT
 * `listening`, which means "I am looking and do not know yet": a tap that can
 * never see anything must not present as one that is making progress.
 */

import { rfft } from './fft.js';
import {
  CHROMA_FFT_SIZE, createChromaAccumulator, createKeyDisplay, DISPLAY_POLICY, MODES,
} from './chroma.js';

/**
 * `other` is stem index 2, so it is planes 4 and 5 — `stemIdx * 2 + ch`.
 * shared/stemring.js PLANES is the authority: drums.L drums.R bass.L bass.R
 * other.L other.R vocals.L vocals.R guitar.L guitar.R piano.L piano.R pass.L
 * pass.R.
 *
 * THESE TWO NUMBERS ARE DERIVED FROM `STEMS.indexOf('other') === 2` AND FROM
 * NOTHING ELSE. They survived the four-stem -> six-stem widening untouched for
 * exactly one reason: the new stems APPEND, so `other` did not move
 * (docs/SIX-STEM-CONTRACT.md, "Wire order"). A future reorder that puts `other`
 * anywhere else silently retunes the key detector to a different instrument
 * group — and it would still lock onto SOMETHING, so nothing downstream could
 * tell. `tap-point-is-the-other-stem` in the self-check below is the tripwire:
 * it reads `STEMS` and `PLANES` and fails if either stops agreeing with these
 * literals. Do not "fix" that assertion by editing the expected numbers.
 */
export const KEY_TAP_PLANE_L = 4;
export const KEY_TAP_PLANE_R = 5;

/**
 * ABSOLUTE, NON-DESTRUCTIVE read of one stem-ring plane — the stem ring's
 * equivalent of `RingConsumer.readAt` plus `engine/live.js::readWindow`'s
 * residency check, in one function because there is exactly one caller and the
 * check is the whole point of it.
 *
 * Unlike `readWindow` this does NOT zero-fill what is missing. Live mode
 * zero-fills because a zero-padded left context is what the causal window wants
 * at startup; an FFT of a half-zeroed window is just a wrong spectrum.
 *
 * The residency test is repeated AFTER the copy. The producer writes one hop at
 * a time and the tail is ~9.5 s away from anything this reads, so the race is
 * not reachable in the shipped configuration — but it is two lines, and "not
 * reachable today" is how the ponytail in shared/stemring.js starts.
 *
 * @param {{planes:Float32Array[], cap:number, mask:number, writeFrames:()=>number}} ring
 * @param {number} plane index into PLANES
 * @param {number} from absolute frame
 * @param {number} n frames
 * @param {Float32Array} dst
 * @returns {'ok'|'early'|'stale'} 'early' = before frame 0 or past the write
 *          pointer; 'stale' = the producer has already overwritten it.
 */
export function readStemWindow(ring, plane, from, n, dst) {
  if (from < 0 || from + n > ring.writeFrames()) return 'early';
  if (from < ring.writeFrames() - ring.cap) return 'stale';
  const p = ring.planes[plane];
  const start = from & ring.mask;
  const first = Math.min(n, ring.cap - start);
  dst.set(p.subarray(start, start + first), 0);
  if (n > first) dst.set(p.subarray(0, n - first), first);
  return from < ring.writeFrames() - ring.cap ? 'stale' : 'ok';
}

/**
 * How far the cursor moves per accepted window, frames. 4410 = 0.1 s, so ten
 * accepted windows are one second of music and `elapsedSec` below is a real
 * duration rather than a wall-clock guess.
 */
export const KEY_WINDOW_ADVANCE = 4410;
/** Windows per `tick()`. 4 x 4410 is 4x real time — enough to absorb a hop. */
export const KEY_MAX_WINDOWS_PER_TICK = 4;
/**
 * If the cursor is further behind the producer than this, give up on the gap and
 * jump to the newest audio. One hop at the largest offered hop (3.9 s) is
 * 172 000 frames and must NOT trigger this — the cursor is supposed to catch up
 * through a hop, that is what it is for. 8 s is comfortably past any hop and
 * comfortably inside the 11.89 s ring, so the only thing that reaches it is a
 * deck that was starved or suspended for seconds.
 */
export const KEY_CATCHUP_FRAMES = 8 * 44100;

export class KeyTap {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate]
   * @param {number} [o.fftSize] CHROMA_FFT_SIZE. Set by the LOW end of the band:
   *        a semitone at C2 spans 3.9 Hz and 8192 points cannot resolve it.
   */
  constructor(o = {}) {
    this.sr = o.sampleRate || 44100;
    this.n = o.fftSize || CHROMA_FFT_SIZE;
    this.advance = o.advance || KEY_WINDOW_ADVANCE;
    this.maxPerTick = o.maxPerTick || KEY_MAX_WINDOWS_PER_TICK;
    this.policy = o.policy || DISPLAY_POLICY;
    /** how many accepted windows between re-correlations. 10 Hz in, ~2 Hz out. */
    this.every = Math.max(1, Math.round((o.accumHz || 10) / (o.estimateHz || 2)));

    // scratch, allocated once — this runs on the offscreen main thread beside
    // the pump and must not churn.
    this.l = new Float32Array(this.n);
    this.r = new Float32Array(this.n);
    this.win = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) this.win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.n));
    this.buf = new Float64Array(this.n);
    this.re = new Float64Array(this.n / 2 + 1);
    this.im = new Float64Array(this.n / 2 + 1);
    this.mag = new Float32Array(this.n / 2 + 1);

    this.acc = createChromaAccumulator();
    this.display = createKeyDisplay(this.policy);
    this.reset();
  }

  /**
   * TRACK CHANGE, SEEK, DECK LOAD, LIVE RESTART — docs/ARCHITECTURE.md §3.9's
   * discontinuity hook. Everything goes, including the hysteresis gate: holding
   * the previous track's label over a new one is the single most confusing thing
   * this feature could do, because the label is CORRECT-LOOKING and the user is
   * fingering an instrument against it.
   */
  reset() {
    this.acc.reset();
    this.display.reset();
    /** absolute frame the next window ENDS at. null until the first tick. */
    this.cursor = null;
    this.windows = 0;         // accepted, i.e. read AND non-silent
    this.earlyWindows = 0;    // before frame 0 or past the write pointer
    this.staleWindows = 0;    // THE producer lapped us. Should never be non-zero.
    this.silentWindows = 0;   // read fine, carried no energy
    this.estimates = 0;
    this.jumps = 0;           // cursor gave up on a gap and jumped forward
    this.last = null;         // last correlateKey result
    this.painted = null;      // last createKeyDisplay verdict
    this.nonFinite = 0;       // confidences that were not a number. Must stay 0.
  }

  /** Seconds of music actually counted. NOT wall time — see KEY_WINDOW_ADVANCE. */
  get elapsedSec() { return (this.acc.frames * this.advance) / this.sr; }

  /**
   * Advance the tap against a stem ring. Call at ~10 Hz; it paces itself off the
   * cursor, so calling it more or less often changes latency, not weighting.
   *
   * @param {{planes:Float32Array[], cap:number, mask:number, writeFrames:()=>number}} ring
   * @returns {number} windows accepted this tick
   */
  tick(ring) {
    if (!ring) return 0;
    const w = ring.writeFrames();
    if (this.cursor === null) this.cursor = Math.max(0, w);
    // A gap bigger than any hop means the deck was starved, suspended or reset
    // under us. Analysing our way through it would spend seconds reporting the
    // key of audio nobody is anywhere near.
    if (w - this.cursor > KEY_CATCHUP_FRAMES) { this.cursor = w; this.jumps++; }

    let taken = 0, accepted = 0;
    while (taken < this.maxPerTick && this.cursor + this.advance <= w) {
      this.cursor += this.advance;
      taken++;
      const from = this.cursor - this.n;
      const a = readStemWindow(ring, KEY_TAP_PLANE_L, from, this.n, this.l);
      if (a !== 'ok') { if (a === 'stale') this.staleWindows++; else this.earlyWindows++; continue; }
      const b = readStemWindow(ring, KEY_TAP_PLANE_R, from, this.n, this.r);
      if (b !== 'ok') { if (b === 'stale') this.staleWindows++; else this.earlyWindows++; continue; }
      if (this._fold()) { this.windows++; accepted++; } else this.silentWindows++;
    }
    if (accepted && this.acc.frames % this.every === 0) this._estimate();
    return accepted;
  }

  /** One window: mono-sum, Hann, rfft, magnitudes, accumulate. */
  _fold() {
    const n = this.n, l = this.l, r = this.r, win = this.win, buf = this.buf;
    // Mono sum before the transform, not two transforms: the chroma fold throws
    // the stereo image away anyway and this halves the only expensive step.
    for (let i = 0; i < n; i++) buf[i] = (l[i] + r[i]) * 0.5 * win[i];
    rfft(buf, 0, n, this.re, this.im, 0, 1);
    const re = this.re, im = this.im, mag = this.mag;
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    // LINEAR magnitudes, which is what foldChroma's float path wants. Passing
    // getFloatFrequencyData's dB here would fold to zeros and read as silence.
    return this.acc.add(mag, this.sr, n);
  }

  _estimate() {
    this.last = this.acc.estimate();
    this.painted = this.display.update(this.last, this.elapsedSec);
    this.estimates++;
  }

  /**
   * THE WIRE CONTRACT, fixed by the spec, and this is the only place it is built.
   *
   *   { state: 'listening' | 'locked' | 'none',
   *     concertTonic: 0..11 | null,
   *     mode: 'major' | 'minor' | null,
   *     confidence: number }
   *
   * `concertTonic` is the SOUNDING tonic — the key of the audio that is
   * PLAYING, at whatever speed it is playing at. Since the 2026-08-17 ruling
   * that is ALSO the recording's own tonic at every rate: the SPEED control
   * key-locks the element (`speed.js`'s `SPEED_KEY_LOCK`), so nothing reaches
   * the capture ring transposed and this field needs no rate term. See this
   * file's header, THE TAP POINT, for the two corrections that got here. The
   * engine never
   * applies OUR transpose offset and never learns which instrument the user
   * plays; the UI calls
   * `chroma.js::displayKey(concertTonic, mode, semitones, instrument)`,
   * which is one mod-12 at one call site. Adding a `writtenTonic` or a
   * `soundingTonic` here would be the second call site, and AGENTS.md's
   * entry-point rule exists because this repo has had four defects from a value
   * being right at one and wrong at another.
   *
   * The three states, and why `none` is not `listening`:
   *   none       nothing has been counted — the deck is silent, or every window
   *              was refused. The tap cannot see, and says so.
   *   listening  frames are being counted and the display gate is not satisfied
   *              yet: under `minListenSec`, or the margin is under
   *              `minConfidence`. This is progress.
   *   locked     the gate is showing a label. It covers the gate's own `showing`
   *              AND `holding` — `holding` means "a label is up and this update
   *              could not confirm it", and blanking a label mid-song reads as a
   *              crash (chroma.js createKeyDisplay).
   */
  payload() {
    const p = this.painted;
    // NOTHING ON THE WIRE MAY BE NaN (qa/live-wire.mjs asserts it across every
    // engine -> UI message, and a console that renders `Number(NaN) || 0` shows a
    // confident zero for a feed that has died). A non-finite confidence is not
    // reachable from `correlateKey` — it is `best - second` of two finite
    // correlations — so it is COUNTED rather than swallowed: `stats().nonFinite`
    // going above zero means something upstream broke, and a wire value of 0
    // would otherwise be indistinguishable from an honest weak match.
    const conf = (c) => {
      if (Number.isFinite(c)) return +c.toFixed(4);
      this.nonFinite++;
      return 0;
    };
    if (!p || this.acc.frames === 0 || p.tonic < 0) {
      return {
        state: this.acc.frames === 0 ? 'none' : 'listening',
        concertTonic: null, mode: null,
        confidence: p ? conf(p.confidence) : 0,
      };
    }
    return {
      state: 'locked',
      concertTonic: p.tonic,
      mode: p.mode,
      confidence: conf(p.confidence),
    };
  }

  /**
   * Diagnostics. NOT on the UI contract — this is the harness surface, and it
   * exists because `payload()` alone cannot tell "the tap looked and is not sure"
   * from "the tap has never once managed to read a window", and those two report
   * the same `listening`-shaped nothing to a gate.
   */
  stats() {
    return {
      windows: this.windows,
      frames: this.acc.frames,
      silentWindows: this.silentWindows,
      accSilentFrames: this.acc.silentFrames,
      earlyWindows: this.earlyWindows,
      staleWindows: this.staleWindows,
      jumps: this.jumps,
      estimates: this.estimates,
      nonFinite: this.nonFinite,
      elapsedSec: +this.elapsedSec.toFixed(2),
      cursor: this.cursor,
      minListenSec: this.policy.minListenSec,
      minConfidence: this.policy.minConfidence,
      r: this.last ? +this.last.r.toFixed(4) : null,
    };
  }
}

// ===================================================================== self-check
//
// `node extension/engine/keytap.js`.

async function selfCheck() {
  const { StemRingWriter, PLANES } = await import('../shared/stemring.js');
  const { RING_PLANES, STEMS } = await import('../shared/config.js');
  const { keyName } = await import('./chroma.js');

  const FS = 44100;
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // ---- the same synthesis chroma.js uses: six harmonics at 1/n, so harmonic
  // leakage (a fifth and a third above every note) is present. A pure-sine chord
  // is unrealistically easy and never exercises the thing that is actually hard.
  const HARMONICS = 6;
  function addNote(buf, midi, startSec, durSec, amp, rnd) {
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const s0 = Math.round(startSec * FS), n = Math.round(durSec * FS);
    const atk = Math.max(1, Math.round(0.015 * FS));
    const rel = Math.max(1, Math.round(0.030 * FS));
    const ph = [];
    for (let h = 1; h <= HARMONICS; h++) ph.push(rnd() * 2 * Math.PI);
    for (let i = 0; i < n; i++) {
      const t = i / FS;
      let e = i < atk ? i / atk : Math.exp(-2.0 * (i - atk) / n);
      if (i > n - rel) e *= (n - i) / rel;
      let v = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        const f = f0 * h;
        if (f > FS / 2) break;
        v += Math.sin(2 * Math.PI * f * t + ph[h - 1]) / h;
      }
      const j = s0 + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * e * v;
    }
  }
  const PROG = {
    major: [{ b: 0, c: [0, 4, 7] }, { b: 5, c: [5, 9, 12] }, { b: 7, c: [7, 11, 14, 17] }, { b: 0, c: [0, 4, 7] }],
    minor: [{ b: 0, c: [0, 3, 7] }, { b: 5, c: [5, 8, 12] }, { b: 7, c: [7, 11, 14, 17] }, { b: 0, c: [0, 3, 7] }],
  };
  function progression(tonic, mode, seed, bars = 16, barSec = 2.0) {
    const rnd = mulberry32(seed);
    const buf = new Float32Array(Math.round(bars * barSec * FS));
    const prog = PROG[mode];
    for (let b = 0; b < bars; b++) {
      const c = prog[b % prog.length], t0 = b * barSec;
      addNote(buf, 48 + tonic + c.b, t0, barSec * 0.95, 0.55, rnd);
      for (const iv of c.c) addNote(buf, 60 + tonic + iv, t0, barSec * 0.95, 0.30, rnd);
      for (let q = 0; q < 4; q++) {
        const deg = c.c[q % c.c.length] - c.c[0];
        addNote(buf, 72 + tonic + c.c[0] + deg, t0 + q * barSec / 4, barSec / 4 * 0.9, 0.22, rnd);
      }
    }
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / peak;
    return buf;
  }

  /** A real StemRingWriter over a real ArrayBuffer, fed like the live deck feeds it. */
  function makeRing(cap = 1 << 19) {
    const sab = new ArrayBuffer(128 + cap * 4 * RING_PLANES);
    return new StemRingWriter(sab, cap);
  }
  /** Publish `len` frames of `pcm` on the `other` planes, everything else silent. */
  function publish(ring, pcm, from, len, planes) {
    for (let q = 0; q < RING_PLANES; q++) planes[q].fill(0, 0, len);
    for (let i = 0; i < len; i++) {
      const v = from + i < pcm.length ? pcm[from + i] : 0;
      planes[KEY_TAP_PLANE_L][i] = v;
      planes[KEY_TAP_PLANE_R][i] = v;
    }
    return ring.write(from, planes, len);
  }

  console.log('\x1b[1mkeytap.js self-check\x1b[0m');

  // ==================================================== 1. the tap point
  head('1. the tap point, and readStemWindow');
  {
    // THE ENTRY POINT: the module-level constants KEY_TAP_PLANE_L/R, as read by
    // KeyTap.tick(). Everything else in this file is downstream of them pointing
    // at `other`. Written as three separate facts because they can break
    // independently: the model's source order, the ring's plane layout, and the
    // two literals that join them.
    const otherIdx = STEMS.indexOf('other');
    ok('tap-point-is-the-other-stem: STEMS still puts `other` at index 2, which is the ONLY thing KEY_TAP_PLANE_L/R are derived from',
      otherIdx === 2, `STEMS = [${STEMS.join(', ')}], other at ${otherIdx}`);
    ok('tap-point-planes-follow-stemIdx*2+ch (a reorder or an inserted stem must land here, not in a mis-keyed display)',
      KEY_TAP_PLANE_L === otherIdx * 2 && KEY_TAP_PLANE_R === otherIdx * 2 + 1,
      `planes ${KEY_TAP_PLANE_L}/${KEY_TAP_PLANE_R}, stemIdx*2 = ${otherIdx * 2}`);
    // PLANES is the ring's own authority and is hand-written, so this is a real
    // second opinion rather than the same expression twice. It also fails when
    // the plane simply is not there — an out-of-range index reads `undefined`,
    // which is not 'other.L'.
    ok('tap-point-names-are-other.L-and-other.R in shared/stemring.js PLANES',
      PLANES[KEY_TAP_PLANE_L] === 'other.L' && PLANES[KEY_TAP_PLANE_R] === 'other.R',
      `PLANES[${KEY_TAP_PLANE_L}] = ${PLANES[KEY_TAP_PLANE_L]}, PLANES[${KEY_TAP_PLANE_R}] = ${PLANES[KEY_TAP_PLANE_R]}`);
    ok('the-ring-is-wide-enough-for-every-stem-plus-passthrough (RING_PLANES and PLANES cannot disagree)',
      PLANES.length === RING_PLANES && RING_PLANES === STEMS.length * 2 + 2,
      `${STEMS.length} stems -> ${STEMS.length * 2 + 2} planes; RING_PLANES ${RING_PLANES}, PLANES ${PLANES.length}`);
  }
  {
    const cap = 1 << 16;
    const ring = makeRing(cap);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(8192));
    const ramp = new Float32Array(cap * 3);
    for (let i = 0; i < ramp.length; i++) ramp[i] = Math.sin(i * 0.001);
    for (let p = 0; p < 8192 * 4; p += 8192) publish(ring, ramp, p, 8192, planes);
    // the consumer must keep up or write() refuses, so pretend it has
    const dst = new Float32Array(4096);

    ok('stem-window-read-refuses-a-span-before-frame-0',
      readStemWindow(ring, KEY_TAP_PLANE_L, -100, 4096, dst) === 'early');
    ok('stem-window-read-refuses-a-span-past-the-write-pointer',
      readStemWindow(ring, KEY_TAP_PLANE_L, ring.writeFrames() - 100, 4096, dst) === 'early');

    const from = 8192 * 2 + 17;
    const st = readStemWindow(ring, KEY_TAP_PLANE_L, from, 4096, dst);
    let bad = -1;
    for (let i = 0; i < 4096; i++) if (dst[i] !== ramp[from + i]) { bad = i; break; }
    ok('stem-window-read-is-exact: a non-destructive absolute read returns the frames that were written, including across the wrap',
      st === 'ok' && bad < 0, st === 'ok' ? (bad < 0 ? '4096 frames identical' : `first mismatch at ${bad}`) : `read returned ${st}`);

    // Lap the tail: advance the consumer and the producer past a whole capacity,
    // then ask for the span we started with.
    Atomics.store(ring.hdr, 1, ring.writeFrames());
    for (let p = ring.writeFrames(); p < cap + 8192 * 4; p += 8192) {
      Atomics.store(ring.hdr, 1, ring.writeFrames());
      publish(ring, ramp, p, 8192, planes);
    }
    ok('stem-window-read-refuses-a-lapped-span (rather than FFT-ing a window that is half old audio and half new)',
      readStemWindow(ring, KEY_TAP_PLANE_L, from, 4096, dst) === 'stale',
      `write pointer ${ring.writeFrames()}, capacity ${cap}, asked for ${from}`);
  }

  // ==================================================== 2. end to end
  head('2. the tap, against a real stem ring');
  {
    // Drive it exactly as the deck does: publish one hop at a time, tick at
    // 10 Hz between hops. That shape is the whole reason the cursor exists —
    // the write pointer stands still for 1.95 s and then jumps 86 000 frames.
    const HOP = Math.round(1.95 * FS);
    let locked = 0, wrong = '';
    const tried = [0, 3, 7, 9];
    for (const tonic of tried) {
      const pcm = progression(tonic, 'major', 900 + tonic);
      const ring = makeRing();
      const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(HOP));
      const tap = new KeyTap();
      for (let p = 0; p + HOP <= pcm.length; p += HOP) {
        Atomics.store(ring.hdr, 1, Math.max(0, p - 4 * FS));   // a plausible playhead
        publish(ring, pcm, p, HOP, planes);
        for (let t = 0; t < 20; t++) tap.tick(ring);            // 1.95 s at 10 Hz
      }
      const k = tap.payload();
      if (k.state === 'locked' && k.concertTonic === tonic && k.mode === 'major') locked++;
      else if (!wrong) wrong = `${keyName(tonic, 'major')} -> ${k.state} ${k.concertTonic === null ? '-' : keyName(k.concertTonic, k.mode || 'major')} conf ${k.confidence}`;
      if (tonic === tried[0]) {
        const s = tap.stats();
        console.log(`      ${keyName(tonic, 'major')}: ${JSON.stringify(s)}`);
        ok('the-tap-never-refused-a-window-it-should-have-had (staleWindows is a producer lapping the consumer and must be 0)',
          s.staleWindows === 0 && s.windows > 100, `${s.windows} accepted, ${s.earlyWindows} early, ${s.staleWindows} stale, ${s.jumps} jumps`);
        ok('a-hop-sized-jump-does-not-trip-the-catch-up (the cursor is supposed to walk through a hop, not skip it)',
          s.jumps === 0, `${s.jumps} jumps over ${(pcm.length / FS).toFixed(0)} s at hop 1.95`);
      }
    }
    ok('key-tap-locks-onto-the-recording-key-through-the-real-ring',
      locked === tried.length, `${locked}/${tried.length} keys${wrong ? ', first miss: ' + wrong : ''}`);
  }

  // ==================================================== 3. it must not guess
  head('3. refusing rather than guessing');
  {
    // Silence. Not "listening" — the tap has counted nothing and must say so.
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 15));
    const tap = new KeyTap();
    const silence = new Float32Array(20 * FS);
    for (let p = 0; p + (1 << 15) <= silence.length; p += 1 << 15) {
      Atomics.store(ring.hdr, 1, ring.writeFrames());
      publish(ring, silence, p, 1 << 15, planes);
      for (let t = 0; t < 8; t++) tap.tick(ring);
    }
    const k = tap.payload(), s = tap.stats();
    ok('a-silent-stem-reports-none-not-listening (a tap that can never see anything must not present as one making progress)',
      k.state === 'none' && k.concertTonic === null && k.mode === null && s.silentWindows > 50,
      `${JSON.stringify(k)} after ${s.silentWindows} silent windows, ${s.windows} accepted`);
  }
  {
    // Every window lapped. The cursor is parked deep enough inside the
    // overwritten region that all 20 windows stay there, and far enough forward
    // that KEY_CATCHUP_FRAMES does not rescue it — this is the branch that must
    // never quietly become 'listening'.
    const cap = 1 << 16;
    const ring = makeRing(cap);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(8192));
    const pcm = progression(0, 'major', 1234, 8);
    const tap = new KeyTap();
    tap.maxPerTick = 1;
    for (let p = 0; p + 8192 <= pcm.length; p += 8192) {
      Atomics.store(ring.hdr, 1, ring.writeFrames());
      publish(ring, pcm, p, 8192, planes);
    }
    const ticks = 20;
    const oldest = ring.writeFrames() - cap;
    tap.cursor = oldest - ticks * KEY_WINDOW_ADVANCE - 1000;
    const behind = ring.writeFrames() - tap.cursor;
    for (let t = 0; t < ticks; t++) tap.tick(ring);
    const k = tap.payload(), s = tap.stats();
    ok('a-lapped-span-is-refused-and-counted-as-stale, and the tap reports none rather than a key built from torn audio',
      behind < KEY_CATCHUP_FRAMES && s.jumps === 0 && s.staleWindows === ticks && s.windows === 0 && k.state === 'none',
      `${s.staleWindows}/${ticks} stale, ${s.windows} accepted, ${s.jumps} jumps, state ${k.state} (cursor was ${behind} frames behind, catch-up fires at ${KEY_CATCHUP_FRAMES})`);
  }
  {
    // The same audio must not be counted twice: a PAUSED deck stops advancing
    // the write pointer, and a tap that re-analysed its last window ten times a
    // second would drive the confidence up on four seconds of music.
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 16));
    const pcm = progression(0, 'major', 55, 8);
    const tap = new KeyTap();
    Atomics.store(ring.hdr, 1, 0);
    publish(ring, pcm, 0, 1 << 16, planes);
    // Start the cursor at the first frame that HAS a full window behind it; left
    // to itself it would start at the write pointer and correctly do nothing,
    // which is the same green for the opposite reason.
    tap.cursor = CHROMA_FFT_SIZE;
    for (let t = 0; t < 200; t++) tap.tick(ring);     // 20 s of ticks, no new audio
    const s = tap.stats();
    const available = Math.floor(((1 << 16) - CHROMA_FFT_SIZE) / KEY_WINDOW_ADVANCE);
    ok('never-counts-the-same-audio-twice: 200 ticks over a frozen write pointer take each window once and then stop',
      s.windows + s.silentWindows + s.earlyWindows === available && s.windows > 0,
      `${available} windows of audio behind the frozen pointer, ${s.windows} accepted + ${s.silentWindows} silent + ${s.earlyWindows} early over 200 ticks (800 windows' worth of opportunity)`);
  }

  // ==================================================== 4. the wire contract
  head('4. the wire contract');
  {
    const tap = new KeyTap();
    const fresh = tap.payload();
    ok('key-payload-is-exactly-the-four-contract-fields, in every state',
      JSON.stringify(Object.keys(fresh).sort()) === JSON.stringify(['concertTonic', 'confidence', 'mode', 'state']),
      Object.keys(fresh).join(','));
    // qa/live-wire.mjs walks every engine -> UI message for NaN and Infinity.
    const nanTap = new KeyTap();
    nanTap.acc.add(new Float32Array(nanTap.n / 2 + 1).fill(0.01), FS, nanTap.n);
    nanTap.painted = { state: 'showing', tonic: 4, mode: 'major', confidence: NaN, streak: 0 };
    const bad = nanTap.payload();
    ok('a-non-finite-confidence-never-reaches-the-wire-and-is-counted-rather-than-swallowed',
      Number.isFinite(bad.confidence) && nanTap.stats().nonFinite === 1 && new KeyTap().stats().nonFinite === 0,
      `confidence ${bad.confidence}, nonFinite ${nanTap.stats().nonFinite}`);
    ok('a-tap-that-has-never-ticked-reports-none', fresh.state === 'none' && fresh.concertTonic === null);

    // The engine reports CONCERT tonic only. There is no shift on this object
    // and no way to put one there — the check is that nothing in the payload or
    // the stats can be mistaken for a transposed or written tonic, because the
    // second place a mod-12 happens is where the double-count is born.
    const keys = [...Object.keys(fresh), ...Object.keys(tap.stats())].join(' ');
    ok('the-engine-exposes-no-shifted-or-written-tonic (displayKey is the ONE call site that composes the transpose)',
      !/semitone|shift|written|sounding|instrument|transpos/i.test(keys), keys);

    // And the three states are the three the contract names, nothing else.
    const seen = new Set();
    const t2 = new KeyTap();
    seen.add(t2.payload().state);
    t2.acc.add(new Float32Array(t2.n / 2 + 1).fill(0.01), FS, t2.n);   // a flat frame
    t2.painted = { state: 'listening', tonic: -1, mode: null, confidence: 0, streak: 0 };
    seen.add(t2.payload().state);
    t2.painted = { state: 'showing', tonic: 9, mode: 'minor', confidence: 0.2, streak: 0 };
    seen.add(t2.payload().state);
    ok('state-is-only-ever-listening-locked-or-none',
      [...seen].every((s) => ['listening', 'locked', 'none'].includes(s)) && seen.size === 3,
      [...seen].join(','));
    ok('the-gate-holding-a-label-still-reads-locked (blanking a label mid-song reads as a crash)',
      (() => { t2.painted = { state: 'holding', tonic: 9, mode: 'minor', confidence: 0, streak: 0 }; return t2.payload().state === 'locked' && t2.payload().concertTonic === 9; })());
    ok('mode-is-only-ever-major-minor-or-null',
      MODES.length === 2 && MODES.includes('major') && MODES.includes('minor'));
  }

  // ==================================================== 5. discontinuity
  head('5. the discontinuity hook');
  {
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 16));
    const tap = new KeyTap();
    const a = progression(0, 'major', 77);
    for (let p = 0; p + (1 << 16) <= a.length; p += 1 << 16) {
      Atomics.store(ring.hdr, 1, ring.writeFrames());
      publish(ring, a, p, 1 << 16, planes);
      for (let t = 0; t < 8; t++) tap.tick(ring);
    }
    const before = tap.payload();
    tap.reset();
    const after = tap.payload(), s = tap.stats();
    ok('reset-drops-the-label-and-the-accumulator (holding the previous track key over a new one is correct-looking and the worst thing this feature could do)',
      before.state === 'locked' && after.state === 'none' && s.frames === 0 && s.windows === 0 && s.cursor === null,
      `${before.state} -> ${after.state}, ${s.frames} frames`);
  }

  // ==================================================== 6. cost
  head('6. cost');
  {
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 17));
    const pcm = progression(0, 'major', 5, 8);
    publish(ring, pcm, 0, 1 << 17, planes);
    const tap = new KeyTap();
    tap.cursor = CHROMA_FFT_SIZE;
    tap.maxPerTick = 1;
    const reps = 200;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) { tap.cursor = CHROMA_FFT_SIZE + (i % 8) * 1024; tap.tick(ring); }
    const per = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    console.log(`      one 16384-point window (read + Hann + rfft + fold + accumulate): ${per.toFixed(3)} ms`);
    console.log(`      at 10 Hz that is ${(per * 10).toFixed(2)} ms per second of the offscreen MAIN thread`);
    ok('cost-one-window-under-5ms (this runs on the main thread beside the pump, never on the render deadline)',
      per < 5, `${per.toFixed(3)} ms`);
  }

  console.log(fail ? `\n\x1b[31m${fail} FAILURE(S)\x1b[0m of ${pass + fail}\n` : `\nall ${pass} keytap checks passed\n`);
  process.exit(fail ? 1 : 0);
}

if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return selfCheck();
  }).catch((e) => { console.error(e); process.exit(1); });
}
