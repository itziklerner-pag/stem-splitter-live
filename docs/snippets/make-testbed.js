#!/usr/bin/env node
// make-testbed.js — synthesise a deterministic 6-source multitrack with exact
// ground truth, for automated separation QA. See docs/AUDIO.md §6.
//
//   node make-testbed.js ./testbed        [seconds] [bpm]     musical material
//   node make-testbed.js ./testbed-steady  [seconds] [bpm] --steady
//                                                            stationary material,
//                                                            for the seam gate
//   node make-testbed.js --check                             run the honesty gate
//                                                            (no files written)
//
// Emits, at 44100 Hz / stereo / 32-bit float:
//   mix.wav  drums.wav  bass.wav  other.wav  vocals.wav  guitar.wav  piano.wav
// Invariant: mix === drums + bass + other + vocals + guitar + piano, sample-exact,
// by construction. The source names and their ORDER are `STEMS` from
// extension/shared/config.js — imported, not re-declared, and asserted in
// `checkTestbed()` below. That drift is what this file existed in a 4-wide state
// long enough to prove: see docs/SIX-STEM-CONTRACT.md "Known debt", item 4.
//
// The material is deliberately synthetic so that ground truth is exact and the
// file is reproducible from this script alone (no licensing, no download).
// It is OUT OF DISTRIBUTION for HT-Demucs, so the absolute SDR will be lower
// than on real music. Use it as a REGRESSION gate against a recorded golden run,
// not as an absolute quality bar. For absolute quality, run one MUSDB18-HQ track.
//
// ---------------------------------------------------------------------------
// WHY GUITAR AND PIANO ARE WRITTEN THE WAY THEY ARE
//
// A guitar that is a copy of `other` teaches the gates nothing; a guitar in a
// band of its own makes separation look far better than it is. Both are graded
// by `checkTestbed()`, which asserts the two properties as numbers:
//
//   CONFUSABLE  guitar, piano and `other` play the SAME four-bar progression in
//               the SAME key as the vocal line, in overlapping registers. Their
//               octave-band energy profiles have cosine similarity > 0.5 — the
//               spectra genuinely collide, so a separator cannot win on a
//               band-split.
//   SEPARABLE   what differs is TIME and PARTIAL STRUCTURE, which is what a
//               separator actually has to use:
//                 guitar  purely harmonic (Karplus-Strong, no stiffness); a
//                         STRUM — six strings offset by 14 ms, alternating down
//                         and up strokes; broadband PICK noise (high-passed) in
//                         the first few ms; notes damped, no pedal.
//                 piano   INHARMONIC (f_n = n*f0*sqrt(1+B*n^2), B = 3.5e-4), so
//                         above the ~6th partial its overtones sit measurably
//                         sharp of the guitar's on the same note; per-partial
//                         decay (higher partials die faster); a HAMMER thump
//                         (low-passed) — the opposite end of the spectrum from
//                         the pick; sustain pedal, so notes ring across the
//                         chord change and blur.
//               No two sources share an onset grid, and the 20 ms log-energy
//               envelope correlation between any two distinct sources stays
//               below the leakage gate bss-eval.js applies to the estimates.
//
// TWO DELIBERATE CHANGES TO `other`, both of which a 6-stem model forces:
//
//   1. The Karplus-Strong pluck is GONE from `other` and lives in `guitar`.
//      htdemucs_6s pulls plucked strings OUT of `other` by definition. Leaving a
//      pluck in `other` would have made bss-eval.js's leakage gate — a hard FAIL
//      when a row's diagonal is not its maximum — fire on correct separation.
//      A false red is more expensive than a missing test.
//   2. `other` gains a staccato synth stab with a PLATEAU envelope (fast attack,
//      flat hold, fast release). Neither a plucked nor a hammered decay, so it
//      keeps `other` rhythmic without being mistakable for the two new stems.
//
// EVERY NOTE NOW ENDS ON A RELEASE TAPER. docs/AUDIO.md §6.2 claims "the material
// itself contains no sample-scale discontinuities — any spike in the output came
// from us." Before 6-stems that claim was FALSE: the bass, the kick, the snare,
// the hats and the old `other` pluck all simply STOPPED mid-decay, at 4.1 % /
// 6.9 % / 1.8 % / 5.0 % / 41 % of their own envelope respectively. Those steps
// sit inside the material the seam detector normalises against. `rel()` below
// fixes all of them. It is not asserted here — see the note where check 7 used
// to be, and the stationary seam numbers that measure it properly.
//
// ALL GOLDEN NUMBERS RECORDED AGAINST THE 4-SOURCE TESTBED ARE VOID. The mix is
// a different signal: two more sources, a different `other`, and a different
// peak-normalisation gain. Re-record, do not adjust the gates to match.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from './wav.js';
import { STEMS } from '../../extension/shared/config.js';

const FS = 44100;

export { STEMS };

