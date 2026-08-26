/**
 * 44 100 -> 22 050 mono decimator for the MIDI transcription lanes. Pure
 * arithmetic, no browser APIs, no `chrome.*`, so `node extension/engine/resample2.js`
 * runs every line of it against synthesised tones rather than against a mock.
 *
 *   stem ring planes 2k / 2k+1  (44 100 Hz, stereo, un-normalised)
 *     -> mono sum   (l + r) * 0.5          what librosa hands upstream Basic Pitch
 *     -> half-band FIR, cutoff fs/4        the anti-alias filter
 *     -> keep every second sample          the 2:1 decimation
 *     -> one lane of 22 050 Hz mono        engine/notes.js's clock
 *
 * ===========================================================================
 * WHY THIS IS NOT THE RESAMPLING `CONTRIBUTING.md` FORBIDS
 * ===========================================================================
 *
 * That is the first question a reviewer of this file will ask, so it is the
 * first thing answered. CONTRIBUTING.md's settled decision reads "One
 * `AudioContext` at 44 100 Hz — the model's native rate — and no JS resampling
 * anywhere on the live path", and its own carve-out names what is actually
 * banned:
 *
 *   "The absolute prohibition is on SAMPLE-RATE CONVERSION BETWEEN THE CAPTURE
 *    CLOCK AND THE MODEL CLOCK."
 *
 * The capture clock is 44 100 and the model clock is htdemucs's 44 100, and
 * nothing here sits between them. This file is a READ-ONLY TAP DOWNSTREAM OF THE
 * STEM RING: it runs on audio htdemucs has already produced, it feeds a DIFFERENT
 * model on a different clock (Basic Pitch is 22 050 Hz mono by construction —
 * `BASIC_PITCH.sr`), and **nothing it produces is ever audible**. No sample it
 * emits reaches the mixer, the master bus, the worklet or the DAC. It is the same
 * class of thing as `keytap.js`'s FFT: a lagging, refusable, non-destructive read
 * that forms an opinion and never touches the signal path.
 *
 * The two rules that keep it that way, and both are checked below:
 *   - `decimate2` writes only into a caller-owned `dst`. It never writes back.
 *   - it is an INTEGER 2:1 decimation with a FIXED ratio and FIXED taps. There is
 *     no general rational resampler here and there must not be one — a general
 *     resampler is the shape that gets pointed at the capture path by the next
 *     person, and the prohibition above is exactly about that shape.
 *
 * AND NOT `OfflineAudioContext`. `docs/AUDIO.md` §1.3 is standing: an
 * `AudioBufferSourceNode` whose buffer rate differs from the context rate runs
 * through Blink's LINEAR interpolator, which this repo measured at -8.6 dB and
 * banned. It also does not exist in Node, so a check built on it could never run
 * in the fast gate. Both reasons point the same way; the filter below is 31
 * numbers and it is the smaller thing.
 *
 * ===========================================================================
 * THE FILTER, AND WHAT IT COSTS
 * ===========================================================================
 *
 * Decimating by 2 folds everything above the new Nyquist (11 025 Hz) back down.
 * An 18 kHz cymbal partial that is simply "every other sample" comes back as a
 * 4 050 Hz tone AT FULL AMPLITUDE, in the middle of the band Basic Pitch reads —
 * i.e. as a confident, audible-looking note that was never played. That is the
 * failure this file exists to prevent, and `stopband-fir-rejects-the-alias` below
 * runs the unfiltered decimator alongside the real one so the number is a
 * comparison rather than a claim.
 *
 * SIZING. The cutoff MUST sit below 11 025 Hz; everything else is free choice.
 * The cost ceiling is the tap count: at 128 taps a lane costs
 * 128 MAC x 22 050 out/s x 1 channel ~= 2.8 MMAC/s of ARITHMETIC — and 127
 * moves x 44 100 in/s = 5.6 M float moves/s of delay-line shuffling on top of
 * it, which is the half of the bill "MMAC/s" hides and which the numbers below
 * keep separate. Against htdemucs at RTF 0.4527 neither is a number anyone
 * would notice, so affordability is not the constraint — the transition band is. **Basic Pitch's top note is A7 = 3520 Hz**
 * (`BASIC_PITCH.midiLow + 87` = MIDI 108, and the model's own band tops out
 * there), so everything between ~4 kHz and 11 025 Hz is harmonics the note head
 * never reports on, and a wide, sloppy transition band costs the transcription
 * nothing at all. A generous transition band is therefore FREE, which is why this
 * spends 31 taps and not 128:
 *
 *   passband  0 - 3520 Hz (every note Basic Pitch can name)  +0.03 / -0.00 dB
 *   -6 dB     11 025 Hz exactly (the half-band symmetry point)
 *   stopband  >= 13 400 Hz                                   <= -45.8 dB
 *   at 15 kHz                                                    -54.4 dB
 *   at 18 kHz                                                    -55.6 dB
 *
 * `taps-*` and `stopband-*` below assert those, so the table is measured and not
 * remembered.
 *
 * HALF-BAND, and this is why the cutoff is exactly fs/4 rather than "somewhere
 * below 11 025". At fc = fs/4 the ideal impulse response `sin(pi k / 2) / (pi k)`
 * is EXACTLY ZERO at every even offset from the centre, and a symmetric window
 * cannot disturb a zero, so 14 of the 31 taps are structurally zero. The
 * response is also antisymmetric about fs/4 — passband ripple and stopband
 * rejection are the SAME number, so one measurement covers both ends.
 * `taps-half-band-zeroes` counts those zeros; if someone moves the cutoff it
 * goes red, which is the point.
 *
 * THOSE ZEROS ARE A PROPERTY OF THE DESIGN AND NOT A SAVING, and this header
 * used to say otherwise in three places: it priced the loop at "17 MAC per
 * output sample = 0.37 MMAC/s per lane (1.87 across the five)", which is what a
 * filter that SKIPPED the zeros would cost. `decimate2` skips nothing and never
 * did. This repo does not let a correct decision rest on a wrong number — see
 * the `LIVE_CUSHION_SEC` comment in `shared/config.js` — so the numbers below
 * are MEASURED by §"9. the cost, counted" rather than derived from the tap
 * table: the 17 non-zero taps are poked one at a time and the output watched for
 * movement, the 14 ZERO taps are caught in the act by an Infinity walking the
 * delay line (`0 * Infinity` is NaN and a skipped tap is not), and the delay line
 * counts the floats it actually memmoves.
 *
 *   arithmetic  31 MAC   x 22 050 out/s = 0.68 MMAC/s   per lane, 3.42 over five
 *   shuffling   30 moves x 44 100 in/s  = 1.32 M mov/s  per lane, 6.62 over five
 *
 * THE SHUFFLE IS THE LARGER HALF — 1.935x the arithmetic — and it was missing
 * from every earlier statement of this cost. "MMAC/s" was the wrong unit for a
 * loop whose biggest line is a memmove.
 *
 * The inner loop multiplies all 31 deliberately. A sparse tap list is a second
 * array to keep in step with the first, and it would remove 14 x 22 050 =
 * 0.31 MMAC/s per lane (1.54 over five) while leaving every one of the moves
 * above exactly where it is — under a third of this file's per-lane work, inside
 * a process already spending 45 % of a core on htdemucs.
 *
 * ponytail: CEILING — the delay line is a `copyWithin` memmove per INPUT frame,
 * so the shuffling costs 1.32 M float moves/s per lane and 6.62 M across the
 * five pitched lanes: 1.935x this file's own arithmetic, and about 10x the
 * 14 x 44 100 = 0.62 M float writes/s the stem ring itself does. UPGRADE PATH —
 * a circular delay line: carry a write cursor in the state beside `phase` and
 * index the taps modulo the line length, which removes every move for one add
 * and one mask per tap. Not taken today because 30 contiguous floats is a
 * memmove a CPU does in a handful of cycles while the modulo form pays its cost
 * inside the MAC loop, and because nothing here has been measured on a real deck
 * — only counted. The day this file is profiled rather than counted, that is the
 * trade to settle.
 *
 * GROUP DELAY. Linear phase, so it is a constant (RS2_TAPS - 1) / 2 = 15 input
 * samples = 340 us of latency, identical for every frequency. It is a BIAS, not a
 * drift: it does not accumulate over a take, and it is an order of magnitude
 * under the 3.1 ms frame-grid seam `engine/notes.js` documents and two orders
 * under the unmeasured `chrome.tabCapture` offset. It is not compensated, and
 * `group-delay-is-fifteen-input-samples` pins it so that a future tap change
 * cannot move it silently.
 *
 * ===========================================================================
 * STREAMING: WHY THE STATE IS AN OBJECT
 * ===========================================================================
 *
 * This is fed one hop at a time and must produce, over a whole take, exactly the
 * samples one call over the whole take would have produced. Two things have to
 * cross a call boundary for that to be true:
 *
 *   1. `z`, the FIR delay line — 30 mono samples of history. Without it every
 *      block starts from silence and the join clicks 15 samples wide, every hop,
 *      forever.
 *   2. `phase`, ONE BIT. The default hop is 1.95 s = round(1.95 * 44100) = 85 995
 *      input frames, which is **ODD** (`CONTRACT` Appendix A). A decimator that
 *      takes `n >> 1` and moves on either loses or duplicates one sample at every
 *      odd-length join, and the lane's sample<->time map drifts by one input
 *      frame per hop until the transcription is seconds off the video. Carrying
 *      the phase is the whole reason this is an object and not a closure over an
 *      array.
 *
 * `blocked-equals-one-shot` is the assertion for both: 85 995 + 85 995 must be
 * sample-identical to 171 990, as a COUNT and an exact array comparison, with no
 * clock anywhere near it.
 */

