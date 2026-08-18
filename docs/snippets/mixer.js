// mixer.js — stem gain law, mute/solo semantics, ramping, master protection.
// See docs/AUDIO.md §3 and §4.

// The wire order, re-exported rather than re-declared. It was a local literal
// `['drums','bass','other','vocals']` and it sat four wide through the whole
// 6-stem migration without anything noticing — nothing in this file reads it, so
// there was no test that could have caught it. A constant with no reader and its
// own copy of the truth is exactly the shape that drifts.
//
// The import reaches out of docs/snippets/ into the extension, which inverts the
// usual direction here (extension/engine/mixer.js is a PORT of this file). That
// is deliberate: there is one wire order in this product, config.js owns it, and
// a second copy in a reference snippet is worth less than nothing. Nothing else
// in docs/snippets/ depends on the extension, and config.js has no imports of
// its own, so this stays a leaf.
export { STEMS } from '../../extension/shared/config.js';

// ---------------------------------------------------------------- fader law
/**
 * Stem Splitter Live fader law: piecewise-linear in dB, unity at u = 0.80, +6 dB at the top,
 * hard zero at exactly u = 0. Slopes 120 / 60 / 50 / 30 dB per unit travel.
 * @param {number} u 0..1
 * @returns {number} dB, or -Infinity at u === 0
 */
export function faderDb(u) {
  if (!(u > 0)) return -Infinity;
  if (u >= 1) return 6;
  if (u <= 0.25) return -60 + 120 * u;                    // -60 .. -30
  if (u <= 0.50) return -30 + 60 * (u - 0.25);            // -30 .. -15
  if (u <= 0.80) return -15 + 50 * (u - 0.50);            // -15 ..   0
  return 30 * (u - 0.80);                                 //   0 .. +6
}
/** Inverse, for restoring a saved dB value onto the fader. */
export function dbToFader(db) {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 6) return 1;
  if (db <= -30) return (db + 60) / 120;
  if (db <= -15) return 0.25 + (db + 30) / 60;
  if (db <= 0) return 0.50 + (db + 15) / 50;
  return 0.80 + db / 30;
}
export const dbToGain = (db) => (db === -Infinity ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));
export const faderGain = (u) => dbToGain(faderDb(u));

// ---------------------------------------------------------------- mute/solo
/**
 * Standard DAW semantics:
 *  - any stem soloed  => only soloed stems are audible; their own mute is IGNORED
 *  - no stem soloed   => muted stems are silent
 *  - multiple solos   => union (all soloed stems audible, at their own fader)
 *  - solo is solo-in-place: it does not change the level of the soloed stem
 * @param {{mute:boolean, solo:boolean, fader:number}[]} state
 * @param {number} masterFader
 * @returns {number[]} linear gain per stem
 */
export function resolveGains(state, masterFader = 0.8) {
  const anySolo = state.some((s) => s.solo);
  const m = faderGain(masterFader);
  return state.map((s) => {
    const on = anySolo ? s.solo : !s.mute;
    return on ? faderGain(s.fader) * m : 0;
  });
}

// ---------------------------------------------------------------- ramping
/** Time constants, seconds. setTargetAtTime reaches 95% in 3*tau, 99% in 4.6*tau. */
export const TAU = {
  mute: 0.003,     // 95% in  9 ms, 99% in 14 ms — "instant" but click-free
  fader: 0.010,    // 95% in 30 ms — smooth under a fast hand
  master: 0.020,
};

/**
 * Apply a gain change without zipper noise or a click.
 * Always follow a ramp-to-zero with an exact setValueAtTime(0) so the node truly
 * silences (setTargetAtTime is asymptotic and leaves denormal-level residue).
 */
export function rampGain(param, target, ctx, tau = TAU.fader) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setTargetAtTime(target, t, tau);
  if (target === 0) param.setValueAtTime(0, t + 6 * tau);
  return t + 6 * tau;   // time at which the change is complete
}

