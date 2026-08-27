/**
 * BOUNCE - the offline render of what a deck is playing, gated without a browser.
 *
 *   node qa/bounce.mjs
 *
 * Read extension/engine/bounce.js for what a bounce is and why it bakes three
 * things and not four; extension/offscreen/bounce.js for the render path;
 * qa/lib/bounce-offline.mjs for what the harness really drives and what it
 * cannot see. This file is the evidence.
 *
 * ===========================================================================
 * WHY THE FIXTURES LOOK LIKE THIS - read before changing one
 * ===========================================================================
 *
 * A BOUNCE GATE RENDERED AT UNITY, NO MUTE, NO TRANSPOSE IS BLIND, and it is
 * blind in the exact way PHASE4-CONTRACT.md section 12's third failure
 * describes. At unity the bounce EQUALS the plain sum of the stems, so the
 * whole fader / mute / solo / crossfader stage could be missing and every
 * assertion would still pass. Any gate whose fixture makes two inputs identical
 * is blind to whatever distinguishes them.
 *
 * So every fixture below makes the settings DIFFER, and each assertion is
 * chosen so that breaking the code moves the number the WRONG way:
 *
 *   distinct gains   every stem a DIFFERENT known gain, asserted against the
 *                    analytically weighted sum. Delete the gain stage and the
 *                    residual gets LARGER, not smaller.
 *   solo             the others' energy as a RATIO against the soloed one. "The
 *                    others are quiet" passes on a bug that attenuates
 *                    everything; a ratio does not - and the soloed stem's own
 *                    level is asserted against its analytic value beside it, so
 *                    a uniform attenuation fails there.
 *   mute             the same shape, one stem down, ratio against an unmuted
 *                    reference.
 *   transpose        the fundamental moved by 2^(N/12) AND THE DRUMS LANE DID
 *                    NOT. A fixture with no drums content cannot see the second
 *                    half, so the drums fixture is a CLICK TRAIN - the signal a
 *                    phase vocoder smears most - and the assertion is that the
 *                    deliverable is the click train back, to the float floor.
 *
 * THE SIX TONES ARE ON EXACT ANALYSIS BINS, which is what makes the per-stem
 * measurement exact rather than approximate: at 44100 over a 4410-sample
 * window the bins are 10 Hz apart, 220/330/440/550/660/770 are bins
 * 22/33/44/55/66/77, and a Goertzel at one of them sees EXACTLY ZERO from the
 * other five. That is orthogonality, not a tolerance, and it is why six stems
 * can be measured simultaneously out of one summed render.
 *
 * THE TRANSPOSE FIXTURE IS SEPARATE FOR A MEASURED REASON. At +5 the shift
 * ratio is 1.3348, and 330 x 1.3348 = 440.45 - which lands on the `other`
 * stem's own 440 Hz bin. Measured directly while this suite was written: the
 * six-tone fixture at +5 read 0.121 at 440 Hz, which is bass's SHIFTED tone
 * sitting in another stem's band. One fixture per claim.
 *
 * ===========================================================================
 * WHAT A GREEN `bounce` IS NOT EVIDENCE OF - THREE GAPS, NAMED
 * ===========================================================================
 *
 * None of the three is covered by anything below, and each is easy to assume is
 * covered by all of it. They are listed first, before the table of what IS
 * measured, so nobody has to reach the end to find them.
 *
 *   1. NO UI CONSUMER, ANYWHERE. `BOUNCE_START` / `BOUNCE_CANCEL` are answered
 *      and `BOUNCE_PROGRESS` / `BOUNCE_DONE` / `BOUNCE_ERROR` are sent, and this
 *      suite drives the unit side of that wire - but nothing in this repository
 *      or the desktop one draws a Bounce button, a progress bar or an error
 *      banner. The closed code vocabulary exists so the FIRST consumer cannot be
 *      handed an invented code (#29); that is a promise about the emitter, and
 *      it is not evidence about a renderer that does not exist yet.
 *
 *   2. NOT RUN IN A REAL `OfflineAudioContext` IN THIS REPOSITORY, on any run.
 *      `qa/lib/bounce-offline.mjs` boots the SHIPPED worklet in a `vm` realm and
 *      pumps it at the 128-frame render quantum, honouring suspend/resume at
 *      quantum boundaries. Chromium's own `OfflineAudioContext` honouring a
 *      suspension schedule - the property the whole design rests on - was
 *      measured separately in Electron, 3/3, and is NOT re-measured here.
 *
 *   3. NO REAL-STEM BOUNCE. Every fixture is synthetic: six exact-bin tones, a
 *      click train, one sine. Nothing here has bounced htdemucs output or any
 *      recorded music at all. This suite is evidence about the GEOMETRY, the mix
 *      stage and the plumbing. It is not evidence that a bounce of a real track
 *      sounds like the deck did.
 *
 * ===========================================================================
 * THE MUTATION TABLE LIVES IN THE BATTERY, AND THAT IS THE POINT
 * ===========================================================================
 *
 * `node qa/bounce-mutations.mjs` is the authority. Every anchor carries, IN THE
 * TREE, the defect it introduces and the SET OF ASSERTIONS IT MUST TURN RED -
 * checked in both directions on every run, so a coverage loss that migrates from
 * one mutation to another cannot hide inside an unchanged total. It reports
 * three verdicts per anchor, because three different things have gone wrong in
 * this build: an anchor that no longer MATCHES (a decayed instrument), one that
 * matches and no longer REDS (decay or a real coverage loss), and one whose red
 * SET has moved. A fourth, `EQUIV`, is for a mutation that cannot be caught by
 * construction, with the arithmetic saying why.
 *
 * THERE IS NO SECOND COPY OF THAT TABLE HERE ANY MORE, and its removal is the
 * point rather than a tidy-up. There was one, and it decayed exactly the way
 * INTEGRATION.md section 26 says such tables do: it claimed "17/17 anchors,
 * against a 51-passed green baseline" for a suite that had become 72 assertions
 * and thirty-odd anchors, and its stamp named commits a rebase had already
 * rewritten. Nothing went red, because prose cannot. A measurement that lives
 * only in a comment is a measurement nobody is checking - and this file is the
 * wrong place to keep one, because editing an assertion here does not put the
 * table in front of the person editing it.
 *
 * LAST RUN OVER THIS TREE, 2026-08-27, over a 72-assertion green baseline:
 * 34/34 anchors still MATCH their source; 33 RED with exactly the assertions
 * they declare, in both directions; 1 EQUIVALENT by construction
 * (`bounce-tau-is-the-worklet-default` - 18 ms of ramp inside a 69.7 ms trim);
 * 0 needing attention. `guard-without-its-finally` is counted RED because the
 * suite HANGS rather than reporting, which is the whole point of layer 2.
 *
 * ===========================================================================
 * THE TWO-LAYER GUARD, AND ITS BOUND
 * ===========================================================================
 *
 * Every section runs inside `section()`. Layer 1 is the named throw at the call
 * site - each helper says which file and which call failed. Layer 2 is this
 * guard, which turns a throw anywhere in a section into a NAMED RED carrying
 * the section's name, so a render that constructs fine and throws on first use
 * still REPORTS instead of ending the suite in a stack trace with nothing
 * counted.
 *
 * THE BOUND: the guard converts a crash into a report. It does NOT recover the
 * assertions after the throw - everything later in that section simply never
 * runs, and the total drops by however many those were. A guarded suite is
 * never "fully covered"; it is a suite that told you which part stopped.
 */

import { rfft } from '../extension/engine/fft.js';
import { SR, STEMS, STEM_RING_FRAMES, RING_PLANES } from '../extension/shared/config.js';
import { StemRingWriter, stemRingByteLength } from '../extension/shared/stemring.js';
import { dbToGain, xfaderGains, xfFactor } from '../extension/engine/mixer.js';
import { decodeWav } from '../extension/shared/wav.js';
import {
  bouncePlan, bounceCushionFloor, bounceFileName, bounceError, BOUNCE_QUANTUM, BOUNCE_REFILL_FRAMES,
  BOUNCE_CODES, isBounceCode, bounceSettings, bounceRefusal, bounceWireCode,
} from '../extension/engine/bounce.js';
import { renderBounce, writeBounce, bounceToSink } from '../extension/offscreen/bounce.js';
import { makeOfflineHarness, makeFakeSink, QUANTUM } from './lib/bounce-offline.mjs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '../extension');

