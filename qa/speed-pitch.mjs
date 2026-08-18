/**
 * SPEED MUST NOT MOVE THE KEY — the acceptance gate for the 2026-08-17 ruling.
 *
 *     node qa/speed-pitch.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT BROKE. The build shipped VARISPEED: `content.js::driveRate()` — the one
 * driver of `video.playbackRate` — wrote `preservesPitch = false` before every
 * rate, so the page's own player transposed by the rate and the capture tap,
 * which sits downstream of it, recorded the transposed audio. Every stem the
 * separator produced was therefore already in the wrong key, and TRANSPOSE was
 * the operator's manual undo. It was deliberate, it was documented, and the spec
 * has overruled it: **speed changes the tempo and nothing else, matching what
 * YouTube's own speed menu does, because that is what every player the user has
 * ever touched does.**
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CAN AND CANNOT SEE, said first so no assertion below is read as
 * more than it is.
 *
 * The rate stage is CHROME'S — `media::AudioRendererAlgorithm` behind
 * `HTMLMediaElement.preservesPitch` — and there is no Chrome in Node. So the
 * chain that decides the deck's output pitch is split in two and this file
 * handles the halves differently:
 *
 *   1. WHICH BRANCH THE SHIPPED BUILD SELECTS. Read out of the shipped sources,
 *      not restated here — §1. This is the half that broke and it is the half
 *      the assertions can move.
 *   2. WHAT EACH BRANCH DOES. Defined by the HTML spec: `preservesPitch = true`
 *      leaves the pitch alone, `false` makes it follow the rate. §2 turns that
 *      into ONE number, `uaRatio`, and drives a REAL windowed-sinc resampler
 *      with it — so the varispeed branch really is a resampled signal whose
 *      fundamental has really moved, and the estimator really has to find it.
 *   3. EVERYTHING AFTER THE TAP — the ring, the segmenter, the overlap-add, the
 *      pitch lanes. Only the last of those can move a pitch, and it is the real
 *      `extension/engine/pitch.js`, driven here at the same settings the deck
 *      bus drives it at.
 *
 * So: `f_out = F0 · uaRatio(rate, keyLock) · 2^(transpose/12)`, and the ruling
 * is the claim that the middle factor is 1.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT COMPENSATE IN THE ENGINE, since `pitch.js` is already on the bus. §4
 * computes it rather than arguing it. Short version: the compensation is
 * −12·log2(rate), `pitch.js` produces INTEGER semitones in [−6, +6], and of the
 * deck's 29 rungs only 13 land on one. The ladder's own ends need ±12 — twice
 * the whole range — composition with TRANSPOSE overflows before the range does,
 * and above 1x varispeed destroys band BEFORE the tap that no downstream shifter
 * can put back.
 *
 * ---------------------------------------------------------------------------
 * L1/P1/M1 are untouched: this reads no URL, opens no socket and generates its
 * own stimulus.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import {
  PitchShifter, PITCH_GROUP_DELAY_SAMPLES, PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES,
} from '../extension/engine/pitch.js';
import { rfft, hann } from '../extension/engine/fft.js';
import { SPEED_RATES, speedFar } from '../extension/ui/embed-state.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');

let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log(`\x1b[32mok  \x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; console.log(`\x1b[31mFAIL\x1b[0m ${name}${detail ? `\n       ${detail}` : ''}`); }
};

// ===========================================================================
// 1. THE SHIPPED POLICY, READ OUT OF THE BUILD
// ===========================================================================
/**
 * It is READ and never restated. A gate that declares `keyLock = true` and then
 * measures a chain built from its own declaration is the vacuous shape
 * `AGENTS.md` has twenty instances of: it would report coverage of the exact
 * property that broke while having none. The value driving §3's measurement is
 * the one the browser will use.
 */

/** Every `.js` under `extension/`, so §1.2 cannot pass by scanning nothing. */
function extensionSources() {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === 'vendor' || e === 'node_modules') continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js')) out.push(p);
    }
  };
  walk(EXT);
  return out;
}

const SOURCES = extensionSources();

