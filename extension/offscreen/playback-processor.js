/**
 * Playback AudioWorklet. Reads seven stereo SAB planes, TRANSPOSES them (drums
 * excluded), applies per-sample smoothed gains, sums, and meters. This is the
 * whole reason live mode feels like an instrument instead of a render queue.
 *
 * HARD RULE (R0, probe/R0-RESULTS.md): this file must never name
 * `SharedArrayBuffer` and must never read `crossOriginIsolated`. Both are
 * UNDEFINED in AudioWorkletGlobalScope when the document is not cross-origin
 * isolated, and we deliberately ship without the COOP/COEP manifest keys. The
 * SAB arrives through processorOptions and is used directly.
 *
 * THE LOAD-BEARING DECISION (docs/ARCHITECTURE.md §1.6): stem gains are applied
 * HERE, at read time, never baked in at inference time. The pipeline runs ~3 s
 * behind; baking gains in at inference would make a fader move audible three
 * seconds later and the product would be dead. Applied here, fader response is
 * one render quantum plus the output latency.
 *
 * Why not AudioParams + GainNodes: the seven lanes are summed inside this
 * processor anyway (they share one read pointer, which is what guarantees stem
 * alignment), so there is no node boundary to hang an AudioParam on. The
 * one-pole below is the same curve `setTargetAtTime` produces, plus an exact
 * snap at 6 tau so a mute really reaches zero (docs/AUDIO.md §3.3 note 1).
 *
 * Meters are computed here over EVERY sample, not with an AnalyserNode, which
 * hands you a snapshot of the last 2048 samples whenever you happen to poll and
 * therefore misses peaks between polls (docs/AUDIO.md §4.3).
 *
 * ---------------------------------------------------------------- TWO COPIES
 *
 * Everything between the `VERBATIM COPY` markers below is a byte-for-byte copy
 * of `engine/pitch.js` and `engine/pitchbank.js` above their self-check banners,
 * modulo a leading `export ` and the one `import` line — neither of which can
 * appear in a worklet. That is the `engine/mixer.js` -> here precedent and the
 * reason shared/stemring.js:21-25 gives for it: AudioWorkletGlobalScope has no
 * module resolution, so the choice is duplicate or reimplement, and duplicating
 * is the one that can be CHECKED. `node extension/engine/pitchbank.js` reads
 * this file and diffs both regions (`worklet-copy-is-verbatim`), so drift is a
 * red rather than a code review. DO NOT hand-edit inside the markers.
 *
 * ------------------------------------------------ WHERE THE TRANSPOSE SITS
 *
 * The chain, per sample, is now:
 *
 *   ring plane at the ONE shared read pointer j        <- Δ = 0 lives here
 *     -> PitchLanes (drums delayed, the other six shifted, all by 3072)
 *     -> per-sample stem gain / mute / solo
 *     -> METER TAP                                     <- post-fader, PRE-xfader
 *     -> crossfader factor
 *     -> sum -> master gain -> starvation envelope
 *
 * THE GAINS ARE APPLIED AFTER THE TRANSPOSE, NOT BEFORE IT, and this is the one
 * place the implementation departs from the letter of the brief ("after the
 * per-sample gains and before the sum"). Gain and a linear shifter COMMUTE, so
 * the audio is identical either way; what does not commute is the latency of the
 * CONTROL. Putting the gains upstream would mean a mute reaches the speaker one
 * group delay later than it does today — 18.0 ms becomes ~88 ms, which is a
 * measured gate (`tools/run-ext.mjs`, "18.0 ms mute-to-silence in the rendered
 * samples") and a real regression in feel for every user including the ones who
 * never touch the transpose. Downstream also keeps the phase vocoder's input
 * independent of the mixer, so a fast mute cannot look like a transient to the
 * onset detector and trigger a phase reset (pitch.js ONSET_TOT_FLOOR is an
 * ABSOLUTE floor, so upstream gains would also change transient handling as a
 * function of fader position).
 *
 * Everything the brief's placement was protecting is unchanged: the seven lanes
 * are still read through the ONE shared pointer `j`, so Δ = 0 is still
 * structural; the transpose is still per-stem and still before the sum, so the
 * drums are still excluded; and the meter tap is still post-stem-fader and
 * PRE-crossfader (CONTRIBUTING.md, "Channel meters are post-stem-fader,
 * PRE-crossfader, pre-soft-clip"). Moving the gains back upstream is a swap of
 * two blocks in `process()` if the letter is wanted instead.
 */

const HEADER_BYTES = 128;      // shared/stemring.js STEM_RING_HEADER_BYTES
const NPLANES = 14;
const H_WRITE = 0, H_READ = 1, H_PLAY = 3, H_UNDERRUNS = 4, H_UNDERFRAMES = 5;
const NSTEMS = 6;
const Q = 128;                 // render quantum
/** Passthrough is the LAST plane pair — shared/stemring.js PLANES. */
const P_L = NSTEMS * 2, P_R = NSTEMS * 2 + 1;
/** Gain slots: 0..NSTEMS-1 stems, NSTEMS passthrough, NSTEMS+1 master. */
const G_PASS = NSTEMS, G_MASTER = NSTEMS + 1;

// ---8<--- BEGIN VERBATIM COPY: extension/engine/pitch.js ---8<---
/**
 * Fixed-interval pitch shifter — STFT phase vocoder + polyphase resampler.
 *
 * Shifts a stream by a FIXED INTEGER number of semitones in [-6, +6] and
 * preserves duration exactly: `framesIn === framesOut`, sample for sample, at
 * any block size. That is a hard invariant, not a target — the deck bus feeds
 * three of these (bass, other, vocals) and one `MatchedDelay` (drums), and the
 * four planes are summed by a single read pointer. One sample of length drift
 * on any plane is a stem alignment bug that grows without bound.
 *
 * ZERO IMPORTS, ON PURPOSE. This module will later be copied verbatim into an
 * AudioWorklet, where `import` does not exist. Everything it needs — the real
 * FFT, the Kaiser kernel design, the constants — is inlined here, following the
 * `engine/mixer.js` vs `offscreen/playback-processor.js` precedent: a pure
 * module for the logic and `node`-runnable checks, a thin duplicated copy in the
 * worklet. The self-check at the bottom is the ONLY part that touches `process`
 * or `import.meta`; the worklet copy drops it.
 *
 * `node extension/engine/pitch.js` runs the checks.
 *
 * ---------------------------------------------------------------- how it works
 *
 * Pitch shift by r = 2^(k/12) = time-stretch by r, then resample by 1/r.
 *
 *  1. STFT, N = 2048, synthesis hop Hs = 512 (Hann, 75 % overlap, sum of w^2
 *     over the hop grid is exactly 1.5 — COLA, asserted below).
 *  2. Analysis hop Ha = Hs*M/L, where L/M is the rational approximation of
 *     2^(k/12) in PITCH_RATIOS (all 13 within 0.01 cent — 10x inside the
 *     0.1-cent budget). Ha is kept an INTEGER every frame by an exact integer
 *     remainder accumulator (`arem`), so a_j = floor(a_0 + j*Hs*M/L) with no
 *     float drift, ever. The phase unwrapping uses that frame's ACTUAL integer
 *     hop, so the +/-1 sample jitter is not an error term.
 *  3. Phase propagation with identity phase locking (Laroche-Dolson): peaks
 *     propagate, the bins in a peak's region copy the peak's synthesis phase
 *     plus their own analysis phase offset from it.
 *  4. Spectral-flux onset detection resets phases to the analysis phases on
 *     transient frames. This is the specific fix for transient smearing and it
 *     is why this is a phase vocoder and not WSOLA. See "the transient offset
 *     correction" below — a naive reset is WRONG by up to 9.6 ms and every
 *     spectral test still passes on it.
 *  5. The stretched signal is resampled by M/L with a 128-tap Kaiser (beta 9.5)
 *     windowed sinc, arbitrary phase. NOT linear interpolation: docs/AUDIO.md
 *     Section 1.3 measured linear at -8.6 dB round trip and the project's
 *     ratified "no JS resampler on the live path" line exists to keep that out.
 *
 * ------------------------------------------- the transient offset correction
 *
 * The textbook "reset the synthesis phase to the analysis phase on a transient
 * frame" is not sufficient here and the reason is worth writing down, because
 * five of the seven spectral assertions below pass on the broken version.
 *
 * The content mapping is anchored at the frame CENTRE: analysis frame f covers
 * input [a_f, a_f+N) and is overlap-added at stretched [s_f, s_f+N), so input
 * time a_f + N/2 lands at stretched time s_f + N/2 and, in general,
 *
 *      inputPos(s) = a_f + N/2 + (s - s_f - N/2) * (M/L).
 *
 * A plain phase reset reproduces the frame's content at the SAME offset u
 * inside the synthesis frame, i.e. at stretched s_f + u, i.e. at input position
 * a_f + N/2 + (u - N/2)*(M/L) — which is the true position a_f + u only when
 * u = N/2 or M/L = 1. The error is (u - N/2)*(M/L - 1): up to +/-424 samples,
 * 9.6 ms, and it moves with u, so consecutive reset frames put the same drum
 * hit in different places and it comes out as a flam.
 *
 * So the reset carries a linear phase ramp `-omega_k * delta` with
 * delta = (u - N/2)*(L/M - 1), where u is the onset's offset in THIS frame,
 * located in the time domain to a few samples. Every frame that resets on a
 * given onset then places it at exactly the same absolute position, and frames
 * after the last reset hold it there (for impulsive content the instantaneous
 * frequency estimate is exactly omega_k, so normal propagation is a pure
 * translation by Hs, which is also exactly what the synthesis hop does).
 * `onsets-do-not-move` is the assertion that catches this, and it was run
 * against both broken versions to check it discriminates: worst click position
 * error at +6 is 1 sample with the ramp, 55 samples (1.25 ms) with a naive
 * reset, 100 samples (2.27 ms) with no transient handling at all. The 10-90 %
 * attack rise over the same three: 28, 126, 237 samples.
 *
 * ------------------------------------------------------------------- latency
 *
 * PITCH_GROUP_DELAY_SAMPLES is CONSTANT across all 13 settings, including
 * bypass, and `MatchedDelay` is the same number. Bypass is ratio 1 flowing
 * through the whole path (the resample kernel degenerates to a delta because
 * the cutoff is exactly Nyquist there), not a disconnect: a latency step when
 * the user engages pitch would blow the <50 ms inter-deck drift bar on its own.
 * The causality floor is D >= N/2 - 1 + (N/2 + 64)*(M/L) = 2562 samples at the
 * worst ratio (M/L = 1.414 at -6); 3072 is that rounded up to 6*Hs and leaves
 * 510 samples of slack. `stats.starved` counts any output sample that had to be
 * emitted before its input arrived and the self-check asserts it is 0.
 */

// ============================================================== public constants

/** STFT size. Ratified. */
const PITCH_FFT_SIZE = 2048;
/** Synthesis hop. 75 % overlap; Hann^2 sums to exactly 1.5 on this grid. */
const PITCH_SYNTH_HOP = 512;

/**
 * Algorithmic latency, in samples, at EVERY setting including 0 semitones, and
 * the delay `MatchedDelay` applies to the unshifted plane. Downstream adds this
 * to the latency readout. Changing it changes the drums/bass alignment, so the
 * self-check pins it two ways: `bypass-is-identity` (offset D) and
 * `matched-delay-tracks-the-shifter` (sample for sample against ratio 1).
 */
const PITCH_GROUP_DELAY_SAMPLES = 3072;

const PITCH_MIN_SEMITONES = -6;
const PITCH_MAX_SEMITONES = 6;

/** Largest block `process()` handles in one internal pass; bigger blocks loop. */
const PITCH_MAX_BLOCK = 8192;

/**
 * Recommended crossfade when the caller changes the interval under a running
 * stream. `setSemitones()` re-anchors on a frame boundary and is length- and
 * latency-exact, but the synthesis phase is discontinuous at the switch, so the
 * caller crossfades two instances. Duplicated from shared/config.js
 * SEAM_XFADE_MS (this module has no imports) — if that moves, move this.
 */
