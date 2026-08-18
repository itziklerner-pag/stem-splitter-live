/**
 * Stem gain law, mute/solo semantics, master soft clip.
 *
 * Ported from `docs/snippets/mixer.js` (the reviewed reference implementation,
 * verified by `docs/snippets/selftest.js`). Only the parts live mode actually
 * uses are here — the WaveShaper curve, the fader law and the solo truth table.
 * Ramping is NOT here: it happens per sample inside the playback worklet
 * (offscreen/playback-processor.js), because there is no AudioParam between the
 * five SAB rings and the sum.
 *
 * Pure. `node test.js mix` exercises all of it.
 */

/**
 * PUBLIC INTERFACE. `faderDb`, `dbToFader` and `dbToGain` have a second consumer:
 * the console UI imports them so there is exactly one implementation of the
 * normative fader law (docs/AUDIO.md §3.1). Do not change these signatures
 * without saying so — the UI's fader widget is built on them.
 *
 * -120 dB is TRUE ZERO, not 1e-6. The UI sends -120 as its silence sentinel
 * because -Infinity does not survive structured clone reliably, and a sentinel
 * that lands on -120 dBFS of residue instead of digital black is not silence —
 * it is a denormal generator sitting in the summing bus. The threshold is also
 * ~60 dB below the bottom of the fader's own travel (-60 dB at u -> 0), so no
 * reachable fader position can be swallowed by it.
 */
export const SILENT_DB = -120;
export const dbToGain = (db) => (db === -Infinity || db <= SILENT_DB ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/**
 * Stem Splitter Live fader law: piecewise-linear in dB, unity at u = 0.80, +6 dB at the
 * top, hard zero at exactly u = 0. docs/AUDIO.md §3.1.
 *
 * The wire contract carries dB, so the fader *widget* owns the u -> dB mapping
 * and the engine never calls this. It lives here because AUDIO.md §3.1 is
 * normative and this is the implementation `node test.js mix` pins (including
 * the dbToFader round trip to 1.1e-16, so saved presets survive). If the console
 * ships its own copy of the curve, the two must agree — there is exactly one
 * normative law and this is it.
 */
export function faderDb(u) {
  if (!(u > 0)) return -Infinity;
  if (u >= 1) return 6;
  if (u <= 0.25) return -60 + 120 * u;
  if (u <= 0.50) return -30 + 60 * (u - 0.25);
  if (u <= 0.80) return -15 + 50 * (u - 0.50);
  return 30 * (u - 0.80);
}
export function dbToFader(db) {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 6) return 1;
  if (db <= -30) return (db + 60) / 120;
  if (db <= -15) return 0.25 + (db + 30) / 60;
  if (db <= 0) return 0.50 + (db + 15) / 50;
  return 0.80 + db / 30;
}

/**
 * docs/AUDIO.md §3.2, verbatim semantics:
 *  - any stem soloed  => only soloed stems are audible; their own mute is IGNORED
 *  - no stem soloed   => muted stems are silent
 *  - multiple solos   => union, each at its own fader
 *  - solo-in-place    => no make-up gain
 * Mute and solo stay independent booleans so un-soloing restores mutes.
 *
 * @param {{gainDb:number, muted:boolean, soloed:boolean}[]} stems
 * @returns {number[]} linear gain per stem (master is applied separately, in the
 *                     worklet, so a master move does not restate four stem gains)
 */
export function resolveGains(stems) {
  const anySolo = stems.some((s) => s.soloed);
  return stems.map((s) => ((anySolo ? s.soloed : !s.muted) ? dbToGain(s.gainDb) : 0));
}

/**
 * Gain for the passthrough plane — the unseparated mix the backpressure ladder
 * substitutes for a chunk it could not deliver in time (docs/ARCHITECTURE.md
 * §3.8 L2). QA-15.
 *
 * "Never louder than the quietest thing the user asked to hear."
 *
 * The stem faders cannot act on the passthrough plane — it is the mix, not a
 * stem — so if it plays at unity, a dropped chunk UNDOES the user's kill and the
 * vocal punches back in on its own. That is not a degraded span, it is the one
 * gesture this product exists for being reversed at random. Measured before the
 * fix: all four stems muted, input 0.5/−0.5, output 0.5/−0.5.
 *
 * Taking the minimum of the four resolved gains means:
 *   - nothing killed  -> min = unity, byte-identical to no ducking at all
 *   - anything killed -> min = 0, the span is silent instead of leaking it
 *   - partial cuts    -> ducks to the quietest, no step
 *   - solo            -> free, since solo resolves the others to 0
 *
 * A short hole is strictly better than a stem returning: a DJ can work around a
 * gap, they cannot work around a kill that undoes itself. The span still counts
 * in `drops` either way — silence the user did not ask for must never be
 * invisible.
 *
 * @param {number[]} resolved output of resolveGains()
 */