/**
 * `driveRate`'s body, sliced out of `content.js`. The function's own header
 * names itself "THE ONLY PLACE THAT DRIVES `playbackRate`", so this is the
 * entry point the ruling attaches to and the only one §1.1 speaks for.
 *
 * `null` when it cannot be located — which §1.1 treats as a FAILURE and not as
 * an excuse. If the function was renamed or moved, this gate has stopped
 * watching the thing it exists to watch, and that has to be a red.
 */
function driveRateBody() {
  const src = readFileSync(join(EXT, 'content.js'), 'utf8');
  const at = src.indexOf('\nfunction driveRate(');
  if (at < 0) return null;
  const end = src.indexOf('\n}\n', at);
  return end < 0 ? null : src.slice(at, end);
}

/**
 * Resolve one `preservesPitch = <rhs>` to a boolean. `true`/`false` are
 * themselves; the identifier `SPEED_KEY_LOCK` is resolved from `speed.js`,
 * which is where the ruling lives. ANYTHING ELSE IS `null` — an expression this
 * gate cannot evaluate is a policy it cannot report, which is a red, not a pass.
 */
function resolvePolicy(rhs) {
  if (rhs === 'true') return true;
  if (rhs === 'false') return false;
  if (rhs !== 'SPEED_KEY_LOCK') return null;
  const m = readFileSync(join(EXT, 'speed.js'), 'utf8')
    .match(/\bvar\s+SPEED_KEY_LOCK\s*=\s*(true|false)\s*;/);
  return m ? m[1] === 'true' : null;
}

const body = driveRateBody();
const writes = body ? [...body.matchAll(/\.preservesPitch\s*=\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]) : [];
const keyLock = writes.length === 1 ? resolvePolicy(writes[0]) : null;

ok('THE POLICY — driveRate() key-locks the element  [entry point: content.js::driveRate, '
  + 'the one driver of video.playbackRate]',
  keyLock === true,
  body === null
    ? 'could not locate `function driveRate(` in extension/content.js. The gate cannot look, so it fails: '
      + 'if the driver moved, nothing here is watching the ruling any more.'
    : writes.length !== 1
      ? `expected exactly one \`preservesPitch =\` in driveRate, found ${writes.length}: ${JSON.stringify(writes)}. `
        + 'Two writes of one property in one function is the entry-point family in miniature.'
      : keyLock === null
        ? `\`preservesPitch = ${writes[0]}\` — this gate cannot evaluate that, so it cannot report the policy.`
        : keyLock === true
          ? `driveRate writes \`preservesPitch = ${writes[0]}\` -> KEY LOCK, on every rate write`
          : `driveRate writes \`preservesPitch = ${writes[0]}\` -> VARISPEED. The fix is one token:\n`
          + '         extension/content.js, in driveRate():\n'
          + '           -  if (v.preservesPitch !== false) v.preservesPitch = false;\n'
          + '           +  if (v.preservesPitch !== SPEED_KEY_LOCK) v.preservesPitch = SPEED_KEY_LOCK;\n'
          + '         (`SPEED_KEY_LOCK` is `var`-declared in extension/speed.js, which loads ahead of\n'
          + '          content.js in the same content_scripts entry — the same way SPEED_EPS reaches it.)');

/**
 * ...AND THE SAME QUESTION ONE SCOPE WIDER, because it is a different claim.
 * §1.1 says the DRIVER key-locks. This says NO path in the extension leaves the
 * element key-unlocked — a second writer somewhere else would satisfy §1.1 and
 * still ship the defect, which is exactly the five-times-shipped failure
 * `AGENTS.md` calls the entry-point family.
 */
const unlocked = SOURCES
  .map((p) => [relative(ROOT, p), readFileSync(p, 'utf8')])
  .filter(([, s]) => /\.preservesPitch\s*=\s*(false|0|null|undefined)\b/.test(s))
  .map(([p]) => p);