const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- biquads (RBJ cookbook) -------------------------------------------------
export function biquad(type, f0, Q, fs = FS) {
  const w = (2 * Math.PI * f0) / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }
  else { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; }  // bp (0 dB peak)
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
export const bq = (f, x) => {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; return y;
};

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
// Raised-cosine attack. Real instruments have no slope discontinuity at onset;
// a linear ramp would put a sample-scale spike on every downbeat and confuse the
// seam detector in bss-eval.js.
const att = (u, ta = 0.0015) => (u >= ta ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * u) / ta));
// Release taper — the mirror image, and the reason AUDIO.md §6.2's "no
// sample-scale discontinuities" claim is now true. `i` samples into a note of
// `len` samples, fade over the last `ms`.
const rel = (i, len, ms = 12) => {
  const w = ms * 0.001 * FS, r = (len - 1 - i) / w;
  return r >= 1 ? 1 : r <= 0 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * r);
};
const addPan = (L, R, i, v, pan) => { const a = (pan + 1) * Math.PI / 4; L[i] += v * Math.cos(a); R[i] += v * Math.sin(a); };

/**
 * The one four-bar progression. `other`, `guitar` and `piano` all play it, in
 * the key the vocal melody is in. This is the whole confusability story: same
 * fundamentals, same overtone series below the 6th partial, overlapping
 * registers — nothing but time and partial structure to separate them by.
 * Am7 / Fmaj9 / Cmaj / Gsus-ish, voiced from A3.
 */
const CHORDS = [[57, 60, 64, 67], [53, 57, 60, 65], [60, 64, 67, 72], [55, 59, 62, 67]];

// ---- sources ----------------------------------------------------------------
function makeBass(N, spb, rnd) {
  const L = new Float32Array(N), R = new Float32Array(N);
  const roots = [33, 29, 36, 31];                       // A1 F1 C2 G1
  const lp = biquad('lp', 420, 0.9);
  for (let bar = 0; bar * 4 * spb < N; bar++) {
    const f = midi(roots[bar % roots.length]);
    for (let e = 0; e < 8; e++) {                       // 8 eighths per bar
      const t0 = Math.round((bar * 4 + e * 0.5) * spb);
      const len = Math.round(spb * 0.45);
      let ph = 0;
      for (let i = 0; i < len && t0 + i < N; i++) {
        const env = Math.exp(-3.2 * i / len) * att(i / FS, 0.004) * rel(i, len, 8);
        ph += f / FS; ph -= Math.floor(ph);
        let s = 0;
        for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * h * ph) / h;  // saw
        const v = bq(lp, s * 0.40 * env);
        addPan(L, R, t0 + i, v, 0);
      }
    }
  }
  return [L, R];
}

function makeDrums(N, spb, rnd) {
  const L = new Float32Array(N), R = new Float32Array(N);
  const hpH = biquad('hp', 7000, 0.7), bpS = biquad('bp', 1900, 0.8), hpS = biquad('hp', 220, 0.7);
  const kick = (t0) => { const len = Math.round(0.20 * FS); for (let i = 0; i < len && t0 + i < N; i++) { const u = i / FS; const f = 45 + 85 * Math.exp(-u / 0.020); const env = att(u) * Math.exp(-u / 0.075) * rel(i, len, 10); addPan(L, R, t0 + i, 0.85 * env * Math.sin(2 * Math.PI * f * u), 0); } };
  const snare = (t0) => { const len = Math.round(0.22 * FS); for (let i = 0; i < len && t0 + i < N; i++) { const u = i / FS; const env = att(u) * Math.exp(-u / 0.055) * rel(i, len, 10); const n = bq(hpS, bq(bpS, rnd() * 2 - 1)); addPan(L, R, t0 + i, env * (0.45 * n + 0.20 * Math.sin(2 * Math.PI * 185 * u)), 0); } };
  const hat = (t0, open) => { const d = open ? 0.11 : 0.030, len = Math.round(d * FS); for (let i = 0; i < len && t0 + i < N; i++) { const env = att(i / FS, 0.0008) * Math.exp(-(i / FS) / (d / 3)) * rel(i, len, 4); addPan(L, R, t0 + i, 0.16 * env * bq(hpH, rnd() * 2 - 1), 0.30); } };
  for (let b = 0; b * spb < N; b++) {
    const t = Math.round(b * spb), q = b % 4;
    if (q === 0 || q === 2) kick(t);
    if (q === 1 || q === 3) snare(t);
    if (q === 3) kick(Math.round((b + 0.75) * spb));
    hat(t, false); hat(Math.round((b + 0.5) * spb), q === 3);
  }
  return [L, R];
}

function makeVocals(N, spb, rnd) {
  const L = new Float32Array(N), R = new Float32Array(N);
  // /a/-ish formants
  const F = [biquad('bp', 700, 8), biquad('bp', 1220, 10), biquad('bp', 2600, 12)];
  const A = [1.0, 0.45, 0.22];
  const mel = [69, 71, 72, 71, 67, 69, 64, 67];         // A4 B4 C5 B4 G4 A4 E4 G4
  let ph = 0;
  for (let n = 0; n * spb < N; n++) {
    const f0 = midi(mel[n % mel.length]);
    const t0 = Math.round(n * spb), len = Math.round(spb * 0.82);
    for (let i = 0; i < len && t0 + i < N; i++) {
      const u = i / FS;
      const env = att(u, 0.030) * rel(i, len, 60) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 5.1 * u));
      const vib = f0 * (1 + 0.004 * Math.sin(2 * Math.PI * 5.1 * u));
      ph += vib / FS; ph -= Math.floor(ph);
      let g = 0;                                          // band-limited glottal pulse
      for (let h = 1; h <= 26; h++) g += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.25);
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[k] * bq(F[k], g);
      s += 0.010 * (rnd() * 2 - 1);                       // breath
      const v = 1.45 * env * s;
      addPan(L, R, t0 + i, v, 0);
      L[t0 + i] += 0.05 * v; R[t0 + i] -= 0.05 * v;       // slight width
    }
  }
  return [L, R];
}