let pass = 0, fail = 0;
const ok = (n, c, d = '') => {
  c ? (pass++, console.log(`  \x1b[32mPASS\x1b[0m ${n}${d ? '  ' + d : ''}`))
    : (fail++, console.log(`  \x1b[31mFAIL\x1b[0m ${n}${d ? '  ' + d : ''}`));
};
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/** Layer 2 of the guard. See the header for what it does and does not recover. */
async function section(name, fn) {
  head(name);
  try { await fn(); } catch (e) {
    ok(`${name} — THE SECTION THREW and the assertions after the throw never ran`,
      false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | '));
  }
}

// ------------------------------------------------------------------ instruments

/**
 * Amplitude of `x` at `f`, over `n` samples from `from`. Goertzel, so it costs
 * one pass and no allocation, and it is EXACT at a bin centre: every fixture
 * frequency below is an integer multiple of SR/n, so the other five stems
 * contribute exactly zero rather than "a small amount".
 */
function amplitudeAt(x, f, from, n) {
  const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), k = 2 * c;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const t = x[from + i] + k * s1 - s2; s2 = s1; s1 = t; }
  const re = s1 - s2 * c, im = s2 * s;
  return 2 * Math.sqrt(re * re + im * im) / n;
}

/**
 * The dominant frequency near `x[off..off+n)`, or NaN when nothing in there is
 * peak-like. Copied in shape from extension/engine/pitchbank.js's `peakHz`,
 * including its refusal: an estimator that answered a number for noise would
 * let the transpose assertion pass having measured nothing.
 */
function peakHz(x, off, n = 16384) {
  const buf = new Float64Array(n);
  for (let i = 0; i < n; i++) buf[i] = (x[off + i] || 0) * 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
  const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
  rfft(buf, 0, n, re, im, 0, 1);
  const mag = new Float64Array(n / 2 + 1);
  let k = -1, mx = 0, sum = 0;
  for (let i = 1; i <= n / 2; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    sum += mag[i];
    if (mag[i] > mx) { mx = mag[i]; k = i; }
  }
  if (k < 2 || k >= n / 2 - 1) return NaN;
  if (mx < 20 * (sum / (n / 2))) return NaN;
  const a = Math.log(mag[k - 1]), b = Math.log(mag[k]), c = Math.log(mag[k + 1]);
  const den = a - 2 * b + c;
  if (!(den < 0)) return NaN;
  return (k + 0.5 * (a - c) / den) * SR / n;
}

/** 10*log10(||a-b||^2 / ||b||^2). The house A-vs-B instrument (qa/compare.mjs nulls()). */
function residualDb(a, b, n = Math.min(a.length, b.length)) {
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { const e = a[i] - b[i]; num += e * e; den += b[i] * b[i]; }
  return den === 0 ? (num === 0 ? -Infinity : Infinity) : 10 * Math.log10(num / den);
}
const peakOf = (x, from = 0, n = x.length - from) => {
  let p = 0; for (let i = 0; i < n; i++) { const v = Math.abs(x[from + i]); if (v > p) p = v; } return p;
};

// -------------------------------------------------------------------- fixtures

/** The six exact-bin tones. `W` below is the analysis window they are bins of. */
const W = 4410;                                  // 0.1 s -> 10 Hz bins
const F = [220, 330, 440, 550, 660, 770];        // bins 22, 33, 44, 55, 66, 77
const A = [0.20, 0.17, 0.14, 0.11, 0.09, 0.07];  // DISTINCT, so a swapped plane is visible

function silentStems(n) {
  const o = {};
  for (const s of STEMS) o[s] = [new Float32Array(n), new Float32Array(n)];
  return o;
}
function toneStems(n) {
  const o = silentStems(n);
  for (let k = 0; k < STEMS.length; k++) {
    const [L, R] = o[STEMS[k]];
    for (let i = 0; i < n; i++) { L[i] = A[k] * Math.sin(2 * Math.PI * F[k] * i / SR); R[i] = L[i]; }
  }
  return o;
}
/** A click train - the signal a phase vocoder smears most. Same shape as pitchbank's. */
function clickTrain(n) {
  const x = new Float32Array(n);
  for (let t = 0; t < n; t += Math.round(SR * 0.25)) {
    for (let i = 0; i < 24 && t + i < n; i++) x[t + i] = 0.9 * Math.exp(-i / 4) * (i % 2 ? -1 : 1);
  }
  return x;
}

const flatMix = () => STEMS.map(() => ({ gainDb: 0, muted: false, soloed: false }));
/** Unity everywhere: `assign: 'A'` on deck A bypasses the crossfader at every position. */
const unitySettings = (over = {}) => ({
  id: 'A', mix: flatMix(),
  xf: { position: 0.5, curve: 'dip', assign: STEMS.map(() => 'A') },
  masterDb: 0, semitones: 0, ...over,
});
/** Crossfader at the centre detent, every stem on it: the ordinary listening case. */
const centreSettings = (over = {}) => ({
  id: 'A', mix: flatMix(),
  xf: { position: 0.5, curve: 'dip', assign: STEMS.map(() => 'XF') },
  masterDb: 0, semitones: 0, ...over,
});

async function bounce(track, settings, extra = {}) {
  const h = makeOfflineHarness(EXT);
  const r = await renderBounce({ track, settings, assetUrl: h.assetUrl, audio: h.audio, ...extra });
  r.harness = h;
  return r;
}

// ===========================================================================
await section('1. the plan — pure arithmetic, no context and no clock', async () => {
  const p14 = bouncePlan({ frames: Math.round(14 * SR) });
  ok('the render is the track plus the transpose group delay, rounded UP to a whole render quantum',
    p14.renderFrames === Math.round(14 * SR) + 3072
      && p14.quantaFrames % BOUNCE_QUANTUM === 0
      && p14.quantaFrames >= p14.renderFrames
      && p14.quantaFrames - p14.renderFrames < BOUNCE_QUANTUM,
    `track ${p14.outputFrames} + trim ${p14.trimFrames} = ${p14.renderFrames} -> ${p14.quantaFrames} quanta frames`);

  ok('the producer stops every half-ring, and the stops are whole quanta',
    p14.refillEvery === (STEM_RING_FRAMES >> 1) && p14.refillEvery === BOUNCE_REFILL_FRAMES
      && p14.refills.every((r) => r.frame % BOUNCE_QUANTUM === 0)
      && p14.refills.map((r) => r.frame).join(',') === '262144,524288',
    `${p14.refills.length} stops at ${p14.refills.map((r) => r.frame).join(', ')}`);

  // THE INDEPENDENCE CHECK. Everything below is about refills; if no plan in the
  // sweep had one, the sweep would be measuring nothing at all.
  const lens = [1, 5, 11, 12, 14, 60, 240, 600];
  const plans = lens.map((s) => bouncePlan({ frames: Math.round(s * SR) }));
  const withRefills = plans.filter((p) => p.refills.length > 0).length;
  ok('the sweep really contains tracks that outlast the ring, or it is measuring nothing',
    withRefills >= 4 && plans[0].refills.length === 0,
    `${withRefills} of ${plans.length} lengths need a refill; ${lens[0]} s needs none, `
    + `${lens[lens.length - 1]} s needs ${plans[plans.length - 1].refills.length}`);

  let worst = null;
  for (let i = 0; i < plans.length; i++) {
    const f = bounceCushionFloor(plans[i]);
    if (!worst || f.frames < worst.f.frames) worst = { f, s: lens[i] };
  }
  ok('the plan leaves a cushion of at least one quantum at every render step, at every length',
    worst.f.frames >= BOUNCE_QUANTUM,
    `worst floor ${worst.f.frames} frames at frame ${worst.f.at} of the ${worst.s} s plan `
    + `(one quantum is ${BOUNCE_QUANTUM}; a correct plan runs dry exactly at the last step)`);

  // ...AND THE SAME INSTRUMENT, WATCHED FAILING. Without this, "the floor is
  // >= 128" is a claim about a function nobody has seen return anything else.
  const naive = bounceCushionFloor({ ...p14, refills: [] });
  const dry = p14.quantaFrames - STEM_RING_FRAMES;
  ok('...and that floor GOES NEGATIVE when the refills are removed, so it is an instrument and not a constant',
    naive.frames < 0 && naive.frames === STEM_RING_FRAMES - (p14.quantaFrames - BOUNCE_QUANTUM),
    `${naive.frames} frames at frame ${naive.at} (the last step) — a naive render runs dry at frame `
    + `${STEM_RING_FRAMES} and is short by ${dry} frames = ${(dry / SR).toFixed(2)} s of the 14 s track`);

  const threw = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };
  ok('a bounce of nothing is refused rather than written',
    /positive integer/.test(threw(() => bouncePlan({ frames: 0 })) || '')
    && /positive integer/.test(threw(() => bouncePlan({ frames: 1.5 })) || ''),
    threw(() => bouncePlan({ frames: 0 })));
  ok('a refill that is not a whole quantum is refused, because the implementation would round it',
    /render quantum/.test(threw(() => bouncePlan({ frames: SR, refillEvery: 1000 })) || ''),
    threw(() => bouncePlan({ frames: SR, refillEvery: 1000 })));
  ok('a refill period that does not fit the ring is refused',
    /does not fit/.test(threw(() => bouncePlan({ frames: SR, refillEvery: STEM_RING_FRAMES })) || ''),
    threw(() => bouncePlan({ frames: SR, refillEvery: STEM_RING_FRAMES })));
  ok('a ring capacity that is not a power of two is refused',
    /power of two/.test(threw(() => bouncePlan({ frames: SR, capacity: 1000 })) || ''));
});

