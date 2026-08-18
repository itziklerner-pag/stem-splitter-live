#!/usr/bin/env node
// selftest.js — unit tests for the DSP contract in docs/AUDIO.md.
// Run in CI:  node docs/snippets/selftest.js
// No dependencies, no audio device, deterministic.

import { makeLivePlan, trapezoidWindow, demucsTriangularWeight, colaError, TrapezoidOLA, DemucsOLA, SEGMENT_SAMPLES, MODEL_SR, normalizeMix, denormalizeStem } from './ola.js';
import { Resampler, resampleBuffer } from './resample.js';
import { encodeWav, decodeWav } from './wav.js';
import { faderDb, dbToFader, faderGain, resolveGains, softClipCurve, applyCurve, makeDcBlocker, STEMS } from './mixer.js';
import { makeTestbed, makeStationary, checkTestbed } from './make-testbed.js';
import { STEMS as CONFIG_STEMS } from '../../extension/shared/config.js';

let failures = 0;
const ok = (name, cond, detail = '') => { console.log(`${cond ? ' ok  ' : 'FAIL '}${name}${detail ? '   ' + detail : ''}`); if (!cond) failures++; };
const rmsDb = (a, b) => { let n = 0, d = 0; for (let i = 0; i < a.length; i++) { const e = a[i] - b[i]; n += e * e; d += a[i] * a[i]; } return 10 * Math.log10(n / (d || 1e-300)); };
const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

console.log('\n--- 1. segment constants -------------------------------------------------');
ok('SEGMENT_SAMPLES === 343980 (7.8 s @ 44100)', SEGMENT_SAMPLES === 343980, `got ${SEGMENT_SAMPLES}`);

console.log('\n--- 2. COLA ---------------------------------------------------------------');
for (const preset of [
  { name: 'live-safe   H=3.0 X=0.5 R=0.5', hopSeconds: 3.0, crossfadeSeconds: 0.5, rightContextSeconds: 0.5 },
  { name: 'live-fast   H=1.5 X=0.25 R=0.25', hopSeconds: 1.5, crossfadeSeconds: 0.25, rightContextSeconds: 0.25 },
  { name: 'live-tight  H=1.0 X=0.15 R=0.20', hopSeconds: 1.0, crossfadeSeconds: 0.15, rightContextSeconds: 0.20 },
]) {
  const p = makeLivePlan(preset);
  const e = colaError(p.window, p.H);
  ok(`COLA ${preset.name}`, e < 1e-6,
    `P=${(p.P / MODEL_SR).toFixed(2)}s lookahead=${p.lookaheadSeconds.toFixed(2)}s maxInf=${p.maxInferenceSeconds.toFixed(2)}s err=${e.toExponential(1)}`);
}
{
  const w = demucsTriangularWeight(1000);
  ok('demucs triangular peaks at 1.0', Math.max(...w) === 1);
  ok('demucs triangular is NOT COLA at overlap 0.25 (upstream divides instead)', colaError(w, 750) > 0.1,
    `err=${colaError(w, 750).toFixed(3)}`);
}

