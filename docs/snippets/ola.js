// ola.js — segmentation, windows and overlap-add for chunked HT-Demucs inference.
// Normative implementation for Stem Splitter Live. See docs/AUDIO.md §2.
//
// Two modes:
//   1. TrapezoidOLA  — live/streaming. Exact COLA (sum of windows == 1.0 to 1 ulp),
//                      O(crossfade) memory, emits one hop per inference, no division.
//   2. DemucsOLA     — offline export. Bit-for-bit mirror of upstream demucs
//                      `apply.py::apply_model` (triangular weight + divide by sum_weight),
//                      so our export can be null-tested against `python -m demucs`.

export const MODEL_SR = 44100;
/** HT-Demucs pretrained `model.segment` is Fraction(39, 5) = 7.8 s. */
export const SEGMENT_SECONDS = 39 / 5;
/** 7.8 s * 44100 = 343980 samples. int(44100 * 7.8) in Python is also 343980. */
export const SEGMENT_SAMPLES = Math.trunc(MODEL_SR * SEGMENT_SECONDS); // 343980

/**
 * Live plan. P + H + X + R === L, always. The tensor fed to the model is always
 * the full L samples (HT-Demucs zero-pads anything shorter to its training length,
 * so a short segment costs the SAME compute and only loses context) — the only
 * real knob is how you split L between left context P (free) and the
 * latency-bearing part H + X + R.
 *
 *   emit region of chunk k (absolute samples): [k*H, k*H + H + X)
 *   input  region of chunk k                 : [k*H - P, k*H - P + L)
 *   algorithmic lookahead                    = H + X + R
 *   real-time constraint                     : T_inference <= H / fs
 */
export function makeLivePlan({
  fs = MODEL_SR,
  segment = SEGMENT_SAMPLES,
  hopSeconds = 3.0,
  crossfadeSeconds = 0.5,
  rightContextSeconds = 0.5,
} = {}) {
  const L = segment;
  const H = Math.round(hopSeconds * fs);
  const X = Math.round(crossfadeSeconds * fs);
  const R = Math.round(rightContextSeconds * fs);
  const P = L - H - X - R;
  if (P < 0) throw new RangeError(`hop+crossfade+rightContext (${H + X + R}) exceeds segment ${L}`);
  if (X > H) throw new RangeError('crossfade must be <= hop');
  if (X < 1) throw new RangeError('crossfade must be >= 1 sample');
  return {
    fs, L, H, X, R, P,
    lookaheadSamples: H + X + R,
    lookaheadSeconds: (H + X + R) / fs,
    maxInferenceSeconds: H / fs,
    window: trapezoidWindow(L, P, X, R),
  };
}

/**
 * Exact-COLA trapezoid. Zero over the discarded left context and right context,
 * linear rise/fall of length X, flat 1 in between.
 *   w[n] = 0                     n <  P
 *          (n - P + 0.5) / X     P <= n < P+X
 *          1                     P+X <= n < L-R-X
 *          (L - R - n - 0.5) / X L-R-X <= n < L-R
 *          0                     n >= L-R
 * With hop H = L - P - X - R,  w[n] + w[n+H] == 1 exactly over the crossfade.
 */
export function trapezoidWindow(L, P, X, R) {
  const w = new Float32Array(L);
  const fallStart = L - R - X;
  for (let n = P; n < P + X; n++) w[n] = (n - P + 0.5) / X;
  for (let n = P + X; n < fallStart; n++) w[n] = 1;
  for (let n = fallStart; n < L - R; n++) w[n] = (L - R - n - 0.5) / X;
  return w;
}

/**
 * Upstream demucs weight, verbatim port of apply.py lines 271-276:
 *   weight = cat([arange(1, L//2 + 1), arange(L - L//2, 0, -1)]); (weight/weight.max())**p
 * Note this is NOT COLA at overlap 0.25 — upstream divides by the running sum of
 * weights instead. Do the same (DemucsOLA below) if you want parity.
 */
export function demucsTriangularWeight(L, transitionPower = 1) {
  const w = new Float32Array(L);
  const half = Math.floor(L / 2);
  for (let i = 0; i < half; i++) w[i] = i + 1;
  for (let i = half, v = L - half; i < L; i++, v--) w[i] = v;
  let max = 0;
  for (let i = 0; i < L; i++) if (w[i] > max) max = w[i];
  for (let i = 0; i < L; i++) w[i] = Math.pow(w[i] / max, transitionPower);
  return w;
}

/**
 * COLA check. Returns max |sum_k w[n - k*H] - 1| over the steady-state interior.
 * A correct trapezoid plan gives < 1e-7 in Float32 and < 1e-15 in Float64.
 * Unit test: assert(colaError(plan.window, plan.H) < 1e-6).
 */
export function colaError(w, H, reps = 8) {
  const L = w.length;
  const total = L + H * reps;
  const s = new Float64Array(total);
  for (let k = 0; k <= reps; k++) for (let n = 0; n < L; n++) s[k * H + n] += w[n];
  // steady state = positions covered by every window that could cover them
  const lo = L, hi = H * reps;
  let e = 0;
  for (let n = lo; n < hi; n++) e = Math.max(e, Math.abs(s[n] - 1));
  return e;
}