// ===========================================================================
await section('2. one render, at unity — length, the head trim, and no starvation', async () => {
  const N = Math.round(2 * SR);
  const r = await bounce({ stems: toneStems(N), frames: N }, unitySettings());

  ok('the deliverable is exactly as long as the track — no drift, no rounding out of the quanta',
    r.frames === N && r.left.length === N && r.right.length === N,
    `${r.left.length} frames for a ${N}-frame track`);
  // THE LIVENESS HALF IS NOT DECORATION - see section 3b's second control. The
  // worklet only counts an underrun `if (play)`, so a ring that never played
  // reads 0 and 0 here while the deliverable is silence: the instrument's
  // PERFECT value on the worst defect in the slice. `framesRead` is the
  // consumer's own cursor and cannot be satisfied by a render that did nothing.
  ok('nothing starved: the ring never made the worklet fade, and the worklet really read it',
    r.underruns === 0 && r.underrunFrames === 0 && r.framesRead === r.plan.quantaFrames,
    `${r.underruns} underruns, ${r.underrunFrames} underrun frames, `
    + `${r.framesRead} of ${r.plan.quantaFrames} frames read off the ring `
    + '(a worklet that never played reads 0 frames and still reports 0 underruns)');

  // THE TRIM, AS A RATIO. The first 3072 frames of the RENDER are the transpose
  // lanes' initial zeros; if the trim were missing they would be the first 3072
  // frames of the FILE. Comparing the head to the middle is what makes the
  // number get worse rather than merely different: no trim -> head/mid = 0.
  const trimFrames = r.plan.trimFrames;
  const headPk = peakOf(r.left, 0, trimFrames);
  const midPk = peakOf(r.left, N >> 1, trimFrames);
  ok('the deliverable starts where the track starts — the transpose group delay is trimmed off the head',
    trimFrames === 3072 && midPk > 0.1 && headPk / midPk > 0.9,
    `head peak ${headPk.toFixed(5)} over the first ${trimFrames} frames, middle peak ${midPk.toFixed(5)}, `
    + `ratio ${(headPk / midPk).toFixed(4)} (an untrimmed bounce reads 0.0000)`);

  // ...and the tail is not faded either. Same ratio, other end.
  const tailPk = peakOf(r.left, N - trimFrames, trimFrames);
  ok('...and the deliverable ends where the track ends — the silent tail flushes the delay instead of starving it',
    tailPk / midPk > 0.9, `tail peak ${tailPk.toFixed(5)}, ratio ${(tailPk / midPk).toFixed(4)}`);
});

// ===========================================================================
await section('3. THE LONG FIXTURE — a bounce longer than the stem ring', async () => {
  const SECONDS = 14;
  const N = Math.round(SECONDS * SR);
  ok('the fixture really outlasts the ring, or this whole section is blind',
    N > STEM_RING_FRAMES,
    `${N} frames = ${SECONDS}.0 s against a ring of ${STEM_RING_FRAMES} frames `
    + `= ${(STEM_RING_FRAMES / SR).toFixed(2)} s`);

  // PROGRESS IS DRIVEN HERE rather than in a section of its own, because this is
  // the only fixture with more than one producer stop to report and a second
  // 14-second render would buy nothing.
  const ticks = [];
  const r = await bounce({ stems: toneStems(N), frames: N }, centreSettings(),
    { onProgress: (t) => ticks.push(t) });

  ok('a 14.0 s bounce runs to the end without starving — the count, not a listen',
    r.underruns === 0 && r.underrunFrames === 0 && r.frames === N
      && r.framesRead === r.plan.quantaFrames,
    `${r.underruns} underruns, ${r.underrunFrames} underrun frames, ${r.frames} frames out, `
    + `${r.framesRead} of ${r.plan.quantaFrames} frames read off the ring`);

  /**
   * PROGRESS RIDES ITS OWN MESSAGE AND TICKS ONCE PER PRODUCER STOP - the rule
   * PHASE4-CONTRACT.md section 7 states and the one the report's headline
   * claimed. A count and an exact frame list, never a clock: the `>= 2` clause
   * is what stops a plan with no stops at all from passing this vacuously.
   */
  ok('progress ticks ONCE PER PRODUCER STOP, at the frames the plan named, monotonically',
    ticks.length === r.plan.refills.length && ticks.length >= 2
      && ticks.map((t) => t.frame).join(',') === r.plan.refills.map((x) => x.frame).join(',')
      && ticks.every((t) => t.frames === r.plan.quantaFrames)
      && ticks.every((t) => Math.abs(t.pct - t.frame / r.plan.quantaFrames) < 1e-12)
      && ticks.every((t, i) => i === 0 || t.pct > ticks[i - 1].pct),
    `${ticks.length} ticks at ${ticks.map((t) => t.frame).join(', ')} of ${r.plan.quantaFrames}, `
    + `pct ${ticks.map((t) => t.pct.toFixed(4)).join(' ')} `
    + `(the plan's stops are ${r.plan.refills.map((x) => x.frame).join(', ')})`);
  ok('the render stopped exactly where the plan said it would',
    r.stops === r.plan.refills.length
      && r.harness.last.stoppedAt.join(',') === r.plan.refills.map((x) => x.frame).join(','),
    `${r.stops} stops at ${r.harness.last.stoppedAt.join(', ')}; plan said `
    + `${r.plan.refills.map((x) => x.frame).join(', ')}`);

  // THE END OF THE FILE AGAINST THE START OF IT, PER STEM, AS A RATIO. A naive
  // offline render is correct for 11.89 s and silent afterwards, so this ratio
  // goes from 1.000 to 0.000 - the number gets worse, and it says which stem.
  const g = dbToGain(0) * xfFactor('A', 'XF', xfaderGains(0.5, 'dip'));
  let worstRatio = Infinity, worstK = -1, worstAbs = 0;
  for (let k = 0; k < STEMS.length; k++) {
    const hAmp = amplitudeAt(r.left, F[k], SR, W);
    const tAmp = amplitudeAt(r.left, F[k], N - SR, W);
    const ratio = hAmp === 0 ? 0 : tAmp / hAmp;
    if (ratio < worstRatio) { worstRatio = ratio; worstK = k; }
    worstAbs = Math.max(worstAbs, Math.abs(hAmp - A[k] * g));
  }
  ok('the LAST second of the bounce is as loud as the FIRST, stem by stem',
    worstRatio > 0.9999 && worstRatio < 1.0001,
    `worst tail/head ratio ${worstRatio.toFixed(6)} on ${STEMS[worstK]} `
    + '(a bounce that outran its producer reads 0.000000 here)');
  ok('...and both ends are at the level the settings say, so a uniform attenuation cannot pass the ratio',
    worstAbs < 1e-6, `worst |measured - analytic| ${worstAbs.toExponential(2)} at a crossfader factor of ${g.toFixed(5)}`);
});

