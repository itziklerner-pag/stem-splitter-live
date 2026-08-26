/**
 * Runnable checks for the non-trivial DSP. No browser, no framework, no deps.
 *
 *   node test.js            # everything
 *   node test.js ola wav    # just those groups
 *
 * What is covered and why (CONTRIBUTING.md: "non-trivial logic leaves one runnable
 * check behind"):
 *
 *   window   the export window is upstream Demucs' triangular transition weight
 *   ola      weighted-overlap-add: normalised gain is exactly 1 (the WOLA
 *            equivalent of a COLA assertion), the chunk plan mirrors
 *            TensorChunk.padded/center_trim, and identity reconstruction is exact
 *   sum      all six stems summed reconstruct the mix through the whole OLA path
 *   wav      RIFF writer round-trips and matches the byte map in AUDIO.md §5.4
 *   fft      rfft agrees with a naive DFT; STFT/iSTFT round-trips
 *   ring     the SAB capture ring is lossless across wrap
 *   live     Mode 1: the causal chunk plan emits every sample exactly once, the
 *            crossfade reconstructs an identity model exactly, all twelve stem
 *            planes are sample-aligned, and the stem ring accounts for under-
 *            and overruns under a simulated slow producer
 *   mix      fader law round trip, mute/solo truth table, per-sample gain
 *            smoothing settle time, soft clipper transfer function
 *   host     the Host seam, both halves. The boot check names a missing duty
 *            and refuses a Host that is short one, the engine really runs it
 *            before it builds anything, R5's track-stop survives every failing
 *            path, and each shipped Host — offscreen/host.js, ui/host.js — is
 *            driven through the duties the typedef spells MUST: the envelope,
 *            late binding, the address filter, the MV3 response channel, the
 *            capture token, and the swallowed delivery failure
 *
 * ---------------------------------------------------------------------------
 * RENDERING vs REACHABILITY — read this before trusting an assertion here.
 *
 * A test that CONSTRUCTS the state it is testing cannot prove the production
 * path ever reaches that state. We nearly shipped `phase` with pushState()
 * rendering it perfectly and nothing assigning it: the unit test set `lp.phase`
 * by hand, so the field was null for the entire priming window and only the
 * browser caught it.
 *
 * Five groups below are rendering-only. Each is marked `RENDERING ONLY` at the
 * head, says what it cannot see, and names what covers reachability:
 *
 *   1. gain smoothing (`mix`)     reimplements the worklet's one-pole loop.
 *        reached by: run-ext.mjs measures 18.0 ms mute-to-silence in the
 *        rendered samples.
 *   2. QA-15 summing (`mix`)      reimplements the worklet's summing line.
 *        reached by: run-ext.mjs "output is EXACTLY zero for the whole kill".
 *   3. soft clip (`mix`)          `applyCurve` reimplements WaveShaper.
 *        reached by: run-ext.mjs reads `oversample` and the curve length off
 *        the live graph (4x is mandatory, AUDIO.md §4.3).
 *   4. ladder simulation (`live`) reimplements pump()'s loop, though the
 *        DECISION it drives is the real `skipFrames`.
 *        reached by: run-ext.mjs DEV_FORCE_DROP and the hop-1.0 soak.
 *   5. SAB ring producer (`ring`, `live`) mirrors capture-processor.js, which
 *        cannot be imported outside an AudioWorklet.
 *        reached by: run-ext.mjs "SAB ring filled from the AudioWorklet".
 *
 * Everything else drives production code directly and is reachable by
 * construction. When you add a test, say which kind it is.
 */

import { encodeWav, decodeWav } from './extension/shared/wav.js';
import { pipelineVersion, cacheKey, bytesForSeconds, CacheWriter, planEviction,
  videoIdFromUrl, primeRefusal, commitRefusal } from './extension/shared/stemcache.js';
import { CachedDeck, resumeSeek } from './extension/offscreen/cacheddeck.js';
// The transpose lanes' group delay, IMPORTED and never re-typed. It is a term in
// the latency assertion below, and a second copy of 3072 in this file is a second
// place for the assertion to disagree with the code it is checking.
import { PITCH_GROUP_DELAY_SAMPLES } from './extension/engine/pitch.js';
import { syncCorrection, audioClockAt } from './extension/ui/audio-math.js';
import { SEGMENT, STRIDE, SR, STEMS, RING_FRAMES } from './extension/shared/config.js';
import { RingConsumer, ringByteLength } from './extension/shared/ring.js';
import { rfft, stft, istft, hann } from './extension/engine/fft.js';
import {
  makeLivePlan, chunkPlan, makeFades, LiveEmitter, readWindow, primedPct, skipFrames, STEM_PLANES,
  PASS_PLANE_L, PASS_PLANE_R,
} from './extension/engine/live.js';
import { StemRingWriter, stemRingByteLength, PLANES, H_READ, H_PLAY } from './extension/shared/stemring.js';
import { outputTick, OUTPUT_DEAD_HOLD_SEC, OUTPUT_DEAD_HOLD_FRAMES, MIXER_SILENT_PEAK } from './extension/offscreen/live.js';
import {
  faderDb, dbToFader, dbToGain, resolveGains, passthroughGain, effectiveXfPosition, softClip, softClipCurve,
  applyCurve, smoothCoef, SILENT_DB,
  xfaderGains, xfFactor, xfStemGain, resolveDeckGains, masterTrimDb,
} from './extension/engine/mixer.js';
import { GpuScheduler, demotionDecision } from './extension/engine/scheduler.js';
import {
  LIVE_HOPS, SEAM_XFADE_LAW, STEM_RING_HEADER_BYTES, RING_PLANES, TAU,
  LIVE_CUSHION_SEC, LIVE_LOW_WATER_SEC, MARGINAL_P95_FRACTION, MARGINAL_DROP_RATE, LIVE_HOP_DEFAULT,
  HEALTH_HZ, XF_CURVES, XF_CURVE_DEFAULT, XF_CUT_EDGE, XF_TARGETS, XF_ASSIGN_DEFAULT,
  XF_POSITION_DEFAULT, DECKS, MODEL, STEM_CACHE_MAX_BYTES,
} from './extension/shared/config.js';

let pass = 0, fail = 0;
const only = process.argv.slice(2);
const group = (n) => !only.length || only.includes(n);

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
}
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/** 20*log10(||a-b|| / ||b||) */
function residualDb(a, b) {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; num += d * d; den += b[i] * b[i]; }
  if (den === 0) return num === 0 ? -Infinity : Infinity;
  return 10 * Math.log10(num / den);
}

function noise(n, seed = 1) {
  // deterministic LCG so failures are reproducible
  let s = seed >>> 0;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = (s / 4294967296) * 2 - 1; }
  return x;
}

/**
 * The worklet gain-slot map, DERIVED from STEMS rather than spelled. Slots
 * `0..STEMS.length-1` are the stems in wire order, then passthrough, then
 * master — the same expressions `offscreen/live.js` and
 * `offscreen/cacheddeck.js` compute (`G_PASS = STEMS.length`). Written once here
 * because the 4-stem suite had `4` and `5` typed into nine separate assertions,
 * and every one of them would have gone green on a build that wrote the
 * passthrough onto the guitar slot.
 */
const G_PASS = STEMS.length, G_MASTER = STEMS.length + 1;
/** Plane index of stem `k`'s L/R, the layout `(stemIdx * 2 + ch)`. */
const planeL = (k) => k * 2, planeR = (k) => k * 2 + 1;
/** One open (unmuted, unsoloed, 0 dB) channel strip per stem in `STEMS`. */
const openStrips = (db = 0) => STEMS.map(() => ({ gainDb: db, muted: false, soloed: false }));
/** Every stem assigned to the crossfader — the default matrix row. */
const XF_ALL = STEMS.map(() => 'XF');
/** Index of a stem by name, so an assertion names the stem and not a literal. */
const S_IDX = Object.fromEntries(STEMS.map((s, i) => [s, i]));

// ===========================================================================
if (group('window')) {
  head('wav — round trip + byte map (AUDIO.md §5.4)');
  const n = 5000;
  const l = noise(n, 3), r = noise(n, 4);
  // deliberately out of range: 32f export must not clip (AUDIO.md §5.3)
  l[10] = 1.7; r[11] = -1.42;

  {
    const buf = encodeWav([l, r], { sampleRate: SR, bitDepth: 32, float: true });
    const dv = new DataView(buf);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    ok('RIFF/WAVE/fmt  tags', tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ');
    ok('fmt chunk is 18 bytes (non-PCM needs cbSize)', dv.getUint32(16, true) === 18);
    ok('audioFormat = 3 (IEEE float)', dv.getUint16(20, true) === 3);
    ok('numChannels = 2', dv.getUint16(22, true) === 2);
    ok('sampleRate = 44100', dv.getUint32(24, true) === 44100);
    ok('byteRate = 352800', dv.getUint32(28, true) === 352800);
    ok('blockAlign = 8, bits = 32', dv.getUint16(32, true) === 8 && dv.getUint16(34, true) === 32);
    ok('cbSize = 0 at offset 36', dv.getUint16(36, true) === 0);
    ok('fact chunk at 38 with numFrames', tag(38) === 'fact' && dv.getUint32(46, true) === n);
    ok('data chunk at 50, size = frames*8', tag(50) === 'data' && dv.getUint32(54, true) === n * 8);
    ok('RIFF size field = fileSize - 8', dv.getUint32(4, true) === buf.byteLength - 8);

    const back = decodeWav(buf);
    ok('32f round trip is bit exact',
      back.channels[0].every((v, i) => v === l[i]) && back.channels[1].every((v, i) => v === r[i]));
    ok('32f preserves out-of-range samples (no clip, no rescale)',
      back.channels[0][10] === Math.fround(1.7) && back.channels[1][11] === Math.fround(-1.42));
    ok('decoded rate/depth/float flag', back.sampleRate === SR && back.bitDepth === 32 && back.float === true);
  }

  for (const bits of [24, 16]) {
    const clamped = [Float32Array.from(l, (v) => Math.max(-1, Math.min(0.999, v))),
                     Float32Array.from(r, (v) => Math.max(-1, Math.min(0.999, v)))];
    const buf = encodeWav(clamped, { sampleRate: SR, bitDepth: bits, float: false, dither: false });
    const dv = new DataView(buf);
    ok(`${bits}-bit: fmt 16 bytes, format 1, no fact`,
      dv.getUint32(16, true) === 16 && dv.getUint16(20, true) === 1 &&
      String.fromCharCode(dv.getUint8(36), dv.getUint8(37), dv.getUint8(38), dv.getUint8(39)) === 'data');
    const back = decodeWav(buf);
    const lsb = 1 / (1 << (bits - 1));
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(back.channels[0][i] - clamped[0][i]));
    ok(`${bits}-bit round trip within 1 LSB`, worst <= lsb, `worst ${(worst / lsb).toFixed(2)} LSB`);
  }

  {
    // the exported length must equal the source length exactly (AUDIO.md §5.3)
    const buf = encodeWav([new Float32Array(7), new Float32Array(7)], { sampleRate: SR });
    ok('numFrames survives an odd short buffer', decodeWav(buf).channels[0].length === 7);
  }
}

// ===========================================================================
if (group('fft')) {
  head('fft — rfft vs naive DFT, and STFT/iSTFT round trip');
  {
    const N = 256;
    const x = noise(N, 5);
    const re = new Float32Array(N / 2 + 1), im = new Float32Array(N / 2 + 1);
    rfft(x, 0, N, re, im, 0, 1);
    let worst = 0, mag = 0;
    for (let k = 0; k <= N / 2; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < N; t++) { const a = -2 * Math.PI * k * t / N; sr += x[t] * Math.cos(a); si += x[t] * Math.sin(a); }
      worst = Math.max(worst, Math.hypot(re[k] - sr, im[k] - si));
      mag = Math.max(mag, Math.hypot(sr, si));
    }
    ok('rfft matches a naive DFT', worst / mag < 1e-6, `max rel err ${(worst / mag).toExponential(2)}`);
  }
  {
    // the pipeline's actual configuration
    const nfft = 4096, hop = 1024, frames = 40;
    const n = (frames - 1) * hop + nfft;
    const x = noise(n, 6);
    const S = stft(x, nfft, hop);
    const y = istft(S.real, S.imag, S.numFrames, S.numBins, nfft, hop, n);
    // window-sum normalisation only reconstructs the fully-overlapped interior
    const a = nfft, b = n - nfft;
    const db = residualDb(y.subarray(a, b), x.subarray(a, b));
    ok(`STFT->iSTFT interior residual ${db.toFixed(1)} dB (gate < -100)`, db < -100);
    ok('periodic Hann (w[0] === 0, no duplicate endpoint)',
      hann(8)[0] === 0 && Math.abs(hann(8)[4] - 1) < 1e-12);
  }
}

// ===========================================================================
if (group('ring')) {
  head('ring — SAB capture ring is lossless across wrap');
  // RENDERING ONLY on the producer side: capture-processor.js cannot be imported
  // outside an AudioWorklet, so the writer here mirrors it.
  // Reached by: run-ext.mjs "SAB ring filled from the AudioWorklet, no drops".
  if (typeof SharedArrayBuffer !== 'function') {
    ok('SharedArrayBuffer available', false, 'not in this node build');
  } else {
    const CAP = 1 << 12;
    const sab = new SharedArrayBuffer(ringByteLength(CAP));
    const ring = new RingConsumer(sab, CAP);
    // Mirrors the write loop in offscreen/capture-processor.js (which cannot be
    // imported here: it needs AudioWorkletGlobalScope).
    const hdr = new Int32Array(sab, 0, 16);
    const pl = new Float32Array(sab, 64, CAP);
    const pr = new Float32Array(sab, 64 + CAP * 4, CAP);
    const produce = (block) => {
      const w = Atomics.load(hdr, 0);
      for (let i = 0; i < block.length; i++) {
        const idx = (w + i) & (CAP - 1);
        pl[idx] = block[i]; pr[idx] = -block[i];
      }
      Atomics.store(hdr, 0, w + block.length);
    };

    const total = CAP * 5 + 377;      // several wraps, not a multiple of capacity
    const src = noise(total, 9);
    const got = [];
    let produced = 0;
    while (produced < total) {
      const n = Math.min(128, total - produced);
      produce(src.subarray(produced, produced + n));
      produced += n;
      if (produced % 1024 === 0) { const d = ring.drain(); if (d) got.push(d); }
    }
    const d = ring.drain(); if (d) got.push(d);

    const outL = new Float32Array(total); let o = 0, dropped = 0;
    for (const g of got) { outL.set(g.l, o); o += g.l.length; dropped += g.dropped; }
    ok('every produced frame came back, in order', o === total && dropped === 0 &&
      outL.every((v, i) => v === src[i]), `${o}/${total} frames, ${dropped} dropped`);

    ok('R (mono up-mix path) is independent of L',
      got[0].r[0] === -src[0]);

    // overflow must be reported, not silently swallowed
    const sab2 = new SharedArrayBuffer(ringByteLength(CAP));
    const ring2 = new RingConsumer(sab2, CAP);
    const hdr2 = new Int32Array(sab2, 0, 16);
    Atomics.store(hdr2, 0, CAP * 2 + 5);           // producer lapped us twice
    const d2 = ring2.drain();
    ok('an overrun is reported as `dropped`', d2 && d2.dropped === CAP + 5 && d2.l.length === CAP,
      `dropped ${d2 && d2.dropped}`);

    ok('default ring holds 23.7 s at 44.1 kHz', Math.abs(RING_FRAMES / SR - 23.78) < 0.05,
      `${(RING_FRAMES / SR).toFixed(2)} s`);
  }
}

// ===========================================================================
if (group('live')) {
  head('live — causal chunk plan (spike/FINDINGS.md §5)');

  for (const hop of LIVE_HOPS) {
    const p = makeLivePlan(hop);
    // every published frame, exactly once, no gaps, no double-emit
    const nChunks = 40;
    const seen = new Int32Array(chunkPlan(nChunks - 1, p).emitTo);
    let bad = '';
    let cursor = 0;
    for (let k = 0; k < nChunks; k++) {
      const c = chunkPlan(k, p);
      if (c.emitFrom !== cursor) { bad = `chunk ${k} starts at ${c.emitFrom}, expected ${cursor}`; break; }
      for (let i = c.emitFrom; i < c.emitTo; i++) seen[i]++;
      cursor = c.emitTo;
      if (c.emitLen !== (k === 0 ? p.H - p.X : p.H)) { bad = `chunk ${k} emits ${c.emitLen}`; break; }
      if (c.srcOffset < 0 || c.srcOffset + c.emitLen > p.L) { bad = `chunk ${k} reads outside the model output`; break; }
      if (c.inputEnd - c.inputStart !== p.L) { bad = `chunk ${k} window is not ${p.L}`; break; }
      // CAUSAL: the window must never need a sample later than its own end.
      if (c.emitTo > c.inputEnd) { bad = `chunk ${k} emits past its input (lookahead!)`; break; }
    }
    const once = !bad && seen.every((v) => v === 1);
    ok(`hop ${hop}s: ${nChunks} chunks, every output sample emitted exactly once, no lookahead`,
      once, bad || `H=${p.H} X=${p.X} srcOffset=${p.srcOffset}`);
  }

  {
    const p = makeLivePlan(1.95);
    ok('the model window is always the full 343980 samples (a short one costs the same — AUDIO.md §2.1)',
      chunkPlan(0, p).inputEnd - chunkPlan(0, p).inputStart === SEGMENT &&
      chunkPlan(99, p).inputEnd - chunkPlan(99, p).inputStart === SEGMENT);
    ok('startup zero-pads: chunk 0 looks back before frame 0',
      chunkPlan(0, p).inputStart < 0, `${(chunkPlan(0, p).inputStart / SR).toFixed(2)} s of silence as left context`);
    const firstReal = Math.ceil(SEGMENT / p.H) - 1;
    ok(`the window is fully real audio from chunk ${firstReal} on (${(SEGMENT / SR).toFixed(2)} s)`,
      chunkPlan(firstReal, p).inputStart >= 0 && chunkPlan(firstReal - 1, p).inputStart < 0);
    ok('primedPct ramps 0 -> 1 over one segment',
      primedPct(0) === 0 && Math.abs(primedPct(SEGMENT / 2) - 0.5) < 1e-9 && primedPct(SEGMENT * 2) === 1);
    ok('latency is hop + xfade + T_inf, no lookahead term',
      p.L - p.srcOffset - p.H === p.X, `hop ${(p.H / SR).toFixed(2)}s + xfade ${(p.X / SR).toFixed(3)}s`);
  }

  head('live — crossfade laws');
  {
    const n = makeLivePlan(1.95).X;
    const ep = makeFades(n, 'equalPower');
    let worstP = 0;
    for (let i = 0; i < n; i++) worstP = Math.max(worstP, Math.abs(ep.fi[i] * ep.fi[i] + ep.fo[i] * ep.fo[i] - 1));
    ok('equal-power crossfade sums to unity POWER across the join', worstP < 1e-6,
      `max |fi²+fo²-1| = ${worstP.toExponential(2)}`);

    const li = makeFades(n, 'linear');
    let worstA = 0, coherentEP = 0;
    for (let i = 0; i < n; i++) {
      worstA = Math.max(worstA, Math.abs(li.fi[i] + li.fo[i] - 1));
      coherentEP = Math.max(coherentEP, ep.fi[i] + ep.fo[i]);
    }
    ok('linear crossfade sums to unity AMPLITUDE across the join', worstA < 1e-6,
      `max |fi+fo-1| = ${worstA.toExponential(2)}`);
    // The two chunks at a join are two estimates of the SAME audio (corr ~0.99,
    // FINDINGS §5) — coherent, so they add in amplitude, not in power.
    ok('equal-power on coherent material puts a level bump in every join',
      Math.abs(20 * Math.log10(coherentEP) - 3.01) < 0.05,
      `+${(20 * Math.log10(coherentEP)).toFixed(2)} dB at the midpoint — this is why the default law is 'linear'`);
    ok('the shipped default is the coherent-correct law', SEAM_XFADE_LAW === 'linear', SEAM_XFADE_LAW);
    ok('fades are half-sample centred (no step at either end)',
      li.fo[n - 1] < 1 / n && li.fi[0] < 1 / n && li.fi[0] > 0);
  }

  head('live — identity model reconstructs the input exactly through the joins');
  // AUDIO.md §2.6: "the strongest test available" — replace the model with the
  // identity and require the pipeline to return its input. Isolates the DSP from
  // the model completely, and is exactly the test that fails on a butt splice.
  for (const law of ['linear', 'equalPower']) {
    for (const hop of [1.0, 1.95, 3.9]) {
      const p = makeLivePlan(hop);
      const em = new LiveEmitter(p, law);
      const nChunks = 8;
      const total = chunkPlan(nChunks - 1, p).emitTo;
      const x = noise(total + SEGMENT, 21);
      const out = new Float32Array(total);
      const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT));
      const zero = new Float32Array(p.H);
      for (let k = 0; k < nChunks; k++) {
        const c = chunkPlan(k, p);
        // the "model" is the identity: hand back exactly the window it was given
        for (let q = 0; q < STEM_PLANES; q++) {
          for (let i = 0; i < SEGMENT; i++) {
            const t = c.inputStart + i;
            src[q][i] = t < 0 ? 0 : x[t];
          }
        }
        const e = em.chunk(k, src, zero, zero);
        out.set(e.planes[0].subarray(0, e.len), e.from);
      }
      const db = residualDb(out, x.subarray(0, total));
      if (law === 'linear') {
        ok(`linear, hop ${hop}s: identity residual ${db === -Infinity ? '-inf' : db.toFixed(1)} dB (gate < -120)`, db < -120);
      } else {
        ok(`equalPower, hop ${hop}s: identity residual ${db.toFixed(1)} dB — the join bump, measured`, db > -60,
          'recorded so the choice of law is a number, not an opinion');
      }
    }
  }

  head('live — all twelve stem planes are sample-aligned (Δ must be 0, AUDIO.md §8.1)');
  {
    const p = makeLivePlan(1.95);
    const em = new LiveEmitter(p, 'linear');
    const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT));
    const zero = new Float32Array(p.H);
    const hitAt = [];
    for (let k = 0; k < 4; k++) {
      const c = chunkPlan(k, p);
      // one impulse per plane, at the SAME absolute frame, with a per-plane
      // amplitude so a swapped plane is also caught
      const impulseAbs = c.emitFrom + (k === 0 ? 1000 : p.X + 1000);
      for (let q = 0; q < STEM_PLANES; q++) {
        src[q].fill(0);
        src[q][impulseAbs - c.inputStart] = q + 1;
      }
      const e = em.chunk(k, src, zero, zero);
      const at = [];
      for (let q = 0; q < STEM_PLANES; q++) {
        let idx = -1, amp = 0;
        for (let i = 0; i < e.len; i++) if (Math.abs(e.planes[q][i]) > 1e-6) { idx = i; amp = e.planes[q][i]; break; }
        at.push({ idx: idx + e.from, amp });
      }
      hitAt.push(at);
      const aligned = at.every((v) => v.idx === at[0].idx && v.idx === impulseAbs);
      const ordered = at.every((v, q) => Math.abs(v.amp - (q + 1)) < 1e-6);
      ok(`chunk ${k}: Δ = ${Math.max(...at.map((v) => v.idx)) - Math.min(...at.map((v) => v.idx))} across all ${STEM_PLANES} planes, no plane swap`,
        aligned && ordered, `at absolute ${at[0].idx}`);
    }
    ok('a 4-sample skew would comb at 5.5 kHz — this is why it is asserted, not eyeballed',
      hitAt.length === 4);
    // FAIL WHEN IT CANNOT LOOK: the loop above is `for q < STEM_PLANES`, so an
    // emitter that published only the old eight planes would have passed every
    // row of it by never being asked about guitar or piano. Pin the width.
    ok('...and the alignment was checked across TWELVE planes, not the old eight',
      STEM_PLANES === STEMS.length * 2 && STEM_PLANES === 12 &&
      hitAt.every((at) => at.length === STEM_PLANES),
      `${STEM_PLANES} planes x ${hitAt.length} chunks`);
  }

  head('live — backpressure: a skipped chunk becomes passthrough, never silence');
  {
    const p = makeLivePlan(1.95);
    const em = new LiveEmitter(p, 'linear');
    const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT).fill(0.5));
    const mix = new Float32Array(p.H).fill(0.25);
    em.chunk(0, src, mix, mix);
    const g = em.gap(p.H, mix, mix);
    // Every L plane the listener could be hearing: the six stem Ls plus the
    // passthrough L. Spelled from STEMS so it cannot go on summing four.
    const audibleL = [...STEMS.map((_, k) => planeL(k)), PASS_PLANE_L];
    let silent = 0;
    for (let i = 0; i < g.len; i++) {
      let sum = 0;
      for (const q of audibleL) sum += g.planes[q][i];
      if (Math.abs(sum) < 1e-9) silent++;
    }
    ok('a skipped span carries the original mix on the passthrough plane, not silence',
      silent === 0 && Math.abs(g.planes[PASS_PLANE_L][g.len - 1] - 0.25) < 1e-6,
      `${silent} silent frames of ${g.len}, summed over ${audibleL.length} L planes`);
    ok('the stems fade out and the passthrough fades in over exactly one crossfade',
      Math.abs(g.planes[PASS_PLANE_L][0] - 0.25 * (0.5 / p.X)) < 1e-4 && g.planes[0][p.X] === 0,
      'linear (the mix and Σstems are the same signal, so they add coherently)');
    /**
     * THE ASSERTION THAT CATCHES THE PASSTHROUGH STAYING AT 8/9, and it is the
     * reason this one is worth its own line rather than being folded into the
     * span sum above. Planes 8-11 are guitar.L/R and piano.L/R now; they were
     * `pass.L/pass.R` at four stems. An emitter that still writes the
     * unseparated mix at 8/9 publishes a span that sums correctly, plays at the
     * right level, and quietly routes the whole mix through the GUITAR fader —
     * so the user's guitar kill deletes the passthrough and their guitar
     * control rides the whole track. Every other assertion in this block passes
     * on that build. (Folded in from TRACK A's isolation suite, which had no
     * permanent home.)
     */
    const steady = g.len - 1;                  // past the entry crossfade
    const newStemPlanes = [planeL(S_IDX.guitar), planeR(S_IDX.guitar),
                           planeL(S_IDX.piano), planeR(S_IDX.piano)];
    ok('gap(): guitar and piano (planes 8-11) are SILENT — the mix went to 12/13, not onto a stem',
      newStemPlanes.every((q) => g.planes[q][steady] === 0),
      `[${newStemPlanes.join(',')}] = ${newStemPlanes.map((q) => g.planes[q][steady]).join(' ')}`);
    ok('gap(): every one of the twelve stem planes is silent in the steady part of the span',
      Array.from({ length: STEM_PLANES }, (_, q) => g.planes[q][steady]).every((v) => v === 0));
    ok('gap(): the unseparated mix is on 12/13, and those are the planes shared/stemring.js calls pass.L/pass.R',
      Math.abs(g.planes[PASS_PLANE_L][steady] - 0.25) < 1e-6 &&
      Math.abs(g.planes[PASS_PLANE_R][steady] - 0.25) < 1e-6 &&
      PASS_PLANE_L === PLANES.indexOf('pass.L') && PASS_PLANE_R === PLANES.indexOf('pass.R') &&
      PASS_PLANE_L === 12,
      `${PASS_PLANE_L}/${PASS_PLANE_R} vs stemring ${PLANES.indexOf('pass.L')}/${PLANES.indexOf('pass.R')}`);
    const back = em.chunk(2, src, mix, mix);
    ok('the next real chunk fades the stems back in and the passthrough out',
      Math.abs(back.planes[0][0]) < 0.5 && Math.abs(back.planes[0][p.X] - 0.5) < 1e-6 &&
      back.planes[PASS_PLANE_L][p.X] === 0 && back.planes[PASS_PLANE_L][0] > 0);
    ok('no gap and no overlap across the skip',
      em.commit === chunkPlan(2, p).emitTo, `commit ${em.commit}`);
  }

  head('live — stem ring accounting under a slow producer');
  if (typeof SharedArrayBuffer !== 'function') {
    ok('SharedArrayBuffer available', false, 'not in this node build');
  } else {
    const CAP = 1 << 13;
    const w = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(CAP)), CAP);
    ok('fourteen planes, one write pointer — alignment is structural',
      PLANES.length === RING_PLANES && RING_PLANES === STEMS.length * 2 + 2 && RING_PLANES === 14,
      `${PLANES.length} named, ${RING_PLANES} derived`);
    ok('header is 128 bytes / 32 Int32 slots, matching playback-processor.js',
      STEM_RING_HEADER_BYTES === 128);

    const blk = Array.from({ length: RING_PLANES }, (_, q) => new Float32Array(1000).fill(q + 1));
    // consumer is the playback worklet: it only ever advances H_READ
    const consume = (n) => { Atomics.store(w.hdr, H_READ, w.readFrames() + n); };
    let written = 0, refused = 0;
    for (let i = 0; i < 40; i++) {
      if (w.write(written, blk, 1000)) written += 1000; else refused++;
      if (i % 2 === 0) consume(1000);        // consumer drains at half the rate
    }
    ok('an overrun is refused and counted, never a torn write',
      refused > 0 && w.overruns === refused && w.cushion() <= CAP,
      `${refused} refused, cushion ${w.cushion()}/${CAP}`);
    ok('write() rejects a non-contiguous span (the alignment guard)',
      (() => { try { w.write(written + 1, blk, 10); return false; } catch { return true; } })());
    /**
     * ...and it rejects a SHORT PLANE ARRAY, which is the six-stem widening
     * arriving half-done. A ten-plane write from a caller that was not updated
     * leaves guitar.L/R and piano.L/R holding whatever the previous lap wrote —
     * stale audio, correct pointers, nothing to say so. Refusal is the only
     * behaviour that surfaces it. (Folded in from TRACK A's isolation suite.)
     */
    let shortWrite = '';
    try { w.write(w.writeFrames(), blk.slice(0, 10), 10); } catch (e) { shortWrite = e.message; }
    ok('write() REFUSES a 10-plane write rather than leaving guitar/piano stale',
      new RegExp(`expected ${RING_PLANES} planes, got 10`).test(shortWrite),
      shortWrite || '(did not throw)');
    ok('the ring never reports a negative cushion', w.cushion() >= 0);
    ok('play flag defaults to hold-silence until the cushion is primed',
      (() => { const w2 = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(1024)), 1024);
               const before = w2.playing(); w2.play(true); return before === false && w2.playing() === true; })());
    ok('reset() re-zeroes both pointers and the play flag',
      (() => { w.reset(); return w.writeFrames() === 0 && w.readFrames() === 0 &&
               Atomics.load(w.hdr, H_PLAY) === 0; })());
  }

  head('live — the backpressure ladder against a simulated clock');
  // RENDERING ONLY for the loop; the DECISION is the real skipFrames.
  // Reached by: run-ext.mjs DEV_FORCE_DROP and the hop-1.0 soak.
  /**
   * Drives the real decision function (engine/live.js::skipFrames) and the real
   * schedule arithmetic through a virtual sample clock, with inference times
   * drawn from a reproducible distribution. This is the check the browser soak
   * cannot give us: the browser only exercises whatever T_inf the GPU happened
   * to produce on the day, and the interesting cases are the ones where it is
   * slow.
   *
   * The invariant, from docs/ARCHITECTURE.md §3.8: the playback worklet never
   * runs dry, and a chunk we cannot deliver becomes unseparated audio — never
   * silence, never an ever-growing latency.
   */
  function simulate({ hop, inferMs, jitterMs, seconds, seed = 5 }) {
    const p = makeLivePlan(hop);
    const Q = 128, TICK = 4096;
    const lowWater = Math.round(LIVE_LOW_WATER_SEC * SR);
    let rnd = seed >>> 0;
    const tinf = () => {
      rnd = (rnd * 1664525 + 1013904223) >>> 0;
      return Math.round(((inferMs + (rnd / 4294967296 * 2 - 1) * jitterMs) / 1000) * SR);
    };
    let k = 0, commit = 0, write = 0, read = 0, drops = 0, underruns = 0, playing = false;
    let armAt = -1, inFlight = null, minCushion = Infinity, maxLatency = 0, discarded = 0;
    const emitted = new Map();                 // span start -> length, for the coverage check

    const publish = (from, len) => {
      if (from !== commit) throw new Error(`non-contiguous publish at ${from}, expected ${commit}`);
      if (from < write) throw new Error('rewrote frames the consumer may have read');
      emitted.set(from, len);
      commit += len; write += len;
    };
    const pump = (t) => {
      for (;;) {
        const n = skipFrames({ cap: t, commit, plan: p, k, playing, cushion: write - read, lowWater });
        if (n === 0) break;
        publish(commit, n); k++; drops++;
        // mirrors LivePipeline.fill(): a passthrough span can arm playback too,
        // otherwise a pipeline that is overloaded from the first chunk never starts
        if (armAt < 0) armAt = t + p.X + Math.round(LIVE_CUSHION_SEC * SR);
      }
      if (inFlight) return;
      const c = chunkPlan(k, p);
      if (t < c.inputEnd) return;
      inFlight = { c, doneAt: t + tinf() };
    };

    for (let t = 0; t < seconds * SR; t += Q) {
      if (inFlight && t >= inFlight.doneAt) {
        const c = inFlight.c;
        inFlight = null;
        k = Math.max(k, c.k + 1);
        if (c.emitTo <= commit) discarded++;                 // the ladder beat it to the span
        else { publish(c.emitFrom, c.emitLen); if (c.k === 0) armAt = t + p.X + Math.round(LIVE_CUSHION_SEC * SR); }
        pump(t);
      }
      if (!playing && armAt >= 0 && t >= armAt) playing = true;
      if (playing) {
        if (write - read < Q) { underruns++; }
        else { read += Q; minCushion = Math.min(minCushion, write - read); maxLatency = Math.max(maxLatency, t - read); }
      }
      if (t % TICK === 0) pump(t);
    }
    // coverage: every published frame exactly once, no gaps
    let cursor = 0, gaps = 0;
    for (const from of [...emitted.keys()].sort((a, b) => a - b)) {
      if (from !== cursor) gaps++;
      cursor = from + emitted.get(from);
    }
    return { p, drops, discarded, underruns, gaps, commit, cursor,
             minCushionSec: minCushion / SR, maxLatencySec: maxLatency / SR,
             rtf: inferMs / 1000 / hop };
  }

  for (const c of [
    { hop: 1.95, inferMs: 875, jitterMs: 120, label: 'hop 1.95 s, T_inf 875±120 ms (the measured M2 Max case)' },
    { hop: 1.00, inferMs: 810, jitterMs: 280, label: 'hop 1.00 s, T_inf 810±280 ms — marginal, RTF 0.81' },
    { hop: 3.90, inferMs: 900, jitterMs: 200, label: 'hop 3.90 s, T_inf 900±200 ms — lots of margin' },
  ]) {
    const r = simulate({ ...c, seconds: 180 });
    ok(`${c.label}: 0 underruns, output contiguous`,
      r.underruns === 0 && r.gaps === 0 && r.cursor === r.commit,
      `drops ${r.drops} · min cushion ${r.minCushionSec.toFixed(3)} s · latency ${r.maxLatencySec.toFixed(2)} s`);
  }
  {
    // Overload: inference cannot keep up at all. The ladder must convert that
    // into passthrough, hold the latency flat, and STILL never starve.
    const r = simulate({ hop: 1.0, inferMs: 1500, jitterMs: 100, seconds: 180 });
    ok('overload (RTF 1.5): drops happen, latency stays bounded, still 0 underruns and no gaps',
      r.drops > 0 && r.underruns === 0 && r.gaps === 0 && r.maxLatencySec < 3,
      `${r.drops} chunks -> passthrough, ${r.discarded} discarded in flight, latency ${r.maxLatencySec.toFixed(2)} s, min cushion ${r.minCushionSec.toFixed(3)} s`);
    const r2 = simulate({ hop: 1.0, inferMs: 4000, jitterMs: 100, seconds: 180 });
    ok('catastrophic overload (RTF 4.0): degrades to mostly-passthrough, never to silence',
      r2.underruns === 0 && r2.gaps === 0 && r2.drops > 100 && r2.maxLatencySec < 3,
      `${r2.drops} of ~180 chunks -> passthrough, latency ${r2.maxLatencySec.toFixed(2)} s`);
  }
  {
    // The `starving` trigger specifically: with only the `behind` trigger the
    // measured hop-1.0 case underran on real hardware (22 ms of silence in 35 s).
    const withStarve = simulate({ hop: 1.0, inferMs: 950, jitterMs: 90, seconds: 180 });
    ok('the cushion trigger is what saves the marginal case (RTF 0.95)',
      withStarve.underruns === 0 && withStarve.drops > 0,
      `${withStarve.drops} passthrough spans, min cushion ${withStarve.minCushionSec.toFixed(3)} s`);
  }

  head('live — a stop during inference must not poison the pipeline');
  if (typeof SharedArrayBuffer !== 'function' || typeof structuredClone !== 'function') {
    ok('SharedArrayBuffer + structuredClone available', false, 'not in this node build');
  } else {
    /**
     * The model buffers are TRANSFERRED to the inference worker, so they are
     * detached on this side the moment `infer` is called. A `LIVE_STOP` that
     * landed between the await and the reclaim used to leave them detached for
     * the life of the pipeline: every later session threw "Cannot perform
     * Construct on a detached ArrayBuffer" on the first line of runChunk, once
     * per capture tick, forever. The run was 100 % silent and reported drops
     * rather than an outage. This drives the real LivePipeline against a fake
     * worker that detaches exactly the way postMessage does.
     */
    const { LivePipeline } = await import('./extension/offscreen/live.js');
    const { StemRingWriter, stemRingByteLength } = await import('./extension/shared/stemring.js');
    const { STEM_RING_FRAMES } = await import('./extension/shared/config.js');

    const CAP = 1 << 17;
    const capSab = new SharedArrayBuffer(ringByteLength(CAP));
    const capRing = new RingConsumer(capSab, CAP);
    const sent = [];
    let detachOnly = false;

    const mount = () => {
      let lp;
      lp = new LivePipeline({
        ctx: () => null, ring: () => capRing,
        infer: async (mixBuf, outBuf) => {
          // exactly postMessage-with-transferables: the originals detach here
          const mix = structuredClone(mixBuf, { transfer: [mixBuf] });
          const stems = structuredClone(outBuf, { transfer: [outBuf] });
          await Promise.resolve();
          if (detachOnly) throw new Error('worker died holding the buffers');
          return { mix, stems, prepMs: 0, inferMs: 0, postMs: 0 };
        },
        ensureModel: async () => {}, send: (m) => sent.push(m), log: () => {},
        // See the CachedDeck stub above: the deps bundle `offscreen/deck.js`
        // hands a LivePipeline now carries the Host's asset resolver.
        assetUrl: (relPath) => `stub://unit/${relPath}`,
        // Mode 3: the master bus is SHARED, so the deck borrows it. The stub
        // returns whatever `lp.probeBuf`/`lp.probe` were mocked with, which is
        // what the watchdog tests drive.
        master: () => ({
          busPeak: () => {
            if (!lp || !lp.probe) return null;
            lp.probe.getFloatTimeDomainData(lp.probeBuf);
            let p = 0;
            for (let i = 0; i < lp.probeBuf.length; i++) { const a = Math.abs(lp.probeBuf[i]); if (a > p) p = a; }
            return p;
          },
          probeState: () => ({ built: true }),
          probeTerminal: () => ({ terminalIsDestination: true, why: 'edge present' }),
          input: () => null,
          pre: null, shaper: null, post: null, probe: null,
        }),
      });
      lp.plan = makeLivePlan(1.95);
      lp.emitter = new LiveEmitter(lp.plan, 'linear');
      lp.passL = new Float32Array(lp.plan.H);
      lp.passR = new Float32Array(lp.plan.H);
      lp.lowWaterFrames = Math.round(LIVE_LOW_WATER_SEC * SR);
      lp.out = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(STEM_RING_FRAMES)), STEM_RING_FRAMES);
      lp.baseFrame = 0; lp.stopped = false; lp.status = 'running';
      return lp;
    };
    const quiesce = (lp) => { clearTimeout(lp.startTimer); clearInterval(lp.pushTimer); };

    {
      const lp = mount();
      // stop lands while the chunk is in flight — the exact poisoning sequence
      const realInfer = lp.d.infer;
      lp.d.infer = async (a, b) => { const r = await realInfer(a, b); lp.stopped = true; return r; };
      await lp.runChunk(chunkPlan(0, lp.plan));
      quiesce(lp);
      // The model output buffer is STEMS.length x 2ch x SEGMENT floats: 16 511 040 B
      // at six stems, was 11 007 360 B at four. Derived, so a pipeline that
      // reallocated at the old width is a red here rather than a truncated stem.
      ok('a stop mid-inference reclaims both transferred buffers',
        lp.mixBuf.byteLength === 2 * SEGMENT * 4 && lp.outBuf.byteLength === STEMS.length * 2 * SEGMENT * 4,
        `mixBuf ${lp.mixBuf.byteLength} B, outBuf ${lp.outBuf.byteLength} B of ${STEMS.length * 2 * SEGMENT * 4} (0 = detached)`);
      ok('and clears inFlight, so a restart is not wedged', lp.inFlight === false);
      // the restart is what actually broke: prove it runs
      lp.stopped = false;
      let threw = null;
      try { await lp.runChunk(chunkPlan(1, lp.plan)); } catch (e) { threw = e; }
      quiesce(lp);
      ok('the next chunk after a mid-inference stop runs (this is the reported bug)',
        threw === null, threw ? String(threw.message) : 'ok');
    }

    {
      // a worker that dies holding the buffers must also leave us usable
      const lp = mount();
      detachOnly = true;
      let threw = null;
      try { await lp.runChunk(chunkPlan(0, lp.plan)); } catch (e) { threw = e; }
      detachOnly = false;
      quiesce(lp);
      ok('a rejected inference reallocates rather than leaving detached buffers',
        threw !== null && lp.mixBuf.byteLength === 2 * SEGMENT * 4 &&
        lp.outBuf.byteLength === STEMS.length * 2 * SEGMENT * 4,
        `threw "${threw && threw.message}", mixBuf ${lp.mixBuf.byteLength} B, outBuf ${lp.outBuf.byteLength} B`);
      let threw2 = null;
      try { await lp.runChunk(chunkPlan(0, lp.plan)); } catch (e) { threw2 = e; }
      quiesce(lp);
      ok('and the pipeline recovers on the next chunk', threw2 === null, threw2 ? String(threw2.message) : 'ok');
    }

    head('live — a silenced passthrough span is still COUNTED (QA-15 requirement 2)');
    {
      const lp = mount();
      // fill the capture ring so the ladder has history to publish
      const hdr = new Int32Array(capSab, 0, 16);
      const pl = new Float32Array(capSab, 64, CAP), pr = new Float32Array(capSab, 64 + CAP * 4, CAP);
      for (let i = 0; i < CAP; i++) { pl[i] = 0.5; pr[i] = -0.5; }
      Atomics.store(hdr, 0, CAP);
      const sentGains = [];
      lp.node = { port: { postMessage: (m) => sentGains.push(m) } };
      lp.mix = STEMS.map(() => ({ gainDb: 0, muted: true, soloed: false }));
      lp.pushGains(0.003);
      const passMsg = sentGains.find((m) => m.i === G_PASS);
      // The slot map moved 4/5 -> 6/7 with the two new stems. A build that still
      // wrote the passthrough at slot 4 would be writing it onto GUITAR.
      ok(`pushGains writes every stem slot 0..${STEMS.length - 1} AND the passthrough slot ${G_PASS}`,
        STEMS.every((_, k) => sentGains.some((m) => m.i === k)) && !!passMsg,
        sentGains.map((m) => m.i).join(','));
      ok('and sends 0 for it when everything is killed', passMsg && passMsg.value === 0, `${passMsg && passMsg.value}`);
      ok(`slot ${G_PASS} is ramped like the rest — no click at the passthrough boundary`,
        passMsg && passMsg.tau === 0.003, `tau ${passMsg && passMsg.tau}`);
      const before = lp.drops;
      const fired = lp.forceDrop();
      quiesce(lp);
      ok('a passthrough span the user will hear as SILENCE still increments drops',
        fired && lp.drops === before + 1,
        `drops ${before} -> ${lp.drops}; silence the user did not ask for must never be invisible`);
      // QA-17 class: values the console would otherwise have to infer
      ok('the span is recorded so `passthroughNow` is a fact, not a guess',
        lp.passSpans.length === 1 && lp.passSpans[0].to > lp.passSpans[0].from,
        JSON.stringify(lp.passSpans[0]));
      lp.out.play(true);
      Atomics.store(lp.out.hdr, 1, lp.passSpans[0].from + 10);
      ok('passthroughNow is true while the playhead is inside a skipped span', lp.passthroughNow());
      Atomics.store(lp.out.hdr, 1, lp.passSpans[0].to + 10);
      ok('and false once past it', !lp.passthroughNow());
      lp.out.play(false);
    }

    head('live — the output watchdog: "green and silent" has to be self-reporting');
    {
      /**
       * Three times this project has shipped a build that was 100 % green and
       * 100 % silent, because every gate reads the SAB ring or the playback
       * worklet and both sit UPSTREAM of the break. watchOutput() is the engine
       * noticing on its own. It is also the exact kind of detector that quietly
       * stops working, so it is pinned in both directions: it must fire on the
       * two failures it is for, and it must stay silent on a healthy deck, on a
       * deliberately killed one, and on a deck that is not playing at all.
       */
      const alarms = (lp) => sent.filter((m) => m.type === 'LIVE_ERROR' &&
        (m.code === 'OUTPUT_STALLED' || m.code === 'OUTPUT_SILENT'));
      /**
       * `stemPeak` was NOT a parameter here at four stems: the frame spelled the
       * four names with every stem at 0 and only `master` varying. That is now
       * two separate problems. `outputTick` reads a frame that is short a stem as
       * `blind`, so a four-name frame makes the THIRD arm fire on cases named
       * "a healthy deck raises nothing" — and because `alarms()` filters to
       * STALLED/SILENT, it would fire invisibly. And an all-zero stem row is not
       * what "healthy" means anyway. So the frame is built from STEMS and the
       * stem row is set explicitly per case.
       */
      const mountWatch = ({ busPeak, masterPeak, stemPeak = 0, healthAgeMs, playing = true }) => {
        sent.length = 0;
        const lp = mount();
        lp.out.play(playing);
        lp.probe = { getFloatTimeDomainData: (a) => { a.fill(0); a[3] = busPeak; } };
        lp.probeBuf = new Float32Array(2048);
        const peak = { master: masterPeak };
        for (const s of STEMS) peak[s] = stemPeak;
        lp.lastMeters = { peak, rms: {}, clip: false };
        lp.lastHealthAt = performance.now() - healthAgeMs;
        return lp;
      };
      /** every LIVE_ERROR, so a third-arm alarm cannot hide behind the filter above */
      const anyAlarm = () => sent.filter((m) => m.type === 'LIVE_ERROR').map((m) => m.code);

      {
        // the audio render thread stopped being pulled at all
        const lp = mountWatch({ busPeak: 0.4, masterPeak: 0.4, healthAgeMs: 3000 });
        lp.watchOutput();
        quiesce(lp);
        const a = alarms(lp);
        ok('no `health` from the worklet for 2 s raises OUTPUT_STALLED',
          a.length === 1 && a[0].code === 'OUTPUT_STALLED', a.map((x) => x.code).join(',') || 'nothing');
        ok('and it names the context state, so the paste is actionable',
          a.length === 1 && /Context state/.test(a[0].message), a[0] && a[0].message.slice(0, 60));
        const n = sent.length;
        lp.watchOutput(); lp.watchOutput();
        quiesce(lp);
        ok('the alarm is latched — one message, not one per health tick', sent.length === n);
      }
      {
        // the mixer is summing signal but nothing survives to the last node
        const lp = mountWatch({ busPeak: 0, masterPeak: 0.5, stemPeak: 0.3, healthAgeMs: 0 });
        for (let i = 0; i < HEALTH_HZ - 1; i++) lp.watchOutput();
        quiesce(lp);
        ok('one second of disagreement is required before crying wolf', alarms(lp).length === 0,
          `${lp.silentTicks} ticks so far`);
        lp.watchOutput();
        quiesce(lp);
        const a = alarms(lp);
        ok('a bus at digital zero while the meters show signal raises OUTPUT_SILENT',
          a.length === 1 && a[0].code === 'OUTPUT_SILENT', a.map((x) => x.code).join(',') || 'nothing');
      }
      {
        // A killed deck is silent ON PURPOSE. The meters are post-fader, so they
        // read 0 too — which is precisely why the test is meters-vs-bus and not
        // bus-vs-zero. Firing here would put a red banner on every panic button.
        const lp = mountWatch({ busPeak: 0, masterPeak: 0, healthAgeMs: 0 });
        for (let i = 0; i < 3 * HEALTH_HZ; i++) lp.watchOutput();
        quiesce(lp);
        ok('a deliberately killed deck does NOT raise OUTPUT_SILENT', alarms(lp).length === 0,
          alarms(lp).map((x) => x.code).join(','));
      }
      {
        // A healthy deck has signal ON ITS STEMS, not just on master. Asserted
        // against EVERY LIVE_ERROR rather than the two filtered codes: the third
        // arm (OUTPUT_DEAD) reads a short or all-zero stem row as blind/dead, so
        // the filter would have hidden exactly the regression this row is for.
        const lp = mountWatch({ busPeak: 0.4, masterPeak: 0.4, stemPeak: 0.3, healthAgeMs: 0 });
        for (let i = 0; i < 3 * HEALTH_HZ; i++) lp.watchOutput();
        quiesce(lp);
        ok('a healthy deck raises nothing at all — not STALLED, not SILENT, not DEAD',
          anyAlarm().length === 0, anyAlarm().join(',') || 'nothing');
      }
      {
        // Before playback arms there is no output to be missing, and the worklet
        // has not started posting health either. Both detectors must hold off.
        const lp = mountWatch({ busPeak: 0, masterPeak: 0.5, healthAgeMs: 9000, playing: false });
        for (let i = 0; i < 3 * HEALTH_HZ; i++) lp.watchOutput();
        quiesce(lp);
        ok('a deck that has not armed yet raises nothing', alarms(lp).length === 0,
          alarms(lp).map((x) => x.code).join(','));
      }
    }

    head('live — the wire payloads are constructible (cheap guard, expensive to find in a browser)');
    {
      /**
       * Both of these are built from ~20 fields each and go out over
       * chrome.runtime, which is JSON-serialised. A stale identifier in either
       * throws inside the handler, the message never arrives, and the symptom is
       * a Playwright timeout six minutes into an e2e run with no stack. Ask for
       * them here instead, in 3 ms. (This exists because `rtfMarginal:
       * RTF_MARGINAL` outlived the constant it referenced.)
       */
      const lp = mount();
      lp.plan = makeLivePlan(1.95);
      lp.chunkMs = [800, 810, 820];
      let st = null, threw = null;
      try { st = lp.stats(); } catch (e) { threw = e; }
      ok('stats() is constructible', threw === null, threw ? String(threw.message) : '');
      ok('and JSON round-trips (it crosses chrome.runtime)',
        st !== null && JSON.parse(JSON.stringify(st)).hopSeconds === 1.95);

      sent.length = 0;
      let threw2 = null;
      try { lp.pushState(true); } catch (e) { threw2 = e; }
      quiesce(lp);
      ok('pushState() is constructible', threw2 === null, threw2 ? String(threw2.message) : '');
      const msg = sent.find((m) => m.type === 'LIVE_STATE');
      const CONTRACT = ['status', 'phase', 'hopSec', 'pendingHopSec', 'latencySec', 'passthroughNow',
        'bufferMinSec', 'bufferSec', 'floorSec', 'targetSec', 'rtf', 'drops',
        'underruns', 'overruns', 'staleReads', 'primedPct'];
      ok('LIVE_STATE carries every field the console contract promises',
        msg && CONTRACT.every((k) => k in msg),
        msg ? `missing: ${CONTRACT.filter((k) => !(k in msg)).join(',') || 'none'}` : 'no LIVE_STATE sent');
      ok('every LIVE_STATE value is JSON-safe (no undefined, no NaN)',
        msg && CONTRACT.every((k) => msg[k] === null || (typeof msg[k] !== 'undefined' && !Number.isNaN(msg[k]))),
        msg ? JSON.stringify(Object.fromEntries(CONTRACT.map((k) => [k, msg[k]]))) : '');
      ok('hopSec reports the RUNNING hop and pendingHopSec the requested one (QA-17)',
        msg && msg.hopSec === 1.95 && msg.pendingHopSec === LIVE_HOP_DEFAULT,
        msg ? `running ${msg.hopSec}, pending ${msg.pendingHopSec}` : '');
      // `priming` covers two completely different waits; the console must not
      // have to correlate two message streams to know which bar to draw.
      ok('phase is null unless priming', msg && msg.phase === null, `status ${msg && msg.status}`);
      // An idle deck must not report the LAST session's hop. REACHABLE: drives
      // the real stop().
      lp.status = 'running'; sent.length = 0;
      await lp.stop(); quiesce(lp);
      const idle = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
      ok('hopSec is null once the deck is idle (not the last session\'s hop)',
        idle && idle.hopSec === null && idle.status === 'idle',
        idle ? `hopSec ${idle.hopSec}, status ${idle.status}` : 'no LIVE_STATE on stop');
      ok('pendingHopSec survives a stop, so the next start is predictable',
        idle && idle.pendingHopSec === LIVE_HOP_DEFAULT, `${idle && idle.pendingHopSec}`);
      ok('and pushState after stop does not throw on the null plan',
        (() => { try { lp.pushState(true); return true; } catch { return false; } })());
      lp.plan = makeLivePlan(1.95); lp.status = 'running';   // restore for later checks
      lp.status = 'priming'; lp.phase = 'model'; sent.length = 0; lp.pushState(true); quiesce(lp);
      ok("phase is 'model' while the weights are loading",
        sent.find((m) => m.type === 'LIVE_STATE').phase === 'model');
      lp.phase = 'ring'; sent.length = 0; lp.pushState(true); quiesce(lp);
      ok("phase is 'ring' once the model is up and the causal window is filling",
        sent.find((m) => m.type === 'LIVE_STATE').phase === 'ring');

      // ...and that start() actually SETS it. Rendering the field correctly is
      // worth nothing if nothing assigns it: the first cut of this shipped with
      // pushState() perfect and the two assignments missing, so `phase` was null
      // for the entire priming window and only the browser run caught it.
      const lp2 = mount();
      // stand in for build(), which needs an AudioWorklet
      lp2.build = async () => {};
      lp2.node = { port: { postMessage: () => {} } };
      const seen = [];
      lp2.d.ensureModel = async () => { seen.push(lp2.phase); };
      lp2.status = 'idle';
      sent.length = 0;
      await lp2.start();
      quiesce(lp2);
      ok("start() sets phase 'model' before it waits on the weights", seen[0] === 'model', `${seen[0]}`);
      ok("start() sets phase 'ring' before building the graph", lp2.phase === 'ring', `${lp2.phase}`);
      const primingMsgs = sent.filter((m) => m.type === 'LIVE_STATE' && m.status === 'priming');
      ok('and both priming phases actually reach the wire',
        primingMsgs.map((m) => m.phase).join(',') === 'model,ring',
        primingMsgs.map((m) => m.phase).join(',') || 'none');
    }

    /**
     * REACHABLE, and that is the whole reason this block exists rather than more
     * assertions inside `extension/engine/bpmtap.js`. That file proves the
     * DETECTOR — it builds its own StemRingWriter and drives the tap by hand.
     * Nothing in it can see whether `offscreen/live.js` ever calls `tick()`, hands
     * it THIS deck's ring, puts the payload on the wire, or resets it when the
     * track changes. Every assertion below drives the real `LivePipeline` through
     * `pushState()` and `start()` and reads what actually went out on `send`.
     *
     * The tempo tap has no browser-only dependency (it is main-thread arithmetic
     * over a SharedArrayBuffer), so this tier can carry the whole integration.
     */
    head('live — the tempo tap: driven by the heartbeat, on the wire, reset by the lifecycle');
    {
      const { BPM_TAP_PLANE_L, BPM_TAP_PLANE_R, BPM_MAX_BLOCKS_PER_TICK, beatPhaseAt } =
        await import('./extension/engine/bpmtap.js');
      const { KEY_ACCUM_HZ } = await import('./extension/shared/config.js');
      const BPM_ACCUM_HZ = 10;   // live.js's own constant; the assertions below bracket it

      // ---- a drum kit, not a tone. Same synthesis as bpmtap.js's suite.
      const kick = (buf, at, amp) => {
        const n = Math.round(0.12 * SR);
        for (let i = 0; i < n; i++) {
          const t = i / SR, j = at + i;
          if (j >= 0 && j < buf.length) buf[j] += amp * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.045);
        }
      };
      const clickTrain = (bpm, sec) => {
        const buf = new Float32Array(Math.round(sec * SR));
        const beat = 60 / bpm * SR;
        for (let b = 0; b * beat < buf.length; b++) kick(buf, Math.round(b * beat), 1.0);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / peak;
        return buf;
      };

      const HOP = Math.round(1.95 * SR);
      /**
       * Feed a real deck exactly as the pump does — one hop published into the
       * deck's OWN stem ring, then the heartbeat run across the 1.95 s it spends
       * on the next one — and return the last LIVE_STATE that actually went out.
       *
       * Rolling `bpmAt` back ONE PERIOD before each push is deliberate and is NOT
       * the thing under test: it opens the wall-clock gate so a synchronous burst
       * delivers the 20 blocks a real 1.95 s of wall time would. The gate itself
       * is bracketed separately below, by count, at its own entry point.
       *
       * IT IS `now - period`, NOT `0`, AND THAT COST A RED. `performance.now()`
       * in node is milliseconds since PROCESS START, so `bpmAt = 0` asks "is the
       * process older than 95 ms?" — and `node test.js live` reaches this block at
       * about 30 ms. Some pushes were refused, the estimate schedule shifted, and
       * the lock assertion went red on unmodified code; adding one `console.log`
       * above it made it pass. A harness that reads an absolute clock is measuring
       * the machine exactly as hard as a gate that does (AGENTS.md, "if a claim
       * can be carried by a COUNT, do not carry it with a stopwatch"). Relative to
       * `now`, the gate opens on every push whatever the uptime.
       *
       * `keyTap.tick` is stubbed out for cost only — 260 heartbeats x up to four
       * 16384-point FFTs is a second of CPU for a detector that has its own suite
       * and nothing to do with this claim.
       */
      const driveDeck = (pcm, planeL, planeR) => {
        const lp = mount();
        lp.keyTap.tick = () => 0;
        const planes = Array.from({ length: PLANES.length }, () => new Float32Array(HOP));
        sent.length = 0;
        for (let p = 0; p + HOP <= pcm.length; p += HOP) {
          // a plausible playhead, so write() never refuses as an overrun
          Atomics.store(lp.out.hdr, H_READ, Math.max(0, p - 4 * SR));
          for (let q = 0; q < PLANES.length; q++) planes[q].fill(0, 0, HOP);
          for (let i = 0; i < HOP; i++) { const v = pcm[p + i]; planes[planeL][i] = v; planes[planeR][i] = v; }
          lp.out.write(p, planes, HOP);
          for (let t = 0; t < 20; t++) { lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ; lp.pushState(true); }
        }
        quiesce(lp);
        return { lp, last: sent.filter((m) => m.type === 'LIVE_STATE').at(-1) };
      };

      // ================================================ the cadence, as a COUNT
      /**
       * THE ENTRY POINT IS `pushState()`, which is both the 10 Hz timer and the
       * half-dozen forced pushes. Carried by counts of `tick()` calls, never by a
       * stopwatch: AGENTS.md, "a gate whose verdict changes on code that did not
       * change is measuring the machine".
       *
       * The two rows BRACKET the rate rather than restate it. Roll the clock back
       * one whole period and the tap must be fed; roll it back HALF a period and
       * it must not. A tap given its own 20 Hz driver passes the first and fails
       * the second; a tap at 5 Hz fails the first. Both are run against the key
       * tap in the same loop, so "the same heartbeat as tickKey" is the compared
       * quantity and not an assumption.
       */
      {
        const lp = mount();
        let bpmTicks = 0, keyTicks = 0;
        lp.bpmTap.tick = () => { bpmTicks++; return 0; };
        lp.keyTap.tick = () => { keyTicks++; return 0; };
        const N = 20;

        // (a) a burst of forced pushes inside ONE gate window feeds each tap once.
        // `now - period`, never 0 — see driveDeck's note: `performance.now()` is
        // uptime here, so `0` asks a question about the process, not the gate.
        sent.length = 0;
        lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        lp.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) lp.pushState(true);
        const burstMs = performance.now() - t0;
        quiesce(lp);
        ok(`${N} forced pushState() calls inside one gate window feed the tempo tap ONCE — exactly like the key tap`,
          bpmTicks === 1 && keyTicks === 1,
          `bpm ${bpmTicks}, key ${keyTicks}; burst took ${burstMs.toFixed(2)} ms against a ` +
          `${(1000 / BPM_ACCUM_HZ - 5).toFixed(0)} ms gate (${(( 1000 / BPM_ACCUM_HZ - 5) / Math.max(burstMs, 1e-6)).toFixed(0)}x margin)`);

        // (b) one whole period later, each push feeds each tap again: N pushes, N blocks
        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
          lp.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
          lp.pushState(true);
        }
        quiesce(lp);
        ok('a full period after the last block the tap is fed again — 20 heartbeats, 20 blocks, on both taps',
          bpmTicks === N && keyTicks === N, `bpm ${bpmTicks}/${N}, key ${keyTicks}/${N}`);

        // (c) HALF a period is refused. This is the row a faster gate breaks.
        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ / 2;
          lp.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ / 2;
          lp.pushState(true);
        }
        quiesce(lp);
        ok('half a period after the last block it is refused — the tap is on the 10 Hz heartbeat and not on a driver of its own',
          bpmTicks === 0 && keyTicks === 0,
          `bpm ${bpmTicks}, key ${keyTicks} over ${N} pushes at ${(1000 / BPM_ACCUM_HZ / 2).toFixed(0)} ms spacing ` +
          `(a 20 Hz gate would let ${N} through here and still pass the row above)`);

        // ...and it stops with the deck, because pushState(true) does not.
        bpmTicks = 0;
        lp.status = 'idle';
        lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        lp.pushState(true);
        quiesce(lp);
        ok('an idle deck is not fed at all (pushState still runs — the tap must decline, not the heartbeat)',
          bpmTicks === 0, `${bpmTicks} blocks while idle`);
      }

      // ============================================ the payload, on a real ring
      const CONTRACT = ['state', 'bpm', 'confidence', 'beatFrame'];
      const TOL = 1.5;   // bpmtap.js's own tolerance: one 0.25 lag step at the fast end
      const a128 = driveDeck(clickTrain(128, 26), BPM_TAP_PLANE_L, BPM_TAP_PLANE_R);
      const b92 = driveDeck(clickTrain(92, 26), BPM_TAP_PLANE_L, BPM_TAP_PLANE_R);

      ok('LIVE_STATE carries `bpm`, and it is the four-field contract with a state the UI can switch on',
        !!a128.last && !!a128.last.bpm && CONTRACT.every((k) => k in a128.last.bpm) &&
        ['none', 'listening', 'locked', 'fault'].includes(a128.last.bpm.state),
        a128.last ? JSON.stringify(a128.last.bpm) : `no LIVE_STATE in ${sent.length} messages`);
      {
        // LIVE_STATE crosses chrome.runtime, which is JSON. `undefined` and NaN
        // both survive the assertion above and neither survives the wire.
        const round = a128.last ? JSON.parse(JSON.stringify(a128.last)) : null;
        ok('...and it JSON round-trips unchanged (no undefined, no NaN, no bigint)',
          !!round && JSON.stringify(round.bpm) === JSON.stringify(a128.last.bpm) &&
          CONTRACT.every((k) => round.bpm[k] === null || !Number.isNaN(round.bpm[k])),
          round ? JSON.stringify(round.bpm) : 'nothing to round-trip');
      }

      // THE HYPOTHESIS: the wire number comes from THIS deck's drums planes.
      ok('a 128 BPM drum stem locks, and the number reaches the wire',
        !!a128.last && a128.last.bpm.state === 'locked' &&
        Math.abs(a128.last.bpm.bpm - 128) <= TOL,
        a128.last ? `read ${a128.last.bpm.bpm} against 128.00, tol ±${TOL}, conf ${a128.last.bpm.confidence}` : 'no LIVE_STATE');
      /**
       * THE CONTROL, AND IT CAN LOSE. A `bpm` field wired to a constant, to a
       * stale echo, or to some other deck's tap passes the row above and fails
       * this one — the two decks are driven through identical code and differ
       * only in the audio published into their own rings.
       */
      ok('a second deck at 92 BPM reports 92, so the wire value tracks the deck\'s own ring and not the harness',
        !!b92.last && b92.last.bpm.state === 'locked' &&
        Math.abs(b92.last.bpm.bpm - 92) <= TOL &&
        Math.abs((a128.last.bpm.bpm - b92.last.bpm.bpm) - 36) <= 2 * TOL,
        b92.last ? `128 - 92 = 36.00 true, ${a128.last.bpm.bpm} - ${b92.last.bpm.bpm} = ${(a128.last.bpm.bpm - b92.last.bpm.bpm).toFixed(2)} read` : 'no LIVE_STATE');
      /**
       * THE TAP POINT, and this control can lose too. The identical stimulus on
       * `other` (planes 4/5, the KEY tap's planes) must produce no tempo at all.
       * A wiring that handed BpmTap the wrong ring, the passthrough planes, or a
       * mono mix would pass one of these two rows and fail the other; there is no
       * wiring that passes both except the right one.
       */
      {
        const wrong = driveDeck(clickTrain(128, 26), 4, 5);
        ok('the same drums published on the `other` planes produce NO tempo — the tap is on drums, on this deck\'s stem ring',
          !!wrong.last && wrong.last.bpm.state === 'none' && wrong.last.bpm.bpm === null &&
          wrong.lp.bpmTap.stats().audibleBlocks === 0 && wrong.lp.bpmTap.stats().blocks > 100,
          wrong.last ? `${JSON.stringify(wrong.last.bpm)} after ${wrong.lp.bpmTap.stats().blocks} blocks read, ${wrong.lp.bpmTap.stats().audibleBlocks} audible`
            : 'no LIVE_STATE');
      }
      // The consumer's only entry point into `beatFrame`, driven off the wire
      // value rather than off the tap, because the wire is what the UI gets.
      ok('beatPhaseAt() reads the wire payload straight: 0 on the beat, 0.5 half a beat later',
        (() => {
          const p = a128.last && a128.last.bpm;
          if (!p || p.beatFrame === null) return false;
          const period = 60 / p.bpm * SR;
          return beatPhaseAt(p, p.beatFrame, SR) === 0 &&
            Math.abs(beatPhaseAt(p, p.beatFrame + period / 2, SR) - 0.5) < 0.01;
        })(),
        a128.last ? `beatFrame ${a128.last.bpm.beatFrame}` : 'no payload');

      /**
       * THE PLAYHEAD THE PHASE IS MEASURED AGAINST. ENTRY POINT: `pushState()`,
       * the same publisher every row above reads — `a128.last` is the last
       * LIVE_STATE the 128 BPM run actually put on the wire.
       *
       * IT IS THE OUTPUT RING'S *READ* COUNTER: what the audio device has
       * consumed, on the axis `bpm.beatFrame` is on. Not the write head, not a
       * track position.
       *
       * THE CONTROL CAN LOSE. `driveDeck` parks the read head four seconds behind
       * the producer and then writes one more hop, so the two counters are seconds
       * apart on this run — a `playFrames` wired to `writeFrames()` passes every
       * "the field is present and finite" test and fails this one. The separation
       * is reported so a run where the two heads converged would be visible rather
       * than silently trivial.
       */
      ok('LIVE_STATE.playFrames is the deck output ring\'s READ counter, not its write head',
        !!a128.last && a128.last.playFrames === a128.lp.out.readFrames()
          && a128.last.playFrames !== a128.lp.out.writeFrames(),
        a128.last
          ? `wire ${a128.last.playFrames}, readFrames() ${a128.lp.out.readFrames()}, ` +
            `writeFrames() ${a128.lp.out.writeFrames()}, heads ` +
            `${((a128.lp.out.writeFrames() - a128.lp.out.readFrames()) / SR).toFixed(2)} s apart`
          : 'no LIVE_STATE');

      /**
       * ...AND THE PAIR COMPOSES INTO A PHASE. ENTRY POINT: `beatPhaseAt(payload,
       * frame, sr)` fed the way `embed.js::beatFrameNow()` feeds it — the wire
       * playhead advanced by the age of its own timestamp. Asserting the two
       * fields are merely PRESENT is not asserting the pulse can run, so this row
       * runs the composition and reads a phase back.
       *
       * `atMs` IS A `Date.now()`-SCALE WALL CLOCK, and that is the claim. The
       * offscreen document and the page have different `performance` time origins,
       * so their `performance.now()` values cannot be differenced; the epoch is the
       * one clock they share. The bound is deliberately loose — a
       * `performance.now()`-scale value is process uptime and misses an epoch bound
       * by decades, while any real publish lag clears it. A tight bound here would
       * be a stopwatch claim wearing this row's name, and AGENTS.md says a
       * stopwatch measures the machine.
       */
      {
        const AGE_BOUND_SEC = 60;
        const m = a128.last;
        const ageSec = m ? (Date.now() - Number(m.atMs)) / 1000 : NaN;
        const frame = m ? Number(m.playFrames) + ageSec * SR : NaN;
        const phase = m ? beatPhaseAt(m.bpm, frame, SR) : null;
        ok('the (playFrames, atMs) pair composes into a real beat phase — one wall clock, one frame axis',
          !!m && Number.isFinite(ageSec) && ageSec >= 0 && ageSec < AGE_BOUND_SEC
            && Number.isFinite(frame) && typeof phase === 'number' && phase >= 0 && phase < 1,
          m ? `atMs age ${ageSec.toFixed(3)} s against a ${AGE_BOUND_SEC} s clock-scale bound, ` +
              `frame ${m.playFrames} advanced to ${frame.toFixed(0)}, phase ${phase}`
            : 'no LIVE_STATE');
      }

      /**
       * AND IT MUST FAIL WHEN IT CANNOT LOOK. ENTRY POINT: `pushState(true)` on a
       * deck with no output ring — the state every deck is in before it arms.
       *
       * ABSENT, NEVER ZEROED. Frame 0 is a real position the ring takes at the
       * start of every run, and `embed.js::beatFrameNow()` discriminates on
       * `Number.isFinite`, so a zeroed field would light the pulse against a
       * playhead nobody sampled. `atMs` is asserted finite in the same row because
       * "the message went out at all" is what makes the missing field evidence of
       * a decision rather than of a dropped publish.
       */
      {
        const lp = mount();
        lp.out = null;
        lp.status = 'ready';
        sent.length = 0;
        lp.pushState(true);
        quiesce(lp);
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a deck with no output ring OMITS playFrames — absent, never zeroed — and still timestamps the message',
          !!m && !('playFrames' in m) && Number.isFinite(m.atMs)
            && !Number.isFinite(Number(m.playFrames)),
          m ? `playhead keys on the wire ${JSON.stringify(Object.keys(m).filter((k) => /play/i.test(k)))}, ` +
              `Number(m.playFrames) ${String(Number(m.playFrames))}, atMs ${m.atMs}`
            : `no LIVE_STATE in ${sent.length} messages`);
      }

      // The bound that keeps this off the hop's deadline is a COUNT, and it is the
      // one the "run it unconditionally, on every deck, with no flag" decision
      // rests on. Read off the real run, not a fresh tap.
      ok('the whole run never consumed more than the per-tick block cap, however far the producer jumped ahead',
        a128.lp.bpmTap.stats().blocks > 100 && a128.lp.bpmTap.lastTickBlocks <= BPM_MAX_BLOCKS_PER_TICK,
        `${a128.lp.bpmTap.stats().blocks} blocks over ${a128.lp.bpmTap.stats().estimates} estimates, ` +
        `last tick ${a128.lp.bpmTap.lastTickBlocks} against a cap of ${BPM_MAX_BLOCKS_PER_TICK}`);

      // ==================================================== the lifecycle reset
      /**
       * A BPM HELD OVER FROM THE PREVIOUS TRACK IS A WRONG READOUT, NOT A STALE
       * ONE — and the mechanism is nastier than "we forgot to call reset". A new
       * session puts the ring's write pointer back to 0, which is BELOW the tap's
       * cursor; `w - cursor` is then negative, the catch-up threshold never
       * fires, every block is refused as `early`, and no `envBreak` is recorded.
       * The tap goes on reporting the old tempo forever with clean-looking stats.
       *
       * REACHABLE: this drives the real `start()`, not `bpmTap.reset()`. An
       * implementation with the reset line deleted passes every row above.
       */
      {
        const lp = a128.lp;
        const before = lp.bpmPayload();
        const cursorBefore = lp.bpmTap.cursor;
        const writeBefore = lp.out.writeFrames();
        lp.build = async () => {};                       // needs an AudioWorklet
        lp.node = { port: { postMessage: () => {} } };
        lp.d.ensureModel = async () => {};
        lp.status = 'idle';
        sent.length = 0;
        await lp.start();
        /**
         * THE HEARTBEAT AFTER start() RETURNS, not the last message start() sent.
         * `start()` pushes twice from inside the priming ramp (`phase:'model'`,
         * then `phase:'ring'`) and BOTH of those are emitted before the detector
         * resets a dozen lines later, so the wire legitimately still carries the
         * old session's tempo while the weights load. The claim here is about the
         * new session, so it is read from the new session's first heartbeat.
         * (That priming-window carry-over is shared with `key`, whose reset sits
         * on the same line, and it is reported rather than asserted here.)
         */
        lp.pushState(true);
        quiesce(lp);
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        ok('start() puts the write pointer BEHIND the tap\'s cursor — the state the silent-hold failure needs',
          writeBefore > 0 && cursorBefore > 0 && lp.out.writeFrames() < cursorBefore,
          `write ${writeBefore} -> ${lp.out.writeFrames()}, cursor was ${cursorBefore}`);
        /**
         * `cursor` is NOT asserted null: the heartbeat above re-anchors it on the
         * new ring, and that RE-ANCHORING is the property that matters. Left at
         * the old session's 1.1 M it would sit permanently ahead of a write
         * pointer that restarts at 0, every block would be refused as `early`,
         * and the tap would hold the old tempo forever with clean-looking stats.
         * So the assertion is that it came back BELOW where it was, not that it
         * is unset — an implementation that resets the envelope and leaks the
         * cursor passes `filled === 0` and fails here.
         */
        ok('...and start() drops the locked tempo with it: a new session reports `none`, not the last track\'s BPM',
          before.state === 'locked' && !!after && after.bpm.state === 'none' &&
          after.bpm.bpm === null && after.bpm.beatFrame === null &&
          lp.bpmTap.stats().filled === 0 && lp.bpmTap.stats().cursor < cursorBefore,
          `${before.state} ${before.bpm} -> ${after ? after.bpm.state + ' ' + after.bpm.bpm : 'NO LIVE_STATE'}, ` +
          `${lp.bpmTap.stats().filled} envelope samples, cursor ${cursorBefore} -> ${lp.bpmTap.stats().cursor}`);
      }

      // ============================================== a fault is REPORTED state
      /**
       * The detector runs inside the 10 Hz heartbeat, so it may not throw into
       * it — and "degrades to no estimate" and "silently does nothing" are the
       * same wire value unless the failure is NAMED. That is the whole content of
       * these rows: not that the throw was caught, but that catching it is
       * visible from outside.
       *
       * TWO ENTRY POINTS, TWO ASSERTIONS. `tick()` is caught in `tickBpm()` and
       * `payload()` is caught in `bpmPayload()`; a guard on one is not a guard on
       * the other, and AGENTS.md's entry-point rule exists because this repo has
       * had five defects from exactly that.
       */
      {
        const lp = mount();
        const logs = [];
        lp.d.log = (s) => logs.push(s);
        const healthy = lp.bpmPayload();
        lp.bpmTap.tick = () => { throw new Error('synthetic tick fault'); };
        sent.length = 0;
        lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        let threw = null;
        try { lp.pushState(true); } catch (e) { threw = e; }
        quiesce(lp);
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a tap that throws in tick() does not take pushState() down',
          threw === null, threw ? String(threw.message) : 'pushState returned normally');
        ok('...and the fault is on the wire as its own state, carrying the message and the count',
          !!m && m.bpm.state === 'fault' && m.bpm.bpm === null &&
          /synthetic tick fault/.test(String(m.bpm.fault)) && m.bpm.faults === 1,
          m ? JSON.stringify(m.bpm) : 'no LIVE_STATE sent');
        /**
         * THE POINT OF THE FIFTH STATE, and the row that would go red if someone
         * "simplified" the fault branch to return `none`. A broken detector and a
         * detector that has heard nothing must not be the same wire value — that
         * is a feature reporting success for the same reason a vacuous assertion
         * does.
         */
        ok('...and a FAULTED tap is distinguishable on the wire from one that has simply heard nothing',
          healthy.state === 'none' && !!m && m.bpm.state !== healthy.state && !('fault' in healthy),
          `healthy ${JSON.stringify(healthy)} vs faulted ${m ? JSON.stringify(m.bpm) : 'n/a'}`);
        // Latched: off for the session, one log line, and the counter does not
        // run away at 10 Hz for the life of the deck.
        sent.length = 0;
        for (let i = 0; i < 10; i++) { lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ; lp.pushState(true); }
        quiesce(lp);
        const m2 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('the fault latches the tap off — 10 more heartbeats, still one throw, still one log line, still reported',
          !!m2 && m2.bpm.state === 'fault' && m2.bpm.faults === 1 && lp.bpmFaults === 1 &&
          logs.filter((s) => /tempo tap faulted/.test(s)).length === 1,
          `faults ${lp.bpmFaults}, ${logs.filter((s) => /tempo tap faulted/.test(s)).length} log line(s)`);
        // ...and the next session clears it, or a transient fault would be
        // unclearable without reloading the offscreen document.
        lp.bpmTap.tick = () => 0;
        lp.build = async () => {};
        lp.node = { port: { postMessage: () => {} } };
        lp.d.ensureModel = async () => {};
        lp.status = 'idle';
        sent.length = 0;
        await lp.start();
        lp.pushState(true);            // the new session's first heartbeat — see above
        quiesce(lp);
        const m3 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('and start() clears it, so a transient fault does not need a document reload',
          !!m3 && m3.bpm.state === 'none' && lp.bpmFault === null && lp.bpmFaults === 0,
          m3 ? `${JSON.stringify(m3.bpm)}, fault ${lp.bpmFault}` : 'no LIVE_STATE');
      }
      {
        // The OTHER entry point. Same claim, different guard.
        const lp = mount();
        lp.d.log = () => {};
        lp.bpmTap.payload = () => { throw new Error('synthetic payload fault'); };
        sent.length = 0;
        let threw = null;
        try { lp.pushState(true); } catch (e) { threw = e; }
        quiesce(lp);
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a tap that throws in payload() does not take pushState() down either, and reports the same way',
          threw === null && !!m && m.bpm.state === 'fault' &&
          /synthetic payload fault/.test(String(m.bpm.fault)),
          threw ? String(threw.message) : m ? JSON.stringify(m.bpm) : 'no LIVE_STATE');
        // stats() is the harness surface and is built from the same helper, so it
        // must survive the same fault — a DIAG paste that throws is a DIAG paste
        // nobody gets.
        let threw2 = null, st = null;
        try { st = lp.stats(); } catch (e) { threw2 = e; }
        ok('...and stats() still builds, with the fault visible in it',
          threw2 === null && !!st && st.bpm.state === 'fault' && st.bpmFaults >= 1,
          threw2 ? String(threw2.message) : st ? `bpmFaults ${st.bpmFaults}` : 'no stats');
      }
    }

    head('live — hop viability is about the SPREAD of T_inf, not its mean');
    {
      /**
       * The case that killed the mean test, measured on an M2 Max over a cold
       * 300 s soak: hop 1.0 runs at RTF 0.8906 — comfortably under 1.0 — and
       * still misses 138 of 305 deadlines, because median chunk time oscillates
       * 753..1002 ms across a 1000 ms deadline with no trend. An RTF>0.85 gate
       * sits silent through exactly the failure it exists to catch.
       */
      const feed = (lp, series) => { lp.chunkMs = series.slice(-32); lp.k = series.length; };
      // The measured M2 Max distribution sits at RTF 0.8906, which the old
      // RTF>0.85 gate caught — but only just, and by luck of where the mean
      // landed. A machine 6 % faster has the SAME 45 % miss rate and slips under
      // the gate entirely. That is the case being fixed, so that is the case to
      // test: 55 % of chunks at 700 ms, 45 % at 1010 ms against a 1000 ms
      // deadline. Mean 840 ms => RTF 0.84, silent under the old rule.
      const nearMiss = [];
      for (let i = 0; i < 32; i++) nearMiss.push(i < 18 ? 700 : 1010);   // 14/32 = 44 % over the deadline
      const meanRtf = nearMiss.reduce((a, b) => a + b, 0) / nearMiss.length / 1000;
      const missRate = nearMiss.filter((v) => v > 1000).length / nearMiss.length;
      const lp1 = mount();
      lp1.plan = makeLivePlan(1.0);
      feed(lp1, nearMiss);
      lp1.drops = 0;
      ok('a machine 6 % faster than ours passes the OLD mean gate while missing 45 % of deadlines',
        meanRtf < 0.85 && missRate > 0.4,
        `RTF ${meanRtf.toFixed(3)} (old gate 0.85 — silent) with ${(missRate * 100).toFixed(0)} % of chunks over the deadline`);
      sent.length = 0;
      lp1.warnIfMarginal();
      quiesce(lp1);
      ok('the p95 test fires on that same data',
        sent.some((m) => m.code === 'HOP_MARGINAL'),
        `p95 ${lp1.p95ChunkMs()} ms vs a 1000 ms deadline`);
      // and on the real measured distribution too
      const lpQA = mount();
      lpQA.plan = makeLivePlan(1.0);
      feed(lpQA, Array.from({ length: 32 }, (_, i) => (i % 2 ? 1002 : 753)));
      lpQA.drops = 0;
      sent.length = 0;
      lpQA.warnIfMarginal();
      quiesce(lpQA);
      ok('and on the distribution actually measured (753<->1002 ms, RTF 0.89)',
        sent.some((m) => m.code === 'HOP_MARGINAL'), `p95 ${lpQA.p95ChunkMs()} ms`);

      // hop 1.95 on the same machine must stay quiet
      const lp2 = mount();
      lp2.plan = makeLivePlan(1.95);
      feed(lp2, Array.from({ length: 32 }, (_, i) => 746 + (i % 5) * 17));   // 746..814, measured
      lp2.drops = 6; lp2.k = 156;
      sent.length = 0;
      lp2.warnIfMarginal();
      quiesce(lp2);
      ok('and stays quiet at the shipping hop (p95 814 ms against a 1950 ms deadline)',
        !sent.some((m) => m.code === 'HOP_MARGINAL') && !lp2.marginalWarned,
        `p95 ${lp2.p95ChunkMs()} ms, drops ${(100 * 6 / 156).toFixed(1)} %`);

      // the drop-rate trigger catches it even when p95 lands on the fast phase
      const lp3 = mount();
      lp3.plan = makeLivePlan(1.0);
      feed(lp3, Array.from({ length: 32 }, () => 760));
      lp3.drops = 45; lp3.k = 151;
      sent.length = 0;
      lp3.warnIfMarginal();
      quiesce(lp3);
      ok('a fast-phase window still trips on the observed drop rate',
        sent.some((m) => m.code === 'HOP_MARGINAL'),
        `p95 ${lp3.p95ChunkMs()} ms looks fine; ${(100 * 45 / 151).toFixed(0)} % of chunks already unseparated`);
      ok('thresholds are named constants, not literals',
        MARGINAL_P95_FRACTION === 0.85 && MARGINAL_DROP_RATE === 0.05);
    }

    head('live — a chunk failure degrades, then halts loudly; it never limps in silence');
    {
      const lp = mount();
      sent.length = 0;
      lp.fail('CHUNK_FAILED', new Error('boom'));
      ok('one failure does NOT set status=error (that would lock armPlayback off forever, ' +
         'so the ladder fills the ring with passthrough nobody is allowed to play)',
        lp.status === 'running' && lp.stopped === false, `status ${lp.status}`);
      lp.fail('CHUNK_FAILED', new Error('boom'));
      lp.fail('CHUNK_FAILED', new Error('boom'));
      quiesce(lp);
      ok('three consecutive failures halt the pipeline and say so',
        lp.status === 'error' && lp.stopped === true && lp.out.playing() === false, `status ${lp.status}`);
      const errs = sent.filter((m) => m.type === 'LIVE_ERROR');
      ok('the error is reported at most 4 times, not once per capture tick',
        errs.length === 4 && errs.at(-1).code === 'HALTED',
        `${errs.length} LIVE_ERROR: ${errs.map((e) => e.code).join(',')}`);
      for (let i = 0; i < 50; i++) lp.fail('CHUNK_FAILED', new Error('boom'));
      quiesce(lp);
      ok('and stays quiet afterwards (200 copies of one message buries the useful one)',
        sent.filter((m) => m.type === 'LIVE_ERROR').length === 4);
    }
  }

  head('live — readWindow zero-pads the past and reports lost history');
  if (typeof SharedArrayBuffer === 'function') {
    const CAP = 1 << 12;
    const sab = new SharedArrayBuffer(ringByteLength(CAP));
    const ring = new RingConsumer(sab, CAP);
    const hdr = new Int32Array(sab, 0, 16);
    const pl = new Float32Array(sab, 64, CAP), pr = new Float32Array(sab, 64 + CAP * 4, CAP);
    const put = (n) => { const wf = Atomics.load(hdr, 0);
      for (let i = 0; i < n; i++) { pl[(wf + i) & (CAP - 1)] = wf + i + 1; pr[(wf + i) & (CAP - 1)] = -(wf + i + 1); }
      Atomics.store(hdr, 0, wf + n); };
    put(500);
    // window = absolute frames [-300, 600): 300 of pre-history, 500 written, 100 unwritten
    const a = new Float32Array(900), b = new Float32Array(900);
    ok('a window reaching before frame 0 is zero-padded, not an error',
      readWindow(ring, -300, 900, a, b) === true && a[0] === 0 && a[299] === 0 && a[300] === 1);
    ok('reading past the write head yields zeros, not stale audio',
      a[799] === 500 && a[800] === 0 && a[899] === 0 && b[300] === -1);
    put(CAP);   // lap the ring
    const c2 = new Float32Array(200), d2 = new Float32Array(200);
    ok('a window the producer has already lapped is reported as lost',
      readWindow(ring, 0, 200, c2, d2) === false);
  }

  head('live — OUTPUT_DEAD: a playing deck that produces NOTHING must say so');
  /**
   * REACHABLE: drives the real decision, `offscreen/live.js::outputTick`, which
   * `LivePipeline.watchOutput()` calls at HEALTH_HZ. The browser half is in
   * tools/run-ext.mjs ("the dead-output watchdog"), which proves the arm is
   * wired and actually evaluating on a real deck; this proves the decision.
   *
   * WHY THIS EXISTS. Reported 2026-08-09 from a real end-to-end run: the buffer
   * gauge moving, every stem meter and the master meter at rest, no sound, and
   * NOT ONE ERROR anywhere. Both existing arms are structurally unable to fire
   * on that state — `OUTPUT_SILENT` requires `meters.peak.master > 1e-3` before
   * it will count a tick, and `OUTPUT_STALLED` requires the worklet to stop
   * heartbeating, which a deck emitting digital zero does not do. The engine had
   * a watchdog named for exactly this failure and a blind spot exactly the shape
   * of it.
   *
   * Every assertion below names the entry point, because `outputTick` has one
   * caller today and will acquire more (`AGENTS.md`, the entry-point rule).
   */
  {
    /**
     * A meter frame keyed by STEMS + `master`, built from the list rather than
     * from four spelled names. `outputTick` returns `blind` for any frame that
     * is short a stem (offscreen/live.js: "a frame that is short a stem is
     * blind, not signal"), so a four-name builder here would have made every row
     * below report `blind` instead of testing the verdict it names — the
     * assertion would still have been red, but for the wrong reason and at the
     * wrong file.
     * @param {...number} p one peak per stem in STEMS order, then master
     */
    const M = (...p) => {
      if (p.length !== STEMS.length + 1) throw new Error(`M() needs ${STEMS.length + 1} peaks, got ${p.length}`);
      const peak = { master: p[STEMS.length] };
      STEMS.forEach((s, k) => { peak[s] = p[k]; });
      return { peak };
    };
    const ZEROS = STEMS.map(() => 0);
    const LIVE = { meter: STEMS.map(() => 1), pass: 1 };
    const KILLED = { meter: [...ZEROS], pass: 0 };
    /**
     * TWO INPUT READINGS, AND THE DEFAULT IS "THE TAB IS LIVE AT BOTH ENDS".
     *
     * `outputTick` takes the capture peak over the frames the output just played
     * (`inputPeakPlayed`, the OUTPUT's clock — what was owed) AND the capture
     * peak now (`inputPeakNow`, the CAPTURE clock — whether audio is on the way).
     * It used to take one `inputPeak` read at the capture clock and compare it
     * against meters read at the speaker, which is two points on a delay line
     * treated as one instant; the rows below all default to a tab that is live
     * at both ends, so every verdict they name is the verdict under test rather
     * than a side effect of the split.
     */
    const tick = (o) => outputTick({
      playing: true, meters: M(...ZEROS, 0), gains: LIVE,
      inputPeakPlayed: 0.5, inputPeakNow: 0.5, ...o,
    });
    /** one stem up, the rest dead — `at('guitar', 1)` is the partial-kill vector */
    const only = (name, v) => STEMS.map((s) => (s === name ? v : 0));

    ok('watchOutput: a deck with signal at the stem tap is `signal`',
      tick({ meters: M(0.4, 0.1, 0.2, 0.3, 0.15, 0.05, 0.7) }) === 'signal');
    /**
     * THE NEW STEMS, ON THEIR OWN. `outputTick` used to read four spelled names,
     * so a deck playing nothing but guitar and piano metered as digital black
     * and would have raised OUTPUT_DEAD on a working deck. That is a wolf-cry on
     * ratified behaviour — exactly the failure `AGENTS.md` names — and it is
     * reachable with two clicks (solo guitar). Asserted per new stem, because
     * one name being wired up says nothing about the other.
     */
    for (const s of ['guitar', 'piano']) {
      ok(`watchOutput: a deck playing ONLY ${s} reads \`signal\`, not a dead deck`,
        tick({ meters: M(...only(s, 0.4), 0.4) }) === 'signal');
    }
    /**
     * ...and the converse, which is the half that can go vacuous: a frame that
     * omits a stem must be `blind`, not `signal`. A worklet still posting a
     * 4-stem meter array through a 6-stem byStem() yields `piano = undefined`,
     * and the old `Math.max(...)` form returned 'signal' on it.
     */
    for (const s of STEMS) {
      const short = M(...STEMS.map(() => 0.4), 0.4);
      delete short.peak[s];
      ok(`watchOutput: a meter frame missing \`${s}\` is \`blind\`, never \`signal\``,
        outputTick({ playing: true, meters: short, gains: LIVE, inputPeakPlayed: 0.5, inputPeakNow: 0.5 }) === 'blind');
    }
    ok('watchOutput: silent stems with a LIVE capture is `dead-mixer` — the separator published nothing',
      tick({ inputPeakPlayed: 0.5 }) === 'dead-mixer');
    ok('watchOutput: silent stems with a SILENT capture is `dead-input` — there was nothing to separate',
      tick({ inputPeakPlayed: 0, inputPeakNow: 0 }) === 'dead-input');
    ok('watchOutput: a deck that is not playing is `idle` and can never raise the alarm',
      outputTick({ playing: false, meters: null, gains: LIVE, inputPeakPlayed: 0, inputPeakNow: 0 }) === 'idle');

    // THE EXCUSE, and it is the only one. It is read off the RESOLVED GAIN
    // VECTOR — our own state — so it is independent of the silence it excuses
    // `AGENTS.md`. A user who kills all six stems has ASKED for digital black.
    ok('watchOutput: all six stems killed is `asked` — the user chose the silence',
      tick({ gains: KILLED }) === 'asked' && KILLED.meter.length === STEMS.length);
    // ...and it must take ALL of them. Asserted once per stem: a six-wide `asked`
    // that only inspects the first four would excuse a deck on the strength of
    // drums..vocals while guitar was still open, which is the partial kill this
    // row exists to refuse.
    for (const s of STEMS) {
      ok(`watchOutput: ...${s} still up is NOT excused, so a partial kill cannot hide a dead deck`,
        tick({ gains: { meter: only(s, 1), pass: 0 } }) === 'dead-mixer');
    }
    // QA-15's ratified ducking rule: with a stem killed, a DROPPED span is
    // silent on purpose (passthroughGain = min of the resolved gains = 0). At
    // hop 1.0 that is 57 s of a 71 s run — an alarm here would be crying wolf on
    // ratified behaviour, which is the failure `AGENTS.md` names twice.
    const ONE_KILLED = { meter: STEMS.map((s) => (s === 'vocals' ? 0 : 1)), pass: 0 };
    ok('watchOutput: a passthrough span ducked to zero by a killed stem is `asked`, not an alarm',
      tick({ gains: ONE_KILLED, passthrough: true }) === 'asked');
    ok('watchOutput: ...but the SAME gains OUTSIDE a passthrough span are a dead deck, because separated audio was owed',
      tick({ gains: ONE_KILLED, passthrough: false }) === 'dead-mixer');

    // AGENTS.md, "an assertion must FAIL when it cannot look" — applied to the
    // instrument itself. A playing deck whose audio thread has never reported a
    // meter frame is the failure; reading it as an excuse is how a watchdog
    // reports coverage it does not have.
    ok('watchOutput: a playing deck with NO meter frame is `blind`, which counts toward the alarm',
      outputTick({ playing: true, meters: null, gains: LIVE, inputPeakPlayed: 0.5, inputPeakNow: 0.5 }) === 'blind');
    ok('watchOutput: ...and `blind` is not silently rescued by the kill excuse either',
      outputTick({ playing: true, meters: null, gains: KILLED, inputPeakPlayed: 0, inputPeakNow: 0 }) === 'blind');

    // The two arms must cover DISJOINT regions. If this one could fire while the
    // master meter is up, it would double-report every OUTPUT_SILENT and the two
    // codes would stop meaning different things.
    ok('watchOutput: a deck crossfaded fully out still meters its stems, so it reads `signal`, not dead',
      tick({ meters: M(0.4, 0.1, 0.2, 0.3, 0.15, 0.05, 0) }) === 'signal');

    // Reintroducing the defect means widening the floor until real silence reads
    // as signal; pin the boundary so that shows up here rather than in a user's
    // ears. 1e-6 is ~-120 dBFS: below anything a 32-bit float mix produces.
    ok('watchOutput: the digital-zero floor is exact — 1e-6 is dead, 2e-6 is signal',
      tick({ meters: M(...ZEROS, MIXER_SILENT_PEAK) }) === 'dead-mixer' &&
      tick({ meters: M(...ZEROS, 2e-6) }) === 'signal');
    // ...and the floor is applied to EVERY stem, not just to master. Pinned per
    // new stem: at four names, `guitar` above the floor was invisible to it.
    for (const s of ['guitar', 'piano'])
      ok(`watchOutput: ...and the floor applies to ${s} too — ${s} at 2e-6 alone is signal`,
        tick({ meters: M(...only(s, 2e-6), 0) }) === 'signal' &&
        tick({ meters: M(...only(s, MIXER_SILENT_PEAK), 0) }) === 'dead-mixer');
    /**
     * THE HOLD IS A COUNT OF FRAMES, NOT OF HEARTBEATS. It used to be
     * `Math.round(OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ)` = 30 ticks, and this
     * assertion pinned that — a count of `setInterval` callbacks, which is a
     * stopwatch with a counter's name on it. `OUTPUT_DEAD_HOLD_FRAMES` is
     * seconds of audio the listener was actually handed, on the device's own
     * clock. The two agree only on a machine that never misses a heartbeat,
     * which is the machine nobody has.
     */
    ok('watchOutput: the hold is 3 s of PLAYED AUDIO, 132300 frames, long enough for a silent intro',
      OUTPUT_DEAD_HOLD_SEC === 3 && OUTPUT_DEAD_HOLD_FRAMES === 3 * SR && OUTPUT_DEAD_HOLD_FRAMES === 132300,
      `${OUTPUT_DEAD_HOLD_FRAMES} frames at ${SR} Hz`);

    /**
     * THE ACCEPTANCE CASE, AND IT IS A MEASUREMENT, NOT A CONSTRUCTION.
     *
     * PROVENANCE: Itzik's own run, 2026-08-09 — unpacked extension, real
     * YouTube tab, real toolbar arm, real DJ console, forty minutes. Every
     * number below is transcribed from that DIAG paste, not invented:
     *
     *   capture.seconds 2416.55 · capture.peak [0, 0] · dropped 0
     *   live.playing true · worklet.play true · worklet.running true · fade 1
     *   worklet.gain [1,1,1,1,1,1] · worklet.xf [1,1,1,1] · rampLeft all 0
     *   lastMeters present, every peak and rms 0 (912 METERS in 5 s, all zero)
     *   k 676 · drops 0 · underruns 0 · cushionSec 1.956 · healthAgeMs 33
     *   output.busPeak 0 · terminalIsDestination true · ctx.state "running"
     *   outputAlarm NULL  <- the engine said nothing for 2416 seconds
     *
     * The tab was PAUSED. The pipeline was correct end to end and was faithfully
     * separating silence into silence. `OUTPUT_SILENT` could not fire because it
     * demands `meters.peak.master > 1e-3` BEFORE it will count a silent tick,
     * and `OUTPUT_STALLED` could not fire because the worklet was heartbeating
     * 33 ms ago. The one instrument named for this failure was structurally
     * incapable of seeing it.
     *
     * This is why the deleted end-to-end block is not needed: it rested on an
     * unverified premise about what the model emits for an all-zero input, and
     * this rests on what the product actually did on a user's machine.
     *
     * ---- THE PASTE IS FOUR-STEM. READ THIS BEFORE TRUSTING THE REPLAY.
     *
     * That run predates guitar and piano — `worklet.gain [1,1,1,1,1,1]` is four
     * stems plus passthrough plus master, i.e. the OLD six-slot map, not the
     * eight-slot one this branch ships. The transcription above is left exactly
     * as it was pasted; what is widened is the REPLAY, and only on the clause
     * that the run's own premise settles: THE TAB WAS PAUSED, so the capture
     * ring was digital zero and the separator was faithfully turning silence
     * into silence. That is a property of the INPUT, so it holds for every stem
     * the model emits, at any stem count — `guitar: 0` and `piano: 0` are
     * entailed by `capture.peak [0, 0]`, not invented to make six keys.
     *
     * What is NOT claimed: nothing here is evidence about how guitar and piano
     * behave on a run with audio in it. That needs a new measurement, and
     * SIX-STEM-CONTRACT §4 records that we do not have one yet.
     */
    {
      const zeroPeaks = () => Object.fromEntries([...STEMS, 'master'].map((s) => [s, 0]));
      const REAL = {
        playing: true,
        meters: { peak: zeroPeaks(), rms: zeroPeaks() },
        gains: { meter: STEMS.map(() => 1), pass: 1, stems: STEMS.map(() => 1), xf: STEMS.map(() => 1) },
        passthrough: false,        // 0 drops in 676 chunks -> passSpans is empty
        // capture.peak [0, 0] AT BOTH ENDS: the tab was paused, so the frames
        // the speaker was replaying were silent and so is the tab right now.
        // With only the second of those it would read `inflight` — a working
        // deck one latency behind — which is exactly the state this run was NOT
        // in and exactly the state the old single reading could not tell it from.
        inputPeakPlayed: 0,
        inputPeakNow: 0,
      };
      ok("watchOutput: Itzik's 2416 s silent run reads `dead-input` — the branch that names the tab",
        outputTick(REAL) === 'dead-input');
      // Each of the three states the engine WAS in must be shown not to excuse
      // it, or this assertion proves only that some field happened to be zero.
      ok('...and none of the three excuses applies to it: gains were unity, no span was passthrough, meters were present',
        Math.max(REAL.gains.pass, ...REAL.gains.meter) === 1 &&
        REAL.passthrough === false && REAL.meters.peak !== undefined);
      // 132300 frames = 3.0 s of audio HANDED TO THE LISTENER. He got 2416.55 s
      // of it. Expressed in frames rather than in ticks because the claim is
      // about what he heard, not about how often our timer ran.
      ok('...and it would have fired after 3.0 s of silent audio, not 2416.6 s of it',
        OUTPUT_DEAD_HOLD_FRAMES / SR === 3 && 2416.55 / (OUTPUT_DEAD_HOLD_FRAMES / SR) > 800,
        `${OUTPUT_DEAD_HOLD_FRAMES} frames = 3.0 s; the real run went ${(2416.55 / 3).toFixed(0)}x that long in silence`);

      /**
       * ---- THE EMITTED MESSAGE, and its `variant` field.
       *
       * `LIVE_ERROR.variant` is present ONLY on
       * `OUTPUT_DEAD`, is one of the three members of DEAD_VERDICTS, and its
       * REFERENCE POINT IS THE TICK THAT TRIPPED THE LATCH — not the current
       * verdict. The console picks the remedy from it, and the two remedies are
       * opposites: `dead-input` sends the user to the tab (restarting the deck
       * fixes nothing), `dead-mixer`/`blind` restart the deck (going to the tab
       * fixes nothing). Before the field existed the console had to show both.
       *
       * This drives the real `watchOutput()` on a real LivePipeline, with the
       * same literal values from Itzik's snapshot, and reads what actually went
       * out on `send`. Nothing here is a re-implementation of the decision.
       */
      const { LivePipeline: LP } = await import('./extension/offscreen/live.js');
      /**
       * A DECK WHOSE PLAYHEAD ACTUALLY MOVES, because the alarm now counts the
       * audio that came out of it. `readFrames: () => 0` — what this stub used
       * to be — is a deck that has been handed nothing, and a deck that has been
       * handed nothing has nothing to be dead about.
       *
       * The capture ring is the paused tab: digital zero everywhere, and
       * readable, so `inputPeakOver()` gets a real (silent) answer rather than a
       * miss. `writeFrames` runs ahead of the playhead because capture always
       * does; `cap` is the real ring's 2^20 frames so nothing is ever reported
       * as lapped history.
       */
      const FPT = Math.round(SR / HEALTH_HZ);             // 4410 frames per heartbeat
      const wired = (meters) => {
        const out = [];
        const st = { played: 0 };
        const lp = new LP({
          deck: 'A',
          ctx: () => null,
          ring: () => ({                                  // capture.peak [0, 0]
            cap: 1 << 20,
            writeFrames: () => st.played + 3 * SR,
            peaks: () => [0, 0],
            readAt: (from, n, dL, dR, off = 0) => { dL.fill(0, off, off + n); dR.fill(0, off, off + n); },
          }),
          master: () => ({ busPeak: () => 0 }),           // output.busPeak 0
          infer: async () => ({}), ensureModel: async () => {},
          send: (m) => out.push(m), log: () => {},
        });
        lp.node = { port: { postMessage: () => {} } };    // gains resolve; nothing is sent
        lp.xf.position = 0;                               // lone deck A parks hard left (unity)
        lp.out = { playing: () => true, readFrames: () => st.played };
        lp.lastMeters = meters;
        lp.lastHealthAt = performance.now();              // healthAgeMs 33 -> STALLED cannot fire
        /** one heartbeat: the deck hands the listener FPT more frames, then we look */
        st.tick = () => { st.played += FPT; lp.lastHealthAt = performance.now(); lp.watchOutput(); };
        return { lp, out, st };
      };
      const ZERO = { peak: zeroPeaks(), rms: zeroPeaks() };

      const { lp, out, st } = wired(ZERO);
      // Drive until it fires, with a hard stop at four times the hold so a
      // watchdog that never fires ends this loop rather than hanging it.
      let ticksRun = 0;
      while (!lp.outputAlarm && ticksRun < 4 * OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ) { st.tick(); ticksRun++; }
      const fired = out.find((m) => m.type === 'LIVE_ERROR' && m.code === 'OUTPUT_DEAD');
      // FAIL WHEN IT CANNOT LOOK: if nothing was emitted, every field read below
      // is `undefined` and the assertions after it would be reporting on a
      // message that does not exist.
      ok('OUTPUT_DEAD is emitted after exactly the hold, and carries a `variant`',
        !!fired && out.filter((m) => m.type === 'LIVE_ERROR').length === 1 && 'variant' in fired,
        fired ? `after ${ticksRun} ticks / ${st.played} played frames: ${JSON.stringify({ code: fired.code, variant: fired.variant })}`
              : `no LIVE_ERROR in ${out.length} messages`);
      // THE HOLD IS A LOWER BOUND, AND IT IS TIGHT: the arm does not claim the
      // frames played during the tick that became dead (it did not observe them
      // dead), so it fires between the hold and the hold plus one heartbeat.
      ok('...and it fired on the FRAME COUNT: at least the hold, at most one heartbeat past it',
        !!fired && lp.deadFrames >= OUTPUT_DEAD_HOLD_FRAMES &&
        lp.deadFrames < OUTPUT_DEAD_HOLD_FRAMES + FPT,
        `${lp.deadFrames} dead frames against a ${OUTPUT_DEAD_HOLD_FRAMES}-frame hold (+${lp.deadFrames - OUTPUT_DEAD_HOLD_FRAMES})`);
      ok("...and for Itzik's values the variant is `dead-input` — the source-tab remedy, not Restart",
        fired && fired.variant === 'dead-input', fired && String(fired.variant));
      ok('...and the variant is in the ratified domain (the three DEAD_VERDICTS, nothing else)',
        fired && ['dead-input', 'dead-mixer', 'blind'].includes(fired.variant), fired && String(fired.variant));

      /**
       * THE REFERENCE POINT, and this is the assertion that actually tests it.
       *
       * The alarm latches once per session; `outputVerdict` does not stand still.
       * Move it and the LATCHED record must not follow. An implementation that
       * reports "the current verdict" instead of "the verdict that tripped it"
       * passes every assertion above and fails this one — which is the whole
       * reason the spec specified a reference point rather than a field name.
       */
      lp.outputVerdict = 'dead-mixer';                    // a later tick saw something else
      lp.watchOutput();                                   // latched: must be a no-op
      ok('the latched variant does NOT track a later `outputVerdict` — it is the tripping tick, not the current one',
        lp.outputAlarmVariant === 'dead-input' && lp.outputVerdict === 'dead-mixer' &&
        out.filter((m) => m.type === 'LIVE_ERROR').length === 1,
        `latched ${lp.outputAlarmVariant}, current ${lp.outputVerdict}, ` +
        `${out.filter((m) => m.type === 'LIVE_ERROR').length} LIVE_ERROR emitted`);
      ok('...and the message already on the wire still says what caused it',
        fired && fired.variant === 'dead-input' && fired.variant !== lp.outputVerdict,
        `wire ${fired && fired.variant} vs current ${lp.outputVerdict}`);

      // PRESENT ONLY ON OUTPUT_DEAD. A stalled audio thread with live meters
      // takes the OTHER arm, and a console keying off `'variant' in m` must not
      // find one there.
      {
        const byStem = (v, master) => Object.fromEntries([...STEMS.map((s) => [s, v]), ['master', master]]);
        const w2 = wired({ peak: byStem(0.3, 0.7), rms: byStem(0.1, 0.2) });
        w2.lp.lastHealthAt = performance.now() - 5000;    // heartbeat 5 s old
        w2.lp.watchOutput();
        const st = w2.out.find((m) => m.type === 'LIVE_ERROR');
        ok('OUTPUT_STALLED carries NO variant field at all — absent, not null',
          !!st && st.code === 'OUTPUT_STALLED' && !('variant' in st),
          st ? `${st.code}, keys ${Object.keys(st).join(',')}` : 'no LIVE_ERROR emitted');
      }
    }
  }

  head('live — OUTPUT_DEAD: the hold is a COUNT of played frames, and it is read on the right clock');
  /**
   * REACHABLE: every row drives the real `LivePipeline.watchOutput()` against a
   * deck whose playhead moves, whose capture ring can be read, and whose mixer
   * can be broken on purpose. Nothing here re-implements the decision.
   *
   * WHY THIS BLOCK EXISTS — two defects, one event (diagnosis, 2026-08-16). At a
   * hop-1.0 restart the e2e tier raised a FATAL `OUTPUT_DEAD [dead-mixer]` on a
   * deck that was working perfectly: 0 chunk failures, 33346/35607 audible
   * ms-blocks, 0 drops. Fired 4/4 at hop 1.0 and 0/2 at hop 1.95 with a **0.2 s
   * margin**, on a build nobody had changed.
   *
   *   D1 — THE HOLD WAS A STOPWATCH. `deadTicks >= 3 s * HEALTH_HZ` counts
   *        `setInterval` callbacks and starts at `play()`, so it spent its whole
   *        budget on the deck's own start-up: the deck was faithfully replaying
   *        the silence the tab produced before the user pressed play.
   *   D2 — IT COMPARED TWO CLOCKS. `inputPeak` came from `ring.peaks()` (the
   *        CAPTURE clock, "now") and `meters` is the speaker, `latencySec`
   *        behind. When the tab woke mid-count the verdict flipped
   *        `dead-input -> dead-mixer` with nothing in the mixer changing — and
   *        the console picks the REMEDY off that variant, so the user was told to
   *        restart a working deck instead of to press play in their own tab.
   *
   * The fix is a count and a clock, not a bigger constant: raising the hold would
   * have made this red go away while leaving the gate measuring the machine, and
   * it would have lengthened the forty-minute defect the arm exists to catch.
   */
  {
    const { LivePipeline: LP } = await import('./extension/offscreen/live.js');
    /** one meter frame at level `v`, every stem plus master — built off STEMS */
    const S = (v) => Object.fromEntries([...STEMS.map((s) => [s, v]), ['master', v]]);
    const verdictCount = (a, v) => a.filter((x) => x === v).length;
    /**
     * `Infinity` for a verdict that never happened, so an ordering assertion on
     * a sequence that is missing one of its members goes RED instead of passing
     * on a `-1` that happens to sort first.
     */
    const firstIndex = (a, v) => { const i = a.indexOf(v); return i < 0 ? Infinity : i; };

    /**
     * A DECK ON A TIMELINE, driven one heartbeat at a time.
     *
     * The model is the pipeline's own geometry and nothing more: output frame
     * `n` is the audio captured at live-relative capture frame `n` (the identity
     * `latencySec()` is derived from), the capture clock runs `latencySec` ahead
     * of the playhead, and the worklet meters what just came out. A mixer that
     * eats the audio is one multiplier — `mixerGain` — so "the tab went quiet"
     * and "the separator published nothing" are DIFFERENT knobs and a row can
     * turn exactly one of them.
     *
     * `hz` is how often the main thread gets to look. It is a property of the
     * MACHINE, never of the audio, and two rows below run the identical timeline
     * at 10 Hz and 2 Hz for exactly that reason.
     */
    const rig = ({ hz = HEALTH_HZ, latencySec = 2.0, tabLive = () => true, mixerGain = () => 1 }) => {
      const out = [], verdicts = [];
      const fpt = Math.round(SR / hz);
      const latFrames = Math.round(latencySec * SR);
      const st = { played: 0, ticks: 0, maxDeadFrames: 0, silentRun: 0, maxSilentRun: 0,
                   firedAtPlayed: null, firedAtTicks: null, firedAtDeadFrames: null, firedAtDeadTicks: null };
      const inputAt = (f) => (f >= 0 && tabLive(f) ? 0.6 : 0);
      const lp = new LP({
        deck: 'A',
        ctx: () => null,
        ring: () => ({
          cap: 1 << 20,
          // capture runs ahead of the playhead by the deck's latency
          writeFrames: () => st.played + latFrames,
          // THE CAPTURE CLOCK: the tab's peak over the last capture quanta, which
          // is what `capture-processor.js` publishes in the ring header.
          peaks: () => { const v = inputAt(st.played + latFrames - 1); return [v, v]; },
          readAt: (from, n, dL, dR, off = 0) => {
            for (let i = 0; i < n; i++) { const v = inputAt(from + i); dL[off + i] = v; dR[off + i] = v; }
          },
        }),
        master: () => ({ busPeak: () => 0.5 }),      // the bus is fine; this arm is about the deck
        infer: async () => ({}), ensureModel: async () => {},
        send: (m) => out.push(m), log: () => {},
      });
      lp.node = { port: { postMessage: () => {} } };
      lp.xf.position = 0;                            // lone deck A parks hard left (unity)
      lp.baseFrame = 0;
      lp.out = { playing: () => true, readFrames: () => st.played };
      st.tick = () => {
        const from = st.played;
        st.played += fpt; st.ticks++;
        let sig = 0;
        for (let f = from; f < st.played; f++) { const v = inputAt(f); if (v > sig) sig = v; }
        const heard = sig * mixerGain(st.played);
        lp.lastMeters = { peak: S(heard), rms: S(heard) };
        /**
         * `performance.now()`, NEVER 0, AND THIS HAS NOW COST TWO AGENTS A RED IN
         * THIS FILE. In node `performance.now()` is milliseconds since PROCESS
         * START, so pinning a time gate to 0 does not open it — it asks "is the
         * process older than N ms?", and the suite reaches these blocks at about
         * 30 ms. Ground every time gate on `now` or on `now - period`.
         */
        lp.lastHealthAt = performance.now();
        lp.watchOutput();
        verdicts.push(lp.outputVerdict);
        if (lp.deadFrames > st.maxDeadFrames) st.maxDeadFrames = lp.deadFrames;
        // What the OLD instrument counted: consecutive heartbeats on which the
        // deck produced nothing. Tracked so a row can show that the old rule
        // would have fired on a timeline the new one correctly passes.
        st.silentRun = heard > MIXER_SILENT_PEAK ? 0 : st.silentRun + 1;
        if (st.silentRun > st.maxSilentRun) st.maxSilentRun = st.silentRun;
        if (lp.outputAlarm && st.firedAtPlayed === null) {
          st.firedAtPlayed = st.played; st.firedAtTicks = st.ticks;
          st.firedAtDeadFrames = lp.deadFrames; st.firedAtDeadTicks = lp.deadTicks;
        }
      };
      st.run = (sec) => { const n = Math.round(sec * hz); for (let i = 0; i < n; i++) st.tick(); };
      return { lp, out, st, verdicts, fpt };
    };
    const deadMsg = (out) => out.find((m) => m.type === 'LIVE_ERROR' && m.code === 'OUTPUT_DEAD') || null;
    const OLD_HOLD_TICKS = Math.round(OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ);   // the instrument this replaces

    // ================================================ 1. THE SLOW START (D1+D2)
    /**
     * The reported false alarm, as a timeline: the user armed the deck and the
     * tab did not produce its first sample until 3.6 s of capture later. The deck
     * armed 2.0 s in, so for the first 1.6 s of playback it is replaying silence
     * that the tab really did produce, and after that it is replaying silence
     * while the tab is ALREADY PLAYING — the audio is in the pipe, one latency
     * from the speaker.
     */
    {
      const TAB_STARTS = Math.round(3.6 * SR);
      const r = rig({ tabLive: (f) => f >= TAB_STARTS, latencySec: 2.0 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('slow start: a deck replaying the lead-in silence the TAB produced raises no alarm',
        m === null && r.lp.outputAlarm === null,
        m ? `fired ${m.variant}: ${m.message.slice(0, 60)}` : `no LIVE_ERROR in ${r.out.length} messages`);
      /**
       * ...AND THE GREEN IS NOT "THE ARM NEVER RAN". Three separate facts, each
       * asserted rather than assumed: the arm evaluated on every heartbeat, it
       * DID see the deck producing nothing (so it was looking at the failure it
       * is named for), and the counter really did move.
       */
      ok('...and it looked every heartbeat, saw the silence, and counted it — this green is not a watchdog that never ran',
        r.lp.outputChecks === r.st.ticks && verdictCount(r.verdicts, 'dead-input') > 0 && r.st.maxDeadFrames > 0,
        `${r.lp.outputChecks} evaluations of ${r.st.ticks} ticks, ${verdictCount(r.verdicts, 'dead-input')} dead-input, ` +
        `peak ${r.st.maxDeadFrames} dead frames of a ${OUTPUT_DEAD_HOLD_FRAMES}-frame hold`);
      /**
       * THE OLD INSTRUMENT WOULD HAVE FIRED ON THIS EXACT TIMELINE. `maxSilentRun`
       * is what `deadTicks` counted — consecutive heartbeats with nothing at the
       * speaker — and it clears the old 30-tick hold comfortably. Without this
       * row the assertion above is "a timeline on which nothing fires", which
       * proves nothing about the fix.
       */
      ok('...and the OLD tick-counting hold WOULD have fired here, which is what makes this row a fix and not a coincidence',
        r.st.maxSilentRun >= OLD_HOLD_TICKS && r.st.maxDeadFrames < OUTPUT_DEAD_HOLD_FRAMES,
        `${r.st.maxSilentRun} consecutive silent heartbeats against the old ${OLD_HOLD_TICKS}-tick hold; ` +
        `new counter peaked at ${r.st.maxDeadFrames}/${OUTPUT_DEAD_HOLD_FRAMES} frames`);
      /**
       * D2, DIRECTLY. The tab wakes at 3.6 s of capture, i.e. 1.6 s into
       * playback, while the speaker is still 2.0 s behind. Under the old single
       * capture-clock reading every heartbeat from then on read `dead-mixer` and
       * the console would have offered "Restart live" for a deck whose only
       * problem was that the user had just pressed play.
       */
      ok('D2: a tab waking mid-count does NOT flip the verdict to `dead-mixer` — nothing in the mixer changed',
        verdictCount(r.verdicts, 'dead-mixer') === 0 && verdictCount(r.verdicts, 'inflight') > 0,
        `${verdictCount(r.verdicts, 'dead-mixer')} dead-mixer, ${verdictCount(r.verdicts, 'inflight')} inflight, ` +
        `${verdictCount(r.verdicts, 'signal')} signal`);
      // ...and the sequence is the physical one, in order: the tab was silent,
      // then it was playing and we had not caught up, then we had.
      ok('...and the verdict sequence is the pipeline geometry: dead-input -> inflight -> signal, once each way',
        firstIndex(r.verdicts, 'dead-input') < firstIndex(r.verdicts, 'inflight') &&
        firstIndex(r.verdicts, 'inflight') < firstIndex(r.verdicts, 'signal'),
        `dead-input@${firstIndex(r.verdicts, 'dead-input')} inflight@${firstIndex(r.verdicts, 'inflight')} ` +
        `signal@${firstIndex(r.verdicts, 'signal')}`);
    }

    // =========================================== 2. BREAK IT: the tab NEVER starts
    /**
     * THE CONTROL, AND IT CAN LOSE. Same rig, same lead-in, one difference: the
     * tab never produces a sample. If row 1's green came from a rig that cannot
     * fire, this row is green too and the whole block is worthless.
     */
    {
      const r = rig({ tabLive: () => false, latencySec: 2.0 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('BROKEN ON PURPOSE — a tab that never plays: the alarm fires, and names the TAB',
        !!m && m.variant === 'dead-input' && r.lp.outputAlarmVariant === 'dead-input',
        m ? `${m.variant} after ${r.st.firedAtPlayed} played frames` : `nothing fired in ${r.st.ticks} ticks`);
      ok('...on the frame count, not the tick count: at least the hold of played audio',
        !!m && r.st.firedAtDeadFrames >= OUTPUT_DEAD_HOLD_FRAMES,
        `${r.st.firedAtDeadFrames} dead frames, ${r.st.firedAtDeadTicks} dead ticks`);
      ok('...and it says so exactly once — the alarm latches per session',
        r.out.filter((x) => x.type === 'LIVE_ERROR').length === 1,
        `${r.out.filter((x) => x.type === 'LIVE_ERROR').length} LIVE_ERROR`);
    }

    // ============================================ 3. BREAK IT: kill the mixer
    /**
     * The other half of the discrimination, and the one the console's remedy
     * turns on. The tab plays throughout; the separator publishes digital zero.
     * `dead-input` here would send the user to a tab that is working.
     */
    {
      const r = rig({ tabLive: () => true, mixerGain: () => 0 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('BROKEN ON PURPOSE — a dead mixer under a LIVE tab: the alarm fires, and names the DECK',
        !!m && m.variant === 'dead-mixer',
        m ? `${m.variant} after ${r.st.firedAtPlayed} played frames` : `nothing fired in ${r.st.ticks} ticks`);
      ok('...and the two breaks are told apart by the audio, not by luck: row 2 said `dead-input`, this one says `dead-mixer`',
        !!m && m.variant === 'dead-mixer' && verdictCount(r.verdicts, 'dead-input') === 0,
        `${verdictCount(r.verdicts, 'dead-mixer')} dead-mixer, ${verdictCount(r.verdicts, 'dead-input')} dead-input`);
    }

    // ================================== 4. THE MESSAGE MAY NOT MISSTATE ITS EVIDENCE
    /**
     * The separator running on a silent input publishes something around 2.4e-08
     * per stem, not zero — and `toFixed(6)` renders every one of those as
     * `0.000000`, which reads as "the mixer emitted nothing" and is a different
     * defect with a different first suspect. The message is the only artefact a
     * user ever pastes, so a message that misstates its own evidence costs an
     * investigation exactly as a wrong assertion does.
     */
    {
      const r = rig({ tabLive: () => true, mixerGain: () => 4.1e-8 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('the OUTPUT_DEAD message prints a 2.4e-08 stem peak as 2.4e-08, not as `0.000000`',
        !!m && /e-8/.test(m.message) && !/0\.000000/.test(m.message),
        m ? m.message.slice(m.message.indexOf('(stem peaks')) : 'nothing fired');
      // ...and it is still a dead deck: 2.46e-08 is 152 dB below full scale, well
      // under the 1e-6 floor. The formatting fix must not have widened the floor.
      ok('...and 2.46e-08 is still DEAD, not signal — printing it honestly did not widen the floor',
        !!m && m.variant === 'dead-mixer' && 0.6 * 4.1e-8 < MIXER_SILENT_PEAK,
        `stem peak ${(0.6 * 4.1e-8).toExponential(2)} against a ${MIXER_SILENT_PEAK} floor`);
    }

    // ================================= 5. THE PAUSE MID-RUN (DEVTEST L5a, and Itzik's run)
    /**
     * The failure the arm was built for, and it must still work. The tab plays
     * for 10 s and is then paused. The deck goes on playing what it has buffered,
     * so the alarm must NOT fire while the user can still hear music — and must
     * fire a hold after the silence reaches the speaker, naming the tab.
     */
    {
      const PAUSE_AT = 10 * SR;
      const r = rig({ tabLive: (f) => f < PAUSE_AT, latencySec: 2.0 });
      r.st.run(25);
      const m = deadMsg(r.out);
      ok('a tab paused mid-run still raises OUTPUT_DEAD, and still names the tab',
        !!m && m.variant === 'dead-input',
        m ? `${m.variant} at played frame ${r.st.firedAtPlayed}` : `nothing fired in ${r.st.ticks} ticks`);
      /**
       * AND NOT ONE FRAME BEFORE THE USER COULD HEAR IT. The capture goes silent
       * 2.0 s (one latency) before the speaker does; an alarm decided on the
       * capture clock would fire that much early, while the deck was still
       * playing music. This is the same clock error as D2 seen from the other
       * end, so it gets its own row.
       */
      ok('...and never while music is still coming out: it fires a full hold AFTER the silence reaches the speaker',
        !!m && r.st.firedAtPlayed >= PAUSE_AT + OUTPUT_DEAD_HOLD_FRAMES,
        `fired at played frame ${r.st.firedAtPlayed}, silence reached the speaker at ${PAUSE_AT}, ` +
        `hold ${OUTPUT_DEAD_HOLD_FRAMES}`);
    }

    // ====================================== 6. THE SAME AUDIO, TWO SPEEDS OF MACHINE
    /**
     * THE CLAIM THE WHOLE RE-GROUNDING RESTS ON: the verdict is a property of the
     * audio, not of how often this laptop got round to looking. Identical
     * timeline — tab live, mixer dead — sampled at 10 Hz and at 2 Hz.
     *
     * A gate whose verdict changes on code that did not change is measuring the
     * machine (AGENTS.md). The old rule needed 30 heartbeats, which at 2 Hz is
     * FIFTEEN seconds of audio and at 10 Hz is three: the same defect, reported
     * five times later, on the same build. The frame count is the same both times
     * to within one heartbeat, which is the resolution of the instrument.
     */
    {
      const fast = rig({ hz: 10, tabLive: () => true, mixerGain: () => 0 });
      const slow = rig({ hz: 2, tabLive: () => true, mixerGain: () => 0 });
      fast.st.run(12); slow.st.run(12);
      ok('COUNT NOT STOPWATCH: at 10 Hz and at 2 Hz the alarm fires after the SAME amount of audio',
        fast.st.firedAtPlayed !== null && slow.st.firedAtPlayed !== null &&
        Math.abs(fast.st.firedAtPlayed - slow.st.firedAtPlayed) <= slow.fpt,
        `10 Hz fired at ${fast.st.firedAtPlayed} frames, 2 Hz at ${slow.st.firedAtPlayed} ` +
        `(one 2 Hz heartbeat is ${slow.fpt} frames)`);
      ok('...while the HEARTBEAT count differs by the sampling rate, which is the thing that must not decide it',
        fast.st.firedAtTicks >= 4 * slow.st.firedAtTicks,
        `${fast.st.firedAtTicks} ticks at 10 Hz vs ${slow.st.firedAtTicks} at 2 Hz`);
      /**
       * ...AND THE OLD RULE IS SHOWN FAILING ON THE SLOW MACHINE. `deadTicks` is
       * still published for diagnosis, so its value at the tripping instant is
       * exactly what the old gate would have been looking at: under 30, i.e. the
       * old instrument had not fired yet and would not for another 8 s of audio.
       */
      ok('...and the old 30-tick hold had NOT fired at that point on the 2 Hz machine — it needed 15 s of audio, not 3',
        slow.st.firedAtDeadTicks < OLD_HOLD_TICKS && slow.st.firedAtDeadFrames >= OUTPUT_DEAD_HOLD_FRAMES,
        `${slow.st.firedAtDeadTicks} dead ticks (old hold ${OLD_HOLD_TICKS}) but ` +
        `${slow.st.firedAtDeadFrames} dead frames (new hold ${OUTPUT_DEAD_HOLD_FRAMES})`);
    }

    // ============================ 7. WHEN IT CANNOT LOOK, IT MAY NOT ACCUSE THE TAB
    /**
     * A heartbeat later than the one-second probe window cannot read the whole
     * span the deck played, so it cannot support "the tab was digitally silent
     * throughout". AGENTS.md's rule is that the missing evidence is the failure,
     * not an excuse from it — so the alarm still fires (the deck is dead either
     * way) and the CLAIM degrades to the deck-side remedy, counted on
     * `inputWindowMisses` rather than inferred.
     */
    {
      const r = rig({ hz: 0.5, tabLive: () => false });      // 88200 frames a look
      r.st.run(16);
      const m = deadMsg(r.out);
      ok('an unreadable input window still fires the alarm — "we could not look" is not an excuse from it',
        !!m && r.lp.inputWindowMisses > 0,
        m ? `${m.variant} after ${r.lp.inputWindowMisses} unreadable windows` : 'nothing fired');
      ok('...but it may NOT say the tab was silent: the variant degrades to the deck-side remedy',
        !!m && m.variant === 'dead-mixer' && verdictCount(r.verdicts, 'dead-input') === 0,
        `${m && m.variant}, ${verdictCount(r.verdicts, 'dead-input')} dead-input verdicts`);
      ok('...and the message does not claim evidence it never read',
        !!m && !/captured tab has audio/.test(m.message),
        m ? m.message.slice(0, 72) : 'nothing fired');
    }
  }

  head('live — Ruling 8: a new session may not publish the LAST track\'s key or tempo');
  /**
   * REACHABLE: drives the real `start()` and reads the LIVE_STATE messages that
   * actually went out during the priming window. This is a SEQUENCING claim about
   * `offscreen/live.js`, not a claim about either detector — `keytap.js` and
   * `bpmtap.js` each prove their own `reset()` clears them, and neither can see
   * WHEN the deck calls it.
   *
   * THE DEFECT. `start()` pushes state twice before the ring exists —
   * `phase:'model'` (weights, up to a 172 MiB download) and `phase:'ring'` — and
   * both resets used to sit a dozen lines below them. So for the entire priming
   * window, ~3.4 s at hop 1.95 and far longer on a cold model, LIVE_STATE carried
   * the PREVIOUS track's key and BPM under the new track's title. That is not a
   * stale readout that catches up; it is a wrong one that is correct-looking,
   * which is the exact property both detectors' own headers say is the worst
   * thing either feature can do.
   *
   * The taps are stubbed to a single fact — "has reset() been called yet" —
   * because that is the only thing this block claims. The control below shows the
   * wire faithfully carries whatever the tap holds, so `none` in the priming push
   * can only mean the reset ran first.
   */
  {
    const { LivePipeline: LP } = await import('./extension/offscreen/live.js');
    const lastTrack = (locked) => ({
      wasReset: false,
      reset() { this.wasReset = true; },
      tick() {},
      stats: () => ({}),
      payload() {
        return this.wasReset
          ? { state: 'none', bpm: null, confidence: 0, beatFrame: null, concertTonic: null, mode: null }
          : locked;
      },
    });
    const KEY_LAST = { state: 'locked', concertTonic: 9, mode: 'minor', confidence: 0.71 };
    const BPM_LAST = { state: 'locked', bpm: 128.4, confidence: 0.63, beatFrame: 1117935 };

    const sends = [];
    const lp = new LP({
      deck: 'A',
      ctx: () => null,
      ring: () => ({ cap: 1 << 20, writeFrames: () => 0, peaks: () => [0, 0], readAt: () => {} }),
      master: () => ({ busPeak: () => 0 }),
      infer: async () => ({}), ensureModel: async () => {},
      send: (m) => sends.push(m), log: () => {},
    });
    lp.keyTap = lastTrack(KEY_LAST);
    lp.bpmTap = lastTrack(BPM_LAST);
    // A previous session's LATCHED tempo fault, which is the same class of
    // carry-over: `state:'fault'` from a track that is no longer loaded.
    lp.bpmFault = 'tick: the last track';
    lp.bpmFaults = 4;

    /**
     * THE CONTROL, AND IT CAN LOSE. A heartbeat BEFORE start() must publish the
     * previous track's values — otherwise "the priming push says none" would be
     * satisfied by a wire that never carries a key at all, and every row below
     * would be green against a broken payload.
     */
    lp.status = 'running';
    lp.pushState(true);
    const pre = sends.filter((m) => m.type === 'LIVE_STATE').at(-1);
    ok('control: before start(), the wire really does carry the previous track\'s key and tempo',
      !!pre && pre.key.state === 'locked' && pre.key.concertTonic === 9 &&
      pre.bpm.state === 'fault' && pre.bpm.faults === 4,
      pre ? `key ${pre.key.state}/${pre.key.concertTonic}, bpm ${pre.bpm.state}` : 'no LIVE_STATE');

    // ---- now the real start(), with only the browser-only half stubbed out.
    const posted = [];
    lp.status = 'idle';
    lp.build = async () => {                          // needs an AudioWorklet
      lp.node = { port: { postMessage: (m) => posted.push(m) } };
      lp.out = {
        _play: false, _w: 0,
        reset() { this._w = 0; }, play(v) { this._play = v; }, playing() { return this._play; },
        readFrames: () => 0, writeFrames() { return this._w; }, cushion: () => 0,
      };
    };
    sends.length = 0;
    await lp.start();
    const priming = sends.filter((m) => m.type === 'LIVE_STATE');
    // FAIL WHEN IT CANNOT LOOK: if start() emitted no priming state at all, every
    // field below is `undefined` and the rows would be reporting on messages that
    // do not exist.
    ok('start() emits the two priming pushes this claim is about (`model`, then `ring`)',
      priming.length >= 2 && priming[0].phase === 'model' && priming[1].phase === 'ring',
      `${priming.length} LIVE_STATE, phases ${priming.map((m) => m.phase).join(',') || 'none'}`);
    ok('...and the FIRST of them already reports `none` for the key — the reset is ahead of the push',
      priming.length >= 2 && priming[0].key.state === 'none' && priming[0].key.concertTonic === null,
      priming.length ? `${priming[0].key.state}/${priming[0].key.concertTonic}` : 'no push');
    ok('...and `none` for the tempo, with the previous session\'s latched fault cleared with it',
      priming.length >= 2 && priming[0].bpm.state === 'none' && priming[0].bpm.bpm === null &&
      lp.bpmFault === null && lp.bpmFaults === 0,
      priming.length ? `${priming[0].bpm.state}/${priming[0].bpm.bpm}, fault ${lp.bpmFault}, faults ${lp.bpmFaults}` : 'no push');
    // Both pushes, not just the first: the model load sits BETWEEN them, so a
    // reset that ran after the first one would still leave the second wrong for
    // however long the weights take.
    ok('...and so does every other push start() makes, across the whole priming window',
      priming.every((m) => m.key.state === 'none' && m.bpm.state === 'none'),
      priming.map((m) => `${m.phase}:${m.key.state}/${m.bpm.state}`).join(' '));
    ok('...and both taps were actually asked to reset, by start(), on the start path',
      lp.keyTap.wasReset === true && lp.bpmTap.wasReset === true,
      `key ${lp.keyTap.wasReset}, bpm ${lp.bpmTap.wasReset}`);
    await lp.stop();                                  // release the 10 Hz interval
  }
}

// ===========================================================================
if (group('cache')) {
  head('cache — the key must invalidate on anything that changes the samples');
  // REACHABLE: drives the real pipelineVersion()/cacheKey(). Silently-stale
  // stems are the worst bug this project could ship — they sound plausible, they
  // are wrong, and nothing in the UI can tell you.
  {
    const a = cacheKey('dQw4w9WgXcQ', 1.95);
    ok('the key contains the video id and a version', /^dQw4w9WgXcQ--/.test(a), a);
    ok('a different HOP is a different key (causal stems are hop-dependent: ' +
       'corr 0.9909 at 1.95 s vs 0.9938 at 3.9 s against offline)',
      cacheKey('x', 1.95) !== cacheKey('x', 3.9),
      `${pipelineVersion(1.95)} vs ${pipelineVersion(3.9)}`);
    ok('the version pins the model hash', pipelineVersion(1.95).includes(MODEL.sha256.slice(0, 12)));
    ok('the version pins the segment geometry and the seam law',
      pipelineVersion(1.95).includes(`seg${SEGMENT}`) && /-x50[LP]$/.test(pipelineVersion(1.95)),
      pipelineVersion(1.95));
    ok('the same inputs give the same key (a hit is reproducible)',
      cacheKey('abc', 1.95) === cacheKey('abc', 1.95));
    ok('ids are sanitised, so a hostile id cannot escape the directory',
      !cacheKey('../../etc/passwd', 1.95).includes('/') &&
      !cacheKey('a b/c', 1.95).includes(' '), cacheKey('../../etc/passwd', 1.95));
  }

  head('cache — storage arithmetic (AUDIO.md §8.3)');
  {
    /**
     * RE-DERIVED AT SIX STEMS, not renumbered. The quantity is physical: one
     * 16-bit stereo PCM file per stem, so 4 bytes per frame per stem, plus one
     * 44-byte RIFF header per file.
     *
     *   240 s x 44 100 = 10 584 000 frames
     *   10 584 000 x 4 B x 6 stems     = 254 016 000 B
     *   + 6 x 44 B of RIFF header      =         264 B
     *                                  = 254 016 264 B = 254.0 MB
     *
     * It was 169.3 MB at four stems (10 584 000 x 4 x 4 + 176). The +50 % is the
     * two new stems and nothing else — SIX-STEM-CONTRACT §3 predicted "169 ->
     * ~254 MB/track" and this is the arithmetic behind it.
     *
     * The left-hand side is computed here from SR and STEMS.length rather than
     * read back out of `bytesForSeconds`, so this is a check of the function
     * against the physics and not of the function against itself.
     */
    const fourMin = bytesForSeconds(240);
    const derived = Math.round(240 * SR) * 4 * STEMS.length + STEMS.length * 44;
    ok(`a 4-minute track is 254.0 MB at 16-bit stereo x ${STEMS.length} stems (was 169.3 at four)`,
      fourMin === derived && Math.abs(fourMin / 1e6 - 254.0) < 0.5,
      `${(fourMin / 1e6).toFixed(3)} MB = ${Math.round(240 * SR)} frames x 4 B x ${STEMS.length} + ${STEMS.length} x 44 B`);
    /**
     * 4 GiB / 254 016 264 B = 16.91 -> 16 tracks. It was 25 at four stems.
     * AUDIO.md §8.3's table computes against 4 DECIMAL GB and is still written
     * for four stems (169 MB / 24 tracks); at six stems the decimal figure is
     * 4e9 / 254 016 264 = 15.75 -> 15. Both units are pinned so nobody
     * "corrects" one to match the other, and so the doc pass has the number.
     */
    ok('the 4 GiB cap therefore holds 16 tracks, not the 25 it held at four stems',
      Math.floor(STEM_CACHE_MAX_BYTES / fourMin) === 16 &&
      Math.floor(4e9 / fourMin) === 15,
      `${Math.floor(STEM_CACHE_MAX_BYTES / fourMin)} tracks in ${(STEM_CACHE_MAX_BYTES / 2 ** 30).toFixed(0)} GiB, ` +
      `${Math.floor(4e9 / fourMin)} in 4 decimal GB`);
    // 8 = 16/2 exactly, which is the whole argument for 16-bit and is the one
    // part of this block that stem count cannot move.
    ok('32-bit float would have held half as many, 8 not 16 (why the cache is 16-bit)',
      Math.floor(STEM_CACHE_MAX_BYTES / (fourMin * 2)) === 8 &&
      Math.floor(STEM_CACHE_MAX_BYTES / (fourMin * 2)) * 2 === Math.floor(STEM_CACHE_MAX_BYTES / fourMin),
      `${Math.floor(STEM_CACHE_MAX_BYTES / (fourMin * 2))} tracks at 32f`);
  }

  head('cache — the writer accumulates hops and refuses to commit a broken prime');
  {
    const w = new CacheWriter('k', { videoId: 'v' });
    // TWELVE planes, one per stem channel. Each carries its own value so a
    // plane-to-stem mapping error is a wrong number rather than a wrong length.
    const planes = Array.from({ length: STEMS.length * 2 }, (_, q) => new Float32Array(100).fill((q + 1) / 10));
    w.append(planes, 100);
    w.append(planes, 60);                       // a short final hop
    ok('frames accumulate across hops', w.frames === 160, `${w.frames}`);
    const st = w.stems();
    ok(`all ${STEMS.length} stems come back with both channels at the right length`,
      Object.keys(st).length === STEMS.length &&
      STEMS.every((s) => st[s].length === 2 && st[s][0].length === 160),
      Object.keys(st).join(','));
    /**
     * WIDENED, NOT SPOT-CHECKED. The four-stem form asserted drums (planes 0/1)
     * and vocals (6/7) and inferred the rest. At six stems the two planes that
     * can be wrong without either of those noticing are precisely the new ones —
     * guitar at 8/9 and piano at 10/11 — so the mapping is now asserted for
     * EVERY stem, `planes[2k]` -> L and `planes[2k+1]` -> R.
     * (Folded in from TRACK A's isolation suite.)
     */
    const wrong = STEMS.filter((s, k) =>
      Math.abs(st[s][0][0] - (planeL(k) + 1) / 10) > 1e-6 ||
      Math.abs(st[s][1][0] - (planeR(k) + 1) / 10) > 1e-6);
    ok('every stem reads back plane pair 2k / 2k+1, L then R — guitar is 8/9, piano 10/11, no off-by-two',
      wrong.length === 0,
      STEMS.map((s, k) => `${s}=${st[s][0][0].toFixed(1)}/${st[s][1][0].toFixed(1)}`).join(' '));
    ok('a short final hop is not padded out', st.bass[0][159] !== 0 && st.bass[0].length === 160);
    /**
     * THE REFUSAL, and it is the one that keeps the widening from arriving
     * half-done. An 8-plane caller would cache four stems, COMMIT, and read back
     * later as a track that is silently missing its guitar and piano — the
     * silently-stale entry this whole file exists to prevent, with nothing in
     * the UI able to tell you. (Folded in from TRACK A's isolation suite.)
     */
    let shortAppend = '';
    try { new CacheWriter('k', {}).append(planes.slice(0, 8), 100); } catch (e) { shortAppend = e.message; }
    ok('append() REFUSES an 8-plane call rather than caching four stems and committing',
      new RegExp(`needs ${STEMS.length * 2} planes for ${STEMS.length} stems, got 8`).test(shortAppend),
      shortAppend || '(did not throw)');
    w.abort();
    ok('an aborted prime holds nothing and cannot commit', w.frames === 0);
  }

  head('cache — eviction is strict LRU, predictable, and never touches the playing track');
  {
    // The 169 MB below is a SYNTHETIC FIXTURE SIZE, not the per-track figure —
    // planEviction is pure LRU and knows nothing about stems, so the caps here
    // are chosen to make the ordering unambiguous and deliberately do NOT track
    // the 254 MB derived above.
    const MB = 1e6;
    const E = (key, usedAt, mb) => ({ key, usedAt, bytes: mb * MB, title: key });
    const four = [E('oldest', 100, 169), E('old', 200, 169), E('recent', 300, 169), E('newest', 400, 169)];
    ok('nothing is removed while under the cap',
      planEviction(four, 1000 * MB).removed.length === 0);
    ok('over the cap, the OLDEST-USED goes first',
      planEviction(four, 520 * MB).removed.map((e) => e.key).join(',') === 'oldest',
      `cap 520 MB of 676 MB used -> removes ${planEviction(four, 520 * MB).removed.map((e) => e.key).join(',')}`);
    ok('and it removes only as many as it needs to',
      planEviction(four, 350 * MB).removed.map((e) => e.key).join(',') === 'oldest,old');
    ok('the PINNED (playing) track is never a candidate, even if it is oldest',
      planEviction(four, 350 * MB, 'oldest').removed.map((e) => e.key).join(',') === 'old,recent',
      planEviction(four, 350 * MB, 'oldest').removed.map((e) => e.key).join(','));
    ok('it reports what it removed, so the UI can say so rather than silently drop a prepared set',
      planEviction(four, 350 * MB).removed.every((e) => e.key && e.bytes > 0 && e.title));
    ok('a cap smaller than the pinned track is reported, not silently violated',
      planEviction(four, 10 * MB, 'newest').wouldExceed === true &&
      planEviction(four, 10 * MB, 'newest').bytes === 169 * MB);
    // determinism matters: a prime that finishes and is played lands in the same ms
    const tie = [E('b', 100, 169), E('a', 100, 169), E('c', 500, 169)];
    ok('ties are broken deterministically by key, not by array order',
      planEviction(tie, 200 * MB).removed.map((e) => e.key).join(',') ===
      planEviction(tie.slice().reverse(), 200 * MB).removed.map((e) => e.key).join(','),
      planEviction(tie, 200 * MB).removed.map((e) => e.key).join(','));
  }

  head('cache — a cached deck streams from memory and has none of the live machinery');
  if (typeof SharedArrayBuffer !== 'function') {
    ok('SharedArrayBuffer available', false, 'not in this node build');
  } else {
    /**
     * REACHABLE for fill/transport: this drives the real CachedDeck against a
     * real StemRingWriter. `ensureGraph()` is stubbed because it needs an
     * AudioWorkletNode; what that hides is only the wiring, and the browser
     * check covers it once measurement is cleared.
     */
    const { StemRingWriter, stemRingByteLength } = await import('./extension/shared/stemring.js');
    const { STEM_RING_FRAMES } = await import('./extension/shared/config.js');
    const sent = [];
    const mkDeck = () => {
      const d = new CachedDeck('A', {
        ctx: () => ({ outputLatency: 0.048 }),
        master: () => ({ build: async () => ({ input: () => ({}) }) }),
        send: (m) => sent.push(m), log: () => {},
        // The Host's asset resolver, which `ensureGraph()` uses to find the
        // playback worklet. Stubbed rather than omitted: `ensureGraph` is
        // replaced below, so leaving it out would let this stub drift out of
        // step with the bundle `offscreen/engine.js` really hands over and
        // nothing here would notice. The graph builder's real use of it is
        // driven in the `host` group.
        assetUrl: (relPath) => `stub://unit/${relPath}`,
      });
      d.ensureGraph = async () => {
        d.out = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(STEM_RING_FRAMES)), STEM_RING_FRAMES);
        d.node = { port: { postMessage: () => {} } };
        d.planes = Array.from({ length: RING_PLANES }, () => new Float32Array(65536));
      };
      return d;
    };
    const track = (frames) => {
      const stems = {};
      STEMS.forEach((s2, k) => {
        stems[s2] = [0, 1].map((c) => {
          const a = new Float32Array(frames);
          for (let i = 0; i < frames; i++) a[i] = ((k * 2 + c + 1) / 10) * Math.sin(i / 50);
          return a;
        });
      });
      return { stems, frames, meta: { videoId: 'v', title: 't' } };
    };

    const FR = 44100 * 60;               // a minute: far bigger than the ring
    const d = mkDeck();
    await d.load(track(FR));
    ok('loading buffers ahead WITHOUT loading the track whole',
      d.out.writeFrames() > 44100 && d.out.writeFrames() < FR && d.writeHead === d.out.writeFrames(),
      `${d.out.writeFrames()} of ${FR} frames buffered, ring cap ${d.out.cap}`);
    ok('it buffers about the configured look-ahead, not the whole ring',
      Math.abs(d.out.writeFrames() / SR - 4) < 0.2, `${(d.out.writeFrames() / SR).toFixed(2)} s`);
    ok('nothing is playing until play() — load does not start audio',
      d.status === 'loaded' && d.out.playing() === false);

    /**
     * WIDENED PER STEM. The four-stem form checked plane 0 (drums.L) and plane 7
     * (vocals.R) and inferred the six planes between them. `vocals` is still at
     * index 3 so plane 7 is still vocals.R — which means that assertion stayed
     * GREEN at six stems while saying nothing at all about guitar (8/9) or piano
     * (10/11). Every stem is now named.
     */
    const ref = track(200).stems;
    const misplaced = STEMS.filter((s) =>
      Math.abs(d.out.planes[planeL(S_IDX[s])][100] - ref[s][0][100]) > 1e-4 ||
      Math.abs(d.out.planes[planeR(S_IDX[s])][100] - ref[s][1][100]) > 1e-4);
    ok('every stem lands on its own plane pair, model order, L then R',
      misplaced.length === 0, misplaced.length ? `wrong: ${misplaced.join(',')}` : `${STEMS.length}/${STEMS.length}`);
    ok('the passthrough planes (12/13, not 8/9) stay silent — nothing was skipped, ' +
       'so there is nothing to substitute (a cached deck has no ladder)',
      d.out.planes[PASS_PLANE_L][1000] === 0 && d.out.planes[PASS_PLANE_R][1000] === 0 &&
      PASS_PLANE_L === 12);

    d.play();
    ok('play() starts the worklet consuming', d.status === 'playing' && d.out.playing());
    // drain the way the worklet does, then let the timer's work happen
    Atomics.store(d.out.hdr, 1, d.out.readFrames() + 44100 * 2);
    const beforeHead = d.writeHead;
    d.fill();
    ok('it tops up as the worklet consumes, and stays near the look-ahead',
      d.writeHead > beforeHead && Math.abs(d.out.cushion() / SR - 4) < 0.3,
      `head ${beforeHead} -> ${d.writeHead}, cushion ${(d.out.cushion() / SR).toFixed(2)} s`);
    ok('the transport position follows the READ pointer, not the write head',
      Math.abs(d.positionSec() - 2) < 0.01, `${d.positionSec().toFixed(3)} s`);

    d.seek(30);
    ok('seek repositions and refills (a live deck cannot do this — it would have ' +
       'to re-run the model over the new causal window first)',
      d.writeHead > 30 * SR && Math.abs(d.positionSec() - 30) < 0.01,
      `position ${d.positionSec().toFixed(2)} s, head ${(d.writeHead / SR).toFixed(2)} s`);
    ok('and it is still playing after the seek', d.out.playing());

    /**
     * AMENDED 2026-08-15. The old form asserted `latencySec() === 0.048` under the
     * name "the output buffer and NOTHING else", and it went red the day the
     * shared `stem-playback` worklet grew transpose lanes. THE CODE WAS RIGHT: a
     * cached deck now genuinely carries PITCH_GROUP_DELAY_SAMPLES / SR = 69.7 ms
     * of group delay at EVERY setting including 0 (the drums take a matched
     * delay, which is what keeps the four planes aligned), and cacheddeck.js
     * reports it because ui/audio-math.js::syncCorrection locks the video to this
     * number against a 60 ms threshold — omitting a constant 69.7 ms would not be
     * a rounding error, it would be a permanent one-sided correction.
     *
     * So the PREMISE was stale, not the check, and the replacement keeps every
     * tooth the original had. It is still an EQUALITY to 1e-9, so it admits
     * exactly two terms and nothing else: any leak makes it red by four to six
     * orders of magnitude past the tolerance. What it rejects, in the units it
     * would be wrong by —
     *   a hop         (1.95 s at the default) -> off by 1.95, 2e9 x tolerance
     *   a cushion     (LIVE_CUSHION_SEC 0.4)  -> off by 0.40, 4e8 x tolerance
     *   an inference  (~0.74 s of T_inf)      -> off by 0.74, 7e8 x tolerance
     *   a SECOND group delay (double-counted) -> off by 0.0697, 7e7 x tolerance
     *   the group delay dropped altogether    -> off by 0.0697, same
     * and the last two are the ones the old form could not see at all: it would
     * have gone green on a build that silently stopped applying the transpose
     * delay, which is the build the video lock breaks on.
     *
     * ENTRY POINT: CachedDeck.latencySec(). LivePipeline has a same-named method
     * with a different contract (it adds the capture-to-playhead counter
     * difference) and this says nothing about it.
     */
    ok('a cached deck\'s latency is the output buffer plus the transpose group ' +
       'delay and nothing else — no hop, no cushion, no inference',
      Math.abs(d.latencySec() - (0.048 + PITCH_GROUP_DELAY_SAMPLES / SR)) < 1e-9,
      `${(d.latencySec() * 1000).toFixed(1)} ms = 48.0 out + ${(PITCH_GROUP_DELAY_SAMPLES / SR * 1000).toFixed(1)} transpose`);
    const st = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
    ok('its LIVE_STATE has the same shape as a live deck, with the inapplicable ' +
       'fields pinned to "not applicable"',
      st && st.source === 'cache' && st.hopSec === null && st.drops === 0 &&
      st.passthroughNow === false && st.primedPct === 1 && st.durationSec === 60,
      st ? JSON.stringify({ source: st.source, hopSec: st.hopSec, drops: st.drops, dur: st.durationSec }) : 'none');
    /**
     * `atMs` is what makes `positionSec` usable by the video lock — without it
     * the reader cannot tell a 5 ms-old sample from a 95 ms-old one, and the
     * difference is larger than syncCorrection's whole threshold. Asserted as a
     * PRESENT, PLAUSIBLE timestamp: `st.atMs != null` alone would pass on a
     * hard-coded 0, which is precisely the sample age it would then claim.
     */
    ok('every LIVE_STATE stamps WHEN the playhead was sampled, on the wall clock ' +
       'the page also has (Date.now, not performance.now)',
      st && Number.isFinite(st.atMs) && Math.abs(st.atMs - Date.now()) < 60_000,
      st ? `atMs ${st.atMs} vs now ${Date.now()}` : 'none');

    /**
     * ENTRY POINT: offscreen/engine.js reconcileMaster(), which applies the dual-deck
     * trim the moment a second deck loads — and for a cached deck that can be
     * BEFORE ensureGraph() has built the node. The live pipeline learned this
     * the expensive way: -3 dB in the field, unity in the worklet.
     */
    const d4 = mkDeck();
    d4.setMasterGain(-3, true);
    ok('a master gain set BEFORE the graph exists is stored, not dropped',
      d4.masterDb === -3 && d4.masterAuto === true && d4.masterUserSet === false);
    const posted = [];
    await d4.load(track(20000));
    d4.node.port.postMessage = (x) => posted.push(x);
    d4.pushMaster();
    // Slot G_MASTER = STEMS.length + 1 = 7. It was 5 at four stems — and 5 is
    // now the PIANO stem, so the literal would have latched -3 dB onto a stem
    // fader and reported the master as pushed.
    ok(`...and load() pushes it on slot ${G_MASTER}, so the worklet ends up agreeing with the field`,
      posted.some((x) => x.t === 'gain' && x.i === G_MASTER && Math.abs(x.value - Math.pow(10, -3 / 20)) < 1e-9),
      JSON.stringify(posted));
    d4.setMasterGain(-6, false);
    ok('a USER master gain latches masterUserSet, so the engine default stops ' +
       'moving it — the same latch as the live deck',
      d4.masterUserSet === true && d4.masterAuto === false && d4.masterDb === -6);

    // end of track
    const d2 = mkDeck();
    await d2.load(track(20000));
    d2.play();
    Atomics.store(d2.out.hdr, 1, 20000);
    d2.fill();
    ok('a track that runs out ends cleanly rather than starving',
      d2.status === 'ended' && d2.out.playing() === false, d2.status);

    const d3 = mkDeck();
    let threw = null;
    try { await d3.load({ stems: { drums: [new Float32Array(10)] }, frames: 10, meta: {} }); } catch (e) { threw = e; }
    ok('a malformed entry is refused at load, not discovered mid-playback',
      threw !== null && /stem/.test(threw.message), threw ? threw.message : 'accepted');

    /**
     * REACHABLE, and that is the whole reason this block exists rather than more
     * assertions inside `extension/engine/bpmtap.js`. That file proves the
     * DETECTOR against a ring it builds itself; the `live` group above proves
     * `offscreen/live.js` wires it. NEITHER of them can see whether a CachedDeck
     * calls `tick()`, hands it THIS deck's ring, puts the payload on the wire, or
     * clears it on the lifecycle — and the cached deck is the one the play-along
     * user is on, because `offscreen/engine.js` swaps deck A to it on a cache hit, i.e.
     * on the SECOND listen to any track.
     *
     * Every assertion below drives the real `CachedDeck` through `load()`,
     * `seek()`, `stop()` and `pushState()` and reads what actually went out on
     * `send`. The deck streams the fixture into its own stem ring through the
     * real `fill()`, so the audio the tap sees got there the way the product puts
     * it there.
     */
    head('cache — the tempo tap: on the wire, on the drums planes, cleared by seek');
    {
      const { BPM_MAX_BLOCKS_PER_TICK, beatPhaseAt } = await import('./extension/engine/bpmtap.js');
      const { KEY_ACCUM_HZ } = await import('./extension/shared/config.js');
      /**
       * cacheddeck.js's own constant, re-typed here on purpose: it is module-
       * private (deliberately — see that file's note on why it is not
       * KEY_ACCUM_HZ). The cadence rows below BRACKET it rather than restate it,
       * so this copy going stale is a red and not a silent agreement.
       */
      const BPM_ACCUM_HZ = 10;

      // ---- a drum kit, not a tone. Same synthesis as bpmtap.js's suite.
      const kick = (buf, at, amp) => {
        const n = Math.round(0.12 * SR);
        for (let i = 0; i < n; i++) {
          const t = i / SR, j = at + i;
          if (j >= 0 && j < buf.length) buf[j] += amp * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.045);
        }
      };
      const clickTrain = (bpm, sec) => {
        const buf = new Float32Array(Math.round(sec * SR));
        const beat = 60 / bpm * SR;
        for (let b = 0; b * beat < buf.length; b++) kick(buf, Math.round(b * beat), 1.0);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / peak;
        return buf;
      };
      /** A cache entry carrying `pcm` on ONE named stem and digital silence on the other five. */
      const stemTrack = (pcm, name) => {
        const frames = pcm.length;
        const quiet = new Float32Array(frames);      // read-only in fill(), so one copy is enough
        const stems = {};
        for (const s of STEMS) stems[s] = [0, 1].map(() => (s === name ? pcm : quiet));
        return { stems, frames, meta: { videoId: 'v', title: name } };
      };

      /**
       * 0.4 s — four 4410-frame blocks, which is `BPM_MAX_BLOCKS_PER_TICK`. The
       * worklet's consumption and the tap's intake advance at the same rate, so
       * the tap is never behind and never asked for audio the fill has not
       * written. That is the real steady state of a cached deck.
       */
      const STEP = 4410 * BPM_MAX_BLOCKS_PER_TICK;
      /**
       * Drive a real CachedDeck the way the product does: load, play, and then
       * drain-and-top-up on the heartbeat. `fill()` is the real one, so the
       * fixture reaches the ring through the same code path a cached track does.
       *
       * Rolling `bpmAt` back ONE PERIOD before each push is deliberate and is NOT
       * the thing under test: it opens the wall-clock gate so a synchronous burst
       * delivers the blocks that a real 0.1 s of wall time would. The gate itself
       * is bracketed separately below, by count, at its own entry point.
       *
       * IT IS `now - period`, NOT `0` — `performance.now()` in node is uptime, so
       * `bpmAt = 0` asks "is the process older than 95 ms?", which is a question
       * about the machine (the `live` group above paid a red for exactly that).
       *
       * `keyTap.tick` is stubbed for cost only: hundreds of 16384-point FFTs for
       * a detector that has its own suite and nothing to do with this claim.
       */
      const driveCached = async (trk) => {
        const d = mkDeck();
        d.keyTap.tick = () => 0;
        sent.length = 0;
        await d.load(trk);
        /**
         * ANCHOR THE CURSOR DETERMINISTICALLY, and this line is here for the same
         * reason `bpmAt` is rolled back to `now - period` rather than set to 0.
         * `load()` sets `bpmAt = 0` and then pushes once; in node
         * `performance.now()` is UPTIME, so whether that push feeds the tap
         * depends on whether the process happens to be older than the 95 ms gate
         * — which differs between `node test.js` and `node test.js cache`. Fed,
         * the cursor anchors at the 4 s `load()` buffered; refused, it anchors one
         * block later on the first loop iteration, and the whole estimate schedule
         * shifts. Neither is wrong and the difference is invisible in a browser
         * (a real document is seconds old before a deck loads), but it would make
         * this block's printed evidence a function of the machine. One forced,
         * gate-open push pins it.
         */
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.pushState();
        d.play();
        let pushes = 0;
        while (d.writeHead + STEP < trk.frames) {
          Atomics.store(d.out.hdr, H_READ, d.out.readFrames() + STEP);
          d.fill();
          d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
          d.pushState();
          pushes++;
        }
        return { d, pushes, last: sent.filter((m) => m.type === 'LIVE_STATE').at(-1) };
      };

      const CONTRACT = ['state', 'bpm', 'confidence', 'beatFrame'];
      const TOL = 1.5;   // bpmtap.js's own tolerance: one 0.25 lag step at the fast end
      /**
       * The `bpm` payload of a LIVE_STATE, or null. Every row below is written
       * `!!bpmOf(m) && <check>` and NEVER `!bpmOf(m) || <check>`: a message that
       * does not carry the field is the failure this block exists to prevent, not
       * an excuse from checking (AGENTS.md, "an assertion must FAIL when it cannot
       * look"). It is a helper rather than an inline guard so that a build with
       * the field deleted goes RED on every row that reads it, instead of going
       * red on two and then throwing a TypeError that takes the remaining
       * assertions — and the rest of the `cache` group — with it. A crash is loud
       * but it is not a verdict, and it denies one to everything after it.
       */
      const bpmOf = (m) => (m && m.bpm) || null;
      const a128 = await driveCached(stemTrack(clickTrain(128, 26), 'drums'));
      const b92 = await driveCached(stemTrack(clickTrain(92, 26), 'drums'));

      ok('a CachedDeck\'s LIVE_STATE carries `bpm`, and it is the four-field contract with a state the UI can switch on',
        !!bpmOf(a128.last) && CONTRACT.every((k) => k in a128.last.bpm) &&
        ['none', 'listening', 'locked', 'fault'].includes(a128.last.bpm.state),
        bpmOf(a128.last) ? JSON.stringify(a128.last.bpm) : `NO bpm FIELD in the last of ${sent.length} messages`);
      {
        // LIVE_STATE crosses chrome.runtime, which is JSON. `undefined` and NaN
        // both survive the assertion above and neither survives the wire.
        const round = a128.last ? JSON.parse(JSON.stringify(a128.last)) : null;
        ok('...and it JSON round-trips unchanged (no undefined, no NaN, no bigint)',
          !!bpmOf(round) && !!bpmOf(a128.last) && JSON.stringify(round.bpm) === JSON.stringify(a128.last.bpm) &&
          CONTRACT.every((k) => round.bpm[k] === null || !Number.isNaN(round.bpm[k])),
          bpmOf(round) ? JSON.stringify(round.bpm) : 'nothing to round-trip');
      }
      // THE HYPOTHESIS: the wire number comes from THIS deck's drums planes.
      ok('a 128 BPM cached track locks, and the number reaches the wire',
        !!bpmOf(a128.last) && a128.last.bpm.state === 'locked' && Math.abs(a128.last.bpm.bpm - 128) <= TOL,
        bpmOf(a128.last) ? `read ${a128.last.bpm.bpm} against 128.00, tol ±${TOL}, conf ${a128.last.bpm.confidence}, over ${a128.pushes} heartbeats` : 'no bpm on the wire');
      /**
       * THE CONTROL, AND IT CAN LOSE. A `bpm` field wired to a constant, echoed
       * from the live deck, or read off some other ring passes the row above and
       * fails this one — the two decks run identical code and differ only in the
       * audio their own `fill()` published.
       */
      ok('a second cached track at 92 BPM reports 92, so the wire value tracks THIS deck\'s ring and not the harness',
        !!bpmOf(b92.last) && !!bpmOf(a128.last) && b92.last.bpm.state === 'locked' &&
        a128.last.bpm.bpm !== null && Math.abs(b92.last.bpm.bpm - 92) <= TOL &&
        Math.abs((a128.last.bpm.bpm - b92.last.bpm.bpm) - 36) <= 2 * TOL,
        bpmOf(b92.last) && bpmOf(a128.last) ? `128 - 92 = 36.00 true, ${a128.last.bpm.bpm} - ${b92.last.bpm.bpm} = ${(a128.last.bpm.bpm - b92.last.bpm.bpm).toFixed(2)} read` : 'no bpm on the wire');
      /**
       * THE TAP POINT, and this control can lose too. The identical stimulus on
       * `other` (planes 4/5, the KEY tap's planes) must produce no tempo at all.
       * A wiring that handed BpmTap the wrong planes, the passthrough pair or a
       * mono mix passes one of these two rows and fails the other; there is no
       * wiring that passes both except the right one.
       */
      {
        const wrong = await driveCached(stemTrack(clickTrain(128, 26), 'other'));
        ok('the same drums published on the `other` stem produce NO tempo — the tap is on drums, on this deck\'s stem ring',
          !!bpmOf(wrong.last) && wrong.last.bpm.state === 'none' && wrong.last.bpm.bpm === null &&
          wrong.d.bpmTap.stats().audibleBlocks === 0 && wrong.d.bpmTap.stats().blocks > 100,
          bpmOf(wrong.last) ? `${JSON.stringify(wrong.last.bpm)} after ${wrong.d.bpmTap.stats().blocks} blocks read, ${wrong.d.bpmTap.stats().audibleBlocks} audible` : 'no bpm on the wire');
      }
      // The consumer's only entry point into `beatFrame`, driven off the wire
      // value rather than off the tap, because the wire is what the UI gets.
      // NOTE the frame is on the RING clock, not the track clock — the two differ
      // by `readBase` after a seek, and beatPhaseAt is invariant to that.
      ok('beatPhaseAt() reads the cached deck\'s wire payload straight: 0 on the beat, 0.5 half a beat later',
        (() => {
          const p = bpmOf(a128.last);
          if (!p || p.beatFrame === null || p.bpm === null) return false;
          const period = 60 / p.bpm * SR;
          return beatPhaseAt(p, p.beatFrame, SR) === 0 &&
            Math.abs(beatPhaseAt(p, p.beatFrame + period / 2, SR) - 0.5) < 0.01;
        })(),
        bpmOf(a128.last) ? `beatFrame ${a128.last.bpm.beatFrame}` : 'no bpm on the wire');

      /**
       * ============================ THE PLAYHEAD THE PHASE IS MEASURED AGAINST
       *
       * ENTRY POINT: `CachedDeck.pushState()`, the same publisher every row above
       * reads — `a128.last` is the last LIVE_STATE the 128 BPM cached run actually
       * put on the wire. The live deck's identical claim lives in the `live` group
       * at its own entry point (`LivePipeline.pushState`); this one is here
       * because `offscreen/engine.js` swaps deck A to a CachedDeck on a cache hit, so the
       * embed reaches THIS file on the second listen to any track, and a pulse
       * that works on first play and is dead on replay is the failure this row
       * exists to prevent.
       *
       * IT IS THE OUTPUT RING'S *READ* COUNTER, on the axis `bpm.beatFrame` is on.
       * Not the write head, and not the track position in frames.
       *
       * THE CONTROL CAN LOSE — against the write head, here. `driveCached` drains
       * and tops up, so the ring carries seconds of cushion and the two counters
       * are far apart: a `playFrames` wired to `writeFrames()` passes every "the
       * field is present and finite" test and fails this one. The THIRD competing
       * quantity, `positionSec * SR`, coincides with the read counter on this run
       * because `readBase` is 0 until something seeks — so it is REPORTED here
       * rather than asserted, and the discrimination that can lose against it is
       * the post-seek row below. A row that cannot separate two quantities must
       * say so instead of scoring the coincidence as evidence.
       */
      ok('a CachedDeck\'s LIVE_STATE.playFrames is the deck output ring\'s READ counter, not its write head',
        !!a128.last && a128.last.playFrames === a128.d.out.readFrames()
          && a128.last.playFrames !== a128.d.out.writeFrames(),
        a128.last
          ? `wire ${a128.last.playFrames}, readFrames() ${a128.d.out.readFrames()}, ` +
            `writeFrames() ${a128.d.out.writeFrames()}, heads ` +
            `${((a128.d.out.writeFrames() - a128.d.out.readFrames()) / SR).toFixed(2)} s apart; ` +
            `positionSec*SR ${Math.round(a128.last.positionSec * SR)} COINCIDES here ` +
            `(readBase ${a128.d.readBase}) — separated after a seek, below`
          : 'no LIVE_STATE');

      /**
       * ...AND THE PAIR COMPOSES INTO A PHASE. ENTRY POINT: `beatPhaseAt(payload,
       * frame, sr)` fed the way `embed.js::beatFrameNow()` feeds it — the wire
       * playhead advanced by the age of its own timestamp. Asserting the two
       * fields are merely PRESENT is not asserting the pulse can run, so this row
       * runs the composition and reads a phase back.
       *
       * `atMs` IS A `Date.now()`-SCALE WALL CLOCK, and that is the claim. The
       * offscreen document and the page have different `performance` time origins,
       * so their `performance.now()` values cannot be differenced; the epoch is
       * the one clock they share. The bound is deliberately loose and epoch-scale
       * — a `performance.now()`-scale value is process uptime and misses an epoch
       * bound by decades, while any real publish lag clears it. A tight bound here
       * would be a stopwatch claim wearing this row's name, and AGENTS.md says a
       * stopwatch measures the machine. On the live side the wrong clock still
       * produced a plausible-looking phase; only the epoch check rejected it.
       */
      {
        const AGE_BOUND_SEC = 60;
        const m = a128.last;
        const ageSec = m ? (Date.now() - Number(m.atMs)) / 1000 : NaN;
        const frame = m ? Number(m.playFrames) + ageSec * SR : NaN;
        const phase = m ? beatPhaseAt(m.bpm, frame, SR) : null;
        ok('a cached deck\'s (playFrames, atMs) pair composes into a real beat phase — one wall clock, one frame axis',
          !!m && Number.isFinite(ageSec) && ageSec >= 0 && ageSec < AGE_BOUND_SEC
            && Number.isFinite(frame) && typeof phase === 'number' && phase >= 0 && phase < 1,
          m ? `atMs age ${ageSec.toFixed(3)} s against a ${AGE_BOUND_SEC} s clock-scale bound, ` +
              `frame ${m.playFrames} advanced to ${frame.toFixed(0)}, phase ${phase}`
            : 'no LIVE_STATE');
      }

      /**
       * AND IT MUST FAIL WHEN IT CANNOT LOOK. ENTRY POINT: `pushState()` on a
       * cached deck that has not loaded — no `ensureGraph()`, so no output ring.
       * That is the state deck A is in for every push between the swap and the
       * first `load()`.
       *
       * ABSENT, NEVER ZEROED. Frame 0 is a real position the ring takes at the
       * start of every run (and immediately after every seek — see below), and
       * `embed.js::beatFrameNow()` discriminates on `Number.isFinite`, so a zeroed
       * field would light the pulse against a playhead nobody sampled. `atMs` is
       * asserted finite in the same row because "the message went out at all" is
       * what makes the missing field evidence of a decision rather than of a
       * dropped publish.
       */
      {
        const d = mkDeck();          // never loaded: out === null
        sent.length = 0;
        d.pushState();
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a cached deck with no output ring OMITS playFrames — absent, never zeroed — and still timestamps the message',
          !!m && !('playFrames' in m) && Number.isFinite(m.atMs)
            && !Number.isFinite(Number(m.playFrames)),
          m ? `playhead keys on the wire ${JSON.stringify(Object.keys(m).filter((k) => /play/i.test(k)))}, ` +
              `Number(m.playFrames) ${String(Number(m.playFrames))}, atMs ${m.atMs}`
            : `no LIVE_STATE in ${sent.length} messages`);
      }

      /**
       * A SEEK MUST NOT LEAVE A STALE PLAYHEAD, and this is the row where the
       * three candidate quantities are finally SEPARATED. ENTRY POINT:
       * `CachedDeck.seek()`, which is the cached deck's primary gesture.
       *
       * `seek()` calls `out.reset()` — both ring counters go back to 0 — and moves
       * `readBase` to the new position. So after seeking to 5 s of a track played
       * to ~20 s, the three quantities that could be published under this name are
       * hundreds of thousands of frames apart:
       *
       *   readFrames()            0        the ring axis, which `beatFrame` is on
       *   the pre-seek playhead   ~20 s    what a stale field would still say
       *   positionSec * SR        ~5 s     the TRACK axis, `readBase + read`
       *
       * and the tempo tap is reset in the same breath, so both sides of the phase
       * restart together. A publisher wired to `readBase + readFrames()` or to
       * `positionSec * SR` is red here and green everywhere else in this group.
       *
       * The `0` is also why the omission above is written `=== null` and not a
       * falsy test: frame 0 is a REAL sample here and must reach the wire.
       */
      {
        const d = mkDeck();
        d.keyTap.tick = () => 0;
        await d.load(stemTrack(clickTrain(128, 40), 'drums'));
        d.play();
        // consume 20 s the way the worklet does, topping the ring up each second
        for (let i = 0; i < 20; i++) {
          Atomics.store(d.out.hdr, H_READ, d.out.readFrames() + SR);
          d.fill();
        }
        sent.length = 0;
        d.pushState();
        const before = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        d.seek(5);
        const after = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        const trackFrames = Math.round(after ? after.positionSec * SR : NaN);
        ok('a seek republishes the playhead on the RING axis — 0, present, and neither the pre-seek frame nor the track position',
          !!before && !!after && before.playFrames > 10 * SR &&
          'playFrames' in after && after.playFrames === d.out.readFrames() &&
          after.playFrames === 0 && Math.abs(trackFrames - 5 * SR) < SR &&
          d.readBase === 5 * SR,
          before && after
            ? `playFrames ${before.playFrames} -> ${after.playFrames} (readFrames() ${d.out.readFrames()}), ` +
              `while positionSec*SR is ${trackFrames} and readBase is ${d.readBase} — ` +
              `ring axis and track axis ${((trackFrames - after.playFrames) / SR).toFixed(2)} s apart`
            : 'no LIVE_STATE');
      }

      /**
       * THE COST, AS A COUNT AND NEVER AS A CLOCK (AGENTS.md: a gate whose verdict
       * changes on code that did not change is measuring the machine). The bound
       * that keeps this off the fill timer is "a tick does a fixed, small amount
       * of work however far the fill loop ran ahead", and that is countable
       * exactly. Read off the real run, not a fresh tap.
       */
      ok('the whole cached run never consumed more than the per-tick block cap, however far fill() jumped ahead',
        a128.d.bpmTap.stats().blocks > 100 && a128.d.bpmTap.lastTickBlocks <= BPM_MAX_BLOCKS_PER_TICK &&
        a128.d.bpmTap.stats().staleBlocks === 0,
        `${a128.d.bpmTap.stats().blocks} blocks over ${a128.d.bpmTap.stats().estimates} estimates, ` +
        `last tick ${a128.d.bpmTap.lastTickBlocks} against a cap of ${BPM_MAX_BLOCKS_PER_TICK}, ${a128.d.bpmTap.stats().staleBlocks} stale`);

      // ======================================================= THE SEEK CASE
      /**
       * THE REASON THIS WHOLE BLOCK EXISTS. Seeking is the cached deck's primary
       * gesture — it is the deck that CAN seek, which is why the play-along user
       * is on it — and `seek()` calls `out.reset()`, which puts the ring's write
       * pointer back to 0 while the tap's cursor is still a million frames ahead.
       * `w - cursor` is then NEGATIVE: the catch-up threshold cannot fire, the
       * `cursor + n <= w` loop never runs, no block is read, no refusal is
       * counted and no `envBreak` is recorded. A tap that was not reset here goes
       * on reporting the PRE-SEEK tempo forever with clean-looking stats.
       *
       * REACHABLE: this drives the real `seek()`, not `bpmTap.reset()`. An
       * implementation with the reset line deleted passes every row above.
       */
      {
        const d = a128.d;
        const before = d.bpmPayload();
        const cursorBefore = d.bpmTap.cursor;
        const writeBefore = d.out.writeFrames();
        const filledBefore = d.bpmTap.stats().filled;
        sent.length = 0;
        d.seek(5);
        const duringSeek = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        // the next heartbeat, which is where the cursor re-anchors on the new ring
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.pushState();
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);

        ok('seek() puts the write pointer BEHIND the tap\'s cursor — the state the silent-hold failure needs',
          writeBefore > 0 && cursorBefore > 0 && filledBefore > 0 && d.out.writeFrames() < cursorBefore,
          `write ${writeBefore} -> ${d.out.writeFrames()}, cursor was ${cursorBefore}, ${filledBefore} envelope samples held`);
        /**
         * `cursor` is NOT asserted null: the heartbeat above re-anchors it on the
         * new ring, and that RE-ANCHORING is the property that matters. Left at
         * the old position's value it would sit permanently ahead of a write
         * pointer that restarted at 0. So the claim is that it came back BELOW
         * where it was — an implementation that drops the envelope and leaks the
         * cursor passes `filled === 0` and fails here.
         */
        ok('cached-seek-clears-the-tempo-tap: a seek drops the locked tempo, the envelope AND the cursor',
          before.state === 'locked' && !!bpmOf(after) && after.bpm.state === 'none' &&
          after.bpm.bpm === null && after.bpm.beatFrame === null &&
          d.bpmTap.stats().filled === 0 && d.bpmTap.stats().audibleBlocks === 0 &&
          d.bpmTap.stats().cursor !== null && d.bpmTap.stats().cursor < cursorBefore,
          `${before.state} ${before.bpm} -> ${bpmOf(after) ? after.bpm.state + ' ' + after.bpm.bpm : 'NO bpm ON THE WIRE'}, ` +
          `${filledBefore} -> ${d.bpmTap.stats().filled} envelope samples, cursor ${cursorBefore} -> ${d.bpmTap.stats().cursor}`);
        /**
         * product ruling 8, at the `seek()` entry point. The message `seek()` itself
         * publishes must ALREADY be clear: the reset lines sit above the
         * `pushState()` at the bottom of that method, so there is no window in
         * which the wire carries the pre-seek tempo against a post-seek playhead.
         * Move the reset below the push and this row goes red on its own.
         */
        ok('...and the LIVE_STATE seek() itself emits is already clear — no window where the wire pairs the old tempo with the new playhead',
          !!bpmOf(duringSeek) && duringSeek.bpm.state === 'none' && duringSeek.bpm.bpm === null,
          bpmOf(duringSeek) ? `${JSON.stringify(duringSeek.bpm)} at position ${duringSeek.positionSec} s` : 'no bpm on the LIVE_STATE seek() emitted');
      }

      // ================================================= the track change
      /**
       * Same mechanism, different entry point (AGENTS.md: an assertion about a
       * function with more than one caller must name the entry point). `load()`
       * also calls `out.reset()`, and a BPM held over from the previous track is
       * a WRONG readout rather than a stale one — and a correct-looking one.
       */
      {
        const d = b92.d;
        const before = d.bpmPayload();
        const cursorBefore = d.bpmTap.cursor;
        sent.length = 0;
        await d.load(stemTrack(clickTrain(128, 6), 'drums'));
        const duringLoad = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.pushState();
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        ok('cached-load-clears-the-tempo-tap: a new track reports `none`, not the previous track\'s BPM',
          before.state === 'locked' && !!bpmOf(after) && after.bpm.state === 'none' && after.bpm.bpm === null &&
          d.bpmTap.stats().filled === 0 && d.bpmTap.stats().cursor !== null &&
          d.bpmTap.stats().cursor < cursorBefore,
          `${before.state} ${before.bpm} -> ${bpmOf(after) ? after.bpm.state + ' ' + after.bpm.bpm : 'NO bpm ON THE WIRE'}, cursor ${cursorBefore} -> ${d.bpmTap.stats().cursor}`);
        /**
         * product ruling 8 at the `load()` entry point, and this is the row that
         * would have caught the live deck's priming-window carry-over. `load()`
         * emits exactly one LIVE_STATE and every reset precedes it, so the
         * previous track's tempo can never appear beside the new track's title.
         */
        ok('cached-load-emits-no-previous-track-bpm: the LIVE_STATE load() emits is already the new track\'s',
          !!bpmOf(duringLoad) && duringLoad.bpm.state === 'none' && duringLoad.bpm.bpm === null &&
          duringLoad.durationSec === 6,
          bpmOf(duringLoad) ? `${JSON.stringify(duringLoad.bpm)} on a ${duringLoad.durationSec} s track` : 'no bpm on the LIVE_STATE load() emitted');
      }
      {
        // stop() is the third lifecycle site, and the one that leaves the deck
        // idle with the field still on the wire.
        const { d } = await driveCached(stemTrack(clickTrain(128, 26), 'drums'));
        const before = d.bpmPayload();
        sent.length = 0;
        d.stop();
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        ok('stop() clears it too, and an idle deck still PUBLISHES the field — a missing `bpm` is not "no tempo" to a UI, it is whatever it painted last',
          before.state === 'locked' && !!bpmOf(after) && after.bpm.state === 'none' &&
          after.bpm.bpm === null && d.bpmTap.stats().filled === 0,
          bpmOf(after) ? `${before.state} ${before.bpm} -> ${JSON.stringify(after.bpm)}` : 'no bpm on the LIVE_STATE stop() emitted');
      }

      // ================================================= the cadence, as a COUNT
      /**
       * THE ENTRY POINT IS `pushState()`, which on a cached deck is the FILL_HZ
       * timer AND a forced push from load/play/pause/seek/stop/end-of-track.
       * Carried by counts of `tick()` calls, never by a stopwatch.
       *
       * The rows BRACKET the rate rather than restate it: roll the clock back one
       * whole period and the tap must be fed, roll it back HALF a period and it
       * must not. A tap given its own 20 Hz driver passes the first and fails the
       * second; a tap at 5 Hz fails the first. Both taps are counted in the same
       * loop, so "the same heartbeat as tickKey" is a compared quantity.
       */
      {
        const d = mkDeck();
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        let bpmTicks = 0, keyTicks = 0;
        d.bpmTap.tick = () => { bpmTicks++; return 0; };
        d.keyTap.tick = () => { keyTicks++; return 0; };
        const N = 20;

        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
        for (let i = 0; i < N; i++) d.pushState();
        ok(`${N} forced pushState() calls inside one gate window feed the cached deck's tempo tap ONCE — exactly like the key tap`,
          bpmTicks === 1 && keyTicks === 1, `bpm ${bpmTicks}, key ${keyTicks}`);

        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
          d.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
          d.pushState();
        }
        ok('a full period after the last block the tap is fed again — 20 heartbeats, 20 blocks, on both taps',
          bpmTicks === N && keyTicks === N, `bpm ${bpmTicks}/${N}, key ${keyTicks}/${N}`);

        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ / 2;
          d.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ / 2;
          d.pushState();
        }
        ok('half a period after the last block it is refused — the tap is on the 10 Hz heartbeat and not on a driver of its own',
          bpmTicks === 0 && keyTicks === 0,
          `bpm ${bpmTicks}, key ${keyTicks} over ${N} pushes at ${(1000 / BPM_ACCUM_HZ / 2).toFixed(0)} ms spacing ` +
          `(a 20 Hz gate would let ${N} through here and still pass the row above)`);

        // ...and it stops with the track, because pushState() does not.
        bpmTicks = 0;
        d.stop();
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        d.pushState();
        ok('a deck with no track is not fed at all (pushState still runs — the tap must decline, not the heartbeat)',
          bpmTicks === 0, `${bpmTicks} blocks with track === null`);
      }

      // ============================================== a fault is REPORTED state
      /**
       * The detector runs inside the heartbeat, so it may not throw into it — and
       * "degrades to no estimate" and "silently does nothing" are the same wire
       * value unless the failure is NAMED. That is the content of these rows: not
       * that the throw was caught, but that catching it is visible from outside.
       *
       * TWO ENTRY POINTS, TWO ASSERTIONS. `tick()` is caught in `tickBpm()` and
       * `payload()` in `bpmPayload()`; a guard on one is not a guard on the other.
       */
      {
        const d = mkDeck();
        const logs = [];
        d.s.log = (s) => logs.push(s);
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        const healthy = mkDeck().bpmPayload();
        d.bpmTap.tick = () => { throw new Error('synthetic tick fault'); };
        sent.length = 0;
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        let caught = null;
        try { d.pushState(); } catch (e) { caught = e; }
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a cached deck\'s tap that throws in tick() does not take pushState() down',
          caught === null, caught ? String(caught.message) : 'pushState returned normally');
        ok('...and the fault is on the wire as its own state, carrying the message and the count',
          !!bpmOf(m) && m.bpm.state === 'fault' && m.bpm.bpm === null && m.bpm.beatFrame === null &&
          /synthetic tick fault/.test(String(m.bpm.fault)) && m.bpm.faults === 1,
          bpmOf(m) ? JSON.stringify(m.bpm) : 'no bpm on the wire');
        /**
         * THE POINT OF THE FIFTH STATE, and the row that goes red if someone
         * "simplifies" the fault branch to return `none`. A broken detector and a
         * detector that has heard nothing must not be the same wire value — that
         * is a feature reporting success for the same reason a vacuous assertion
         * does.
         */
        ok('...and a FAULTED tap is distinguishable on the wire from one that has simply heard nothing',
          healthy.state === 'none' && !!bpmOf(m) && m.bpm.state !== healthy.state && !('fault' in healthy) &&
          'fault' in m.bpm && 'faults' in m.bpm,
          `healthy ${JSON.stringify(healthy)} vs faulted ${bpmOf(m) ? JSON.stringify(m.bpm) : 'NO bpm ON THE WIRE'}`);
        /**
         * Latched: off until the next load, one log line, and the counter does
         * not run away at 10 Hz for the life of the deck.
         *
         * REACHABILITY, checked rather than assumed (AGENTS.md: name the value
         * that would make this go red and ask whether it is reachable). The
         * `faults === 1` clause goes red on its own the moment `tickBpm()` stops
         * latching. The ONE LOG LINE clause does not: with the tick latch in
         * place `bpmFault_` cannot be entered twice, so deleting its own
         * `if (this.bpmFault) return;` changes nothing — that line is
         * defence-in-depth, and the clause only goes red when BOTH latches are
         * removed. Verified by breaking both on purpose. It is kept because it is
         * the clause that names the log-spam failure, and because the second
         * latch is what makes it true if a future caller reaches bpmFault_ from
         * somewhere other than a latched tick.
         */
        sent.length = 0;
        for (let i = 0; i < 10; i++) { d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ; d.pushState(); }
        const m2 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('the fault latches the tap off — 10 more heartbeats, still one throw, still one log line, still reported',
          !!bpmOf(m2) && m2.bpm.state === 'fault' && m2.bpm.faults === 1 && d.bpmFaults === 1 &&
          logs.filter((s) => /tempo tap faulted/.test(s)).length === 1,
          `faults ${d.bpmFaults}, ${logs.filter((s) => /tempo tap faulted/.test(s)).length} log line(s)`);
        /**
         * A SEEK DOES NOT CLEAR IT, and that is deliberate rather than an
         * oversight: a tick that threw part-way may have left the cursor or the
         * envelope torn, and retrying on torn state risks a confident lock — the
         * one output this feature must never produce. A seek is a discontinuity
         * inside one track; the track boundaries are what clear it.
         */
        sent.length = 0;
        d.seek(2);
        const m3 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a seek RESETS the tap but does not clear the latch — the fault belongs to the track, not to the playhead',
          !!bpmOf(m3) && m3.bpm.state === 'fault' && d.bpmFault !== null && d.bpmTap.stats().filled === 0,
          bpmOf(m3) ? `${JSON.stringify(m3.bpm)}, ${d.bpmTap.stats().filled} envelope samples` : 'no bpm on the wire');
        // ...and the next track clears it, or a transient fault would be
        // unclearable without reloading the offscreen document.
        d.bpmTap.tick = () => 0;
        sent.length = 0;
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        const m4 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('and load() clears it, so a transient fault does not need a document reload',
          !!bpmOf(m4) && m4.bpm.state === 'none' && d.bpmFault === null && d.bpmFaults === 0,
          bpmOf(m4) ? `${JSON.stringify(m4.bpm)}, fault ${d.bpmFault}` : 'no bpm on the wire');
      }
      {
        // The OTHER entry point. Same claim, different guard.
        const d = mkDeck();
        d.s.log = () => {};
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        d.bpmTap.payload = () => { throw new Error('synthetic payload fault'); };
        sent.length = 0;
        let caught = null;
        try { d.pushState(); } catch (e) { caught = e; }
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a cached deck\'s tap that throws in payload() does not take pushState() down either, and reports the same way',
          caught === null && !!bpmOf(m) && m.bpm.state === 'fault' && m.bpm.faults >= 1 &&
          /synthetic payload fault/.test(String(m.bpm.fault)),
          caught ? String(caught.message) : bpmOf(m) ? JSON.stringify(m.bpm) : 'no bpm on the wire');
      }
    }
  }

  head('cache — audio-clock-driven video sync (AUDIO.md §8.2)');
  // REACHABLE: this IS the function CachedDeck calls. Pure, so it needs no
  // browser. What it cannot see is the <video> element actually obeying it —
  // that is the browser check, once measurement is cleared.
  {
    const at = (a, v) => syncCorrection(a, v);
    ok('within 60 ms: leave it alone (chasing sub-JND error looks worse than the error)',
      at(10, 10.03).action === 'none' && at(10, 9.95).action === 'none',
      `+30 ms -> ${at(10, 10.03).action}, -50 ms -> ${at(10, 9.95).action}`);
    ok('the 60 ms boundary is inclusive and starts a soft correction',
      at(10, 10.06).action === 'rate' && at(10, 10.0599).action === 'none');
    const ahead = at(10, 10.2), behind = at(10, 9.8);
    ok('video AHEAD is slowed to 0.98, video BEHIND is sped to 1.02',
      ahead.action === 'rate' && Math.abs(ahead.playbackRate - 0.98) < 1e-12 &&
      behind.action === 'rate' && Math.abs(behind.playbackRate - 1.02) < 1e-12,
      `+200 ms -> ${ahead.playbackRate}, -200 ms -> ${behind.playbackRate}`);
    ok('the soft correction never exceeds 2 % (beyond a few percent it judders)',
      [0.06, 0.1, 0.3, 0.499].every((e) => Math.abs(at(10, 10 + e).playbackRate - 1) <= 0.02 + 1e-12));
    ok('>= 500 ms is a hard seek to the AUDIO clock, not a rate nudge',
      at(10, 10.5).action === 'seek' && at(10, 10.5).seekTo === 10 &&
      at(10, 9.4).action === 'seek' && at(10, 9.4).seekTo === 10);
    ok('a 2 % correction closes a 100 ms error in ~5 s (the reason 2 % is enough)',
      Math.abs(0.100 / 0.02 - 5) < 1e-12);
    ok('...and would take 25 s at 500 ms, which is why that one seeks instead',
      0.500 / 0.02 === 25);
    ok('the error sign is video-minus-audio, so the caller can display it',
      Math.abs(at(10, 10.2).errorSec - 0.2) < 1e-12 && Math.abs(at(10, 9.8).errorSec + 0.2) < 1e-12);
  }

  head('cache — the sync loop reads a STALE playhead, and compensates for it');
  /**
   * ENTRY POINT: `embed/ui/embed.js` syncVideoLock(), the only caller. It reads
   * `LIVE_STATE.positionSec`, which was true at `atMs` and arrives 50-100 ms
   * later (10 Hz publish + a chrome.runtime hop).
   *
   * This exists because the lag is the SAME SIZE as syncCorrection's 60 ms
   * threshold. The first assertion is the one that matters: it shows the
   * uncompensated read tripping a correction that is not real, so deleting
   * `audioClockAt` cannot pass.
   */
  {
    const T0 = 1_700_000_000_000;
    // A perfectly locked pair: the audio playhead and the video are both at
    // 30.000 s. The engine sampled the playhead 90 ms ago.
    const pos = 30.0, atMs = T0 - 90, videoSec = 30.09;

    ok('UNCOMPENSATED, a perfectly locked video reads as 90 ms of error and is ' +
       'corrected — the bug this function exists to prevent',
      syncCorrection(pos, videoSec).action === 'rate',
      `${syncCorrection(pos, videoSec).action}, err ${(syncCorrection(pos, videoSec).errorSec * 1000).toFixed(0)} ms`);
    ok('COMPENSATED, the same pair reads as locked and nothing is touched',
      syncCorrection(audioClockAt(pos, atMs, T0), videoSec).action === 'none',
      `err ${(syncCorrection(audioClockAt(pos, atMs, T0), videoSec).errorSec * 1000).toFixed(0)} ms`);
    ok('it advances the playhead by exactly the sample age',
      Math.abs(audioClockAt(30, T0 - 250, T0) - 30.25) < 1e-9,
      `${audioClockAt(30, T0 - 250, T0)}`);
    ok('a REAL error still survives compensation — it corrects the clock, not the ' +
       'measurement (a 300 ms lead is still a 300 ms lead)',
      syncCorrection(audioClockAt(pos, atMs, T0), 30.39).action === 'rate' &&
      Math.abs(syncCorrection(audioClockAt(pos, atMs, T0), 30.39).errorSec - 0.3) < 1e-9);
    ok('a backwards wall clock does not rewind the playhead — Date.now() can step, ' +
       'and inventing a negative age would be inventing an error',
      audioClockAt(30, T0 + 500, T0) === 30);
    ok('an absent position is 0, not NaN — a NaN playhead makes every comparison ' +
       'false and syncCorrection would silently return "none" forever',
      audioClockAt(undefined, T0, T0) === 0 && audioClockAt(30, undefined, T0) === 30);
  }

  head('cache — a cached deck starts where the USER is, not at the top');
  /**
   * ENTRY POINT: offscreen/engine.js playCachedAtPage(), on both routes into cached
   * audio — the first LIVE_START after a cache hit, and every resume after it.
   * Both defects it prevents are SILENT: one plays the wrong part of the song,
   * the other plays nothing at all.
   */
  {
    ok('a cache hit on a video the user is 90 s into starts at 90 s, not at 0 — ' +
       'otherwise the video lock drags the picture back to 0:00 and it reads as ' +
       'the deck hijacking the transport',
      resumeSeek(0, 'loaded', 90) === 90);
    ok('an ordinary pause/resume does NOT flush the ring for drift the video ' +
       'lock already handles',
      resumeSeek(90.0, 'paused', 90.05) === null);
    ok('...but a scrub does, because that is a different part of the song',
      resumeSeek(90, 'paused', 130) === 130);
    /**
     * THE REPLAY. This is the first gesture anyone makes after a prime finishes:
     * the track ended, press play again. Without the rewind the deck's write
     * head is parked at the end and play() re-ends it on the next fill — silent
     * audio, no error, nothing in any log.
     */
    ok('a deck that ran to the end REWINDS on play, even with no page to follow',
      resumeSeek(240, 'ended', null) === 0);
    ok('...and follows the page when there is one (YouTube seeks to 0 to replay)',
      resumeSeek(240, 'ended', 0) === 0);
    ok('a loaded deck with no page transport plays from where it is',
      resumeSeek(0, 'loaded', null) === null);
    ok('a non-numeric page position is ignored rather than seeking to NaN — ' +
       'a NaN seek clamps to frame 0 and silently restarts the track',
      resumeSeek(90, 'playing', NaN) === null && resumeSeek(90, 'playing', undefined) === null);
  }

  head('cache — the track identity, and it is a NAME not an acquisition path (L1)');
  {
    const ID = 'dQw4w9WgXcQ';
    ok('the watch page, which is the shipping case',
      videoIdFromUrl(`https://www.youtube.com/watch?v=${ID}`) === ID);
    ok('...with the query params YouTube actually attaches',
      videoIdFromUrl(`https://www.youtube.com/watch?v=${ID}&list=PLx&index=2&t=41s`) === ID);
    ok('the short domain, the embed, the shorts and the live paths',
      videoIdFromUrl(`https://youtu.be/${ID}?t=41`) === ID &&
      videoIdFromUrl(`https://www.youtube.com/embed/${ID}`) === ID &&
      videoIdFromUrl(`https://www.youtube.com/shorts/${ID}`) === ID &&
      videoIdFromUrl(`https://www.youtube.com/live/${ID}`) === ID);
    ok('music.youtube.com and m.youtube.com are the same tracks',
      videoIdFromUrl(`https://music.youtube.com/watch?v=${ID}`) === ID &&
      videoIdFromUrl(`https://m.youtube.com/watch?v=${ID}`) === ID);
    /**
     * The refusals matter more than the acceptances. A key that is invented for
     * a page we do not recognise collides across two different tracks, and the
     * failure is stems from the wrong song playing back as if they were right.
     */
    ok('a non-video YouTube page has NO id — not a guess, not the pathname',
      videoIdFromUrl('https://www.youtube.com/') === null &&
      videoIdFromUrl('https://www.youtube.com/feed/subscriptions') === null &&
      videoIdFromUrl('https://www.youtube.com/@someChannel') === null);
    ok('another host is not a YouTube video however it is shaped',
      videoIdFromUrl(`https://notyoutube.com/watch?v=${ID}`) === null &&
      videoIdFromUrl(`https://youtube.com.evil.test/watch?v=${ID}`) === null);
    ok('a malformed id is refused rather than truncated into a plausible key',
      videoIdFromUrl('https://www.youtube.com/watch?v=short') === null &&
      videoIdFromUrl('https://www.youtube.com/watch?v=' + 'x'.repeat(40)) === null);
    ok('junk in is null out, never a throw — this runs on every LIVE_START',
      videoIdFromUrl(null) === null && videoIdFromUrl('') === null &&
      videoIdFromUrl('not a url') === null && videoIdFromUrl(undefined) === null);
    ok('the SAME video at a different hop is a DIFFERENT cache key — the causal ' +
       'window is hop-dependent, so the stems genuinely differ',
      cacheKey(ID, 1.95) !== cacheKey(ID, 3.9));
  }

  head('cache — a prime is all-or-nothing, and "we cannot see" is a refusal');
  /**
   * ENTRY POINTS: `primeRefusal` is called from offscreen/engine.js beginPrime() on
   * LIVE_START; `commitRefusal` from endPrime() on stop. They are separate
   * assertions because they run at different moments on different evidence.
   */
  {
    const ID = 'dQw4w9WgXcQ';
    const page = (o) => ({ currentTime: 0, duration: 240, ended: false, ...o });

    ok('a fresh watch page at the top of the track primes',
      primeRefusal(ID, page()) === null);
    ok('...and 1.0 s in still counts as the top (a play never lands on 0.000)',
      primeRefusal(ID, page({ currentTime: 0.9 })) === null);
    /**
     * THE ONE THAT MUST NOT REGRESS. `null` here means the side-panel build,
     * which has no content script and therefore no idea where the playhead is.
     * Treating that as "assume 0" writes an entry covering 1:47-to-the-end and
     * reports it as the whole song — the same disease as an assertion that
     * passes because it could not look (AGENTS.md).
     */
    ok('NO page transport is a REFUSAL, not an assumption that it started at 0',
      primeRefusal(ID, null) === 'no page transport (this build has no content script)');
    ok('a video already part-way through does not prime',
      /already 107.0 s in/.test(primeRefusal(ID, page({ currentTime: 107 })) || ''),
      primeRefusal(ID, page({ currentTime: 107 })));
    ok('no duration yet (metadata has not landed) does not prime',
      primeRefusal(ID, page({ duration: 0 })) !== null);
    ok('a page with no recognisable video is not cacheable at all',
      primeRefusal(null, page()) === 'not a recognisable video page');

    const W = (frames, aborted = false) => ({ frames, aborted });
    const FULL = 240 * SR;
    ok('a complete listen commits',
      commitRefusal(W(FULL), page({ ended: true })) === null);
    ok('...and so does one short by the causal tail the pipeline can never separate',
      commitRefusal(W(FULL - 4 * SR), page({ ended: true })) === null);
    ok('but not one short by more than that — a track that ends 40 s early is ' +
       'a wrong entry, not a slightly short one',
      /40.0 s short/.test(commitRefusal(W(FULL - 40 * SR), page({ ended: true })) || ''),
      commitRefusal(W(FULL - 40 * SR), page({ ended: true })));
    ok('a track the user paused near the end commits NOTHING — "nearly all of it" ' +
       'is exactly the ambiguity this policy removes',
      /did not play to the end/.test(commitRefusal(W(FULL - SR), page({ ended: false })) || ''));
    ok('an interrupted prime (a seek aborted the writer) never commits',
      commitRefusal(W(FULL, true), page({ ended: true })) === 'the prime was interrupted');
    ok('an empty writer never commits',
      commitRefusal(W(0), page({ ended: true })) === 'nothing was captured');
    ok('and with no page transport to check against, it refuses rather than ' +
       'committing on the frame count alone',
      commitRefusal(W(FULL), null) !== null);
  }

  head('cache — 16-bit round trip is good enough for playback, and is NOT dithered');
  {
    // Four dithered stems summed would stack four independent TPDF noise floors
    // on a signal that is about to be re-mixed. Export re-derives at 32f, so
    // nothing lossy reaches a deliverable.
    const n = 4096;
    const x = noise(n, 31);
    const wav = encodeWav([x, x], { sampleRate: SR, bitDepth: 16, float: false, dither: false });
    const back = decodeWav(wav).channels[0];
    const db = residualDb(back, x);
    ok(`16-bit quantisation floor is ${db.toFixed(1)} dB (gate < -85)`, db < -85);
    const again = decodeWav(encodeWav([back, back], { sampleRate: SR, bitDepth: 16, float: false, dither: false })).channels[0];
    ok('and a second round trip is BIT IDENTICAL — undithered means idempotent, ' +
       'so re-caching cannot accumulate noise',
      again.every((v, i) => v === back[i]));
  }
}

// ===========================================================================
if (group('mix')) {
  head('mix — fader law (AUDIO.md §3.1)');
  ok('unity at u = 0.80', Math.abs(faderDb(0.8)) < 1e-12);
  ok('+6 dB at the top and hard zero at exactly u = 0',
    faderDb(1) === 6 && faderDb(0) === -Infinity && dbToGain(faderDb(0)) === 0);
  ok('-60 dB at the bottom of travel', Math.abs(faderDb(1e-9) + 60) < 1e-6);
  {
    let worst = 0;
    for (let i = 1; i <= 1000; i++) { const u = i / 1000; worst = Math.max(worst, Math.abs(dbToFader(faderDb(u)) - u)); }
    ok('dbToFader is the exact inverse (presets round-trip)', worst < 1e-12, `worst ${worst.toExponential(2)}`);
  }
  ok('the law is linear in dB, not in amplitude (a cube law gives -5.8 dB at u=0.8)',
    Math.abs(faderDb(0.8) - 0) < 1e-12 && Math.abs(20 * Math.log10(0.8 ** 3) + 5.8) < 0.05);

  head('mix — the wire contract with the console UI');
  // faderDb / dbToFader / dbToGain now have a second consumer (ui/audio-math.js
  // imports them, so there is one implementation of the normative law). These
  // checks are the interface, not internals.
  ok('SILENT_DB is -120 and maps to TRUE zero, not 1e-6',
    SILENT_DB === -120 && dbToGain(-120) === 0 && dbToGain(-121) === 0 && dbToGain(-1e9) === 0);
  ok('-Infinity also maps to true zero (it does not survive structured clone, hence the sentinel)',
    dbToGain(-Infinity) === 0);
  ok('the sentinel is far below the bottom of the fader\'s own travel',
    faderDb(1e-9) > SILENT_DB + 50, `fader bottoms out at ${faderDb(1e-9).toFixed(0)} dB`);
  ok('just above the sentinel is still a real (tiny) gain, not silently snapped',
    dbToGain(-119) > 0 && dbToGain(-119) < 1e-5, `${dbToGain(-119).toExponential(2)}`);
  ok('0 dB is unity and +6 dB is 2x', dbToGain(0) === 1 && Math.abs(dbToGain(6) - 1.9953) < 1e-3);
  {
    // Asserted at EVERY stem index, not just index 0: resolveGains maps over the
    // array, so index 0 passing says nothing about whether the array it was
    // handed was six long. A four-wide caller would have been invisible here.
    const sentinelBad = STEMS.filter((_, k) => {
      const strips = openStrips();
      strips[k].gainDb = SILENT_DB;
      const g = resolveGains(strips);
      return g.length !== STEMS.length || g[k] !== 0 || g.filter((v) => v === 1).length !== STEMS.length - 1;
    });
    ok('a stem at the sentinel resolves to exactly 0 through the solo/mute table, at any of the six positions',
      sentinelBad.length === 0, sentinelBad.length ? `wrong at ${sentinelBad.join(',')}` : `${STEMS.length}/${STEMS.length}`);
  }
  ok('primedPct is 0..1, never 0..100', primedPct(0) === 0 && primedPct(SEGMENT) === 1 && primedPct(SEGMENT * 99) === 1);

  head('mix — mute/solo truth table (AUDIO.md §3.2)');
  {
    const S = (mute, solo) => ({ gainDb: 0, muted: mute, soloed: solo });
    /**
     * SIX COLUMNS, and three of the rows are new rather than the old seven
     * padded out. Padding would have widened the table without widening its
     * COVERAGE: every original row leaves guitar and piano open and unsoloed, so
     * a resolver that stopped at four would produce the correct answer for the
     * columns those rows actually interrogate. The three added rows put the
     * decisive stem at index 4 and index 5, which is the only place a truncated
     * loop shows up.
     */
    const cases = [
      // [drums, bass, other, vocals, guitar, piano] as [mute, solo] -> audible
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 1, 1, 1, 1, 1], why: 'nothing muted, nothing soloed' },
      { st: [[1, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [0, 1, 1, 1, 1, 1], why: 'a mute silences that stem' },
      { st: [[0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 0, 0, 0, 0, 0], why: 'any solo silences everything else' },
      { st: [[0, 1], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 1, 0, 0, 0, 0], why: 'multiple solos are a UNION' },
      { st: [[1, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 0, 0, 0, 0, 0], why: 'solo overrides the soloed stem’s own mute' },
      { st: [[1, 1], [1, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 0, 0, 0, 0, 0], why: 'a muted non-soloed stem stays silent' },
      { st: [[0, 0], [1, 1], [1, 0], [0, 0], [0, 0], [0, 0]], want: [0, 1, 0, 0, 0, 0], why: 'mute+solo on one, mute on another' },
      // --- the three that only exist at six stems
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1]], want: [0, 0, 0, 0, 0, 1], why: 'the LAST stem soloed — piano alone, the row a four-wide loop cannot get right' },
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [0, 0]], want: [1, 1, 1, 1, 0, 1], why: 'a mute on guitar silences guitar and nothing else' },
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 1]], want: [0, 0, 0, 0, 1, 1], why: 'the solo UNION lands entirely on the two new stems' },
    ];
    let bad = '';
    for (const c of cases) {
      if (c.st.length !== STEMS.length || c.want.length !== STEMS.length) { bad += `[${c.why}: row is not ${STEMS.length} wide] `; continue; }
      const g = resolveGains(c.st.map(([m, so]) => S(!!m, !!so)));
      if (g.length !== STEMS.length) { bad += `[${c.why}: resolveGains returned ${g.length}] `; continue; }
      const got = g.map((v) => (v > 0 ? 1 : 0));
      if (got.join('') !== c.want.join('')) bad += `[${c.why}: got ${got.join('')} want ${c.want.join('')}] `;
    }
    ok(`${cases.length} rows of the truth table, ${STEMS.length} columns each`, !bad, bad);
    // solo-in-place: the soloed stem does not get make-up gain. Checked on the
    // LAST stem as well as the first — make-up gain applied by index would be
    // invisible at index 0.
    const g0 = resolveGains(openStrips().map((s, k) => (k === 0 ? S(false, true) : s)));
    const g5 = resolveGains(openStrips().map((s, k) => (k === STEMS.length - 1 ? S(false, true) : s)));
    ok('solo is solo-in-place (no make-up gain on the soloed stem), first stem and last',
      Math.abs(g0[0] - 1) < 1e-12 && Math.abs(g5[STEMS.length - 1] - 1) < 1e-12,
      `${STEMS[0]} ${g0[0]}, ${STEMS[STEMS.length - 1]} ${g5[STEMS.length - 1]}`);
    // un-soloing restores the previous mutes
    const st = openStrips(); st[0] = S(true, true);
    const soloed = resolveGains(st).map((v) => (v > 0 ? 1 : 0)).join('');
    st[0].soloed = false;
    ok('un-soloing restores mute (they are independent booleans, never a tri-state)',
      soloed === '1' + '0'.repeat(STEMS.length - 1) &&
      resolveGains(st).map((v) => (v > 0 ? 1 : 0)).join('') === '0' + '1'.repeat(STEMS.length - 1),
      `soloed ${soloed}`);
  }

  head('mix — a LONE deck is never attenuated by an untouched crossfader');
  {
    // The control defaults to centre = -3.01 dB per deck on `dip`. Correct with
    // two decks, wrong with one — and it shipped as a -10.63 dB "separation"
    // regression in the Sigma-stems gate that was really the mixer.
    ok('one deck loaded parks the crossfader on it (unity, not -3.01 dB)',
      effectiveXfPosition(0.5, { A: true, B: false }) === 0 &&
      effectiveXfPosition(0.5, { A: false, B: true }) === 1);
    ok('both decks loaded honour the control',
      effectiveXfPosition(0.5, { A: true, B: true }) === 0.5 &&
      effectiveXfPosition(0.2, { A: true, B: true }) === 0.2);
    ok('nothing loaded changes nothing', effectiveXfPosition(0.5, { A: false, B: false }) === 0.5);
    const lone = resolveDeckGains('A', openStrips(), XF_ALL,
      effectiveXfPosition(0.5, { A: true, B: false }), 'dip');
    ok('so a lone deck A plays at UNITY through the whole chain, on all six stems',
      lone.stems.length === STEMS.length && lone.stems.every((v) => Math.abs(v - 1) < 1e-12),
      JSON.stringify(lone.stems.map((v) => +v.toFixed(4))));
    const pair = resolveDeckGains('A', openStrips(), XF_ALL,
      effectiveXfPosition(0.5, { A: true, B: true }), 'dip');
    ok('and only drops to -3.01 dB once deck B is actually loaded, on all six stems',
      pair.stems.length === STEMS.length && pair.stems.every((v) => Math.abs(v - Math.SQRT1_2) < 1e-12),
      `[${pair.stems.map((v) => v.toFixed(4)).join(' ')}]`);
  }

  head('mix — METERS are post-fader, PRE-crossfader (a cued deck must still meter)');
  {
    // RENDERING ONLY for the summing line; REACHABLE for the gain split, which
    // drives the real resolveDeckGains(). Reachability for the tap point itself:
    // run-ext.mjs asserts a crossfaded-out deck keeps its meters.
    const open6 = openStrips();
    const XFALL = XF_ALL;
    // deck A crossfaded FULLY out (position 1 = full B)
    const a = resolveDeckGains('A', open6, XFALL, 1, 'dip');
    ok('a deck faded fully out is silent in the audio path, on all six stems',
      a.stems.length === STEMS.length && a.stems.every((v) => v === 0), JSON.stringify(a.stems));
    ok('...but its METER gain stays at unity on all six, so the DJ can cue it',
      a.meter.length === STEMS.length && a.meter.every((v) => v === 1) && a.xf.every((v) => v === 0),
      `meter ${JSON.stringify(a.meter)} xf ${JSON.stringify(a.xf)}`);
    ok('audio gain is exactly meter x xf — the split cannot drift from the sum',
      a.stems.every((v, i) => Math.abs(v - a.meter[i] * a.xf[i]) < 1e-12));
    // Mute and solo are on the METERED side, so they still zero the meter. Driven
    // on GUITAR rather than drums: the four-stem form only ever moved index 0,
    // which a resolver truncated at four still handles correctly.
    const muted = openStrips(); muted[S_IDX.guitar].muted = true;
    const m = resolveDeckGains('A', muted, XFALL, 0, 'dip');
    ok('a MUTED guitar reads zero on the meter (mute is pre-tap, unlike the crossfader)',
      m.meter[S_IDX.guitar] === 0 && m.stems[S_IDX.guitar] === 0 &&
      STEMS.every((s, k) => k === S_IDX.guitar || m.meter[k] === 1),
      `meter ${JSON.stringify(m.meter)}`);
    const soloed = openStrips(); soloed[S_IDX.piano].soloed = true;
    const so = resolveDeckGains('A', soloed, XFALL, 0, 'dip');
    ok('a soloed PIANO zeroes the other five stems on the meter too',
      so.meter[S_IDX.piano] === 1 && STEMS.every((s, k) => k === S_IDX.piano || so.meter[k] === 0),
      `meter ${JSON.stringify(so.meter)}`);
    // at the centre of a dip crossfader the audio is -3.01 dB but the meter is not
    const c = resolveDeckGains('A', open6, XFALL, 0.5, 'dip');
    ok('at centre the audio is -3.01 dB and the meter is still 0 dB',
      Math.abs(c.stems[0] - Math.SQRT1_2) < 1e-12 && c.meter[0] === 1,
      `audio ${c.stems[0].toFixed(4)} meter ${c.meter[0]}`);
  }

  head('mix — the two crossfades must never be unified (they need OPPOSITE laws)');
  {
    /**
     * There are two crossfades in this product and the same word names both:
     *   SEAM_XFADE_LAW  joins two chunks of the SAME audio inside one deck.
     *                   Correlated => amplitudes add => LINEAR.
     *   XF_CURVE_DEFAULT crossfades two DIFFERENT records between decks.
     *                   Uncorrelated => powers add => CONSTANT POWER.
     * The deciding variable is correlation, not anything about faders. This
     * block fails if anyone ever makes them agree, which is exactly what a
     * well-meaning "unify the crossfade laws" refactor would do.
     */
    const n = 512;
    const seam = makeFades(n, SEAM_XFADE_LAW);
    let worstAmp = 0;
    for (let i = 0; i < n; i++) worstAmp = Math.max(worstAmp, Math.abs(seam.fi[i] + seam.fo[i] - 1));
    ok('SEAM: complementary AMPLITUDE across the join (fi + fo = 1)',
      worstAmp < 1e-6, `max |fi+fo-1| = ${worstAmp.toExponential(2)} under '${SEAM_XFADE_LAW}'`);

    let worstPow = 0;
    for (let i = 0; i <= 100; i++) {
      const g = xfaderGains(i / 100, XF_CURVE_DEFAULT);
      worstPow = Math.max(worstPow, Math.abs(g.a * g.a + g.b * g.b - 1));
    }
    ok('DECK: constant POWER across the sweep (a² + b² = 1)',
      worstPow < 1e-12, `max |a²+b²-1| = ${worstPow.toExponential(2)} under '${XF_CURVE_DEFAULT}'`);

    // the midpoints are the whole argument, in one number each
    const sMid = seam.fi[n >> 1];
    const dMid = xfaderGains(0.5, XF_CURVE_DEFAULT).a;
    ok('and their midpoints DIFFER — 0.500 vs 0.707 is the +/-3.01 dB at stake',
      Math.abs(sMid - 0.5) < 0.01 && Math.abs(dMid - Math.SQRT1_2) < 1e-12,
      `seam ${sMid.toFixed(3)} (${(20 * Math.log10(2 * sMid)).toFixed(2)} dB summed) · ` +
      `deck ${dMid.toFixed(3)} (${(20 * Math.log10(dMid)).toFixed(2)} dB each)`);

    // THE unification guard, stated as the refactor it is defending against
    ok('the seam law is NOT the deck law (a "unify the crossfades" refactor fails here)',
      SEAM_XFADE_LAW === 'linear' && XF_CURVE_DEFAULT !== 'lin',
      `seam '${SEAM_XFADE_LAW}' vs deck '${XF_CURVE_DEFAULT}' — if the seam is ever 'equalPower' or the ` +
      `deck default ever 'lin', one of them is 3.01 dB wrong and this is where you find out`);
    ok('`lin` stays available for the case where it IS right: beat-juggling two ' +
       'phase-locked copies of one loop, where the decks ARE correlated',
      XF_CURVES.includes('lin') && Math.abs(xfaderGains(0.5, 'lin').a - 0.5) < 1e-12);
  }

  head('mix — QA-15: a kill must survive a dropped chunk');
  // RENDERING ONLY below the gain vector: `sumAt` reimplements the worklet's
  // summing line. Reached by: run-ext.mjs "EXACTLY zero for the whole kill".
  /**
   * The backpressure ladder substitutes the unseparated mix for a chunk it could
   * not deliver. The stem faders cannot act on that plane — it is the mix, not a
   * stem — so until this was fixed, a drop UNDID the user's kill and the vocal
   * punched back in at full level. Measured before the fix: all four muted,
   * input 0.5/-0.5, output 0.5/-0.5. QA counted 26 such spans in 155 s at the
   * default hop, i.e. ~51 s of a killed vocal returning.
   *
   * This reproduces the playback worklet's summing line verbatim against the
   * real LiveEmitter.gap() and the real resolveGains(), so the conclusion is
   * arithmetic, not inference.
   */
  {
    const p = makeLivePlan(1.95);
    const St = (m, so, db = 0) => ({ gainDb: db, muted: m, soloed: so });
    /**
     * The EIGHT worklet gain slots: `0..5` stems, `6` passthrough, `7` master.
     * It was six slots (`0..3 / 4 / 5`) at four stems. The two indices that
     * moved are exactly the two that mean something other than "a stem", so a
     * build that kept the old literals writes the passthrough onto GUITAR and
     * the master onto PIANO — audible, plausible, and green under the old
     * assertions.
     */
    const slots = (mix, masterDb = 0) => {
      const g = resolveGains(mix);
      return [...g, passthroughGain(g), dbToGain(masterDb)];
    };
    /** offscreen/playback-processor.js, per output sample */
    const sumAt = (planes, i, g) => {
      let L = 0, R = 0;
      for (let q = 0; q < STEM_PLANES; q += 2) { L += planes[q][i] * g[q / 2]; R += planes[q + 1][i] * g[q / 2]; }
      L += planes[PASS_PLANE_L][i] * g[G_PASS]; R += planes[PASS_PLANE_R][i] * g[G_PASS];
      return [L * g[G_MASTER], R * g[G_MASTER]];
    };
    ok(`the slot map is ${STEMS.length} stems then passthrough at ${G_PASS} then master at ${G_MASTER}`,
      slots(openStrips()).length === STEMS.length + 2 && G_PASS === 6 && G_MASTER === 7,
      `${slots(openStrips()).length} slots`);
    const gapPlanes = () => {
      const em = new LiveEmitter(p, 'linear');
      const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(p.L).fill(0.25));
      const mixL = new Float32Array(p.H).fill(0.5), mixR = new Float32Array(p.H).fill(-0.5);
      em.chunk(0, src, mixL, mixR);
      return em.gap(p.H, mixL, mixR).planes;   // the ladder's actual sequence
    };
    const pl = gapPlanes();
    const mid = p.H - 1;                        // past the entry crossfade

    ok('a skipped chunk does put the unseparated mix on planes 12/13 and zero ALL TWELVE stem planes',
      Math.abs(pl[PASS_PLANE_L][mid] - 0.5) < 1e-6 && Math.abs(pl[PASS_PLANE_R][mid] + 0.5) < 1e-6 &&
      Array.from({ length: STEM_PLANES }, (_, q) => pl[q][mid]).every((v) => v === 0));

    // --- the scenario from qa/passthrough-gain.mjs
    const allMuted = STEMS.map(() => St(true, false));
    const gM = slots(allMuted);
    ok('all six stems muted => passthrough gain is 0, not 1', gM[G_PASS] === 0, `slot ${G_PASS} = ${gM[G_PASS]}`);
    const outM = sumAt(pl, mid, gM);
    ok('WITH ALL SIX STEMS MUTED the output during a drop is EXACTLY zero',
      outM[0] === 0 && outM[1] === 0,
      `output ${outM[0].toFixed(4)} / ${outM[1].toFixed(4)} against an input of 0.5000 / -0.5000`);
    let leak = 0;
    for (let i = 0; i < p.H; i++) { const o = sumAt(pl, i, gM); if (o[0] !== 0 || o[1] !== 0) leak++; }
    ok('and it is zero across the WHOLE span, crossfades included', leak === 0, `${leak} non-zero frames of ${p.H}`);

    // --- no regression on the happy path
    const none = openStrips();
    const gN = slots(none);
    ok('nothing killed => passthrough gain is unity, bit-identical to before the fix', gN[G_PASS] === 1);
    let same = true;
    const legacy = [...resolveGains(none), 1, dbToGain(0)];   // the old, unwritten passthrough slot
    for (let i = 0; i < p.H; i += 97) {
      const a = sumAt(pl, i, gN), b = sumAt(pl, i, legacy);
      if (a[0] !== b[0] || a[1] !== b[1]) { same = false; break; }
    }
    ok('the unmuted passthrough span is bit-identical to today', same);

    // --- the rest of the truth table. The kill is applied at EVERY stem index,
    // not just at vocals: `passthroughGain` is a min over the whole vector, so a
    // caller handing it a four-wide slice ducks correctly on drums..vocals and
    // silently ignores a killed guitar or piano — the QA-15 defect, restored for
    // exactly the two stems nobody would think to re-test.
    const notDucked = STEMS.filter((s, k) => {
      const strips = openStrips(); strips[k].muted = true;
      return slots(strips)[G_PASS] !== 0;
    });
    ok('ONE stem killed — any one of the six — is enough to duck the passthrough (the stem cannot return)',
      notDucked.length === 0, notDucked.length ? `not ducked by ${notDucked.join(',')}` : `${STEMS.length}/${STEMS.length}`);
    const soloStrips = openStrips(); soloStrips[0].soloed = true;
    ok('solo ducks it for free (the others resolve to 0)', slots(soloStrips)[G_PASS] === 0);
    const sentinelStrips = openStrips(); sentinelStrips[S_IDX.piano].gainDb = SILENT_DB;
    ok('the -120 dB sentinel ducks it too, applied to the last stem', slots(sentinelStrips)[G_PASS] === 0);
    const partialStrips = openStrips(); partialStrips[S_IDX.guitar].gainDb = -6;
    const partial = slots(partialStrips);
    ok('a partial cut ducks to the quietest, no step',
      Math.abs(partial[G_PASS] - dbToGain(-6)) < 1e-12, `${partial[G_PASS].toFixed(4)} = ${dbToGain(-6).toFixed(4)}`);
    ok('passthroughGain is exactly min(resolved) — nothing sneaks above the quietest stem',
      [[1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 0.5, 1], [1, 1, 1, 1, 1, 0], [0.3, 0.2, 0.9, 0.25, 0.15, 0.4]]
        .every((v) => v.length === STEMS.length && passthroughGain(v) === Math.min(...v)));
  }

  head('mix — per-sample gain smoothing in the playback worklet (AUDIO.md §3.3)');
  // RENDERING ONLY: reimplements the worklet's loop, so it cannot see the worklet
  // failing to run it. Reached by: run-ext.mjs mute-to-silence timing.
  {
    // Mirrors the loop in offscreen/playback-processor.js exactly. If that loop
    // changes, this test must change with it — which is the point.
    const ramp = (from, to, tau, sr = SR) => {
      const a = smoothCoef(tau, sr);
      let g = from, d = Math.ceil(6 * tau * sr);
      const trace = [g];
      while (d > 0) { if (--d === 0) g = to; else g += (to - g) * a; trace.push(g); }
      return trace;
    };
    for (const [name, tau, ms] of [['mute', TAU.mute, 18], ['fader', TAU.fader, 60], ['master', TAU.master, 120]]) {
      const t = ramp(1, 0, tau);
      const settleMs = ((t.length - 1) / SR) * 1000;
      const at3tau = t[Math.round(3 * tau * SR)];
      const overshoot = Math.min(...t) < -1e-12 || Math.max(...t) > 1 + 1e-12;
      ok(`${name} (τ=${(tau * 1000).toFixed(0)} ms): reaches the target in ${settleMs.toFixed(1)} ms (<= ${ms}), 95 % at 3τ, no overshoot`,
        settleMs <= ms + 0.1 && t[t.length - 1] === 0 && Math.abs(at3tau - 0.05) < 0.01 && !overshoot,
        `3τ value ${at3tau.toFixed(4)}`);
    }
    const up = ramp(0, 1, TAU.mute);
    ok('an unmute is exactly 1.0 by 18 ms, not asymptotically close',
      up[up.length - 1] === 1 && ((up.length - 1) / SR) * 1000 <= 18.1);
    const t10 = ramp(1, 0.5, TAU.fader);
    const at20ms = t10[Math.round(0.020 * SR)];
    ok('a fader move is 86 % of the way there by 20 ms — audible immediately, not stepped',
      Math.abs(at20ms - (1 - 0.5 * (1 - Math.exp(-2)))) < 0.01, `g = ${at20ms.toFixed(4)} of 0.5`);
  }

  head('mix — master soft clip (AUDIO.md §4.3), NOT a DynamicsCompressorNode');
  // RENDERING ONLY: `applyCurve` reimplements WaveShaper's interpolation, so it
  // proves the CURVE and never that the node is wired in with 4x oversampling.
  // Reached by: run-ext.mjs reads oversample/curve length off the live graph.
  {
    const curve = softClipCurve(0.7079, 2);
    const at = (dbfs) => 20 * Math.log10(Math.abs(applyCurve(curve, dbToGain(dbfs), 2)));
    ok('-6 dBFS passes through untouched', Math.abs(at(-6) + 6) < 0.01, `${at(-6).toFixed(3)} dBFS`);
    ok('-3 dBFS (the knee) passes through untouched', Math.abs(at(-3) + 3) < 0.02, `${at(-3).toFixed(3)} dBFS`);
    ok('0 dBFS lands at -0.63 dBFS', Math.abs(at(0) + 0.63) < 0.05, `${at(0).toFixed(3)} dBFS`);
    ok('+6 dBFS is held at the ceiling', at(6) < 0.01 && at(6) > -0.1, `${at(6).toFixed(3)} dBFS`);
    ok('+12 dBFS cannot exceed the ceiling (Web Audio clamps the curve input)',
      at(12) <= 0 && Math.abs(at(12) - at(6)) < 1e-3, `${at(12).toFixed(3)} dBFS`);
    ok('the transfer function is monotone and odd',
      softClip(-0.9) === -softClip(0.9) && softClip(0.9) > softClip(0.8));
    /**
     * THE WORST-CASE SUM, RE-DERIVED AT SIX STEMS — AND A FINDING ABOUT WHAT
     * THIS ASSERTION CAN AND CANNOT SEE. Read this before citing it as headroom
     * evidence for the six-stem move.
     *
     * The arithmetic: every stem fader hard at the top is +6 dB = x1.9953, so
     * `STEMS.length` identical stems summed is 6 x 2 = 12.0 linear, where four
     * stems gave 8.0. That IS more summed energy and the number in the assertion
     * moves with it.
     *
     * The physics: it changes NOTHING, and pretending otherwise would be the
     * wrong estimator for the claim (AGENTS.md). `applyCurve` reproduces
     * WaveShaper, which CLAMPS its input to ±1 after the 1/headroom divide — so
     * every input at or above `headroom` (2.0) maps to the same last curve
     * sample. Measured: applyCurve(8, 2) and applyCurve(12, 2) are the identical
     * 0.99992, and so is applyCurve(2, 2). The four-stem form was already
     * saturated: at four stems, at six, at sixty, this returns the ceiling.
     *
     * So it stays green at six stems, and it stays green for a reason that has
     * nothing to do with stem count. IT IS NOT EVIDENCE THAT SIX STEMS IS
     * HEADROOM-SAFE. The clipper cannot let the DAC clip at any input; what six
     * stems changes is how much of the time the clipper is WORKING, which is a
     * measurement (`tools/mashup-probe.mjs`) and is SIX-STEM-CONTRACT §"known
     * debt" item 2 — `DUAL_MASTER_TRIM_DB = -3` was measured with four stems and
     * has not been re-measured. Do not close that item on the strength of this
     * line.
     *
     * Split into arithmetic and physics so the two claims cannot hide behind
     * each other, and the saturation is asserted explicitly rather than left as
     * the silent reason a `<= 1.0` gate passes.
     */
    const worstSum = STEMS.length * dbToGain(6);
    ok(`arithmetic: ${STEMS.length} stems at +6 dB sum to ${worstSum.toFixed(2)} linear, past the shaper's 2.0 headroom`,
      Math.abs(worstSum - STEMS.length * 1.99526) < 1e-3 && worstSum > 2,
      `${worstSum.toFixed(3)} vs ${(4 * dbToGain(6)).toFixed(3)} at four stems`);
    ok(`physics: ${STEMS.length} stems at +6 dB summed cannot leave the DAC clipping`,
      Math.abs(applyCurve(curve, worstSum, 2)) <= 1.0,
      `${applyCurve(curve, worstSum, 2).toFixed(6)} out`);
    ok('...and it is the SATURATED branch doing that, identically at four stems and at six — ' +
       'so this line can never go red on stem count and is not headroom evidence for the 6-stem move',
      applyCurve(curve, worstSum, 2) === applyCurve(curve, 4 * dbToGain(6), 2) &&
      applyCurve(curve, worstSum, 2) === applyCurve(curve, 2, 2) &&
      applyCurve(curve, 1.5, 2) < applyCurve(curve, 2, 2),
      `ceiling ${applyCurve(curve, 2, 2).toFixed(6)}, unsaturated 1.5 -> ${applyCurve(curve, 1.5, 2).toFixed(6)}`);
  }
}

// ===========================================================================
if (group('xf')) {
  head('xf — crossfader curves (docs/design/DESIGN.md §6.4)');
  // Pure maths against production code. Reachability: run-ext.mjs drives XFADER
  // over the wire and reads the resulting gain vector back out of the running
  // worklet; audible-probe.mjs proves it at the DAC.
  {
    const P = Array.from({ length: 201 }, (_, i) => i / 200);

    // --- dip: CONSTANT POWER. This is the one property the curve exists for and
    // the one an "improved" implementation always breaks.
    let worst = 0, worstAt = 0;
    for (const p of P) {
      const { a, b } = xfaderGains(p, 'dip');
      const e = Math.abs(a * a + b * b - 1);
      if (e > worst) { worst = e; worstAt = p; }
    }
    ok('dip sums to UNITY POWER at every one of 201 positions, not just the ends',
      worst < 1e-12, `worst |a²+b²−1| = ${worst.toExponential(2)} at p=${worstAt}`);
    {
      const c = xfaderGains(0.5, 'dip');
      ok('dip centre is −3.0103 dB on both decks (the "dip" the name refers to)',
        Math.abs(20 * Math.log10(c.a) + 3.0103) < 1e-3 && Math.abs(c.a - c.b) < 1e-12,
        `${(20 * Math.log10(c.a)).toFixed(4)} dB`);
      const l = xfaderGains(0, 'dip'), r = xfaderGains(1, 'dip');
      ok('dip ends are hard: p=0 is full A / silent B, p=1 the reverse',
        l.a === 1 && Math.abs(l.b) < 1e-15 && Math.abs(r.a) < 1e-15 && r.b === 1,
        `A ${l.a}/${r.a.toExponential(1)}  B ${l.b.toExponential(1)}/${r.b}`);
    }

    // --- lin: amplitudes sum to 1, which is a 3 dB POWER dip at centre. Both
    // facts matter: the first is why it exists, the second is why it is not the
    // default.
    {
      const bad = P.filter((p) => Math.abs(xfaderGains(p, 'lin').a + xfaderGains(p, 'lin').b - 1) > 1e-12);
      ok('lin sums to unity AMPLITUDE at every position', bad.length === 0);
      const c = xfaderGains(0.5, 'lin');
      ok('lin centre is −6.02 dB per deck (−3.01 dB in power) — the reason dip is the default',
        Math.abs(20 * Math.log10(c.a) + 6.0206) < 1e-3,
        `${(20 * Math.log10(c.a)).toFixed(4)} dB, power ${(10 * Math.log10(c.a * c.a + c.b * c.b)).toFixed(4)} dB`);
    }

    // --- cut: HARD. Both decks at unity across the middle; the cut lives in the
    // last XF_CUT_EDGE of travel. This is the scratch curve and "hard" is the
    // whole specification.
    {
      const mid = P.filter((p) => p > XF_CUT_EDGE && p < 1 - XF_CUT_EDGE);
      ok(`cut holds BOTH decks at exactly unity across the middle ${(100 * (1 - 2 * XF_CUT_EDGE)).toFixed(0)} % of travel`,
        mid.every((p) => { const g = xfaderGains(p, 'cut'); return g.a === 1 && g.b === 1; }),
        `${mid.length} positions checked`);
      const l = xfaderGains(0, 'cut'), r = xfaderGains(1, 'cut');
      ok('cut is silent on the closed deck at each end',
        l.b === 0 && r.a === 0 && l.a === 1 && r.b === 1);
      // "Hard" quantified: how far must the cap travel from the edge before the
      // deck is at full level? A constant-power fader needs 100 % of the travel.
      const toFull = P.find((p) => xfaderGains(p, 'cut').b >= 1);
      ok(`cut reaches FULL level ${(100 * toFull).toFixed(0)} % from the edge (dip needs 100 %) — this is what makes it a scratch curve`,
        Math.abs(toFull - XF_CUT_EDGE) < 1e-9, `${toFull}`);
      ok('cut is NOT constant power (it is not trying to be) — the middle is +3.01 dB',
        Math.abs(10 * Math.log10(2) - 3.0103) < 1e-3 &&
        Math.abs(xfaderGains(0.5, 'cut').a ** 2 + xfaderGains(0.5, 'cut').b ** 2 - 2) < 1e-12);
    }

    // --- shared properties
    for (const curve of XF_CURVES) {
      const g = P.map((p) => xfaderGains(p, curve));
      const monoA = g.every((v, i) => i === 0 || v.a <= g[i - 1].a + 1e-12);
      const monoB = g.every((v, i) => i === 0 || v.b >= g[i - 1].b - 1e-12);
      const bounded = g.every((v) => v.a >= 0 && v.a <= 1 && v.b >= 0 && v.b <= 1);
      const sym = P.every((p, i) => {
        const l = xfaderGains(p, curve), r = xfaderGains(1 - p, curve);
        return Math.abs(l.a - r.b) < 1e-12 && Math.abs(l.b - r.a) < 1e-12;
      });
      ok(`${curve}: A falls monotonically, B rises monotonically, both stay in [0,1], and the curve is A↔B symmetric`,
        monoA && monoB && bounded && sym);
    }
    ok('the position is clamped, not wrapped — a UI that sends 1.5 or −0.2 gets the end, not a fold-back',
      xfaderGains(1.5, 'dip').b === 1 && xfaderGains(-0.2, 'dip').a === 1);
    ok('an unknown curve name falls back to constant power, never to silence',
      xfaderGains(0.5, 'wobble').a === xfaderGains(0.5, 'dip').a);
  }

  head('xf — XF_ASSIGN truth table: a hard-assigned stem IGNORES the fader');
  // The flagship Mode 3 behaviour, and the one place the wire contract needed
  // interpretation. See engine/mixer.js xfFactor() for the reasoning.
  {
    const P = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    // The truth table, stated once, in the same shape the UI's matrix has:
    //   deck   target   expected
    const table = [
      ['A', 'A', 'hard ON  — 1 at every position'],
      ['A', 'B', 'hard OFF — 0 at every position'],
      ['B', 'B', 'hard ON  — 1 at every position'],
      ['B', 'A', 'hard OFF — 0 at every position'],
    ];
    for (const [deck, target, why] of table) {
      const want = target === deck ? 1 : 0;
      const all = XF_CURVES.every((c) => P.every((p) => xfStemGain(deck, target, p, c) === want));
      ok(`deck ${deck} stem assigned "${target}": ${why} (all 3 curves x 7 positions)`, all);
    }
    for (const curve of XF_CURVES) {
      const okXf = [0, 0.25, 0.5, 0.75, 1].every((p) => {
        const g = xfaderGains(p, curve);
        return xfStemGain('A', 'XF', p, curve) === g.a && xfStemGain('B', 'XF', p, curve) === g.b;
      });
      ok(`"XF" follows the fader on the stem's OWN deck side (${curve})`, okXf);
    }
    ok('a missing/undefined target defaults to XF rather than to silence — an under-specified UI must not mute a deck',
      xfFactor('A', undefined, xfaderGains(0, 'dip')) === 1 && XF_ASSIGN_DEFAULT === 'XF');

    // The two-click mashup, end to end. This is the acceptance criterion in
    // ARCHITECTURE §8 Phase 4 expressed as arithmetic.
    {
      /**
       * "vocals from A over the instrumental from B": the master matrix's
       * `vocals` row -> A, every other row -> B. One UI click per row writes TWO
       * XF_ASSIGN messages (one per deck), which is the part a UI would have to
       * infer and must not.
       *
       * The row vector is BUILT FROM STEMS rather than typed as `['B','B','B','A']`.
       * A four-entry assign array against a six-stem strip list is not an error
       * anywhere in `resolveDeckGains` — `assign[4]` and `assign[5]` come back
       * `undefined`, `xfFactor` defaults those to `'XF'`, and guitar and piano
       * quietly start FOLLOWING THE FADER while every other stem is hard-assigned.
       * The mashup still sounds right at the ends of the travel and collapses in
       * the middle. That is exactly the shape of bug this table exists to catch,
       * and a padded literal would have reintroduced it.
       */
      const LEAD = 'vocals';
      const assignA = STEMS.map((s) => (s === LEAD ? 'A' : 'B'));
      const assignB = assignA.slice();
      ok(`the assign row is one entry per stem (${assignA.join(',')}) — a short row silently reverts the tail to XF`,
        assignA.length === STEMS.length && assignA.filter((t) => t === 'A').length === 1);
      const flat = openStrips();
      const bad = [];
      for (const p of [0, 0.5, 1]) {
        for (const curve of XF_CURVES) {
          const a = resolveDeckGains('A', flat, assignA, p, curve).stems;
          const b = resolveDeckGains('B', flat, assignB, p, curve).stems;
          // A contributes the lead stem only; B contributes everything else.
          if (!STEMS.every((s, i) => a[i] === (s === LEAD ? 1 : 0))) bad.push(`A@${p}/${curve}=${a}`);
          if (!STEMS.every((s, i) => b[i] === (s === LEAD ? 0 : 1))) bad.push(`B@${p}/${curve}=${b}`);
        }
      }
      ok('acapella-over-instrumental: A gives vocals only, B gives the other five, and RIDING THE FADER CHANGES NOTHING',
        bad.length === 0, bad.join(' '));
      // ...and every stem is present exactly once across the two decks. A UI
      // that wrote only one of the two messages would double the vocal here.
      const sum = STEMS.map((_, i) =>
        resolveDeckGains('A', flat, assignA, 0.5, 'dip').stems[i] +
        resolveDeckGains('B', flat, assignB, 0.5, 'dip').stems[i]);
      ok(`each of the ${STEMS.length} stems sums to exactly 1.0 across both decks — nothing doubled, nothing missing`,
        sum.length === STEMS.length && sum.every((v) => Math.abs(v - 1) < 1e-12), `[${sum.join(', ')}]`);
      /**
       * THE NEW STEMS AS THE LEAD. The row above puts the decisive stem at
       * index 3, which four-stem code handles correctly. Running the same
       * gesture with guitar and then piano as the lead is what interrogates
       * indices 4 and 5 — and "guitar from A over everything else from B" is a
       * real gesture, not a synthetic one.
       */
      for (const lead of ['guitar', 'piano']) {
        const aRow = STEMS.map((s) => (s === lead ? 'A' : 'B'));
        const gA = resolveDeckGains('A', flat, aRow, 0.5, 'dip').stems;
        const gB = resolveDeckGains('B', flat, aRow, 0.5, 'dip').stems;
        ok(`...and the same gesture with ${lead} as the lead: A gives ${lead} only, B gives the other five`,
          STEMS.every((s, i) => gA[i] === (s === lead ? 1 : 0) && gB[i] === (s === lead ? 0 : 1)),
          `A [${gA.join(' ')}] B [${gB.join(' ')}]`);
      }
    }
  }

  head('xf — the dual-deck master trim, pinned to the peaks that motivated it');
  {
    ok('one deck (or none) gets no trim — Mode 1 and Mode 2 are untouched',
      masterTrimDb(0) === 0 && masterTrimDb(1) === 0);
    ok('two loaded decks default to -3 dB', masterTrimDb(2) === -3);
    /**
     * THE CONSTANT IS PINNED TO ITS EVIDENCE, not to taste. The clip flag arms at
     * 0.99 pre-soft-clip, and the whole point of the trim is that the flagship
     * gesture must not light it (a warning that fires on correct use stops being
     * a warning). These are the three master-bus peaks measured by
     * tools/mashup-probe.mjs at hop 2.6 with the mashup routing applied.
     */
    const MEASURED_PEAKS = [1.196, 1.317, 1.029];
    const g = dbToGain(masterTrimDb(2));
    ok('-3 dB puts every measured mashup peak under the 0.99 clip threshold',
      MEASURED_PEAKS.every((p) => p * g < 0.99),
      MEASURED_PEAKS.map((p) => `${p}->${(p * g).toFixed(3)}`).join(' '));
    ok('...and without it, two of the three would have armed the clip flag on correct use',
      MEASURED_PEAKS.filter((p) => p >= 0.99).length === 3,
      `${MEASURED_PEAKS.filter((p) => p >= 0.99).length} of 3 peaks were >= 0.99 untrimmed`);
    ok('the trim leaves the soft clipper doing almost nothing at the worst measured peak',
      Math.abs(20 * Math.log10(softClip(1.317 * g) / (1.317 * g))) < 0.5,
      `${(20 * Math.log10(softClip(1.317 * g) / (1.317 * g))).toFixed(2)} dB of reduction, was -2.47 dB untrimmed`);
  }

  head('xf — the combined gain vector: mute/solo x crossfader x passthrough');
  {
    const flat = () => openStrips();
    // One 'XF' PER STEM. `['XF','XF','XF','XF']` against six strips leaves
    // assign[4]/assign[5] undefined; that happens to resolve to 'XF' as well, so
    // the old literal would have gone green here while being the wrong length —
    // and the same literal one block below, where the row is NOT all-XF, is a
    // real defect. Same array, two call sites, one of them silent: `AGENTS.md`'s entry-point rule.
    const XF6 = XF_ALL;
    ok(`the assign row is ${STEMS.length} wide, one entry per stem`, XF6.length === STEMS.length);

    {
      const g = resolveDeckGains('A', flat(), XF6, 0.5, 'dip');
      ok('all six stems on XF get the same crossfader gain — a fader move cannot skew the stem balance',
        g.stems.length === STEMS.length && new Set(g.stems.map((v) => v.toFixed(12))).size === 1,
        `[${g.stems.map((v) => v.toFixed(4)).join(' ')}]`);
    }
    {
      // The QA-15 invariant, now under a crossfader. A dropped chunk on a deck
      // that has been faded out must NOT punch that deck's whole unseparated mix
      // back in at unity.
      const g = resolveDeckGains('A', flat(), XF6, 1, 'dip');   // deck A fully out
      ok('a deck faded fully OUT has passthrough gain 0 — a dropped chunk cannot resurrect a deck you just faded away',
        g.pass === 0 && g.stems.every((v) => Math.abs(v) < 1e-15), `pass ${g.pass}`);
      const h = resolveDeckGains('A', flat(), XF6, 0.5, 'dip');
      ok('a deck at the centre detent has passthrough gain equal to its crossfader gain, not unity',
        Math.abs(h.pass - Math.SQRT1_2) < 1e-12, `pass ${h.pass.toFixed(6)}`);
    }
    {
      // Driven on PIANO, the last stem: QA-15's duck is a min() over the whole
      // vector, so a kill at index 5 is the one a truncated loop would miss.
      const m = flat(); m[S_IDX.piano].muted = true;
      const g = resolveDeckGains('A', m, XF6, 0, 'dip');
      ok('QA-15 survives the crossfader: kill one stem (piano, index 5) and passthrough ducks to zero, at any fader position',
        g.stems[S_IDX.piano] === 0 && g.pass === 0);
    }
    {
      const so = flat(); so[S_IDX.bass].soloed = true;           // bass solo
      const g = resolveDeckGains('B', so, XF6, 1, 'dip');        // deck B fully in
      ok('solo resolves BEFORE the crossfader: soloed bass at full, the other five exactly 0',
        g.stems[S_IDX.bass] === 1 && STEMS.every((s, i) => i === S_IDX.bass || g.stems[i] === 0),
        `[${g.stems.join(' ')}]`);
    }
    {
      // A hard-assigned stem is immune to the fader but NOT to its own mute.
      // Those are different controls and the DJ expects both to work. The row is
      // built per stem: a four-entry row here leaves guitar and piano on 'XF' and
      // the "unmuted stays at full level" line below would then be testing the
      // fader, not the assignment.
      const HARD = STEMS.map((s) => (s === 'vocals' ? 'A' : 'XF'));
      const m = flat(); m[S_IDX.vocals].muted = true;
      const g = resolveDeckGains('A', m, HARD, 1, 'dip');
      ok('a hard-assigned stem still obeys its own mute — "ignores the crossfader" does not mean "ignores you"',
        g.stems[S_IDX.vocals] === 0);
      const u = resolveDeckGains('A', flat(), HARD, 1, 'dip');
      ok('...and unmuted it stays at full level while the other five are faded away',
        u.stems[S_IDX.vocals] === 1 && STEMS.every((s, i) => i === S_IDX.vocals || u.stems[i] === 0),
        `[${u.stems.join(' ')}]`);
    }
    {
      // Nothing above may change Mode 1. A single deck at the default position
      // must produce the byte-identical vector resolveGains() produced before
      // the crossfader existed... which it cannot, at the DEFAULT centre detent.
      // Say so out loud rather than let someone discover it as a 3 dB drop.
      const base = resolveGains(flat());
      const centre = resolveDeckGains('A', flat(), XF6, XF_POSITION_DEFAULT, XF_CURVE_DEFAULT).stems;
      const hardA = resolveDeckGains('A', flat(), XF6, 0, XF_CURVE_DEFAULT).stems;
      ok('at the CENTRE detent a deck is at −3.01 dB, not unity — Mode 1 must not boot with the fader centred',
        Math.abs(centre[0] - Math.SQRT1_2) < 1e-12 && Math.abs(base[0] - 1) < 1e-12);
      ok('with the fader hard against its own end a deck is byte-identical to the Mode 1 vector',
        hardA.every((v, i) => v === base[i]), `[${hardA.join(' ')}] vs [${base.join(' ')}]`);
    }
  }
}

// ===========================================================================
if (group('sched')) {
  head('sched — the shared GPU token: one GPU, two decks, one queue');
  // Drives the real GpuScheduler with an injectable clock and fake inferences.
  // Reachability: dual-live-probe.mjs reports granted/demoted/maxWait off the
  // running engine, and run-ext.mjs asserts the two-deck ordering gate.
  {
    const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, r }; };

    {
      // The whole reason the token exists: two decks must never be inside
      // session.run() at the same time.
      const s = new GpuScheduler();
      let concurrent = 0, maxConcurrent = 0;
      const job = () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); return new Promise((r) => setTimeout(() => { concurrent--; r('ok'); }, 5)); };
      await Promise.all([s.run('A', 1e9, job), s.run('B', 1e9, job), s.run('A', 1e9, job), s.run('B', 1e9, job)]);
      ok('four overlapping requests across two decks never overlap on the GPU', maxConcurrent === 1, `peak ${maxConcurrent}`);
      ok('...and all four were granted', s.stats.granted.A === 2 && s.stats.granted.B === 2);
    }

    {
      // Priority ordering. B is queued first, then A; A must jump it.
      const s = new GpuScheduler({ priority: 'A' });
      const order = [];
      const hold = defer();
      const first = s.run('B', 1e9, () => hold.p);        // takes the token
      await null;
      const b2 = s.run('B', 1e9, async () => { order.push('B'); });
      const a1 = s.run('A', 1e9, async () => { order.push('A'); });
      await new Promise((r) => setTimeout(r, 0));
      hold.r();
      await Promise.all([first, b2, a1]);
      ok('the priority deck jumps the queue: B queued first, A ran first', order.join('') === 'AB', order.join(''));
    }

    {
      // ...but not forever. Two same-priority waiters must come out FIFO, or a
      // busy deck can starve the other indefinitely.
      const s = new GpuScheduler({ priority: 'A' });
      const order = [];
      const hold = defer();
      const first = s.run('A', 1e9, () => hold.p);
      await null;
      const w1 = s.run('B', 1e9, async () => { order.push('B1'); });
      const w2 = s.run('B', 1e9, async () => { order.push('B2'); });
      await new Promise((r) => setTimeout(r, 0));
      hold.r();
      await Promise.all([first, w1, w2]);
      ok('same-priority waiters are FIFO — no starvation', order.join(',') === 'B1,B2', order.join(','));
    }

    {
      // A throwing inference must still release the token, or both decks wedge
      // permanently. This is the exact failure mode the try/finally exists for.
      const s = new GpuScheduler();
      await s.run('A', 1e9, async () => { throw new Error('boom'); }).catch(() => {});
      ok('an inference that throws still releases the token', s.busy === null);
      const r = await s.run('B', 1e9, async () => 'after');
      ok('...and the next deck runs normally', r.demoted === false && r.result === 'after');
    }

    {
      const s = new GpuScheduler();
      await s.run('A', 1e9, async () => 'x');
      s.release('B');                    // a stale release from the wrong deck
      ok('releasing a token you do not hold is a no-op, not a double-release', s.busy === null);
    }
  }

  head('sched — L3 demotion: only ONE deck falls behind, and it is never deck A');
  {
    // The pure decision, first. `estMs` is the machine's p95 inference; the
    // budget is the audio still in the deck's playback ring.
    const D = (o) => demotionDecision({ priority: 'A', estMs: 900, armed: true, waitMs: 0, ...o });
    ok('deck B is demoted when the GPU cannot finish inside what is left of its buffer',
      D({ deck: 'B', budgetMs: 500 }).demote === true, D({ deck: 'B', budgetMs: 500 }).why);
    ok('deck B is NOT demoted when it still fits', D({ deck: 'B', budgetMs: 1500 }).demote === false);
    ok('deck A is NEVER demoted by the scheduler, however far behind it is — its own L2 ladder owns that call',
      D({ deck: 'A', budgetMs: 0 }).demote === false && D({ deck: 'A', budgetMs: -5000 }).demote === false);
    ok('queue wait counts against the budget: 800 ms already spent waiting turns a fitting chunk into a doomed one',
      D({ deck: 'B', budgetMs: 1500, waitMs: 0 }).demote === false &&
      D({ deck: 'B', budgetMs: 1500, waitMs: 800 }).demote === true);
    ok('switching priority switches who is protected — it is a policy, not a hardcoded deck',
      demotionDecision({ deck: 'A', priority: 'B', estMs: 900, budgetMs: 100, waitMs: 0 }).demote === true &&
      demotionDecision({ deck: 'B', priority: 'B', estMs: 900, budgetMs: 100, waitMs: 0 }).demote === false);
    ok('with L3 disarmed nobody is ever demoted (the probe runs both ways)',
      D({ deck: 'B', budgetMs: 0, armed: false }).demote === false);

    // THE ANTI-LOCKOUT INVARIANT. A demoted deck contributes no timing sample,
    // so an estimate it was never allowed to influence must not be grounds to
    // refuse it. Measured live: deck B demoted 15/15 hops with a 1.665 s buffer
    // trough, producing nothing for a whole run, because p95 over 17 samples is
    // the maximum of 17 and one slow post-create chunk on deck A set it.
    ok('a deck that has NEVER run is never demoted, however bad the estimate looks',
      D({ deck: 'B', budgetMs: 100, estMs: 99999, grantedToDeck: 0 }).demote === false,
      D({ deck: 'B', budgetMs: 100, estMs: 99999, grantedToDeck: 0 }).why);
    ok('...but once it has run, the estimate applies to it normally',
      D({ deck: 'B', budgetMs: 100, estMs: 9999, grantedToDeck: 3 }).demote === true);
    ok('a p95 over too few samples may not refuse work — it is just the maximum',
      D({ deck: 'B', budgetMs: 100, estMs: 9999, samples: 3 }).demote === false &&
      D({ deck: 'B', budgetMs: 100, estMs: 9999, samples: 64 }).demote === true);
    {
      // ...and through the real scheduler, end to end: a cold pair must not lock
      // the non-priority deck out on its own first slow chunk.
      const s2 = new GpuScheduler({ priority: 'A' });
      s2.observe(2400);                       // one slow post-create chunk on deck A
      let bRan = 0;
      for (let i = 0; i < 6; i++) {
        await s2.run('A', 1950, async () => 900);
        const r = await s2.run('B', 1950, async () => { bRan++; return 900; });
        if (r.demoted) break;
      }
      ok('a cold scheduler does not lock the non-priority deck out on one outlier',
        bRan === 6 && s2.stats.demoted.B === 0, `deck B ran ${bRan}/6, demoted ${s2.stats.demoted.B}`);
    }

    // And through the real scheduler: a demotion must be a RETURN VALUE, never a
    // throw. LivePipeline routes throws into the CHUNK_FAILED ladder, which
    // halts the deck after three — so a throw here would turn a designed
    // degradation into a dead deck.
    {
      const s = new GpuScheduler({ priority: 'A' });
      // Establish evidence first: the anti-lockout invariant means a deck that
      // has never run, or a population too small to have a real p95, is never
      // refused. Demotion is only reachable once both are satisfied.
      for (let i = 0; i < 12; i++) s.observe(900);
      await s.run('B', 1e9, async () => {});
      s.estMs = 900;
      let ran = false;
      const r = await s.run('B', 300, async () => { ran = true; });
      ok('a demotion resolves {demoted:true} and NEVER runs the inference — no wasted GPU, no throw',
        r.demoted === true && ran === false && typeof r.why === 'string', r.why);
      ok('...and the token was not taken, so deck A is not delayed by it', s.busy === null);
      ok('demotions are counted per deck', s.stats.demoted.B === 1 && s.stats.demoted.A === 0,
        `A ${s.stats.demoted.A}, B ${s.stats.demoted.B}`);
    }

    {
      // The headline scenario: deck B is starving, deck A is healthy. Deck A must
      // be completely unaffected.
      const s = new GpuScheduler({ priority: 'A' });
      for (let i = 0; i < 12; i++) s.observe(900);     // evidence, per the invariant
      await s.run('B', 1e9, async () => {});           // deck B has now run once
      const grantedBefore = s.stats.granted.B;
      s.estMs = 900;
      const results = [];
      for (let hop = 0; hop < 10; hop++) {
        results.push(await s.run('A', 1900, async () => 'A-separated'));
        results.push(await s.run('B', 200, async () => 'B-separated'));
      }
      const aOk = results.filter((_, i) => i % 2 === 0).every((r) => r.demoted === false);
      const bDemoted = results.filter((_, i) => i % 2 === 1).every((r) => r.demoted === true);
      ok('ten hops with deck B out of buffer: deck A separated every single chunk',
        aOk && s.stats.granted.A === 10, `granted A ${s.stats.granted.A}`);
      ok('...and deck B was demoted every time instead of stealing the GPU',
        bDemoted && s.stats.demoted.B === 10 && s.stats.granted.B === grantedBefore,
        `demoted ${s.stats.demoted.B}, granted ${s.stats.granted.B} (was ${grantedBefore})`);
    }

    {
      // estMs must track the machine, or the policy is tuned to a constant.
      const s = new GpuScheduler();
      for (let i = 0; i < 40; i++) s.observe(800);
      for (let i = 0; i < 3; i++) s.observe(1400);
      ok('estMs is the p95 of observed inference time, so one slow chunk does not panic the policy',
        s.estMs >= 800 && s.estMs <= 1400, `${s.estMs} ms`);
      ok('a nonsense observation is ignored rather than poisoning the estimate',
        (s.observe(NaN), s.observe(-5), Number.isFinite(s.estMs)));
    }
  }
}

// ===========================================================================
if (group('dual')) {
  head('dual — twenty-four stem planes, two decks, Δ = 0 (docs/AUDIO.md §8.1)');
  /**
   * AUDIO.md §8.1: "Every stem must be sample-aligned... Δ = 4 combs at 5.5 kHz,
   * Δ = 10 destroys the mid-range. Assert Δ === 0 in code, do not eyeball it."
   *
   * Within one deck, alignment is STRUCTURAL: fourteen planes share one ring and
   * one pair of indices, and `write()` refuses a non-contiguous `from`. That is
   * already asserted in the `live` group. What is new in Mode 3 is the pair of
   * decks, and the two things that can go wrong there are different:
   *
   *   1. the two decks' rings are advanced by DIFFERENT read pointers, so a
   *      frame index means a different instant on each deck;
   *   2. the two decks' pointers advance at different RATES, i.e. drift — which
   *      is what a second AudioContext would cause and is the whole reason
   *      there is only one.
   *
   * Both are checked here against the real StemRingWriter, by putting an impulse
   * at the same absolute frame on all TWENTY-FOUR stem planes of both decks
   * (12 per deck at six stems, was 8) and measuring where each one comes out.
   */
  {
    const plan = makeLivePlan(LIVE_HOP_DEFAULT);
    // 2^19 frames: three chunks at hop 1.95 publish 255 780 frames and the ring
    // must hold all of them un-lapped so the impulse can still be found.
    const mk = () => new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(1 << 19)), 1 << 19);
    const A = mk(), B = mk();
    const IMPULSE_AT = 5000;

    // Both decks publish through their own LiveEmitter, from their own model
    // output, exactly as runChunk does.
    const emit = (ring, seed) => {
      const em = new LiveEmitter(plan, SEAM_XFADE_LAW);
      const mixL = new Float32Array(plan.H), mixR = new Float32Array(plan.H);
      for (let k = 0; k < 3; k++) {
        const c = chunkPlan(k, plan);
        const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT));
        // one impulse, same ABSOLUTE frame, on every plane of both decks
        const local = IMPULSE_AT - c.emitFrom + c.srcOffset;
        if (local >= 0 && local < SEGMENT) for (const p of src) p[local] = seed;
        const e = em.chunk(k, src, mixL, mixR);
        ring.write(e.from, e.planes, e.len);
      }
    };
    emit(A, 1);
    emit(B, 1);

    const findAll = (ring) => {
      const out = [];
      for (let q = 0; q < STEM_PLANES; q++) {
        const pl = ring.planes[q];
        let at = -1;
        for (let i = 0; i < ring.writeFrames(); i++) if (Math.abs(pl[i]) > 0.5) { at = i; break; }
        out.push(at);
      }
      return out;
    };
    const posA = findAll(A), posB = findAll(B);
    ok(`deck A: all ${STEM_PLANES} stem planes carry the impulse at the SAME frame, Δ = 0`,
      posA.length === STEM_PLANES && new Set(posA).size === 1 && posA[0] >= 0, `[${posA.join(' ')}]`);
    ok('deck B: same', posB.length === STEM_PLANES && new Set(posB).size === 1 && posB[0] >= 0, `[${posB.join(' ')}]`);
    ok(`ACROSS decks: all ${2 * STEM_PLANES} planes land on the same absolute frame, Δ = 0`,
      new Set([...posA, ...posB]).size === 1 && posA.length + posB.length === 2 * STEM_PLANES,
      `A ${posA[0]} vs B ${posB[0]} (Δ ${Math.abs(posA[0] - posB[0])})`);
    ok('...and that frame is where the schedule says it should be',
      posA[0] === IMPULSE_AT, `${posA[0]} vs ${IMPULSE_AT}`);
    ok('both decks published exactly the same number of frames — no per-deck length skew',
      A.writeFrames() === B.writeFrames(), `${A.writeFrames()} vs ${B.writeFrames()}`);
  }

  head('dual — one clock: two decks cannot drift (the reason there is one AudioContext)');
  {
    /**
     * The playback worklets advance their read pointers by exactly `n` frames
     * per process() call, and BOTH run in the same audio thread on the same
     * render quantum. So the invariant is not "the pointers are equal" — the
     * decks arm at different times and are deliberately allowed to be offset —
     * it is that the DIFFERENCE never changes.
     *
     * This mirrors playback-processor.js's `r += n; Atomics.store(...)`. It is a
     * RENDERING-ONLY test in the taxonomy at the top of this file: it cannot see
     * the worklet failing to run the loop. Reached by: dual-live-probe.mjs
     * reports both decks' playedFrames off the running engine over 340 s.
     */
    const cap = 1 << 16;
    const A = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(cap)), cap);
    const B = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(cap)), cap);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(4096));
    // deck A arms first; deck B arms 1500 frames later. That offset is expected.
    A.write(0, planes, 4096); A.play(true);
    B.write(0, planes, 4096); B.play(true);
    let rA = 0, rB = -1500;
    const skews = [];
    for (let quantum = 0; quantum < 200; quantum++) {
      // one shared render quantum advances BOTH decks by the same 128 frames
      const n = 128;
      if (A.writeFrames() - rA < n) A.write(A.writeFrames(), planes, 4096);
      if (B.writeFrames() - Math.max(0, rB) < n) B.write(B.writeFrames(), planes, 4096);
      rA += n; rB += n;
      skews.push(rA - rB);
    }
    ok('the A/B read-pointer skew is constant to the sample across 200 render quanta — one clock, zero drift',
      new Set(skews).size === 1 && skews[0] === 1500, `skew ${[...new Set(skews)].join(',')}`);
    ok('...which is what a second AudioContext would break, and why Mode 3 forbids one',
      DECKS.length === 2);
  }

  head('dual — backpressure when only ONE deck is late');
  {
    /**
     * RENDERING ONLY (taxonomy at the top): this drives the real `skipFrames`
     * decision against a simulated clock, exactly as the `live` group does, but
     * for two decks at once. Reached by: dual-live-probe.mjs reports per-deck
     * drops/demotions/underruns off the running engine.
     *
     * The property under test is ISOLATION. Deck B falling behind must produce
     * passthrough on deck B and change NOTHING about deck A — not its schedule,
     * not its drops, not its published frames.
     */
    const plan = makeLivePlan(LIVE_HOP_DEFAULT);
    const lowWater = Math.round(LIVE_LOW_WATER_SEC * SR);
    const step = (st, cap, cushion) => {
      let filled = 0;
      for (;;) {
        const n = skipFrames({ cap, commit: st.commit, plan, k: st.k, playing: true, cushion, lowWater });
        if (n === 0) break;
        st.commit += n; st.k++; st.drops++; filled += n;
      }
      // the on-time path
      const c = chunkPlan(st.k, plan);
      if (cap >= c.inputEnd && st.commit === c.emitFrom) { st.commit = c.emitTo; st.k++; st.done++; }
      return filled;
    };
    const A = { k: 0, commit: 0, drops: 0, done: 0 };
    const B = { k: 0, commit: 0, drops: 0, done: 0 };
    // 12 hops of capture. Deck A always has cushion; deck B is starved from hop 4.
    for (let hop = 1; hop <= 12; hop++) {
      const cap = hop * plan.H;
      step(A, cap, plan.H);                        // healthy
      step(B, cap, hop >= 4 ? 0 : plan.H);         // starving from hop 4
    }
    ok('deck B starving produces passthrough spans on deck B', B.drops > 0, `${B.drops} spans`);
    ok('deck A is untouched by deck B starving: zero drops', A.drops === 0);
    ok('both decks still published a contiguous, gapless stream — a drop fills the span, it never skips it',
      A.commit === B.commit && A.commit > 0, `A ${A.commit}, B ${B.commit}`);
    ok('and every published frame is accounted for as either separated or passthrough',
      A.done + A.drops === A.k && B.done + B.drops === B.k, `A ${A.done}+${A.drops}=${A.k}  B ${B.done}+${B.drops}=${B.k}`);
  }
}

// ===========================================================================
if (group('host')) {
  head('host — the ENGINE half of the Host seam: a Host that cannot do the job is refused at boot');
  /**
   * WHAT THIS COVERS AND WHY IT IS WORTH A GATE.
   *
   * `extension/shared/host.js` declares what the unit asks of whatever is
   * hosting it, and `assertHost()` refuses a Host that is short a duty at MODULE
   * EVALUATION. The moment matters: without it, a Host missing `captureStream`
   * surfaces as `host.captureStream is not a function` thrown from inside
   * `captureStart`, which is precisely the halfway R5 is about — a capture that
   * fails after the track exists and leaves the user's tab silent.
   *
   * WHICH KIND OF TEST THIS IS — the RENDERING vs REACHABILITY rule at the head
   * of this file. NOT rendering-only, and in three separate ways, because
   * driving `assertHost()` with hand-built stubs and stopping there would be:
   *
   *   1. The shipping Host is DRIVEN, never imitated.
   *      `extension/offscreen/host.js` — the module `offscreen/engine.js`
   *      imports and the only EngineHost that ships — goes through the real
   *      `assertHost`, and further down each of its five duties is CALLED with
   *      the platform stubbed underneath it. Deleting a duty from that file, or
   *      changing what one returns, turns this group red. It is also the CONTROL
   *      for the refusals below: without it, "a broken Host is refused" would be
   *      satisfied by a function that refuses everything.
   *   2. The CALL SITE is read out of `engine.js`. `assertHost` working proves
   *      nothing about the engine ever calling it — review proved exactly that,
   *      by deleting the module-scope call and watching the whole tree stay
   *      green while two assertion names went on claiming it as their entry
   *      point.
   *   3. The stubs exist only to break ONE declared duty at a time, which is the
   *      one thing a real Host cannot be asked to do on demand.
   */
  const { assertHost, ENGINE_HOST_DUTIES, DECK_HOST_DUTIES } = await import('./extension/shared/host.js');
  const engineHost = await import('./extension/offscreen/host.js');
  const duties = Object.keys(ENGINE_HOST_DUTIES);
  const threw = (fn) => { try { fn(); return null; } catch (e) { return String((e && e.message) || e); } };
  /** A Host that owes exactly what is declared, so each case below breaks ONE thing. */
  const stub = () => Object.fromEntries(duties.map((k) => [k, () => {}]));

  const shipping = threw(() => assertHost(engineHost, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('THE SHIPPING EngineHost SATISFIES EVERY DECLARED DUTY  '
    + '[entry point: extension/offscreen/host.js, the module extension/offscreen/engine.js imports]',
    duties.length > 0 && shipping === null,
    duties.length === 0
      ? 'ENGINE_HOST_DUTIES is empty — this assertion has no coverage at all'
      : shipping || `${duties.length} duties: ${duties.join(', ')}`);

  const noCapture = stub();
  delete noCapture.captureStream;
  const why = threw(() => assertHost(noCapture, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('A HOST THAT CANNOT OPEN A CAPTURE IS REFUSED, AND THE ERROR NAMES THE DUTY  '
    + '[entry point: assertHost(), called at extension/offscreen/engine.js module scope]',
    why != null && why.includes('captureStream') && why.includes(ENGINE_HOST_DUTIES.captureStream),
    why == null
      ? 'a Host with no captureStream was ACCEPTED — the engine would boot and fail at the first arm instead'
      : why);

  /**
   * Matched as `name() — `, the exact form `assertHost` lists a MISSING duty in,
   * rather than as a bare identifier anywhere in the sentence. The bare form
   * passes today only because no duty's help text happens to contain another
   * duty's name; a duty added by S2 or S7 whose sentence mentions one, or a
   * rewording of `captureStream`'s, would turn this red for a reason that has
   * nothing to do with the claim, and a red that is about wording costs an
   * investigation to discover that it is.
   */
  const listed = (k) => why != null && why.includes(`${k}() — `);
  ok('...and it names ONLY the duty that is missing, so the message is a repair instruction',
    listed('captureStream') && duties.filter((k) => k !== 'captureStream').every((k) => !listed(k)),
    why == null ? 'nothing was thrown' : why);

  const absent = threw(() => assertHost(undefined, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('AN ABSENT HOST IS THE LOUDEST FAILURE HERE, NOT THE QUIETEST  '
    + '[entry point: assertHost(), the `!host || ...` shape AGENTS.md bans]',
    absent != null && absent.includes('no host module was supplied'),
    absent == null
      ? 'assertHost(undefined) returned without throwing — a seam check that reports coverage exactly when it has none'
      : absent);

  const notCallable = stub();
  notCallable.assetUrl = 'vendor/ort/';
  const nc = threw(() => assertHost(notCallable, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('A DUTY THAT IS PRESENT BUT NOT CALLABLE COUNTS AS MISSING',
    nc != null && nc.includes('assetUrl'),
    nc == null ? 'a Host whose assetUrl is a string was ACCEPTED' : nc);

  const empty = threw(() => assertHost(stub(), {}, 'EngineHost'));
  ok('AN EMPTY DUTY LIST IS REFUSED — nothing can be asserted about a Host nothing was asked of',
    empty != null && empty.includes('no duties were declared'),
    empty == null ? 'assertHost(host, {}) accepted a Host it checked nothing about' : empty);

  /**
   * FROM HERE DOWN, THE ENGINE IS READ AS TEXT rather than imported.
   * `extension/offscreen/engine.js` builds an AudioContext, a Worker and a
   * MasterBus at module scope, so it cannot be evaluated from Node at all —
   * every claim below about what the engine DOES is therefore made against its
   * source, the same shape `qa/speed-pitch.mjs` uses to read the key-lock policy
   * out of `content.js`. Comments are stripped first: these are claims about
   * code, and a claim a doc comment can satisfy is not a claim.
   */
  const { readFileSync } = await import('node:fs');
  const engineRaw = readFileSync(new URL('./extension/offscreen/engine.js', import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const engineSrc = strip(engineRaw);

  /**
   * THE CHECK IS ONLY WORTH ITS NAME IF THE ENGINE ACTUALLY RUNS IT — AND RUNS
   * IT FIRST.
   *
   * Every refusal above drives `assertHost` directly, which proves the function
   * works and proves nothing at all about `offscreen/engine.js` ever calling it.
   * Review proved the gap by deleting the module-scope call together with its
   * import: `node test.js host` stayed 11 passed 0 failed and the whole `--quick`
   * stayed GREEN, while two assertions above went on naming that call site as
   * their entry point. The interface-drift pair below cannot see it either — it
   * matches `host.x(`, and `assertHost` is not `host.`-prefixed.
   *
   * THE MOMENT IS THE POINT (`shared/host.js`): before `MasterBus`, before
   * `Deck`, and before the boot `HELLO` that is the first thing to reach
   * `host.send`. After any of those, a Host short a duty is a TypeError one
   * layer down — for `captureStream`, thrown from inside `captureStart` with a
   * track already taken off the user's tab, which is the halfway R5 exists to
   * prevent.
   *
   * FAILS IF IT CANNOT LOOK: a call that is gone, commented out or no longer
   * first is a red, and so is a build in which the three constructions it is
   * ordered against cannot be found.
   */
  const bootAt = engineSrc.indexOf('assertHost(host, ENGINE_HOST_DUTIES');
  ok('THE ENGINE ITSELF RUNS THE CHECK — assertHost() is called at engine.js module scope, not only from this file  '
    + '[entry point: extension/offscreen/engine.js module scope, comments stripped]',
    bootAt >= 0,
    bootAt >= 0
      ? 'engine.js refuses to boot on a Host that is short a duty'
      : 'no `assertHost(host, ENGINE_HOST_DUTIES` call in extension/offscreen/engine.js — every refusal above still '
        + 'passes, and a Host missing captureStream now fails inside captureStart with a track already off the tab (R5)');

  const BUILDS = ['new MasterBus(', 'new Deck(', "send({ type: 'HELLO' })"];
  const builtAt = BUILDS.map((b) => ({ b, i: engineSrc.indexOf(b) }));
  const unfound = builtAt.filter((x) => x.i < 0).map((x) => x.b);
  const firstBuild = builtAt.reduce((a, x) => (x.i >= 0 && (a.i < 0 || x.i < a.i) ? x : a));
  ok('...and it runs BEFORE the first construction that would otherwise fail one layer down',
    bootAt >= 0 && unfound.length === 0 && bootAt < firstBuild.i,
    unfound.length
      ? `cannot look: ${unfound.join(', ')} not found in engine.js, so this ordering claim has no anchor`
      : bootAt < 0
        ? 'there is no assertHost call to order'
        : bootAt < firstBuild.i
          ? `assertHost at ${bootAt} chars precedes \`${firstBuild.b}\` at ${firstBuild.i}`
          : `assertHost at ${bootAt} chars runs AFTER \`${firstBuild.b}\` at ${firstBuild.i} — `
            + 'the Host is already in use by the time it is checked');

  /**
   * THE INTERFACE AND ITS ONE CONSUMER MUST NOT DRIFT APART, in either
   * direction. S2 and S7 both add duties to this seam; a duty used but not
   * declared is a Host that passes `assertHost` and then throws, and a duty
   * declared but never used is one more thing a second Host must implement for
   * nothing.
   *
   * Matched as CALLS (`host.x(`) rather than as any `host.x`, because
   * `import * as host from './host.js'` would otherwise contribute a duty named
   * `js`.
   */
  const reached = [...new Set([...engineSrc.matchAll(/\bhost\.(\w+)\s*\(/g)].map((m) => m[1]))].sort();
  const undeclared = reached.filter((k) => !duties.includes(k));
  ok('EVERY HOST DUTY THE ENGINE REACHES FOR IS DECLARED  '
    + '[entry point: extension/offscreen/engine.js, comments stripped]',
    reached.length > 0 && undeclared.length === 0,
    reached.length === 0
      ? 'the engine calls no host duty at all — either the seam is gone or this scan cannot see it'
      : undeclared.length
        ? `undeclared: ${undeclared.map((k) => `host.${k}()`).join(', ')} — declare it in ENGINE_HOST_DUTIES or a Host will pass assertHost and still throw`
        : `${reached.length} reached: ${reached.join(', ')}`);

  const unreached = duties.filter((k) => !reached.includes(k));
  ok('...and every declared duty is actually reached for, so a second Host implements nothing dead',
    reached.length > 0 && unreached.length === 0,
    unreached.length ? `declared but never called: ${unreached.join(', ')}` : `all ${duties.length}`);

  /**
   * R5 — TRACK-STOP DISCIPLINE, ASSERTED FOR THE FIRST TIME.
   *
   * `docs/ARCHITECTURE.md` R5: holding the MediaStream track IS the tab mute.
   * Chrome mutes a tab the moment it is captured and releasing the track
   * unmutes it, so a capture that fails after the stream exists — and does not
   * stop it — leaves the user's tab permanently silent with no affordance to
   * fix it. `SECURITY.md` puts that in scope as a vulnerability.
   *
   * It had no assertion anywhere before this slice, and the slice is exactly
   * the edit most likely to break it: the token now crosses a Host boundary
   * (`host.captureStream`), so the tempting mistake is a null check, a log line
   * or an early return between the stream arriving and the guard that stops it.
   *
   * READ OUT OF THE BUILD rather than reimplemented, the same shape
   * `qa/speed-pitch.mjs` uses to read the key-lock policy out of `content.js`
   * and `qa/passthrough-gain.mjs` uses to read `pushGains` out of `live.js`.
   * `captureStart` cannot be driven from Node — `offscreen/engine.js` builds an
   * AudioContext, a Worker and a MasterBus at module scope — so the claim is
   * made where it is checkable. FAILS IF IT CANNOT LOOK: a `captureStart` this
   * cannot locate, or a second `host.captureStream` call it did not expect, is
   * a red rather than a silent pass.
   */
  const capAt = engineRaw.indexOf('\nasync function captureStart(');
  const capBody = capAt < 0 ? null : engineRaw.slice(capAt + 1).split(/\n\}\n/)[0];
  /**
   * The WHOLE call statement is matched, up to its own `);`, and the stream's
   * name is read out of it rather than assumed. Splitting on the literal
   * `const s = await host.captureStream(` and then skipping to the next LINE was
   * blind to `const s = await host.captureStream(t); if (!s) return;` — the
   * third spelling of the very mistake the block above names, and the one the
   * typedef's "MUST REJECT rather than resolve null" exists because someone will
   * reach for. There is no linter in this repo to forbid the one-line form.
   * Matching the statement also means a reformat of the call, or a rename of
   * `s`, no longer reports a false R5 red.
   */
  const opens = capBody ? [...capBody.matchAll(/const (\w+) = await host\.captureStream\([\s\S]*?\);/g)] : [];
  const sVar = opens.length === 1 ? opens[0][1] : null;
  const afterOpen = opens.length === 1 ? strip(capBody.slice(opens[0].index + opens[0][0].length)) : null;
  ok('R5 — THE CAPTURE TOKEN IS SPENT INSIDE THE GUARD: nothing at all runs between the stream arriving and the try that stops it  '
    + '[entry point: extension/offscreen/engine.js captureStart(), reached from the CAPTURE_START case]',
    afterOpen != null && /^\s*try\s*\{/.test(afterOpen),
    capBody == null
      ? 'could not locate `async function captureStart(` in extension/offscreen/engine.js. The gate cannot look, so it fails.'
      : opens.length !== 1
        ? `expected exactly one \`const <name> = await host.captureStream(…);\`, found ${opens.length} — `
          + 'a second way to open a capture is a second way to leak one'
        : /^\s*try\s*\{/.test(afterOpen)
          ? 'the statement after the stream exists is `try {`'
          : `the statement after the stream exists is ${JSON.stringify(afterOpen.trim().slice(0, 90))}, not a try. `
            + 'Chrome mutes the tab the moment it is captured: anything that can return or throw here leaves it silent for good.');

  const guard = capBody ? capBody.match(/catch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\n {2}\}/) : null;
  /**
   * BOUND TO THE STREAM THIS FUNCTION JUST OPENED, and to every track on it.
   * An unbound `.getTracks() … .stop()` cannot tell `s` from `d.stream`, and on
   * the path this guard exists for they are not synonyms: `deck.js` throws
   * `deck <id> is already capturing` BEFORE it assigns `this.stream`, so on a
   * re-entrant start — the first case the comment above the try names —
   * `d.stream` is either null, and `null.getTracks()` throws inside the catch
   * and REPLACES the rethrow the sibling assertion checks for, or it is the
   * PREVIOUS stream, and the one just opened leaks with the tab muted for good.
   * Anchoring on `.forEach(` immediately after `.getTracks()` is what carries
   * the word EVERY: a `.filter((t) => t.kind === 'video')` in between stops no
   * audio track at all, and an unanchored match cannot see the difference.
   *
   * The exception this encodes, so the red is self-explaining: the guard must
   * stop the stream by the NAME the open bound it to, in one `.forEach((t) =>
   * t.stop())`. A `for (const t of …)` rewrite is a red — deliberately, because
   * the assertion cannot bind a receiver it cannot parse.
   */
  const stops = guard && sVar
    ? new RegExp(`\\b${sVar}\\.getTracks\\(\\)\\.forEach\\(\\((\\w+)\\) => \\1\\.stop\\(\\)\\)`).test(guard[2])
    : false;
  const rethrows = guard ? new RegExp(`throw\\s+${guard[1]}\\b`).test(guard[2]) : false;
  ok('...and that guard STOPS EVERY TRACK OF THE STREAM IT JUST OPENED, AND RETHROWS — a swallowed failure is a muted tab under a deck that reports idle',
    stops && rethrows,
    guard == null ? 'no catch block found in captureStart at all'
      : sVar == null ? 'the stream the guard must stop could not be named, so what it stops cannot be checked'
        : !stops ? `the catch does not stop every track of \`${sVar}\`: ${JSON.stringify(guard[2].trim())}`
          : !rethrows ? `the catch stops the tracks but does not rethrow ${guard[1]}, so the CAPTURE_START case would report success`
            : `catch (${guard[1]}) stops every track of \`${sVar}\` and rethrows`);

  /**
   * The other end of the same rule: R5's third track-stop site. `pagehide` used
   * to be written here; it is now `host.onTeardown`, because the moment a
   * context goes away is the Host's fact and not the engine's — but WHAT must
   * not be left behind is still the engine's.
   */
  const tdAt = engineRaw.indexOf('host.onTeardown(');
  const tdBody = tdAt < 0 ? null : engineRaw.slice(tdAt).split(/\n\}\);/)[0];
  ok('R5 — TEARDOWN STOPS THE TRACKS TOO, so a context going away unmutes the tab  '
    + '[entry point: extension/offscreen/engine.js, the host.onTeardown callback]',
    tdBody != null && /\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(tdBody),
    tdAt < 0
      ? 'no host.onTeardown( call in extension/offscreen/engine.js — R5s last-gasp stop is gone entirely'
      : /\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(tdBody)
        ? 'the teardown callback stops every track on every live deck'
        : `the teardown callback does not stop the tracks: ${JSON.stringify(tdBody.trim().slice(0, 90))}`);

  /**
   * THE DUTIES SPELLED `MUST`, HELD AGAINST THE ONE IMPLEMENTATION THAT HAS
   * THEM RIGHT.
   *
   * `assertHost` checks `typeof host[k] === 'function'` and nothing else, so
   * every MUST in the `EngineHost` typedef was documentation with no gate: a
   * Host whose `send` returns a promise, whose `onMessage` drops the routing
   * guard or re-wraps the envelope, or whose `captureStream` resolves null
   * instead of rejecting, passes the boot check and then fails quietly, far from
   * the mistake. The sharpest case is the one an Electron Host reaches for
   * first — `send = (m) => ipcRenderer.invoke('unit', m)` — which satisfies
   * `assertHost` and reintroduces exactly the unhandled rejection per 10 Hz
   * heartbeat that this Host's `.catch(() => {})` is load-bearing against.
   *
   * The whole value of declaring an interface rather than grepping for `chrome.`
   * is that a second implementer can be checked against it, and "did you define
   * five functions" is the question they are least likely to get wrong. The
   * deck's half below is the same shape against `DeckHost`, so the coverage this
   * seam has is the coverage both contexts get.
   *
   * REACHABLE, NOT CONSTRUCTED: every assertion below CALLS the shipping
   * `extension/offscreen/host.js`. What is stubbed is the PLATFORM underneath it
   * — `chrome`, `navigator.mediaDevices`, `addEventListener` — never the Host
   * itself, because the platform is the only part that cannot be present in
   * Node. The globals are removed again in the `finally`.
   */
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const wire = [];
  const registered = [];
  let inbox = null;
  let handled = false;
  let gum = null;
  let gumArg = null;
  /**
   * NOT a real rejected promise. An unhandled rejection ENDS THE PROCESS in
   * Node, so the mutation this exists to catch — a `send` that does not attach a
   * rejection handler — would take the whole suite out instead of turning one
   * line red, and a suite that dies is not a suite that reports. This thenable
   * records whether a rejection handler was attached at all; `.catch(fn)` and
   * `.then(null, fn)` both count, because the claim is that the failure is
   * handled, not how.
   */
  const deliveryFailure = () => ({
    then(_ok, err) { handled = true; if (err) err(new Error('Could not establish connection.')); return this; },
    catch(err) { return this.then(undefined, err); },
  });
  globalThis.chrome = {
    runtime: {
      sendMessage: (m) => { wire.push(m); return deliveryFailure(); },
      onMessage: { addListener: (fn) => { inbox = fn; } },
      getURL: (rel) => `chrome-extension://ffffffffffffffffffffffffffff/${rel}`,
    },
  };
  globalThis.addEventListener = (type, fn) => { registered.push([type, fn]); };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: (c) => { gumArg = c; return gum(); } } },
    configurable: true,
    writable: true,
  });
  /**
   * Every duty is reached through `probe`, never called bare. A Host short a
   * duty is already red at the top of this group, and it must not ALSO take the
   * suite out on its way past: a file that dies at assertion three reports
   * nothing about the seven after it. An unreachable duty becomes the
   * assertion's own detail and the assertion fails — the same verdict, by a
   * route someone can read.
   */
  const probe = (f, ...a) => {
    try { return { ok: true, v: f(...a) }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; }
  };
  try {
    const sendCall = probe(engineHost.send, { type: 'HELLO' });
    const ret = sendCall.v;
    ok('send() RETURNS UNDEFINED, NEVER A PROMISE  '
      + '[entry point: extension/offscreen/host.js send(), reached from the 22 `return send({...})` sites in engine.js]',
      sendCall.ok && ret === undefined,
      !sendCall.ok
        ? `send() could not be called at all: ${sendCall.e}`
        : ret === undefined
          ? 'undefined'
          : `send() returned ${ret && typeof ret.then === 'function' ? 'a thenable' : JSON.stringify(ret)} — `
            + 'a `case` that ends `return send({...})` inside an async function would await it');

    ok('...and it SWALLOWS the delivery failure: with no surface open there is no listener, and that is entirely normal',
      wire.length === 1 && handled === true,
      wire.length !== 1
        ? `send() put ${wire.length} messages on the bus, expected 1 — the claim has nothing to look at`
        : handled
          ? 'the rejection is handled; unhandled, it is one console error per 10 Hz heartbeat'
          : 'nothing was attached to the promise sendMessage returned — every heartbeat becomes an unhandled rejection');

    ok('...and the HOST addresses it, not the engine: the engine hands over a bare {type} and the deck sees a full envelope  '
      + '[entry point: extension/offscreen/host.js send()]',
      wire.length === 1 && wire[0].v === 1 && wire[0].to === 'ui' && wire[0].from === 'off' && wire[0].type === 'HELLO',
      wire.length === 1 ? JSON.stringify(wire[0]) : `${wire.length} messages on the bus, expected 1`);

    const seen = [];
    const inboxCall = probe(engineHost.onMessage, (m) => { seen.push(m); });
    const notMine = { v: 1, to: 'ui', from: 'off', type: 'STATE' };
    const rOther = inbox ? inbox(notMine) : null;
    const rNull = inbox ? inbox(null) : null;
    ok("onMessage()'s ROUTING GUARD IS THE HOST'S: a message addressed elsewhere never reaches the engine  "
      + '[entry point: extension/offscreen/host.js onMessage(), reached from engine.js module scope]',
      inbox != null && seen.length === 0,
      inbox == null
        ? `onMessage registered no listener with the platform at all — the engine has no inbox${inboxCall.ok ? '' : ` (${inboxCall.e})`}`
        : seen.length === 0
          ? 'chrome.runtime.sendMessage is a broadcast, so `to` is the routing, and the routing is applied here'
          : `the engine was handed ${seen.length} message(s) not addressed to it: ${JSON.stringify(seen)}`);

    const mine = { v: 1, to: 'off', from: 'sw', type: 'CAPTURE_START', streamId: 'tok' };
    const rMine = inbox ? inbox(mine) : null;
    ok('...and what it hands over is the RAW ENVELOPE — the same object, not a copy and not the payload',
      seen.length === 1 && seen[0] === mine,
      seen.length !== 1
        ? `the engine's inbox ran ${seen.length} times for one addressed message`
        : seen[0] === mine
          ? 'the same object, unwrapped and un-normalised'
          : `the engine was handed ${JSON.stringify(seen[0])}, not the envelope the bus carried`);

    ok('...and the listener returns falsy, so MV3 does not hold the message channel open for every message the engine receives',
      inbox != null && !rMine && !rOther && !rNull,
      inbox == null ? 'no listener was registered' : `to:'off' -> ${JSON.stringify(rMine)}, to:'ui' -> ${JSON.stringify(rOther)}, null -> ${JSON.stringify(rNull)}`);

    gum = () => Promise.reject(new Error('NotAllowedError: permission denied'));
    const failing = probe(engineHost.captureStream, 'token-A');
    const outcome = failing.ok
      ? await Promise.resolve(failing.v).then((v) => ({ resolved: true, v }), (e) => ({ resolved: false, e }))
      : { unreachable: failing.e };
    ok('captureStream() REJECTS RATHER THAN RESOLVING NULL — a null would travel on as a capture with no track  '
      + '[entry point: extension/offscreen/host.js captureStream(), reached from engine.js captureStart()]',
      outcome.resolved === false,
      outcome.unreachable
        ? `captureStream() could not be called at all: ${outcome.unreachable}`
        : outcome.resolved === false
          ? String(outcome.e && outcome.e.message)
          : `the failure resolved as ${JSON.stringify(outcome.v)} — every caller is .catch-wrapped, so the engine `
            + 'would attach it and report a live capture over a stream with no track');

    const track = { kind: 'audio', stop() {} };
    const stream = { getTracks: () => [track] };
    gum = () => Promise.resolve(stream);
    const opening = probe(engineHost.captureStream, 'token-B');
    const got = opening.ok ? await Promise.resolve(opening.v).catch(() => null) : null;
    const tokenThrough = gumArg && gumArg.video === false
      && gumArg.audio && gumArg.audio.mandatory && gumArg.audio.mandatory.chromeMediaSourceId === 'token-B';
    ok('...and OWNERSHIP TRANSFERS: the stream arrives exactly as the platform made it, and the opaque token reached the platform untouched',
      got === stream && tokenThrough === true,
      got !== stream
        ? 'the Host wrapped or replaced the stream — the engine stops the tracks (R5) on the object it is handed, so a wrapper leaks the real one'
        : tokenThrough
          ? JSON.stringify(gumArg)
          : `the token did not reach getUserMedia intact: ${JSON.stringify(gumArg)}`);

    const assetCall = probe(engineHost.assetUrl, 'offscreen/capture-processor.js');
    const url = assetCall.v;
    ok('assetUrl() IS SYNCHRONOUS AND RETURNS A STRING — it is called from constructors that run before there is an AudioContext to await on  '
      + '[entry point: extension/offscreen/host.js assetUrl(), reached from engine.js ensureContext()]',
      assetCall.ok && typeof url === 'string' && url.endsWith('/offscreen/capture-processor.js'),
      !assetCall.ok
        ? `assetUrl() could not be called at all: ${assetCall.e}`
        : typeof url !== 'string'
          ? `assetUrl returned ${url && typeof url.then === 'function' ? 'a promise' : typeof url} — `
            + 'audioWorklet.addModule() would be handed it verbatim'
          : url);

    const tdFn = () => {};
    const tdCall = probe(engineHost.onTeardown, tdFn);
    ok("onTeardown() REGISTERS THE ENGINE'S OWN CALLBACK, unwrapped, so nothing can defer or await the last-gasp stop  "
      + '[entry point: extension/offscreen/host.js onTeardown(), reached from engine.js module scope]',
      tdCall.ok && registered.length === 1 && registered[0][0] === 'pagehide' && registered[0][1] === tdFn,
      !tdCall.ok
        ? `onTeardown() could not be called at all: ${tdCall.e}`
        : registered.length !== 1
          ? `onTeardown registered ${registered.length} listeners, expected 1`
          : registered[0][1] !== tdFn
            ? "the registered handler is a wrapper, not the engine's callback — teardown does not await, "
              + 'so a wrapper that returns a promise drops the track stop'
            : `${registered[0][0]}, the engine's own function`);
  } finally {
    delete globalThis.chrome;
    delete globalThis.addEventListener;
    Object.defineProperty(globalThis, 'navigator', realNavigator);
  }

  head('host — the DECK half of the same seam: the boot check, and the transport it hides');
  /**
   * The shipped DeckHost, driven and never imitated: a check that reimplemented
   * the two-line module it is guarding would be a second copy of the bug. It
   * names `chrome` only inside its two function bodies, so importing it costs
   * nothing here and the stub goes on `globalThis` at the point of use.
   */
  const deckHost = (await import('./extension/ui/host.js')).host;
  const deckDuties = Object.keys(DECK_HOST_DUTIES);
  /**
   * RENDERING vs REACHABILITY: reachable by construction. Every assertion below
   * drives the SHIPPED `extension/ui/host.js` and the SHIPPED `assertHost`, with
   * a `chrome` stub standing in for the bus. Nothing here reimplements either.
   *
   * WHY THESE ARE HERE AND NOT ONLY IN `tools/embed-smoke.mjs`. The browser gate
   * covers the deck end to end and it is the only thing that can — but CI runs
   * `--quick` and never reaches it (`.github/workflows/verify.yml`), which is
   * exactly why the chord fix had to leave an `embed-state` assertion behind as
   * well. The two things a broken Host breaks SILENTLY are late binding and the
   * envelope, so both get an assertion on this side of the browser too.
   */

  // ---------------------------------------------------------- the boot check
  /**
   * ENTRY POINT: `assertHost(host, DECK_HOST_DUTIES, 'DeckHost')` at the top of
   * `extension/ui/embed.js`. `assertHost` now has TWO callers — the block above
   * drives it through `ENGINE_HOST_DUTIES` from `offscreen/engine.js`'s side —
   * and a duty list that is right for one and wrong for the other is exactly the
   * "right at one call site, wrong at another" defect AGENTS.md counts five of.
   * So these name the deck's list, not "a host".
   */
  {
    const complete = { send() {}, onMessage() {} };
    ok('assertHost-returns-the-host-it-was-given: a complete DeckHost boots',
      assertHost(complete, DECK_HOST_DUTIES, 'DeckHost') === complete);

    ok('assertHost-passes-the-SHIPPED-ui/host.js — this is the gate on its export list',
      assertHost(deckHost, DECK_HOST_DUTIES, 'DeckHost') === deckHost,
      deckDuties.join(', '));

    const threw = (h) => { try { assertHost(h, DECK_HOST_DUTIES, 'DeckHost'); return null; } catch (e) { return e; } };

    const noSend = threw({ onMessage() {} });
    ok('assertHost-NAMES-the-missing-duty: a Host without `send` throws saying `send`',
      noSend instanceof Error && /\bsend\b/.test(noSend.message) && /DeckHost/.test(noSend.message),
      noSend ? noSend.message : 'it did not throw');

    const noneAtAll = threw({});
    ok('assertHost-names-EVERY-missing-duty, not just the first',
      noneAtAll !== null && /\bsend\b/.test(noneAtAll.message) && /\bonMessage\b/.test(noneAtAll.message),
      noneAtAll ? noneAtAll.message : 'it did not throw');

    /**
     * NOT ONLY THE STRING CASE. Both reviews of this wave found the same
     * survivor: the deck's `assertHost` accepted `typeof v === 'object'` before
     * the two halves were merged, so `{ send: {} }` — an Electron preload
     * bridge wrapped one level too deep, and the likeliest shape a second Host
     * gets wrong — passed the boot check and then died at the first user
     * gesture with `host.send is not a function`, which is the exact failure
     * this check exists to move to boot. The engine's half already required a
     * function; the merged `assertHost` keeps that, and this holds it for the
     * deck's list too. Widening it again for a genuinely namespace-shaped duty
     * (S4's `storage`) turns this red, which is the point: it should be a
     * deliberate change with its own assertion, not a side effect.
     */
    const wrongShapes = [
      ['a lost export, which reads as a string rather than as absence', { send: 'sendMessage', onMessage() {} }],
      ['a namespace object where a callable was meant', { send: {}, onMessage() {} }],
      ['an array', { send: [], onMessage() {} }],
    ];
    const waved = wrongShapes.filter(([, h]) => threw(h) === null).map(([why]) => why);
    ok('assertHost-refuses-a-duty-that-is-present-but-NOT-CALLABLE, in every shape a wrong one arrives in',
      wrongShapes.length === 3 && waved.length === 0,
      waved.length ? `ACCEPTED: ${waved.join('; ')}` : `refused all ${wrongShapes.length}`);

    /**
     * "An assertion must FAIL when it cannot look" (AGENTS.md). A boot check
     * that excused itself when there was no host at all would report the seam
     * intact on precisely the run where nothing was wired.
     *
     * IT IS NOT ENOUGH THAT SOMETHING THREW, which is all this could see before
     * the merge — and review proved it by deleting the absent-host guard and
     * watching the group stay green. Without the guard `assertHost(null, …)`
     * still throws, as `Cannot read properties of null (reading 'send')`: no
     * seam named, no duty named, no file to look in. That sentence is the whole
     * reason the check is at boot rather than at first call, so the assertion
     * reads the sentence rather than the fact of a throw.
     */
    const namesTheSeam = (h) => {
      const e = threw(h);
      return e !== null && /DeckHost/.test(e.message) && /\bsend\b/.test(e.message) && /\bonMessage\b/.test(e.message);
    };
    const noHost = threw(undefined);
    ok('assertHost-with-no-Host-AT-ALL-throws rather than passing vacuously, and the error still names the seam and both duties',
      namesTheSeam(undefined) && namesTheSeam(null),
      noHost === null ? 'assertHost(undefined) returned without throwing' : noHost.message);
  }

  // ------------------------------------------------------- the outgoing wire
  /**
   * THE LATE-BINDING RULE, ASSERTED WITHOUT A BROWSER — `shared/host.js` rule 2.
   *
   * `tools/embed-smoke.mjs` observes the deck's whole outgoing wire by replacing
   * the PROPERTY `chrome.runtime.sendMessage` after the deck has booted. A Host
   * that captured the function at import time — `bind`, or a module-scope
   * `const send = chrome.runtime.sendMessage` — leaves that recorder empty, and
   * `[].every()` and `![].some()` are both true, so the transpose-ceiling and
   * speed/ad-gate assertions report GREEN while inspecting nothing. That is a
   * failure this repo has already paid for once, and CI cannot see the browser
   * gate. So it is re-asserted here, against the same shipped module, by doing
   * the same thing the smoke gate does: patch the property, and count.
   */
  {
    const before = [], after = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: (m) => { before.push(m); return Promise.resolve(); },
        onMessage: { addListener() {} },
      },
    };
    deckHost.send({ v: 1, to: 'off', from: 'ui', type: 'STATUS' });
    // exactly what tools/embed-smoke.mjs does, after boot, to the property
    chrome.runtime.sendMessage = (m) => { after.push(m); return Promise.resolve(); };
    deckHost.send({ v: 1, to: 'off', from: 'ui', type: 'PITCH', deck: 'A', semitones: 2 });

    ok('send-resolves-the-transport-at-CALL-time: a property swapped after boot receives the next message',
      before.length === 1 && after.length === 1 && after[0].type === 'PITCH',
      `${before.length} before the swap, ${after.length} after — a bound transport gives 2 and 0`);

    /**
     * THE ENVELOPE IS THE UNIT'S — `shared/host.js` rule 1. The host may not add
     * a field, rename one, or drop one: `tools/embed-smoke.mjs` injects a raw
     * `{v:1,to:'ui',from:'off',type:'LIVE_STATE',…}` from the service worker on
     * the strength of that, and a re-wrapping host breaks it with no symptom,
     * because a `LIVE_STATE` that never arrives leaves the last one on screen.
     */
    // `|| null` and not `|| {}`: an unrecorded message is this assertion's own
    // failure, not an excuse from it, and a bare `after[0]` would throw and take
    // the rest of the group with it instead of going red on its own line.
    const got = after[0] || null;
    ok('send-carries-the-envelope-VERBATIM: no field added, renamed or dropped',
      got !== null && Object.keys(got).sort().join(',') === 'deck,from,semitones,to,type,v'
      && got.v === 1 && got.to === 'off' && got.from === 'ui' && got.deck === 'A' && got.semitones === 2,
      got ? Object.keys(got).sort().join(',') : 'nothing reached the transport at all');

    ok('send-returns-nothing, so no call site can start awaiting delivery',
      deckHost.send({ v: 1, to: 'sw', from: 'ui', type: 'SW_STATUS' }) === undefined);
  }

  /**
   * DELIVERY FAILURE IS THE HOST'S TO SWALLOW — `shared/host.js` rule 3. There
   * is very often no listener on this bus, and the deck sends on a 10 Hz
   * heartbeat; one unhandled rejection per message is a console nobody can read.
   */
  {
    let unhandled = 0;
    const count = () => { unhandled++; };
    process.on('unhandledRejection', count);

    // INSTRUMENT CHECK. `unhandled === 0` below is worth nothing unless this
    // counter can move at all — an unwired handler and a swallowed rejection
    // look identical from the assertion's side.
    Promise.reject(new Error('control: this one is deliberately not caught'));
    await new Promise((r) => setTimeout(r, 20));
    ok('INSTRUMENT CHECK: an uncaught rejection in this harness IS counted',
      unhandled === 1, `${unhandled} counted`);

    unhandled = 0;
    globalThis.chrome = {
      runtime: {
        sendMessage: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
        onMessage: { addListener() {} },
      },
    };
    deckHost.send({ v: 1, to: 'off', from: 'ui', type: 'STATUS' });
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', count);
    ok('send-swallows-a-delivery-failure: a message nobody is listening for is not an error',
      unhandled === 0, `${unhandled} unhandled rejections from one undeliverable message`);
  }

  // ------------------------------------------------------- the incoming wire
  /**
   * THE ADDRESS FILTER AND THE RESPONSE CHANNEL ARE THE HOST'S — rule 4. Both
   * are facts about the transport: `chrome.runtime.sendMessage` is a BROADCAST,
   * so every context hears every message, and MV3 reads a truthy return from a
   * listener as "I will call `sendResponse` later" and holds the channel open
   * for it. Neither belongs in a deck that has to run somewhere else too.
   */
  {
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (f) => listeners.push(f) },
      },
    };
    const seen = [];
    deckHost.onMessage((m) => { seen.push(m); return true; });

    // INSTRUMENT CHECK: everything below reads `listeners[0]`, so an onMessage
    // that registered nothing would leave every one of them inspecting a stub
    // of this file's own making.
    ok('INSTRUMENT CHECK: onMessage registered exactly one listener on the bus',
      listeners.length === 1, `${listeners.length} registered`);

    const mine = { v: 1, to: 'ui', from: 'off', type: 'LIVE_STATE', status: 'running', latencySec: 1.5 };
    const rets = [
      listeners[0]({ v: 1, to: 'sw', from: 'ui', type: 'SW_STATUS' }),
      listeners[0]({ v: 1, to: 'off', from: 'ui', type: 'STATUS' }),
      listeners[0]({ v: 1, to: 'tab', from: 'sw', type: 'STEM_SPLITTER_LIVE_EMBED' }),
      listeners[0](null),
      listeners[0](mine),
    ];

    ok('onMessage-delivers-only-what-is-addressed-here: 1 of 5 on a broadcast bus',
      seen.length === 1 && seen[0].type === 'LIVE_STATE',
      `${seen.length} delivered of 5 (to: sw, off, tab, null, ui)`);

    ok('onMessage-hands-the-deck-the-SAME-message, envelope and all',
      seen.length === 1 && seen[0] === mine && seen[0].v === 1 && seen[0].from === 'off'
      && seen[0].latencySec === 1.5);

    /**
     * The handler above returns `true` on purpose: the control has to be able to
     * lose. If the host forwarded what the deck returned, this would read `true`
     * for the one message it delivered, and Chrome would hold a response channel
     * open for every `LIVE_STATE` at 10 Hz.
     */
    ok('onMessage-never-holds-the-response-channel-open, not even for a handler that returns true',
      rets.length === 5 && rets.every((r) => r === false),
      rets.map((r) => String(r)).join(' '));
  }

  delete globalThis.chrome;

  head('host — S2: the audio graph asks the Host for every asset URL it needs');
  /**
   * WHAT THIS COVERS, AND WHY IT IS NOT ALREADY COVERED BY THE BLOCK ABOVE.
   *
   * `assetUrl` was a declared duty before this slice and `offscreen/engine.js`
   * called it — once, for the capture worklet. The unit's other five asset URLs
   * did not go through the seam at all: the master meter worklet (`master.js`),
   * the playback worklet twice over (`live.js` and `cacheddeck.js`, once per
   * kind of deck), and the ORT runtime directory plus its presence probe
   * (`deck.js`) each called `chrome.runtime.getURL` themselves. A second Host
   * could therefore implement all five duties perfectly and still not load a
   * single worklet — and neither `assertHost` nor the interface-drift pair above
   * can see that, because both only ever look at `engine.js`.
   *
   * REACHABLE, NOT CONSTRUCTED — and the fact that it CAN be reachable is itself
   * the result this slice is after. All four files now import and run under Node
   * with no `chrome` global in existence, so every claim below drives the
   * shipped graph builder and reads back what it asked the Host for. The same
   * code before this slice threw `chrome is not defined` on the first line of
   * each of the five sites.
   *
   * WHAT IS STUBBED IS THE PLATFORM, NEVER THE GRAPH. `addModule` records the
   * URL it is handed and resolves; construction then dies at the first real Web
   * Audio node, which Node does not have. That is deliberate rather than
   * tolerated: the claim is about what the builder asked the Host for, and
   * everything after `addModule` is the browser gate's job
   * (`tools/embed-smoke.mjs`).
   *
   * THE RESOLVER IS A STUB WITH A SCHEME NOTHING ELSE USES (`stub://unit/`), so
   * a URL that reached `addModule` by any other route — a surviving literal, a
   * second copy of the path — cannot be mistaken for one that came from the Host.
   */
  {
    const asked = [];
    const assetUrl = (relPath) => { asked.push(relPath); return `stub://unit/${relPath}`; };
    /** a fake AudioContext that can do exactly one thing: record an addModule */
    const fakeCtx = () => {
      const added = [];
      return { added, sampleRate: SR, audioWorklet: { addModule: async (url) => { added.push(url); } } };
    };
    /** run a builder to the point where Node runs out of Web Audio, and keep the reason */
    const drive = (p) => p.then(() => null, (e) => String((e && e.message) || e));

    // ------------------------------------------------------------ master bus
    const { MasterBus } = await import('./extension/offscreen/master.js');
    let noResolver = null;
    try { new MasterBus(null); } catch (e) { noResolver = String((e && e.message) || e); }
    ok("THE MASTER BUS REFUSES TO BE CONSTRUCTED WITHOUT THE HOST'S RESOLVER  "
      + '[entry point: extension/offscreen/master.js constructor — its one construction is '
      + '`new MasterBus(null, host.assetUrl)` at engine.js module scope]',
      noResolver != null && noResolver.includes('assetUrl'),
      noResolver == null
        ? 'new MasterBus(null) was ACCEPTED. A short HOST is not what this catches — assertHost() already refuses '
          + 'one, a few lines earlier in engine.js. What is left is the WIRING: an engine.js that reverts to a late '
          + 'setter or drops the argument, after which a bus with no resolver says nothing at boot and throws inside '
          + '_build(), at the first arm, with a deck already half-wired'
        : noResolver);

    const busCtx = fakeCtx();
    const bus = new MasterBus(null, assetUrl);
    // exactly what engine.js does at ensureContext(): the context arrives late,
    // the resolver did not.
    bus.ctx = busCtx;
    const busWhy = await drive(bus.build());
    ok('THE MASTER METER WORKLET IS RESOLVED THROUGH THE HOST  '
      + '[entry point: extension/offscreen/master.js _build(), the only addModule in the file]',
      busCtx.added.length === 1 && busCtx.added[0] === 'stub://unit/offscreen/master-meter-processor.js',
      busCtx.added.length === 0
        ? `_build() never reached addModule, so this inspected nothing: ${busWhy}`
        : busCtx.added.join(', '));

    // ---------------------------------------------------------- the live deck
    const { LivePipeline } = await import('./extension/offscreen/live.js');
    const liveCtx = fakeCtx();
    const lp = new LivePipeline({
      deck: 'A', ctx: () => liveCtx, master: () => null, ring: () => null,
      infer: async () => ({}), ensureModel: async () => {}, send: () => {}, log: () => {},
      assetUrl,
    });
    const liveWhy = await drive(lp.build());
    ok('THE LIVE DECK RESOLVES ITS PLAYBACK WORKLET THROUGH THE HOST  '
      + '[entry point: extension/offscreen/live.js LivePipeline.build(), reached from start()]',
      liveCtx.added.length === 1 && liveCtx.added[0] === 'stub://unit/offscreen/playback-processor.js',
      liveCtx.added.length === 0
        ? `build() never reached addModule, so this inspected nothing: ${liveWhy}`
        : liveCtx.added.join(', '));

    // -------------------------------------------------------- the cached deck
    // A CONTEXT OF ITS OWN. The two kinds of deck register the same processor
    // name, and whether one registration is allowed to stand in for the other is
    // a separate claim with its own block below; here they must not share, or
    // this assertion would pass on the live deck's work.
    const cachedCtx = fakeCtx();
    const cd = new CachedDeck('A', {
      ctx: () => cachedCtx, master: () => null, send: () => {}, log: () => {}, assetUrl,
    });
    const cachedWhy = await drive(cd.ensureGraph());
    ok('...AND SO DOES THE CACHED DECK, which registers the same worklet by a different path  '
      + '[entry point: extension/offscreen/cacheddeck.js CachedDeck.ensureGraph(), reached from load()]',
      cachedCtx.added.length === 1 && cachedCtx.added[0] === 'stub://unit/offscreen/playback-processor.js',
      cachedCtx.added.length === 0
        ? `ensureGraph() never reached addModule, so this inspected nothing: ${cachedWhy}`
        : cachedCtx.added.join(', '));

    // ------------------------------------------------------- the ORT runtime
    /**
     * THE INFERENCE WORKER'S TWO URLS, WHICH ARE NOT THE SAME KIND OF THING.
     *
     * `vendor/ort/` and the probe that names it are FILES ON DISK, so they go
     * through the Host. The worker module itself is reached by
     * `new URL(..., import.meta.url)` and must not — see the note in
     * `ensureWorker()`. Both halves are asserted, because "thread everything
     * through the Host" and "thread the RIGHT things through the Host" fail
     * differently: the second is a Host handed authority over the unit's own
     * directory layout, and it would go unnoticed under this Host, where the two
     * answers happen to agree.
     */
    const { Deck } = await import('./extension/offscreen/deck.js');
    const posts = [];
    const spawned = [];
    const fetched = [];
    const realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let deckWhy = null;
    try {
      globalThis.Worker = class {
        constructor(url, opts) { this.url = String(url); this.opts = opts; spawned.push(this); }
        postMessage(m) { posts.push(m); }
        terminate() {}
      };
      globalThis.fetch = (url, init) => {
        fetched.push({ url: String(url), method: init && init.method });
        return Promise.resolve({ ok: true });
      };
      const d = new Deck('A', {
        ctx: () => null, master: () => null, gpu: null,
        modelBytes: async () => new ArrayBuffer(8),
        send: () => {}, log: () => {}, armRefMs: () => 0, assetUrl,
      });
      const session = d.ensureSession();
      // LOAD_MODEL is posted after two awaits; nothing here may assume how many.
      for (let i = 0; i < 200 && !d.sessionReady; i++) await new Promise((r) => setTimeout(r, 0));
      if (d.sessionReady) d.onWorker({ type: 'MODEL_READY', ep: 'stub', createMs: 0, warmupMs: 0 });
      deckWhy = await drive(session);
    } finally {
      delete globalThis.Worker;
      if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch);
      else delete globalThis.fetch;
    }

    ok('THE ORT PRESENCE PROBE IS RESOLVED THROUGH THE HOST, and it is still a HEAD  '
      + '[entry point: extension/offscreen/deck.js Deck.ensureSession(), reached from LIVE_START and DECK_PREPARE]',
      fetched.length === 1 && fetched[0].url === 'stub://unit/vendor/ort/ort.all.bundle.min.mjs'
      && fetched[0].method === 'HEAD',
      fetched.length === 0
        ? `ensureSession() never reached the probe, so this inspected nothing: ${deckWhy}`
        : JSON.stringify(fetched));

    const init = posts.find((m) => m && m.type === 'INIT');
    ok('...and the worker is told where the ORT runtime lives as a DIRECTORY url from the Host  '
      + '[entry point: extension/offscreen/deck.js Deck.ensureWorker(), reached from ensureSession()]',
      init != null && init.wasmDirUrl === 'stub://unit/vendor/ort/' && init.wasmDirUrl.endsWith('/'),
      init == null
        ? `no INIT was posted, so this inspected nothing: ${deckWhy}. Posted: ${posts.map((m) => m && m.type).join(', ')}`
        : String(init.wasmDirUrl));

    /**
     * THE ONE URL THE HOST DOES NOT GET TO RESOLVE, asserted from both sides: the
     * worker was spawned from a path ending in the unit's own layout, and the
     * Host was never asked about it. Asking only the first would be satisfied by
     * a build that resolved it through the Host to the same place, which is
     * exactly what this Host would do.
     */
    const workerUrl = spawned.length === 1 ? spawned[0].url : null;
    ok("THE INFERENCE WORKER'S OWN URL STAYS RELATIVE — the unit's directory layout is the unit's contract, not the Host's  "
      + '[entry point: extension/offscreen/deck.js Deck.ensureWorker()]',
      workerUrl != null && workerUrl.endsWith('/extension/workers/inference.worker.js')
      && !asked.some((p) => /worker/i.test(p)),
      spawned.length !== 1
        ? `expected exactly one Worker to be spawned, got ${spawned.length}: ${deckWhy}`
        : asked.some((p) => /worker/i.test(p))
          ? `the Host was asked to resolve ${JSON.stringify(asked.filter((p) => /worker/i.test(p)))} — `
            + 'a Host that answers that owns where the unit keeps its own files'
          : workerUrl);

    // ------------------------------------------- and nothing reaches past it
    /**
     * THE NEGATIVE HALF OF THE SLICE, read out of the tree rather than from a
     * grep in a PR body: after this slice `offscreen/host.js` is the only file
     * in the directory that says `chrome.` at all. Comments are stripped first —
     * three prose mentions survive on purpose (`live.js` twice, `cacheddeck.js`
     * once) and a claim a comment can satisfy is not a claim.
     *
     * FAILS IF IT CANNOT LOOK, in both directions: an empty or unrecognisable
     * file list is a red, and so is a strip that has eaten the calls it is
     * supposed to find — which the control below is the only thing that could
     * notice.
     */
    const { readdirSync } = await import('node:fs');
    const offDir = new URL('./extension/offscreen/', import.meta.url);
    const offFiles = readdirSync(offDir).filter((f) => f.endsWith('.js')).sort();
    const readOff = (f) => strip(readFileSync(new URL(f, offDir), 'utf8'));
    const offenders = offFiles.filter((f) => f !== 'host.js' && /\bchrome\./.test(readOff(f)));
    ok('THE HOST IS THE ONLY FILE UNDER offscreen/ THAT SAYS chrome.  '
      + '[entry point: the shipped tree, comments stripped]',
      offFiles.length >= 8 && offFiles.includes('host.js') && offenders.length === 0,
      offFiles.length < 8 || !offFiles.includes('host.js')
        ? `the scan found ${offFiles.length} .js files under offscreen/ and ${offFiles.includes('host.js') ? 'did' : 'did NOT'} `
          + 'find host.js — it is not looking at the directory it thinks it is'
        : offenders.length
          ? `${offenders.join(', ')} still reach Chrome directly, so a second Host cannot load what they load`
          : `${offFiles.length - 1} files clean, host.js excepted`);

    ok('INSTRUMENT CHECK: the scan can still SEE a chrome. call — offscreen/host.js, the one file that must have them  '
      + '[control: it has to be able to lose]',
      offFiles.includes('host.js') && /\bchrome\./.test(readOff('host.js')),
      offFiles.includes('host.js')
        ? `host.js: ${(readOff('host.js').match(/\bchrome\.\w+/g) || []).join(', ') || 'NOTHING — the strip ate them, and the claim above is vacuous'}`
        : 'offscreen/host.js was not found at all');

    /**
     * AND THEY TAKE THE RESOLVER RATHER THAN IMPORTING THE HOST. Four files that
     * each did `import { assetUrl } from './host.js'` would pass the scan above
     * and would work perfectly under this Host — while putting four more imports
     * of the platform into the half of the unit that is meant to be
     * host-agnostic, which is the property ADR 0001 decision 5 is buying.
     */
    const GRAPH = ['deck.js', 'live.js', 'cacheddeck.js', 'master.js'];
    const importers = GRAPH.filter((f) => /from\s+'\.\/host\.js'/.test(readOff(f)));
    ok('...and the audio graph TAKES the resolver rather than importing the Host: the platform enters at one door  '
      + '[entry point: extension/offscreen/{deck,live,cacheddeck,master}.js]',
      GRAPH.every((f) => offFiles.includes(f)) && importers.length === 0,
      !GRAPH.every((f) => offFiles.includes(f))
        ? `missing from the directory: ${GRAPH.filter((f) => !offFiles.includes(f)).join(', ')}`
        : importers.length
          ? `${importers.join(', ')} import ./host.js directly`
          : `${GRAPH.length} files scanned, resolver passed in from engine.js`);

    // ------------------------------------------ and where the thread STARTS
    /**
     * THE ORIGIN OF THE THREAD — the one claim the ten above cannot make, and
     * the one the slice is actually named after.
     *
     * Each of those ten hands the builder a `stub://unit/` resolver written in
     * this file. Together they prove the four files USE a resolver; not one of
     * them proves that `offscreen/engine.js` SUPPLIES one. Review measured the
     * hole exactly: delete the single line `assetUrl: host.assetUrl` from the
     * `shared` bundle and `--quick` stays GREEN at 18 of 20 steps and
     * `embed-smoke` stays at 122/122, while the shipped extension dies at
     * module evaluation — `engine.js` calls `decks.A.ensureWorker()` at module
     * scope and it throws `this.s.assetUrl is not a function`. No INIT, no
     * HELLO, no engine, and nothing red anywhere. That is the exact shape
     * AGENTS.md names as the source of five defects here: a value right at four
     * call sites and absent at the one that feeds them.
     *
     * TWO GATES NOW, BECAUSE CI IS ONLY ONE OF THEM. `Deck` and `CachedDeck`
     * refuse a bundle short the resolver (below), which turns that mutation
     * into a module-scope throw — and a module-scope throw takes `embed-smoke`
     * to `5/37 FAILED`. This pair is what makes `--quick`, the only gate
     * GitHub Actions runs, see it too.
     *
     * READ AS TEXT for the reason the block at the top of this group gives:
     * `engine.js` cannot be imported from Node at all. Comments are stripped —
     * which matters here more than usual, because the doc comment sitting
     * directly above the line quotes the seam in prose. The `strip` control a
     * few assertions above is what keeps that stripping honest.
     */
    const sharedAt = engineSrc.indexOf('const shared = {');
    const sharedLit = sharedAt < 0 ? null : engineSrc.slice(sharedAt).split(/\n\};/)[0];
    /**
     * EVERY construction is parsed, and the parsed count is compared with the
     * raw one, so a `new Deck(` this pattern cannot read is a red rather than a
     * silent pass — there are three today (deck A at module scope, deck B in
     * `deck()`, and the cached deck in `cachedDeck()`) and a fourth must not
     * arrive unnoticed.
     */
    const constructions = (engineSrc.match(/new (?:Deck|CachedDeck)\(/g) || []).length;
    const takers = [...engineSrc.matchAll(/new (?:Deck|CachedDeck)\(\s*[^,()]+,\s*([A-Za-z_$][\w$]*)\s*\)/g)];
    const notShared = takers.filter((m) => m[1] !== 'shared').map((m) => m[0]);
    const onBundle = sharedLit != null && /(^|\n)\s*assetUrl:\s*host\.assetUrl\s*,/.test(sharedLit);
    ok("THE ENGINE PUTS THE HOST'S RESOLVER ON THE BUNDLE, and the bundle is what every deck is built from  "
      + '[entry point: extension/offscreen/engine.js `const shared = {`, comments stripped]',
      sharedLit != null && onBundle
      && constructions >= 2 && takers.length === constructions && notShared.length === 0,
      sharedLit == null
        ? 'cannot look: no `const shared = {` in extension/offscreen/engine.js, so there is no bundle to inspect'
        : !onBundle
          ? 'the `shared` bundle does NOT carry `assetUrl: host.assetUrl`. Every deck then reads undefined: '
            + 'engine.js calls decks.A.ensureWorker() at module scope, so the engine does not boot at all — no INIT '
            + 'to the inference worker and no HELLO to the deck'
          : takers.length !== constructions
            ? `cannot look: ${constructions} deck constructions in engine.js but only ${takers.length} could be read, `
              + 'so one of them is built from something this claim never inspected'
            : notShared.length
              ? `built from something other than the bundle: ${notShared.join(', ')}`
              : `assetUrl: host.assetUrl on the bundle, and all ${constructions} deck constructions take it`);

    /**
     * The whole argument list is read to the statement's own `);` and the LAST
     * argument taken from it, rather than a shape-matched pair: a resolver
     * wrapped, replaced by a literal or dropped entirely all have to name the
     * defect, and a pattern that only matches two bare identifiers reports
     * "cannot look" for the two most likely of the three.
     */
    const busCall = engineSrc.match(/new MasterBus\(([\s\S]*?)\);/);
    const busSecond = busCall == null ? null : busCall[1].slice(busCall[1].indexOf(',') + 1).trim();
    ok('...AND HANDS IT TO THE MASTER BUS TOO, which is constructed before there is a context to await on  '
      + '[entry point: extension/offscreen/engine.js module scope, comments stripped]',
      busCall != null && busSecond === 'host.assetUrl',
      busCall == null
        ? 'cannot look: no `new MasterBus(…);` statement in extension/offscreen/engine.js'
        : busSecond === 'host.assetUrl'
          ? busCall[0]
          : `the bus is handed ${JSON.stringify(busSecond)} rather than host.assetUrl — the Host is no longer what `
            + 'decides where offscreen/master-meter-processor.js lives');

    /**
     * AND THE DECKS REFUSE A BUNDLE THAT LOST IT, which is what makes the two
     * source reads above a belt rather than the only strap.
     *
     * `assertHost()` cannot cover this: it checks the HOST — that
     * `host.assetUrl` is a function — and it runs before any of this. The
     * hand-off from the Host onto `shared` is a separate step with a separate
     * way to go wrong, and it had no alarm at all. `MasterBus` refuses the same
     * way and has since this slice's first commit; the asymmetry review found
     * was that the DECK side did not, so the mutation stayed silent in the
     * browser while `new MasterBus(null)` would have aborted engine.js on the
     * spot.
     */
    const shortLive = threw(() => new Deck('A', { ctx: () => null, master: () => null, send: () => {}, log: () => {} }));
    ok("THE LIVE DECK REFUSES A SHARED BUNDLE THAT IS SHORT THE HOST'S RESOLVER  "
      + "[entry point: extension/offscreen/deck.js constructor — `new Deck('A', shared)` runs at engine.js module scope]",
      shortLive != null && shortLive.includes('assetUrl'),
      shortLive == null
        ? 'new Deck(id, {…no assetUrl}) was ACCEPTED. The deck then reads undefined and throws `this.s.assetUrl is not '
          + 'a function` inside ensureWorker(), three layers from the mistake — and because that construction is at '
          + 'engine.js module scope, the browser gate is the only thing that could have seen it'
        : shortLive);

    const shortCached = threw(() => new CachedDeck('A', { ctx: () => null, master: () => null, send: () => {}, log: () => {} }));
    ok('...AND SO DOES THE CACHED DECK, which is built lazily and would otherwise find out at the first cache hit  '
      + '[entry point: extension/offscreen/cacheddeck.js constructor — `new CachedDeck(k, shared)` in engine.js cachedDeck()]',
      shortCached != null && shortCached.includes('assetUrl'),
      shortCached == null
        ? 'new CachedDeck(id, {…no assetUrl}) was ACCEPTED — ensureGraph() would then hand undefined() to addModule at '
          + 'the first cached play'
        : shortCached);
  }

  head('host — one playback worklet per AudioContext, whichever deck gets there first');
  /**
   * THE DEFECT THIS CLOSES. Mode 3 puts both decks on ONE AudioContext and both
   * kinds of deck play through the same `stem-playback` processor, so the second
   * registration on a context rejects with "A processor named 'stem-playback' is
   * already registered". That fact was tracked in TWO module-scoped WeakSets
   * that did not share state — one in `live.js`, one in `cacheddeck.js` — and
   * only one of the two files swallowed the rejection. So whether the collision
   * was survivable depended on WHICH DECK GOT THERE FIRST: live-then-cached was
   * fine, and cached-then-live rejected out of `LivePipeline.build()` and
   * surfaced as `START_FAILED`. A live deck that refuses to start because a
   * cached deck is already playing is the flagship dual-deck gesture failing.
   *
   * S2 is the slice that edits both of those lines, so it is the slice that
   * either fixes this or entrenches it: the shared set now lives in
   * `offscreen/worklets.js` and both decks go through it.
   *
   * REACHABLE, NOT CONSTRUCTED: the two direction assertions drive the SHIPPED
   * `LivePipeline.build()` and `CachedDeck.ensureGraph()` against ONE fake
   * context, in both orders. Nothing here reimplements the decision.
   *
   * THE FAKE CONTEXT REFUSES A SECOND REGISTRATION THE WAY CHROME DOES, with
   * Chrome's own wording, and the instrument check below is what makes the two
   * claims able to lose: against a permissive fake, "cached then live" would
   * pass on a build where live.js registered a second time and threw in the
   * browser.
   */
  {
    const { ensurePlaybackWorklet } = await import('./extension/offscreen/worklets.js');
    const { LivePipeline } = await import('./extension/offscreen/live.js');
    const assetUrl = (relPath) => `stub://unit/${relPath}`;
    const drive = (p) => p.then(() => null, (e) => String((e && e.message) || e));
    /** an AudioContext that registers a processor name exactly once, as Chrome does */
    const oneShotCtx = () => {
      const added = [];
      return {
        added,
        sampleRate: SR,
        audioWorklet: {
          addModule: async (url) => {
            if (added.includes(url)) throw new Error("A processor named 'stem-playback' is already registered");
            added.push(url);
          },
        },
      };
    };
    const liveOn = (ctx) => new LivePipeline({
      deck: 'A', ctx: () => ctx, master: () => null, ring: () => null,
      infer: async () => ({}), ensureModel: async () => {}, send: () => {}, log: () => {}, assetUrl,
    });
    const cachedOn = (ctx) => new CachedDeck('A', {
      ctx: () => ctx, master: () => null, send: () => {}, log: () => {}, assetUrl,
    });

    const probe = oneShotCtx();
    await probe.audioWorklet.addModule('stub://unit/offscreen/playback-processor.js');
    const second = await drive(probe.audioWorklet.addModule('stub://unit/offscreen/playback-processor.js'));
    ok('INSTRUMENT CHECK: the fake context refuses a second registration the way Chrome does  '
      + '[control: against a permissive fake, both claims below pass on a build that registers twice]',
      second != null && /already registered/i.test(second),
      second == null ? 'the fake accepted a second addModule of the same processor — it cannot reproduce the defect' : second);

    // ---- live first, then a cached deck on the same context
    const ctxLF = oneShotCtx();
    const lfLive = await drive(liveOn(ctxLF).build());
    const lfCached = await drive(cachedOn(ctxLF).ensureGraph());
    ok('LIVE FIRST, THEN CACHED ON THE SAME CONTEXT: one registration, and neither builder trips over it  '
      + '[entry point: live.js LivePipeline.build() then cacheddeck.js CachedDeck.ensureGraph()]',
      ctxLF.added.length === 1
      && !/already registered/i.test(String(lfLive)) && !/already registered/i.test(String(lfCached)),
      ctxLF.added.length !== 1
        ? `${ctxLF.added.length} registrations on one context, expected 1`
        : `1 registration; live stopped at ${JSON.stringify(String(lfLive).slice(0, 48))}, cached at ${JSON.stringify(String(lfCached).slice(0, 48))}`);

    // ---- and the other way round, which is the order that used to fail
    const ctxCF = oneShotCtx();
    const cfCached = await drive(cachedOn(ctxCF).ensureGraph());
    const cfLive = await drive(liveOn(ctxCF).build());
    ok('...AND CACHED FIRST, THEN LIVE — the order that used to reject out of build() as START_FAILED  '
      + '[entry point: cacheddeck.js CachedDeck.ensureGraph() then live.js LivePipeline.build()]',
      ctxCF.added.length === 1
      && !/already registered/i.test(String(cfCached)) && !/already registered/i.test(String(cfLive)),
      ctxCF.added.length !== 1
        ? `${ctxCF.added.length} registrations on one context, expected 1`
        : /already registered/i.test(String(cfLive))
          ? `the live deck rejected with ${JSON.stringify(String(cfLive))} — a live prime cannot start while a cached deck holds the context`
          : `1 registration; cached stopped at ${JSON.stringify(String(cfCached).slice(0, 48))}, live at ${JSON.stringify(String(cfLive).slice(0, 48))}`);

    /**
     * THE TWO REJECTIONS THAT ARE NOT THE SAME KIND, driven directly because
     * neither is reachable from a deck builder in Node: one is what the registrar
     * must swallow and the other is what it must never swallow, and a registrar
     * that got them the wrong way round would pass both direction claims above.
     */
    const collided = await drive(ensurePlaybackWorklet({
      audioWorklet: { addModule: async () => { throw new Error("A processor named 'stem-playback' is already registered"); } },
    }, assetUrl));
    ok('A NAME COLLISION IS TOLERATED — the module loaded, and the caller\'s AudioWorkletNode is what proves it  '
      + '[entry point: extension/offscreen/worklets.js ensurePlaybackWorklet(), the one both decks call]',
      collided === null,
      collided === null ? 'resolved' : `rejected with ${JSON.stringify(collided)}`);

    const broken = await drive(ensurePlaybackWorklet({
      audioWorklet: { addModule: async () => { throw new Error('Failed to fetch playback-processor.js'); } },
    }, assetUrl));
    ok('...AND A GENUINE LOAD FAILURE IS NOT — a 404 or a syntax error in the worklet still reaches the deck  '
      + '[entry point: extension/offscreen/worklets.js ensurePlaybackWorklet(), the one both decks call]',
      broken != null && /Failed to fetch/.test(broken),
      broken == null
        ? 'ensurePlaybackWorklet() SWALLOWED a load failure — the deck would then build a node for a processor that is not there'
        : broken);
  }
}

// ===========================================================================
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
