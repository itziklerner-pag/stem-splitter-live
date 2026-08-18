/**
 * QA-15 — acceptance gate for the passthrough-gain ruling.
 *
 * WHY THIS EXISTS. The backpressure ladder degrades a late chunk to unseparated
 * passthrough rather than to silence. That is the right call and it is well
 * tested. What nobody stated is what the DJ's mixer does to that passthrough,
 * and the answer was: nothing. `LiveEmitter.gap()` writes the unseparated mix
 * into the passthrough planes; the worklet multiplies them by gain slot
 * `G_PASS`; that slot is initialised to 1 in the processor constructor and no
 * message ever wrote it (`pushGains()` posted the stem slots only). So a killed
 * stem came back for the whole of every dropped span. The 334 s soak measured
 * 26 such spans in the first 155 s at the default hop.
 *
 * THE RULING (engine-side):
 *
 *   passthrough gain = MIN of the resolved stem gains
 *
 * so a killed stem can never leak during a drop, and with nothing muted or
 * soloed the minimum is 1 and the output stays bit-identical to today.
 *
 * This file drives the REAL `LiveEmitter.gap()`, the REAL `resolveGains()` and
 * the REAL `passthroughGain()`, and reproduces the worklet's summing line
 * verbatim, so it is arithmetic rather than inference and needs no browser.
 *
 * EVERY PLANE INDEX AND EVERY GAIN VECTOR HERE IS DERIVED FROM `STEMS`.
 * This file was written when planes 8/9 were the passthrough and `g4` had four
 * entries. At six stems 8/9 are GUITAR, the passthrough is 12/13, and the
 * hardcoded `g4[q / 2]` ran off the end of a four-long array — which produced
 * `NaN` in the summing line and eight reds that said nothing about the ruling.
 * Nothing below names a number that STEMS.length determines.
 *
 * STATUS. This file's footer used to promise it would "flip green on its own the
 * moment both halves land, with no edit here". THAT PROMISE IS RETIRED and the
 * footer says so: it held for the QA-15 ruling, which is engine-side, and it did
 * NOT hold for the stem-count change, which moves the plane map this file has to
 * reproduce. A gate that mirrors a memory layout cannot be indifferent to the
 * layout changing. What it still does — and this is the part worth keeping — is
 * read `mixer.passthroughGain` and grep `offscreen/live.js` for the post, rather
 * than restating either.
 *
 *   node qa/passthrough-gain.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLivePlan, LiveEmitter, STEM_PLANES, PASS_PLANE_L, PASS_PLANE_R } from '../extension/engine/live.js';
import { STEMS } from '../extension/shared/config.js';
import * as mixer from '../extension/engine/mixer.js';
const { resolveGains, dbToGain } = mixer;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = STEMS.length;

let failed = 0, passed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) passed++; else failed++;
  console.log(`  ${cond ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? '\n         ' + detail : ''}`);
};
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const p = makeLivePlan(1.95);
const IN_L = 0.5, IN_R = -0.5;

/** one good chunk then a skipped one — the ladder's actual sequence */
function skippedSpan() {
  const em = new LiveEmitter(p, 'linear');
  const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(p.L).fill(0.25));
  const mixL = new Float32Array(p.H).fill(IN_L), mixR = new Float32Array(p.H).fill(IN_R);
  em.chunk(0, src, mixL, mixR);
  return em.gap(p.H, mixL, mixR);
}
const gap = skippedSpan();
/** last frame of the span: past the entry crossfade, pure passthrough */
const I = p.H - 1;

/**
 * `offscreen/playback-processor.js`'s summing line, verbatim, with N + 2 gain
 * slots: `0..N-1` stems · `G_PASS = N` passthrough · `G_MASTER = N + 1` master.
 * @param {number[]} gs the resolved stem gains, one per STEMS entry
 * @param {number} gPass whatever is in slot G_PASS
 * @param {number} gMaster slot G_MASTER
 */
const sum = (gs, gPass, gMaster) => {
  if (gs.length !== N) throw new Error(`sum() got ${gs.length} stem gains, STEMS has ${N}`);
  const pl = gap.planes;
  let L = 0, R = 0;
  for (let q = 0; q < STEM_PLANES; q += 2) { L += pl[q][I] * gs[q / 2]; R += pl[q + 1][I] * gs[q / 2]; }
  L += pl[PASS_PLANE_L][I] * gPass; R += pl[PASS_PLANE_R][I] * gPass;
  return [L * gMaster, R * gMaster];
};

/** what the ruling requires */
const ruled = (gs) => Math.min(...gs);

