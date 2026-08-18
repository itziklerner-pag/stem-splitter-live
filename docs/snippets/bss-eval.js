#!/usr/bin/env node
// bss-eval.js — objective separation metrics QA can run headless.
// See docs/AUDIO.md §6.
//
//   node bss-eval.js <truthDir> <estDir> [--hop 132300] [--crossfade 22050] [--json]
//
// truthDir must contain mix.wav + one wav per stem — all SIX of
// drums bass other vocals guitar piano, the `STEMS` order from
// extension/shared/config.js. estDir must contain the same stem filenames, same
// length, same sample rate.
//
// THE STEM LIST IS THE PROJECTION BASIS, not a loop bound. Running this with a
// basis narrower than the material is not "a narrower report" — it is a WRONG
// one: energy belonging to a source that is not in the basis has nowhere to
// project and is attributed to whichever basis vector is nearest, inflating that
// stem's interference and deflating its SDR. That is why `STEMS` is imported
// from config.js here and never re-declared.
//
// Reports, per stem:
//   SDR / SIR / SAR  — BSS-Eval with filter length 1 (projection onto the span of
//                      the ground-truth sources). Global and median-of-1s-frames.
//   SI-SDR           — scale-invariant SDR (Le Roux 2019), gain-robust.
// Plus:
//   leakage matrix   — Pearson correlation of 20 ms log-energy envelopes, est x truth
//   reconstruction   — 20*log10(|| mix - sum(est) || / || mix ||)
//   seam report      — sample-scale click ratio at every chunk boundary
//
// The seam GATE is only meaningful on stationary material. Generate it with
//   node make-testbed.js ./steady 30 120 --steady
// and run bss-eval against that. On musical material the seam numbers are
// advisory only (chunk boundaries land on downbeats and transients look like
// discontinuities to any single-pass statistic).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav } from './wav.js';
import { STEMS } from '../../extension/shared/config.js';

export { STEMS };
const db = (x) => 10 * Math.log10(Math.max(x, 1e-300));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const dotMulti = (A, B) => { let s = 0; for (let c = 0; c < A.length; c++) s += dot(A[c], B[c]); return s; };

function solve(G, b) {                       // small dense solve with ridge
  const n = b.length, M = G.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < n; i++) M[i][i] += 1e-12 * (G[i][i] || 1);
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-30) continue;
    for (let r = 0; r < n; r++) { if (r === i) continue; const f = M[r][i] / M[i][i]; for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]; }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-30 ? 0 : r[n] / r[i]));
}

/**
 * BSS-Eval, filter length 1, multichannel (channels treated jointly).
 *
 * J is `truths.length` throughout — the Gram matrix, `solve()`'s pivoting and
 * the projection loop are all sized from it, so widening the basis from 4 to 6
 * needed no change HERE. The only place the stem count was baked in beyond the
 * basis was `framedMetrics()`; see the note there.
 *
 * @param {Float32Array[][]} truths  J sources x C channels
 * @param {Float32Array[]} est       C channels, the estimate of source `idx`
 */
export function bssMetrics(truths, est, idx) {
  const J = truths.length;
  const G = Array.from({ length: J }, (_, j) => truths.map((_, k) => dotMulti(truths[j], truths[k])));
  const b = truths.map((t) => dotMulti(t, est));
  const c = solve(G, b);
  const a = b[idx] / Math.max(G[idx][idx], 1e-300);        // 1-D projection onto the target
  const C = est.length, T = est[0].length;
  let eT = 0, eI = 0, eA = 0, eTI = 0;
  for (let ch = 0; ch < C; ch++) {
    for (let i = 0; i < T; i++) {
      const tgt = a * truths[idx][ch][i];
      let proj = 0; for (let j = 0; j < J; j++) proj += c[j] * truths[j][ch][i];
      const interf = proj - tgt, artif = est[ch][i] - proj;
      eT += tgt * tgt; eI += interf * interf; eA += artif * artif;
      eTI += (tgt + interf) * (tgt + interf);
    }
  }
  return { SDR: db(eT / (eI + eA)), SIR: db(eT / eI), SAR: db(eTI / eA) };
}

