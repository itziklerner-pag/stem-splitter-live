#!/usr/bin/env node
/**
 * Independent re-derivation of the numbers the dev reports, straight from WAVs
 * on disk. Does not import their harness; only their WAV reader (byte map is
 * separately asserted in test.js).
 *
 *   node qa/compare.mjs stats  <stemDir> [mix.wav]        peak/RMS/DC/clip/seam/sum-null
 *   node qa/compare.mjs null   <dirA> <dirB>              per-stem 20log10(||A-B||/||B||)
 *   node qa/compare.mjs rms    <a.wav> <b.wav> [winMs]    windowed-RMS comparison
 *   node qa/compare.mjs smoke  [stemDir]                  the gated one — see below
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, encodeWav } from '../extension/shared/wav.js';
import { SEGMENT, STRIDE, SR, STEMS } from '../extension/shared/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => decodeWav(readFileSync(p).buffer.slice(0));
const db = (x) => 20 * Math.log10(Math.max(x, 1e-300));

function stats(dir, mixPath) {
  const stems = {};
  for (const s of STEMS) stems[s] = rd(join(dir, s + '.wav'));
  const n = stems.drums.channels[0].length;

  console.log(`\n${dir}   ${n} frames (${(n / SR).toFixed(2)} s) @ ${stems.drums.sampleRate} Hz, ` +
    `${stems.drums.bitDepth}-bit ${stems.drums.float ? 'float' : 'int'}, ${stems.drums.channels.length} ch`);

  console.log('\nstem      peak dBFS   rms dBFS        DC        clip-runs>=3   maxΔ/sample   maxΔ @seam(±10ms)');
  const boundaries = [];
  for (let b = STRIDE; b < n; b += STRIDE) boundaries.push(b);
  for (const s of STEMS) {
    const ch = stems[s].channels;
    let peak = 0, sum2 = 0, dc = 0, N = 0, clipRuns = 0, run = 0, maxD = 0, maxDs = 0;
    for (const c of ch) {
      for (let i = 0; i < c.length; i++) {
        const v = c[i], a = Math.abs(v);
        if (a > peak) peak = a;
        sum2 += v * v; dc += v; N++;
        if (a >= 1.0) { if (++run === 3) clipRuns++; } else run = 0;
        if (i) { const d = Math.abs(v - c[i - 1]); if (d > maxD) maxD = d; }
      }
      for (const b of boundaries)
        for (let i = Math.max(1, b - 441); i < Math.min(c.length, b + 441); i++) {
          const d = Math.abs(c[i] - c[i - 1]); if (d > maxDs) maxDs = d;
        }
    }
    console.log(`${s.padEnd(9)}${db(peak).toFixed(2).padStart(8)}${db(Math.sqrt(sum2 / N)).toFixed(2).padStart(11)}` +
      `${(dc / N).toExponential(2).padStart(12)}${String(clipRuns).padStart(14)}` +
      `${maxD.toFixed(4).padStart(14)}${maxDs.toFixed(4).padStart(18)}`);
  }
  console.log(`(seam window = ±10 ms around each multiple of STRIDE=${STRIDE}; ${boundaries.length} boundaries)`);

  if (mixPath && existsSync(mixPath)) {
    const mix = rd(mixPath);
    const T = Math.min(n, mix.channels[0].length);
    let num = 0, den = 0;
    for (let c = 0; c < 2; c++) {
      const M = mix.channels[c] || mix.channels[0];
      for (let i = 0; i < T; i++) {
        let s = 0; for (const st of STEMS) s += stems[st].channels[c][i];
        const d = M[i] - s; num += d * d; den += M[i] * M[i];
      }
    }
    console.log(`\nΣ${STEMS.length} stems vs mix : ${(10 * Math.log10(num / den)).toFixed(2)} dB   (SCOPE AC-2.2.d gate ≤ -18)`);
    console.log(`length vs mix   : stems ${n} frames, mix ${mix.channels[0].length} frames  -> ${n === mix.channels[0].length ? 'EXACT' : 'MISMATCH'}`);
  }
}

function nulls(a, b) {
  console.log(`\nper-stem  20log10(||${a} - ${b}|| / ||${b}||)     AUDIO.md §6.4 gate ≤ -50 dB\n`);
  let worst = -Infinity;
  for (const s of STEMS) {
    const A = rd(join(a, s + '.wav')).channels, B = rd(join(b, s + '.wav')).channels;
    const T = Math.min(A[0].length, B[0].length);
    let num = 0, den = 0, maxAbs = 0;
    for (let c = 0; c < A.length; c++) for (let i = 0; i < T; i++) {
      const d = A[c][i] - B[c][i]; num += d * d; den += B[c][i] * B[c][i];
      if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
    }
    const v = 10 * Math.log10(num / den);
    worst = Math.max(worst, v);
    console.log(`  ${s.padEnd(8)} ${v.toFixed(2).padStart(8)} dB    max |Δ| ${maxAbs.toExponential(2)}`);
  }
  console.log(`\nworst ${worst.toFixed(2)} dB  -> ${worst <= -50 ? 'PASS' : 'FAIL'} (gate -50)`);
}

function rmsCompare(pa, pb, winMs = 400) {
  const A = rd(pa), B = rd(pb);
  const W = Math.round((SR * winMs) / 1000);
  const T = Math.min(A.channels[0].length, B.channels[0].length);
  const e = (x, t) => { let s = 0, n = 0; for (const c of x.channels) for (let i = t; i < t + W; i++) { s += c[i] * c[i]; n++; } return Math.sqrt(s / n); };
  let ra = 0, rb = 0, k = 0;
  for (let t = 0; t + W <= T; t += W) { ra += e(A, t); rb += e(B, t); k++; }
  console.log(`mean ${winMs} ms-window RMS over ${k} windows:`);
  console.log(`  ${pa}: ${db(ra / k).toFixed(2)} dBFS`);
  console.log(`  ${pb}: ${db(rb / k).toFixed(2)} dBFS`);
  console.log(`  difference: ${(db(ra / k) - db(rb / k)).toFixed(2)} dB`);
}

/**
 * ============================================================ the gated one
 *
 * WHAT THIS CLAIMS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It claims: the ground-truth testbed on disk has ONE SOURCE PER `STEMS` ENTRY,
 * every source carries signal, and this file's OWN reader and summation
 * reproduce the mix from those sources to the float32 round-trip floor.
 *
 * It does NOT claim anything about separation quality. The −18 dB AC-2.2.d gate
 * is a claim about the MODEL and belongs to `tools/run-ext.mjs`, which measures
 * it through the real export path. Reusing that number here would be the wrong
 * estimator for the claim: a synthesis null has ~120 dB of headroom over it, so
 * a −18 dB gate on this entry point would pass with five of six sources
 * missing. The gate here is the float floor.
 *
 * WHY IT REGENERATES RATHER THAN VALIDATING WHAT IT FINDS. `qa/testbed/` is
 * gitignored, so it is a local artifact with no version stamp — a directory
 * built by an older `make-testbed.js` is indistinguishable from a current one
 * until you read the file count, and even then only if the SOURCE SET changed.
 * It did this time (four sources became six, and the Karplus-Strong pluck moved
 * out of `other` into `guitar`), and the stale copy was still on disk and still
 * being fed to `qa/run-qa.mjs`. Rebuilding it every run costs about a second and
 * removes the entire staleness class instead of trying to detect it.
 *
 * The round trip through the FILESYSTEM is the point: `qa/run-qa.mjs` feeds the
 * extension WAV files, not a generator's return value, so the encode/decode pair
 * is inside the thing being checked.
 *
 * IT WRITES ITS OWN DIRECTORY, NOT `qa/testbed`. First version defaulted to
 * `qa/testbed` and clobbered the documented 30 s musical fixture with an 8 s
 * one — a gate that breaks the fixture the suite it is gating depends on. 8 s is
 * four bars at 120 BPM, one full cycle of every chord, strum, arpeggio and stab,
 * which is the shortest length at which the material is itself
 * (`make-testbed.js --check` uses the same 8 s for the same reason).
 */