ok('THE POLICY — no path in the extension leaves the element key-unlocked  '
  + '[entry point: every .js under extension/]',
  SOURCES.length > 0 && unlocked.length === 0,
  SOURCES.length === 0
    ? 'scanned zero files — the walk found nothing, so this assertion has no coverage at all'
    : unlocked.length
      ? `${unlocked.length} file(s) assign preservesPitch a falsy literal: ${unlocked.join(', ')}`
      : `${SOURCES.length} files scanned, none`);

// ===========================================================================
// 2. THE INSTRUMENT
// ===========================================================================
const SR = 44100;
const F0 = 1000;                       // the probe tone
const AN = 1 << 16;                    // 65 536-sample analysis window, 1.486 s
const SETTLE = 1 << 14;                // let the vocoder fill past its own delay
const NEED = PITCH_GROUP_DELAY_SAMPLES + SETTLE + AN + 4096;

/**
 * The fundamental, by parabolic interpolation on the log-magnitude peak of a
 * Hann-windowed 65 536-point spectrum.
 *
 * PICKED FOR THE CLAIM'S RANGE **AND** ITS RESOLUTION, which are two different
 * requirements and §3.5/§3.6 pay for both:
 *   - RANGE. The search is the whole spectrum, so it resolves a transposition of
 *     ±1200 cents as readily as one of 3. An estimator that assumed the peak was
 *     near F0 would saturate exactly where the defect lives — the failure mode
 *     `AGENTS.md` calls "the dynamic range was removed three lines upstream".
 *   - RESOLUTION. A raw bin is 0.673 Hz = 1.16 cents at F0, which cannot carry a
 *     3-cent claim on its own; the interpolation is what does, and §3.6 measures
 *     that rather than assuming it.
 *
 * IT READS NO CLOCK. Every number below is a frequency ratio, so nothing here
 * can go red because the machine was busy.
 *
 * @returns {{hz:number, snrDb:number}|null} null when there is no peak to read —
 *   which every caller must treat as a failure, never as a skip.
 */
function fundamental(x, off) {
  if (off + AN > x.length) return null;
  const w = hann(AN);
  const buf = new Float64Array(AN);
  for (let i = 0; i < AN; i++) buf[i] = x[off + i] * w[i];
  const nb = (AN >> 1) + 1;
  const re = new Float64Array(nb), im = new Float64Array(nb);
  rfft(buf, 0, AN, re, im, 0, 1);
  const p = (k) => re[k] * re[k] + im[k] * im[k];
  let best = -1, bestP = 0, tot = 0;
  for (let k = 1; k < nb - 1; k++) { const v = p(k); tot += v; if (v > bestP) { bestP = v; best = k; } }
  if (best < 1 || bestP <= 0) return null;
  const l = (k) => 0.5 * Math.log(p(k) + 1e-300);
  const a = l(best - 1), b = l(best), c = l(best + 1);
  const den = a - 2 * b + c;
  const d = den === 0 ? 0 : 0.5 * (a - c) / den;
  if (!Number.isFinite(d) || Math.abs(d) > 1) return null;
  // Peak against everything that is not the peak's own three bins.
  const rest = tot - p(best - 1) - bestP - p(best + 1);
  return { hz: (best + d) * SR / AN, snrDb: 10 * Math.log10(bestP / (rest + 1e-300)) };
}

const cents = (got, want) => 1200 * Math.log2(got / want);

// --- a real windowed-sinc varispeed, so the rate stage is measured not asserted
const RS_TAPS = 128, RS_BRANCHES = 512, RS_BETA = 9.5;
function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-18 * s) break; }
  return s;
}
const bankCache = new Map();
function kernelBank(fc) {
  const key = fc.toFixed(12);
  let bank = bankCache.get(key);
  if (bank) return bank;
  bank = new Float64Array((RS_BRANCHES + 1) * RS_TAPS);
  const half = RS_TAPS >> 1, i0b = besselI0(RS_BETA);
  for (let b = 0; b <= RS_BRANCHES; b++) {
    const frac = b / RS_BRANCHES;
    let sum = 0;
    for (let j = 0; j < RS_TAPS; j++) {
      const t = j - half + 1 - frac;
      const s = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
      const u = (j - (RS_TAPS - 1) / 2) / (RS_TAPS / 2);
      const arg = 1 - u * u;
      const win = arg <= 0 ? 0 : besselI0(RS_BETA * Math.sqrt(arg)) / i0b;
      bank[b * RS_TAPS + j] = s * win;
      sum += s * win;
    }
    for (let j = 0; j < RS_TAPS; j++) bank[b * RS_TAPS + j] /= sum;
  }
  bankCache.set(key, bank);
  return bank;
}