/**
 * Streaming overlap-add for the live path.
 * Feed chunks in order; each call returns exactly H new output samples per channel
 * (the final call returns H + X + R).
 */
export class TrapezoidOLA {
  /** @param {ReturnType<typeof makeLivePlan>} plan @param {number} channels */
  constructor(plan, channels = 2) {
    this.plan = plan;
    this.channels = channels;
    this.tail = Array.from({ length: channels }, () => new Float32Array(plan.X));
    this.k = 0;
  }

  /**
   * @param {Float32Array[]} seg  channels x L, one stem's model output for chunk k
   * @param {boolean} isFinal     true for the last chunk of the track
   * @returns {Float32Array[]}    channels x (H) — or (H+X+R) when isFinal
   */
  push(seg, isFinal = false) {
    const { L, H, X, P, R, window: w } = this.plan;
    const emitLen = isFinal ? H + X + R : H;
    const out = [];
    for (let c = 0; c < this.channels; c++) {
      const s = seg[c];
      if (s.length !== L) throw new RangeError(`segment must be ${L} samples, got ${s.length}`);
      const y = new Float32Array(emitLen);
      // crossfade region [0, X): previous chunk's faded tail + this chunk's rise.
      // Chunk 0 has no predecessor, so it contributes unwindowed.
      if (this.k === 0) for (let i = 0; i < X; i++) y[i] = s[P + i];
      else for (let i = 0; i < X; i++) y[i] = this.tail[c][i] + w[P + i] * s[P + i];
      // flat region
      const flatEnd = isFinal ? emitLen : H;
      for (let i = X; i < flatEnd; i++) y[i] = s[P + i];   // w == 1 here
      if (!isFinal) {
        const t = this.tail[c];
        for (let i = 0; i < X; i++) t[i] = w[P + H + i] * s[P + H + i];
      }
      out.push(y);
    }
    this.k++;
    return out;
  }

  /** Absolute input sample range the model must be fed for chunk k. Negative => zero-pad. */
  inputRange(k = this.k) {
    const { L, H, P } = this.plan;
    return { start: k * H - P, end: k * H - P + L, length: L };
  }
}

/**
 * Offline / export overlap-add, upstream-compatible.
 * Accumulate `weight * chunk` and the running `sum_weight`, then divide.
 */
export class DemucsOLA {
  constructor({ length, channels = 2, segment = SEGMENT_SAMPLES, overlap = 0.25, transitionPower = 1 }) {
    this.L = segment;
    this.stride = Math.trunc((1 - overlap) * segment);   // int() in python truncates
    this.length = length;
    this.channels = channels;
    this.w = demucsTriangularWeight(segment, transitionPower);
    this.acc = Array.from({ length: channels }, () => new Float64Array(length));
    this.sum = new Float64Array(length);
  }
  /** Offsets to iterate: range(0, length, stride) — exactly upstream's loop. */
  offsets() { const o = []; for (let i = 0; i < this.length; i += this.stride) o.push(i); return o; }
  /** @param {number} offset @param {Float32Array[]} seg channels x <=L */
  add(offset, seg) {
    const n = Math.min(seg[0].length, this.L, this.length - offset);
    for (let c = 0; c < this.channels; c++) {
      const a = this.acc[c], s = seg[c];
      for (let i = 0; i < n; i++) a[offset + i] += this.w[i] * s[i];
    }
    for (let i = 0; i < n; i++) this.sum[offset + i] += this.w[i];
  }
  finish() {
    for (let i = 0; i < this.length; i++) if (!(this.sum[i] > 0)) throw new Error(`sum_weight==0 at ${i}`);
    return this.acc.map((a) => {
      const y = new Float32Array(this.length);
      for (let i = 0; i < this.length; i++) y[i] = a[i] / this.sum[i];
      return y;
    });
  }
}

/**
 * Input normalisation, verbatim port of demucs/api.py::separate_tensor.
 * MUST be applied per whole track (export) or per rolling window (live) —
 * NEVER per chunk, or the stems will pump at every seam.
 */
export function normalizeMix(chans) {
  const T = chans[0].length, C = chans.length;
  let mean = 0;
  for (let i = 0; i < T; i++) { let m = 0; for (let c = 0; c < C; c++) m += chans[c][i]; mean += m / C; }
  mean /= T;
  let v = 0;
  for (let i = 0; i < T; i++) { let m = 0; for (let c = 0; c < C; c++) m += chans[c][i]; m = m / C - mean; v += m * m; }
  const std = Math.sqrt(v / T);           // torch .std() uses N-1; difference is < 1e-5 rel for T>1e5
  const g = 1 / (std + 1e-8);
  const out = chans.map((x) => { const y = new Float32Array(T); for (let i = 0; i < T; i++) y[i] = (x[i] - mean) * g; return y; });
  return { chans: out, mean, std };
}
export function denormalizeStem(chans, { mean, std }) {
  const s = std + 1e-8;
  return chans.map((x) => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * s + mean; return y; });
}