// ===========================================================================
await section('3b. THE NAIVE RENDER — the failure this slice exists to prevent, measured', async () => {
  /**
   * A CONTROL, NOT COVERAGE. This section builds the broken thing by hand -
   * prefill the ring once, never top it up - which is exactly the "constructs
   * the state it is testing" shape test.js:26-53 marks RENDERING ONLY. It
   * claims nothing about the production path. What it does is prove that the
   * two instruments section 3 uses can SEE the defect, and it pins the defect's
   * shape: correct until the ring runs out, silent afterwards, nothing red.
   */
  const SECONDS = 14;
  const N = Math.round(SECONDS * SR);
  const stems = toneStems(N);
  const h = makeOfflineHarness(EXT);
  const plan = bouncePlan({ frames: N });
  const ctx = h.audio.offlineContext(2, plan.renderFrames, SR);
  await ctx.audioWorklet.addModule(h.assetUrl('offscreen/playback-processor.js'));
  const sab = new SharedArrayBuffer(stemRingByteLength(plan.capacity));
  const out = new StemRingWriter(sab, plan.capacity);
  const node = h.audio.workletNode(ctx, 'stem-playback', {
    processorOptions: { sab, capacity: plan.capacity, sampleRate: SR, panicFadeMs: 20, lowWaterSec: 0.05, meterHz: 30, healthHz: 10 },
  });
  node.connect(ctx.destination);
  const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(plan.capacity));
  for (let k = 0; k < STEMS.length; k++) {
    for (let c = 0; c < 2; c++) planes[k * 2 + c].set(stems[STEMS[k]][c].subarray(0, plan.capacity), 0);
  }
  out.play(true);
  out.write(0, planes, plan.capacity);                       // ONE fill. No top-up. Ever.
  const buf = await ctx.startRendering();
  const y = buf.getChannelData(0).slice(plan.trimFrames, plan.trimFrames + N);

  const early = amplitudeAt(y, F[0], SR, W);
  const late = amplitudeAt(y, F[0], N - SR, W);
  ok('a naive offline render IS correct for the first eleven seconds — which is why it passes a listen',
    Math.abs(early - A[0]) < 1e-5,
    `${early.toFixed(6)} at 1.0 s, analytic ${A[0].toFixed(6)} — the ring holds `
    + `${(STEM_RING_FRAMES / SR).toFixed(2)} s`);
  ok('...and it is SILENT after the ring runs dry, which both of section 3\'s instruments see',
    late / early < 0.01 && out.underruns() > 0,
    `tail/head ${(late / early).toExponential(2)}, ${out.underruns()} underruns, `
    + `${out.underrunFrames()} underrun frames`);

  /**
   * THE SECOND CONTROL, AND IT IS WHY SECTIONS 2 AND 3 READ `framesRead`.
   *
   * playback-processor.js's starvation branch is `if (!play || avail < n)`, and
   * inside it the underrun counters are advanced only `if (play)` and the read
   * pointer is not advanced at all. So a ring that was never put in play is not
   * merely "a different defect" - it is INDISTINGUISHABLE from a perfectly fed
   * render on the two counters the whole slice is gated on. Measured: the
   * deliverable is silence and both counters read 0.
   *
   * That is PHASE4-CONTRACT.md section 12's third failure exactly - an
   * instrument reading its PERFECT value on the worst defect in the slice - and
   * it was found by a reviewer, not by this suite. It is pinned here as a
   * control so the pairing above cannot be "simplified" back out again.
   */
  const h2 = makeOfflineHarness(EXT);
  const ctx2 = h2.audio.offlineContext(2, plan.renderFrames, SR);
  await ctx2.audioWorklet.addModule(h2.assetUrl('offscreen/playback-processor.js'));
  const out2 = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(plan.capacity)), plan.capacity);
  const node2 = h2.audio.workletNode(ctx2, 'stem-playback', {
    processorOptions: { sab: out2.sab, capacity: plan.capacity, sampleRate: SR, panicFadeMs: 20, lowWaterSec: 0.05, meterHz: 30, healthHz: 10 },
  });
  node2.connect(ctx2.destination);
  out2.play(false);                                          // NEVER put in play.
  out2.write(0, planes, plan.capacity);
  const silent = (await ctx2.startRendering()).getChannelData(0);
  ok('a ring that NEVER PLAYS reads PERFECT on both starvation counters — which is why they are '
    + 'paired with a frame count',
    peakOf(silent) === 0 && out2.underruns() === 0 && out2.underrunFrames() === 0
      && out2.readFrames() === 0,
    `peak ${peakOf(silent)}, ${out2.underruns()} underruns, ${out2.underrunFrames()} underrun frames — `
    + `identical to a healthy render — but ${out2.readFrames()} of ${plan.quantaFrames} frames read, `
    + 'which is not');
});

// ===========================================================================
await section('4. DISTINCT GAINS — the fader, crossfader and master stages, per stem', async () => {
  const N = Math.round(2 * SR);
  const GAIN_DB = [-1, -3, -6, -9, -12, -15];      // every stem DIFFERENT, none of them unity
  const ASSIGN = ['XF', 'XF', 'XF', 'A', 'XF', 'B'];
  const POS = 0.35, CURVE = 'dip', MASTER_DB = -2;
  const s = {
    id: 'A',
    mix: STEMS.map((_, k) => ({ gainDb: GAIN_DB[k], muted: false, soloed: false })),
    xf: { position: POS, curve: CURVE, assign: ASSIGN },
    masterDb: MASTER_DB, semitones: 0,
  };
  const r = await bounce({ stems: toneStems(N), frames: N }, s);

  const xg = xfaderGains(POS, CURVE);
  const master = dbToGain(MASTER_DB);
  const expect = STEMS.map((_, k) => A[k] * dbToGain(GAIN_DB[k]) * xfFactor('A', ASSIGN[k], xg) * master);
  const got = STEMS.map((_, k) => amplitudeAt(r.left, F[k], SR, W));

  // THE FIXTURE HAS TO DISTINGUISH THE STAGES. Six identical expectations would
  // make this section blind to a swapped slot and to a missing stage alike.
  const live = expect.filter((v) => v > 0);
  ok('the fixture gives every audible stem a DIFFERENT expected level, so a swapped slot is visible',
    new Set(live.map((v) => v.toFixed(9))).size === live.length && live.length === 5,
    `expected ${expect.map((v) => v.toFixed(5)).join(' ')}`);

  let num = 0, den = 0;
  for (let k = 0; k < STEMS.length; k++) { const e = got[k] - expect[k]; num += e * e; den += expect[k] * expect[k]; }
  const residual = Math.sqrt(num / den);
  ok('each stem arrives at its OWN gain: fader x crossfader x master, against the analytic weighted sum',
    residual < 1e-4,
    `relative residual ${residual.toExponential(2)} over ${STEMS.length} stems  `
    + `measured ${got.map((v) => v.toFixed(5)).join(' ')}  `
    + '(deleting the gain stage takes this to ~0.6, i.e. WORSE)');

  const loud = Math.max(...got);
  ok('an assign of B on deck A is silent at every crossfader position — the hard-assign kill, as a ratio',
    got[5] / loud < 1e-6,
    `${STEMS[5]} reads ${got[5].toExponential(2)} against the loudest stem's ${loud.toFixed(5)} `
    + `= ${(got[5] / loud).toExponential(2)}`);

  /**
   * THE SAME MEASUREMENT AT THE HEAD OF THE FILE, AND IT IS A DIFFERENT CLAIM.
   *
   * Everything above reads at `from = SR` — one second in — where any head ramp
   * has long since settled. That made `BOUNCE_TAU` (offscreen/bounce.js) a
   * load-bearing constant with a sixteen-line justification and NO assertion:
   * setting it to `TAU.master` = 0.020, the value every other caller of the same
   * {t:'gain'} message uses, left this suite 51 passed / 0 failed.
   *
   * MEASURED DAMAGE of that setting on this exact fixture: the worklet's gain
   * slots all start at 1, so the deck's real gains arrive over 6 tau = 120 ms.
   * The trim only eats the first 3072 frames = 69.7 ms of it, so the two
   * deliverables differ by more than 0.1 % of peak for the first 2049 frames =
   * 46.5 ms OF THE FILE, up to 3.4 % of peak. It ships.
   *
   * A UNITY FIXTURE CANNOT SEE THIS AT ALL — with every gain already 1 there is
   * nothing to ramp from, which is why the existing head-of-file assertion
   * (section 7's, on unitySettings) was blind to it. Section 12 in miniature:
   * a fixture that makes two inputs identical is blind to what distinguishes
   * them. This one is on the DISTINCT-gain fixture on purpose.
   */
  const headGot = STEMS.map((_, k) => amplitudeAt(r.left, F[k], 0, W));
  let hnum = 0, hden = 0;
  for (let k = 0; k < STEMS.length; k++) { const e = headGot[k] - expect[k]; hnum += e * e; hden += expect[k] * expect[k]; }
  const headResidual = Math.sqrt(hnum / hden);
  ok('...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, '
    + 'so it must not spend a smoothing constant sliding up to its own settings',
    headResidual < 1e-4,
    `relative residual over the first ${W} frames of the FILE ${headResidual.toExponential(2)} `
    + `(at 1.0 s it is ${residual.toExponential(2)}; posting the worklet's own 20 ms tau instead of `
    + 'BOUNCE_TAU reads ~2e-2 here and is unchanged at 1.0 s, because 120 ms of ramp does not fit '
    + 'inside a 69.7 ms trim)');
});