/**
 * THE RATE STAGE, as one number. `uaRatio` is the factor Chrome applies to the
 * pitch: 1 under key lock, the playback rate under varispeed. Both branches run
 * through THIS SAME resampler — at ratio 1 the kernel is a delta and it is a
 * pure delay — so the two policies differ by a value and not by a code path,
 * which is what lets §3.5 be a control that can lose.
 *
 * It interpolates COEFFICIENTS between neighbouring sub-phase branches, never
 * the signal. `docs/AUDIO.md` §1.3's −8.6 dB is signal interpolation and this is
 * deliberately not it.
 */
function stimulus(uaRatio) {
  const half = RS_TAPS >> 1;
  const srcLen = Math.ceil(NEED * Math.max(1, uaRatio)) + 4 * RS_TAPS;
  const src = new Float64Array(srcLen);
  for (let i = 0; i < srcLen; i++) src[i] = 0.5 * Math.sin(2 * Math.PI * F0 * i / SR);
  const bank = kernelBank(0.5 * Math.min(1, 1 / uaRatio));
  const out = new Float32Array(NEED);
  for (let n = 0; n < NEED; n++) {
    const tau = n * uaRatio + half;
    const i0 = Math.floor(tau), fr = tau - i0;
    const bf = fr * RS_BRANCHES, b0 = Math.floor(bf), al = bf - b0;
    const o0 = b0 * RS_TAPS, o1 = (b0 + 1) * RS_TAPS;
    let acc = 0;
    for (let j = 0; j < RS_TAPS; j++) {
      const idx = i0 - half + 1 + j;
      if (idx < 0 || idx >= srcLen) continue;
      acc += src[idx] * (bank[o0 + j] * (1 - al) + bank[o1 + j] * al);
    }
    out[n] = acc;
  }
  return out;
}

/**
 * Through the REAL shifter, at the block sizes the worklet actually hands it
 * (128 is the render quantum; the rest are pitch.js's own suite's, so a block
 * boundary lands in a different place on every pass).
 *
 * `framesIn`/`framesOut` are the SHIFTER's own absolute counters, not a running
 * total of what this file passed in. A tally of our own argument would be
 * arithmetic about one variable and could not fail; these two are the object's
 * record of what it consumed and what it emitted.
 */
const BLOCKS = [128, 1000, 4096, 333, 8191];
function throughDeckBus(x, semitones) {
  const sh = new PitchShifter(semitones, 1);
  const out = new Float32Array(x.length);
  let p = 0, bi = 0, handed = 0;
  while (p < x.length) {
    const n = Math.min(BLOCKS[bi++ % BLOCKS.length], x.length - p);
    sh.process([x.subarray(p, p + n)], [out.subarray(p, p + n)], n);
    handed += n; p += n;
  }
  return { out, handed, framesIn: sh.inCount, framesOut: sh.outCount, starved: sh.stats.starved };
}

/** One end-to-end case: policy + rate + transpose -> measured cents off target. */
function render(rate, transpose, lock) {
  const uaRatio = lock ? 1 : rate;
  const r = throughDeckBus(stimulus(uaRatio), transpose);
  const f = fundamental(r.out, PITCH_GROUP_DELAY_SAMPLES + SETTLE);
  const want = F0 * Math.pow(2, transpose / 12);
  return { ...r, uaRatio, want, hz: f ? f.hz : null, snrDb: f ? f.snrDb : null, cents: f ? cents(f.hz, want) : null };
}