console.log('\n--- 3. overlap-add reconstruction with an identity model ------------------');
{
  // The strongest DSP test available: replace the model with identity. A correct
  // OLA pipeline must return the input bit-for-bit (to float32 epsilon).
  const plan = makeLivePlan({ hopSeconds: 3.0, crossfadeSeconds: 0.5, rightContextSeconds: 0.5 });
  const rnd = mulberry32(7);
  const T = plan.H * 6 + plan.X + plan.R;
  const x = [new Float32Array(T), new Float32Array(T)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < T; i++) x[c][i] = rnd() * 2 - 1;
  const ola = new TrapezoidOLA(plan, 2);
  const y = [[], []];
  const nChunks = Math.ceil((T - plan.X - plan.R) / plan.H);
  for (let k = 0; k < nChunks; k++) {
    const { start } = ola.inputRange(k);
    const seg = [0, 1].map((c) => {
      const s = new Float32Array(plan.L);
      for (let i = 0; i < plan.L; i++) { const t = start + i; s[i] = t >= 0 && t < T ? x[c][t] : 0; }
      return s;
    });
    const out = ola.push(seg, k === nChunks - 1);
    for (let c = 0; c < 2; c++) y[c].push(out[c]);
  }
  const cat = (parts) => { const n = parts.reduce((a, b) => a + b.length, 0), o = new Float32Array(n); let p = 0; for (const q of parts) { o.set(q, p); p += q.length; } return o; };
  const Y = [cat(y[0]), cat(y[1])];
  const n = Math.min(T, Y[0].length);
  const err = Math.max(rmsDb(x[0].subarray(0, n), Y[0].subarray(0, n)), rmsDb(x[1].subarray(0, n), Y[1].subarray(0, n)));
  ok('TrapezoidOLA identity reconstruction < -120 dB', err < -120, `${err.toFixed(1)} dB, ${nChunks} chunks, ${n}/${T} samples`);
}
{
  const T = SEGMENT_SAMPLES * 3;
  const rnd = mulberry32(11);
  const x = [new Float32Array(T), new Float32Array(T)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < T; i++) x[c][i] = rnd() * 2 - 1;
  const ola = new DemucsOLA({ length: T, channels: 2, overlap: 0.25 });
  for (const off of ola.offsets()) {
    const n = Math.min(SEGMENT_SAMPLES, T - off);
    ola.add(off, [x[0].subarray(off, off + n), x[1].subarray(off, off + n)]);
  }
  const Y = ola.finish();
  const err = Math.max(rmsDb(x[0], Y[0]), rmsDb(x[1], Y[1]));
  ok('DemucsOLA identity reconstruction < -120 dB', err < -120, `${err.toFixed(1)} dB, stride=${ola.stride}`);
}

console.log('\n--- 4. resampler ----------------------------------------------------------');
{
  const r = new Resampler(48000, 44100);
  ok('48k->44.1k ratio L/M = 147/160', r.L === 147 && r.M === 160, `L=${r.L} M=${r.M}`);
  console.log(`      prototype ${r.N} taps, cutoff ${r.cutoffHz.toFixed(0)} Hz, transition ${r.transitionHz.toFixed(0)} Hz, groupDelayIn ${r.groupDelayInExact.toFixed(4)} samples`);

  const FS = 48000, T = FS * 2;
  const tones = [100, 440, 1000, 3000, 7000, 12000, 17000, 19000];
  const x = new Float32Array(T);
  tones.forEach((f, k) => { for (let i = 0; i < T; i++) x[i] += 0.1 * Math.sin(2 * Math.PI * f * i / FS + k); });
  const mid = resampleBuffer(x, 48000, 44100);
  const back = resampleBuffer(mid, 44100, 48000);
  const g = 4000, n = Math.min(x.length, back.length) - g;
  const err = rmsDb(x.subarray(g, n), back.subarray(g, n));
  ok('48k->44.1k->48k round trip (100 Hz .. 19 kHz) < -85 dB', err < -85, `${err.toFixed(1)} dB`);
  ok('group delay is an exact integer of input samples', r.groupDelayInExact === r.P / 2, `${r.groupDelayInExact}`);

  // Out-of-band rejection: 23 kHz cannot survive a trip through 44.1 kHz.
  const y = new Float32Array(T);
  for (let i = 0; i < T; i++) y[i] = 0.5 * Math.sin(2 * Math.PI * 23000 * i / FS);
  const d = resampleBuffer(y, 48000, 44100);
  let ein = 0, eout = 0;
  for (let i = g; i < T - g; i++) ein += y[i] * y[i];
  for (let i = g; i < d.length - g; i++) eout += d[i] * d[i];
  const rej = 10 * Math.log10((eout / (d.length - 2 * g)) / (ein / (T - 2 * g)));
  ok('23 kHz alias rejection <= -80 dB', rej <= -80, `${rej.toFixed(1)} dB`);

  // Linear interpolation, for contrast — this is what Blink's AudioBufferSourceNode does.
  const lin = new Float32Array(Math.floor(T * 44100 / 48000));
  for (let n2 = 0; n2 < lin.length; n2++) { const t = n2 * 48000 / 44100, i = Math.floor(t), a = t - i; lin[n2] = x[i] * (1 - a) + x[i + 1] * a; }
  const linBack = new Float32Array(T);
  for (let n2 = 0; n2 < T; n2++) { const t = n2 * 44100 / 48000, i = Math.floor(t), a = t - i; linBack[n2] = i + 1 < lin.length ? lin[i] * (1 - a) + lin[i + 1] * a : 0; }
  const linErr = rmsDb(x.subarray(g, n), linBack.subarray(g, n));
  console.log(`      (for contrast) linear-interp round trip = ${linErr.toFixed(1)} dB  <- Blink AudioBufferSourceNode`);
  ok('polyphase beats linear interpolation by > 60 dB', err < linErr - 60, `${(linErr - err).toFixed(1)} dB better`);
}

