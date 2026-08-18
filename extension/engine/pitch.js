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
export const PITCH_FFT_SIZE = 2048;
/** Synthesis hop. 75 % overlap; Hann^2 sums to exactly 1.5 on this grid. */
export const PITCH_SYNTH_HOP = 512;

/**
 * Algorithmic latency, in samples, at EVERY setting including 0 semitones, and
 * the delay `MatchedDelay` applies to the unshifted plane. Downstream adds this
 * to the latency readout. Changing it changes the drums/bass alignment, so the
 * self-check pins it two ways: `bypass-is-identity` (offset D) and
 * `matched-delay-tracks-the-shifter` (sample for sample against ratio 1).
 */
export const PITCH_GROUP_DELAY_SAMPLES = 3072;

export const PITCH_MIN_SEMITONES = -6;
export const PITCH_MAX_SEMITONES = 6;

/** Largest block `process()` handles in one internal pass; bigger blocks loop. */
export const PITCH_MAX_BLOCK = 8192;

/**
 * Recommended crossfade when the caller changes the interval under a running
 * stream. `setSemitones()` re-anchors on a frame boundary and is length- and
 * latency-exact, but the synthesis phase is discontinuous at the switch, so the
 * caller crossfades two instances. Duplicated from shared/config.js
 * SEAM_XFADE_MS (this module has no imports) — if that moves, move this.
 */
export const PITCH_SWITCH_XFADE_MS = 50;

/**
 * The 13 (L, M) pairs. L/M approximates 2^(k/12); the analysis hop is
 * Hs*M/L. There is no continuous knob, so these are a table, not a search.
 * Chosen as the smallest continued-fraction convergent within 0.01 cent — the
 * budget is 0.1 cent and the next convergent down (89/84 at +1) sits at
 * 0.0992 cent, which meets the budget with 0.8 % of margin. Not enough margin
 * to be worth having. `cents` is the exact error of the pair, and
 * `ratio-table-is-within-0.01-cent` re-derives it from L and M.
 */