// ===========================================================================
// 3. THE MEASUREMENT
// ===========================================================================
/**
 * The rates are REAL LADDER RUNGS, fetched from `SPEED_RATES` by their exponent
 * in thirty-sixths of an octave — not typed as decimals. A literal 0.7492 is not
 * on the ladder (the rung is 0.74915353…), so `speedFar()` would call it off-grid
 * and §4 would silently compute the wrong compensation for it.
 *
 * The two ends, home, and four rungs between — including −15/36, a fourth down,
 * which is the ruling's own worked example, and +21/36, a fifth up. 0.50x and
 * 2.00x are in deliberately: they are the settings that decide this, because
 * they are the ones no shifter of ours could ever have compensated.
 */
const rung = (m) => {
  const r = SPEED_RATES.find((v) => Math.abs(Math.log2(v) * 36 - m) < 1e-9);
  if (r === undefined) throw new Error(`qa/speed-pitch: no ladder rung at ${m}/36 of an octave`);
  return r;
};
const RATES = [-36, -15, -6, 0, 12, 21, 36].map(rung);
const RATE_M = new Map(RATES.map((r, i) => [r, [-36, -15, -6, 0, 12, 21, 36][i]]));
const TOL_CENTS = 2;

const grid = [];
for (const t of [0, 5, -5]) for (const r of RATES) grid.push({ rate: r, transpose: t, ...render(r, t, keyLock === true) });

const fmt = (c) => (c === null ? '  n/a ' : `${c >= 0 ? '+' : ''}${c.toFixed(2)}`);
console.log('\n  rate   transpose   want Hz    got Hz     cents   SNR dB');
for (const g of grid) {
  console.log(`  ${g.rate.toFixed(4)}  ${String(g.transpose).padStart(6)}    ${g.want.toFixed(2).padStart(8)}  `
    + `${(g.hz === null ? '—' : g.hz.toFixed(3)).padStart(9)}  ${fmt(g.cents).padStart(7)}  `
    + `${(g.snrDb === null ? '—' : g.snrDb.toFixed(1)).padStart(6)}`);
}
console.log('');

const worst = (rows) => rows.reduce((a, g) => (g.cents !== null && Math.abs(g.cents) > Math.abs(a) ? g.cents : a), 0);
const anyBlind = (rows) => rows.some((g) => g.cents === null);

/**
 * §3.1 — THE RULING. Entry point: the deck bus with TRANSPOSE at home, which is
 * where the user who slows a video down to learn a line is standing.
 *
 * WHAT MAKES IT GO RED, and it is reachable in this build because it is what the
 * build does today: `preservesPitch = false` puts the fundamental at F0·rate,
 * i.e. −1200 cents at 0.50x and +1200 at 2.00x — six hundred times the
 * tolerance. §3.5 measures exactly that, on purpose.
 *
 * WHAT IT DOES **NOT** PROVE, stated because the shape invites the mistake. Once
 * the policy is key lock, `uaRatio` is 1 at every rate, so the seven rows become
 * seven copies of one stimulus and the row-to-row agreement is arithmetic rather
 * than evidence. THE DISCRIMINATING INPUT IS THE POLICY, which is read from the
 * build and not declared here, and §3.5 is what shows the chain would notice if
 * it moved. The other way this claim could break — something DOWNSTREAM of the
 * tap reading the rate and shifting on it — is out of this harness's reach
 * entirely, and is §3.3.
 */
{
  const rows = grid.filter((g) => g.transpose === 0);
  ok('SPEED DOES NOT MOVE THE KEY  [entry point: the deck bus, TRANSPOSE 0]',
    !anyBlind(rows) && rows.every((g) => Math.abs(g.cents) <= TOL_CENTS),
    anyBlind(rows)
      ? 'at least one rate produced no readable fundamental — the gate could not look, so it fails'
      : `worst ${fmt(worst(rows))} cents over ${rows.length} rates, 0.50x..2.00x (gate ±${TOL_CENTS})`);
}

