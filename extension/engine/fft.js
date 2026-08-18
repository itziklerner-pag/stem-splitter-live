/**
 * Real-input FFT / IFFT + STFT/iSTFT for the Demucs pipeline.
 *
 * Why not the demucs-web vendored fft.js: it runs a full complex radix-2 FFT of
 * size 4096 for every frame and re-derives twiddles via Map lookups. The Demucs
 * post-processing needs 4 stems x 2 channels x 340 frames of iFFT per 7.8 s
 * segment (2720 transforms), which made JS post-processing cost more than the
 * GPU inference itself. This version:
 *   - uses an N/2-point complex FFT + split/recombine for real input (2x)
 *   - precomputes bit-reversal + twiddle tables once per size
 *   - reuses scratch buffers (no per-frame allocation)
 *
 * Convention matches demucs-web / torch.stft(normalized=True):
 *   forward scale 1/sqrt(nfft), periodic Hann, inverse uses window-sum normalisation.
 */

const tables = new Map();

function getTables(n) {
  let t = tables.get(n);
  if (t) return t;
  const bits = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0, x = i;
    for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    const a = -2 * Math.PI * k / n;
    cos[k] = Math.cos(a); sin[k] = Math.sin(a);
  }
  t = { bits, rev, cos, sin, n };
  tables.set(n, t);
  return t;
}

/** In-place iterative complex FFT (decimation in time). sign=-1 forward, +1 inverse (unscaled). */
function cfft(re, im, n, sign) {
  const { rev, cos, sin } = getTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tr = re[i]; re[i] = re[j]; re[j] = tr;
      let ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const tr = cos[k], ti = sign < 0 ? sin[k] : -sin[k];
        const i1 = i + j, i2 = i1 + half;
        const xr = re[i2], xi = im[i2];
        const or_ = xr * tr - xi * ti;
        const oi = xr * ti + xi * tr;
        re[i2] = re[i1] - or_; im[i2] = im[i1] - oi;
        re[i1] += or_;        im[i1] += oi;
      }
    }
  }
}

const rfftCache = new Map();
function getRfftScratch(n) {
  let s = rfftCache.get(n);
  if (s) return s;
  const h = n >> 1;
  const wr = new Float64Array(h + 1), wi = new Float64Array(h + 1);
  for (let k = 0; k <= h; k++) {
    const a = -2 * Math.PI * k / n;
    wr[k] = Math.cos(a); wi[k] = Math.sin(a);
  }
  s = { h, wr, wi, zr: new Float64Array(h), zi: new Float64Array(h) };
  rfftCache.set(n, s);
  return s;
}

/**
 * Real FFT. x: length n (Float32Array/Float64Array). Writes n/2+1 bins into outRe/outIm.
 */
export function rfft(x, xOff, n, outRe, outIm, outOff, scale) {
  const s = getRfftScratch(n);
  const h = s.h, zr = s.zr, zi = s.zi;
  for (let k = 0; k < h; k++) { zr[k] = x[xOff + 2 * k]; zi[k] = x[xOff + 2 * k + 1]; }
  cfft(zr, zi, h, -1);
  // X[k] = 0.5*[(Z[k]+conj(Z[h-k])) - i*W_n^k*(Z[k]-conj(Z[h-k]))]
  for (let k = 0; k <= h >> 1; k++) {
    const k2 = (h - k) % h;
    const ar = zr[k], ai = zi[k];
    const br = zr[k2], bi = -zi[k2];
    const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);   // even part
    const orr = 0.5 * (ar - br), oii = 0.5 * (ai - bi); // odd part (pre-twiddle)
    // -i * W^k * O   where W = wr + i*wi
    const tr = orr * s.wr[k] - oii * s.wi[k];
    const ti = orr * s.wi[k] + oii * s.wr[k];
    const xr = er + ti, xi = ei - tr;
    outRe[outOff + k] = xr * scale; outIm[outOff + k] = xi * scale;
    if (k > 0 && k < h - k) {
      // X[h-k] = conj( even(h-k) ... ) -> derive directly
      const kk = h - k;
      const ar2 = zr[kk % h], ai2 = zi[kk % h];
      const br2 = zr[(h - kk) % h], bi2 = -zi[(h - kk) % h];
      const er2 = 0.5 * (ar2 + br2), ei2 = 0.5 * (ai2 + bi2);
      const or2 = 0.5 * (ar2 - br2), oi2 = 0.5 * (ai2 - bi2);
      const tr2 = or2 * s.wr[kk] - oi2 * s.wi[kk];
      const ti2 = or2 * s.wi[kk] + oi2 * s.wr[kk];
      outRe[outOff + kk] = (er2 + ti2) * scale;
      outIm[outOff + kk] = (ei2 - tr2) * scale;
    }
  }
  // Nyquist bin k = h
  {
    const ar = zr[0], ai = zi[0];
    outRe[outOff + h] = (ar - ai) * scale;
    outIm[outOff + h] = 0;
  }
}