// ===========================================================================
await section('4b. THE SNAPSHOT — the bounce is of the settings AS THEY WERE WHEN IT WAS ASKED FOR', async () => {
  /**
   * `bounceSettings()` is what makes that sentence true, and until this section
   * existed the suite never imported it. Its guarantee is not about audio — a
   * render posts its settings once, before the first quantum, so a deck moved
   * DURING one changes nothing whatever `bounceSettings` returns. What the copy
   * protects is the window between "the user pressed Bounce" and every later
   * read of that record: progress, a retry, a second consumer. So the instrument
   * is the record itself, driven, and not the deliverable.
   */
  const deck = {
    id: 'A',
    mix: STEMS.map((_, k) => ({ gainDb: -k, muted: false, soloed: k === 1 })),
    xf: { position: 0.35, curve: 'dip', assign: STEMS.map(() => 'XF') },
    masterDb: -2, semitones: 3,
  };
  const snap = bounceSettings(deck);

  // The deck moves, exactly as a user moving a fader mid-render moves it.
  deck.mix[1].gainDb = -60;
  deck.mix[1].muted = true;
  deck.xf.assign[2] = 'B';

  ok('the live deck really moved after the snapshot, or this section is measuring nothing',
    deck.mix[1].gainDb === -60 && deck.mix[1].muted === true && deck.xf.assign[2] === 'B',
    `deck now: gainDb ${deck.mix[1].gainDb}, muted ${deck.mix[1].muted}, assign[2] ${deck.xf.assign[2]}`);
  ok('a fader moved after the bounce was asked for does not reach the render: `mix` is COPIED, '
    + 'element by element',
    snap.mix[1].gainDb === -1 && snap.mix[1].muted === false && snap.mix[1].soloed === true
      && snap.mix !== deck.mix && snap.mix[1] !== deck.mix[1],
    `snapshot still reads gainDb ${snap.mix[1].gainDb}, muted ${snap.mix[1].muted}, `
    + `soloed ${snap.mix[1].soloed}; same array ${snap.mix === deck.mix}, `
    + `same element ${snap.mix[1] === deck.mix[1]}`);
  ok('...and neither does the crossfader column: `assign` is COPIED',
    snap.xf.assign[2] === 'XF' && snap.xf.assign !== deck.xf.assign,
    `snapshot still reads assign[2] ${snap.xf.assign[2]}; same array ${snap.xf.assign === deck.xf.assign}`);
  ok('...and the flat record carries every field the render needs, so nothing has to reach for the deck',
    snap.id === 'A' && snap.masterDb === -2 && snap.semitones === 3
      && snap.xf.position === 0.35 && snap.xf.curve === 'dip' && snap.mix.length === STEMS.length,
    `id ${snap.id}, masterDb ${snap.masterDb}, semitones ${snap.semitones}, `
    + `xf ${snap.xf.position}/${snap.xf.curve}, ${snap.mix.length} stems`);
});

// ===========================================================================
await section('5. SOLO — the others as a RATIO against the soloed stem', async () => {
  const N = Math.round(2 * SR);
  const SOLO = 2;                                   // `other`
  const mix = flatMix();
  mix[SOLO].soloed = true;
  const r = await bounce({ stems: toneStems(N), frames: N }, centreSettings({ mix }));

  const got = STEMS.map((_, k) => amplitudeAt(r.left, F[k], SR, W));
  const g = xfFactor('A', 'XF', xfaderGains(0.5, 'dip'));
  let worst = 0, worstK = -1;
  for (let k = 0; k < STEMS.length; k++) {
    if (k === SOLO) continue;
    const ratio = got[k] / got[SOLO];
    if (ratio > worst) { worst = ratio; worstK = k; }
  }
  ok('soloing one stem leaves the other five below it by a RATIO, not by a threshold',
    got[SOLO] > 0 && worst < 1e-6,
    `worst neighbour ${STEMS[worstK]} at ${worst.toExponential(2)} of the soloed `
    + `${STEMS[SOLO]}'s ${got[SOLO].toFixed(5)}`);
  // A RATIO ALONE PASSES ON A BUG THAT ATTENUATES EVERYTHING. This is the other
  // half, and it is why the soloed stem's own level is asserted analytically.
  ok('...and the soloed stem is at its OWN unchanged level, so attenuating everything cannot pass the ratio',
    Math.abs(got[SOLO] - A[SOLO] * g) < 1e-6,
    `${got[SOLO].toFixed(6)} against analytic ${(A[SOLO] * g).toFixed(6)}`);
});

// ===========================================================================
await section('6. MUTE — one stem absent, by ratio, with the rest untouched', async () => {
  const N = Math.round(2 * SR);
  const MUTED = 3;                                  // `vocals`
  const mix = flatMix();
  mix[MUTED].muted = true;
  const r = await bounce({ stems: toneStems(N), frames: N }, centreSettings({ mix }));

  const got = STEMS.map((_, k) => amplitudeAt(r.left, F[k], SR, W));
  const g = xfFactor('A', 'XF', xfaderGains(0.5, 'dip'));
  const ref = got[0];
  ok('a muted stem contributes nothing, as a ratio against an unmuted one',
    ref > 0 && got[MUTED] / ref < 1e-6,
    `${STEMS[MUTED]} reads ${got[MUTED].toExponential(2)} against ${STEMS[0]}'s ${ref.toFixed(5)} `
    + `= ${(got[MUTED] / ref).toExponential(2)}`);
  let worst = 0, worstK = -1;
  for (let k = 0; k < STEMS.length; k++) {
    if (k === MUTED) continue;
    const e = Math.abs(got[k] - A[k] * g);
    if (e > worst) { worst = e; worstK = k; }
  }
  ok('...and the other five are exactly where they were, so a mute that muted the bus cannot pass',
    worst < 1e-6, `worst |measured - analytic| ${worst.toExponential(2)} on ${STEMS[worstK]}`);
});

// ===========================================================================
await section('7. TRANSPOSE — the fundamental moves and the DRUMS DO NOT', async () => {
  const SEMIS = 5;
  const RATIO = Math.pow(2, SEMIS / 12);
  const N = Math.round(1.6 * SR);

  // ---- the drums lane: a CLICK TRAIN, the signal a phase vocoder smears most.
  const clicks = clickTrain(N);
  const dStems = silentStems(N);
  dStems.drums[0].set(clicks); dStems.drums[1].set(clicks);
  const d0 = await bounce({ stems: dStems, frames: N }, unitySettings());
  const d5 = await bounce({ stems: dStems, frames: N }, unitySettings({ semitones: SEMIS }));

  const pk = peakOf(clicks);
  ok('the drums fixture really carries a transient, or the exclusion cannot be seen at all',
    pk > 0.5, `peak ${pk.toFixed(3)} over ${Math.round(N / (SR * 0.25))} clicks in ${(N / SR).toFixed(1)} s`);
  const db0 = residualDb(d0.left, clicks, N);
  const db5 = residualDb(d5.left, clicks, N);
  ok('the drums are NOT transposed: at +5 the deliverable is the click train back, sample for sample',
    db5 < -120 && db0 < -120,
    `residual ${db5 === -Infinity ? '-inf' : db5.toFixed(1)} dB at +${SEMIS}, `
    + `${db0 === -Infinity ? '-inf' : db0.toFixed(1)} dB at 0 `
    + '(a shifted drums lane reads about -3 dB — the clicks smear across the STFT window)');

  // ---- a shifted lane, on its own, so no other stem's shifted tone can land in
  //      the band. Measured while writing this suite: at +5, bass's 330 Hz lands
  //      on `other`'s 440 Hz bin, so one fixture per claim.
  const bStems = silentStems(N);
  for (let i = 0; i < N; i++) {
    const v = 0.5 * Math.sin(2 * Math.PI * 330 * i / SR);
    bStems.bass[0][i] = v; bStems.bass[1][i] = v;
  }
  const b0 = await bounce({ stems: bStems, frames: N }, unitySettings());
  const b5 = await bounce({ stems: bStems, frames: N }, unitySettings({ semitones: SEMIS }));
  const f0 = peakHz(b0.left, N - 16384 - 1024);
  const f5 = peakHz(b5.left, N - 16384 - 1024);
  ok('the estimator can see the untransposed fundamental at all, or the ratio below means nothing',
    Number.isFinite(f0) && Math.abs(f0 - 330) < 0.5,
    Number.isFinite(f0) ? `${f0.toFixed(3)} Hz, want 330.000` : 'NO PEAK — that is the failure, not an excuse from it');
  ok(`a transposed stem's fundamental moves by exactly 2^(${SEMIS}/12)`,
    Number.isFinite(f5) && Math.abs(f5 / f0 - RATIO) / RATIO < 0.005,
    Number.isFinite(f5)
      ? `${f5.toFixed(3)} / ${f0.toFixed(3)} = ${(f5 / f0).toFixed(5)}, want ${RATIO.toFixed(5)}`
      : 'NO PEAK in the transposed bounce');

  /**
   * THE HEAD OF THE FILE, WHICH THE TWO ASSERTIONS ABOVE CANNOT SEE.
   *
   * Both of them look at the END of the render. Setting the transpose with
   * `{t:'pitch'}` alone opens a 3072-sample prime and a 50 ms crossfade from a
   * bank still sitting at 0, so the first ~50 ms of the deliverable is a BLEND
   * of concert pitch and the transposed pitch - and it is outside the 3072-frame
   * trim, so it ships. The drums fixture cannot see it either: lane 0 is a
   * matched delay in BOTH banks, so that crossfade is between two identical
   * signals, which is section 12's blindness in miniature.
   *
   * So this measures the first 50 ms of the transposed bounce at the ORIGINAL
   * frequency against the shifted one. Measured both ways while this was
   * written: 0.048 with the reset, 1.03 without - a factor of 21, and the number
   * gets WORSE when the line goes.
   */
  const HEAD = 2205;                                     // 50 ms, the bank crossfade's own length
  const hOld = amplitudeAt(b5.left, 330, 0, HEAD);
  const hNew = amplitudeAt(b5.left, 330 * RATIO, 0, HEAD);
  ok('the deliverable is at the transposed pitch from its FIRST sample, not after a bank crossfade',
    hNew > 0.2 && hOld / hNew < 0.15,
    `over the first 50 ms: A(330) ${hOld.toFixed(5)} against A(${(330 * RATIO).toFixed(1)}) `
    + `${hNew.toFixed(5)} = ${(hOld / hNew).toFixed(4)}  `
    + '(a bounce whose bank was still crossfading reads 1.03 here)');
});