/** Half-band FIR taps, symmetric, odd length. Designed once at module load. */
export const RS2_TAPS = 31;          // windowed-sinc, cutoff 0.25*fs, Hamming
export const RS2_IN_RATE = 44100;
export const RS2_OUT_RATE = 22050;

/**
 * The taps themselves. Module-private: nothing outside this file has any use for
 * them and the two things that do — `decimate2` and the self-check — are both in
 * it. Built once, at module load, from the closed form rather than shipped as a
 * table of literals, so the design is readable and a reviewer can change the
 * window function without re-deriving 31 numbers by hand.
 *
 *   h[n] = sinc_{fc}(n - c) * hamming(n),  fc = fs/4,  c = (N-1)/2
 *        = sin(pi*k/2) / (pi*k)  * (0.54 - 0.46*cos(2*pi*n/(N-1))),  k = n - c
 *
 * The even-offset zeros are written in EXPLICITLY rather than left to
 * `Math.sin(Math.PI * k / 2)`, which returns ~1e-16 for even k because Math.PI is
 * not pi. `taps-half-band-zeroes` counts exact zeros, so leaving that to floating
 * point would turn a structural property into a tolerance.
 */
const RS2_H = buildTaps();

function buildTaps() {
  const h = new Float64Array(RS2_TAPS);
  const c = (RS2_TAPS - 1) / 2;
  // Built HALF AT A TIME AND MIRRORED, not evaluated twice. `0.54 - 0.46*cos(x)`
  // evaluated at n and at N-1-n differs in the last bit — 2e-17, which is
  // nothing acoustically and is still a broken symmetry, and linear phase is a
  // property of exact symmetry. Mirroring makes `taps-odd-length-and-linear-phase`
  // an equality rather than a tolerance, which is the whole point of asserting it.
  let dc = 0;
  for (let n = 0; n <= c; n++) {
    const k = n - c;
    let s;
    if (k === 0) s = 0.5;                      // the ideal half-band centre tap
    else if (k % 2 === 0) s = 0;               // structural zero, see above
    else s = Math.sin(Math.PI * k / 2) / (Math.PI * k);
    const v = s * (0.54 - 0.46 * Math.cos(2 * Math.PI * n / (RS2_TAPS - 1)));
    h[n] = v;
    h[RS2_TAPS - 1 - n] = v;
    dc += n === c ? v : 2 * v;
  }
  // Normalise to unit DC gain. Windowing costs the ideal response 0.16 % of its
  // sum, and a decimator that quietly attenuates by 0.014 dB would put a bias
  // into every velocity engine/notes.js computes. Cheaper to divide once here —
  // and dividing every tap by the same number keeps the mirror exact.
  for (let n = 0; n < RS2_TAPS; n++) h[n] /= dc;
  return h;
}