/**
 * §3.2 — COMPOSITION, and it is a SEPARATE assertion because it is a separate
 * entry point. TRANSPOSE keeps its meaning: a deliberate key change ON TOP of
 * whatever speed is set. 0.75x with TRANSPOSE +5 is a fourth UP from the
 * original, not back at it.
 *
 * IT IS THE HALF §3.1 CANNOT SEE. A build that key-locked the element and then
 * quietly folded the speed ratio into the shifter would pass §3.1 at every rate
 * and land the +5 case a fourth low. One value, two call sites — five defects in
 * this repo's history, per `AGENTS.md`.
 */
{
  const rows = grid.filter((g) => g.transpose !== 0);
  ok('TRANSPOSE IS THE ONLY THING THAT MOVES THE KEY, AND IT COMPOSES WITH SPEED  '
    + '[entry point: the deck bus, TRANSPOSE +5 and −5]',
    !anyBlind(rows) && rows.every((g) => Math.abs(g.cents) <= TOL_CENTS),
    anyBlind(rows)
      ? 'at least one case produced no readable fundamental — the gate could not look, so it fails'
      : `worst ${fmt(worst(rows))} cents over ${rows.length} cases (gate ±${TOL_CENTS}); `
        + `0.75x +5 reads ${grid.find((g) => g.rate === rung(-15) && g.transpose === 5).hz.toFixed(2)} Hz `
        + `against ${(F0 * Math.pow(2, 5 / 12)).toFixed(2)} Hz — a fourth UP from ${F0} Hz, not back at it`);
}

/**
 * §3.3 — THE ENGINE IS RATE-BLIND, and this is the half §3.1 structurally cannot
 * see. §3.1 drives a chain this file assembles; it would be entirely happy with
 * a build in which `offscreen/live.js` fed the page rate into `PitchLanes`. So
 * the claim is made where it is checkable: NOTHING between the capture tap and
 * the DAC references the page rate at all.
 *
 * `offscreen/offscreen.js` is excluded by name and only it: `pageRate` lives
 * there, its own doc block calls it "A RECORD AND NOT A CONTROL", and the SPEED
 * handler is the one legitimate mention in the engine. Every other engine file
 * naming it would be that record growing a reader.
 *
 * FAILS IF IT CANNOT LOOK: zero files scanned is a red, not a pass.
 */
{
  const scanned = SOURCES.filter((p) => {
    const r = relative(ROOT, p);
    return (r.startsWith('extension/engine/') || r.startsWith('extension/offscreen/')
      || r.startsWith('extension/workers/') || r.startsWith('extension/shared/'))
      && r !== 'extension/offscreen/offscreen.js';
  });
  // Comments are stripped first: this is a claim about CODE, and a header that
  // explains why the engine does not read the rate must not fail an assertion
  // that the engine does not read the rate.
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const readers = scanned
    .map((p) => [relative(ROOT, p), strip(readFileSync(p, 'utf8'))])
    .filter(([, s]) => /\bpageRate\b|\bplaybackRate\b/.test(s))
    .map(([p]) => p);
  ok('NOTHING DOWNSTREAM OF THE TAP READS THE PAGE RATE  '
    + '[entry point: extension/{engine,offscreen,workers,shared}/**, less offscreen.js which owns the record]',
    scanned.length > 0 && readers.length === 0,
    scanned.length === 0
      ? 'scanned zero engine files — this assertion has no coverage at all'
      : readers.length
        ? `${readers.join(', ')} reference the page rate in code. The engine must not shift on it: `
          + 'that is the second call site §3.2 exists to catch, one layer down.'
        : `${scanned.length} engine files, none`);
}

/**
 * §3.4 — THE LENGTH INVARIANT, which the ruling must not have cost. `pitch.js`
 * promises `framesIn === framesOut` at 44 100 and it is condition (b) of the
 * 2026-08-15 amendment that permits a downstream pitch transform at all. Asserted
 * at every rate because the stimulus length is what the rate stage changes.
 */
{
  const bad = grid.filter((g) => !(g.framesIn === g.handed && g.framesOut === g.handed && g.starved === 0));
  ok('framesIn === framesOut AT EVERY SPEED, AND NOTHING STARVED  '
    + '[entry point: PitchShifter.process on the deck bus]',
    grid.length > 0 && bad.length === 0,
    bad.length
      ? bad.map((g) => `${g.rate}x/${g.transpose}: handed ${g.handed} in ${g.framesIn} out ${g.framesOut} starved ${g.starved}`).join('; ')
      : `${grid.length} cases, ${grid[0].handed} frames each, in === out === handed, starved 0`);
}