export const PITCH_RATIOS = [
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

export class PitchShifter {
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
export class MatchedDelay {
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

// ===================================================================== self-check
//
// `node extension/engine/pitch.js`. Everything below this line is the runnable
// check and is NOT part of the module's surface; the worklet copy drops it.

const _argv1 = (typeof process !== 'undefined' && process.argv && process.argv[1]) || '';
if (_argv1.endsWith('pitch.js') && import.meta.url.endsWith('/pitch.js')) selfCheck();

function selfCheck() {
  const FS = 44100;
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
  const dB = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

  // ---------------------------------------------------------------- generators
  function noise(n, seed = 1, amp = 1) {
    let s = seed >>> 0;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = ((s / 4294967296) * 2 - 1) * amp; }
    return x;
  }
  function sine(n, f, amp, fadeMs = 10) {
    const x = new Float32Array(n);
    const fd = Math.round(fadeMs * FS / 1000);
    for (let i = 0; i < n; i++) {
      let e = 1;
      if (i < fd) e = 0.5 * (1 - Math.cos(Math.PI * i / fd));
      else if (i > n - 1 - fd) e = 0.5 * (1 - Math.cos(Math.PI * (n - 1 - i) / fd));
      x[i] = amp * e * Math.sin(TWO_PI * f * i / FS);
    }
    return x;
  }
  /**
   * n-in/n-out through the shifter, block sizes cycled so chunking is exercised.
   *
   * `wrote` IS THE ONLY HONEST OUTPUT COUNT AND IT IS WHY THE SENTINEL IS HERE.
   * This helper used to return `gotOut`, incremented by the same `k` as `fedIn`
   * in the same loop iteration — so `fedIn === gotOut` was arithmetic about the
   * harness, not a measurement of the shifter, and seven assertions built on it
   * passed against a `process()` that wrote nothing at all. The output block is
   * now poisoned with NaN before every call and `wrote` counts the slots the
   * shifter actually overwrote, so a sample the shifter declines to emit is
   * counted as missing rather than inferred as present. (AGENTS.md, "an
   * assertion must FAIL when it cannot look".)
   *
   * Unwritten slots land in `y` as 0, not NaN, deliberately: `wrote` already
   * carries the coverage claim, and a NaN loose in `y` would turn every
   * downstream spectral detail line into `NaN dB` and hide which assertion
   * actually broke.
   */
  function run(x, semitones, blocks = [128, 1000, 4096, 333, 8191]) {
    const sh = new PitchShifter(semitones, 1);
    const y = new Float32Array(x.length);
    let fed = 0, wrote = 0, bi = 0;
    const inB = new Float32Array(PITCH_MAX_BLOCK + 8192);
    const outB = new Float32Array(PITCH_MAX_BLOCK + 8192);
    while (fed < x.length) {
      const k = Math.min(blocks[bi++ % blocks.length], x.length - fed);
      for (let i = 0; i < k; i++) inB[i] = x[fed + i];
      for (let i = 0; i < k; i++) outB[i] = NaN;
      sh.process([inB], [outB], k);
      for (let i = 0; i < k; i++) {
        const v = outB[i];
        if (Number.isFinite(v)) { wrote++; y[fed + i] = v; }
      }
      fed += k;
    }
    return { y, fed, wrote, sh };
  }
  /**
   * The length contract, as one reusable verdict + detail pair, because it is
   * claimed at four entry points (bypass, an interval, the click train, every
   * setting) and AGENTS.md requires each of those to name its own.
   *
   * Three independent witnesses, and none of them is the test loop's own
   * bookkeeping: `wrote` is counted at the output buffer, `inCount`/`outCount`
   * are the shifter's own absolute sample counters advanced inside `_run()`, and
   * `stats.frames` proves an analysis/synthesis frame was actually built. A
   * shifter that emits nothing fails all three.
   */
  function lengthExact(r, want) {
    return r.wrote === want && r.sh.inCount === want && r.sh.outCount === want && r.sh.stats.frames > 0;
  }
  function lengthDetail(r, want) {
    return `${want} fed, ${r.wrote} written to the output buffer, ` +
      `shifter counted ${r.sh.inCount} in / ${r.sh.outCount} out over ${r.sh.stats.frames} frames`;
  }
  function residualDb(a, b, aOff, bOff, n) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { const d = a[aOff + i] - b[bOff + i]; num += d * d; den += b[bOff + i] * b[bOff + i]; }
    if (den === 0) return num === 0 ? -Infinity : Infinity;
    return 10 * Math.log10(num / den);
  }
  function rms(x, from, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[from + i] * x[from + i];
    return Math.sqrt(s / n);
  }
  /** Hann-windowed magnitude spectrum of x[off .. off+n). */
  function spectrum(x, off, n) {
    const f = new RFFT(n);
    const buf = new Float64Array(n), re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
    for (let i = 0; i < n; i++) buf[i] = x[off + i] * 0.5 * (1 - Math.cos(TWO_PI * i / n));
    f.forward(buf, re, im);
    const m = new Float64Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) m[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    return m;
  }
  /**
   * Peak frequency by parabolic interpolation on the LOG magnitude of the three
   * bins around the maximum. A raw peak bin at n=16384 is 2.6917 Hz wide, which
   * can carry "it moved a fifth" (14 bins) but cannot separate equal-tempered
   * 659.2551 Hz from just-intonation 660 Hz (0.277 bins). Returns NaN when
   * there is no peak to interpolate — the caller must treat that as a failure,
   * never as an excuse (AGENTS.md, "an assertion must FAIL when it cannot look").
   */
  function peakHz(mag, n) {
    let k = -1, mx = 0;
    for (let i = 1; i < mag.length - 1; i++) if (mag[i] > mx) { mx = mag[i]; k = i; }
    if (k < 1 || k >= mag.length - 1) return NaN;
    let med = 0;
    for (let i = 1; i < mag.length; i++) med += mag[i];
    med /= mag.length - 1;
    if (mx < 20 * med) return NaN;                      // nothing peak-like here
    const a = Math.log(mag[k - 1]), b = Math.log(mag[k]), c = Math.log(mag[k + 1]);
    const den = a - 2 * b + c;
    if (!(den < 0)) return NaN;
    return (k + 0.5 * (a - c) / den) * FS / n;
  }
  /** 10-90 % rise time of the attack, in samples, from a 16-sample peak envelope. */
  function riseSamples(x, from, to) {
    const W = 16;
    let pk = 0, pkAt = from;
    const env = new Float64Array(to - from);
    for (let i = from; i < to; i++) {
      let m = 0;
      for (let j = 0; j < W && i + j < to; j++) { const v = Math.abs(x[i + j]); if (v > m) m = v; }
      env[i - from] = m;
      if (m > pk) { pk = m; pkAt = i; }
    }
    if (pk <= 0) return NaN;
    let lo = -1, hi = -1;
    for (let i = pkAt - from; i >= 0; i--) if (env[i] < 0.9 * pk) { hi = i; break; }
    if (hi < 0) return NaN;
    for (let i = hi; i >= 0; i--) if (env[i] < 0.1 * pk) { lo = i; break; }
    if (lo < 0) return NaN;
    return hi - lo;
  }

  console.log('\x1b[1mpitch.js self-check\x1b[0m');

  // ================================================================ table + COLA
  head('table & window');
  {
    let worst = 0, worstK = 0;
    for (const e of PITCH_RATIOS) {
      const cents = 1200 * Math.log2((e.L / e.M) / Math.pow(2, e.semitones / 12));
      if (Math.abs(cents - e.cents) > 1e-5) { worst = Infinity; break; }
      if (Math.abs(cents) > worst) { worst = Math.abs(cents); worstK = e.semitones; }
    }
    ok('ratio-table-is-within-0.01-cent, re-derived from L and M',
      PITCH_RATIOS.length === 13 && worst < 0.01,
      `worst ${worst.toFixed(6)} cent at ${worstK >= 0 ? '+' : ''}${worstK}`);

    const sh = new PitchShifter(0, 1);
    ok('hann^2 is COLA at hop 512 over N=2048 (sum 1.5, spread < 1e-12)',
      Math.abs(sh.olaNorm - 1.5) < 1e-12 && sh.colaSpread < 1e-12,
      `sum ${sh.olaNorm.toFixed(12)} spread ${sh.colaSpread.toExponential(2)}`);
  }

  // =============================================================== 1. bypass
  head('1. bypass');
  {
    const x = noise(4 * FS, 7, 0.5);
    const r = run(x, 0);
    const n = x.length - D;
    const res = residualDb(r.y, x, D, 0, n);
    ok('bypass-is-identity: shiftSemitones(0) from the deck bus reconstructs the input below -120 dB',
      res < -120, `${res.toFixed(1)} dB over ${(n / FS).toFixed(1)} s`);
    ok('bypass-emitted-exactly-as-many-samples-as-it-consumed',
      lengthExact(r, x.length), lengthDetail(r, x.length));
    ok('bypass-never-emitted-a-sample-before-its-input-arrived (stats.starved)',
      r.sh.stats.frames > 0 && r.sh.stats.starved === 0,
      `starved ${r.sh.stats.starved} over ${r.sh.stats.frames} frames`);

    // the drums plane must land on the same sample as the shifted planes
    const md = new MatchedDelay(1);
    const yd = new Float32Array(x.length);
    const ib = new Float32Array(1024), obf = new Float32Array(1024);
    for (let p = 0; p < x.length; p += 1024) {
      const k = Math.min(1024, x.length - p);
      for (let i = 0; i < k; i++) ib[i] = x[p + i];
      md.process([ib], [obf], k);
      for (let i = 0; i < k; i++) yd[p + i] = obf[i];
    }
    const dres = residualDb(yd, r.y, D, D, x.length - D);
    ok('matched-delay-tracks-the-shifter: MatchedDelay(drums) vs PitchShifter(0) sample for sample',
      md.delaySamples === D && dres < -120, `${dres.toFixed(1)} dB, delay ${md.delaySamples}`);
  }

  // ============================================================ 2. the interval
  //
  // THE BRIEF SAID +7 AND +7 IS NOT IN RANGE. The ratified interval range is
  // [-6, +6], so a perfect fifth cannot be produced by one instance. The claim
  // the brief wanted from it — "equal-tempered, not a rational approximation" —
  // is tested here at +5, the perfect FOURTH, where the same trap exists in the
  // same form and inside the range:
  //
  //    equal-tempered  440 * 2^(5/12) = 587.3295 Hz
  //    just            440 * 4/3      = 586.6667 Hz     0.663 Hz apart
  //
  // At n = 16384 a bin is 2.6917 Hz, so those two are 0.246 of a bin apart and
  // a raw peak bin cannot separate them, exactly as at the fifth (0.277 bin).
  // Hence parabolic interpolation on the log magnitude. A chained +6 then +1
  // was the other option and was rejected: it doubles the group delay and puts
  // two lots of shifter artefacts in the estimate, so a red would not have said
  // which stage was wrong.
  head('2. interval');
  let sineOut = null;
  {
    const x = sine(2 * FS, 440, 0.5);
    const r = run(x, 5);
    sineOut = r.y;
    const NFFT = 16384;
    const mag = spectrum(r.y, D + 20000, NFFT);
    const f = peakHz(mag, NFFT);
    const want = 440 * Math.pow(2, 5 / 12);
    const just = 440 * 4 / 3;
    // Calibrate the estimator on a synthetic tone AT the target frequency, so
    // the tolerance is about the shifter and not about Hann log-parabolic bias.
    const cal = peakHz(spectrum(sine(NFFT + 2000, want, 0.5, 1), 1000, NFFT), NFFT);
    ok('interval-is-a-fourth: setSemitones(+5) on a 440 Hz sine reads 587.3295 Hz within 0.20 Hz, which rules out just 586.6667',
      Number.isFinite(f) && Math.abs(f - want) < 0.20,
      `measured ${Number.isFinite(f) ? f.toFixed(4) : 'NO PEAK'} Hz, want ${want.toFixed(4)}, ` +
      `just is ${(want - just).toFixed(4)} Hz away, estimator on a reference tone ${Number.isFinite(cal) ? cal.toFixed(4) : 'NO PEAK'}`);
    ok('interval-frames-in-equals-frames-out',
      lengthExact(r, x.length), lengthDetail(r, x.length));
  }

  // ================================================================= 3. onsets
  //
  // +6 rather than the brief's +7: it is the largest up-shift in range and it
  // is the WORST case for this test, because the transient displacement a naive
  // phase reset produces is (u - N/2)*(M/L - 1) and |M/L - 1| is largest at the
  // ends of the range. A length check alone is nearly vacuous here — a
  // resample-then-trim shifter passes out.length === in.length while running
  // 41 % fast — so the position of every click is checked, and frames-in ===
  // frames-out is a separate named invariant.
  head('3. onsets');
  {
    const len = 4 * FS;
    const x = new Float32Array(len);
    const clicks = [];
    for (let t = Math.round(0.25 * FS); t < len - FS * 0.1; t += Math.round(0.25 * FS)) { x[t] = 1; clicks.push(t); }
    const r = run(x, 6);
    const y = r.y;
    let worst = 0, found = 0, worstAt = 0;
    for (const t of clicks) {
      const want = t + D;
      let mx = 0, at = -1;
      for (let i = Math.max(0, want - 2000); i < Math.min(len, want + 2000); i++) {
        const v = Math.abs(y[i]);
        if (v > mx) { mx = v; at = i; }
      }
      if (at < 0 || mx < 1e-3) continue;      // no click found here at all
      found++;
      const err = Math.abs(at - want);
      if (err > worst) { worst = err; worstAt = t; }
    }
    ok('onsets-do-not-move: at +6, every click lands within +/-1 ms (44 samples) of its input position + PITCH_GROUP_DELAY_SAMPLES',
      found === clicks.length && worst <= 44,
      `${found}/${clicks.length} located, worst ${worst} samples (${(worst / FS * 1000).toFixed(2)} ms) at t=${worstAt}`);
    ok('onset-detector-fired-on-every-click (a silent detector makes the assertion above vacuous)',
      r.sh.stats.onsets >= clicks.length && r.sh.stats.resets >= clicks.length,
      `${r.sh.stats.onsets} onsets, ${r.sh.stats.resets} reset frames of ${r.sh.stats.frames}, ${clicks.length} clicks`);
    ok('click-train-frames-in-equals-frames-out',
      lengthExact(r, len), lengthDetail(r, len));
    ok('click-train-never-starved',
      r.sh.stats.frames > 0 && r.sh.stats.starved === 0,
      `starved ${r.sh.stats.starved} over ${r.sh.stats.frames} frames`);
  }

  // ============================================================== 4. unity gain
  head('4. gain');
  {
    const x = sine(2 * FS, 440, 0.5);
    const from = 5000, n = 2 * FS - D - 10000;
    const ri = rms(x, from, n);
    const ro = rms(sineOut, from + D, n);
    const g = dB(ro / ri);
    ok('unity-gain: a 440 Hz sine at +5 keeps its RMS within +/-1 dB (broken synthesis-window normalisation breathes here)',
      Number.isFinite(g) && Math.abs(g) < 1, `${g.toFixed(3)} dB (in ${ri.toFixed(4)}, out ${ro.toFixed(4)})`);
  }


  // ================================================== 5. resampler, AUDIO.md 6.6
  head('5. resampler (docs/AUDIO.md 6.6 gates)');
  {
    // passband: white noise at ratio 1, +/-0.5 dB from 20 Hz to 19 kHz
    //
    // THE WINDOW PLAN IS DERIVED, NOT WRITTEN DOWN, AND THAT IS THE FIX.
    // It was `off = 40000 + w*20000` for 16 windows, whose last window starts at
    // 340000 in a 176400-sample buffer. From w = 7 on, `spectrum()` read past the
    // end, `x[off+i]` was `undefined`, `undefined * hann` was NaN, and every one
    // of the 30 band accumulators was NaN for the rest of the run. The verdict
    // then sailed through because `NaN <= 0` is FALSE, so the "empty" guard never
    // fired, and `Math.abs(NaN) > Math.abs(worst)` is also FALSE, so `worst`
    // stayed at its initial 0. It printed "worst 0.0000 dB at 0 Hz" on every run
    // -- `worstF` never assigned is the fingerprint of an assertion that has
    // never once executed a comparison -- and it passed against a `process()`
    // that wrote nothing at all.
    //
    // `lastOff` is the last offset at which BOTH reads are entirely in range:
    // the input needs [off, off+NFFT) and the output needs [off+D, off+D+NFFT).
    const x = noise(4 * FS, 11, 0.25);
    const r = run(x, 0);
    const NFFT = 8192, WINS = 16, START = 40000;
    const lastOff = x.length - D - NFFT;
    const step = Math.floor((lastOff - START) / (WINS - 1));
    const bandsLo = [], bandsHi = [];
    for (let f = 20; f < 19000; f *= Math.pow(2, 1 / 3)) { bandsLo.push(f); bandsHi.push(Math.min(19000, f * Math.pow(2, 1 / 3))); }
    const pin = new Float64Array(bandsLo.length), pout = new Float64Array(bandsLo.length);
    let wins = 0;
    for (let w = 0; w < WINS; w++) {
      const off = START + w * step;
      if (off < 0 || off > lastOff) continue;              // counted, never silently skipped
      wins++;
      const mi = spectrum(x, off, NFFT), mo = spectrum(r.y, off + D, NFFT);
      for (let k = 1; k <= NFFT / 2; k++) {
        const f = k * FS / NFFT;
        for (let b = 0; b < bandsLo.length; b++) {
          if (f >= bandsLo[b] && f < bandsHi[b]) { pin[b] += mi[k] * mi[k]; pout[b] += mo[k] * mo[k]; break; }
        }
      }
    }
    // Number.isFinite, not a comparison against 0: NaN fails EVERY comparison,
    // so `pin[b] <= 0` is exactly the guard that lets a poisoned band through.
    let worst = 0, worstF = 0, measured = 0, unmeasured = 0;
    for (let b = 0; b < bandsLo.length; b++) {
      if (!(Number.isFinite(pin[b]) && Number.isFinite(pout[b]) && pin[b] > 0 && pout[b] > 0)) { unmeasured++; continue; }
      const d = 10 * Math.log10(pout[b] / pin[b]);
      if (!Number.isFinite(d)) { unmeasured++; continue; }
      // first measured band always assigns, so worstF can never be reported as
      // 0 Hz while claiming coverage
      if (measured === 0 || Math.abs(d) > Math.abs(worst)) { worst = d; worstF = bandsLo[b]; }
      measured++;
    }
    ok('passband-flat-at-ratio-1: white noise, every 1/3-octave band 20 Hz - 19 kHz within +/-0.5 dB (docs/AUDIO.md 6.6). NOTE: at ratio 1 the resample kernel IS a delta, so this restates bypass and says NOTHING about the resampler - the next assertion is the one that loads it',
      wins === WINS && measured === bandsLo.length && unmeasured === 0 && Math.abs(worst) < 0.5,
      // EXPONENTIAL, NOT toFixed(4), AND THAT IS DELIBERATE. At ratio 1 bypass
      // is bit-exact, so the honest answer here is float dust (-2.4e-15 dB) and
      // toFixed(4) renders it `-0.0000` -- character for character the string the
      // BROKEN version printed when `worst` had never been assigned. The one
      // fingerprint that exposed this defect must not be reproducible by the fix.
      `worst ${worst.toExponential(4)} dB at ${worstF.toFixed(0)} Hz, ${measured}/${bandsLo.length} bands measured, ` +
      `${unmeasured} unmeasured, ${wins}/${WINS} windows (step ${step}, last starts ${START + (WINS - 1) * step}, ` +
      `buffer ${x.length}, last legal ${lastOff})`);
  }
  {
    // The resampler's passband, at a ratio where it is actually running with
    // fractional phases. Tones, not noise: a stationary sinusoid goes through
    // the phase vocoder at unity (assertion 4), so every deviation here belongs
    // to the resample stage. -6 is the direction whose cutoff is the full input
    // Nyquist, so the whole 20 Hz - 19 kHz band is in the passband and the
    // AUDIO.md 6.6 gate applies to all of it.
    //
    // 20 Hz IS EXCLUDED AND THIS IS THE EXCEPTION, ENCODED: at N = 2048 a bin is
    // 21.53 Hz, so a 20 Hz partial sits at bin 0.93, under DC and on top of its
    // own negative-frequency image. No phase vocoder at this FFT size resolves
    // it; measured -2.2 dB and reported below so the number is on the record.
    // ponytail: the ceiling is N = 2048; the upgrade is a 4096-point analysis on
    // the bass plane only, which doubles that plane's group delay and therefore
    // needs the whole latency contract reopened.
    const freqs = [20, 25, 30, 35, 40, 50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150, 5000, 8000, 11000, 14000, 16000, 17500, 19000];
    const lvl = [];
    for (const f of freqs) {
      const n = (1.2 * FS) | 0;
      const xx = sine(n, f, 0.5);
      const rr = run(xx, -6, [4096]);
      const from = 6000, ln = n - D - 12000;
      lvl.push(dB(rms(rr.y, from + D, ln) / rms(xx, from, ln)));
    }
    let worst = 0, worstF = 0, unmeasured = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (!Number.isFinite(lvl[i])) { unmeasured++; continue; }
      if (freqs[i] < 25) continue;
      if (Math.abs(lvl[i]) > Math.abs(worst)) { worst = lvl[i]; worstF = freqs[i]; }
    }
    ok('passband-flat-at-minus-6: tones 25 Hz - 19 kHz through the real polyphase kernel stay within +/-0.5 dB (docs/AUDIO.md 6.6; linear interpolation is -6.02 dB at 16 kHz and this is the assertion it would fail)',
      unmeasured === 0 && Math.abs(worst) < 0.5,
      `worst ${worst.toFixed(3)} dB at ${worstF} Hz; 20 Hz (below the STFT's own resolution) ${lvl[0].toFixed(2)} dB; ` +
      `[${freqs.map((f, i) => f + ':' + lvl[i].toFixed(2)).join(' ')}]`);
  }
  {
    // alias floor: 15 kHz tone at ratio 2^(6/12)
    const x = sine(2 * FS, 15000, 0.5);
    const r = run(x, 6);
    const NFFT = 16384, off = D + 20000;
    const mi = spectrum(x, off - D, NFFT), mo = spectrum(r.y, off, NFFT);
    const ref = Math.max(...mi);
    const wantHz = 15000 * Math.pow(2, 6 / 12);
    const kWant = Math.round(wantHz * NFFT / FS);
    let tone = 0;
    for (let k = kWant - 8; k <= kWant + 8; k++) tone = Math.max(tone, mo[k]);
    const k15 = Math.floor(15000 * NFFT / FS);
    let mx = 0, mxK = 0;
    for (let k = 0; k < k15; k++) if (mo[k] > mx) { mx = mo[k]; mxK = k; }
    const aliasDb = dB(mx / ref);
    const toneDb = dB(tone / ref);
    ok('shifted-tone-is-present: 15 kHz at +6 lands at 21213 Hz within 3 dB of the input tone',
      Number.isFinite(toneDb) && Math.abs(toneDb) < 3, `${toneDb.toFixed(2)} dB`);
    ok('alias-floor: nothing folds back below 15 kHz above -60 dB of the input tone',
      tone > 1e-3 * ref && aliasDb < -60,
      `worst ${aliasDb.toFixed(1)} dB at ${(mxK * FS / NFFT).toFixed(0)} Hz, shifted tone at ${toneDb.toFixed(2)} dB`);
  }

  // ============================================================== 6. transients
  head('6. transients');
  {
    // 1.5 ms raised-cosine attack, 40 ms decay, 1 kHz carrier, one per 0.5 s
    const len = 3 * FS;
    const x = new Float32Array(len);
    const atk = Math.round(0.0015 * FS), dec = Math.round(0.04 * FS);
    const hits = [];
    for (let t = Math.round(0.4 * FS); t < len - FS * 0.2; t += Math.round(0.5 * FS)) {
      hits.push(t);
      for (let i = 0; i < atk + dec; i++) {
        const e = i < atk ? 0.5 * (1 - Math.cos(Math.PI * i / atk)) : Math.exp(-(i - atk) / (dec / 4));
        x[t + i] += 0.8 * e * Math.sin(TWO_PI * 1000 * i / FS);
      }
    }
    const r = run(x, 6);
    const inR = riseSamples(x, hits[1] - 500, hits[1] + 2000);
    let worstR = 0, measured = 0;
    for (const t of hits) {
      const o = t + D;
      const rr = riseSamples(r.y, o - 500, o + 2000);
      if (!Number.isFinite(rr)) continue;
      measured++;
      if (rr > worstR) worstR = rr;
    }
    ok('transient-stays-sharp: at +6 a 1.5 ms attack keeps its 10-90 % rise within 3x the input (the ONLY assertion here that fails on a shifter that smears every drum hit into a whoosh)',
      Number.isFinite(inR) && measured === hits.length && worstR <= 3 * inR,
      `in ${Number.isFinite(inR) ? inR : 'NO ATTACK'} samples (${(inR / FS * 1000).toFixed(2)} ms), ` +
      `out worst ${worstR} (${(worstR / FS * 1000).toFixed(2)} ms), ${measured}/${hits.length} measured, ` +
      `${r.sh.stats.resets} reset frames`);
  }

  // ================================================= every setting, end to end
  head('all 13 settings');
  {
    let worstStarve = 0, lenOk = true, worstCents = 0, worstK = 0;
    let fewestFrames = Infinity, fewestWrote = Infinity, lenBadAt = null;
    for (const e of PITCH_RATIOS) {
      const x = sine(FS, 440, 0.5);
      const r = run(x, e.semitones, [128, 512, 4096]);
      if (!lengthExact(r, x.length)) { lenOk = false; if (lenBadAt === null) lenBadAt = e.semitones; }
      fewestFrames = Math.min(fewestFrames, r.sh.stats.frames);
      fewestWrote = Math.min(fewestWrote, r.wrote);
      worstStarve = Math.max(worstStarve, r.sh.stats.starved);
      const NFFT = 16384;
      const f = peakHz(spectrum(r.y, D + 8000, NFFT), NFFT);
      const want = 440 * Math.pow(2, e.semitones / 12);
      const cents = Number.isFinite(f) ? Math.abs(1200 * Math.log2(f / want)) : Infinity;
      if (cents > worstCents) { worstCents = cents; worstK = e.semitones; }
    }
    ok('every-setting-is-length-exact-and-never-starves',
      lenOk && worstStarve === 0 && fewestFrames > 0,
      `starved ${worstStarve}; fewest samples written at any setting ${fewestWrote} of ${FS}; ` +
      `fewest frames run ${fewestFrames}${lenBadAt === null ? '' : `; FIRST LENGTH FAILURE AT ${lenBadAt}`}`);
    ok('every-setting-lands-on-its-equal-tempered-pitch within 2 cent',
      worstCents < 2, `worst ${worstCents.toFixed(3)} cent at ${worstK >= 0 ? '+' : ''}${worstK}`);
  }

  // ============================================ the stereo entry point + in place
  //
  // Everything above is mono. The deck bus calls this with channels = 2 and
  // with inCh === outCh, and neither of those is exercised by a mono run: the
  // channel loop, the shared peak map and the shared onset decision all only
  // execute at ch = 2. Two separate assertions because they are two claims at
  // one entry point, not one loose one.
  head('stereo entry point');
  {
    const n = 100000;
    const xl = noise(n, 3, 0.5), xr = noise(n, 99, 0.5);      // independent, so a
    const sh = new PitchShifter(0, 2);                        // channel swap is red
    const yl = new Float32Array(n), yr = new Float32Array(n);
    const ib = [new Float32Array(128), new Float32Array(128)];
    const ob = [new Float32Array(128), new Float32Array(128)];
    for (let p = 0; p + 128 <= n; p += 128) {
      for (let i = 0; i < 128; i++) { ib[0][i] = xl[p + i]; ib[1][i] = xr[p + i]; }
      sh.process(ib, ob, 128);
      for (let i = 0; i < 128; i++) { yl[p + i] = ob[0][i]; yr[p + i] = ob[1][i]; }
    }
    const rl = residualDb(yl, xl, D, 0, n - D - 128);
    const rr = residualDb(yr, xr, D, 0, n - D - 128);
    ok('stereo-bypass-is-identity-on-both-channels: PitchShifter(0, 2) from the deck bus, independent noise per channel',
      rl < -120 && rr < -120 && sh.stats.starved === 0,
      `L ${rl.toFixed(1)} dB, R ${rr.toFixed(1)} dB, starved ${sh.stats.starved}`);
  }
  {
    const n = 60000, k = 4, blk = 256;
    const x = noise(n, 5, 0.5);
    const shA = new PitchShifter(k, 1), shB = new PitchShifter(k, 1);
    const ya = new Float32Array(n), yb = new Float32Array(n);
    const b = new Float32Array(blk), ib = new Float32Array(blk), obf = new Float32Array(blk);
    for (let p = 0; p + blk <= n; p += blk) {
      for (let i = 0; i < blk; i++) b[i] = ib[i] = x[p + i];
      shA.process([b], [b], blk);                             // in place
      shB.process([ib], [obf], blk);                          // separate buffers
      for (let i = 0; i < blk; i++) { ya[p + i] = b[i]; yb[p + i] = obf[i]; }
    }
    const r = residualDb(ya, yb, 0, 0, n - blk);
    ok('in-place-process-matches-separate-buffers at +4 (the worklet will pass the same array twice)',
      r < -200, `${r === -Infinity ? 'bit identical' : r.toFixed(1) + ' dB'}`);
  }

  // =========================================== runtime interval change (no glitch in LENGTH)
  head('setSemitones under a running stream');
  {
    const x = sine(2 * FS, 440, 0.5);
    const sh = new PitchShifter(0, 2);
    const nB = 512;
    const inB = [new Float32Array(nB), new Float32Array(nB)];
    const outB = [new Float32Array(nB), new Float32Array(nB)];
    // Same NaN sentinel as run(): the count of samples that came OUT has to be
    // measured at the buffer, or it is just the count that went in, restated.
    let fed = 0, wrote = 0;
    while (fed < x.length) {
      const k = Math.min(nB, x.length - fed);
      for (let i = 0; i < k; i++) { inB[0][i] = x[fed + i]; inB[1][i] = x[fed + i]; }
      for (let i = 0; i < k; i++) { outB[0][i] = NaN; outB[1][i] = NaN; }
      if (fed > FS && sh.semitones !== 3) sh.setSemitones(3);
      sh.process(inB, outB, k);
      for (let i = 0; i < k; i++) if (Number.isFinite(outB[0][i]) && Number.isFinite(outB[1][i])) wrote++;
      fed += k;
    }
    ok('setSemitones-mid-stream-stays-length-exact-and-does-not-starve',
      wrote === x.length && sh.inCount === x.length && sh.outCount === x.length &&
      sh.stats.frames > 0 && sh.stats.starved === 0,
      `${x.length} fed, ${wrote} written on BOTH channels, shifter counted ${sh.inCount} in / ${sh.outCount} out ` +
      `over ${sh.stats.frames} frames, starved ${sh.stats.starved}, now ${sh.semitones >= 0 ? '+' : ''}${sh.semitones}`);
  }

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
  if (typeof process !== 'undefined' && process.exit) process.exit(fail === 0 ? 0 : 1);
}