/**
 * `other` — everything that is not a drum, a bass, a voice, a guitar or a piano:
 * a wide detuned saw pad plus a staccato synth stab.
 *
 * The stab's PLATEAU envelope is the load-bearing part. A plucked string and a
 * struck string both start loud and decay; a held synth does not decay at all.
 * That one difference is what stops `other` from being a third confusable
 * plucked source now that `guitar` exists — see the header.
 */
function makeOther(N, spb, rnd) {
  const L = new Float32Array(N), R = new Float32Array(N);
  const lp = [biquad('lp', 2600, 0.8), biquad('lp', 2600, 0.8)];
  for (let bar = 0; bar * 4 * spb < N; bar++) {           // pad
    const ch = CHORDS[bar % CHORDS.length];
    const t0 = Math.round(bar * 4 * spb), len = Math.round(4 * spb);
    const ph = ch.flatMap((n) => [-0.12, 0.12].map(() => rnd()));
    for (let i = 0; i < len && t0 + i < N; i++) {
      const u = i / FS, env = att(u, 0.25) * rel(i, len, 300);
      let s = 0, k = 0;
      for (const n of ch) for (const det of [-0.12, 0.12]) {
        const f = midi(n) * Math.pow(2, det / 12);
        ph[k] += f / FS; ph[k] -= Math.floor(ph[k]);
        s += (2 * ph[k] - 1) / 8; k++;                    // saw
      }
      const v = 0.30 * env * s;
      addPan(L, R, t0 + i, bq(lp[0], v), -0.55);
      addPan(L, R, t0 + i, bq(lp[1], v), 0.55);
    }
  }
  const bp = biquad('bp', 1500, 1.1);                     // staccato stab, plateau env
  for (let bar = 0; bar * 4 * spb < N; bar++) {
    const ch = CHORDS[bar % CHORDS.length];
    for (const beat of [1.75, 3.75]) {
      const t0 = Math.round((bar * 4 + beat) * spb), len = Math.round(0.18 * FS);
      const ph = [0, 0];
      for (let i = 0; i < len && t0 + i < N; i++) {
        // 5 ms up, flat hold, 20 ms down — no decay anywhere in between.
        const env = att(i / FS, 0.005) * rel(i, len, 20);
        let s = 0;
        [ch[2], ch[3] + 12].forEach((n, k) => {
          ph[k] += midi(n) / FS; ph[k] -= Math.floor(ph[k]);
          s += (ph[k] < 0.35 ? 1 : -1) * 0.5;             // 35 % pulse
        });
        addPan(L, R, t0 + i, 0.24 * env * bq(bp, s), 0.15);
      }
    }
  }
  return [L, R];
}

/**
 * `guitar` — strummed steel-string, extended Karplus-Strong.
 *
 * A real string is a delay line with a lossy low-pass in the loop, which gives
 * exactly harmonic partials whose highs die first. It is the *anti-piano*: no
 * stiffness, so no inharmonicity; a strum, so the six notes of one chord are
 * spread over 70 ms instead of struck together; and a high-passed pick
 * transient instead of a low-passed hammer thump.
 */
function makeGuitar(N, spb, rnd) {
  const L = new Float32Array(N), R = new Float32Array(N);
  const pickHp = biquad('hp', 2400, 0.7);
  const bodyLp = biquad('lp', 5200, 0.7);
  // [beat, direction, velocity] — down-strokes run low string to high, up-strokes
  // run high to low. Nothing else in the testbed lands on this grid.
  const strums = [[0, +1, 1.00], [1.5, -1, 0.72], [2.5, +1, 0.88], [3.25, -1, 0.66]];
  for (let bar = 0; bar * 4 * spb < N; bar++) {
    const ch = CHORDS[bar % CHORDS.length];
    const voicing = [ch[0] - 12, ch[0], ch[1], ch[2], ch[3], ch[1] + 12];   // A2..C5 on bar 1
    for (const [beat, dir, vel] of strums) {
      const base = Math.round((bar * 4 + beat) * spb);
      const order = dir > 0 ? voicing : [...voicing].slice().reverse();
      for (let k = 0; k < order.length; k++) {
        const t0 = base + Math.round(k * 0.014 * FS);     // 14 ms per string
        if (t0 >= N) continue;
        const f = midi(order[k]);
        const P = Math.max(2, Math.round(FS / f));
        const buf = new Float32Array(P);
        for (let i = 0; i < P; i++) buf[i] = rnd() * 2 - 1;
        const len = Math.min(Math.round(2.0 * spb), N - t0);
        for (let i = 0, j = 0; i < len; i++) {
          const s = buf[j];
          buf[j] = 0.5 * (s + buf[(j + 1) % P]) * 0.9975;  // lossy string loop
          j = (j + 1) % P;
          const u = i / FS;
          const env = att(u, 0.002) * Math.exp(-u / 1.15) * rel(i, len, 25);
          // Pick attack: broadband, HIGH-passed, gone in ~8 ms.
          const pick = 0.5 * bq(pickHp, rnd() * 2 - 1) * Math.exp(-u / 0.0035);
          const v = 0.46 * vel * env * bq(bodyLp, s + pick);
          addPan(L, R, t0 + i, v, -0.34 + 0.10 * (k / 5));
        }
      }
    }
  }
  return [L, R];
}