const PITCH_SWITCH_XFADE_MS = 50;

/**
 * The 13 (L, M) pairs. L/M approximates 2^(k/12); the analysis hop is
 * Hs*M/L. There is no continuous knob, so these are a table, not a search.
 * Chosen as the smallest continued-fraction convergent within 0.01 cent — the
 * budget is 0.1 cent and the next convergent down (89/84 at +1) sits at
 * 0.0992 cent, which meets the budget with 0.8 % of margin. Not enough margin
 * to be worth having. `cents` is the exact error of the pair, and
 * `ratio-table-is-within-0.01-cent` re-derives it from L and M.
 */
const PITCH_RATIOS = [
  { semitones: -6, L: 408, M: 577, cents: -0.002600 },
  { semitones: -5, L: 221, M: 295, cents: -0.002302 },
  { semitones: -4, L: 277, M: 349, cents: -0.009272 },
  { semitones: -3, L: 1501, M: 1785, cents: -0.000117 },
  { semitones: -2, L: 1527, M: 1714, cents: -0.000457 },
  { semitones: -1, L: 185, M: 196, cents: 0.005940 },
  { semitones: 0, L: 1, M: 1, cents: 0 },
  { semitones: 1, L: 196, M: 185, cents: -0.005940 },
  { semitones: 2, L: 1714, M: 1527, cents: 0.000457 },
  { semitones: 3, L: 1785, M: 1501, cents: 0.000117 },
  { semitones: 4, L: 349, M: 277, cents: 0.009272 },
  { semitones: 5, L: 295, M: 221, cents: 0.002302 },
  { semitones: 6, L: 577, M: 408, cents: 0.002600 },
];

// ============================================================ private constants

const TWO_PI = Math.PI * 2;

const N = PITCH_FFT_SIZE;
const NB = N / 2 + 1;
const HS = PITCH_SYNTH_HOP;
const D = PITCH_GROUP_DELAY_SAMPLES;

/** Resampler: taps per output sample, sub-sample phases in the bank, window. */
const RS_TAPS = 128;
const RS_PHASES = 512;
const RS_BETA = 9.5;

/** Ring sizes. Powers of two. Input holds D + N + PITCH_MAX_BLOCK with room. */
const IN_SIZE = 16384, IN_MASK = IN_SIZE - 1;
const SYN_SIZE = 16384, SYN_MASK = SYN_SIZE - 1;

/**
 * Onset gate. `nf` is the spectral flux normalised by the frame's total
 * magnitude, so it is 0..1 and scale-free; `mult` is the rise over the recent
 * average flux; `tot` keeps the ratio from being computed on silence. A frame
 * only resets if a located onset is within RESET_HALF of its centre — outside
 * that the Hann analysis weight is already below 0.15, and the phase ramp the
 * reset needs would be a circular shift of more than 3N/8.
 */
const ONSET_NF_MIN = 0.22;
const ONSET_MULT = 1.30;
const ONSET_AVG_COEF = 1 / 16;
const ONSET_TOT_FLOOR = 1e-7;
const RESET_HALF = 768;          // 3N/8
const ONSET_SLOTS = 8;
const LOCATE_BLOCK = 32;         // onset location resolution, samples

// ============================================================== Kaiser resampler

/** Modified Bessel I0, series. Converges fast for the |x| <= 10 we use. */
function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-18) break;
  }
  return sum;
}

const kernelCache = new Map();

/**
 * Polyphase kernel bank, laid out branch-major: bank[q*RS_TAPS + t] is the
 * prototype at argument (t - RS_TAPS/2 + q/RS_PHASES) input samples. RS_PHASES+1
 * branches so branch q+1 is always readable for the interpolation.
 *
 * WHAT CHANGED FROM docs/snippets/resample.js, and why it had to:
 *
 *  - The snippet's bank has exactly L branches for a FIXED rational L/M, so the
 *    phase sequence closes and every output sample lands on a stored branch.
 *    That does not port: 2^(k/12) needs L up to 1785, and 128 taps x 1785
 *    branches is a 1.8 MB prototype per interval that takes a visible fraction
 *    of a second to design. This bank is a fixed 512 sub-phases and LINEARLY
 *    INTERPOLATES THE TWO NEIGHBOURING BRANCHES' COEFFICIENTS. That is
 *    interpolation of the FILTER, not of the signal — the forbidden thing in
 *    docs/AUDIO.md 1.3 is linear interpolation of the SIGNAL, which has a
 *    -6.02 dB hole at 16 kHz and measured -8.6 dB round trip. Interpolating the
 *    kernel is second order in 1/RS_PHASES, and the measurements are the
 *    evidence for it, not this comment: alias floor -116.9 dB (gate -60),
 *    passband 40 Hz - 19 kHz within 0.02 dB at -6 (gate +/-0.5).
 *  - The cutoff is EXACTLY the effective Nyquist, 0.5*min(1, M/L), with no
 *    transition-band backoff. The snippet backs off by df/2 because it is a
 *    fixed 48k<->44.1k converter with 2 kHz of spare band. Here the backoff
 *    would cost the top of the band at every setting AND, more importantly, it
 *    would break bypass: at ratio 1 a cutoff of exactly Nyquist makes the
 *    integer-offset taps an exact delta (sin(pi*j)/(pi*j) = 0 for integer
 *    j != 0), so bypass is a bit-exact delay through the same 128-tap
 *    convolution. Measured with the snippet's backoff put back in: bypass goes
 *    from -infinity to -14.2 dB, i.e. it stops being bypass.
 *  - Each branch is normalised to unit sum, so DC gain is exactly 1 at every
 *    sub-phase and there is no phase-dependent level ripple. At ratio 1 the sum
 *    is already 1 to 1e-15, so this does not perturb bypass.
 *  - The group delay is not the snippet's P/2 "compensated as exactly 64": the
 *    kernel here is centred on the requested fractional position, so the
 *    resampler contributes no delay of its own. It contributes 64 samples of
 *    LOOKAHEAD, which is part of PITCH_GROUP_DELAY_SAMPLES.
 *
 * @param {number} fcn cutoff, cycles/sample of the input (stretched) signal
 */
function kernelBank(fcn) {
  const hit = kernelCache.get(fcn);
  if (hit) return hit;
  const P = RS_TAPS, Q = RS_PHASES, half = P / 2;
  const bank = new Float64Array((Q + 1) * P);
  const i0b = besselI0(RS_BETA);
  for (let q = 0; q <= Q; q++) {
    const phi = q / Q;
    const off = q * P;
    let sum = 0;
    for (let t = 0; t < P; t++) {
      const x = t - half + phi;
      const r = x / half;
      let v = 0;
      if (r > -1 && r < 1) {
        const a = TWO_PI * fcn * x;
        const sinc = x === 0 ? 1 : Math.sin(a) / a;
        v = 2 * fcn * sinc * (besselI0(RS_BETA * Math.sqrt(1 - r * r)) / i0b);
      }
      bank[off + t] = v;
      sum += v;
    }
    const g = 1 / sum;
    for (let t = 0; t < P; t++) bank[off + t] *= g;
  }
  kernelCache.set(fcn, bank);
  return bank;
}

// ==================================================================== real FFT

/**
 * Real FFT / iFFT, size fixed at construction, everything preallocated.
 *
 * Transcribed from extension/engine/fft.js (rfft / irfft / cfft), which is the
 * production implementation for the Demucs post-processing and is exercised by
 * `node test.js`. Differences: tables and scratch live on the instance instead
 * of module-level Maps (no allocation and no lookup in the frame path), and the
 * scale factors are folded to 1 both ways so forward+inverse is the identity.
 * The -120 dB gate on `bypass-is-identity` covers the whole round trip.
 */
class RFFT {
  constructor(n) {
    const h = n >> 1;
    this.n = n; this.h = h;
    const bits = Math.log2(h) | 0;
    this.rev = new Uint32Array(h);
    for (let i = 0; i < h; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.tc = new Float64Array(h >> 1);
    this.ts = new Float64Array(h >> 1);
    for (let k = 0; k < (h >> 1); k++) {
      const a = -TWO_PI * k / h;
      this.tc[k] = Math.cos(a); this.ts[k] = Math.sin(a);
    }
    this.wr = new Float64Array(h + 1);
    this.wi = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) {
      const a = -TWO_PI * k / n;
      this.wr[k] = Math.cos(a); this.wi[k] = Math.sin(a);
    }
    this.zr = new Float64Array(h);
    this.zi = new Float64Array(h);
  }

  /** In-place complex FFT of zr/zi, length h. sign -1 forward, +1 inverse. */
  _cfft(sign) {
    const { zr: re, zi: im, rev, tc, ts, h: n } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const tr = tc[k], ti = sign < 0 ? ts[k] : -ts[k];
          const i1 = i + j, i2 = i1 + half;
          const xr = re[i2], xi = im[i2];
          const or_ = xr * tr - xi * ti;
          const oi = xr * ti + xi * tr;
          re[i2] = re[i1] - or_; im[i2] = im[i1] - oi;
          re[i1] += or_; im[i1] += oi;
        }
      }
    }
  }

  /** x: Float64Array(n) -> n/2+1 bins in outRe/outIm. */
  forward(x, outRe, outIm) {
    const { h, zr, zi, wr, wi } = this;
    for (let k = 0; k < h; k++) { zr[k] = x[2 * k]; zi[k] = x[2 * k + 1]; }
    this._cfft(-1);
    for (let k = 0; k <= h; k++) {
      const k1 = k === h ? 0 : k;
      const k2 = (h - k) % h;
      const ar = zr[k1], ai = zi[k1];
      const br = zr[k2], bi = -zi[k2];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const orr = 0.5 * (ar - br), oii = 0.5 * (ai - bi);
      // -i * W^k * O
      const tr = orr * wr[k] - oii * wi[k];
      const ti = orr * wi[k] + oii * wr[k];
      outRe[k] = er + ti;
      outIm[k] = ei - tr;
    }
  }

  /** n/2+1 hermitian bins -> out: Float64Array(n). */
  inverse(inRe, inIm, out) {
    const { h, zr, zi, wr, wi } = this;
    for (let k = 0; k < h; k++) {
      const k2 = h - k;
      const ar = inRe[k], ai = inIm[k];
      const br = inRe[k2], bi = -inIm[k2];
      const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
      const orr = 0.5 * (ar - br), oii = 0.5 * (ai - bi);
      // + i * conj(W^k) * O
      const tr = orr * wr[k] + oii * wi[k];
      const ti = -orr * wi[k] + oii * wr[k];
      zr[k] = er - ti;
      zi[k] = ei + tr;
    }
    this._cfft(+1);
    const inv = 1 / h;
    for (let k = 0; k < h; k++) {
      out[2 * k] = zr[k] * inv;
      out[2 * k + 1] = zi[k] * inv;
    }
  }
}

// =================================================================== utilities

/**
 * Positive modulo for ring indexing. Exact for any integer-valued double up to
 * 2^53 because SIZE is a power of two, so it never needs rebasing — `i & mask`
 * would silently wrap at 2^31, which is 13.5 hours of audio at 44.1 kHz.
 */
const ringIdx = (i, size) => i - Math.floor(i / size) * size;

const wrapPi = (x) => x - TWO_PI * Math.round(x / TWO_PI);

function ratioFor(semitones) {
  const e = PITCH_RATIOS[semitones - PITCH_MIN_SEMITONES];
  if (!e || e.semitones !== semitones) {
    throw new RangeError(`pitch: semitones must be an integer in [${PITCH_MIN_SEMITONES}, ${PITCH_MAX_SEMITONES}], got ${semitones}`);
  }
  return e;
}

// ================================================================ PitchShifter