/** Scale-invariant SDR. */
export function siSdr(truth, est) {
  const s = dotMulti(truth, est) / Math.max(dotMulti(truth, truth), 1e-300);
  let n = 0, d = 0;
  for (let c = 0; c < est.length; c++) for (let i = 0; i < est[c].length; i++) {
    const t = s * truth[c][i], e = est[c][i] - t; n += t * t; d += e * e;
  }
  return db(n / d);
}

const slice = (A, a, b) => A.map((c) => c.subarray(a, b));

/**
 * museval convention: 1 s frames, 1 s hop, report the median.
 *
 * `out` is sized from `truths`, not from the module-level `STEMS`. It used to be
 * `STEMS.map(...)`, which is the one place in this file where the stem count was
 * baked in beyond the projection basis: called with six truths while `STEMS`
 * held four, it threw on `out[4].push`. Silent-frame skipping is also stricter
 * with six sources — the frame is dropped if ANY source is quiet in it — so the
 * `frames` count is reported per stem and gated by the caller. A median over
 * zero frames is NaN, which prints as "n/a" and fails nothing; see the CLI.
 */
export function framedMetrics(truths, ests, fs) {
  const T = truths[0][0].length, W = fs, out = truths.map(() => []);
  for (let t = 0; t + W <= T; t += W) {
    const tw = truths.map((s) => slice(s, t, t + W));
    let energetic = true;
    for (const s of tw) if (dotMulti(s, s) / (s.length * W) < 1e-9) energetic = false;  // skip silent frames
    if (!energetic) continue;
    for (let j = 0; j < truths.length; j++) out[j].push(bssMetrics(tw, slice(ests[j], t, t + W), j));
  }
  const med = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  return out.map((rs) => ({ SDR: med(rs.map((r) => r.SDR)), SIR: med(rs.map((r) => r.SIR)), SAR: med(rs.map((r) => r.SAR)), frames: rs.length }));
}

/** 20 ms log-energy envelope, mono-summed. */
function envelope(ch, fs, ms = 20) {
  const W = Math.round((fs * ms) / 1000), n = Math.floor(ch[0].length / W), e = new Float64Array(n);
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

const percentile = (a, p) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))] || 1e-12; };
const rand32 = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * Seam detector — the test that catches bad overlap-add without ears.
 *
 * Both statistics are normalised against a CONTROL SET of random non-boundary
 * positions in the same file, because chunk boundaries frequently land on beats
 * (hop 3.00 s at 120 BPM lands on beat 6 every time) and a naive absolute
 * threshold just measures the kick drum.
 *
 *   clickRatio : max over boundaries of [peak |second difference| within +-1 ms
 *                / p99 of the same quantity in the surrounding +-250 ms],
 *                divided by the 95th percentile of that statistic over 256
 *                random control positions.
 *                Correct OLA -> ~1.0 (measured 1.02-1.06). GATE: < 2.0
 *   jumpRatio  : same construction on the 20 ms log-energy jump. Catches
 *                "separation flicker" (a voice changing stem at the seam) even
 *                when the waveform itself is continuous.       ADVISORY ONLY
 *
 * The definitive test is still grid-offset invariance (see AUDIO.md §6.5):
 * re-run with the chunk grid shifted by H/2 and diff the two outputs.
 */