/**
 * `piano` — struck string with stiffness, additive.
 *
 * f_n = n*f0*sqrt(1 + B*n^2) with B = 3.5e-4: by the 16th partial the overtone
 * sits 4.4 % (≈ 75 cents) sharp of where the guitar's 16th partial is on the
 * same note. Below the 6th partial the two are indistinguishable, which is the
 * point — the cue is real but it is not a free lunch. Higher partials also decay
 * faster (tau_n = tau0 / n^0.55), the classic bright-to-mellow piano tail.
 *
 * The sustain pedal is DOWN: notes ring 1.6 s, across the chord change, so the
 * piano is the one source whose energy is continuous over a bar line.
 *
 * Oscillators use the norm-preserving coupled ("magic circle") rotation rather
 * than Math.sin per sample: 14 partials x 12 notes/bar x 1.6 s at 44.1 kHz is
 * ~100 M trig calls over a 30 s render, and QA generates 600 s soaks.
 */
function makePiano(N, spb, rnd) {
  const L = new Float32Array(N), R = new Float32Array(N);
  const B = 3.5e-4, NH = 14, TAU0 = 1.6;
  const thumpLp = biquad('lp', 200, 0.8);
  const cw = new Float64Array(NH), sw = new Float64Array(NH);
  const pu = new Float64Array(NH), pv = new Float64Array(NH);
  const amp = new Float64Array(NH), dec = new Float64Array(NH);

  const note = (t0, n, vel, pan) => {
    if (t0 >= N) return;
    const f0 = midi(n);
    let H = 0, norm = 0;
    for (let h = 1; h <= NH; h++) {
      const fh = f0 * h * Math.sqrt(1 + B * h * h);
      if (fh > 17500) break;                              // band-limit before finish()
      const w = (2 * Math.PI * fh) / FS, ph0 = 2 * Math.PI * rnd();
      cw[H] = Math.cos(w); sw[H] = Math.sin(w);
      pu[H] = Math.cos(ph0); pv[H] = Math.sin(ph0);
      amp[H] = 1 / Math.pow(h, 1.15);
      dec[H] = Math.exp(-1 / ((TAU0 / Math.pow(h, 0.55)) * FS));
      norm += amp[H]; H++;
    }
    if (!H) return;
    const g = (0.34 * vel) / norm;
    const len = Math.min(Math.round(TAU0 * FS), N - t0);
    for (let i = 0; i < len; i++) {
      const u = i / FS;
      let s = 0;
      for (let h = 0; h < H; h++) {
        const a = pu[h], b = pv[h];
        pu[h] = cw[h] * a - sw[h] * b;
        pv[h] = sw[h] * a + cw[h] * b;
        amp[h] *= dec[h];
        s += amp[h] * pv[h];
      }
      // Hammer thump: broadband, LOW-passed — the opposite end of the spectrum
      // from the guitar's pick, and the cheapest cue a separator has.
      const thump = 0.9 * bq(thumpLp, rnd() * 2 - 1) * Math.exp(-u / 0.008);
      const env = att(u, 0.004) * rel(i, len, 40);
      addPan(L, R, t0 + i, g * env * (s + thump), pan);
    }
  };

  for (let bar = 0; bar * 4 * spb < N; bar++) {
    const ch = CHORDS[bar % CHORDS.length];
    const voicing = [ch[0], ch[1], ch[2], ch[3], ch[0] + 12, ch[1] + 12];   // A3..C5 on bar 1
    // Block chord on the downbeat: ALL notes at the same sample. That is the
    // single sharpest contrast with the guitar's 14 ms-per-string strum.
    voicing.forEach((n, k) => note(Math.round(bar * 4 * spb), n, 0.85, 0.08 + 0.34 * (k / 5)));
    // ...then a running eighth-note arpeggio through the rest of the bar.
    // The arpeggio drops its last two eighths on odd bars. That gap is not
    // decoration: bss-eval.js decides GATED-vs-ADVISORY on whether EVERY source
    // has > 5 dB of 20 ms envelope range, and the pedalled piano is the flattest
    // source here. Without the gap it sits ~3 dB above that line, and a testbed
    // that drifts under it silently turns the seam gate ON for musical material.
    // `checkTestbed()` asserts the classification with the measured margin.
    const arp = bar % 2 ? [1.0, 1.5, 2.0, 2.5] : [1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
    arp.forEach((beat, k) => {
      const n = voicing[(k + 2) % voicing.length] + (k >= 4 ? 12 : 0);
      note(Math.round((bar * 4 + beat) * spb), n, 0.42 + 0.18 * (k % 2), 0.08 + 0.34 * (k / 5));
    });
  }
  return [L, R];
}

// ---- stationary variant ------------------------------------------------------
// Same six source *categories*, but steady-state: no onsets, no note changes,
// no transients anywhere. On this material ANY sample-scale spike or energy step
// in the separated output can only have been produced by our own splicing, so the
// seam gate in bss-eval.js becomes unambiguous. This is the file the seam test
// runs on; the musical testbed above is for SDR/leakage regression.
//
// The two new categories keep the ONE spectral fact that tells them apart and
// lose the onsets: `guitar` is a sustained EXACTLY-harmonic partial stack behind
// the same body filter, `piano` is a sustained INHARMONIC one at the same
// B = 3.5e-4. Same contrast as the musical testbed, no transients. Without them
// the steady file would score the new stems on material sharing nothing with
// what they hold.
//
// A NOTE ON `seconds`. bss-eval.js decides GATED-vs-ADVISORY from the 5th-to-95th
// percentile of each source's 20 ms envelope, over the WHOLE file, fades
// included. A fixed 0.5 s fade is 17 % of a 6 s render, so p05 lands inside the
// ramp, every source reads 10 dB of "dynamics" and the stationary file is
// classified MUSICAL — which turns the seam gate off in the one place it is a
// gate. The fade therefore scales: never more than 2.5 % of the file at each
// end, so the 5th percentile always lands in the steady body. At the 30 s QA
// renders it is the same 0.5 s it always was.
export function makeStationary({ seconds = 30, seed = 20260807 } = {}) {
  const N = Math.round(seconds * FS), rnd = mulberry32(seed);
  const fadeN = Math.min(0.5, seconds / 40) * FS;
  const fade = (i) => Math.min(1, i / fadeN) * Math.min(1, (N - i) / fadeN);
  const mk = () => [new Float32Array(N), new Float32Array(N)];
  const stems = {};
  for (const s of STEMS) stems[s] = mk();

  { // "drums": steady cymbal wash + steady low rumble
    const hp = biquad('hp', 6500, 0.7), lp = biquad('lp', 90, 0.7);
    for (let i = 0; i < N; i++) {
      const n = rnd() * 2 - 1;
      const v = fade(i) * (0.22 * bq(hp, n) + 0.35 * bq(lp, rnd() * 2 - 1));
      addPan(stems.drums[0], stems.drums[1], i, v, 0);
    }
  }
  { // "bass": one sustained saw
    const lp = biquad('lp', 420, 0.9); let ph = 0; const f = midi(33);
    for (let i = 0; i < N; i++) {
      ph += f / FS; ph -= Math.floor(ph);
      let s2 = 0; for (let h = 1; h <= 12; h++) s2 += Math.sin(2 * Math.PI * h * ph) / h;
      addPan(stems.bass[0], stems.bass[1], i, fade(i) * bq(lp, 0.40 * s2), 0);
    }
  }
  { // "other": one sustained detuned chord
    const ch = CHORDS[0], lp = [biquad('lp', 2600, 0.8), biquad('lp', 2600, 0.8)];
    const ph = ch.flatMap(() => [rnd(), rnd()]);
    for (let i = 0; i < N; i++) {
      let s2 = 0, k = 0;
      for (const n of ch) for (const det of [-0.12, 0.12]) { const f = midi(n) * Math.pow(2, det / 12); ph[k] += f / FS; ph[k] -= Math.floor(ph[k]); s2 += (2 * ph[k] - 1) / 8; k++; }
      const v = fade(i) * 0.30 * s2;
      addPan(stems.other[0], stems.other[1], i, bq(lp[0], v), -0.55);
      addPan(stems.other[0], stems.other[1], i, bq(lp[1], v), 0.55);
    }
  }
  { // "vocals": one sustained vowel with vibrato
    const F = [biquad('bp', 700, 8), biquad('bp', 1220, 10), biquad('bp', 2600, 12)], A = [1, 0.45, 0.22];
    let ph = 0; const f0 = midi(69);
    for (let i = 0; i < N; i++) {
      const u = i / FS;
      ph += (f0 * (1 + 0.004 * Math.sin(2 * Math.PI * 5.1 * u))) / FS; ph -= Math.floor(ph);
      let g = 0; for (let h = 1; h <= 26; h++) g += Math.sin(2 * Math.PI * h * ph) / Math.pow(h, 1.25);
      let s2 = 0; for (let k = 0; k < 3; k++) s2 += A[k] * bq(F[k], g);
      addPan(stems.vocals[0], stems.vocals[1], i, fade(i) * 1.45 * s2, 0);
    }
  }
  { // "guitar": sustained and EXACTLY harmonic — the anti-piano, held still
    // A noise-driven Karplus-Strong loop was the first attempt and it is the
    // wrong instrument for THIS file: it is a stochastic resonator with a long
    // memory, so its 20 ms envelope wandered 9.8 dB over a 30 s render and its
    // RMS was still climbing at the end. Stationarity is this variant's entire
    // contract. What follows is the same partial structure with the randomness
    // removed, written deliberately as the SAME code shape as the piano block
    // below so that the only difference between the two sources is the one that
    // has to carry the separation: sqrt(1 + B*h^2) versus nothing.
    const lp = biquad('lp', 5200, 0.7), NH = 20;
    const parts = [];
    for (const n of [CHORDS[0][0] - 12, CHORDS[0][0], CHORDS[0][2], CHORDS[0][1] + 12]) {
      const f0 = midi(n);
      for (let h = 1; h <= NH; h++) {
        const fh = f0 * h;                                  // no stiffness. none.
        if (fh > 17500) break;
        const w = (2 * Math.PI * fh) / FS, ph0 = 2 * Math.PI * rnd();
        parts.push({ c: Math.cos(w), s: Math.sin(w), u: Math.cos(ph0), v: Math.sin(ph0), a: 1 / Math.pow(h, 1.3) });
      }
    }
    const norm = parts.reduce((t, p) => t + p.a, 0);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const p of parts) { const a = p.u, b = p.v; p.u = p.c * a - p.s * b; p.v = p.s * a + p.c * b; s += p.a * p.v; }
      addPan(stems.guitar[0], stems.guitar[1], i, (fade(i) * 0.62 * bq(lp, s)) / norm, -0.30);
    }
  }
  { // "piano": the same inharmonic partial stack, decay removed
    const B = 3.5e-4, NH = 14;
    const parts = [];
    for (const n of [CHORDS[0][0], CHORDS[0][2], CHORDS[0][1] + 12]) {
      const f0 = midi(n);
      for (let h = 1; h <= NH; h++) {
        const fh = f0 * h * Math.sqrt(1 + B * h * h);
        if (fh > 17500) break;
        const w = (2 * Math.PI * fh) / FS, ph0 = 2 * Math.PI * rnd();
        parts.push({ c: Math.cos(w), s: Math.sin(w), u: Math.cos(ph0), v: Math.sin(ph0), a: 1 / Math.pow(h, 1.15) });
      }
    }
    const norm = parts.reduce((t, p) => t + p.a, 0);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const p of parts) { const a = p.u, b = p.v; p.u = p.c * a - p.s * b; p.v = p.s * a + p.c * b; s += p.a * p.v; }
      addPan(stems.piano[0], stems.piano[1], i, (fade(i) * 0.55 * s) / norm, 0.30);
    }
  }
  return finish(stems, N, seconds, 0);
}