class PitchShifter {
  /**
   * @param {number} semitones integer in [-6, +6]
   * @param {number} channels 1 or 2
   */
  constructor(semitones, channels = 2) {
    if (channels !== 1 && channels !== 2) throw new RangeError(`pitch: channels must be 1 or 2, got ${channels}`);
    ratioFor(semitones);
    this.ch = channels;

    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 * (1 - Math.cos(TWO_PI * i / N));
    // Hann^2 summed over the Hs grid. Exactly 1.5 for N/Hs = 4; computed rather
    // than written down so the COLA assertion has something to check.
    let ws = 0;
    for (let m = 0; m * HS < N; m++) { const w = this.win[m * HS]; ws += w * w; }
    this.olaNorm = ws;
    this.colaSpread = 0;
    for (let i = 0; i < HS; i++) {
      let s = 0;
      for (let m = 0; m * HS + i < N; m++) { const w = this.win[m * HS + i]; s += w * w; }
      const d = Math.abs(s - ws);
      if (d > this.colaSpread) this.colaSpread = d;
    }

    this.omega = new Float64Array(NB);
    for (let k = 0; k < NB; k++) this.omega[k] = TWO_PI * k / N;

    this.fft = new RFFT(N);
    this.inR = [];
    this.synR = [];
    this.mag = [];
    this.phi = [];
    this.prevPhi = [];
    this.synPhi = [];
    for (let c = 0; c < channels; c++) {
      this.inR.push(new Float32Array(IN_SIZE));
      this.synR.push(new Float64Array(SYN_SIZE));
      this.mag.push(new Float64Array(NB));
      this.phi.push(new Float64Array(NB));
      this.prevPhi.push(new Float64Array(NB));
      this.synPhi.push(new Float64Array(NB));
    }
    this.re = new Float64Array(NB);
    this.im = new Float64Array(NB);
    this.magSum = new Float64Array(NB);
    this.prevMagSum = new Float64Array(NB);
    this.peakOf = new Int32Array(NB);
    this.peakList = new Int32Array(NB);
    this.frame = new Float64Array(N);
    this.taps = new Float64Array(RS_TAPS);
    this.onsets = new Float64Array(ONSET_SLOTS);
    this.blockE = new Float64Array(N / LOCATE_BLOCK);

    this._setRatio(semitones);
    this.reset();
  }

  _setRatio(semitones) {
    const e = ratioFor(semitones);
    this.semi = semitones;
    this.L = e.L;
    this.M = e.M;
    this.rateLM = e.L / e.M;              // stretched samples per output sample
    this.rateML = e.M / e.L;              // input samples per stretched sample
    this.hopNum = HS * e.M;               // integer accumulator numerator
    // Cutoff is the effective Nyquist of the resample step, in cycles/sample of
    // the stretched signal. min(1, M/L): decimating (pitch up) needs the
    // anti-alias cut, interpolating (pitch down) only needs image rejection at
    // the input Nyquist. Exactly 0.5 at ratio 1 makes bypass a delta.
    this.bank = kernelBank(0.5 * Math.min(1, e.M / e.L));
  }

  /** Interval currently in effect. */
  get semitones() { return this.semi; }

  /** Constant, every setting. Same number as MatchedDelay. */
  get delaySamples() { return D; }

  reset() {
    for (let c = 0; c < this.ch; c++) {
      this.inR[c].fill(0); this.synR[c].fill(0);
      this.prevPhi[c].fill(0); this.synPhi[c].fill(0);
    }
    this.prevMagSum.fill(0);
    this.onsets.fill(-1e18);
    this.onsetW = 0;
    this.inCount = 0;                     // absolute input samples consumed
    this.outCount = 0;                    // absolute output samples emitted
    // THE FRAME GRID STARTS AT -(N - Hs), NOT AT 0. Overlap-add reaches its
    // full window sum only after N/Hs frames, so a grid starting at 0 leaves
    // the first N - Hs samples under-weighted and input sample 0 is not
    // recoverable at all (the analysis Hann is exactly 0 there and no other
    // frame covers it). Starting 1536 samples early puts that whole ramp on
    // pre-stream silence, where a partial window sum is still silence, and
    // makes the first real output sample exact. Measured: bypass goes from
    // -24.3 dB to -infinity with this one line.
    this.nextA = -(N - HS);               // next analysis frame start, input index
    this.prevA = this.nextA;
    this.arem = 0;                        // accumulator remainder, [0, L)
    this.nextS = -(N - HS);               // next synthesis frame start, stretched index
    this.cIn = this.nextA + N / 2;        // content anchor, input domain
    this.cStr = this.nextS + N / 2;       // content anchor, stretched domain
    this.first = true;
    this.fluxAvg = 0;
    this.stats = { frames: 0, resets: 0, onsets: 0, starved: 0 };
  }

  /**
   * Change the interval under a running stream.
   *
   * Length- and latency-exact: the content anchor is re-pinned at the current
   * output position so `out[n]` still carries `in[n - D]` across the switch, and
   * the analysis accumulator is re-seeded (with its fractional part) from the
   * new mapping. The SYNTHESIS phase is discontinuous, which is audible as a
   * click on tonal material — crossfade two instances over
   * PITCH_SWITCH_XFADE_MS rather than relying on this being clean.
   */
  setSemitones(semitones) {
    if (semitones === this.semi) return;
    const tau = this.cStr + (this.outCount - D - this.cIn) * this.rateLM;
    this.cStr = tau;
    this.cIn = this.outCount - D;
    this._setRatio(semitones);
    // Re-seed the integer accumulator from the new mapping at the pending frame.
    const aExact = this.cIn + (this.nextS + N / 2 - this.cStr) * this.rateML - N / 2;
    const fl = Math.floor(aExact);
    this.nextA = fl;
    this.arem = Math.min(this.L - 1, Math.floor((aExact - fl) * this.L));
    this.first = true;                    // no usable phase history across a ratio change
  }

  /**
   * @param {Float32Array[]} inCh  one array per channel, length >= n
   * @param {Float32Array[]} outCh one array per channel, length >= n
   * @param {number} n samples. Any n; blocks larger than PITCH_MAX_BLOCK loop.
   *
   * Writes exactly n samples per channel. Safe with inCh === outCh (the input
   * is copied into the ring before any output is written).
   */
  process(inCh, outCh, n) {
    let off = 0;
    while (off < n) {
      const k = Math.min(PITCH_MAX_BLOCK, n - off);
      this._run(inCh, outCh, off, k);
      off += k;
    }
  }

  _run(inCh, outCh, off, n) {
    const ch = this.ch;
    // 1. take the input
    for (let c = 0; c < ch; c++) {
      const src = inCh[c], ring = this.inR[c];
      let ri = ringIdx(this.inCount, IN_SIZE);
      for (let i = 0; i < n; i++) { ring[ri] = src[off + i]; ri = (ri + 1) & IN_MASK; }
    }
    this.inCount += n;

    // 2. produce exactly n output samples
    const P = RS_TAPS, half = P >> 1, bank = this.bank, taps = this.taps;
    const s0 = this.synR[0], s1 = ch > 1 ? this.synR[1] : null;
    const o0 = outCh[0], o1 = ch > 1 ? outCh[1] : null;
    for (let i = 0; i < n; i++) {
      const nAbs = this.outCount + i;
      const tau = this.cStr + (nAbs - D - this.cIn) * this.rateLM;
      const i0 = Math.floor(tau);
      // synthesise every frame whose overlap-add can still touch [i0-63, i0+64]
      const needS = i0 + half;
      while (this.nextS <= needS) {
        if (this.nextA + N > this.inCount) { this.stats.starved++; break; }
        this._frame();
      }
      // interpolate the kernel to this sub-sample phase, then convolve
      const fq = (tau - i0) * RS_PHASES;
      const q = fq | 0;
      const fr = fq - q;
      const b0 = q * P, b1 = b0 + P;
      if (fr === 0) { for (let t = 0; t < P; t++) taps[t] = bank[b0 + t]; }
      else { for (let t = 0; t < P; t++) taps[t] = bank[b0 + t] + fr * (bank[b1 + t] - bank[b0 + t]); }
      let ri = ringIdx(i0 + half, SYN_SIZE);
      let a0 = 0, a1 = 0;
      if (s1) {
        for (let t = 0; t < P; t++) { const c = taps[t]; a0 += c * s0[ri]; a1 += c * s1[ri]; ri = (ri - 1) & SYN_MASK; }
      } else {
        for (let t = 0; t < P; t++) { a0 += taps[t] * s0[ri]; ri = (ri - 1) & SYN_MASK; }
      }
      o0[off + i] = a0;
      if (o1) o1[off + i] = a1;
    }
    this.outCount += n;
  }

  /** One analysis/synthesis frame at (nextA, nextS). */
  _frame() {
    const ch = this.ch, a = this.nextA, s = this.nextS, win = this.win;
    const Ha = this.first ? HS : a - this.prevA;

    // ---- analyse
    const magSum = this.magSum;
    magSum.fill(0);
    for (let c = 0; c < ch; c++) {
      const ring = this.inR[c], frame = this.frame;
      let ri = ringIdx(a, IN_SIZE);
      for (let i = 0; i < N; i++) { frame[i] = ring[ri] * win[i]; ri = (ri + 1) & IN_MASK; }
      this.fft.forward(frame, this.re, this.im);
      const mag = this.mag[c], phi = this.phi[c], re = this.re, im = this.im;
      for (let k = 0; k < NB; k++) {
        const r = re[k], q = im[k];
        const m = Math.sqrt(r * r + q * q);
        mag[k] = m; magSum[k] += m;
        phi[k] = Math.atan2(q, r);
      }
    }

    // ---- onset detection (spectral flux, normalised by frame magnitude)
    let flux = 0, tot = 0;
    const prevMagSum = this.prevMagSum;
    for (let k = 0; k < NB; k++) {
      const d = magSum[k] - prevMagSum[k];
      if (d > 0) flux += d;
      tot += magSum[k];
    }
    const nf = tot > ONSET_TOT_FLOOR ? flux / tot : 0;
    if (nf > ONSET_NF_MIN && flux > ONSET_MULT * this.fluxAvg && !this.first) {
      const p = this._locate(a);
      if (p >= 0) {
        let dup = false;
        for (let i = 0; i < ONSET_SLOTS; i++) if (Math.abs(this.onsets[i] - p) < LOCATE_BLOCK * 2) dup = true;
        if (!dup) {
          this.onsets[this.onsetW] = p;
          this.onsetW = (this.onsetW + 1) % ONSET_SLOTS;
          this.stats.onsets++;
        }
      }
    }
    this.fluxAvg += (flux - this.fluxAvg) * ONSET_AVG_COEF;

    // ---- is there a located onset near this frame's centre?
    const centre = a + N / 2;
    let onsetU = -1, best = RESET_HALF + 1;
    for (let i = 0; i < ONSET_SLOTS; i++) {
      const d = Math.abs(this.onsets[i] - centre);
      if (d <= RESET_HALF && d < best) { best = d; onsetU = this.onsets[i] - a; }
    }
    const doReset = this.first || onsetU >= 0;
    // The offset correction, derived in the header. delta = 0 at ratio 1 and at
    // a transient sitting exactly on the frame centre.
    const delta = onsetU >= 0 ? (onsetU - N / 2) * (this.rateLM - 1) : 0;
    if (onsetU >= 0) this.stats.resets++;

    // ---- peaks and regions, from the summed magnitude so both channels lock
    // to the same structure (per-channel peak maps de-correlate the stereo
    // image). ponytail: the peak's own phase still advances per channel, so
    // strongly correlated material can still widen slightly; the upgrade is
    // mid/side or a shared peak phase, and it needs stereo material to judge.
    this._regions();

    // ---- synthesise
    const re = this.re, im = this.im, po = this.peakOf, om = this.omega;
    for (let c = 0; c < ch; c++) {
      const mag = this.mag[c], phi = this.phi[c], pp = this.prevPhi[c], sp = this.synPhi[c];
      if (doReset) {
        for (let k = 0; k < NB; k++) sp[k] = wrapPi(phi[k] - om[k] * delta);
      } else {
        const scale = HS / Ha;
        for (let k = 0; k < NB; k++) {
          if (po[k] !== k) continue;
          const adv = om[k] * Ha;
          sp[k] = wrapPi(sp[k] + (adv + wrapPi(phi[k] - pp[k] - adv)) * scale);
        }
        for (let k = 0; k < NB; k++) {
          const p = po[k];
          if (p !== k) sp[k] = wrapPi(sp[p] + (phi[k] - phi[p]));
        }
      }
      for (let k = 0; k < NB; k++) {
        const m = mag[k];
        re[k] = m * Math.cos(sp[k]);
        im[k] = m * Math.sin(sp[k]);
      }
      im[0] = 0; im[NB - 1] = 0;
      const frame = this.frame;
      this.fft.inverse(re, im, frame);
      const ring = this.synR[c], g = 1 / this.olaNorm;
      // the Hs samples entering the accumulation window have never been written
      let zi = ringIdx(s + N - HS, SYN_SIZE);
      for (let i = 0; i < HS; i++) { ring[zi] = 0; zi = (zi + 1) & SYN_MASK; }
      let wi2 = ringIdx(s, SYN_SIZE);
      for (let i = 0; i < N; i++) { ring[wi2] += frame[i] * win[i] * g; wi2 = (wi2 + 1) & SYN_MASK; }
      for (let k = 0; k < NB; k++) pp[k] = phi[k];
    }

    for (let k = 0; k < NB; k++) prevMagSum[k] = magSum[k];
    this.prevA = a;
    this.nextS = s + HS;
    const t = this.arem + this.hopNum;
    this.nextA = a + Math.floor(t / this.L);
    this.arem = t % this.L;
    this.first = false;
    this.stats.frames++;
  }