/**
 * What the ENGINE actually does — read from the engine, never hardcoded.
 *
 * The first version of this file pinned `SHIPPED_PASS_GAIN = 1` because at the
 * time nothing wrote the passthrough slot. That made the gate blind to its own fix: the engine
 * landed `passthroughGain()` and the file went on reporting five failures. A gate
 * that cannot observe the change it is gating is not a gate. So: use the engine's
 * exported function if it exists, and fall back to the constructor default (1)
 * only when it does not.
 *
 * `pushGains()` must also POST it — an exported helper nobody calls fixes nothing —
 * so that is checked separately, against the source.
 */
const hasHelper = typeof mixer.passthroughGain === 'function';
const enginePass = hasHelper ? mixer.passthroughGain : () => 1;
const liveSrc = fs.readFileSync(path.join(ROOT, 'extension/offscreen/live.js'), 'utf8');
const POSTS_G_PASS = /postMessage\(\s*\{\s*t:\s*'gain',\s*i:\s*G_PASS/.test(liveSrc);

/**
 * Build a full-width stem spec from a SPARSE one keyed by stem NAME.
 *
 * The cases below used to be positional four-element arrays — `[{}, {}, {}, {m:1}]`
 * meant "vocals muted" only because vocals happened to be index 3. Naming the
 * stem makes the gesture survive the model growing, and makes the two new stems
 * participate in every case instead of being appended as `{}` by accident.
 */
const mix = (byName = {}) => STEMS.map((s) => {
  const o = byName[s] || {};
  return { gainDb: o.db ?? 0, muted: !!o.m, soloed: !!o.s };
});
/** every stem, same setting */
const all = (o) => Object.fromEntries(STEMS.map((s) => [s, o]));

// ---------------------------------------------------------------- the setup
head('QA-15 — the mechanism (these must always hold)');
/**
 * THE PLANE MAP IS ITS OWN ASSERTION, AND IT COMES FIRST.
 *
 * Everything under it indexes `gap.planes`. If the passthrough is not where
 * `PASS_PLANE_L/R` say it is, every later assertion is comparing the wrong two
 * numbers and reports a mixer defect. Naming the indices in the assertion text
 * is deliberate: a red here should be diagnosable from the summary line.
 */
ok(`a skipped chunk puts the unseparated mix on the passthrough planes (${PASS_PLANE_L}/${PASS_PLANE_R} at ${N} stems)`,
  gap.planes.length === STEM_PLANES + 2 &&
  gap.planes[PASS_PLANE_L][I] === IN_L && gap.planes[PASS_PLANE_R][I] === IN_R,
  `${gap.planes.length} planes (want ${STEM_PLANES + 2}) · pass.L ${gap.planes[PASS_PLANE_L][I]}, pass.R ${gap.planes[PASS_PLANE_R][I]}`);
ok(`and zeroes all ${STEM_PLANES} stem planes for that span`,
  Array.from({ length: STEM_PLANES }, (_, q) => gap.planes[q][I]).every((v) => v === 0));
ok(`resolveGains silences all ${N} stems when all ${N} are muted`,
  resolveGains(mix(all({ m: 1 }))).every((v) => v === 0));
ok('resolveGains ducks the un-soloed stems to zero',
  JSON.stringify(resolveGains(mix({ drums: { s: 1 } })))
    === JSON.stringify(STEMS.map((s) => (s === 'drums' ? 1 : 0))));

// ------------------------------------------------------------- the ruling
head(`QA-15 — the ruling: passthrough gain = MIN of the ${N} resolved stem gains`);

/**
 * The cases are keyed by stem NAME, and the two new stems are in every one of
 * them — including the two that only ever named `vocals`. `guitar-killed` and
 * `piano-soloed` are new: they are the same gesture on the stems that have no
 * ground truth yet (SIX-STEM-CONTRACT "known debt" §4), so the arithmetic gate
 * is the only cover they have.
 */
const CASES = [
  { name: 'nothing muted or soloed, all faders at unity',
    spec: {}, wantPass: 1,
    why: 'the no-op case — output must stay BIT-IDENTICAL to today' },
  { name: `all ${N} stems muted (the kill)`,
    spec: all({ m: 1 }), wantPass: 0,
    why: 'a killed mix must stay killed through a drop' },
  { name: 'one stem muted (vocals killed, the actual DJ gesture)',
    spec: { vocals: { m: 1 } }, wantPass: 0,
    why: 'min(...,0) = 0 — the passthrough carries the vocal, so it must go' },
  { name: 'one stem muted (GUITAR killed — a stem that did not exist a week ago)',
    spec: { guitar: { m: 1 } }, wantPass: 0,
    why: 'the new stems get the same rule, and slot G_PASS has to see them' },
  { name: `one stem soloed (the other ${N - 1} ducked)`,
    spec: { drums: { s: 1 } }, wantPass: 0,
    why: 'a solo is a kill of everything else' },
  { name: 'one stem soloed (PIANO — the last plane, the easiest to fall off the end of)',
    spec: { piano: { s: 1 } }, wantPass: 0,
    why: 'min over the WHOLE vector; a rule that stopped at index 3 reads 1 here' },
  { name: 'faders only: -6 dB on one stem, no mute, no solo',
    spec: { vocals: { db: -6 } }, wantPass: dbToGain(-6),
    why: 'the passthrough follows the quietest stem' },
  { name: 'faders only: -6 dB on PIANO, no mute, no solo',
    spec: { piano: { db: -6 } }, wantPass: dbToGain(-6),
    why: 'same, at the far end of the vector' },
];

ok('the engine exports a passthrough-gain rule at all',
  hasHelper, hasHelper ? 'engine/mixer.js exports passthroughGain()' : 'no passthroughGain() — G_PASS is still whatever the worklet constructor set');
ok('...and offscreen/live.js actually POSTS it to worklet slot G_PASS',
  POSTS_G_PASS, POSTS_G_PASS ? "pushGains() posts { t:'gain', i: G_PASS }" : 'pushGains() posts the stem slots only, so the helper is dead code');

for (const c of CASES) {
  const gs = resolveGains(mix(c.spec));
  const want = ruled(gs);
  const got = enginePass(gs);
  const [wl] = sum(gs, want, 1);
  const [al] = sum(gs, got, 1);
  ok(`${c.name} → passthrough gain ${want.toFixed(4)}`,
    gs.length === N && Math.abs(want - c.wantPass) < 1e-12 && Math.abs(got - want) < 1e-12 && Math.abs(al - wl) < 1e-12,
    `${c.why}\n         resolved stem gains ${JSON.stringify(gs.map((v) => +v.toFixed(4)))} (${gs.length} of ${N}) · ` +
    `ruled G_PASS = ${want.toFixed(4)} · engine G_PASS = ${got.toFixed(4)}\n         ` +
    `output during the drop: ruled ${wl.toFixed(4)} vs engine ${al.toFixed(4)} ` +
    `(input ${IN_L.toFixed(4)})`);
}

// ------------------------------------------------------- what already works
head('QA-15 — what already reaches the passthrough today');
const killed = resolveGains(mix(all({ m: 1 })));
ok('the master fader reaches the passthrough too (Panic / kill-all works either way)',
  sum(killed, 1, dbToGain(-120))[0] === 0,
  'master at the -120 dB sentinel gives exact 0 even with G_PASS forced to unity');

// ---------------------------------------------------- and the meters lie too
head('QA-15 — the meters during a drop');
// The worklet meters the stem planes per stem and the SUM as `master`, so during
// a drop every stem meter reads exactly 0 while master reads the full mix.
const stemPeaks = STEMS.map((_, k) => Math.abs(gap.planes[k * 2][I] * killed[k]));
const [mL] = sum(killed, enginePass(killed), 1);
// Named for what it CHECKS, not for the bug (QA-19's lesson): it must be green
// when the console is telling the truth, and it is red today.
ok('during a drop the master meter agrees with the stem meters',
  stemPeaks.length === N && stemPeaks.every((v) => v === 0) && Math.abs(mL) === 0,
  `stem peaks ${JSON.stringify(stemPeaks)}, master |${Math.abs(mL).toFixed(4)}| — ` +
  `before the fix this read 0.5000, i.e. ${N} dead meters over audible music`);

console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  // CORRECTED 2026-08-16. This used to end "...so it flips on its own the moment
  // both are in place — no edit here", which was true of the QA-15 RULING and
  // false of everything else. The six-stem migration falsified it in the most
  // direct way available: the plane map moved, `g4[q / 2]` ran off a four-long
  // array, and eight assertions went red with `NaN` in their details while the
  // ruling itself was untouched and correct. A claim that a gate is
  // self-updating is a claim about which of its inputs it reads, so it has to
  // say which.
  console.log('\x1b[2m  Two different reds live in this file, and they have different fixes:\n' +
              '   · the RULING half — `mixer.passthroughGain` and the `G_PASS` postMessage in\n' +
              '     `offscreen/live.js::pushGains` — is read from the engine, so it does flip\n' +
              '     on its own when the engine lands, with no edit here.\n' +
              '   · the LAYOUT half — plane indices, gain-slot count, vector width — is\n' +
              '     REPRODUCED here from `STEMS`, `STEM_PLANES` and `PASS_PLANE_L/R`. It\n' +
              `     tracks the stem count automatically (${N} stems, ${STEM_PLANES + 2} planes today), but a change\n` +
              '     to the LAYOUT ITSELF needs an edit here, and NaN in the detail lines above\n' +
              '     is what that looks like.\x1b[0m');
}
process.exit(failed ? 1 : 0);