export function seamReport(ch, fs, hop, crossfade) {
  const x = ch[0], N = x.length;
  const d = new Float64Array(N);
  for (let i = 2; i < N; i++) d[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
  const env = envelope(ch, fs);
  const frame = Math.round(fs * 0.02);
  const guard = Math.round(fs * 0.001);      // +-1 ms
  const halfWin = Math.round(fs * 0.25);     // +-250 ms local baseline

  // Sample-scale spikiness: a splice is a 1-2 sample spike, a kick attack is a
  // 5 ms ramp. Normalising by the MEDIAN of a +-6 ms neighbourhood separates them.
  const clickAt = (t) => {
    if (t < halfWin + 2 || t >= N - halfWin) return null;
    let peak = 0;
    for (let i = t - guard; i <= t + guard; i++) peak = Math.max(peak, d[i]);
    const nb = [];
    for (let i = t - 256; i <= t + 256; i++) if (Math.abs(i - t) > 4) nb.push(d[i]);
    return peak / percentile(nb, 0.5);
  };
  const jumpAt = (t) => {
    const fi = Math.floor(t / frame);
    const w = Math.round(halfWin / frame);
    if (fi < w + 1 || fi >= env.length - w) return null;
    const j = Math.abs(env[fi] - env[fi - 1]);
    const nb = [];
    for (let i = fi - w; i < fi + w; i++) if (Math.abs(i - fi) > 1 && i > 0) nb.push(Math.abs(env[i] - env[i - 1]));
    return j / percentile(nb, 0.99);
  };

  const rows = [];
  for (let k = 1; k * hop < N; k++)
    for (const [label, t] of [[`${k}H`, k * hop], [`${k}H+X`, k * hop + crossfade]]) {
      const c = clickAt(t), j = jumpAt(t);
      if (c === null || j === null) continue;
      rows.push({ at: label, sample: t, seconds: +(t / fs).toFixed(3), click: +c.toFixed(2), jump: +j.toFixed(2) });
    }
  // Controls are the SAME boundary positions jittered by 5..80 ms, so they carry
  // the same musical content (same beat, same transient) but miss the seam.
  const rnd = rand32(0x5eed);
  const cc = [], cj = [];
  for (const r of rows) for (let n = 0; n < 24; n++) {
    const dt = Math.round((0.005 + 0.075 * rnd()) * fs) * (rnd() < 0.5 ? -1 : 1);
    const c = clickAt(r.sample + dt), j = jumpAt(r.sample + dt);
    if (c !== null) cc.push(c);
    if (j !== null) cj.push(j);
  }
  const nc = percentile(cc, 0.95), nj = percentile(cj, 0.95);
  const worstClick = rows.length ? Math.max(...rows.map((r) => r.click)) / nc : 0;
  const worstJump = rows.length ? Math.max(...rows.map((r) => r.jump)) / nj : 0;
  return { rows, controlClickP95: +nc.toFixed(2), controlJumpP95: +nj.toFixed(2), worstClick: +worstClick.toFixed(2), worstJump: +worstJump.toFixed(2) };
}

// ---- CLI --------------------------------------------------------------------
// A missing wav throws here, by design and per AGENTS.md: an assertion must FAIL
// when it cannot look. A basis that quietly shrinks to the files that happen to
// be on disk would report metrics for four stems and call them six.
function load(dir, name) {
  let buf;
  try { buf = readFileSync(join(dir, name + '.wav')); }
  catch { console.error(`missing ${join(dir, name + '.wav')} — the ${STEMS.length}-source basis is incomplete, so every number below would be wrong. Not scoring.`); process.exit(2); }
  const w = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { ch: w.channels, fs: w.sampleRate };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [truthDir, estDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : Number(process.argv[i + 1]); };
  if (!truthDir || !estDir) { console.error('usage: bss-eval.js <truthDir> <estDir> [--hop N] [--crossfade N] [--json]'); process.exit(2); }
  const hop = arg('hop', 132300), xf = arg('crossfade', 22050);

  const mix = load(truthDir, 'mix');
  const truths = STEMS.map((s) => load(truthDir, s).ch);
  const ests = STEMS.map((s) => load(estDir, s).ch);
  const fs = mix.fs;
  const T = Math.min(mix.ch[0].length, ...truths.map((t) => t[0].length), ...ests.map((e) => e[0].length));
  const cut = (A) => A.map((c) => c.subarray(0, T));
  const TR = truths.map(cut), ES = ests.map(cut), MX = cut(mix.ch);

  const global = STEMS.map((_, j) => ({ stem: STEMS[j], ...bssMetrics(TR, ES[j], j), 'SI-SDR': siSdr(TR[j], ES[j]) }));
  const framed = framedMetrics(TR, ES, fs);

  let num = 0, den = 0;
  for (let c = 0; c < MX.length; c++) for (let i = 0; i < T; i++) {
    let s = 0; for (const e of ES) s += e[c][i];
    const r = MX[c][i] - s; num += r * r; den += MX[c][i] * MX[c][i];
  }
  const recon = 10 * Math.log10(num / den);

  const envT = TR.map((t) => envelope(t, fs)), envE = ES.map((e) => envelope(e, fs));
  const leak = envE.map((e) => envT.map((t) => +pearson(e, t).toFixed(3)));

  const seams = STEMS.map((s, j) => ({ stem: s, ...seamReport(ES[j], fs, hop, xf) }));

  const report = { sampleRate: fs, seconds: +(T / fs).toFixed(2), global, framed, reconstructionDb: +recon.toFixed(2), leakage: leak, seams };
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  const f = (x) => (Number.isFinite(x) ? x.toFixed(2).padStart(7) : '    n/a');
  console.log(`\n${T / fs}s @ ${fs} Hz\n`);
  console.log('stem      SDR     SIR     SAR   SI-SDR |  SDR(med 1s frames)');
  global.forEach((g, j) => console.log(`${g.stem.padEnd(7)}${f(g.SDR)}${f(g.SIR)}${f(g.SAR)}${f(g['SI-SDR'])} | ${f(framed[j].SDR)}  (${framed[j].frames} frames)`));
  console.log(`\nreconstruction  20log10(||mix - sum(est)|| / ||mix||) = ${recon.toFixed(2)} dB`);
  console.log('\nleakage (rows = estimate, cols = ground truth; diagonal must dominate)');
  console.log('        ' + STEMS.map((s) => s.padStart(8)).join(''));
  leak.forEach((r, i) => console.log(STEMS[i].padEnd(8) + r.map((v) => v.toFixed(3).padStart(8)).join('')));
  // > 5 dB of 20 ms envelope range in EVERY source. Six sources now feed this
  // `every()`, so one flat stem flips the whole file from ADVISORY to GATED and
  // fires the seam gate on musical material. make-testbed.js's `checkTestbed()`
  // asserts the classification of both testbeds so that cannot happen silently.
  const dynamic = envT.every((e) => percentile(e, 0.95) - percentile(e, 0.05) > 0.5);
  console.log(`\nseams (hop=${hop}, crossfade=${xf})${dynamic ? '   [ADVISORY — musical material, see header]' : '   [GATED — stationary material]'}`);
  for (const s of seams) console.log(`  ${s.stem.padEnd(7)} clickRatio ${s.worstClick.toFixed(2).padStart(7)}   jumpRatio ${s.worstJump.toFixed(2).padStart(6)}   (control p95: click ${s.controlClickP95}, jump ${s.controlJumpP95})`);
  const fail = [];
  // The framed medians must have measured something. `framedMetrics` drops a
  // frame in which ANY source is quiet, and with six sources that condition is
  // half again as strict as it was with four — the count can reach zero, the
  // median becomes NaN, and the table prints "n/a" while the run exits 0. That
  // is a suite reporting coverage it does not have (AGENTS.md, the VOID rule),
  // so it is a failure, not a footnote.
  framed.forEach((r, j) => { if (!(r.frames > 0)) fail.push(`${STEMS[j]} framed SDR measured 0 frames — no 1 s window had all ${STEMS.length} sources energetic`); });
  if (recon > -12) fail.push(`reconstruction ${recon.toFixed(1)} dB > -12 dB`);
  if (!dynamic) for (const s of seams) if (s.worstClick > 2) fail.push(`${s.stem} seam clickRatio ${s.worstClick.toFixed(2)} > 2.0 — butt splice / broken crossfade`);
  // Skip the leakage gate on stationary material, where every envelope is flat.
  if (dynamic) leak.forEach((r, i) => { if (Math.max(...r) !== r[i]) fail.push(`${STEMS[i]} correlates more with ${STEMS[r.indexOf(Math.max(...r))]} than with itself`); });
  else console.log('\n(stationary material: leakage gate skipped, envelopes are flat)');
  console.log(fail.length ? `\nFAIL:\n  - ${fail.join('\n  - ')}` : '\nPASS');
  process.exit(fail.length ? 1 : 0);
}