  /**
   * Locate the strongest attack inside [a, a+N) to a few samples, in the time
   * domain. Called only on a flux-flagged frame; the flux says WHETHER, this
   * says WHERE, and the phase reset needs the where to a lot better than a
   * frame (see the header). Sums channels; no state.
   *
   * @returns {number} absolute input index, or -1 if nothing rose. The caller's
   * `p >= 0` test therefore also drops onsets located inside the pre-stream zero
   * pad (the frame grid starts at -1536), which is what we want: there is no
   * such thing as a transient in the leading silence.
   */
  _locate(a) {
    const B = LOCATE_BLOCK, nb = N / B, e = this.blockE, ch = this.ch;
    for (let b = 0; b < nb; b++) {
      let acc = 0;
      for (let c = 0; c < ch; c++) {
        const ring = this.inR[c];
        let ri = ringIdx(a + b * B, IN_SIZE);
        for (let i = 0; i < B; i++) { const v = ring[ri]; acc += v * v; ri = (ri + 1) & IN_MASK; }
      }
      e[b] = acc;
    }
    let bb = -1, bestRise = 0;
    for (let b = 1; b < nb; b++) { const r = e[b] - e[b - 1]; if (r > bestRise) { bestRise = r; bb = b; } }
    if (bb < 0) return -1;
    // refine inside the block: first sample above a quarter of its peak
    let pk = 0;
    for (let c = 0; c < ch; c++) {
      const ring = this.inR[c];
      let ri = ringIdx(a + bb * B, IN_SIZE);
      for (let i = 0; i < B; i++) { const v = Math.abs(ring[ri]); if (v > pk) pk = v; ri = (ri + 1) & IN_MASK; }
    }
    for (let i = 0; i < B; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) v = Math.max(v, Math.abs(this.inR[c][ringIdx(a + bb * B + i, IN_SIZE)]));
      if (v >= 0.25 * pk) return a + bb * B + i;
    }
    return a + bb * B;
  }

  /** Peak picking + region map for identity phase locking. */
  _regions() {
    const m = this.magSum, po = this.peakOf, pk = this.peakList;
    let np = 0;
    // Bin 1 and bin NB-2 are candidates, with the +/-2 test relaxed where it
    // would run off the end. Starting the scan at k=2 (the textbook 5-bin rule)
    // silently makes every partial below 43 Hz un-peakable, so a 30 Hz tone gets
    // locked to a shoulder bin and comes out 5.5 dB down; with bin 1 admitted it
    // is 0.2 dB down. Measured on the tone sweep, k=-6: 30 Hz -5.49 -> -0.20 dB,
    // 25 Hz -2.68 -> -0.47 dB. The bass stem lives here.
    for (let k = 1; k < NB - 1; k++) {
      const v = m[k];
      if (v <= 1e-12 || !(v > m[k - 1]) || !(v > m[k + 1])) continue;
      if (k >= 2 && !(v > m[k - 2])) continue;
      if (k < NB - 2 && !(v > m[k + 2])) continue;
      pk[np++] = k;
    }
    if (np === 0) { for (let k = 0; k < NB; k++) po[k] = k; return; }
    let idx = 0;
    for (let k = 0; k < NB; k++) {
      while (idx + 1 < np && k > ((pk[idx] + pk[idx + 1]) >> 1)) idx++;
      po[k] = pk[idx];
    }
  }
}

// ================================================================ MatchedDelay

/**
 * The unshifted plane. Pure integer delay of PITCH_GROUP_DELAY_SAMPLES, so
 * drums stay sample-aligned with bass/other/vocals through a PitchShifter at
 * any interval, including 0. Not optional and not a convenience: the deck sums
 * the four planes on one read pointer.
 */
class MatchedDelay {
  constructor(channels = 2) {
    if (channels !== 1 && channels !== 2) throw new RangeError(`pitch: channels must be 1 or 2, got ${channels}`);
    this.ch = channels;
    this.buf = [];
    for (let c = 0; c < channels; c++) this.buf.push(new Float32Array(IN_SIZE));
    this.reset();
  }

  get delaySamples() { return D; }

  reset() {
    for (let c = 0; c < this.ch; c++) this.buf[c].fill(0);
    this.count = 0;
  }