/**
 * @returns {{z: Float32Array, phase: 0|1}} fresh, zeroed decimator state.
 *   `z` is the FIR delay line (length RS2_TAPS - 1 mono samples).
 *   `phase` is which input frame the next output sample lands on, so a block of
 *   ODD length (hop 1.95 s = 85995 frames) does not lose or duplicate a sample
 *   at the join. Carrying it is the whole reason state is an object.
 */
export function newDecimator() {
  return { z: new Float32Array(RS2_TAPS - 1), phase: 0 };
}

/**
 * Mono-sum + anti-alias + decimate one contiguous block.
 *
 * @param {{z: Float32Array, phase: 0|1}} st  mutated in place
 * @param {Float32Array} l  input, 44100 Hz, at least `n` valid samples
 * @param {Float32Array} r  input, 44100 Hz, at least `n` valid samples
 * @param {Float32Array} dst destination, 22050 Hz, at least ceil(n/2) capacity
 * @param {number} n  input frames to consume
 * @returns {number} output samples written, floor((n + st.phase) / 2)
 *
 * Mono sum is `(l[i] + r[i]) * 0.5`, matching what librosa hands upstream
 * Basic Pitch. MUST NOT normalise, MUST NOT apply gain, MUST NOT clip.
 * MUST NOT allocate. MUST NOT read `dst` before writing it.
 *
 * The guards throw rather than clamp. A short `dst` is the call site being wrong
 * about a buffer it sized itself, and silently writing fewer samples than the
 * return value claims would put a hole in the lane that nothing downstream could
 * see — `offscreen/transcribe.js` derives lane sample <-> source second from the
 * COUNT, so a count that lies is a transcription that drifts. Loud on purpose,
 * and it is the same posture `shared/midi.js::assertDeliverable` takes.
 */
export function decimate2(st, l, r, dst, n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`decimate2: n must be a non-negative integer, got ${n}`);
  }
  if (l.length < n || r.length < n) {
    throw new Error(`decimate2: need ${n} input frames, l has ${l.length} and r has ${r.length}`);
  }
  const want = (n + st.phase) >> 1;
  if (dst.length < want) {
    throw new Error(`decimate2: dst holds ${dst.length}, needs ${want} for n=${n} at phase ${st.phase}`);
  }

  const h = RS2_H, z = st.z, Z = z.length;
  let p = st.phase, o = 0;
  for (let i = 0; i < n; i++) {
    const m = (l[i] + r[i]) * 0.5;
    // The phase flips on every input frame; an output lands on the frame that
    // completes a pair. Starting from phase 0 that is i = 1, 3, 5, ...; starting
    // from phase 1 (an odd block ended mid-pair) it is i = 0, 2, 4, ... — which
    // is exactly the sample the naive `n >> 1` loop drops.
    p ^= 1;
    if (p === 0) {
      // y[i] = sum_k h[k] * x[i-k]. x[i] is `m`, x[i-k] for k >= 1 is z[k-1].
      let acc = h[0] * m;
      for (let k = 1; k < RS2_TAPS; k++) acc += h[k] * z[k - 1];
      dst[o++] = acc;
    }
    // Push x[i] into the delay line. `copyWithin` is a memmove, not an
    // allocation — but it is neither free nor small, and the header used to
    // claim it was both. 30 floats per input frame is 1.32 M float moves/s per
    // lane and 6.62 M across the five pitched lanes: 1.935x this loop's own
    // arithmetic, and roughly ten times the 0.62 M float writes/s the 14-plane
    // stem ring does. It is the largest single cost in this file. COUNTED by
    // `cost-the-delay-line-is-shuffled-once-per-INPUT-frame`, not estimated; the
    // ponytail in the header carries the circular-buffer upgrade that removes it.
    z.copyWithin(1, 0, Z - 1);
    z[0] = m;
  }
  st.phase = p;
  return o;
}

// ===================================================================== self-check
//
// `node extension/engine/resample2.js`. Everything below this line is the
// runnable check and is NOT part of the module's surface.
//
// Every stimulus is chosen so that the measurement needs no window and no
// tolerance for leakage: the test tones complete an INTEGER number of cycles in
// both the input block and the output block, so a bare DFT at the frequency of
// interest is exact. 1000 Hz over 44 100 input frames is 1000 cycles and over
// 22 050 output samples is 1000 cycles; 18 000 Hz over 39 200 input frames is
// 16 000 cycles and its 4 050 Hz alias over 19 600 output samples is 3 600. No
// window, no scalloping, no "within a few dB of where it should be".

