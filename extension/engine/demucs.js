/**
 * HT-Demucs v4 runner. Copied from the Phase-0 spike (`spike/src/demucs.js`),
 * which is parity-verified against PyTorch demucs (corr >= 0.9995) — the only
 * changes here are module wiring and writing post-processing straight into one
 * flat buffer so it can be transferred to the offscreen document zero-copy.
 * DO NOT touch the STFT/iSTFT math or the reflect-pad off-by-one.
 *
 * MODEL INPUT CONTRACT (htdemucs_6s.onnx, arjune123/demucs-onnx — same
 * hoisted-STFT, dual-input / dual-output design as the previous 4-stem pin;
 * shared/config.js MODEL carries the pin and the outstanding parity gate)
 *   inputs :  "input" float32 [1, 2, 343980]        raw waveform, 44100 Hz stereo, NOT normalised
 *                                                   (mean/std normalisation is baked into the graph)
 *             "x"     float32 [1, 4, 2048, 336]     STFT, channel-major [L.re, L.im, R.re, R.im]
 *   outputs:  "output" float32 [1, 6, 4, 2048, 336] freq branch, complex-as-channels per stem
 *             "add_67" float32 [1, 6, 2, 343980]    time branch per stem
 *   final stem = time_branch + iSTFT(freq_branch)
 *   stem order = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
 *                (shared/config.js STEMS is the one source of truth; `other`
 *                 stays at index 2 — docs/SIX-STEM-CONTRACT.md)
 *
 * TWO DIFFERENT FOURS LIVE IN THIS FILE AND ONLY ONE OF THEM IS A STEM COUNT.
 * Every `4` below that multiplies `BINS * FRAMES` — `prepareInput`'s `mag`
 * allocation, `ispecStem`'s `base`, and the `[1, 4, BINS, FRAMES]` feed — is
 * COMPLEX-AS-CHANNELS, i.e. [L.re, L.im, R.re, R.im]. It is fixed by the STFT,
 * not by the model's source list, and it did NOT change when the model widened
 * from four stems to six. The stem count is `STEMS.length` and is written that
 * way wherever it appears.
 *
 * STFT is *outside* the graph on purpose: in-graph STFT/ScatterND makes ORT-Web's
 * WebGPU EP refuse the session.
 */

import { stft, istft, reflectPad } from './fft.js';
import { SEGMENT, STEMS } from '../shared/config.js';

export const FFT_SIZE = 4096;
export const HOP_SIZE = 1024;
export const BINS = 2048;
export const FRAMES = 336;

export function prepareInput(segL, segR) {
  const pad = Math.floor(HOP_SIZE / 2) * 3;                 // 1536
  const le = Math.ceil(SEGMENT / HOP_SIZE);                 // 336
  const padRight = pad + le * HOP_SIZE - SEGMENT;           // 1620
  const cp = FFT_SIZE / 2;
  // 4 = COMPLEX-AS-CHANNELS [L.re, L.im, R.re, R.im], NOT a stem count.
  const mag = new Float32Array(4 * BINS * FRAMES);
  const chans = [segL, segR];
  for (let c = 0; c < 2; c++) {
    const p = reflectPad(reflectPad(chans[c], pad, padRight), cp, cp);
    const S = stft(p, FFT_SIZE, HOP_SIZE);
    const reBase = (c * 2 + 0) * BINS * FRAMES;
    const imBase = (c * 2 + 1) * BINS * FRAMES;
    for (let f = 0; f < FRAMES; f++) {
      const src = (f + 2) * S.numBins;                       // frameOffset = 2
      for (let b = 0; b < BINS; b++) {
        mag[reBase + b * FRAMES + f] = S.real[src + b];
        mag[imBase + b * FRAMES + f] = S.imag[src + b];
      }
    }
  }
  const wave = new Float32Array(2 * SEGMENT);
  wave.set(segL, 0);
  wave.set(segR, SEGMENT);
  return { wave, mag };
}