// ===========================================================================
await section('8. THE DELIVERABLE — one file, through the duty six would use', async () => {
  const N = Math.round(1.0 * SR);
  const r = await bounce({ stems: toneStems(N), frames: N }, centreSettings());
  const sink = makeFakeSink();
  let askedFor = null;
  const exportSink = async (plan) => { askedFor = plan; return { [bounceFileName(plan.title)]: sink.writable }; };
  const w = await writeBounce(exportSink, { title: 'Fixture Track', left: r.left, right: r.right, frames: r.frames });

  ok('exportSink is asked ONCE, for ONE file — N may be one, and this is the call site that says so',
    askedFor && askedFor.files.length === 1 && askedFor.files[0] === 'Fixture Track.wav'
      && w.files.length === 1,
    `${JSON.stringify(askedFor && askedFor.files)}`);
  ok('the sink was CLOSED, not aborted — a bounce that refused would abort so the Host knows the file is not a file',
    sink.closed === true && sink.aborted === null);

  const bytes = sink.bytes();
  const back = decodeWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  ok('the deliverable is 32-bit float, 44.1 kHz, stereo, exactly as long as the bounce',
    back.channels.length === 2 && back.sampleRate === SR && back.bitDepth === 32 && back.float === true
      && back.channels[0].length === N,
    `${back.channels.length} ch, ${back.sampleRate} Hz, ${back.bitDepth}-bit float=${back.float}, `
    + `${back.channels[0].length} frames, ${bytes.length} bytes`);
  let diff = 0;
  for (let i = 0; i < N; i++) {
    diff = Math.max(diff, Math.abs(back.channels[0][i] - r.left[i]), Math.abs(back.channels[1][i] - r.right[i]));
  }
  ok('...and the samples in it are the rendered samples, bit for bit — 32f is a copy, not a re-quantisation',
    diff === 0, `worst |file - render| ${diff}`);

  let refused = null;
  try {
    await writeBounce(async () => ({ 'something else.wav': makeFakeSink().writable }),
      { title: 'Fixture Track', left: r.left, right: r.right, frames: r.frames });
  } catch (e) { refused = e; }
  ok('a Host that answers a map without the file it was asked for is a REFUSAL, not five of six files',
    refused != null && refused.code === 'SINK_REFUSED' && refused.message.includes(BOUNCE_CODES.SINK_REFUSED),
    refused ? `${refused.code}: ${refused.message}` : 'it did not throw');

  // THE ORDINARY CASE. The user cancelling the folder dialog is a THROW by the
  // duty's own words, and it must not reach the wire as a render failure - that
  // blames the render for the user's own gesture, and it is the shape #29
  // measured on ARM_ERROR.
  let cancelledDialog = null;
  try {
    await writeBounce(async () => { throw new Error('the user cancelled the folder dialog'); },
      { title: 'Fixture Track', left: r.left, right: r.right, frames: r.frames });
  } catch (e) { cancelledDialog = e; }
  ok("a Host that THROWS is SINK_REFUSED carrying the Host's OWN words, not RENDER_FAILED",
    cancelledDialog != null && cancelledDialog.code === 'SINK_REFUSED'
      && cancelledDialog.message.includes('cancelled the folder dialog'),
    cancelledDialog ? `${cancelledDialog.code}: ${cancelledDialog.message}` : 'it did not throw');
});