console.log('\n--- 5. WAV round trip -----------------------------------------------------');
{
  const N = 20000, rnd = mulberry32(3);
  const ch = [new Float32Array(N), new Float32Array(N)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) ch[c][i] = (rnd() * 2 - 1) * 0.7;
  for (const [depth, float, limit] of [[32, true, -300], [24, false, -130], [16, false, -80]]) {
    const w = decodeWav(encodeWav(ch, { sampleRate: 44100, bitDepth: depth, float, dither: depth === 16 }));
    const e = Math.max(rmsDb(ch[0], w.channels[0]), rmsDb(ch[1], w.channels[1]));
    ok(`wav ${float ? '32f' : depth + '-bit'} round trip <= ${limit} dB`, e <= limit, `${e === -Infinity ? 'exact' : e.toFixed(1) + ' dB'}, ${w.sampleRate} Hz`);
  }
  const buf = encodeWav(ch, { sampleRate: 44100, bitDepth: 32, float: true });
  const dv = new DataView(buf);
  ok('header: RIFF size == fileSize-8', dv.getUint32(4, true) === buf.byteLength - 8);
  ok('header: fmt chunk size 18 for IEEE float', dv.getUint32(16, true) === 18);
  ok('header: audioFormat 3 (IEEE float)', dv.getUint16(20, true) === 3);
  ok('header: byteRate == sr*blockAlign', dv.getUint32(28, true) === 44100 * 8);
  ok('header: fact chunk present with frame count', String.fromCharCode(dv.getUint8(38), dv.getUint8(39), dv.getUint8(40), dv.getUint8(41)) === 'fact' && dv.getUint32(46, true) === N);
  ok('header: data chunk size == frames*blockAlign', dv.getUint32(54, true) === N * 8);
}

console.log('\n--- 6. fader law / mute / solo --------------------------------------------');
{
  let mono = true;
  for (let u = 0.001; u < 1; u += 0.001) if (faderDb(u + 0.001) < faderDb(u) - 1e-9) mono = false;
  ok('fader law monotonic', mono);
  ok('fader unity at u = 0.80', Math.abs(faderDb(0.8)) < 1e-9, `${faderDb(0.8).toFixed(6)} dB`);
  ok('fader +6 dB at u = 1.0', Math.abs(faderDb(1) - 6) < 1e-9);
  ok('fader hard zero at u = 0', faderGain(0) === 0);
  let inv = 0;
  for (let u = 0.01; u <= 1; u += 0.01) inv = Math.max(inv, Math.abs(dbToFader(faderDb(u)) - u));
  ok('dbToFader is the exact inverse', inv < 1e-9, `max err ${inv.toExponential(1)}`);

  const S = (mute, solo, fader = 0.8) => ({ mute, solo, fader });
  const unity = (v) => Math.abs(v - 1) < 1e-9;
  const g1 = resolveGains([S(0, 0), S(1, 0), S(0, 0), S(0, 0)], 0.8);
  ok('mute silences only that stem', g1[1] === 0 && unity(g1[0]) && unity(g1[3]));
  const g2 = resolveGains([S(0, 1), S(0, 0), S(0, 0), S(0, 0)], 0.8);
  ok('one solo silences the rest', unity(g2[0]) && g2.slice(1).every((v) => v === 0));
  const g3 = resolveGains([S(0, 1), S(0, 1), S(0, 0), S(0, 0)], 0.8);
  ok('multiple solos are a union', unity(g3[0]) && unity(g3[1]) && g3[2] === 0 && g3[3] === 0);
  const g4 = resolveGains([S(1, 1), S(0, 0), S(0, 0), S(0, 0)], 0.8);
  ok('solo overrides mute on the soloed stem', unity(g4[0]));
  ok('master fader scales everything', Math.abs(resolveGains([S(0, 0)], 1)[0] - Math.pow(10, 6 / 20)) < 1e-12);
}