  /** Same signature and the same n-in/n-out contract as PitchShifter. */
  process(inCh, outCh, n) {
    for (let c = 0; c < this.ch; c++) {
      const buf = this.buf[c], src = inCh[c], dst = outCh[c];
      let w = ringIdx(this.count, IN_SIZE);
      let r = ringIdx(this.count - D, IN_SIZE);
      for (let i = 0; i < n; i++) {
        const v = src[i];
        dst[i] = buf[r];
        buf[w] = v;
        w = (w + 1) & IN_MASK; r = (r + 1) & IN_MASK;
      }
    }
    this.count += n;
  }
}
// ---8<--- END VERBATIM COPY: extension/engine/pitch.js ---8<---
// ---8<--- BEGIN VERBATIM COPY: extension/engine/pitchbank.js ---8<---
/**
 * The seven deck lanes under transpose — routing, bank switching, crossfade.
 *
 * `pitch.js` shifts ONE stereo stream. This file is the thing the deck actually
 * needs: seven stereo lanes (the six stems plus the passthrough mix) that all
 * come out with EXACTLY the same delay, a transpose that can be changed under a
 * running stream without a click, and no allocation after the first engage.
 *
 *   lane 0  drums        MatchedDelay          ALWAYS. Never shifted. product ruling.
 *   lane 1  bass         PitchShifter(k)
 *   lane 2  other        PitchShifter(k)
 *   lane 3  vocals       PitchShifter(k)
 *   lane 4  guitar       PitchShifter(k)
 *   lane 5  piano        PitchShifter(k)
 *   lane 6  passthrough  PitchShifter(k)       see "THE PASSTHROUGH DECISION"
 *
 * ZERO IMPORTS EXCEPT `./pitch.js`, ON PURPOSE, and for the same reason that file
 * has none: everything above the self-check banner is copied VERBATIM into
 * `offscreen/playback-processor.js`, where `import` does not exist. The copy is
 * not a promise — `worklet-copy-is-verbatim` below reads the worklet source and
 * diffs it against this file, so drift is a red, not a code review.
 *
 * `node extension/engine/pitchbank.js` runs the checks.
 *
 * ------------------------------------------------- WHY DRUMS ARE NOT SHIFTED
 *
 * A phase vocoder's weakest material is a broadband transient, and the whole
 * drum stem is broadband transients. Every other product has to MITIGATE that
 * (better onset handling, shorter windows, transient/steady splitting) because
 * it only has a mix. This one has the stems already, so it can REMOVE the risk
 * instead: run the five harmonic stems through the shifter and put the drums
 * through a pure integer delay of exactly the same length.
 *
 * That only works because `PITCH_GROUP_DELAY_SAMPLES` is CONSTANT across all 13
 * settings including bypass, so all fourteen planes stay sample-aligned STRUCTURALLY
 * rather than by inspection (docs/AUDIO.md §8.1: Δ between stems must be 0; a
 * 4-sample skew combs at 5.5 kHz). `all-lanes-are-one-exact-delay` is the
 * assertion, and `drums-lane-is-never-shifted` is the one that fails if someone
 * "simplifies" the routing later.
 *
 * THE DRUMS LANE IS NOT PART OF A BANK. It is one `MatchedDelay` on this object,
 * run once per block whatever else is happening. That is not a micro-optimisation
 * — it is a correctness requirement. Both banks would render the drums
 * IDENTICALLY (same delay line, same input), and crossfading two identical
 * signals under an EQUAL-POWER law is +3.01 dB, so every interval change would
 * have put a 50 ms kick-drum bump in the mix. The correlation argument below
 * decides the law; keeping drums out of the fade removes the one lane where the
 * law's premise is false.
 *
 * ------------------------------------------------- THE PASSTHROUGH DECISION
 *
 * Planes 12/13 carry the UNSEPARATED MIX, and only during a span the backpressure
 * ladder had to skip (engine/live.js LiveEmitter.gap). They ARE shifted. Both
 * options are defensible and the reasoning is written here rather than left to
 * be re-derived:
 *
 *   AGAINST shifting — the mix contains the drums, so during a dropped span the
 *   drums go through the vocoder after all. The risk we removed comes back.
 *
 *   FOR shifting, and this is the one that wins — a listener playing along in
 *   the transposed key would hear the record JUMP BACK TO CONCERT PITCH for one
 *   hop (~2 s) and then jump again. A wrong-key span is a musical error the user
 *   ACTS ON: they are fingering a horn against it. A drum-transient artefact is
 *   a quality reduction of a span that is ALREADY advertised as degraded (the
 *   console paints PASSTHROUGH, the stem faders are inert there, and QA-15 may
 *   have ducked it to silence anyway). Degrading quality on a degraded span is
 *   proportionate; changing key is not.
 *
 * Two facts make the cost small. At `semitones === 0` — the default, and the
 * state every existing soak ran in — there is no shifter in the path at all
 * (see `_bankSet`), so this costs literally nothing unless the feature is in
 * use. And the core's transient handling is specifically the fix for this
 * material: worst click position error 1 sample at +6, 10-90 % attack rise 28
 * samples, both measured in pitch.js.
 *
 * ------------------------------------------------- CHANGING THE INTERVAL
 *
 * `setSemitones()` on a live `PitchShifter` is length- and latency-exact but its
 * SYNTHESIS PHASE is discontinuous, which is an audible click on tonal material
 * (pitch.js, `setSemitones` doc). So the interval is changed by crossfading TWO
 * banks, and the schedule is forced by the group delay:
 *
 *   t0            the request lands. Bank NEW is reset to k1 and starts eating
 *                 the same input; bank OLD keeps playing.
 *   t0 .. t0+D    PRIME. NEW's output here is not usable — its output sample m
 *                 carries input m-D, which is before the stream it has seen
 *                 began, so the whole window is the vocoder's zero-padded
 *                 ramp-up. Crossfading into it any earlier is crossfading into
 *                 a hole. MEASURED against a steady-state instance fed the same
 *                 tone, at +5/-5/+6/+1: below -220 dB out to m = 2304, still
 *                 -26 to -33 dB at m = 2560, and within 1 dB of steady state at
 *                 m = D exactly. So D is not a safety margin, it is the number:
 *                 512 samples short of it is a 26 dB hole. The two assertions
 *                 `prime-window-reaches-full-level-at-the-group-delay` and
 *                 `crossfading-before-the-group-delay-would-fade-into-a-hole`
 *                 are the two ends of that, and neither can pass vacuously.
 *   t0+D .. +X    CROSSFADE. Both banks now carry the SAME INPUT INSTANT at the
 *                 same output sample (OLD: T-D; NEW: t0+(T-t0)-D = T-D), so the
 *                 fade is between two renderings of one moment, not two moments.
 *   after         OLD is released and stops being fed.
 *
 * EQUAL POWER, not linear, and this is the opposite of `SEAM_XFADE_LAW` on
 * purpose. The deciding variable is correlation, not the word "crossfade"
 * (shared/config.js says so at length). The seam law is linear because the two
 * chunks are two estimates of the SAME audio, corr ~0.99, so their AMPLITUDES
 * add. Here the two sides are the same music at two DIFFERENT PITCHES: their
 * partials are at different frequencies, so they are uncorrelated and their
 * POWERS add. Linear would dip ~2.7 dB through the middle of every transpose
 * change; `switch-holds-level-through-the-crossfade` measures it against a gate
 * that a linear law cannot pass.
 *
 * --------------------------------------------- THE FRAME-GRID STAGGER
 *
 * A shifter's cost is BIMODAL: the synthesis hop is 512 samples and the render
 * quantum is 128, so one quantum in four carries an STFT frame and the other
 * three carry only the resampler. Every shifter in a bank is reset at the same
 * instant, so without help they all hit that frame in the SAME quantum and the
 * PEAK scales with the shifter count while the mean scales with the work.
 *
 * At four shifted lanes that was survivable and was written down as a ponytail
 * (`2 decks BOTH switching non-stop`, p95 2.616 ms of 2.902). At SIX it is not.
 *
 * COUNTED, NOT TIMED, and that choice is the important part of this section.
 * This machine cannot carry a millisecond figure: three consecutive runs of one
 * build put `cost-at-+6`'s p95 at 0.997, 0.991 and 1.685 ms (max 4.17, 4.08,
 * 23.55) and the third went red on a gate the first two cleared by 30 %.
 * a median wants >= 300 s for a median and these windows are ~6 s of wall
 * clock. So the numbers this file RULES on are frame counts, which read the
 * same on a quiet box and a loud one - the three runs above produced peak 5,
 * mean 3.182, 6364 frames, identical to the last digit.
 *
 * Frames landing in the SAME render quantum, two decks both transposed:
 *
 *                                            peak    mean    lanes running
 *   4 lanes, colliding (the build that ships)   8    2.121     8
 *   6 lanes, colliding                         12    3.182    12
 *   6 lanes, STAGGERED (this build)             5    3.182    12
 *
 * Read the mean column first: 3.182 / 2.121 = 1.500, exactly, and the resampler
 * term scales 8 -> 12 the same way. SIX STEMS DO ONE AND A HALF TIMES THE WORK
 * AND NOTHING CAN MAKE THEM NOT. What the stagger moves is the PEAK, and it
 * moves it far enough that six staggered lanes pile up LESS than the four-lane
 * build that shipped - 5 against 8 - while carrying 1.5x the work.
 *
 * The one wall-clock statement worth keeping is a RATIO measured back-to-back
 * in one process, ABBA-interleaved so drift lands on both arms: collide/stagger
 * p95 is 1.63x at +6 and 2.14x at -6, eight passes, per-pass spread under 2 %.
 * The p50 ratio is 0.36x and 0.53x - i.e. the staggered median is HIGHER. That
 * pair IS the mechanism: a distribution that was cheap three quanta in four and
 * brutal on the fourth becomes flat, with the same area under it.
 *
 * `2 decks both transposed` is the row that forced this. It is STEADY STATE for
 * the flagship dual-deck gesture - no drag, no switch, just two transposed decks
 * playing - and at six lanes with the grids colliding it piles 12 frames into
 * one quantum, half again what the shipped build ever did.
 *
 * HOW IT IS DONE, and why it is NOT the upgrade path this comment used to name.
 * The old note said to change `reset()`'s `nextS`/`nextA` in pitch.js plus the
 * content anchor to match, "because otherwise every lane's delay moves and Δ
 * stops being 0". That is true of reaching into the core. It is not necessary:
 * a shifter's delay is defined in ITS OWN stream - output sample m carries input
 * m - D - so feeding it `off` samples of PRE-STREAM SILENCE and dropping the
 * `off` outputs they produce moves its grid by `off` and moves its delay by
 * NOTHING. `_stagger()` does exactly that, from outside the core, with no change
 * to pitch.js and therefore no change to the content anchor.
 * `all-lanes-are-one-exact-delay` and `drums-lane-is-never-shifted` are the
 * assertions that would catch it if that reasoning were wrong; both still read
 * -inf dB.
 *
 * The offsets are `PITCH_GRID_OFFSETS`, one render quantum apart, cycling every
 * four lanes. Six lanes over four quanta cannot be flat - the counts are
 * 2,2,1,1 - so the peak is a third of the colliding case rather than a sixth.
 * A SECOND phase between the two BANKS was built and measured and then deleted:
 * across the three multi-deck rows it moved p95 by 0.01-0.08 ms, i.e. inside the
 * run-to-run spread, and it is not worth a constant.
 *
 * ------------------------------------------------------------------- COST
 *
 * THIS SECTION DELIBERATELY CARRIES NO ABSOLUTE MILLISECOND VERDICT, and the
 * reason is evidence, not caution. Three consecutive runs of ONE build, nothing
 * in the diff moving:
 *
 *                        run 1    run 2    run 3
 *   1 deck at +6  p50    0.737    0.734    0.802
 *                 p95    0.997    0.991    1.685      <- 69 % swing, one red
 *                 max    4.173    4.077   23.554      <- 5.6x
 *   2 decks +6/-6 peak      5        5        5       <- counted, not timed
 *                 mean  3.182    3.182    3.182
 *                 frames 6364     6364     6364
 *
 * The wall clock moved by 69 % at p95 and produced a false red; the frame counts
 * did not move a digit. QA independently saw this suite take 38.4 s and 46.1 s
 * on identical code with `chroma` and `keytap` inflating ~40 % alongside. This
 * box has had up to eight agents on it all day, a median wants >= 300 s for
 * a median, and section 8 times ~6 s of wall clock per row. So:
 *
 *   - the DEADLINE is ruled on by frame COUNT (see THE FRAME-GRID STAGGER above
 *     and `bank-peak-frame-concentration-...` in section 8). Deterministic,
 *     comparable across processes, gated against the FOUR-lane build rather
 *     than against a millisecond figure from today;
 *   - the STAGGER BEING PRESENT is ruled on by reading the grids back off the
 *     running banks (`every-running-bank-has-the-frame-grid-stagger-applied`),
 *     which names the defect instead of inferring it from a slow p95;
 *   - the only wall clock left gates the semitones-0 DEFAULT state at 0.005 ms
 *     against a 0.145 ms gate — 29x headroom, and it has never moved.
 *
 * The +6 and -6 timing rows were CUT (2026-08-16), not merely relabelled.
 * Section 8 carries the full record of what they read and why shrinking them to
 * a tenth made them worse rather than better. Do not lift a millisecond figure
 * from this file into a ratified document: the ratios-and-counts rule forbids quoting
 * an absolute RTF for exactly this reason, and the p95 column above is why.
 *
 * TWO ZEROED-VECTOR p95s ARE ON RECORD - 3.529 ms (QA's `--quick`) and 3.193 ms
 * (this file's own deliberate red-check). They are TWO DIFFERENT PROCESSES, not
 * one window quoted twice; both are withdrawn milliseconds and neither is the
 * zeroed-vector p95. The zeroed configuration's honest number is a count, and it
 * reproduces exactly: two decks at +6/-6 with six colliding lanes is
 * PEAK 12, MEAN 3.182 - against PEAK 5, MEAN 3.182 staggered. Same mean, because
 * the stagger moves peaks and not work.
 *
 * ------------------------------------------------ WHAT THIS SUITE COSTS, AND WHERE
 *
 * This file is the most expensive step in `--quick` and has been called out for
 * it twice. The breakdown is here so that "pitchbank is slow" is a decision
 * anyone can make instead of folklore someone has to re-measure. Per section,
 * wall clock, one M-series Mac, and treat these as indicative for the same
 * reason everything else in this section is:
 *
 *                                        before      after
 *   4  allocation                          9.6 s      2.2 s   <- 48 s of fixture
 *                                                              audio -> 13 s
 *   7  the shipped worklet, in a VM        7.3 s      6.9 s   <- the next lever
 *   8  cost                              ~30   s     ~4   s   <- timing rows cut
 *   3  switching under a running stream    3.3 s      3.1 s
 *   1, 2, 5, 6                            ~1.6 s     ~1.6 s
 *   TOTAL                                ~40   s     18.7 s   (18.78/18.61/18.68
 *                                                              over three runs)
 *
 * THE NEXT LEVER IS SECTION 7, and it is a different trade from the two already
 * taken: it boots seven AudioWorklet processors in a `vm` realm and pumps real
 * audio through the SHIPPED file. It is the only place outside a browser that
 * the transposed live path runs at all, which is exactly why `tools/verify.mjs`
 * argued for keeping this suite in `--quick` when it cost 16.8 s. Shrink it only
 * if you are willing to say which of those seven boots is redundant.
 *
 * Section 4 and section 8 were both shrunk on 2026-08-16 and only one of them
 * was safe to shrink for its stated reason - see the note above section 4's
 * fixture. The property that decided it was COUNT vs STATISTIC, not runtime.
 *
 * READ THE FIRST NUMBER A COLD PROCESS PRODUCES WITH SUSPICION - a separate
 * effect from contention and worth knowing independently. Measured standalone,
 * `1 deck at +6` reads mean 1.70 ms with 400 quanta of burn-in and 0.77 ms with
 * 4400, FLAT across all 8000 timed quanta either way, so it never shows up as a
 * trend inside the row. It is the first shifter-heavy workload in the process
 * paying for its own optimisation, and section 7 makes it worse by driving four
 * processors at semitones 0, which makes `_bankRun`'s `unit.process` call site
 * polymorphic. Section 8 burns the optimiser in before timing anything.
 *
 * ponytail: `2 decks BOTH switching non-stop` - four banks, 24 stereo vocoders -
 * is the one configuration the stagger cannot rescue, and the argument is
 * arithmetic rather than a stopwatch. The stagger moves peaks; it cannot move
 * the MEAN, which is exactly 1.5x the four-lane build's by frame count. The
 * four-lane build already ran that row at p95 2.616 of a 2.902 ms deadline -
 * 90 %, recorded as a ceiling at the time - so 1.5x the work cannot fit, and the
 * timing runs agree (they put it at the wall) for whatever a timing run here is
 * worth. CEILING: two decks both transposed with both users dragging the
 * transpose control at once can miss a render quantum. It needs both decks
 * transposed AND both mid-switch, so it is a ~120 ms window per gesture, and
 * Mode 3 is V2 - but it is the wall, and it is `docs/SIX-STEM-CONTRACT.md` debt
 * item 1 in its post-stagger form. UPGRADE PATH: the work itself has to come
 * down, not move - a shorter synthesis window for the two new lanes, or refusing
 * a second in-flight switch while another deck is already mid-switch (the state
 * is already tracked; `pending` would just have to be honoured across decks).
 */


// ============================================================== public constants

/** drums, bass, other, vocals, guitar, piano, passthrough — one stereo lane each. */
const PITCH_LANES = 7;
/** shared/stemring.js PLANES, duplicated: lane L is planes 2L and 2L+1. */
const PITCH_PLANES = 14;
/** Lane 0 is drums and is NEVER in this list. Read the header before changing it. */
const PITCH_SHIFTED_LANES = Object.freeze([1, 2, 3, 4, 5, 6]);