// ---------------------------------------------------------------- the controls
/**
 * §3.5 — THE CONTROL, AND IT CAN LOSE. `AGENTS.md`: a control that
 * cannot distinguish the hypothesis from its negation is a second copy of the
 * measurement wearing the word "control".
 *
 * This drives the SAME chain with the policy forced the other way — the build as
 * it ships today — and requires the reading to be the transposition varispeed
 * actually produces, +1200·log2(rate) cents, at every non-unity rate. Two ways
 * for it to lose, and both are the ways §3.1 could have been vacuous:
 *   - if the estimator saturated or only searched near F0, it would read ≈0 and
 *     this fails;
 *   - if the rate stage were inert — a `uaRatio` that never reached the
 *     resampler — it would read ≈0 and this fails.
 * It is also the direct evidence that §3.1's assertion has been observed
 * failing, on the very policy this gate exists to retire.
 */
{
  const rows = RATES.filter((r) => r !== 1).map((r) => {
    const g = render(r, 0, false);
    return { r, got: g.cents, want: 1200 * Math.log2(r) };
  });
  const bad = rows.filter((x) => x.got === null || Math.abs(x.got - x.want) > TOL_CENTS
                                || Math.abs(x.got) <= TOL_CENTS);
  ok('CONTROL — with the policy forced to VARISPEED the same chain reads the full transposition  '
    + '[entry point: the deck bus, TRANSPOSE 0, preservesPitch = false]',
    rows.length >= 5 && bad.length === 0,
    bad.length
      ? bad.map((x) => `${x.r}x: read ${fmt(x.got)}, expected ${fmt(x.want)}`).join('; ')
      : rows.map((x) => `${x.r.toFixed(4)}x ${fmt(x.got)}/${fmt(x.want)}`).join('  '));
}

/**
 * §3.6 — THE OTHER HALF OF "pick the estimator for the claim": RESOLUTION.
 * §3.5 proves the instrument's range covers ±1200 cents. That says nothing about
 * whether it can tell 3 cents from 0 — and a 3-cent gate read by a 1.16-cent bin
 * would be a gate that cannot fail for small errors, which is how a real
 * compensation bug of a quarter-tone or less would walk straight through §3.1.
 *
 * A tone one cent sharp of F0, through the same window: read it as 1.00 ± 0.25.
 */
{
  const off = Math.pow(2, 1 / 1200);
  const n = AN + 4096;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * F0 * off * i / SR);
  const f = fundamental(x, 2048);
  const read = f ? cents(f.hz, F0) : null;
  ok('CONTROL — the instrument resolves ONE cent  [entry point: fundamental(), the estimator itself]',
    read !== null && Math.abs(read - 1) <= 0.25,
    read === null ? 'no peak found in a pure tone — the estimator is broken, not the chain'
      : `a +1.000-cent tone reads ${read.toFixed(3)} cents (raw bin spacing here is 1.16 cents, `
        + 'so this is entirely the interpolation)');
}

// ===========================================================================
// 4. WHY THE ENGINE ROUTE WAS NOT TAKEN — derived, not argued
// ===========================================================================
/**
 * Every number below comes from the shipped ladder (`SPEED_RATES`) and the
 * shipped shifter's range (`PITCH_MIN/MAX_SEMITONES`). Nothing is written down,
 * so if either moves these go red and the decision gets re-read — which is the
 * point, since we want to be told whether restricting the ladder would
 * make the engine route viable.
 */
const rungs = SPEED_RATES.map((r) => {
  const interval = speedFar(r).semitones;              // exact thirds, off the ladder's own exponent
  return { r, interval, comp: interval === null ? null : -interval };
});
const exact = rungs.filter((x) => x.comp !== null && Number.isInteger(x.comp)
  && x.comp >= PITCH_MIN_SEMITONES && x.comp <= PITCH_MAX_SEMITONES);