/** freq branch [nStems,4,BINS,FRAMES] for one stem -> [L, R] time signals of targetLen */
function ispecStem(freq, stemIdx, targetLen, scratch) {
  const pf = FRAMES + 4, pb = BINS + 1;
  // The per-stem stride is 4 COMPLEX-AS-CHANNELS planes, not four stems. This
  // literal is fixed by the STFT and is unchanged by the stem count.
  const base = stemIdx * 4 * BINS * FRAMES;
  const out = [];
  for (let ch = 0; ch < 2; ch++) {
    const re = scratch.re, im = scratch.im;
    re.fill(0); im.fill(0);
    const rSrc = base + (ch * 2 + 0) * BINS * FRAMES;
    const iSrc = base + (ch * 2 + 1) * BINS * FRAMES;
    for (let f = 0; f < FRAMES; f++) {
      const dst = (f + 2) * pb;
      for (let b = 0; b < BINS; b++) {
        re[dst + b] = freq[rSrc + b * FRAMES + f];
        im[dst + b] = freq[iSrc + b * FRAMES + f];
      }
    }
    const L = (pf - 1) * HOP_SIZE + FFT_SIZE;
    const y = istft(re, im, pf, pb, FFT_SIZE, HOP_SIZE, L);
    const off = FFT_SIZE / 2 + Math.floor(HOP_SIZE / 2) * 3;
    out.push(y.subarray(off, off + targetLen));
  }
  return out;
}

export function makeScratch() {
  const pf = FRAMES + 4, pb = BINS + 1;
  return { re: new Float32Array(pf * pb), im: new Float32Array(pf * pb) };
}

/**
 * freq [1,6,4,2048,336] + time [1,6,2,SEGMENT] -> flat Float32Array
 * laid out [stem][channel][sample], i.e. index (k*2 + ch)*SEGMENT + i.
 *
 * The 6 is `STEMS.length`; the 4 in the freq dims is complex-as-channels.
 */
export function postProcess(freq, time, scratch, out) {
  const dst = out || new Float32Array(STEMS.length * 2 * SEGMENT);
  for (let k = 0; k < STEMS.length; k++) {
    const f = ispecStem(freq, k, SEGMENT, scratch);
    const tl = k * 2 * SEGMENT, tr = tl + SEGMENT;
    const ol = tl, or_ = tr;
    const f0 = f[0], f1 = f[1];
    for (let i = 0; i < SEGMENT; i++) {
      dst[ol + i] = time[tl + i] + f0[i];
      dst[or_ + i] = time[tr + i] + f1[i];
    }
  }
  return dst;
}

export class DemucsEngine {
  /** @param {any} ort the onnxruntime-web module namespace */
  constructor(ort) {
    this.ort = ort;
    this.session = null;
    this.ep = null;
    this._scratch = null;
    this.stats = {};
  }

  /** @param {ArrayBuffer|Uint8Array} modelBuffer */
  async load(modelBuffer, ep = 'webgpu') {
    const t0 = performance.now();
    this.session = await this.ort.InferenceSession.create(modelBuffer, {
      executionProviders: [ep],
      graphOptimizationLevel: 'basic',   // 'all' is untested; upstream demucs-web avoids it
    });
    this.stats.sessionCreateMs = performance.now() - t0;
    this.ep = ep;
    this.inputNames = this.session.inputNames;
    this.outputNames = this.session.outputNames;
    this._scratch = makeScratch();
    return this.stats.sessionCreateMs;
  }

  /**
   * Run one 343980-sample segment.
   * @param {Float32Array} segL @param {Float32Array} segR
   * @param {Float32Array} [out] flat [STEMS.length][2][SEGMENT] destination
   */
  async runSegment(segL, segR, out) {
    const tPrep = performance.now();
    const { wave, mag } = prepareInput(segL, segR);
    const prepMs = performance.now() - tPrep;

    const tInf = performance.now();
    const feeds = {};
    feeds[this.inputNames[0]] = new this.ort.Tensor('float32', wave, [1, 2, SEGMENT]);
    // [1, 4, BINS, FRAMES] — 4 = COMPLEX-AS-CHANNELS, NOT the stem count.
    feeds[this.inputNames[1]] = new this.ort.Tensor('float32', mag, [1, 4, BINS, FRAMES]);
    const res = await this.session.run(feeds);
    let freq = null, time = null;
    for (const n of this.outputNames) {
      const t = res[n];
      if (t.dims.length === 5) freq = t.data;
      else if (t.dims.length === 4) time = t.data;
    }
    const inferMs = performance.now() - tInf;

    const tPost = performance.now();
    const stems = postProcess(freq, time, this._scratch, out);
    const postMs = performance.now() - tPost;
    return { stems, prepMs, inferMs, postMs };
  }
}