/**
 * FRAME-GRID STAGGER, in samples, one per entry of `PITCH_SHIFTED_LANES` — the
 * pre-stream silence that lane's shifter eats at `_bankSet` so its STFT frames
 * land in a different render quantum from its siblings'. Read "THE FRAME-GRID
 * STAGGER" in the header: what it buys, why it costs no alignment, and why the
 * second phase between the two banks was measured and then deleted.
 *
 * ONE RENDER QUANTUM APART, cycling every `hop / quantum` = 4 lanes. The
 * granularity is the QUANTUM and not something finer because a frame either
 * lands inside a given `process()` call or it does not; two lanes 64 samples
 * apart still collide. 128 is fixed by the Web Audio spec, not by `maxBlock`.
 */
const PITCH_GRID_OFFSETS = Object.freeze(PITCH_SHIFTED_LANES.map(
  (_l, i) => (i % (PITCH_SYNTH_HOP / 128)) * 128));

// ================================================================== PitchLanes

class PitchLanes {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate] 44100 on the live path. Only the crossfade
   *        length is derived from it; the shifter itself is rate-agnostic.
   * @param {number} [o.maxBlock] largest block processed in one internal pass.
   *        128 in the worklet — the render quantum. Bigger blocks loop.
   * @param {number} [o.xfadeMs]
   */
  constructor(o = {}) {
    this.sr = o.sampleRate || 44100;
    this.maxBlock = o.maxBlock || 128;
    this.xfLen = Math.max(1, Math.round(((o.xfadeMs ?? PITCH_SWITCH_XFADE_MS) / 1000) * this.sr));

    // Equal-power ramps, half-sample centred so the pair is symmetric and both
    // ends are strictly inside (0,1) — engine/live.js makeFades, same argument.
    this.fi = new Float32Array(this.xfLen);
    this.fo = new Float32Array(this.xfLen);
    for (let i = 0; i < this.xfLen; i++) {
      const u = (i + 0.5) / this.xfLen;
      this.fi[i] = Math.sqrt(u);
      this.fo[i] = Math.sqrt(1 - u);
    }

    /** Lane 0. Outside the banks on purpose — see the header. */
    this.drums = new MatchedDelay(2);

    /**
     * Two banks, lanes 1-6 only. `md` is allocated up front (a delay line is
     * 128 KB and costs nothing to build); `sh` stays null until the user first
     * engages the transpose, because allocating twelve stereo phase vocoders and
     * designing a resample kernel is ~3 ms and the default state never needs it.
     */
    this.banks = [this._makeBank(), this._makeBank()];
    this.cur = this.banks[0];
    this.nxt = this.banks[1];
    /** how many times a PitchShifter has ever been constructed here. */
    this.allocations = 0;

    /** the interval the lanes are converging to. */
    this.target = 0;
    /** the interval fully in effect (differs from `target` only mid-switch). */
    this.applied = 0;
    /** null, or a target queued because a switch was already in flight. */
    this.pending = null;

    this.switching = false;
    this.primeLeft = 0;
    this.xfPos = 0;
    this.switches = 0;

    // scratch: two sets of 14 planes, maxBlock frames. Allocated once.
    this.a = Array.from({ length: PITCH_PLANES }, () => new Float32Array(this.maxBlock));
    this.b = Array.from({ length: PITCH_PLANES }, () => new Float32Array(this.maxBlock));
    // reused argument pairs, so the hot path never builds an array
    this._i2 = [null, null];
    this._o2 = [null, null];

    // Stagger scratch: the pre-stream silence a shifter eats at `_bankSet`, and
    // somewhere to throw its output. Never on the per-block path; allocated here
    // because `_bankSet` runs inside the audio thread's message handler.
    const gmax = PITCH_GRID_OFFSETS.reduce((m, v) => (v > m ? v : m), 0);
    this._zin = [new Float32Array(gmax), new Float32Array(gmax)];
    this._zout = [new Float32Array(gmax), new Float32Array(gmax)];
  }

  _makeBank() {
    const md = new Array(PITCH_LANES).fill(null);
    for (const l of PITCH_SHIFTED_LANES) md[l] = new MatchedDelay(2);
    return { semi: 0, md, sh: null };
  }

  /** Constant, every setting, every lane. Downstream adds this to its latency readout. */
  get delaySamples() { return PITCH_GROUP_DELAY_SAMPLES; }

  /**
   * Build the phase vocoders. Called at most once per instance, off the steady
   * state: the FIRST non-zero transpose request pays for it.
   *
   * Measured at six lanes: the whole first engage — twelve stereo instances,
   * the kernel bank, and `_bankSet`'s stagger — is ~1.8-2.1 ms warm and ~13 ms
   * on the very first call in a process, the difference being JIT and not work.
   * The kernel bank is ~2 ms the first time a given resample cutoff is seen (the
   * 128-tap Kaiser bank is 513 branches of besselI0). All seven down-shifts and
   * bypass share ONE cutoff (0.5 exactly), so only the six up-shifts can pay that
   * cost, and each pays it once per AudioWorkletGlobalScope because pitch.js
   * caches the bank at module scope — which means deck B never pays it at all.
   *
   * ponytail: that ~2 ms lands on the audio render thread, inside the port
   * message handler, once per session, at the instant the user first grabs the
   * transpose control. It fits inside the output buffer's slack (~48 ms of
   * outputLatency, 16 quanta) so it cannot underrun, but it IS a render-thread
   * task longer than one quantum. CEILING: on a machine 3x slower it is ~6 ms,
   * still inside the slack but not by much. UPGRADE PATH: design the kernel
   * banks on the offscreen MAIN thread (they are plain Float64Arrays) and post
   * them into the worklet's `kernelCache` before the first engage.
   */
  _ensureShifters() {
    for (const bank of this.banks) {
      if (bank.sh) continue;
      const sh = new Array(PITCH_LANES).fill(null);
      for (const l of PITCH_SHIFTED_LANES) { sh[l] = new PitchShifter(0, 2); this.allocations++; }
      bank.sh = sh;
    }
  }

  /**
   * Point a bank at an interval and wipe its history. Exactly the sequence
   * `PitchShifter`'s own constructor uses (`_setRatio` then `reset`), expressed
   * through the public API so this file never reaches into the core's privates:
   * `setSemitones` re-anchors (harmless — `reset` is about to wipe it) and
   * early-returns when the value has not changed (also harmless, for the same
   * reason). The kernel bank lookup inside it is the only real work.
   *
   * AT ZERO SEMITONES THERE IS NO PHASE VOCODER IN THE PATH. `bypass-is-identity`
   * and `matched-delay-tracks-the-shifter` together say a `PitchShifter(0)` and a
   * `MatchedDelay` agree to below -120 dB sample for sample, so substituting the
   * delay is inaudible by the core's own measurement — and it takes the DEFAULT
   * state, which is every session that never touches the control and every soak
   * this project has already run, from ~17 % of a core to ~0.7 %.
   */
  _bankSet(bank, k) {
    bank.semi = k;
    for (let i = 0; i < PITCH_SHIFTED_LANES.length; i++) {
      const l = PITCH_SHIFTED_LANES[i];
      if (k === 0) { bank.md[l].reset(); continue; }
      bank.sh[l].setSemitones(k);
      bank.sh[l].reset();
      this._stagger(bank.sh[l], PITCH_GRID_OFFSETS[i]);
    }
  }

  /**
   * Eat `off` samples of pre-stream silence, throwing the output away, so this
   * shifter's STFT frame grid sits `off` samples away from its siblings'.
   * `PITCH_GRID_OFFSETS` is why; the header's "THE FRAME-GRID STAGGER" is the
   * proof that it costs no alignment.
   *
   * This is the ONLY place the offset is created and it is deliberately NOT on
   * the per-block path: a shifter's delay is measured in its OWN stream, so
   * feeding it `off` extra samples ahead of the stream and dropping the `off`
   * outputs they produce leaves output sample m carrying input m - D exactly as
   * before, at every lane and every interval.
   *
   * ponytail: this is not free and it is not amortised. `_bankSet` goes from
   * 0.038 ms to 0.358 ms measured — 896 samples of vocoder work across the six
   * lanes — and it lands on the render thread inside the port message handler,
   * once per ACCEPTED interval change. That is 12 % of a render quantum against
   * ~48 ms of output-buffer slack, so it cannot underrun, and it buys the p95
   * numbers in the header. CEILING: a control being dragged coalesces to one
   * switch at a time (`pending`), so the worst case is one of these per completed
   * switch — one per 3072 + 2205 samples, ~8 per second, 0.3 % of a core.
   * UPGRADE PATH: spend the offset
   * inside the existing 3072-sample prime instead of ahead of it — the output is
   * discarded there anyway — which needs `_bankRun` to feed one bank a different
   * frame count per lane, i.e. a per-lane budget threaded through the hot path.
   * Not worth it until a profile says this spike matters.
   */
  _stagger(sh, off) {
    const zi = this._zin, zo = this._zout;
    let done = 0;
    while (done < off) {
      const m = Math.min(zi[0].length, off - done);
      sh.process(zi, zo, m);
      done += m;
    }
  }

  /**
   * Lanes 1-6 of one bank, n frames, reading `inPl` at `inOff` and writing
   * `outPl` at `outOff`.
   *
   * The `=== 0` branches exist so the worklet's hot path (one 128-frame block,
   * both offsets zero) allocates NOTHING: `subarray` mints a new TypedArray
   * object every call, and 48 of those per render quantum is GC pressure on the
   * audio thread. Every other host takes the slow path.
   */
  _bankRun(bank, inPl, inOff, outPl, outOff, n) {
    const i2 = this._i2, o2 = this._o2;
    for (const l of PITCH_SHIFTED_LANES) {
      const unit = bank.semi === 0 ? bank.md[l] : bank.sh[l];
      const iL = inPl[2 * l], iR = inPl[2 * l + 1];
      const oL = outPl[2 * l], oR = outPl[2 * l + 1];
      i2[0] = inOff === 0 ? iL : iL.subarray(inOff, inOff + n);
      i2[1] = inOff === 0 ? iR : iR.subarray(inOff, inOff + n);
      o2[0] = outOff === 0 ? oL : oL.subarray(outOff, outOff + n);
      o2[1] = outOff === 0 ? oR : oR.subarray(outOff, outOff + n);
      unit.process(i2, o2, n);
    }
  }

  /**
   * Request an interval. Integer in [-6, +6]; anything else is REFUSED and the
   * lanes keep the interval they had, because the alternative — clamping — turns
   * a UI bug into a wrong key the user cannot see.
   *
   * @returns {boolean} true if the request was accepted (a no-op counts).
   */
  setSemitones(k) {
    if (!Number.isInteger(k) || k < PITCH_MIN_SEMITONES || k > PITCH_MAX_SEMITONES) return false;
    if (k === this.target) { this.pending = null; return true; }
    // One switch at a time: a user dragging the control must not spawn a third
    // bank. The last request wins and is applied the moment this one lands.
    if (this.switching) { this.pending = k; return true; }
    this._beginSwitch(k);
    return true;
  }

  _beginSwitch(k) {
    if (k !== 0) this._ensureShifters();
    this._bankSet(this.nxt, k);
    this.target = k;
    this.switching = true;
    this.primeLeft = PITCH_GROUP_DELAY_SAMPLES;
    this.xfPos = 0;
    this.switches++;
  }

  _completeSwitch() {
    const old = this.cur;
    this.cur = this.nxt;
    this.nxt = old;
    this.applied = this.cur.semi;
    this.switching = false;
    this.primeLeft = 0;
    this.xfPos = 0;
    const p = this.pending;
    this.pending = null;
    if (p !== null && p !== this.target) this._beginSwitch(p);
  }

  /**
   * A HARD DISCONTINUITY — seek, deck load, track change, live restart.
   * docs/ARCHITECTURE.md §3.9: the input stream jumps, so the D samples of
   * history inside every lane belong to a different piece of music and must not
   * be emitted. Clearing them costs one group delay of silence at the seam,
   * which the deck's own ring gating already covers; NOT clearing them bleeds
   * 70 ms of the previous position over the new one.
   *
   * Any switch in flight is abandoned: the interval being converged to simply
   * becomes the interval, from the first sample.
   */
  reset() {
    const k = this.pending !== null ? this.pending : this.target;
    if (k !== 0) this._ensureShifters();
    this.pending = null;
    this.target = k;
    this.applied = k;
    this.switching = false;
    this.primeLeft = 0;
    this.xfPos = 0;
    this.drums.reset();
    this._bankSet(this.cur, k);
    this._bankSet(this.nxt, k);
  }

  /**
   * @param {Float32Array[]} inPl  PITCH_PLANES planes, >= n valid frames
   * @param {Float32Array[]} outPl PITCH_PLANES planes, >= n frames of room
   * @param {number} n
   *
   * Writes exactly n frames to every plane. Safe with `inPl === outPl`.
   */
  process(inPl, outPl, n) {
    let done = 0;
    while (done < n) {
      const m = Math.min(this.maxBlock, n - done);
      this._run(inPl, outPl, done, m);
      done += m;
    }
  }

  _run(inPl, outPl, off, n) {
    // ---- lane 0, drums. One delay line, run once, never crossfaded.
    {
      const i2 = this._i2, o2 = this._o2;
      i2[0] = off === 0 ? inPl[0] : inPl[0].subarray(off, off + n);
      i2[1] = off === 0 ? inPl[1] : inPl[1].subarray(off, off + n);
      o2[0] = off === 0 ? outPl[0] : outPl[0].subarray(off, off + n);
      o2[1] = off === 0 ? outPl[1] : outPl[1].subarray(off, off + n);
      this.drums.process(i2, o2, n);
    }

    if (!this.switching) { this._bankRun(this.cur, inPl, off, outPl, off, n); return; }

    this._bankRun(this.cur, inPl, off, this.a, 0, n);
    this._bankRun(this.nxt, inPl, off, this.b, 0, n);
    const a = this.a, b = this.b, fi = this.fi, fo = this.fo;

    let i = 0;
    while (i < n) {
      if (this.primeLeft > 0) {
        // Bank NEW is still filling its group delay and is emitting exact zeros.
        const m = Math.min(n - i, this.primeLeft);
        for (const l of PITCH_SHIFTED_LANES) {
          for (let c = 0; c < 2; c++) {
            const q = 2 * l + c, d = outPl[q], s = a[q];
            for (let j = 0; j < m; j++) d[off + i + j] = s[i + j];
          }
        }
        this.primeLeft -= m; i += m;
      } else if (this.xfPos < this.xfLen) {
        const m = Math.min(n - i, this.xfLen - this.xfPos);
        const p = this.xfPos;
        for (const l of PITCH_SHIFTED_LANES) {
          for (let c = 0; c < 2; c++) {
            const q = 2 * l + c, d = outPl[q], s0 = a[q], s1 = b[q];
            for (let j = 0; j < m; j++) d[off + i + j] = s0[i + j] * fo[p + j] + s1[i + j] * fi[p + j];
          }
        }
        this.xfPos += m; i += m;
      } else {
        const m = n - i;
        for (const l of PITCH_SHIFTED_LANES) {
          for (let c = 0; c < 2; c++) {
            const q = 2 * l + c, d = outPl[q], s = b[q];
            for (let j = 0; j < m; j++) d[off + i + j] = s[i + j];
          }
        }
        i += m;
      }
    }
    if (this.primeLeft === 0 && this.xfPos >= this.xfLen) this._completeSwitch();
  }

  /**
   * What the audio thread ACTUALLY has. On the diagnostic path for the same
   * reason the worklet's gain vector is: this state lives ONLY here, so without
   * it nothing outside the render thread can tell "the transpose is applied"
   * from "the message was dropped on the floor".
   */
  stats() {
    return {
      target: this.target,
      applied: this.applied,
      pending: this.pending,
      switching: this.switching,
      switches: this.switches,
      primeLeft: this.primeLeft,
      xfPos: this.xfPos,
      xfLen: this.xfLen,
      delaySamples: PITCH_GROUP_DELAY_SAMPLES,
      allocations: this.allocations,
      shifted: this.cur.semi !== 0 || (this.switching && this.nxt.semi !== 0),
    };
  }
}
// ---8<--- END VERBATIM COPY: extension/engine/pitchbank.js ---8<---