/**
 * Beat-quantised version. In live mode the processed audio is already `lookahead`
 * seconds behind the capture, so the beat grid for the *audio about to be played*
 * is already known — schedule the ramp so it lands exactly on the beat.
 * @param {number} beatTime AudioContext time of the target beat
 */
export function rampGainAtBeat(param, target, beatTime, tau = TAU.mute) {
  param.cancelScheduledValues(beatTime - 3 * tau);
  param.setTargetAtTime(target, beatTime - 3 * tau, tau);
  if (target === 0) param.setValueAtTime(0, beatTime + 3 * tau);
}

// ---------------------------------------------------------------- master bus
/** The transfer function itself. Identity below `t`, asymptotic to +/-1 above it. */
export const softClip = (x, t = 0.7079) => {
  const a = Math.abs(x);
  return Math.sign(x) * (a <= t ? a : t + (1 - t) * Math.tanh((a - t) / (1 - t)));
};

/**
 * Soft-clip curve for a WaveShaperNode. A WaveShaper's curve domain is fixed to
 * [-1, +1], so we scale by `headroom` (linear) to cover signals hotter than 0 dBFS
 * and undo it after the node:
 *
 *   sum -> trim -> gain(1/headroom) -> WaveShaper(curve) -> gain(headroom) -> dest
 *
 * headroom = 2 (+6 dB) with t = 0.7079 (-3 dBFS knee) gives:
 *   bit-transparent up to -3 dBFS, hard ceiling 0.9997 (-0.003 dBFS) at and above
 *   +6 dBFS. Zero latency, no gain pumping, no release-time tuning.
 * Set node.oversample = '4x' so the generated harmonics do not alias.
 */
export function softClipCurve(threshold = 0.7079, headroom = 2, n = 8192) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = softClip(x * headroom, threshold) / headroom;
  }
  return c;
}

/** Evaluate a WaveShaper curve the way Web Audio does (for unit tests). */
export function applyCurve(curve, x, headroom = 2) {
  const u = Math.max(-1, Math.min(1, x / headroom));
  const p = ((u + 1) / 2) * (curve.length - 1);
  const i = Math.floor(p), f = p - i;
  const v = i + 1 < curve.length ? curve[i] * (1 - f) + curve[i + 1] * f : curve[curve.length - 1];
  return v * headroom;
}

/** Wire the standard master chain: sum -> trim -> soft clip -> destination. */
export function buildMasterBus(ctx, { trimDb = 0, kneeDb = -3, headroomDb = 6 } = {}) {
  const headroom = dbToGain(headroomDb);
  const input = ctx.createGain();
  const trim = ctx.createGain(); trim.gain.value = dbToGain(trimDb);
  const pre = ctx.createGain(); pre.gain.value = 1 / headroom;
  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve(dbToGain(kneeDb), headroom);
  shaper.oversample = '4x';
  const post = ctx.createGain(); post.gain.value = headroom;
  input.connect(trim).connect(pre).connect(shaper).connect(post).connect(ctx.destination);
  return { input, trim, shaper, post, headroom };
}

// ---------------------------------------------------------------- DC blocker
/**
 * One-pole DC blocker, -3 dB at `fc`. Separated stems (especially `bass` and
 * `other`) can carry a few hundred microvolts of DC; six of them summed plus a
 * soft clipper turns that into asymmetric headroom loss.
 *   y[n] = x[n] - x[n-1] + R*y[n-1],  R = 1 - 2*pi*fc/fs
 */
export function makeDcBlocker(fs = 44100, fc = 5) {
  const R = 1 - (2 * Math.PI * fc) / fs;   // 0.999288 at 44100 / 5 Hz
  let x1 = 0, y1 = 0;
  return (buf) => {
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i];
      const y = x - x1 + R * y1;
      x1 = x; y1 = y; buf[i] = y;
    }
    return buf;
  };
}