async function smoke(dir = join(ROOT, 'qa/testbed-smoke')) {
  let failed = 0, passed = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) passed++; else failed++;
    console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? '  ' + detail : ''}`);
  };

  // The reference generator, imported read-only. `compare.mjs`'s independence is
  // from the DEV'S HARNESS — it still may not import test.js or the extension's
  // engine — and the ground truth is not the harness.
  const { makeTestbed } = await import('../docs/snippets/make-testbed.js');
  const t = makeTestbed({ seconds: 8, bpm: 120 });
  mkdirSync(dir, { recursive: true });
  const w = (name, ch) => writeFileSync(join(dir, name + '.wav'),
    Buffer.from(encodeWav(ch, { sampleRate: SR, bitDepth: 32, float: true })));
  w('mix', t.mix);
  for (const [k, v] of Object.entries(t.stems)) w(k, v);
  console.log(`\n\x1b[1mground truth — ${Object.keys(t.stems).length} sources rebuilt into ${dir}\x1b[0m`);

  // Read them BACK OFF DISK with this file's own decoder.
  const missing = STEMS.filter((s) => !existsSync(join(dir, s + '.wav')));
  ok(`the testbed carries one source per STEMS entry (${STEMS.join(', ')})`,
    missing.length === 0 && Object.keys(t.stems).length === STEMS.length,
    missing.length ? `no wav for ${missing.join(', ')}` :
      `${Object.keys(t.stems).length} generated, ${STEMS.length} expected: ${Object.keys(t.stems).join(',')}`);
  if (missing.length) { console.log(`\n\x1b[31m${passed} passed, ${failed} failed\x1b[0m`); process.exit(1); }

  const stems = {}; for (const s of STEMS) stems[s] = rd(join(dir, s + '.wav'));
  const mix = rd(join(dir, 'mix.wav'));
  const n = mix.channels[0].length;

  // A source that is all zeros satisfies every "Σ nulls" check trivially — it
  // contributes nothing to either side. Assert presence separately, and per
  // source, so the failure names which one.
  const peaks = {};
  for (const s of STEMS) {
    let p = 0; for (const c of stems[s].channels) for (const v of c) { const a = Math.abs(v); if (a > p) p = a; }
    peaks[s] = p;
  }
  ok('every source carries signal (an all-zero source nulls perfectly and proves nothing)',
    STEMS.every((s) => peaks[s] > 1e-3),
    STEMS.map((s) => `${s} ${db(peaks[s]).toFixed(1)}`).join(' · '));
  ok('every source is the same length as the mix',
    STEMS.every((s) => stems[s].channels[0].length === n),
    STEMS.map((s) => `${s} ${stems[s].channels[0].length}`).join(' ') + ` vs mix ${n}`);

  let num = 0, den = 0;
  for (let c = 0; c < 2; c++) {
    const M = mix.channels[c] || mix.channels[0];
    for (let i = 0; i < n; i++) {
      let sm = 0; for (const s of STEMS) sm += stems[s].channels[c][i];
      const d = M[i] - sm; num += d * d; den += M[i] * M[i];
    }
  }
  const nullDb = 10 * Math.log10(num / den);
  // GATE: the float32 round-trip floor, not the separation gate. Measured
  // −144.4 dB at 30 s / −144 dB at 8 s on the six-source testbed; a single
  // missing source puts it near −3 dB, so −120 has ~24 dB of margin and cannot
  // be reached by anything except a real defect.
  ok('Σ sources reproduces the mix to the float32 floor (gate <= -120 dB; this is NOT the AC-2.2.d separation gate)',
    nullDb <= -120, `${nullDb.toFixed(2)} dB over ${(n / SR).toFixed(1)} s`);

  console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
  process.exit(failed ? 1 : 0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'stats') stats(rest[0], rest[1]);
else if (cmd === 'null') nulls(rest[0], rest[1]);
else if (cmd === 'rms') rmsCompare(rest[0], rest[1], Number(rest[2] || 400));
else if (cmd === 'smoke') await smoke(rest[0]);
else { console.error('usage: compare.mjs stats|null|rms|smoke ...'); process.exit(2); }