export const passthroughGain = (resolved) => Math.min(...resolved);

/** Soft-clip transfer function. Identity below `t`, asymptotic to ±1 above it. */
export const softClip = (x, t = 0.7079) => {
  const a = Math.abs(x);
  return Math.sign(x) * (a <= t ? a : t + (1 - t) * Math.tanh((a - t) / (1 - t)));
};

/**
 * WaveShaperNode curve. docs/AUDIO.md §4.3 — NOT a DynamicsCompressorNode: that
 * caps at 20:1, colours with attack/release, and adds lookahead we would have to
 * compensate everywhere. Wire it as
 *   sum -> gain(1/headroom) -> WaveShaper(curve, oversample:'4x') -> gain(headroom)
 * `oversample:'4x'` is mandatory or the generated harmonics fold back.
 */
export function softClipCurve(threshold = 0.7079, headroom = 2, n = 8192) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = softClip(x * headroom, threshold) / headroom;
  }
  return c;
}

/** Evaluate a WaveShaper curve the way Web Audio does — for unit tests. */
export function applyCurve(curve, x, headroom = 2) {
  const u = Math.max(-1, Math.min(1, x / headroom));
  const p = ((u + 1) / 2) * (curve.length - 1);
  const i = Math.floor(p), f = p - i;
  const v = i + 1 < curve.length ? curve[i] * (1 - f) + curve[i + 1] * f : curve[curve.length - 1];
  return v * headroom;
}

/**
 * One-pole smoothing coefficient for a per-sample gain ramp, matching
 * `AudioParam.setTargetAtTime(target, t, tau)`: 63.2 % in tau, 95 % in 3 tau.
 * The worklet additionally snaps to the target at 6 tau so a mute reaches
 * *exactly* zero (setTargetAtTime is asymptotic — AUDIO.md §3.3 note 1).
 */
export const smoothCoef = (tau, sampleRate) => 1 - Math.exp(-1 / (Math.max(tau, 1e-6) * sampleRate));

// ============================================================ crossfader (Mode 3)

/**
 * PUBLIC INTERFACE — second consumer is the console UI (`ui/audio-math.js`
 * re-exports these and the UI selftest asserts function-object IDENTITY, so
 * there is exactly one implementation of the crossfader law in the product).
 * Do not change these signatures without saying so.
 */

import {
  XF_CURVES, XF_CURVE_DEFAULT, XF_CUT_EDGE, XF_TARGETS, XF_ASSIGN_DEFAULT, DUAL_MASTER_TRIM_DB,
} from '../shared/config.js';

export { XF_CURVES, XF_CURVE_DEFAULT, XF_CUT_EDGE, XF_TARGETS, XF_ASSIGN_DEFAULT, DUAL_MASTER_TRIM_DB };

/**
 * The master gain the ENGINE defaults to for a given number of loaded decks.
 *
 * Keyed on loaded decks, not on routing — see shared/config.js
 * DUAL_MASTER_TRIM_DB. Pure so `node test.js mix` can pin the constant against
 * the peaks that motivated it; the ownership rule (a default, not a clamp) lives
 * in offscreen.js reconcileMaster(), because it is about who last touched the
 * control and that is not a property of the gain law.
 */
export const masterTrimDb = (loadedDecks) => (loadedDecks >= 2 ? DUAL_MASTER_TRIM_DB : 0);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Snap a crossfader gain to EXACT digital zero.
 *
 * `Math.cos(Math.PI / 2)` is 6.12e-17, not 0. Left alone, a deck faded hard
 * against the other end would sit at -324 dBFS forever instead of at digital
 * black — which is the same class of not-quite-silence that SILENT_DB exists to
 * refuse, and it makes "faded out" untestable as an exact property. The
 * threshold is -180 dB: 60 dB below the bottom of the fader's own travel and
 * ~13 orders of magnitude above float64 noise, so no reachable fader position
 * can be swallowed by it.
 */
const SNAP = 1e-9;
const snap = (g) => (g < SNAP ? 0 : g > 1 - SNAP ? 1 : g);