const fine = rungs.filter((x) => x.comp !== null && !Number.isInteger(x.comp));
const far = rungs.filter((x) => x.comp !== null && Number.isInteger(x.comp)
  && (x.comp < PITCH_MIN_SEMITONES || x.comp > PITCH_MAX_SEMITONES));

/** How far a rung's compensation misses the nearest interval `pitch.js` has. */
const missCents = (x) => Math.abs(x.comp - Math.round(x.comp)) * 100;
const worstMiss = fine.reduce((a, x) => Math.max(a, missCents(x)), 0);

console.log(`\n  ladder: ${SPEED_RATES.length} rungs — ${exact.length} exactly compensable by pitch.js, `
  + `${fine.length} off-grid by up to ${worstMiss.toFixed(2)} cents, `
  + `${far.length} outside [${PITCH_MIN_SEMITONES}, ${PITCH_MAX_SEMITONES}] semitones`);
console.log(`  off-grid rungs: ${fine.map((x) => `${x.r.toFixed(4)} (needs ${x.comp >= 0 ? '+' : ''}${x.comp.toFixed(4)}, `
  + `nearest rung misses by ${missCents(x).toFixed(2)}c)`).join('  ')}`);
console.log(`  out-of-range  : ${far.map((x) => `${x.r.toFixed(4)} (${x.comp >= 0 ? '+' : ''}${x.comp})`).join('  ')}\n`);

ok('THE ENGINE ROUTE CANNOT CARRY THIS LADDER  [entry point: SPEED_RATES x pitch.js\'s range]',
  rungs.every((x) => x.comp !== null)
  && exact.length + fine.length + far.length === SPEED_RATES.length
  && fine.length > 0 && far.length > 0,
  rungs.some((x) => x.comp === null)
    ? 'a rung fell off its own ladder — speedFar() returned null for a SPEED_RATES entry, so this cannot be computed'
    : `${exact.length}/${SPEED_RATES.length} exact; the ends need ${Math.abs(-12 * Math.log2(SPEED_RATES[0])).toFixed(0)} `
      + `semitones against a range of ${PITCH_MAX_SEMITONES}`);

/**
 * ...and COMPOSITION overflows before the RANGE does, which is the sharper half
 * and the one that kills the idea even if the ladder were trimmed to the 13
 * representable rungs. 0.75x needs +5 of compensation; the worked
 * example puts TRANSPOSE +5 on top of it; one shifter would have to produce +10.
 *
 * It reads the rung from `SPEED_RATES` rather than typing 0.7492, because the
 * ladder rung is 0.74915353… and `speedFar()` answers `null` off the grid —
 * which would make this assertion pass or fail on a rounding error instead of on
 * the claim.
 */
{
  const r = rung(-15);
  const comp = -speedFar(r).semitones;
  const worst = comp + PITCH_MAX_SEMITONES;
  ok('...AND COMPOSITION OVERFLOWS BEFORE THE RANGE DOES  '
    + `[entry point: ${r.toFixed(4)}x (a fourth down) + TRANSPOSE +5, the ruling's worked example]`,
    comp === 5 && worst > PITCH_MAX_SEMITONES,
    `${r.toFixed(4)}x needs ${comp >= 0 ? '+' : ''}${comp} of compensation; with TRANSPOSE +5 on top, one `
    + `shifter would owe +${worst} semitones against a ceiling of +${PITCH_MAX_SEMITONES}`);
}

// ===========================================================================
console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed && keyLock !== true) {
  console.log('\x1b[2m  The §1 reds and the §3 reds are ONE defect and ONE fix, not two:\n'
    + '  §3 renders the chain under the policy §1 read out of the build, so while driveRate()\n'
    + '  writes `preservesPitch = false` the measurement is of varispeed and the cents columns\n'
    + '  above are the defect, measured. Apply the one-token patch printed under the first\n'
    + '  assertion and every red in this file goes green together — §3.5, which forces the old\n'
    + '  policy explicitly, is the one that must stay green either way.\x1b[0m');
}
process.exit(failed ? 1 : 0);