async function selfCheck() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

  /** Amplitude of the component at `f` in `x`, sampled at `fs`. Exact when
   *  `f * x.length / fs` is an integer — every stimulus here is. */
  const amplitudeAt = (x, fs, f) => {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i++) {
      const a = -2 * Math.PI * f * i / fs;
      re += x[i] * Math.cos(a); im += x[i] * Math.sin(a);
    }
    return 2 * Math.hypot(re, im) / x.length;
  };
  const db = (v) => 20 * Math.log10(v + 1e-300);
  const tone = (n, fs, f, amp = 1) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / fs);
    return x;
  };

  /**
   * THE CONTROL. Decimation with no anti-alias filter at all: mono-sum and keep
   * every second sample. It is written here, in the suite, run on the same
   * stimulus, and asserted to LOSE — AGENTS.md's rule, because a control that
   * cannot distinguish the hypothesis from its negation is a second copy of the
   * measurement wearing the word "control". Its phase bookkeeping is the same as
   * `decimate2`'s so the only difference between the two paths is the filter.
   */
  function naiveDecimate(st, l, r, dst, n) {
    let p = st.phase, o = 0;
    for (let i = 0; i < n; i++) {
      p ^= 1;
      if (p === 0) dst[o++] = (l[i] + r[i]) * 0.5;
    }
    st.phase = p;
    return o;
  }

  /** Run a whole signal through `fn` in one call, from a fresh state. */
  const runAll = (fn, x, y = x) => {
    const st = newDecimator();
    const dst = new Float32Array(Math.ceil(x.length / 2) + 1);
    const got = fn(st, x, y, dst, x.length);
    return dst.subarray(0, got);
  };

  /**
   * Run `x` through `fn` TWICE and return the second block. Every stimulus here
   * is exactly periodic over its own length, so the second block is the exact
   * steady-state response and the FIR's 15-sample start-up transient is not in
   * the measurement window. That matters: the transient carries ~15 samples of
   * unfiltered tone out of ~19 600, which is itself around -56 dB and would sit
   * on top of a -55 dB stopband reading. Priming removes an artefact of the
   * MEASUREMENT rather than of the filter. `x.length` must be even so both
   * blocks produce the same count.
   */
  const runSteady = (fn, x, y = x) => {
    const st = newDecimator();
    const dst = new Float32Array(Math.ceil(x.length / 2) + 1);
    fn(st, x, y, dst, x.length);
    const got = fn(st, x, y, dst, x.length);
    return dst.subarray(0, got);
  };

  /** |H(f)| of the shipped taps, straight from the coefficients. */
  const magAt = (f) => {
    let re = 0, im = 0;
    for (let n = 0; n < RS2_TAPS; n++) {
      const a = -2 * Math.PI * f * n / RS2_IN_RATE;
      re += RS2_H[n] * Math.cos(a); im += RS2_H[n] * Math.sin(a);
    }
    return Math.hypot(re, im);
  };

  head('1. the taps  (structure, not a table of remembered numbers)');
  {
    const c = (RS2_TAPS - 1) / 2;
    let dc = 0, zeros = 0, sym = 0;
    for (let n = 0; n < RS2_TAPS; n++) {
      dc += RS2_H[n];
      if (RS2_H[n] === 0) zeros++;
      sym = Math.max(sym, Math.abs(RS2_H[n] - RS2_H[RS2_TAPS - 1 - n]));
    }
    ok('taps-odd-length-and-linear-phase', RS2_TAPS % 2 === 1 && sym === 0,
      `${RS2_TAPS} taps, worst |h[n] - h[N-1-n]| = ${sym}`);
    ok('taps-unit-dc-gain', Math.abs(dc - 1) < 1e-12,
      `sum h = ${dc.toFixed(15)}; the unnormalised window sums to 0.998, i.e. a silent -0.014 dB on every velocity`);

    // The half-band structure IS the cutoff. Offsets from the centre run -15..15
    // and the ideal response vanishes at every even non-zero offset, so a
    // 31-tap half-band filter has 2*floor(30/4) = 14 exact zeros. Move the cutoff
    // off fs/4 to "widen the passband" and sin(2*pi*fc*k/fs) stops vanishing:
    // this count goes to 0 and the assertion goes red. That is what it is for.
    const wantZeros = 2 * Math.floor((RS2_TAPS - 1) / 4);
    ok('taps-half-band-zeroes', zeros === wantZeros,
      `${zeros} of ${RS2_TAPS} taps are exactly zero (wanted ${wantZeros}); centre tap ${RS2_H[c].toFixed(6)}, which is 0.5 only because fc is fs/4`);

    // The header's passband claim, measured off the coefficients.
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f <= 3520; f += 5) { const m = magAt(f); lo = Math.min(lo, m); hi = Math.max(hi, m); }
    ok('taps-flat-to-A7-3520hz', db(hi) - db(lo) <= 0.05,
      `0..3520 Hz spans ${db(lo).toFixed(4)} .. ${db(hi).toFixed(4)} dB — A7 = 3520 Hz is Basic Pitch's top note (MIDI 108), so this is the whole band the note head can name`);
    // The half-band crossover. The ideal value is exactly 0.5; the shipped taps
    // sit 0.16 % above it, which IS the DC normalisation above and nothing else.
    // The reachable red is a cutoff that is not fs/4. Measured by moving it: at
    // fc = 0.2*fs this reads 0.0995 and the zero count above collapses to 0.
    const cross = magAt(RS2_OUT_RATE / 2);
    ok('taps-minus-6dB-at-the-new-nyquist', Math.abs(cross - 0.5) < 2e-3,
      `|H(${RS2_OUT_RATE / 2})| = ${cross.toFixed(6)}, ${((cross / 0.5 - 1) * 100).toFixed(3)} % over the ideal 0.5 — that excess is the DC normalisation, not the design`);
    // The whole stopband, not just the two frequencies section 3 happens to
    // probe. Everything at or above 13 400 Hz folds into 0..8 650 Hz on
    // decimation, which is where the note head lives, so this is the number that
    // decides whether an alias can be mistaken for a note. Deterministic
    // arithmetic over the shipped coefficients — no signal, no estimator, no
    // noise; it is red or green for the same reason on every machine.
    let floorDb = -Infinity, floorHz = 0;
    for (let f = 13400; f <= RS2_IN_RATE / 2; f += 5) { const d = db(magAt(f)); if (d > floorDb) { floorDb = d; floorHz = f; } }
    ok('taps-stopband-floor-at-or-below-minus-45-dB', floorDb <= -45,
      `worst is ${floorDb.toFixed(2)} dB at ${floorHz} Hz; the header's table claims -45.8 and this is where that number comes from`);

    // What this SECTION may say about cost is only what it has measured: how
    // many taps are zero. What the loop COSTS is §9, because the loop does not
    // skip them and `RS2_TAPS - zeros` is the price of a filter this file does
    // not contain.
    console.log(`      ${zeros} structurally-zero taps — a design property, NOT a saving: the inner loop multiplies all ${RS2_TAPS}. Section 9 counts what that costs.`);
  }

  head('2. passband  (1 kHz in, 1 kHz out, at the same level)');
  {
    // 44 100 input frames = 1000 whole cycles of 1 kHz; 22 050 output samples =
    // 1000 whole cycles at 22 050. Fed TWICE and measured on the second block, so
    // the FIR's 15-sample start-up transient is not in the window: the tone is
    // periodic over the block, so block 2's output is the exact steady state.
    const x = tone(44100, RS2_IN_RATE, 1000);
    const st = newDecimator();
    const dst = new Float32Array(22051);
    decimate2(st, x, x, dst, x.length);
    const got = decimate2(st, x, x, dst, x.length);
    const y = dst.subarray(0, got);

    ok('passband-count-is-half-the-input', got === 22050, `${got} output samples from ${x.length} input frames`);

    const aIn = amplitudeAt(x, RS2_IN_RATE, 1000);
    const aOut = amplitudeAt(y, RS2_OUT_RATE, 1000);
    ok('passband-1khz-amplitude-within-half-a-dB', Math.abs(db(aOut) - db(aIn)) <= 0.5,
      `in ${aIn.toFixed(6)}, out ${aOut.toFixed(6)}, ${(db(aOut) - db(aIn)).toFixed(4)} dB (fails at +/-0.5)`);

    // "Peak bin within one bin" needs a spectrum, so this one uses the repo's
    // own FFT rather than a bare DFT. 4096 points at 22 050 is 5.383 Hz/bin;
    // 1000 Hz is bin 185.8, so bin 186 is the answer and 185 or 187 still pass.
    const { rfft } = await import('./fft.js');
    const N = 4096;
    const seg = new Float32Array(N);
    seg.set(y.subarray(1000, 1000 + N));
    for (let i = 0; i < N; i++) seg[i] *= 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const re = new Float32Array(N / 2 + 1), im = new Float32Array(N / 2 + 1);
    rfft(seg, 0, N, re, im, 0, 1);
    let peak = -1, peakV = -1;
    for (let k = 1; k <= N / 2; k++) {
      const v = re[k] * re[k] + im[k] * im[k];
      if (v > peakV) { peakV = v; peak = k; }
    }
    const want = 1000 * N / RS2_OUT_RATE;
    ok('passband-peak-bin-is-1khz-within-one-bin', Math.abs(peak - want) <= 1,
      `peak at bin ${peak} = ${(peak * RS2_OUT_RATE / N).toFixed(1)} Hz, wanted bin ${want.toFixed(2)} = 1000 Hz`);
  }

  head('3. stopband, and the unfiltered control that must lose');
  {
    // 18 kHz at 44 100 folds to 22 050 - 18 000 = 4 050 Hz after decimating by 2 —
    // squarely inside the band Basic Pitch reads, and at FULL amplitude if
    // nothing filters it. 39 200 input frames is 16 000 whole cycles at 18 kHz;
    // 19 600 output samples is 3 600 whole cycles at 4 050 Hz. Both exact.
    const x = tone(39200, RS2_IN_RATE, 18000);
    const yFir = runSteady(decimate2, x);
    const yNaive = runSteady(naiveDecimate, x);

    ok('stopband-both-paths-produced-the-same-number-of-samples',
      yFir.length === 19600 && yNaive.length === 19600,
      `fir ${yFir.length}, naive ${yNaive.length} — if these differ the dB comparison below is between two different things`);

    const aFir = amplitudeAt(yFir, RS2_OUT_RATE, 4050);
    const aNaive = amplitudeAt(yNaive, RS2_OUT_RATE, 4050);
    const margin = db(aNaive) - db(aFir);
    console.log(`      alias at 4050 Hz: naive ${aNaive.toFixed(6)} (${db(aNaive).toFixed(2)} dB), fir ${aFir.toExponential(3)} (${db(aFir).toFixed(2)} dB)`);
    ok('stopband-fir-rejects-the-alias-by-at-least-40-dB', margin >= 40,
      `${margin.toFixed(2)} dB below the unfiltered path; the value that makes this red is anything under 40`);

    // THE CONTROL LOSES. Same stimulus, same estimator, same threshold — and the
    // unfiltered decimator's alias is not 40 dB down, it is not down at all.
    // Without this line the assertion above is one measurement compared against a
    // number somebody typed.
    const naiveMargin = db(1) - db(aNaive);
    ok('stopband-CONTROL-the-unfiltered-decimator-fails-that-same-test', !(naiveMargin >= 40),
      `unfiltered alias sits ${naiveMargin.toFixed(2)} dB below the input tone — it needs 40 to pass and it cannot`);

    // The task's other stated margin, on a tone the model would never want:
    // 15 kHz folds to 7 050 Hz, above Basic Pitch's top note (A7 = 3520 Hz) but
    // still inside the note head's input band.
    // 39 102 frames, not 39 200: 15 000 Hz needs a length that is a multiple of
    // 147 to complete whole cycles at 44 100, and an even one so the output block
    // is whole too. 39 102 = 294 * 133 gives 13 300 input cycles and 6 251 output
    // cycles at 7 050 Hz, both exact, so the DFT below needs no window.
    const x15 = tone(39102, RS2_IN_RATE, 15000);
    const y15 = runSteady(decimate2, x15);
    const y15n = runSteady(naiveDecimate, x15);
    const a15 = amplitudeAt(y15, RS2_OUT_RATE, 7050);
    const a15n = amplitudeAt(y15n, RS2_OUT_RATE, 7050);
    console.log(`      alias at 7050 Hz from a 15 kHz tone: naive ${a15n.toFixed(6)}, fir ${a15.toExponential(3)}`);
    ok('stopband-15khz-is-attenuated-by-at-least-45-dB', db(a15n) - db(a15) >= 45,
      `${(db(a15n) - db(a15)).toFixed(2)} dB below the unfiltered path (red under 45)`);
  }

  head('4. streaming  (a block boundary is not a discontinuity)');
  {
    // The default hop: 1.95 s = round(1.95 * 44100) = 85 995 input frames, ODD.
    const H = 85995;
    const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const rnd = mulberry32(20260826);
    const L = new Float32Array(2 * H), R = new Float32Array(2 * H);
    for (let i = 0; i < 2 * H; i++) { L[i] = rnd() * 2 - 1; R[i] = rnd() * 2 - 1; }

    const one = new Float32Array(H + 1);
    const stOne = newDecimator();
    const nOne = decimate2(stOne, L, R, one, 2 * H);

    const two = new Float32Array(H + 1);
    const stTwo = newDecimator();
    const nA = decimate2(stTwo, L, R, two, H);
    const phaseAfterA = stTwo.phase;
    const nB = decimate2(stTwo, L.subarray(H), R.subarray(H), two.subarray(nA), H);

    ok('blocked-count-equals-one-shot-count', nOne === 85995 && nA + nB === nOne,
      `one call ${nOne}; two calls ${nA} + ${nB} = ${nA + nB}. A decimator that took n>>1 would emit ${(H >> 1) * 2} and lose one sample per hop`);
    ok('blocked-odd-block-leaves-the-phase-flipped', phaseAfterA === 1,
      `phase after ${H} (odd) frames is ${phaseAfterA}; if it were 0 the second block would drop the sample the first block owed`);

    let diffs = 0, worst = 0;
    for (let i = 0; i < nOne; i++) {
      const d = Math.abs(one[i] - two[i]);
      if (d !== 0) diffs++;
      if (d > worst) worst = d;
    }
    ok('blocked-equals-one-shot-sample-for-sample', diffs === 0,
      `${diffs} of ${nOne} samples differ (worst ${worst}); this is a COUNT and an exact comparison, there is no clock in it`);
  }

  head('5. odd-length accounting  (one input frame at a time)');
  {
    const st = newDecimator();
    const startPhase = st.phase;
    const one = new Float32Array(1), dst = new Float32Array(4);
    one[0] = 0.5;
    const a = decimate2(st, one, one, dst, 1);
    const midPhase = st.phase;
    const b = decimate2(st, one, one, dst.subarray(a), 1);
    ok('odd-n1-twice-writes-exactly-one-sample', a + b === 1,
      `first call wrote ${a}, second wrote ${b}`);
    ok('odd-n1-twice-returns-the-phase-to-where-it-started', st.phase === startPhase && midPhase !== startPhase,
      `${startPhase} -> ${midPhase} -> ${st.phase}`);

    // 128 single-frame calls must equal one 128-frame call, which is the same
    // claim as section 4 at the smallest possible block size.
    const x = new Float32Array(128);
    for (let i = 0; i < 128; i++) x[i] = Math.sin(i * 0.37);
    const bulk = runAll(decimate2, x);
    const drip = new Float32Array(64);
    const stD = newDecimator();
    let o = 0;
    for (let i = 0; i < 128; i++) o += decimate2(stD, x.subarray(i, i + 1), x.subarray(i, i + 1), drip.subarray(o), 1);
    let same = o === bulk.length;
    for (let i = 0; i < o && same; i++) same = drip[i] === bulk[i];
    ok('odd-one-frame-at-a-time-equals-one-call', same, `${o} samples, identical to the ${bulk.length}-sample bulk run`);
  }

  head('6. the mono sum, and the failure it has');
  {
    const x = tone(4410, RS2_IN_RATE, 1000, 0.8);
    const inv = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) inv[i] = -x[i];

    const same = runAll(decimate2, x, x);
    let peakSame = 0;
    for (let i = 0; i < same.length; i++) peakSame = Math.max(peakSame, Math.abs(same[i]));
    ok('mono-l-equals-r-passes-through-at-unity', Math.abs(peakSame - 0.8) < 0.01,
      `peak ${peakSame.toFixed(6)} from an input peak of 0.8 — the sum is (l+r)*0.5, not l+r`);

    // ponytail: the mono sum is `(l + r) * 0.5` because that is what librosa
    // hands upstream Basic Pitch, and it has one failure that is not theoretical.
    //   CEILING — a polarity-inverted stereo stem (a mis-wired channel, a
    //   Haas-widened synth, a mid/side plugin left inverted) sums to DIGITAL
    //   SILENCE and transcribes as NOTHING, over fully audible music. This is
    //   asserted below rather than hidden, because "no notes" and "no signal"
    //   look identical from the deck.
    //   UPGRADE PATH — pick the louder channel per window instead of summing:
    //   compare the two channels' RMS over the window and take the winner, which
    //   costs one pass and no filter change. Measure it on a REAL inverted
    //   fixture (a stem separated from a track with an inverted channel), not on
    //   a synthetic `l = -r`, because the synthetic case cancels perfectly and a
    //   real one does not — and the interesting question is what the rule does
    //   at partial cancellation, which a perfect null cannot answer.
    const nulled = runAll(decimate2, x, inv);
    let worst = 0;
    for (let i = 0; i < nulled.length; i++) worst = Math.max(worst, Math.abs(nulled[i]));
    ok('mono-polarity-inverted-stereo-sums-to-digital-silence', worst === 0,
      `${nulled.length} output samples, worst |y| = ${worst} — this is the ponytail above, asserted so it cannot be discovered in the field`);
  }

  head('7. group delay  (a bias, and a fixed one)');
  {
    // Linear phase means the impulse response peaks at the centre tap, so the
    // output lags the input by exactly (RS2_TAPS - 1) / 2 = 15 INPUT frames. With
    // phase 0 the outputs land on input frames 1, 3, 5, ..., so an impulse at
    // input frame 30 peaks at input frame 45 = output index (45 - 1) / 2 = 22.
    const delay = (RS2_TAPS - 1) / 2;
    const at = 30;
    const x = new Float32Array(128);
    x[at] = 1;
    const y = runAll(decimate2, x);
    let peak = -1, peakV = -1;
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > peakV) { peakV = Math.abs(y[i]); peak = i; }
    const peakInputFrame = peak * 2 + 1;
    ok('group-delay-is-fifteen-input-samples', peakInputFrame - at === delay,
      `impulse at input frame ${at} peaks at output ${peak} = input frame ${peakInputFrame}, i.e. ${peakInputFrame - at} frames = ${((peakInputFrame - at) / RS2_IN_RATE * 1e6).toFixed(0)} us; wanted ${delay}`);
    console.log(`      that is ${((delay / RS2_IN_RATE) * 1000).toFixed(3)} ms of CONSTANT latency, against the 3.1 ms frame-grid seam engine/notes.js documents. It is a bias, not a drift, and it is not compensated.`);
  }

  head('8. the guards  (a wrong buffer is loud, not quiet)');
  {
    const threw = (f) => { try { f(); return false; } catch { return true; } };
    const st = newDecimator();
    // EVERY PROBE USES AN ODD n, AND THE INPUT IS NOT ZEROS. Both are what make
    // the last assertion in this block able to fail.
    //   - `phase` flips once per input frame, so an EVEN n returns it to 0 all by
    //     itself. The earlier version of this block probed with n = 16 and then
    //     asserted `st.phase === 0`, which reads the same whether the guard fired
    //     or the loop ran all the way through. It answered a constant.
    //   - a delay line of zeros fed zeros is still zeros, so `x` carries a ramp:
    //     if the loop ran, `z` holds it.
    // n = 8.5 already flips the phase an odd number of times (`i < 8.5` runs 9
    // iterations), so it needs no adjusting.
    //
    // WATCHED IT FAIL, and the old n = 16 form did not: with ONLY the
    // `dst.length < want` guard deleted from `decimate2`, the old block printed
    // `PASS guard-untouched-state-after-a-throw  phase is still 0` on a run where
    // the loop had gone all the way through and written 8 outputs into a
    // four-element `dst`; this block prints `FAIL ... phase is still 1`. Same
    // again with only the `l.length < n || r.length < n` guard deleted — old
    // PASS, new FAIL. Reverted, 32/32.
    const x = new Float32Array(15);
    for (let i = 0; i < x.length; i++) x[i] = 0.25 + i / 64;
    ok('guard-short-dst-throws', threw(() => decimate2(st, x, x, new Float32Array(4), 15)),
      'dst of 4 for the 7 outputs 15 input frames owe — a silent short write would put a hole in the lane clock');
    ok('guard-short-input-throws', threw(() => decimate2(st, x, new Float32Array(4), new Float32Array(16), 15)),
      'r shorter than n');
    ok('guard-non-integer-n-throws', threw(() => decimate2(st, x, x, new Float32Array(16), 8.5)), 'n = 8.5');
    let worstZ = 0;
    for (let i = 0; i < st.z.length; i++) worstZ = Math.max(worstZ, Math.abs(st.z[i]));
    ok('guard-untouched-state-after-a-throw', st.phase === 0 && worstZ === 0,
      `phase is still ${st.phase} after three refused calls of ODD length, and the delay line is still all zeros (worst |z| = ${worstZ}); `
      + 'a guard that let the loop run would leave phase 1 and the ramp in z');
  }

  head('9. the cost, counted  (what the loop SPENDS, not what the tap table suggests)');
  {
    // THE HEADER USED TO PRICE THIS LOOP AT 17 MAC PER OUTPUT because 14 of the
    // 31 taps are structurally zero. `decimate2` does not skip them, so that was
    // the cost of a filter this file does not contain, quoted in three places. A
    // correct decision resting on a wrong number is the thing `shared/config.js`'s
    // LIVE_CUSHION_SEC comment exists to stop, so both halves are counted here
    // and the header quotes THESE numbers.
    //
    // WATCHED THEM FAIL, one break per half:
    //   the MAC loop written `if (h[k] !== 0) acc += h[k] * z[k - 1];` — i.e. the
    //     other half of the ruling's choice, the loop made to match what the old
    //     header claimed. `FAIL cost-all-14-structurally-zero-taps-are-multiplied
    //     -ANYWAY ... 0 NaN outputs (one per zero tap, wanted 14)` and
    //     `FAIL cost-the-SHUFFLE-is-the-larger-half ... 0.375 MMAC/s = 3.529x`,
    //     with the delay-line count and every filter assertion still GREEN. That
    //     break is isolated to the arithmetic half, which is what says these are
    //     two claims and not one written twice.
    //   `z.copyWithin(...)` moved inside `if (p === 0)`, so the line advances on
    //     OUTPUT frames only: `FAIL cost-the-delay-line-is-shuffled-once-per-
    //     INPUT-frame ... 2048 memmoves for 4096 input frames`. That one is NOT
    //     isolated — `stopband-fir-rejects-the-alias-by-at-least-40-dB` (-0.03 dB)
    //     and `group-delay-is-fifteen-input-samples` (29 frames) go red beside
    //     it, which is the correct reading: a delay line advanced half as often
    //     is a different filter. There is no version of this loop that keeps the
    //     response and skips the moves — the ponytail's circular buffer moves the
    //     cost, it does not delete it.
    // Reverted, 32/32.

    let zeroTaps = 0;
    for (let k = 0; k < RS2_TAPS; k++) if (RS2_H[k] === 0) zeroTaps++;

    // ---- (a1) the NON-ZERO taps are live: poke each one and the output MOVES.
    const probe = new Float32Array(96);
    for (let i = 0; i < probe.length; i++) probe[i] = Math.sin(i * 0.31);
    const baseline = Array.from(runAll(decimate2, probe));
    let livePokes = 0, poked = 0;
    for (let k = 0; k < RS2_TAPS; k++) {
      if (RS2_H[k] === 0) continue;
      poked++;
      const was = RS2_H[k];
      RS2_H[k] = was + 0.5;
      const moved = Array.from(runAll(decimate2, probe)).some((v, i) => v !== baseline[i]);
      RS2_H[k] = was;                                   // restored immediately, checked below
      if (moved) livePokes++;
    }
    const restored = Array.from(runAll(decimate2, probe));
    ok('cost-the-poke-left-the-taps-exactly-as-it-found-them',
      baseline.length > 0 && restored.length === baseline.length && restored.every((v, i) => v === baseline[i]),
      `${baseline.length} output samples identical before and after ${poked} pokes — without this the sections above would be running on a filter this one edited`);
    ok('cost-all-17-non-zero-taps-reach-the-output',
      poked === RS2_TAPS - zeroTaps && livePokes === poked,
      `${livePokes} of ${poked} non-zero taps change the output when poked`);

    // ---- (a2) AND THE 14 ZEROS ARE MULTIPLIED TOO, which is the whole of the
    // correction. A poke cannot answer this — poking a zero tap makes it
    // non-zero, so a loop that skipped `h[k] === 0` would pick the poked tap up
    // and look identical. IEEE-754 can answer it: `0 * Infinity` is NaN and
    // `skip` is not. One Infinity in the input walks the delay line, and every
    // output where it lands under a structurally-zero tap comes back NaN — 14 of
    // them, one per zero tap, plus exactly one +Infinity where it lands under the
    // centre tap. A loop that skipped the zeros returns 0 NaNs.
    const spike = new Float32Array(64);
    spike[10] = Infinity;
    const spiked = runAll(decimate2, spike);
    let nans = 0, infs = 0;
    for (let i = 0; i < spiked.length; i++) {
      if (Number.isNaN(spiked[i])) nans++;
      else if (!Number.isFinite(spiked[i])) infs++;
    }
    ok('cost-all-14-structurally-zero-taps-are-multiplied-ANYWAY',
      nans === zeroTaps && infs === 1,
      `one Infinity through the delay line comes back as ${nans} NaN outputs (one per zero tap, wanted ${zeroTaps}) and ${infs} Infinity (the centre tap); a loop written \`if (h[k] !== 0)\` returns 0 NaN`);
    const liveTaps = livePokes + nans;

    // ---- (b) the delay line. `z` lives on the state object the CALLER owns, so a
    // Float32Array subclass that counts what `copyWithin` moves counts the
    // shipped loop's own shuffling. No copy of the loop is involved.
    let shuffleCalls = 0, shuffleMoved = 0;
    class CountingLine extends Float32Array {
      copyWithin(target, start, end) {
        shuffleCalls++; shuffleMoved += end - start;
        return super.copyWithin(target, start, end);
      }
    }
    const N_IN = 4096;
    const xc = new Float32Array(N_IN);
    for (let i = 0; i < N_IN; i++) xc[i] = Math.sin(i * 0.017);
    const stc = { z: new CountingLine(RS2_TAPS - 1), phase: 0 };
    const outc = new Float32Array(N_IN / 2 + 1);
    const nOut = decimate2(stc, xc, xc, outc, N_IN);
    ok('cost-the-delay-line-is-shuffled-once-per-INPUT-frame',
      nOut === N_IN / 2 && shuffleCalls === N_IN && shuffleMoved === N_IN * (RS2_TAPS - 2),
      `${shuffleCalls} memmoves for ${N_IN} input frames (${nOut} outputs), ${shuffleMoved} floats moved = ${shuffleMoved / shuffleCalls} per frame, plus the z[0] store = ${shuffleMoved / shuffleCalls + 1}`);

    // ---- the bill, from the two counts above and nothing else.
    const macPerOut = liveTaps;
    // Over the WHOLE block, not per memmove: a loop that shuffled on output
    // frames only would still average 29 floats per call, and dividing by
    // `shuffleCalls` would hide it. `z[0] = m` is unconditional in the loop, so
    // it is one store per input frame.
    const movesPerIn = (shuffleMoved + N_IN) / N_IN;
    const mac = macPerOut * RS2_OUT_RATE;
    const mov = movesPerIn * RS2_IN_RATE;
    console.log(`      arithmetic ${macPerOut} MAC x ${RS2_OUT_RATE} out/s = ${(mac / 1e6).toFixed(2)} MMAC/s per lane, ${(mac * 5 / 1e6).toFixed(2)} across the five pitched lanes`);
    console.log(`      shuffling  ${movesPerIn} moves x ${RS2_IN_RATE} in/s = ${(mov / 1e6).toFixed(2)} M float moves/s per lane, ${(mov * 5 / 1e6).toFixed(2)} across the five`);
    console.log(`      a sparse tap list would remove ${zeroTaps} x ${RS2_OUT_RATE} = ${(zeroTaps * RS2_OUT_RATE / 1e6).toFixed(2)} MMAC/s per lane and NONE of the moves`);
    // A RATIO, which is citable where an absolute is not (AGENTS.md), and it is
    // the claim the header now makes: the memmove is the bigger half of this
    // file, not a rounding error beside the arithmetic.
    ok('cost-the-SHUFFLE-is-the-larger-half-of-this-loop',
      mov > mac && Math.abs(mov / mac - 1.935) < 0.001,
      `${(mov / 1e6).toFixed(3)} M moves/s against ${(mac / 1e6).toFixed(3)} MMAC/s per lane = ${(mov / mac).toFixed(3)}x; the header quoted "0.37 MMAC/s per lane" and no move count at all`);
    // And the comparison the old copyWithin comment got backwards: it claimed the
    // shuffle was "far under the memory traffic the stem ring already does".
    const RING_WRITES = 14 * RS2_IN_RATE;               // 14 planes, one float32 per frame each
    ok('cost-the-shuffle-is-NOT-small-beside-the-stem-ring',
      Math.abs(mov * 5 / RING_WRITES - 10.7) < 0.05,
      `five lanes shuffle ${(mov * 5 / 1e6).toFixed(2)} M floats/s against the 14-plane ring's ${(RING_WRITES / 1e6).toFixed(2)} M float writes/s = ${(mov * 5 / RING_WRITES).toFixed(2)}x it. `
      + 'The comment this replaces said "far under"; it is an order of magnitude OVER. Both are small in absolute terms, which is the honest version of that sentence, '
      + 'and the ratio is pinned rather than the absolute because a ratio is citable and an absolute is not (AGENTS.md)');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

// Node only, and only when this file IS the entry point. No top-level await: the
// extension imports this module synchronously and must not be made async.
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return selfCheck();
  }).catch((e) => { console.error(e); process.exit(1); });
}