/**
 * The crossfader itself: position -> a pair of linear gains, one per deck.
 *
 *   position 0   = full deck A      position 1   = full deck B
 *
 * @param {number} position 0..1 (clamped)
 * @param {'dip'|'lin'|'cut'} curve
 * @returns {{a:number, b:number}} linear amplitude gains
 *
 * 'dip' — CONSTANT POWER, the default. a = cos(pπ/2), b = sin(pπ/2), so
 *   a² + b² = 1 exactly at every position and the centre sits at
 *   1/√2 = -3.0103 dB. This is the correct law here and the correct law is the
 *   OPPOSITE of the one used at chunk joins inside a single deck: two decks are
 *   two different records (uncorrelated — their POWERS add), whereas the two
 *   chunks either side of a join are two estimates of the same audio (coherent —
 *   their AMPLITUDES add, which is why SEAM_XFADE_LAW is 'linear'). Using
 *   either law in the other place is a 3.01 dB error, in opposite directions.
 *
 * 'lin' — a = 1 - p, b = p. Amplitudes sum to 1; power dips to 0.5 (-3.01 dB)
 *   at centre for uncorrelated material. Offered because it is what a DJ who
 *   beat-matched two copies of the same record wants, and because some people
 *   simply prefer the feel.
 *
 * 'cut' — hard. Both decks are at UNITY across the middle 80 % of the travel and
 *   the channel cuts out only inside XF_CUT_EDGE of its own end. This is the
 *   scratch/transformer curve: the point is that a 5 mm move off the edge brings
 *   the deck in at full level, not at 10 %.
 *
 * ponytail: DORMANT. This build has one deck, so no surface sends a crossfader
 * position and the fader sits at its default for the life of a session — where
 * `effectiveXfPosition` parks a single loaded deck at unity, which is the
 * identity. The law is kept because it is PURE, covered by `node test.js mix`,
 * and costs nothing to carry; deleting it would also mean unpicking
 * `offscreen/master.js` and the playback worklet's per-stem gain path, which is
 * live audio nothing in this repo can now measure. Ceiling: ~120 lines that no
 * user gesture can reach. Upstream path: it comes back with a second deck, or it
 * goes with a soak that proves the single-deck gain path is unchanged without it.
 */
export function xfaderGains(position, curve = XF_CURVE_DEFAULT) {
  const p = clamp01(+position);
  if (curve === 'lin') return { a: snap(1 - p), b: snap(p) };
  if (curve === 'cut') {
    // Written as two rising clamps rather than `1 - clamp((p-(1-e))/e)`: the
    // subtraction form leaves 2.2e-16 at p = 0 because (1 - 0.9) is not 0.1,
    // and "the closed deck is silent" is the entire specification of a cut
    // curve. This form is exact at both ends and symmetric by construction.
    const e = XF_CUT_EDGE;
    return { a: clamp01((1 - p) / e), b: clamp01(p / e) };
  }
  // 'dip' and anything unrecognised: constant power is the safe default.
  return { a: snap(Math.cos((p * Math.PI) / 2)), b: snap(Math.sin((p * Math.PI) / 2)) };
}

/**
 * Per-stem crossfader assignment — THE flagship Mode 3 feature, and the one
 * place the wire contract needed interpretation. docs/design/DESIGN.md §6.4:
 * "`A` (always on deck A bus, ignores crossfader) / `XF` (follows crossfader) /
 * `B` … set vocals to `XF`, everything else to `A`".
 *
 * The assignment is per (deck, stem) — eight cells — and `target` names WHICH
 * DECK OWNS THAT STEM:
 *
 *   target 'XF'          this cell follows the crossfader on its own deck's
 *                        side: deck A gets gA, deck B gets gB.
 *   target === deck      hard-assigned ON. Gain 1 at every fader position; the
 *                        crossfader is ignored entirely.
 *   target !== deck      hard-assigned OFF. Gain 0. The other deck owns this
 *                        stem, so this copy of it must not double it.
 *
 * Why the off case has to exist: "vocals from A over the instrumental from B" is
 * only two clicks if one click on the master matrix's `vocals` row writes BOTH
 * `{deck:'A',stem:'vocals',target:'A'}` (on) and `{deck:'B',stem:'vocals',
 * target:'A'}` (off). Without the off case, setting vocals to A would leave
 * deck B's vocals following the fader and the mashup would have two vocals in it
 * at the centre detent.
 *
 * Note the consequence, which is the useful part: a hard-assigned cell is
 * CONSTANT IN POSITION. Pin A.vocals and B.{drums,bass,other} and the mashup
 * survives any crossfader move — the fader then only controls whatever is left
 * on `XF`. That is what makes the acapella stay up while you ride the fader.
 *
 * @param {'A'|'B'} deck        which deck this stem plane belongs to
 * @param {'A'|'B'|'XF'} target the assignment for that (deck, stem) cell
 * @param {{a:number,b:number}} g precomputed xfaderGains() for the current
 *                                position and curve (hoisted out of the per-stem
 *                                loop; the fader moves once, the stems are four)
 * @returns {number} linear gain, 0..1
 */