// ============================================================ the processor

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.cap = o.capacity;
    this.mask = this.cap - 1;
    this.hdr = new Int32Array(o.sab, 0, 32);
    this.pl = [];
    for (let q = 0; q < NPLANES; q++) {
      this.pl.push(new Float32Array(o.sab, HEADER_BYTES + q * this.cap * 4, this.cap));
    }

    this.sr = o.sampleRate || sampleRate;
    // gain state: 6 stems + passthrough + master
    this.g = new Float64Array(NSTEMS + 2).fill(0);
    this.gt = new Float64Array(NSTEMS + 2).fill(0);
    this.ga = new Float64Array(NSTEMS + 2).fill(1);      // one-pole coefficient
    this.gd = new Int32Array(NSTEMS + 2);                // samples left until the exact snap
    // stems start at unity, passthrough at unity (it is only non-zero when a
    // chunk was skipped), master at unity — all with no ramp on the first block.
    for (let i = 0; i < NSTEMS + 2; i++) { this.g[i] = 1; this.gt[i] = 1; }

    /**
     * Crossfader factor per stem, applied AFTER the meter tap. docs/AUDIO.md and
     * the product ruling: METERS are post-stem-fader, PRE-crossfader, pre-soft-clip,
     * because a DJ cues an incoming deck by watching meters on a channel that is
     * crossfaded fully out. Mute and solo are in the metered gain and still zero
     * it; only the crossfader is invisible to the meter.
     */
    this.x = new Float64Array(NSTEMS).fill(1);
    this.xt = new Float64Array(NSTEMS).fill(1);
    this.xa = new Float64Array(NSTEMS).fill(1);
    this.xd = new Int32Array(NSTEMS);

    /**
     * PER-STEM TRANSPOSE. Seven stereo lanes, one shared 3072-sample delay,
     * drums never shifted. At the default of 0 semitones there is no phase
     * vocoder in the path at all — seven delay lines — so a session that never
     * touches the control pays nothing. See engine/pitchbank.js.
     */
    this.pitch = new PitchLanes({ sampleRate: this.sr, maxBlock: Q });
    /**
     * Post-ring, pre-gain scratch: the seven stereo lanes on their way through
     * the transpose. Allocated once. The render quantum is fixed at 128 by the
     * Web Audio spec; the guard in process() exists so that a future host with a
     * different quantum degrades to one allocation rather than to garbage.
     */
    this.sb = [];
    for (let q = 0; q < NPLANES; q++) this.sb.push(new Float32Array(Q));
    /** transpose requests refused at this boundary — see onMessage. */
    this.pitchRefused = 0;

    // starvation fade (never a discontinuity — docs/ARCHITECTURE.md §3.8 L5)
    this.fadeLen = Math.max(1, Math.round(((o.panicFadeMs || 20) / 1000) * this.sr));
    this.fade = 1;             // 1 = fully audible, 0 = fully faded out
    this.starved = false;
    this.lowWater = Math.max(Q * 2, Math.round((o.lowWaterSec || 0.05) * this.sr));

    // metering. NSTEMS channel taps plus the master at index NSTEMS; the
    // passthrough lane is summed but never metered (it has no channel strip).
    this.peak = new Float32Array(NSTEMS + 1);
    this.sq = new Float64Array(NSTEMS + 1);
    this.sqN = 0;
    /**
     * PER-BLOCK meter accumulators, hoisted out of `process()` because nothing
     * may allocate inside the render callback. They are the rolled-loop
     * equivalent of the `pk0..pk3` / `s0..s3` locals this loop used when it was
     * hand-unrolled for four stems: accumulate the block here, fold into
     * `peak`/`sq` once at the end, so the sum-of-squares rounding order is the
     * same per-block-then-merge it always was.
     */
    this.pkB = new Float64Array(NSTEMS + 1);
    this.sqB = new Float64Array(NSTEMS + 1);
    this.meterEvery = Math.max(Q, Math.round(this.sr / (o.meterHz || 30)));
    this.meterAcc = 0;
    this.healthEvery = Math.max(Q, Math.round(this.sr / (o.healthHz || 10)));
    this.healthAcc = 0;
    this.clip = 0;
    // Minimum cushion seen since the last health post. Sampled every render
    // quantum (2.9 ms) because the ring depth sawtooths by a whole hop and its
    // trough is a sharp point: a 10 Hz poll of the instantaneous value misses
    // the extreme by up to 100 ms of drain. Same argument as metering here
    // rather than in an AnalyserNode (docs/AUDIO.md §4.3).
    this.minCushion = Infinity;
    this.lastL = 0; this.lastR = 0;   // held sample for the raised-cosine fade-out

    this.running = true;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  /** {t:'gain', i, value, tau} — i: 0..5 stems, 6 passthrough, 7 master */
  onMessage(m) {
    if (m.t === 'xf') {
      // Post-meter crossfader factor, one per stem. Ramped like everything else.
      const i = m.i | 0;
      if (i < 0 || i >= NSTEMS) return;
      this.xt[i] = m.value;
      const tau = Math.max(m.tau || 0.003, 1e-5);
      this.xa[i] = 1 - Math.exp(-1 / (tau * this.sr));
      this.xd[i] = Math.ceil(6 * tau * this.sr);
      return;
    }
    if (m.t === 'pitch') {
      /**
       * THE UI -> ENGINE TRANSPOSE MESSAGE, fixed by the spec:
       * `{ t: 'pitch', semitones }`, integer in [-6, +6].
       *
       * Validated at the audio-thread boundary and REFUSED rather than clamped
       * or coerced, for the same reason the gain guard below it exists
       * (review finding P3-M2): a malformed value that gets coerced becomes a wrong
       * KEY, and a wrong key is silent — the audio keeps playing, in time, at
       * the wrong pitch, and the user's ear blames the detector. `PitchLanes`
       * does the range check and returns false; the counter is on the `report`
       * payload so a refused message is visible from outside the render thread
       * instead of vanishing.
       */
      if (!this.pitch.setSemitones(m.semitones)) this.pitchRefused++;
      return;
    }
    if (m.t === 'gain') {
      const i = m.i | 0;
      if (i < 0 || i >= NSTEMS + 2) return;
      // Review finding P3-M2: validate at the audio-thread boundary. A NaN target
      // poisons g[i] on the next sample (`g += (NaN - g) * a`), and every sample
      // of every plane is multiplied by it — the whole bus goes NaN. Recovery
      // needs a later valid gain to reach the 6-tau snap, so a single malformed
      // STEM_GAIN/MASTER_GAIN buys seconds of silence. `Number(m.gainDb)` in
      // offscreen.js turns an absent field into exactly this.
      const v = +m.value;
      if (!Number.isFinite(v)) return;
      this.gt[i] = v;
      const tau = Math.max(m.tau || 0.003, 1e-5);
      this.ga[i] = 1 - Math.exp(-1 / (tau * this.sr));
      // AUDIO.md §3.3: setTargetAtTime is asymptotic. Snap at 6 tau so a mute is
      // exactly zero (no -80 dB residue, no denormals) and so the ramp is
      // provably complete by a known deadline.
      this.gd[i] = Math.ceil(6 * tau * this.sr);
    } else if (m.t === 'stop') {
      this.running = false;
    } else if (m.t === 'reset') {
      this.fade = 1; this.starved = false;
      /**
       * A HARD DISCONTINUITY. `reset` is sent by LivePipeline.start() and by
       * CachedDeck.load()/seek(), i.e. exactly when the ring is about to carry a
       * different piece of music (docs/ARCHITECTURE.md §3.9). The transpose
       * lanes hold 3072 samples of the OLD position; without this, a seek bleeds
       * 70 ms of wherever the user came from over wherever they went.
       */
      this.pitch.reset();
    } else if (m.t === 'report') {
      // Diagnostic only. The gain vector lives ONLY here — offscreen/live.js
      // posts targets and never reads back — so a slot stuck at 0 (or poisoned
      // to NaN before the P3-M2 guard landed) is invisible from every other
      // surface, including the AnalyserNode probe, which sits downstream of the
      // sum and cannot say WHICH multiplier zeroed it. One message, on demand.
      this.port.postMessage({
        t: 'report', id: m.id,
        gain: Array.from(this.g), target: Array.from(this.gt), rampLeft: Array.from(this.gd),
        // The post-meter crossfader factors. Reported for the same reason the
        // gain vector is: they live ONLY here, so without this nothing outside
        // the audio thread can verify what the audio thread is actually
        // multiplying by — every other check compares one derived value against
        // another derived value and agrees with itself.
        xf: Array.from(this.xt),
        // Same argument, one feature later: the interval the AUDIO THREAD has is
        // not the interval the UI last sent unless something checks. `applied`
        // trails `target` for one group delay plus one crossfade on every
        // change, and `refused` is the only place a malformed message shows up.
        pitch: { ...this.pitch.stats(), refused: this.pitchRefused },
        fade: this.fade, starved: this.starved, running: this.running,
        lastOut: [this.lastL, this.lastR],
        play: Atomics.load(this.hdr, H_PLAY) === 1,
        write: Atomics.load(this.hdr, H_WRITE), read: Atomics.load(this.hdr, H_READ),
        underruns: Atomics.load(this.hdr, H_UNDERRUNS),
      });
    }
  }

  process(_inputs, outputs) {
    if (!this.running) return false;
    const out = outputs[0];
    const oL = out[0], oR = out.length > 1 ? out[1] : out[0];
    const n = oL.length;

    const w = Atomics.load(this.hdr, H_WRITE);
    let r = Atomics.load(this.hdr, H_READ);
    const play = Atomics.load(this.hdr, H_PLAY) === 1;
    const avail = w - r;

    // ---- gains: advance the one-pole once per block boundary bookkeeping,
    //      but the actual smoothing is per sample below.
    const g = this.g, gt = this.gt, ga = this.ga, gd = this.gd;
    const x = this.x, xt = this.xt, xa = this.xa, xd = this.xd;

    if (!play || avail < n) {
      // Starving (or not started). Fade out over `fadeLen`, hold, and do NOT
      // advance the read pointer — the frames are still owed to the listener.
      //
      // The transpose lanes are NOT run here, and that is correct rather than an
      // omission: they are a function of the ring READ STREAM, which is exactly
      // what has stopped. Their 3072 samples of held audio are still owed too
      // and come out unchanged when the read pointer moves again.
      if (play && avail < n && !this.starved) {
        this.starved = true;
        Atomics.add(this.hdr, H_UNDERRUNS, 1);
      }
      if (play) Atomics.add(this.hdr, H_UNDERFRAMES, n);
      for (let i = 0; i < n; i++) {
        if (this.fade > 0) this.fade = Math.max(0, this.fade - 1 / this.fadeLen);
        // fade the last emitted sample out; with no data the only honest output
        // is silence, reached over a raised cosine so there is never a click.
        const e = 0.5 - 0.5 * Math.cos(Math.PI * this.fade);
        oL[i] = this.lastL * e; oR[i] = this.lastR * e;
      }
      this.meterAcc += n; this.healthAcc += n;
      this.maybePost(w, r, true);
      return true;
    }

    if (this.starved && avail >= this.lowWater) this.starved = false;
    if (avail < this.minCushion) this.minCushion = avail;

    const pl = this.pl, mask = this.mask, sb = this.sb;
    // The Web Audio render quantum is fixed at 128 frames, so this never fires.
    // It is here because the alternative to one allocation is reading past the
    // end of the scratch and summing whatever was there.
    //
    // REBUILDING PitchLanes THROWS AWAY STATE, AND BOTH HALVES ARE HANDLED HERE
    // BECAUSE ONLY ONE OF THEM IS RECOVERABLE.
    //
    //  1. THE INTERVAL, which is recoverable, so it is recovered. The constructor
    //     starts at target = applied = 0, so a bare `new PitchLanes(...)` would
    //     silently drop a user's transpose back to the home position with nothing
    //     in the report channel to say why. `reset()` re-applies it to BOTH banks
    //     from the first sample rather than `setSemitones()`, which would open a
    //     3072-sample prime and a 50 ms crossfade against a bank sitting at 0 —
    //     i.e. it would audibly slide back to concert pitch and then return.
    //     `pending ?? target` is the interval the user last ASKED for, which is
    //     the right one to keep when a switch was in flight.
    //  2. 3072 SAMPLES OF HELD AUDIO on all fourteen planes, NOT recoverable:
    //     the group delay lives inside the shifters' and the MatchedDelay's rings
    //     and the new object's rings are new. One group delay (69.66 ms) of the
    //     stream is dropped, on every lane equally — so Δ between stems stays 0
    //     and the failure is a short mute, not a comb. This is the same trade
    //     `reset()` makes at a seek and is why it is acceptable here.
    if (n > sb[0].length) {
      for (let q = 0; q < NPLANES; q++) sb[q] = new Float32Array(n);
      const keep = this.pitch.pending ?? this.pitch.target;
      this.pitch = new PitchLanes({ sampleRate: this.sr, maxBlock: n });
      this.pitch.target = keep;
      this.pitch.reset();
    }

    // ---- PASS 1: ONE read pointer, fourteen planes. This is where Δ = 0
    // between the stems comes from and nothing below is allowed to break it:
    // every plane is read at the SAME `(r + i) & mask`, so widening the plane
    // count cannot introduce a skew.
    for (let q2 = 0; q2 < NPLANES; q2++) {
      const d = sb[q2], s = pl[q2];
      for (let i = 0; i < n; i++) d[i] = s[(r + i) & mask];
    }

    // ---- PASS 2: TRANSPOSE, in place. Lane 0 (drums) takes the matched delay;
    // bass, other, vocals, guitar, piano and the passthrough mix take the
    // shifter. Every lane comes out delayed by exactly
    // PITCH_GROUP_DELAY_SAMPLES at every setting, including 0, which is what
    // keeps Δ = 0 through the transpose.
    this.pitch.process(sb, sb, n);

    const pk = this.pkB, sq = this.sqB;
    pk.fill(0); sq.fill(0);
    let pkM = 0, sM = 0;

    /**
     * ---- PASS 3: gains, meters, crossfader, sum.
     *
     * ROLLED OVER NSTEMS. This was hand-unrolled for exactly four stems plus
     * the passthrough — ten named plane reads, `pk0..pk3`, and a literal
     * five-term sum. The roll is not free-hand: the accumulation order is the
     * SAME left-to-right order the literal sum had (stems 0..NSTEMS-1, then the
     * passthrough, then master and env), because `0 + y === y` exactly for
     * every finite y, so the block is bit-identical to the unrolled one and the
     * exact-silence/null assertions that depend on an all-muted sum being
     * exactly zero still hold. Nothing here allocates: `pk`/`sq` are
     * constructor-owned.
     *
     * Every ramp still advances exactly once per sample, in this one loop, so
     * mute-to-silence and the 6-tau snap are unchanged.
     */
    for (let i = 0; i < n; i++) {
      // per-sample gain smoothing, one-pole + exact snap at the deadline
      for (let k = 0; k < NSTEMS + 2; k++) {
        if (gd[k] > 0) {
          if (--gd[k] === 0) g[k] = gt[k];
          else g[k] += (gt[k] - g[k]) * ga[k];
        }
      }
      for (let k = 0; k < NSTEMS; k++) {
        if (xd[k] > 0) {
          if (--xd[k] === 0) x[k] = xt[k];
          else x[k] += (xt[k] - x[k]) * xa[k];
        }
      }
      if (this.starved) { if (this.fade > 0) this.fade = Math.max(0, this.fade - 1 / this.fadeLen); }
      else if (this.fade < 1) this.fade = Math.min(1, this.fade + 1 / this.fadeLen);
      const env = this.fade >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * this.fade);

      // METER TAP IS HERE: post transpose, post stem fader / mute / solo, PRE
      // crossfader. All NSTEMS + 1 taps (the stems and the master) are at the
      // same sample index, so a DJ cueing an incoming channel sees its
      // transient at the same instant the master shows it.
      //
      // ...and the crossfader is applied AFTER the tap, so a channel faded
      // fully out still meters. That is how a DJ cues an incoming track.
      let accL = 0, accR = 0;
      for (let k = 0; k < NSTEMS; k++) {
        const gk = g[k];
        const sL = sb[2 * k][i] * gk, sR = sb[2 * k + 1][i] * gk;
        const xk = x[k];
        accL += sL * xk; accR += sR * xk;
        let a = sL < 0 ? -sL : sL; const b = sR < 0 ? -sR : sR; if (b > a) a = b;
        if (a > pk[k]) pk[k] = a;
        sq[k] += sL * sL + sR * sR;
      }
      // The passthrough bypasses the crossfader and is not metered: it has no
      // channel strip, and it is only non-zero on a span the ladder skipped.
      accL += sb[P_L][i] * g[G_PASS];
      accR += sb[P_R][i] * g[G_PASS];

      const mL = accL * g[G_MASTER] * env;
      const mR = accR * g[G_MASTER] * env;
      oL[i] = mL; oR[i] = mR;

      let a = mL < 0 ? -mL : mL; const b = mR < 0 ? -mR : mR; if (b > a) a = b;
      if (a > pkM) pkM = a; sM += mL * mL + mR * mR;
    }
    this.lastL = oL[n - 1]; this.lastR = oR[n - 1];

    r += n;
    Atomics.store(this.hdr, H_READ, r);

    const p = this.peak, q = this.sq;
    for (let k = 0; k < NSTEMS; k++) { if (pk[k] > p[k]) p[k] = pk[k]; q[k] += sq[k]; }
    if (pkM > p[NSTEMS]) p[NSTEMS] = pkM;
    q[NSTEMS] += sM;
    this.sqN += n * 2;
    // CLIP is armed off the PRE-soft-clip peak so the user learns to pull down
    // rather than leaning on the safety net (docs/AUDIO.md §4.3).
    if (pkM > 0.99) this.clip = 1;

    this.meterAcc += n; this.healthAcc += n;
    this.maybePost(w, r, false);
    return true;
  }

  maybePost(w, r, silent) {
    if (this.meterAcc >= this.meterEvery) {
      this.meterAcc = 0;
      const p = this.peak, q = this.sq, N = this.sqN || 1;
      // NSTEMS channel taps then the master at index NSTEMS. Fresh arrays, not
      // hoisted scratch: `p.fill(0)` runs two lines below, so a reused buffer is
      // only safe in a host that copies the payload synchronously. The browser
      // does; the VM harness in pitchbank.js section 7 does not, and a meter
      // payload that reads as zeros under test is not worth two allocations at
      // 30 Hz.
      const mp = new Array(NSTEMS + 1), mr = new Array(NSTEMS + 1);
      for (let k = 0; k <= NSTEMS; k++) { mp[k] = p[k]; mr[k] = Math.sqrt(q[k] / N); }
      this.port.postMessage({ t: 'meters', peak: mp, rms: mr, clip: this.clip });
      p.fill(0); q.fill(0); this.sqN = 0; this.clip = 0;
    }
    if (this.healthAcc >= this.healthEvery) {
      this.healthAcc = 0;
      const minC = this.minCushion === Infinity ? w - r : this.minCushion;
      this.minCushion = Infinity;
      this.port.postMessage({
        t: 'health',
        cushionFrames: w - r,
        cushionMinFrames: minC,
        playedFrames: r,
        underruns: Atomics.load(this.hdr, H_UNDERRUNS),
        underrunFrames: Atomics.load(this.hdr, H_UNDERFRAMES),
        faded: silent || this.fade < 1,
        // The transpose the audio thread is ACTUALLY applying, on the heartbeat
        // rather than only on demand: `applied` is what the listener is hearing
        // and it trails the UI's request by one group delay plus one crossfade.
        pitchSemitones: this.pitch.applied,
        pitchTarget: this.pitch.target,
      });
    }
  }
}

registerProcessor('stem-playback', PlaybackProcessor);