function finish(stems, N, seconds, bpm) {
  for (const s of Object.values(stems)) for (let c = 0; c < 2; c++) {
    const f1 = biquad('lp', 18000, 0.7071), f2 = biquad('lp', 18000, 0.7071);
    for (let i = 0; i < N; i++) s[c][i] = bq(f2, bq(f1, s[c][i]));
  }
  const mix = [new Float32Array(N), new Float32Array(N)];
  for (const s of Object.values(stems)) for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) mix[c][i] += s[c][i];
  let peak = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mix[c][i]));
  const g = Math.pow(10, -1 / 20) / peak;
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < N; i++) mix[c][i] *= g;
    for (const s of Object.values(stems)) for (let i = 0; i < N; i++) s[c][i] *= g;
  }
  return { mix, stems, sampleRate: FS, seconds, bpm, beatSeconds: bpm ? 60 / bpm : 0 };
}

// ---- main -------------------------------------------------------------------
export function makeTestbed({ seconds = 30, bpm = 120, seed = 20260807 } = {}) {
  const N = Math.round(seconds * FS), spb = (60 / bpm) * FS;
  const rnd = mulberry32(seed);
  // Insertion order IS the wire order. `checkTestbed()` asserts it against
  // config.js rather than trusting this literal.
  const stems = {
    drums: makeDrums(N, spb, rnd),
    bass: makeBass(N, spb, rnd),
    other: makeOther(N, spb, rnd),
    vocals: makeVocals(N, spb, rnd),
    guitar: makeGuitar(N, spb, rnd),
    piano: makePiano(N, spb, rnd),
  };
  return finish(stems, N, seconds, bpm);
}