export function xfFactor(deck, target, g) {
  if (target === 'XF' || target == null) return deck === 'A' ? g.a : g.b;
  return target === deck ? 1 : 0;
}

/** Convenience for tests and the UI: the same thing without hoisting. */
export const xfStemGain = (deck, target, position, curve = XF_CURVE_DEFAULT) =>
  xfFactor(deck, target, xfaderGains(position, curve));

/**
 * THE gain vector one deck's playback worklet is driven with, end to end.
 *
 * `resolveGains` (fader/mute/solo) and the crossfader are multiplied HERE, on
 * the main thread, and pushed to the worklet as five already-multiplied numbers.
 * The alternative — a second gain vector inside the worklet — was rejected: the
 * audio thread is the one place in this system where a bug is unrecoverable and
 * unobservable, the worklet is shared with Mode 1, and the product of two
 * one-poles is not the one-pole of the product anyway (so the "more correct"
 * version is also the one that is harder to reason about). Multiplying here
 * costs one message per fader move that already sends five.
 *
 * @param {'A'|'B'} deck
 * @param {{gainDb:number,muted:boolean,soloed:boolean}[]} stems 4, in STEMS order
 * @param {('A'|'B'|'XF')[]} assign 4 targets, in STEMS order
 * @param {number} position crossfader 0..1
 * @param {'dip'|'lin'|'cut'} curve
 * @returns {{stems:number[], pass:number}} five linear gains: 4 stems + passthrough
 */
/**
 * The crossfader position that should actually be APPLIED, given how many decks
 * are loaded.
 *
 * The control defaults to centre, which on the `dip` curve is -3.01 dB per deck.
 * That is correct with two decks and wrong with one: a lone deck would play 3 dB
 * down because of a control the user has never touched, and the Sigma-stems null
 * gate caught it as a -10.63 dB "separation" regression that was really the
 * mixer. Park on whichever deck is loaded until both are.
 *
 * @param {number} position the user's control value, 0..1
 * @param {{A:boolean, B:boolean}} loaded which decks have audio to play
 */
export function effectiveXfPosition(position, loaded) {
  const a = !!(loaded && loaded.A), b = !!(loaded && loaded.B);
  if (a && b) return position;      // both loaded: the control means what it says
  if (a) return 0;                  // lone deck A: hard left, unity
  if (b) return 1;                  // lone deck B: hard right, unity
  return position;                  // nothing loaded: nothing to attenuate
}

export function resolveDeckGains(deck, stems, assign, position, curve = XF_CURVE_DEFAULT) {
  const base = resolveGains(stems);
  const g = xfaderGains(position, curve);
  const xf = base.map((_, i) => xfFactor(deck, assign ? assign[i] : 'XF', g));
  const out = base.map((v, i) => v * xf[i]);
  // Passthrough is the UNSEPARATED mix, so it is not a stem and no assignment
  // applies to it — but it must still obey both the kill rule (QA-15: never
  // louder than the quietest thing the user asked to hear) and the crossfader,
  // or a dropped chunk on the deck you just faded out would punch that deck's
  // whole mix back in at unity. min() over the POST-crossfader gains gives both
  // at once: fade a deck to silence and its passthrough goes with it.
  // `meter` is the PRE-crossfader gain and `xf` the crossfader factor, split out
  // because the meters tap between them: a stem faded fully out on the
  // crossfader must KEEP its meter, which is how a DJ cues an incoming track.
  // Mute and solo live in `meter` and so still zero it. See
  // offscreen/playback-processor.js, which multiplies by `meter`, accumulates
  // the meter, and only then multiplies by `xf`.
  return { stems: out, pass: passthroughGain(out), meter: base, xf };
}