/**
 * Real inverse FFT of a hermitian spectrum with n/2+1 bins -> n real samples in out.
 */
export function irfft(inRe, inIm, inOff, n, out, outOff, scale) {
  const s = getRfftScratch(n);
  const h = s.h, zr = s.zr, zi = s.zi;
  for (let k = 0; k < h; k++) {
    const k2 = h - k;
    const ar = inRe[inOff + k], ai = inIm[inOff + k];
    const br = inRe[inOff + k2], bi = -inIm[inOff + k2];
    const er = 0.5 * (ar + br), ei = 0.5 * (ai + bi);
    const orr = 0.5 * (ar - br), oii = 0.5 * (ai - bi);
    // + i * conj(W^k) * O  ; conj(W^k) = wr - i*wi
    const tr = orr * s.wr[k] + oii * s.wi[k];
    const ti = -orr * s.wi[k] + oii * s.wr[k];
    zr[k] = er - ti;
    zi[k] = ei + tr;
  }
  cfft(zr, zi, h, +1);
  const inv = scale / h;
  for (let k = 0; k < h; k++) {
    out[outOff + 2 * k] = zr[k] * inv;
    out[outOff + 2 * k + 1] = zi[k] * inv;
  }
}

const hannCache = new Map();
export function hann(size) {
  let w = hannCache.get(size);
  if (w) return w;
  w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / size));
  hannCache.set(size, w);
  return w;
}

/** reflectPad identical to demucs-web (note: not numpy 'reflect', has an off-by-one on the left). */
export function reflectPad(sig, padLeft, padRight) {
  const n = sig.length;
  const out = new Float32Array(padLeft + n + padRight);
  for (let i = 0; i < padLeft; i++) out[i] = sig[Math.min(padLeft - i, n - 1)];
  out.set(sig, padLeft);
  for (let i = 0; i < padRight; i++) out[padLeft + n + i] = sig[Math.max(0, n - 2 - i)];
  return out;
}

/** STFT -> {real, imag} laid out [frame*numBins + bin], numBins = fftSize/2+1 */
export function stft(signal, fftSize, hopSize) {
  const numFrames = Math.floor((signal.length - fftSize) / hopSize) + 1;
  const numBins = fftSize / 2 + 1;
  const w = hann(fftSize);
  const scale = 1 / Math.sqrt(fftSize);
  const re = new Float32Array(numFrames * numBins);
  const im = new Float32Array(numFrames * numBins);
  const buf = new Float64Array(fftSize);
  for (let f = 0; f < numFrames; f++) {
    const s = f * hopSize;
    for (let i = 0; i < fftSize; i++) buf[i] = signal[s + i] * w[i];
    rfft(buf, 0, fftSize, re, im, f * numBins, scale);
  }
  return { real: re, imag: im, numFrames, numBins };
}

/** iSTFT with hann synthesis + window-sum normalisation (matches demucs-web). */
export function istft(specRe, specIm, numFrames, numBins, fftSize, hopSize, length) {
  const outLen = length || (numFrames - 1) * hopSize + fftSize;
  const out = new Float32Array(outLen);
  const wsum = new Float32Array(outLen);
  const w = hann(fftSize);
  const scale = Math.sqrt(fftSize);
  const full = fftSize / 2 + 1;
  const tmpRe = new Float64Array(full), tmpIm = new Float64Array(full);
  const frame = new Float64Array(fftSize);
  const w2 = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) w2[i] = w[i] * w[i];

  for (let f = 0; f < numFrames; f++) {
    tmpRe.fill(0); tmpIm.fill(0);
    const off = f * numBins;
    const nb = Math.min(numBins, full);
    for (let k = 0; k < nb; k++) { tmpRe[k] = specRe[off + k]; tmpIm[k] = specIm[off + k]; }
    tmpIm[0] = 0;
    if (numBins >= full) tmpIm[full - 1] = 0;
    irfft(tmpRe, tmpIm, 0, fftSize, frame, 0, scale);
    const s = f * hopSize;
    const lim = Math.min(fftSize, outLen - s);
    for (let i = 0; i < lim; i++) {
      out[s + i] += frame[i] * w[i];
      wsum[s + i] += w2[i];
    }
  }
  for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-8) out[i] /= wsum[i];
  return out;
}