console.log('\n--- 7. master protection --------------------------------------------------');
{
  const c = softClipCurve(0.7079, 2);
  const at = (x) => applyCurve(c, x, 2);
  ok('soft clip transparent at -6 dBFS', Math.abs(at(0.5) - 0.5) < 1e-3, `${at(0.5).toFixed(6)}`);
  ok('soft clip transparent at the -3 dBFS knee', Math.abs(at(0.7079) - 0.7079) < 1e-3, `${at(0.7079).toFixed(6)}`);
  ok('soft clip ceiling < 1.0 at 0 dBFS', at(1) < 1 && at(1) > 0.9, `${at(1).toFixed(6)} (${(20 * Math.log10(at(1))).toFixed(2)} dBFS)`);
  ok('soft clip ceiling < 1.0 at +6 dBFS', at(2) < 1 && at(2) > 0.99, `${at(2).toFixed(6)} (${(20 * Math.log10(at(2))).toFixed(3)} dBFS)`);
  ok('soft clip ceiling holds at +12 dBFS', at(4) < 1, `${at(4).toFixed(6)}`);
  ok('soft clip is odd-symmetric', Math.abs(at(0.9) + at(-0.9)) < 1e-9);

  const dc = makeDcBlocker(44100, 5);
  const b = new Float32Array(44100).fill(0.05);
  dc(b);
  ok('DC blocker removes 0.05 DC within 1 s', Math.abs(b[44099]) < 1e-3, `residual ${b[44099].toExponential(1)}`);
}

console.log('\n--- 8. demucs normalisation round trip ------------------------------------');
{
  const N = 100000, rnd = mulberry32(5);
  const x = [new Float32Array(N), new Float32Array(N)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) x[c][i] = (rnd() * 2 - 1) * 0.3 + 0.01;
  const { chans, mean, std } = normalizeMix(x);
  const back = denormalizeStem(chans, { mean, std });
  ok('normalize -> denormalize round trip < -110 dB', rmsDb(x[0], back[0]) < -110, `${rmsDb(x[0], back[0]).toFixed(1)} dB`);
  console.log(`      mean=${mean.toExponential(2)} std=${std.toFixed(5)}  (mean is added back to EVERY stem upstream — see AUDIO.md §3.4)`);
}

console.log('\n--- 9. testbed ground truth (docs/AUDIO.md §6.2) ---------------------------');
{
  // Why this section exists at all. `make-testbed.js` synthesised exactly FOUR
  // sources for the whole first pass of the 6-stem migration, and nothing went
  // red: a 6-stem model run on 4-source material produces a near-silent guitar
  // and piano, and near-silent output satisfies every "reads exactly 0"
  // assertion in the repo. There was no ground truth for the two new stems and
  // therefore no separation-quality number for them that meant anything.
  //
  // Everything below is a comparison against a value read out of the testbed. A
  // source that is missing is a FAIL — `checkTestbed()` has no `!x || (check)`
  // guard anywhere in it, and neither does this block.
  ok('mixer.js STEMS is config.js STEMS (no local re-declaration)',
    STEMS.length === CONFIG_STEMS.length && STEMS.every((s, i) => s === CONFIG_STEMS[i]),
    `[${STEMS.join(' ')}]`);

  // 8 s = four bars at 120 BPM: one full cycle of the progression, so every
  // chord, strum, arpeggio and stab is present exactly as it is in a QA render.
  checkTestbed(makeTestbed({ seconds: 8, bpm: 120 }), ok, { label: 'musical', dynamic: true });
  checkTestbed(makeStationary({ seconds: 6 }), ok, { label: 'steady', dynamic: false });
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall tests passed\n');
process.exit(failures ? 1 : 0);