// ===========================================================================
await section('9. the closed code vocabulary and the file name', async () => {
  const codes = Object.keys(BOUNCE_CODES);
  ok('the failure codes are a declared, frozen, non-empty set',
    codes.length >= 5 && Object.isFrozen(BOUNCE_CODES) && codes.every((c) => typeof BOUNCE_CODES[c] === 'string'),
    codes.join(', '));
  ok('...and a code this unit never declared is refused, which is what ARM_CODES never did',
    codes.every((c) => isBounceCode(c)) && !isBounceCode('BOUNCE_FAILED') && !isBounceCode('toString'),
    'isBounceCode("BOUNCE_FAILED") === false, isBounceCode("toString") === false');
  const nasty = bounceFileName('a/b\\c:d*e?f"g<h>i|j');
  ok('the file name is a BASE name: no separator survives, so a Host cannot be made to write outside its folder',
    !/[\\/:*?"<>|]/.test(nasty) && nasty.endsWith('.wav'), nasty);
  ok('an empty title still names a file rather than producing ".wav"',
    bounceFileName('') === 'bounce.wav' && bounceFileName(null) === 'bounce.wav', bounceFileName(''));
  ok('the harness pumps at the same render quantum the plan is built on',
    QUANTUM === BOUNCE_QUANTUM && QUANTUM === 128, `${QUANTUM}`);

  // ...AND THE VOCABULARY IS ENFORCED AT THE THROW SITE, not merely declared.
  let invented = null;
  try { bounceError('BOUNCE_EXPLODED', 'x'); } catch (e) { invented = String(e.message); }
  ok('bounceError REFUSES a code the unit never declared, where the stack still names the caller',
    invented != null && invented.includes('BOUNCE_EXPLODED') && invented.includes('NO_TRACK'),
    invented || 'it built an error carrying an undeclared code');
  const real = bounceError('CANCELLED');
  ok('...and a declared one comes back carrying the code AND the sentence, so the wire needs no string matching',
    real.code === 'CANCELLED' && real.message === BOUNCE_CODES.CANCELLED,
    `${real.code}: ${real.message}`);
});

// ===========================================================================
await section('10. CANCEL — the render settles, nothing lands, and it names WHERE it stopped', async () => {
  /**
   * TWO FIXTURES, BECAUSE ONE OF THEM USED TO COLLAPSE THE DISTINCTION IT TESTS.
   *
   * (a) cancels at the THIRD producer stop. The old fixture cancelled at the
   *     first — `cancelled: () => true` — which made the frame the message
   *     reports and the frame it happened at IDENTICAL, so it could not see that
   *     the message always said `plan.refills[0].frame` whatever stop cancelled
   *     it. Measured before the fix: cancelling at the 3rd stop of a 20 s bounce
   *     (real frame 786432) reported "at frame 262144".
   *
   * (b) cancels a bounce with NO PRODUCER STOPS AT ALL, at the SHIPPED ring.
   *     The cancel flag is read inside a suspension callback and `bouncePlan`
   *     schedules no stop below 262144 frames, so at the shipped ring every
   *     bounce shorter than 5.94 s had NOWHERE to observe a cancel: measured at
   *     4.0 s, `cancelled()` was polled 0 times, the render resolved, the file
   *     was written and BOUNCE_DONE was sent. The old fixture hid this by
   *     shrinking the ring so a stop existed.
   *
   * AND THIS IS WHERE LAYER 2 OF THE GUARD IS WATCHED. The cancel path leaves
   * the suspension callback through a bare `return`, so the `finally` is the
   * only thing that resumes the context. Delete it and this section does not go
   * red - it HANGS, for ever, which is why qa/bounce-mutations.mjs runs that one
   * anchor under a timeout and reports HUNG rather than a red.
   */
  const N = Math.round(2 * SR);

  // ---- (a) a SMALL ring on purpose, so there are several stops to choose from.
  const CAP = 1 << 15, EVERY = 1 << 14;
  const planA = bouncePlan({ frames: N, capacity: CAP, refillEvery: EVERY });
  const sink = makeFakeSink();
  let asked = 0, polls = 0, threw = null;
  try {
    const h = makeOfflineHarness(EXT);
    await bounceToSink({
      track: { stems: toneStems(N), frames: N },
      settings: centreSettings(),
      assetUrl: h.assetUrl, audio: h.audio,
      capacity: CAP, refillEvery: EVERY,
      title: 'Cancelled',
      cancelled: () => (++polls >= 3),
      exportSink: async () => { asked++; return { 'Cancelled.wav': sink.writable }; },
    });
  } catch (e) { threw = String(e.message); }
  const at = /at render frame (\d+)/.exec(threw || '');

  ok('the cancel fixture really has several stops and cancels at a LATER one, or it cannot tell '
    + 'the reported frame from the first stop',
    planA.refills.length >= 3 && planA.refills[0].frame !== planA.refills[2].frame,
    `${planA.refills.length} stops at ${planA.refills.map((x) => x.frame).join(', ')}; `
    + `cancelled at the 3rd (frame ${planA.refills[2] ? planA.refills[2].frame : '—'}), not the 1st `
    + `(frame ${planA.refills[0] ? planA.refills[0].frame : '—'})`);
  ok('a cancelled bounce SETTLES rather than hanging, says CANCELLED, and names the stop it '
    + 'ACTUALLY stopped at',
    threw != null && threw.includes(BOUNCE_CODES.CANCELLED)
      && at != null && Number(at[1]) === planA.refills[2].frame,
    threw || 'it resolved as if it had finished');
  ok('...and nothing lands: the Host is never asked for a destination and no byte is written',
    asked === 0 && sink.chunks.length === 0 && sink.closed === false,
    `exportSink called ${asked} times, ${sink.chunks.length} chunks written, closed=${sink.closed}`);

  // ---- (b) the SHIPPED ring, and a track too short to have a single stop.
  const planB = bouncePlan({ frames: N });
  const sinkB = makeFakeSink();
  let askedB = 0, threwB = null;
  try {
    const h = makeOfflineHarness(EXT);
    await bounceToSink({
      track: { stems: toneStems(N), frames: N },
      settings: centreSettings(),
      assetUrl: h.assetUrl, audio: h.audio,
      title: 'Short',
      cancelled: () => true,
      exportSink: async () => { askedB++; return { 'Short.wav': sinkB.writable }; },
    });
  } catch (e) { threwB = String(e.message); }

  ok('the short fixture really has NO producer stop at the shipped ring, or it is the same test twice',
    planB.refills.length === 0 && N < BOUNCE_REFILL_FRAMES,
    `${(N / SR).toFixed(1)} s = ${N} frames against a refill period of ${BOUNCE_REFILL_FRAMES} frames `
    + `= ${(BOUNCE_REFILL_FRAMES / SR).toFixed(2)} s: ${planB.refills.length} stops`);
  ok('a bounce with no producer stop at all is STILL cancellable — it is not a no-op below 5.94 s',
    threwB != null && threwB.includes(BOUNCE_CODES.CANCELLED) && askedB === 0
      && sinkB.chunks.length === 0,
    threwB || `it resolved as if it had finished; exportSink called ${askedB} times, `
      + `${sinkB.chunks.length} chunks written`);
});

// ===========================================================================
await section('11. THE WIRE — the engine is WIRED to the unit\'s refusals, read as text', async () => {
  /**
   * READ AS TEXT, and the reason is the same one test.js gives for reading
   * ui/embed.js that way: importing offscreen/engine.js RUNS it, and it builds a
   * MasterBus, installs a message listener and reaches for Web Audio at module
   * scope.
   *
   * WHAT A TEXT SCAN CAN AND CANNOT CARRY, stated because getting this wrong
   * shipped a defect. This section used to hold an assertion named "a deck with
   * nothing loaded and a deck playing live are DIFFERENT refusals" whose whole
   * check was `all.includes('NO_TRACK') && all.includes('NOT_CACHED')`. Both
   * strings were in the file the entire time NO_TRACK was UNREACHABLE, so it
   * passed for the same reason it would have passed over a comment. A SCAN FOR A
   * STRING IS NOT A TEST OF REACHABILITY.
   *
   * So the reachability claim moved to section 12, where each state is DRIVEN
   * and the code it answers is read back, and what is left here is a WIRING
   * claim, named as one: that the engine reaches for those functions rather than
   * keeping a second copy of the decision. That is a property of the literals,
   * and it is the most a scan can honestly say.
   *
   * IT FAILS WHEN IT CANNOT LOOK. A scan that found no wiring at all would
   * report a clean vocabulary most confidently at the moment it stopped reading
   * the file, so the count is asserted before the membership is.
   */
  const raw = await (await import('node:fs/promises')).readFile(path.join(EXT, 'offscreen/engine.js'), 'utf8');
  /**
   * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. A scan that reads
   * them cannot tell the code from a description of the code — the comment three
   * lines above the fix QUOTES the broken line verbatim, so an unstripped scan
   * for `'NO_TRACK'` finds it in prose and reports on the wrong thing in both
   * directions. Block comments and whole-line `//` comments only: a trailing
   * `//` on a code line is left alone rather than risking a `//` inside a string.
   */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the scan is reading CODE and not prose, or it is answering about the wrong text',
    src.length > 0 && raw.length - src.length > 2000 && /case 'BOUNCE_START'/.test(src),
    `${raw.length} bytes of engine.js, ${raw.length - src.length} of them comment `
    + `(${((raw.length - src.length) / raw.length * 100).toFixed(0)} %); `
    + `${src.split('\n').length} lines of code remain`);
  // LINE-BASED ON PURPOSE. A call can carry its code as a literal, as a ternary
  // over two of them, or as `e.code` with a literal fallback, and a regex over
  // the ARGUMENT LIST would have to balance parentheses to see all three. Every
  // line that mentions the emitter is scanned for upper-case string literals
  // instead, which reaches all three shapes and cannot silently see fewer of
  // them than there are.
  const lines = src.split('\n').filter((l) => /\bbounceFailed\(/.test(l));
  const all = [...new Set(lines.flatMap((l) => [...l.matchAll(/'([A-Z][A-Z_]{2,})'/g)].map((m) => m[1])))].sort();
  ok('the scan really found the bounce wiring, or everything below is vacuous',
    lines.length >= 3 && all.length >= 1
      && /case 'BOUNCE_START'/.test(src) && /case 'BOUNCE_CANCEL'/.test(src),
    `${lines.length} bounceFailed lines carrying ${all.length} code literals: ${all.join(', ')}`);
  const invented = all.filter((c) => !isBounceCode(c));
  ok('...and every literal one of them is a code engine/bounce.js declares — the ARM_CODES failure, '
    + 'checked on the EMITTING side',
    invented.length === 0,
    invented.length ? `UNDECLARED: ${invented.join(', ')}` : `all ${all.length} are in BOUNCE_CODES`);
  ok('the engine does not keep its own copy of the two empty-deck refusals: it asks bounceRefusal, '
    + 'which section 12 drives',
    /\bbounceRefusal\(\{/.test(src) && !/'NO_TRACK'/.test(src) && !/'NOT_CACHED'/.test(src),
    `bounceRefusal({...}) present: ${/\bbounceRefusal\(\{/.test(src)}; `
    + `'NO_TRACK' literal in engine.js: ${/'NO_TRACK'/.test(src)}; `
    + `'NOT_CACHED' literal: ${/'NOT_CACHED'/.test(src)}`);
  /**
   * AND IT HANDS OVER THE LIVENESS FACT, WHICH IS THE HALF A `cd` TEST CANNOT
   * HAVE. Both clauses below are the reason the design is what it is, so both
   * are checked rather than described: `stopCached` really does drop the
   * `CachedDeck` on unload, which is what makes `!cd` unable to tell an unloaded
   * deck from a live one, and the call site really does pass `live` in. If
   * `stopCached` ever stops nulling the entry, this goes red and somebody
   * re-reads the design — which is the red anyone would want.
   */
  ok('...and it hands bounceRefusal the LIVENESS fact, because stopCached drops the CachedDeck on '
    + 'unload and `!cd` cannot tell an unloaded deck from a live one',
    /cachedDecks\[id\] = null;/.test(src) && /live: deckIsLive\(decks\[id\]\)/.test(src)
      && (src.match(/const deckIsLive = /g) || []).length === 1
      && (src.match(/d\.status === 'recording'/g) || []).length === 1,
    `stopCached nulls the entry: ${/cachedDecks\[id\] = null;/.test(src)}; `
    + `the call site passes live: ${/live: deckIsLive\(decks\[id\]\)/.test(src)}; `
    + `deckIsLive defined ${(src.match(/const deckIsLive = /g) || []).length} time(s) and the capture `
    + `predicate written out ${(src.match(/d\.status === 'recording'/g) || []).length} time(s) — one `
    + 'each, or two answers that can disagree');
  ok('...and the code that reaches the wire goes through bounceWireCode, which section 12 also drives — '
    + 'the one call site that carries no literal to scan for',
    /const c = bounceWireCode\(code\);/.test(src) && /bounceFailed\(id, e && e\.code,/.test(src),
    `bounceWireCode at the emitter: ${/const c = bounceWireCode\(code\);/.test(src)}; `
    + `the catch reports e.code: ${/bounceFailed\(id, e && e\.code,/.test(src)}`);
  const errSends = [...src.matchAll(/type: 'BOUNCE_ERROR'/g)].length;
  ok('...and there is exactly ONE place a bounce failure reaches the wire, so the checks above cover all of them',
    errSends === 1, `${errSends} BOUNCE_ERROR emitters`);
});

// ===========================================================================
await section('12. THE REFUSALS, DRIVEN — each state asked, and the code it answers read back', async () => {
  /**
   * THE OTHER HALF OF SECTION 11, AND THE HALF THAT CAN SEE REACHABILITY.
   *
   * Every refusal below is produced by RUNNING the thing, not by finding its
   * name. That is the difference between "both codes appear in the source" — a
   * sentence that stayed true for the whole time `NO_TRACK` could not be
   * produced at all — and "this deck state answers this code".
   */

  // ---- the two empty-deck states (engine/bounce.js's bounceRefusal) ---------
  /**
   * THE WHOLE GRID, NOT A SAMPLE OF IT. `bounceRefusal` takes two independent
   * booleans, so there are exactly four states plus "no facts at all", and all
   * five are driven. A subset would be the same mistake one level down: an
   * assertion that happens not to visit the state where the answer is wrong.
   */
  const at = (cachedTrack, live) => bounceRefusal({ cachedTrack, live });
  const drive = {
    'no facts at all — a deck the engine has never seen': bounceRefusal(undefined),
    'nothing cached, NOT live — never loaded, or unloaded by stopCached': at(false, false),
    'nothing cached, LIVE — capturing, or priming': at(false, true),
    'a whole cached track, not live': at(true, false),
    'a whole cached track while the live deck also runs': at(true, true),
  };
  const answers = Object.values(drive);
  ok('a deck with nothing loaded and a deck playing live are DIFFERENT refusals — driven, one state '
    + 'at a time, and the code READ BACK',
    drive['nothing cached, NOT live — never loaded, or unloaded by stopCached'] === 'NO_TRACK'
      && drive['nothing cached, LIVE — capturing, or priming'] === 'NOT_CACHED'
      && drive['no facts at all — a deck the engine has never seen'] === 'NO_TRACK'
      && new Set(answers.filter((c) => c)).size === 2,
    Object.entries(drive).map(([k, v]) => `${k} -> ${v}`).join('  |  '));
  ok('...and a deck that HAS a track is not refused at all, live or not, so the two above are a '
    + 'decision and not a constant',
    drive['a whole cached track, not live'] === null
      && drive['a whole cached track while the live deck also runs'] === null
      && answers.filter((c) => c !== null).every((c) => isBounceCode(c)),
    `cached+idle -> ${JSON.stringify(drive['a whole cached track, not live'])}, `
    + `cached+live -> ${JSON.stringify(drive['a whole cached track while the live deck also runs'])}; `
    + `every refusal is a declared code: ${answers.filter((c) => c !== null).every(isBounceCode)}`);
  /**
   * BOTH FACTS MUST MATTER, AND THAT IS A SEPARATE CLAIM. A refusal that ignored
   * `live` would still answer two different codes across the grid above — it
   * would simply answer them for the wrong reason, which is exactly what the
   * first repair of this defect did. So each fact is flipped ON ITS OWN and the
   * answer must move: two guards that produce an identical observation are one
   * guard wearing two names.
   */
  ok('flipping EITHER fact on its own changes the answer, so neither is decoration — the check the '
    + 'first repair of this defect would have failed',
    at(false, false) !== at(false, true) && at(false, false) !== at(true, false)
      && at(true, false) !== at(false, false),
    `live alone: (false,false) -> ${at(false, false)} vs (false,true) -> ${at(false, true)}  |  `
    + `cachedTrack alone: (false,false) -> ${at(false, false)} vs (true,false) -> `
    + `${JSON.stringify(at(true, false))}`);

  // ---- the run-time half of #29 (engine/bounce.js's bounceWireCode) --------
  ok('a code the unit never declared is folded to RENDER_FAILED before it reaches the wire — driven, '
    + 'because that call site carries no literal to scan for',
    bounceWireCode('ENOSPC') === 'RENDER_FAILED' && bounceWireCode(undefined) === 'RENDER_FAILED'
      && bounceWireCode('BOUNCE_BUSY') === 'RENDER_FAILED' && bounceWireCode('toString') === 'RENDER_FAILED',
    `ENOSPC -> ${bounceWireCode('ENOSPC')}, undefined -> ${bounceWireCode(undefined)}, `
    + `BOUNCE_BUSY -> ${bounceWireCode('BOUNCE_BUSY')}, toString -> ${bounceWireCode('toString')} `
    + '(ENOSPC is reachable: writeBounce pipes OUTSIDE the SINK_REFUSED try/catch)');
  ok('...and a declared one passes through untouched, so the fold is not a constant either',
    Object.keys(BOUNCE_CODES).every((c) => bounceWireCode(c) === c),
    `all ${Object.keys(BOUNCE_CODES).length} declared codes pass through: `
    + Object.keys(BOUNCE_CODES).map((c) => `${c}->${bounceWireCode(c)}`).join(' '));

  // ---- the per-stem shape guard (offscreen/bounce.js) ----------------------
  const N = Math.round(0.5 * SR);
  const shortStem = toneStems(N);
  shortStem[STEMS[3]] = [shortStem[STEMS[3]][0].subarray(0, N - 1), shortStem[STEMS[3]][1]];
  const missing = toneStems(N);
  delete missing[STEMS[2]];
  const caught = async (track) => {
    try { await bounce(track, unitySettings()); return null; } catch (e) { return e; }
  };
  const eShort = await caught({ stems: shortStem, frames: N });
  const eMissing = await caught({ stems: missing, frames: N });
  const eOk = await caught({ stems: toneStems(N), frames: N });
  ok('a stem SHORTER than the track is NO_TRACK naming the stem — not a deliverable that is silently '
    + 'not the track',
    eShort != null && eShort.code === 'NO_TRACK' && eShort.message.includes(STEMS[3])
      && eShort.message.includes(String(N)),
    eShort ? `${eShort.code}: ${eShort.message}` : 'it rendered a track one of whose stems is short');
  ok('...and a MISSING stem is the same refusal, and a complete track is not refused at all',
    eMissing != null && eMissing.code === 'NO_TRACK' && eMissing.message.includes(STEMS[2])
      && eOk === null,
    `${eMissing ? eMissing.code : 'nothing thrown'} for a missing stem; `
    + `a complete track threw ${eOk ? eOk.code : 'nothing'}`);

  // ---- the producer failure, DRIVEN rather than mutated --------------------
  /**
   * LAYER 1 OF THE GUARD AND THE RE-THROW, WITHOUT A MUTATION. `o.onProgress` is
   * called inside the same try block the producer runs in, so a consumer of
   * progress that throws exercises exactly the path a `fill()` that threw would:
   * the callback's catch names the frame, the `finally` resumes the context so
   * the render still settles, and `if (failure) throw failure` is what stops a
   * truncated bounce being presented as a finished one. Before this, the
   * re-throw could be deleted with the whole suite still green.
   */
  const LONG = Math.round(7 * SR);
  const CAP = 1 << 16, EVERY = 1 << 15;
  const planF = bouncePlan({ frames: LONG, capacity: CAP, refillEvery: EVERY });
  let boom = null;
  try {
    const h = makeOfflineHarness(EXT);
    await renderBounce({
      track: { stems: toneStems(LONG), frames: LONG }, settings: unitySettings(),
      assetUrl: h.assetUrl, audio: h.audio, capacity: CAP, refillEvery: EVERY,
      onProgress: () => { throw new Error('the consumer of progress threw'); },
    });
  } catch (e) { boom = e; }
  ok('a producer that failed mid-render is a RENDER_FAILED naming the frame and the second — never a '
    + 'finished bounce, and never an unhandled rejection',
    planF.refills.length >= 1 && boom != null && boom.code === 'RENDER_FAILED'
      && /the producer failed at frame (\d+) of (\d+) \(\d+\.\d\d s\)/.test(boom.message)
      && boom.message.includes('the consumer of progress threw')
      && Number(/at frame (\d+)/.exec(boom.message)[1]) === planF.refills[0].frame,
    boom ? boom.message : `it resolved as a finished bounce over ${planF.refills.length} stops`);
});

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
