// resample.js — rational polyphase windowed-sinc resampler.
// Normative implementation for Stem Splitter Live. See docs/AUDIO.md §1.
//
// Use it for 48000 -> 44100 (L=147, M=160) and 44100 -> 48000 (L=160, M=147).
// Do NOT use AudioBufferSourceNode or OfflineAudioContext to change sample rate:
// Blink resamples AudioBufferSourceNode with LINEAR interpolation (up to -6 dB of
// phase-dependent droop at 16 kHz, ~-7 dB alias rejection near Nyquist).
//
// Design (defaults, for either direction between 44.1k and 48k):
//   prototype length N = tapsPerPhase * L  = 128 * 147 = 18816 taps @ 7.056 MHz
//   Kaiser beta 9.5  -> stopband attenuation A = beta/0.1102 + 8.7 = 95.9 dB
//   transition width  df = (A-8)/(2.285*N) * fsUp/(2*pi) = 2296 Hz
//   cutoff fc         = min(fsIn,fsOut)/2 - df/2 = 20902 Hz
//   => passband flat (<0.001 dB) to 19.75 kHz, images/aliases <= -96 dB at 22.05 kHz
//   group delay       = (N-1)/(2*L) input samples = 63.9966 (compensated as exactly 64;
//                       residual 0.0034 input samples = 71 ns)
//   cost              = tapsPerPhase MACs per output sample per channel
//                       = 128 * 44100 * 2 = 11.3 MMAC/s. Negligible.

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

function besselI0(x) {
  // Series expansion; converges fast for the |x| <= ~20 we need.
  let sum = 1, term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-18) break;
  }
  return sum;
}

/**
 * Build the linear-phase prototype low-pass, already scaled by L so the
 * polyphase branches have unity DC gain.
 */
export function designPrototype({ L, N, fsUp, cutoffHz, beta, center }) {
  const h = new Float64Array(N);
  // Centre the impulse response on an exact multiple of L so the group delay is an
  // exact integer number of INPUT samples (P/2) and needs no fractional correction.
  const c = center ?? (N - 1) / 2;
  const hw = Math.max(c, N - 1 - c);
  const fcn = cutoffHz / fsUp;       // normalised cutoff, cycles/sample
  const i0b = besselI0(beta);
  for (let k = 0; k < N; k++) {
    const t = k - c;
    const sinc = t === 0 ? 1 : Math.sin(2 * Math.PI * fcn * t) / (2 * Math.PI * fcn * t);
    const r = t / hw;                // -1 .. +1
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[k] = L * 2 * fcn * sinc * w;
  }
  return h;
}

export class Resampler {
  /**
   * @param {number} fsIn
   * @param {number} fsOut
   * @param {{tapsPerPhase?:number, beta?:number, cutoffHz?:number}} [opts]
   */
  constructor(fsIn, fsOut, opts = {}) {
    const g = gcd(fsIn, fsOut);
    this.fsIn = fsIn;
    this.fsOut = fsOut;
    this.L = fsOut / g;                       // interpolation factor
    this.M = fsIn / g;                        // decimation factor
    this.P = opts.tapsPerPhase ?? 128;        // taps per polyphase branch (keep even)
    this.beta = opts.beta ?? 9.5;
    this.N = this.P * this.L;
    const fsUp = fsIn * this.L;
    const A = this.beta / 0.1102 + 8.7;                       // dB, Kaiser
    const df = ((A - 8) / (2.285 * this.N)) * fsUp / (2 * Math.PI); // Hz
    this.cutoffHz = opts.cutoffHz ?? (Math.min(fsIn, fsOut) / 2 - df / 2);
    this.transitionHz = df;
    // Group delay, exactly P/2 input samples.
    this.delayIn = this.P >> 1;
    const center = this.delayIn * this.L;
    this.h = designPrototype({ L: this.L, N: this.N, fsUp, cutoffHz: this.cutoffHz, beta: this.beta, center });
    this.groupDelayInExact = this.delayIn;              // input samples (exact)
    this.groupDelayOutExact = center / this.M;          // output samples (exact)

    this.reset();
  }

  reset() {
    // Rolling input history. buf[0] corresponds to absolute input index bufStart.
    this.buf = new Float64Array(this.P + 4096);
    this.bufLen = this.P - 1;            // pre-loaded with zeros = left pad
    this.bufStart = -(this.P - 1);
    this.phase = 0;                      // (n*M) mod L
    this.base = 0;                       // floor(n*M / L)
    this.outCount = 0;
  }

  /** Upper bound on outputs produced by feeding `nIn` more input samples. */
  outputCapacity(nIn) { return Math.ceil((this.bufLen + nIn) * this.L / this.M) + 2; }

  /**
   * Streaming: push input samples, get whatever output is fully determined.
   * @param {Float32Array|Float64Array} x
   * @returns {Float32Array}
   */
  process(x) {
    // grow / compact the history buffer
    const need = this.bufLen + x.length;
    if (need > this.buf.length) {
      const nb = new Float64Array(Math.max(need, this.buf.length * 2));
      nb.set(this.buf.subarray(0, this.bufLen));
      this.buf = nb;
    }
    this.buf.set(x, this.bufLen);
    this.bufLen += x.length;

    const { L, M, P, h } = this;
    const out = new Float32Array(this.outputCapacity(0));
    let o = 0;
    // y[n] = sum_j h[phase + j*L] * x[base + delayIn - j]
    // highest input index touched = base + delayIn ; lowest = base + delayIn - P + 1
    for (;;) {
      const hi = this.base + this.delayIn;
      const lo = hi - P + 1;
      if (hi >= this.bufStart + this.bufLen) break;      // need more input
      let acc = 0;
      const off = lo - this.bufStart;
      // j runs P-1 .. 0 as the buffer index runs lo .. hi
      for (let j = P - 1, b = off; j >= 0; j--, b++) acc += h[this.phase + j * L] * this.buf[b];
      out[o++] = acc;
      this.outCount++;
      const p = this.phase + M;
      this.base += (p / L) | 0;
      this.phase = p % L;
      // discard history we will never touch again
      const keepFrom = this.base + this.delayIn - P + 1 - this.bufStart;
      if (keepFrom > 8192) {
        this.buf.copyWithin(0, keepFrom, this.bufLen);
        this.bufLen -= keepFrom;
        this.bufStart += keepFrom;
      }
    }
    return out.subarray(0, o);
  }

  /** Flush the tail: feeds delayIn zeros so the last real samples come out. */
  flush() { return this.process(new Float32Array(this.P)); }
}

/** One-shot convenience for offline buffers. Output length = round(x.length * fsOut/fsIn). */
export function resampleBuffer(x, fsIn, fsOut, opts) {
  if (fsIn === fsOut) return Float32Array.from(x);
  const r = new Resampler(fsIn, fsOut, opts);
  const a = r.process(x), b = r.flush();
  const want = Math.round(x.length * fsOut / fsIn);
  const y = new Float32Array(want);
  y.set(a.subarray(0, Math.min(a.length, want)));
  if (a.length < want) y.set(b.subarray(0, want - a.length), a.length);
  return y;
}