// =============================================================================
// The honesty gate.  `node make-testbed.js --check`, and section 9 of
// selftest.js.  See AGENTS.md, "An assertion must FAIL when it cannot look":
// every check below reads a value out of the testbed and compares it. There is
// no `!x || (...)` anywhere in here — a missing source is a FAIL, not a skip.
// =============================================================================

/** Octave-band energy profile, for the spectral-overlap check. Mono-summed. */
export function bandEnergies(ch, centres = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]) {
  return centres.map((f) => {
    const b = [biquad('bp', f, 1.414), biquad('bp', f, 1.414)];
    let e = 0;
    for (let c = 0; c < ch.length; c++) {
      b[c].x1 = b[c].x2 = b[c].y1 = b[c].y2 = 0;
      for (let i = 0; i < ch[c].length; i++) { const y = bq(b[c], ch[c][i]); e += y * y; }
    }
    return e;
  });
}
const cosine = (a, b) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return ab / Math.sqrt(aa * bb + 1e-300);
};
/** 20 ms log-energy envelope, mono-summed. Same statistic bss-eval.js gates on. */
export function envelope20ms(ch, fs = FS) {
  const W = Math.round(fs * 0.02), n = Math.floor(ch[0].length / W), e = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let c = 0; c < ch.length; c++) for (let i = f * W; i < (f + 1) * W; i++) s += ch[c][i] * ch[c][i];
    e[f] = Math.log10(s / (W * ch.length) + 1e-12);
  }
  return e;
}
const pearson = (a, b) => {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sa = 0, sb = 0, sab = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sa += x * x; sb += y * y; sab += x * y; }
  return sab / Math.sqrt(sa * sb + 1e-300);
};

const rmsDbOf = (ch) => {
  let e = 0, n = 0;
  for (const c of ch) { for (let i = 0; i < c.length; i++) e += c[i] * c[i]; n += c.length; }
  return 10 * Math.log10(e / n + 1e-300);
};

/** 20*log10(|| mix - sum(subset) || / || mix ||). `subset` is a list of names. */
export function reconstructionDb(t, subset = Object.keys(t.stems)) {
  const C = t.mix.length, T = t.mix[0].length;
  let num = 0, den = 0;
  for (let c = 0; c < C; c++) for (let i = 0; i < T; i++) {
    let s = 0;
    for (const k of subset) s += t.stems[k][c][i];
    const r = t.mix[c][i] - s;
    num += r * r; den += t.mix[c][i] * t.mix[c][i];
  }
  return 10 * Math.log10(num / (den + 1e-300));
};

/**
 * Grades a testbed and returns the numbers it measured.
 *
 * `report(name, cond, detail)` is the caller's assertion sink, so this runs from
 * the `--check` CLI below and from section 9 of selftest.js with one body.
 *
 * @param t          a `makeTestbed()` or `makeStationary()` result
 * @param report     assertion sink
 * @param label      'musical' | 'steady' — appears in every assertion name, per
 *                   AGENTS.md: an assertion about a function with more than one
 *                   caller must name the entry point it applies to. The gates
 *                   differ between the two entry points and so must the names.
 * @param dynamic    what bss-eval.js MUST classify this material as. `true` =
 *                   musical, seams advisory. `false` = stationary, seam gate on.
 *                   Asserted, not assumed — see check 8.
 */
export function checkTestbed(t, report, { label = 'musical', dynamic = true } = {}) {
  const names = Object.keys(t.stems);

  // --- 1. the source set itself. A missing source is the FAILURE, not a skip.
  report(`[${label}] testbed emits exactly the ${STEMS.length} config STEMS, in order`,
    names.length === STEMS.length && names.every((n, i) => n === STEMS[i]),
    `got [${names.join(', ')}] want [${STEMS.join(', ')}]`);
  // Everything below indexes t.stems[name]; if the set is wrong the reads throw,
  // which is also a failure. Nothing here degrades to "skipped".

  // --- 2. every source carries real energy. This is the assertion that catches
  // a guitar that was "added" but renders silent — the exact failure mode that
  // sails through every "reads exactly 0" check in the repo.
  const rms = {};
  for (const n of STEMS) {
    rms[n] = rmsDbOf(t.stems[n]);
    report(`[${label}] ${n} carries real energy (RMS > -45 dBFS)`, rms[n] > -45, `${rms[n].toFixed(2)} dBFS`);
  }

  // --- 3. the invariant: mix === sum of ALL sources.
  const full = reconstructionDb(t);
  report(`[${label}] mix === Σ${STEMS.length} sources, <= -120 dB`, full <= -120, `${full.toFixed(1)} dB`);

  // --- 4. the control. Omitting ANY ONE source must fail by a wide margin — if
  // the worst case (the quietest source) is still 100 dB above the floor, then
  // the number in 3 is measuring the sum and not measuring nothing.
  let worstOmit = -Infinity, worstName = '';
  for (const n of STEMS) {
    const v = reconstructionDb(t, STEMS.filter((s) => s !== n));
    if (v > worstOmit) { worstOmit = v; worstName = n; }
    report(`[${label}] CONTROL Σ5 without ${n} is detected`, v > full + 100, `${v.toFixed(1)} dB vs ${full.toFixed(1)} dB`);
  }
  report(`[${label}] CONTROL worst single omission (${worstName}) is > -20 dB`, worstOmit > -20, `${worstOmit.toFixed(1)} dB`);

  // --- 5. the envelopes, and what each entry point may claim from them.
  const env = {}, range = {};
  for (const n of STEMS) {
    env[n] = envelope20ms(t.stems[n]);
    range[n] = 10 * (percentileOf(env[n], 0.95) - percentileOf(env[n], 0.05));   // dB
  }
  if (dynamic) {
    // MUSICAL ONLY. Separable: no source is a copy of another. 20 ms log-energy
    // envelope correlation — the same statistic bss-eval.js hard-FAILS the
    // estimates on, so a testbed whose own sources fail it would emit a red no
    // separator could ever clear.
    let worstPair = 0, worstPairName = '';
    for (let i = 0; i < STEMS.length; i++) for (let j = i + 1; j < STEMS.length; j++) {
      const r = Math.abs(pearson(env[STEMS[i]], env[STEMS[j]]));
      if (r > worstPair) { worstPair = r; worstPairName = `${STEMS[i]}/${STEMS[j]}`; }
    }
    report(`[${label}] SEPARABLE no two sources share an envelope (max |r| < 0.90)`,
      worstPair < 0.90, `worst ${worstPairName} r=${worstPair.toFixed(3)}`);
  }
  // On stationary material every envelope is flat by construction, so the
  // correlation above has nothing to measure and is not run — which is why the
  // gate is behind `dynamic` (an argument the CALLER states) and not behind a
  // property of the material itself. An instrument may excuse itself only on
  // evidence independent of the thing it measures: AGENTS.md.

  // --- 6. confusable: the two new sources must COLLIDE spectrally with the old
  // ones. A guitar in a band of its own would make separation look far better
  // than it is, and this is the only assertion in the repo that would notice.
  const bands = {}; for (const n of STEMS) bands[n] = bandEnergies(t.stems[n]);
  for (const [a, b] of [['guitar', 'other'], ['guitar', 'vocals'], ['piano', 'other'], ['piano', 'vocals'], ['guitar', 'piano']]) {
    const s = cosine(bands[a], bands[b]);
    report(`[${label}] CONFUSABLE ${a} shares ${b}'s spectrum (band cosine > 0.50)`, s > 0.50, `${s.toFixed(3)}`);
  }

  // --- 7. NOT HERE, deliberately: "the ground truth contains no sample-scale
  // discontinuity" (docs/AUDIO.md §6.2). The material now satisfies it — `rel()`
  // put a release taper on every generator, and before 6-stems five of the six
  // truncated mid-decay at 1.8-41 % of their own envelope. But the assertion
  // was written and then DELETED, because neither estimator available at this
  // level can carry the claim:
  //   - max |d2| / p99.9 |d2| over the whole file is level-blind. A 200-sample
  //     dropout spliced into a quiet passage of the guitar moved it 2.26 -> 2.26.
  //     A gate it cannot fail is not a gate.
  //   - the same ratio against a block-local median divides by ~0 in a silent
  //     block and reads 1e28 on clean material.
  // The repo already owns the right instrument: bss-eval.js's `seamReport`,
  // which normalises against a +-250 ms local baseline AND against 24 jittered
  // control positions. Run against the stationary testbed all six sources read
  // clickRatio 0.70-1.01 against its 2.0 gate, the two new ones at 1.00 and
  // 0.84. That is the measurement, taken with the estimator built for it.
  // AGENTS.md: pick the estimator for the claim, and delete the assertion that
  // documents an exception instead of encoding it.

  // --- 8. bss-eval.js must CLASSIFY this material the way we think it does.
  // Its `dynamic` flag is `envT.every(range > 5 dB)`, and it silently decides
  // whether the seam gate is a GATE or an ADVISORY. Get it wrong in one
  // direction and the seam gate never runs; wrong in the other and it fires on
  // every downbeat. Two new sources changed the input to an `every()`, so the
  // classification is now something this file is responsible for.
  const cls = STEMS.every((n) => range[n] > 5);
  const flat = STEMS.filter((n) => range[n] <= 5);
  report(`[${label}] bss-eval classifies this as ${dynamic ? 'MUSICAL (seams advisory)' : 'STATIONARY (seam gate ON)'}`,
    cls === dynamic,
    dynamic ? `narrowest source ${STEMS.reduce((a, b) => (range[a] < range[b] ? a : b))} ${Math.min(...STEMS.map((n) => range[n])).toFixed(1)} dB > 5 dB`
      : `${flat.length} of ${STEMS.length} sources flat (${flat.join(', ')})`);

  return { rms, full, worstOmit, worstName, range, classifiedDynamic: cls };
}
const percentileOf = (a, p) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) {
    let failures = 0;
    const report = (name, cond, detail = '') => {
      console.log(`${cond ? ' ok  ' : 'FAIL '}${name}${detail ? '   ' + detail : ''}`);
      if (!cond) failures++;
    };
    // 8 s is four bars of the progression at 120 BPM — one full cycle of every
    // chord, strum, arpeggio and stab. Shorter and the material is not itself.
    checkTestbed(makeTestbed({ seconds: 8, bpm: 120 }), report, { label: 'musical', dynamic: true });
    checkTestbed(makeStationary({ seconds: 6 }), report, { label: 'steady', dynamic: false });
    console.log(failures ? `\n${failures} FAILED\n` : '\nall checks passed\n');
    process.exit(failures ? 1 : 0);
  }

  const out = process.argv[2] ?? './testbed';
  const seconds = Number(process.argv[3] ?? 30);
  const bpm = Number(process.argv[4] ?? 120);
  const steady = process.argv.includes('--steady');
  mkdirSync(out, { recursive: true });
  const t = steady ? makeStationary({ seconds }) : makeTestbed({ seconds, bpm });
  const w = (name, ch) => {
    writeFileSync(join(out, name + '.wav'), Buffer.from(encodeWav(ch, { sampleRate: FS, bitDepth: 32, float: true })));
    let p = 0, e = 0;
    for (const c of ch) for (const v of c) { p = Math.max(p, Math.abs(v)); e += v * v; }
    console.log(`  ${name.padEnd(7)} peak ${(20 * Math.log10(p)).toFixed(2).padStart(7)} dBFS   rms ${(20 * Math.log10(Math.sqrt(e / (ch.length * ch[0].length)))).toFixed(2).padStart(7)} dBFS`);
  };
  console.log(`${steady ? 'STATIONARY seam testbed' : 'musical testbed'}: ${seconds}s${steady ? '' : ' @ ' + bpm + ' BPM'}, ${FS} Hz stereo float32 -> ${out}`);
  w('mix', t.mix);
  for (const [k, v] of Object.entries(t.stems)) w(k, v);

  // Sanity, and it EXITS NONZERO. This used to print a number and a parenthetical
  // "(must be < 1e-6)" and then succeed regardless — a check nobody's CI could
  // fail. Two assertions, both hard: the source set is the config's, and the sum
  // is the mix.
  const names = Object.keys(t.stems);
  const orderOk = names.length === STEMS.length && names.every((n, i) => n === STEMS[i]);
  let maxErr = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < t.mix[c].length; i++) {
    let s = 0; for (const v of Object.values(t.stems)) s += v[c][i];
    maxErr = Math.max(maxErr, Math.abs(s - t.mix[c][i]));
  }
  const sumOk = maxErr < 1e-6;
  console.log(`  sources         : [${names.join(' ')}]  ${orderOk ? 'OK' : 'WRONG — must equal config.js STEMS'}`);
  console.log(`  sum(stems) - mix : max |err| = ${maxErr.toExponential(2)} ${sumOk ? 'OK' : 'FAIL'} (must be < 1e-6)`);
  if (!orderOk || !sumOk) { console.error('\nFAILED — the ground truth is not ground truth. Do not score against these files.'); process.exit(1); }
}
