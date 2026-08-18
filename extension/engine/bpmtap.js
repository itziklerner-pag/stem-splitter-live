/**
 * The tempo tap — keytap.js's sibling. Same discipline, different plane, and the
 * only place the engine ever forms an opinion about tempo.
 *
 *   stem ring planes 0/1 (`drums`)         upstream of the pitch shifter
 *     -> readStemWindow()                  absolute, non-destructive, REFUSABLE
 *     -> 3-band RMS onset envelope         441-frame hops, 100 Hz, HWR difference
 *     -> per-band unit-RMS normalise       kick and snare made the same size
 *     -> unbiased autocorrelation          lags 29..301 over an 8 s history
 *     -> comb (1x, 2x, 3x) x tempo prior   candidates 60..200 BPM, 0.25-lag grid
 *     -> octave hysteresis                 only an octave jump has to earn it
 *     -> pulse-train correlation           beat phase at the winning period
 *     -> { state, bpm, confidence, beatFrame }
 *
 * `node extension/engine/bpmtap.js` runs the checks.
 *
 * DISPLAY ONLY. Nothing downstream syncs to this, exports a beat grid off it, or
 * changes a tempo because of it. That is what buys the right to be lazy below:
 * a wrong BPM costs a wrong number on a label, not a wrong render.
 *
 * -------------------------------------------------------------- THE TAP POINT
 *
 * `drums`, and UPSTREAM of the pitch shifter. Both halves matter and both are
 * invisible in review if they are wrong.
 *
 * WHY `drums` AND NOT THE MIX. It is the exact mirror of keytap.js's argument.
 * chroma.js measures drums at +3.5 dB flattening a chroma into uninterpretability
 * — a drum kit is broadband, which is poison for a pitch estimator and is
 * precisely what a tempo estimator wants. Every published beat tracker spends its
 * front end trying to recover a percussive envelope from a full mix (HPSS,
 * spectral flux with adaptive whitening). We have the drums already, so the front
 * end is three RMS band envelopes and a subtraction — and that is not a shortcut
 * we are getting away with, it is the one thing this product has that a full-mix
 * detector does not.
 *
 * WHY UPSTREAM OF THE SHIFTER. Same composition argument as keytap. `pitch.js`
 * is length-exact (`framesIn === framesOut`, CONTRIBUTING.md's condition (b)), so the
 * shifter does NOT move tempo and tapping downstream would read the same number
 * — today. It is upstream anyway, because the day someone adds a time-stretch the
 * two taps must not disagree about which clock they are on, and a detector that
 * silently starts reporting the PLAYED tempo instead of the RECORDED one is a
 * change nothing downstream could see.
 *
 * ------------------------------------------------- WHICH END OF THE RING
 *
 * The WRITE pointer, walked forward by a fixed-advance cursor. Identical
 * reasoning to keytap.js and it is not repeated here — see that file's "WHICH END
 * OF THE RING". The one difference that is NOT cosmetic:
 *
 *   THE ENVELOPE MUST BE CONTIGUOUS. keytap's accumulator is a histogram, so a
 *   hole in its input costs it a vote. An autocorrelation over a spliced envelope
 *   does not lose a vote, it invents a periodicity. So every refusal, every
 *   catch-up jump and every `reset()` calls `_breakContinuity()`, which throws the
 *   whole 8 s history away. The tap then reports `listening` for 8 s rather than a
 *   tempo derived across a seam. That is expensive and it is the point.
 *
 * ------------------------------------------ REFUSING RATHER THAN GUESSING
 *
 * Three first-class ways of not knowing, and they are distinguishable on the
 * wire because they mean different things to a UI:
 *
 *   none       nothing audible has ever been counted. Silence, or every read
 *              refused. The tap cannot see, and says so.
 *   listening  audio is being counted and there is no answer yet — under 8 s of
 *              contiguous envelope, or the periodicity is below the gate.
 *   locked     `bpm` and `beatFrame` are present and non-null.
 *
 * `bpm` is null in the first two. There is no "best guess" field.
 *
 * --------------------------------------------------------- THE OCTAVE TIE
 *
 * Read this before changing anything in `_estimate`.
 *
 * An onset envelope at tempo B has autocorrelation peaks at EVERY multiple of the
 * beat period, so B, B/2, B/3 are all real periodicities of the signal and none of
 * them is wrong in any mathematical sense. Worse, a backbeat (kick 1 3, snare
 * 2 4) is genuinely periodic at B/2, not B, whenever the envelope cannot tell a
 * kick from a snare — then its strongest true period really is the two-beat
 * pattern and every downstream mechanism is arguing against the arithmetic.
 * The tie is broken by FOUR mechanisms and NOTHING ELSE, in the order they act:
 *
 *   1. THE THREE-BAND ENVELOPE, which is the only one that attacks the cause.
 *      Sub / body / air, each scaled to unit RMS over the analysis window before
 *      the three are summed, so a kick and a snare arrive the same size and the
 *      backbeat becomes one-beat periodic instead of two. Everything below is
 *      arguing about a tie; this is what stops the tie being rigged.
 *   2. A COMB, `r(L) + 0.5 r(2L) + 0.25 r(3L)`. This rewards a candidate whose
 *      own multiples are also peaks, which is what a real pulse looks like and
 *      what a spurious lag between two unrelated peaks does not.
 *   3. A LOG-NORMAL TEMPO PRIOR centred on 120 BPM (Ellis 2007's device). It is
 *      the only thing that separates a bare click train at 160 from the same
 *      signal read as 80 — those two hypotheses are numerically identical up to
 *      the prior, because they ARE the same signal.
 *   4. OCTAVE HYSTERESIS, which decides nothing and only stops the readout
 *      flickering when 2 and 3 land within a percent of each other. See
 *      OCTAVE_HOLD.
 *
 * WHICH WAY THE TIE BREAKS, stated so it is falsifiable and with the number that
 * makes it checkable: when the comb is TIED — which is exactly what an
 * unaccented pulse train produces, because every multiple of its period is an
 * equally perfect peak — the prior picks whichever of B and B/2 is nearer 120 BPM
 * in log-tempo, and those two are equidistant at
 *
 *     B* = sqrt(120 * 240) = 169.71 BPM
 *
 * So a bare pulse BELOW 169.71 reports itself and one ABOVE reports its half,
 * and the boundary does not move with the prior's width. Swept at 1 BPM
 * granularity over the whole 60-200 range: 141 of 141 obey that rule exactly.
 * Two of them are asserted below — 160 -> 160 and 176 -> 88.
 *
 * When the comb is NOT tied it overrules the prior, in both directions. A 70 BPM
 * groove with hats on the eighths reports 70 and not 140 because the eighth-note
 * lag anti-correlates loud beats against quiet offbeats. A bare 68 BPM click
 * train reports 68 and not 136 even though the prior prefers 136, because there
 * is no onset at 136 for the comb to find. Both are asserted below.
 *
 * TWO THINGS THAT LOOK LIKE DETAIL AND ARE THE WHOLE RESULT:
 *
 * 1. THE ENVELOPE IS NOT LOG-COMPRESSED, and that is the opposite of what every
 *    spectral-flux front end does. `log1p(1000 * rms)` was the first version. It
 *    puts a hi-hat and a kick within 1.5x of each other, which DELETES the accent
 *    structure the octave decision is made of — and the 70 BPM groove above then
 *    reports 139.6. Same code, same fixture, linear envelope: 69.9. Compression
 *    is a range problem wearing a robustness costume (AGENTS.md, "pick the
 *    estimator for the claim", (a)).
 *
 * 2. THE COMB READS THREE ACF BINS PER TERM, NOT ONE. An onset envelope is
 *    impulsive, so its autocorrelation peak is ONE bin wide — and a tempo whose
 *    period is not a whole number of 10 ms bins has its peak SPLIT across two,
 *    while a tempo at exactly half that rate lands on a bin and keeps all of it.
 *    The comb evaluates L, 2L and 3L, so the true tempo pays that penalty three
 *    times and its half pays it never. 160 BPM is the worst case at 100 Hz — lag
 *    37.5, dead between bins, with 2L = 75 exactly on one — and it reported 80.
 *    Summing acf[i-1] + acf[i] + acf[i+1] conserves the split peak and makes the
 *    two candidates comparable: the 141/141 sweep above is with the sum, and it
 *    is 132/141 with a single bin. This is NOT smoothing — averaging the three
 *    bins fixes nothing, because averaging halves a split peak exactly the way
 *    sampling it does.
 *
 * There is deliberately NO half-lag penalty (`- w r(L/2)`), which is the obvious
 * third mechanism and is a trap: for any groove with eighth-note subdivision
 * `r(L/2)` is legitimately elevated, so the penalty fires hardest on the correct
 * answer.
 *
 * ponytail: THE CEILING IS A HALVING BOUNDARY AT 166 BPM ON A BACKBEAT, and the
 * numbers below are a 1 BPM sweep of 60-200 through the real ring, not a
 * spot-check. Two different boundaries, because the two stimuli are different
 * problems:
 *
 *   bare pulse   whole to 169, halved from 170. That is sqrt(120*240) = 169.71 to
 *                the resolution of the sweep, i.e. the prior's crossover exactly,
 *                and it is 141/141 with no exceptions.
 *   backbeat     whole to 165, halved from 166. Monotone: no island of
 *                correctness inside the halved side, and no halved tempo inside
 *                the whole side. 164 -> 164.4, 165 -> 165.5, 166 -> 83.0,
 *                167 -> 83.6.
 *
 * So 170 BPM drum'n'bass reads 85, and that is the documented limit rather than a
 * surprise. THE MEASUREMENT DISCIPLINE IS PART OF THE CEILING: an earlier version
 * of this note put the boundary at "about 155" from a 5 BPM sweep, and a 5 BPM
 * grid cannot locate a boundary at all — the broadband build it described had its
 * boundary at 148 with 150 sitting correct between a halved 149 and a halved 151,
 * and the grid landed on exactly the tempi that hid it. Re-measure at 1 BPM or do
 * not quote a number.
 *
 * WHAT IS NOT WRONG WITH IT ANY MORE: the boundary used to be BISTABLE. A 60 s
 * fixture at 148 BPM changed its reported tempo 15 times across 62 estimates on
 * unchanging audio. It is now 0 changes in 98 estimates at 148, and 0 at 165
 * where the boundary actually sits. An oscillating readout is worse than a wrong
 * one, because a wrong one can at least be documented.
 *
 * UPGRADE PATH: the bands are split but their onset envelopes are still SUMMED
 * into one autocorrelation. Correlating the three separately and combining the
 * per-band tempo evidence would let a kick pattern and a snare pattern vote for
 * different periods and be reconciled, which is what would move the backbeat
 * boundary past 170. That is a bigger change than this one and it is not worth it
 * for a display-only label.
 */

import { readStemWindow } from './keytap.js';

/**
 * `drums` is stem index 0, so it is planes 0 and 1 — `stemIdx * 2 + ch`.
 * shared/stemring.js PLANES is the authority.
 *
 * THESE TWO NUMBERS ARE DERIVED FROM `STEMS.indexOf('drums') === 0` AND FROM
 * NOTHING ELSE. `tap-point-is-the-drums-stem` in the self-check is the tripwire —
 * it reads `STEMS` and `PLANES` and fails if either stops agreeing with these
 * literals. Do not "fix" that assertion by editing the expected numbers: a
 * reorder would retune the tempo detector to some other instrument group, and it
 * would still lock onto SOMETHING, so nothing downstream could tell.
 */
export const BPM_TAP_PLANE_L = 0;
export const BPM_TAP_PLANE_R = 1;

/**
 * Onset envelope hop, frames. 441 = exactly 1/100 s at 44 100, so the envelope
 * rate is an integer 100 Hz and `lag -> BPM` is `6000 / lag` with no rounding
 * anywhere. 10 ms also happens to be about the resolution a drum transient has
 * once it is through a broadband energy detector, so a shorter hop would buy
 * arithmetic and no information.
 */
export const BPM_ENV_HOP = 441;
export const BPM_ENV_RATE = 44100 / BPM_ENV_HOP;   // 100 Hz, integer by construction

/**
 * Frames consumed per accepted block — 4410 = 0.1 s = exactly 10 envelope hops,
 * so blocks tile the envelope with no gap and no overlap. This is the cursor's
 * advance AND the read length; keytap's are different because it reads a 16384
 * window behind a 4410 advance, and here overlapping reads would double-count
 * onsets.
 */
export const BPM_BLOCK_FRAMES = 4410;
/** Blocks per `tick()`. 4 x 0.1 s is 4x real time — enough to absorb a hop. */
export const BPM_MAX_BLOCKS_PER_TICK = 4;
/**
 * If the cursor is further behind the producer than this, give up on the gap,
 * jump to the newest audio and break continuity. Same 8 s as keytap and for the
 * same reason: one hop at the largest offered hop (3.9 s) is 172 000 frames and
 * must NOT trip it — walking through a hop is the cursor's job.
 */
export const BPM_CATCHUP_FRAMES = 8 * 44100;

/**
 * Analysis window, seconds of CONTIGUOUS envelope. 8 s at 100 Hz = 800 samples.
 *
 * The floor is set by the comb: the longest lag it evaluates is 3 x 100 = 300
 * samples (3 s), and an unbiased autocorrelation at lag 300 over 800 samples
 * still has 499 overlapping products. Halving the window to 4 s would leave 100,
 * and the estimate at the slow end of the range would be noise. The ceiling is
 * that a tempo change takes a whole window to be believed.
 */
export const BPM_WINDOW_SEC = 8;
export const BPM_ENV_HISTORY = BPM_WINDOW_SEC * BPM_ENV_RATE;   // 800

/** The DJ range. Lags 30..100 envelope samples. Nothing outside is a candidate. */
export const BPM_MIN = 60;
export const BPM_MAX = 200;

/**
 * Periodicity below this is "I do not know". It is the normalised autocorrelation
 * at the winning lag, so the scale is fixed and interpretable: 1.0 is a perfectly
 * periodic envelope, 0.0 is none at that lag.
 *
 * MEASURED, not chosen, and RE-measured after the three-band change moved every
 * number: white noise peaks at 0.1482 over 18 runs (6 seeds x 3 levels, mean
 * 0.0729), the weakest of 141 click tempi reads 0.5901 and the weakest of 29
 * grooves reads 0.4914. 0.25 sits 1.7x above the worst noise and 2.0x below the
 * weakest real signal. Band normalisation lifted the noise floor — it scales a
 * band up regardless of what is in it — so the margin is tighter than it was at
 * 4.7x and is still the most balanced point available. Both sides are asserted.
 */
export const BPM_MIN_CONFIDENCE = 0.25;

/** A block with no sample above this never happened, as far as `state` cares. */
export const BPM_SILENCE_FLOOR = 1e-5;

/**
 * Log-normal tempo prior, sigma in octaves. See "THE OCTAVE TIE" above.
 *
 * 0.9 measured, and RE-measured on the three-band front end, which made this
 * constant much less load-bearing than it was. The bare-pulse crossover lands on
 * the theoretical 170 for every sigma from 0.7 to 1.0 and slips to 171 at 1.1+.
 * What still moves is the backbeat boundary: 167 at 0.7, 166 at 0.8-0.9, 165 at
 * 1.0, 164 at 1.1, 159 at Ellis 2007's 1.4. Higher is worse and lower buys
 * almost nothing, so 0.9 is the flat part of that curve.
 */
export const BPM_PRIOR_CENTER = 120;
export const BPM_PRIOR_SIGMA_OCT = 0.9;

/**
 * Candidate lag grid, in envelope samples. NOT 1: at the fast end one whole
 * sample is 6.5 BPM, and a candidate grid that cannot land near the true lag
 * loses to the half exactly the way a split ACF peak does — the click sweep is
 * 132/141 at step 1 and 141/141 at 0.5 and 0.25. 0.25 costs 281 candidates.
 */
export const BPM_LAG_STEP = 0.25;

/** Comb weights for r(L), r(2L), r(3L). */
const COMB_W = [1, 0.5, 0.25];
/**
 * How many beats the phase pulse train spans. NOT more.
 *
 * A train of J periods laid against an envelope whose true period differs from
 * the estimate by delta accumulates `(J-1) * delta` across its length, and the
 * best-scoring offset is the one that CENTRES that error — so the newest beat,
 * which is what `beatFrame` reports, is displaced by about `(J-1) * delta / 2`.
 * More beats is more averaging of the ONSET positions and more leverage for the
 * TEMPO error, and past a handful the second term wins.
 *
 * Swept over 55 click tempi, worst absolute `beatFrame` error against the true
 * click positions: J = 16 -> 40.0 ms (10 tempi outside the 15 ms gate),
 * J = 8 -> 30 ms (2 outside), J = 4 -> 10.0 ms (none), J = 2 -> 7.3 ms (none).
 * 4 rather than 2 because 2 beats is a single interval with no averaging left,
 * and the difference between them is 2.7 ms against a 16.7 ms paint interval.
 */
const PHASE_BEATS = 4;

/**
 * Onset-envelope band edges, Hz, and the floor on per-band normalisation.
 *
 * THIS IS THE OCTAVE FIX, not a refinement of it — see "THE OCTAVE TIE" above.
 * Three one-pole-squared crossovers give sub / body / air; each band's onset
 * envelope is scaled to unit RMS over the analysis window before the three are
 * summed. Equalising them is the whole point: it makes a kick and a snare the
 * same size, which is what turns a backbeat from two-beat-periodic into
 * one-beat-periodic.
 *
 * THERE IS NO FLOOR ON THE NORMALISATION, and one was tried. `BAND_FLOOR = 0.1`
 * sat here to stop a nearly-silent band being amplified to parity with a loud
 * one — and no fixture could be built where it changed a verdict. A kick is
 * broadband enough that its own transient puts real energy in all three bands:
 * kick-only four-to-the-floor spans 33x across the bands and the floor fires but
 * moves only the confidence (0.9779 -> 0.9727, same tempo); a kick/snare groove
 * with no cymbals and an added hiss bed — the adversarial case the floor was
 * written for — spans 4x and never reaches it at all. Deleting it changed nothing
 * anywhere, so it is deleted: an unexercised guard is one whose ability to fire is
 * an assumption.
 *
 * The `scale > 0` test that replaces it is arithmetic rather than a guard: an
 * empty band has an all-zero envelope, so contributing it at gain 0 is exactly
 * what contributing it at any gain would do — and it removes the Infinity x 0 = NaN
 * that dividing by a zero scale would otherwise produce.
 */
const BAND_LO_HZ = 150;
const BAND_HI_HZ = 3000;
const NBANDS = 3;

/**
 * OCTAVE HYSTERESIS. How much better a half/double candidate must score than the
 * one already being reported before the readout is allowed to jump an octave.
 *
 * ADDED ON MEASUREMENT, NOT ON PRINCIPLE, and only after the three-band fix had
 * done what it could. A broadband envelope put the halving boundary at ~148 BPM
 * — hard-techno tempo — and made it BISTABLE: a 60 s fixture at 148 changed its
 * reported tempo 15 times across 62 estimates on unchanging audio. Three bands
 * moved the boundary to ~166 and made 148 solid (0 flips in 98 estimates), but
 * did not remove the flicker at the boundary itself: 165 BPM still flipped 34
 * times in 98 estimates, because there the two candidates genuinely score within
 * a percent of each other and noise picks the winner.
 *
 * A boundary you can document is acceptable; one that oscillates on stationary
 * audio is not, because it is indistinguishable from a broken feature. This is
 * the ONLY place the estimate depends on its own history, and it is deliberately
 * scoped to the octave decision — fine tempo tracking is untouched, so a real
 * accelerando still follows.
 *
 * 0.90 measured: the flip count at 165 BPM over 98 estimates is 34 at 1.00 (no
 * hysteresis) and 0 at 0.97, 0.95, 0.90 and 0.85 alike — the knee is between
 * 1.00 and 0.97, so any hysteresis at all settles this fixture. 0.90 is chosen
 * to sit well clear of that knee rather than on it, and the same sweep confirms
 * it costs nothing elsewhere (140 BPM clicks and the 92 BPM groove read
 * identically at every value tried).
 *
 * ponytail: it is FIRST-ANSWER-WINS at the boundary — a fixture that opens on a
 * passage scoring for 83 keeps 83 even once the full groove would score for 166.
 * CEILING: a track that genuinely double-times mid-song holds the old octave
 * until the new one beats it by 10 %. UPGRADE PATH: `reset()` already exists for
 * every real discontinuity, so the honest fix is for the deck to call it on a
 * section change it can detect, not for this constant to get looser.
 */
const OCTAVE_HOLD = 0.90;
/** A lag ratio outside this band is an octave-scale jump rather than tracking. */
const OCTAVE_JUMP_LO = 0.65;
const OCTAVE_JUMP_HI = 1.6;

const LAG_MIN = Math.round(60 * BPM_ENV_RATE / BPM_MAX);            // 30
const LAG_MAX = Math.round(60 * BPM_ENV_RATE / BPM_MIN);            // 100
/** The comb reads 3L and one bin either side of it. */
const LAG_ACF_MAX = 3 * LAG_MAX + 1;                                // 301
/** 281 candidates at BPM_LAG_STEP = 0.25. */
const N_CAND = Math.round((LAG_MAX - LAG_MIN) / BPM_LAG_STEP) + 1;

export class BpmTap {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate] must be a multiple of BPM_ENV_RATE (100 Hz)
   * @param {number} [o.maxPerTick] blocks consumed per tick
   * @param {number} [o.accumHz] rate `tick()` is called at, for pacing the estimator
   * @param {number} [o.estimateHz] how often the autocorrelation actually runs
   *
   * There are deliberately no knobs for the hop, the block or the history. They
   * are not free parameters — the hop IS the envelope rate, the block is ten
   * hops, and the history is sized against the longest comb lag. Every one of
   * them used to be settable and every one of them broke the module silently
   * when set (`{envHop: 220}` produced a permanent `listening`). No config for a
   * value that never changes, per CONTRIBUTING.md.
   */
  constructor(o = {}) {
    // sampleRate is HONOURED, not decorative. It used to be stored and never
    // read, so a caller passing 48000 got a 44 100 Hz grid and no complaint —
    // and the offscreen integration passes a rate. The envelope rate is the
    // invariant; the hop is derived from it.
    this.sr = o.sampleRate || 44100;
    if (!Number.isFinite(this.sr) || this.sr % BPM_ENV_RATE !== 0) {
      throw new Error(`bpmtap: sampleRate ${this.sr} is not a multiple of the ${BPM_ENV_RATE} Hz envelope rate`);
    }
    this.hop = this.sr / BPM_ENV_RATE;                    // 441 at 44 100
    this.advance = this.hop * (BPM_BLOCK_FRAMES / BPM_ENV_HOP);   // ten hops
    this.maxPerTick = o.maxPerTick || BPM_MAX_BLOCKS_PER_TICK;
    this.history = BPM_ENV_HISTORY;
    this.minConfidence = BPM_MIN_CONFIDENCE;
    /** accepted blocks between re-estimates. 10 Hz in, 2 Hz out. */
    this.every = Math.max(1, Math.round((o.accumHz || 10) / (o.estimateHz || 2)));

    // scratch, allocated once — this runs on the offscreen main thread beside the
    // pump and must not churn.
    this.l = new Float32Array(this.advance);
    this.r = new Float32Array(this.advance);
    /** one onset envelope per band, same ring geometry, same head. */
    this.env = [];
    for (let b = 0; b < NBANDS; b++) this.env.push(new Float32Array(this.history));
    this.lin = new Float64Array(this.history);
    this.acf = new Float64Array(LAG_ACF_MAX + 2);
    this.score = new Float64Array(N_CAND);
    this.bandSS = new Float64Array(NBANDS);
    this.prevM = new Float64Array(NBANDS);
    this.scale = new Float64Array(NBANDS);

    // one-pole coefficients for the two crossovers, applied twice each
    this.aLo = Math.exp(-2 * Math.PI * BAND_LO_HZ / this.sr);
    this.aHi = Math.exp(-2 * Math.PI * BAND_HI_HZ / this.sr);
    this.z = new Float64Array(4);        // lo1, lo2, hi1, hi2

    // The candidate lags and their prior weights are both fixed, so they are a
    // table built once rather than two transcendentals per candidate per estimate.
    this.cand = new Float64Array(N_CAND);
    this.prior = new Float64Array(N_CAND);
    for (let c = 0; c < N_CAND; c++) {
      const L = LAG_MIN + c * BPM_LAG_STEP;
      const oct = Math.log2((60 * BPM_ENV_RATE / L) / BPM_PRIOR_CENTER) / BPM_PRIOR_SIGMA_OCT;
      this.cand[c] = L;
      this.prior[c] = Math.exp(-0.5 * oct * oct);
    }

    this.reset();
  }

  /**
   * TRACK CHANGE, SEEK, DECK LOAD, LIVE RESTART — docs/ARCHITECTURE.md §3.9's
   * discontinuity hook. Everything goes. Holding the previous track's BPM over a
   * new one is the same defect keytap's reset() exists to prevent, one label over.
   */
  reset() {
    /** absolute frame the next block STARTS at. null until the first tick. */
    this.cursor = null;
    this.blocks = 0;          // read ok
    this.audibleBlocks = 0;   // read ok AND carried energy
    this.silentBlocks = 0;    // read ok, digitally silent
    this.earlyBlocks = 0;     // before frame 0 or past the write pointer
    this.staleBlocks = 0;     // THE producer lapped us. Should never be non-zero.
    this.jumps = 0;           // cursor gave up on a gap and jumped forward
    this.envBreaks = 0;       // times the contiguous envelope was thrown away
    this.estimates = 0;
    this.nonFinite = 0;       // values that were not a number. Must stay 0.
    this.lastTickBlocks = 0;
    this.sinceEstimate = 0;
    this.result = null;       // { bpm, confidence, beatFrame, lag }
    this._breakContinuity(true);
  }

  /**
   * Throw the envelope away. Called on every refusal, every catch-up jump and
   * every reset — see "THE ENVELOPE MUST BE CONTIGUOUS" in the header.
   * @param {boolean} [quiet] true only from reset(), which is not a break.
   */
  _breakContinuity(quiet) {
    this.head = 0;
    this.filled = 0;
    this.hasPrev = false;
    this.z.fill(0);            // the crossover filters are streaming state too
    this.envEndFrame = 0;
    this.result = null;
    this._counted = null;
    this.lockLag = 0;          // octave hysteresis incumbent; 0 = no incumbent
    if (!quiet) this.envBreaks++;
  }

  /** Seconds of CONTIGUOUS envelope currently held. Not wall time, not total. */
  get elapsedSec() { return this.filled / BPM_ENV_RATE; }

  /**
   * Advance the tap against a stem ring. Call at ~10 Hz; it paces itself off the
   * cursor, so calling it more or less often changes latency, not weighting.
   *
   * @param {{planes:Float32Array[], cap:number, mask:number, writeFrames:()=>number}} ring
   * @returns {number} blocks accepted this tick
   */
  tick(ring) {
    if (!ring) return 0;
    const w = ring.writeFrames();
    if (this.cursor === null) this.cursor = Math.max(0, w);
    // THE CATCH-UP IS TWO-SIDED, and it used to be one.
    //
    // Falling BEHIND is the ordinary case: the deck was starved or suspended and
    // the gap is bigger than any hop, so analysing through it would spend seconds
    // reporting the key of audio nobody is near.
    //
    // Being AHEAD is the one that was missing, and it is worse. The cursor can
    // only get in front of the write pointer if the PRODUCER restarted — a new
    // session, a re-armed deck, a fresh stem ring whose `writeFrames` begins at 0
    // again. The consume loop is guarded by `cursor + n <= w`, so from then on it
    // never executes: no blocks, no reads, no refusals, no counters moving, and a
    // `stats()` that looks perfectly healthy while the tap is permanently deaf.
    // That is the exact shape this module exists to refuse — a failure with clean
    // diagnostics. It was found by an integration assertion in `test.js` catching
    // a cursor of 1 117 935 against a write pointer that had restarted near zero.
    if (this.cursor > w) { this.cursor = Math.max(0, w); this.jumps++; this._breakContinuity(); }
    else if (w - this.cursor > BPM_CATCHUP_FRAMES) { this.cursor = w; this.jumps++; this._breakContinuity(); }

    let taken = 0, accepted = 0;
    const n = this.advance;
    while (taken < this.maxPerTick && this.cursor + n <= w) {
      const from = this.cursor;
      this.cursor += n;
      taken++;
      const a = readStemWindow(ring, BPM_TAP_PLANE_L, from, n, this.l);
      if (a !== 'ok') { if (a === 'stale') this.staleBlocks++; else this.earlyBlocks++; this._breakContinuity(); continue; }
      const b = readStemWindow(ring, BPM_TAP_PLANE_R, from, n, this.r);
      if (b !== 'ok') { if (b === 'stale') this.staleBlocks++; else this.earlyBlocks++; this._breakContinuity(); continue; }
      this._envelope(from);
      this.blocks++; accepted++;
    }
    this.lastTickBlocks = taken;
    this.sinceEstimate += accepted;
    // `-= every`, NOT `= 0`. Zeroing DISCARDS the remainder, so with 4 blocks a
    // tick and an interval of 5 the estimator fired every 9th block rather than
    // every 5th — a measured 1.15 Hz against the 2 Hz this file documents. The
    // cadence is now exactly `blocks / every` and `estimate-cadence-is-one-per-
    // every-accepted-blocks` asserts that arithmetic rather than trusting it.
    if (this.sinceEstimate >= this.every) { this.sinceEstimate -= this.every; this._estimate(); }
    return accepted;
  }

  /**
   * One block -> `advance / hop` envelope samples PER BAND. Three-band split,
   * RMS per hop per band, half-wave-rectified first difference. NO log
   * compression — see item 1 of "TWO THINGS THAT LOOK LIKE DETAIL" in the
   * header.
   *
   * The HWR is the whole onset detector. `max(0, m[k] - m[k-1])` keeps energy
   * RISES and discards falls, which is what makes a decaying cymbal one event
   * instead of forty.
   *
   * ENERGY IS SUMMED PER CHANNEL, NOT FROM A MONO SUM. `(L^2 + R^2) / 2` rather
   * than `((L + R) / 2)^2`: a polarity-inverted stereo drums stem cancels to
   * digital silence under a mono sum, and this tap would then report `none`
   * forever on fully audible drums. The chroma tap can mono-sum because it wants
   * one spectrum; an energy envelope has no reason to and one reason not to.
   */
  _envelope(from) {
    const n = this.advance, hop = this.hop, l = this.l, r = this.r;
    const aLo = this.aLo, aHi = this.aHi, z = this.z, ss = this.bandSS;
    let peak = 0;
    for (let h = 0; h < n; h += hop) {
      ss[0] = 0; ss[1] = 0; ss[2] = 0;
      for (let i = h; i < h + hop; i++) {
        const li = l[i], ri = r[i];
        const al = li < 0 ? -li : li, ar = ri < 0 ? -ri : ri;
        if (al > peak) peak = al;
        if (ar > peak) peak = ar;
        const v = (li * li + ri * ri) * 0.5;      // per-channel power, polarity-proof
        const x = Math.sqrt(v);
        // two cascaded one-poles per crossover: 12 dB/oct, enough to make a
        // 55 Hz kick a low-band event and a hi-hat a high-band one.
        z[0] += (1 - aLo) * (x - z[0]);
        z[1] += (1 - aLo) * (z[0] - z[1]);
        z[2] += (1 - aHi) * (x - z[2]);
        z[3] += (1 - aHi) * (z[2] - z[3]);
        const lo = z[1], mid = z[3] - z[1], hi = x - z[3];
        ss[0] += lo * lo; ss[1] += mid * mid; ss[2] += hi * hi;
      }
      for (let b = 0; b < NBANDS; b++) {
        const m = Math.sqrt(ss[b] / hop);
        this.env[b][this.head] = this.hasPrev ? Math.max(0, m - this.prevM[b]) : 0;
        this.prevM[b] = m;
      }
      this.hasPrev = true;
      this.head = (this.head + 1) % this.history;
      if (this.filled < this.history) this.filled++;
      this.envEndFrame = from + h + hop;
    }
    if (peak < BPM_SILENCE_FLOOR) this.silentBlocks++; else this.audibleBlocks++;
  }

  /**
   * Autocorrelation -> comb -> prior -> fractional-lag argmax -> pulse-train phase.
   *
   * Sets `this.result` to null on every path where it could not look: a partial
   * history, or an envelope with no variance at all (digital silence, or a
   * perfectly steady drone with no onsets). It never falls back to the previous
   * answer — that would be a number the current audio does not support.
   */
  _estimate() {
    this.estimates++;
    this.result = null;
    const N = this.filled;
    if (N < this.history) return;

    // PER-BAND NORMALISATION, then sum. This is the octave fix and it is three
    // lines: scale every band's onset envelope to unit RMS over the window before
    // adding them, so a kick and a snare arrive the same size and a backbeat
    // stops being twice as periodic as it is.
    let maxScale = 0;
    for (let b = 0; b < NBANDS; b++) {
      const e = this.env[b];
      let s = 0;
      for (let k = 0; k < N; k++) { const v = e[(this.head + k) % this.history]; s += v * v; }
      this.scale[b] = Math.sqrt(s / N);
      if (this.scale[b] > maxScale) maxScale = this.scale[b];
    }
    // Normalisation divides by the band's own level, so this guard is what stops
    // an empty band's residue being amplified to unit RMS. `> 0` is enough and
    // that is measured, not assumed: after 12 s of digital silence all three band
    // scales are exactly 0.000e+0, because the HWR clamps the decaying crossover
    // tails to zero rather than leaving a denormal behind. An absolute floor was
    // tried here first and is NOT kept — it never fires, and a guard whose
    // ability to fire is an assumption is the thing this repo keeps paying for.
    if (!(maxScale > 0)) return;
    const x = this.lin;
    x.fill(0, 0, N);
    for (let b = 0; b < NBANDS; b++) {
      const g = this.scale[b] > 0 ? 1 / this.scale[b] : 0;
      const e = this.env[b];
      for (let k = 0; k < N; k++) x[k] += g * e[(this.head + k) % this.history];
    }
    let mean = 0;
    for (let k = 0; k < N; k++) mean += x[k];
    mean /= N;
    let v0 = 0;
    for (let k = 0; k < N; k++) { x[k] -= mean; v0 += x[k] * x[k]; }
    v0 /= N;
    if (!(v0 > 1e-12)) return;      // no onsets at all: nothing to correlate

    // unbiased autocorrelation, normalised so r(0) = 1
    const acf = this.acf;
    for (let L = LAG_MIN - 1; L <= LAG_ACF_MAX; L++) {
      let s = 0;
      const end = N - L;
      for (let k = 0; k < end; k++) s += x[k] * x[k + L];
      acf[L] = (s / end) / v0;
    }
    // Three bins SUMMED, not sampled and not averaged — header item 2. An impulsive
    // envelope has a one-bin peak, and a period that is not a whole number of bins
    // splits it; summing the neighbours conserves it, so a candidate and its
    // double are compared on the same footing.
    const at = (t) => {
      const i = Math.round(t);
      return (i >= 1 ? acf[i - 1] : 0) + (i <= LAG_ACF_MAX ? acf[i] : 0)
        + (i + 1 <= LAG_ACF_MAX ? acf[i + 1] : 0);
    };

    // comb x prior over the DJ range, on the fractional candidate grid
    const cand = this.cand, prior = this.prior, sc = this.score;
    let bestC = -1, bestS = -Infinity;
    for (let c = 0; c < cand.length; c++) {
      const L = cand[c];
      let s = 0;
      for (let m = 0; m < COMB_W.length; m++) s += COMB_W[m] * at((m + 1) * L);
      s *= prior[c];
      sc[c] = s;
      if (s > bestS) { bestS = s; bestC = c; }
    }
    if (bestC < 0) return;

    // Octave hysteresis — see OCTAVE_HOLD. Only an octave-SCALE jump is held; a
    // candidate within tracking distance of the incumbent is taken immediately.
    if (this.lockLag > 0) {
      const ratio = cand[bestC] / this.lockLag;
      if (ratio < OCTAVE_JUMP_LO || ratio > OCTAVE_JUMP_HI) {
        const pc = Math.min(N_CAND - 1, Math.max(0,
          Math.round((this.lockLag - LAG_MIN) / BPM_LAG_STEP)));
        if (sc[pc] >= OCTAVE_HOLD * bestS) { bestC = pc; bestS = sc[pc]; }
      }
    }

    const lag = cand[bestC];
    this.lockLag = lag;
    const bpm = 60 * BPM_ENV_RATE / lag;
    // Confidence is the PLAIN autocorrelation at the winning lag, peak-picked over
    // the same +-1 bin, so it stays on the 0..1 periodicity scale the gate is set
    // against rather than on the comb's 0..1.75 one.
    // `|| 0` is NOT used here: it launders NaN into 0, which is precisely the
    // swallowing `payload()`'s comment promises not to do. Out-of-range indices
    // are impossible by construction (LAG_MIN-1 <= i0-1, i0+1 <= LAG_ACF_MAX) and
    // are asserted rather than defended against.
    const i0 = Math.round(lag);
    const confidence = Math.max(0, Math.min(1,
      Math.max(acf[i0 - 1], acf[i0], acf[i0 + 1])));

    // phase: slide a pulse train of period `lag` back from the newest envelope
    // sample and take the offset with the most onset energy under it.
    const beats = Math.max(1, Math.min(PHASE_BEATS, Math.floor((N - 1) / lag)));
    const span = Math.max(1, Math.round(lag));
    let bestPhi = 0, bestP = -Infinity;
    for (let phi = 0; phi < span; phi++) {
      let s = 0, used = 0;
      for (let j = 0; j < beats; j++) {
        const idx = N - 1 - phi - Math.round(j * lag);
        if (idx < 0) break;
        s += x[idx]; used++;
      }
      if (used === beats && s > bestP) { bestP = s; bestPhi = phi; }
    }
    // Envelope sample k covers [envEndFrame - (filled-k)*hop, ... + hop), and the
    // onset is flagged in the sample the transient STARTS in, so the beat is that
    // sample's first frame.
    //
    // THE ERROR BOUND, corrected. This comment used to claim "one hop, biased
    // early", which is only the QUANTISATION term; the pulse train contributes a
    // second, larger term that is signed either way (see PHASE_BEATS). Measured
    // over 55 click tempi at PHASE_BEATS = 4, the worst absolute displacement
    // from a true click is 10.0 ms and it is not one-sided. The gate below is
    // 15 ms, and the display paints at 60 Hz = 16.7 ms.
    const beatFrame = this.envEndFrame - (bestPhi + 1) * this.hop;

    // `windowEnd` is the analysis window's last frame AT THE MOMENT OF THIS
    // ESTIMATE. It is not on the wire; it exists because `beatFrame` is only
    // interpretable against the window it was derived from, and `envEndFrame`
    // keeps advancing with every block consumed afterwards.
    this.result = { bpm, confidence, beatFrame, lag, windowEnd: this.envEndFrame };
  }

  /**
   * THE WIRE CONTRACT, and this is the only place it is built.
   *
   *   { state: 'listening' | 'locked' | 'none',
   *     bpm: number | null,
   *     confidence: number,
   *     beatFrame: number | null }
   *
   * `beatFrame` is an ABSOLUTE stem-ring frame — the most recent beat at or
   * before the end of the analysis window. Everything else a UI wants (the next
   * beat, the phase right now, a blinking dot) is `beatFrame + k * 60/bpm * sr`,
   * and `beatPhaseAt()` below is the ONE call site that does the modulo. Adding a
   * `phase` field here would be the second one, and AGENTS.md's entry-point rule
   * exists because this repo has had five defects from a value being right at one
   * call site and wrong at another.
   */
  payload() {
    // NOTHING ON THE WIRE MAY BE NaN (qa/live-wire.mjs asserts it across every
    // engine -> UI message). Non-finite is not reachable from `_estimate` — every
    // input is a ratio of finite sums and the divisors are guarded — so it is
    // COUNTED rather than swallowed: `stats().nonFinite` above zero means
    // something upstream broke, and a wire value of 0 would otherwise be
    // indistinguishable from an honest weak match.
    //
    // COUNTED ONCE PER RESULT, not once per call. `payload()` is a getter as far
    // as every caller is concerned and the console polls it; incrementing on each
    // call made the counter a function of the poll rate and made the method
    // non-idempotent. The result object identity is the key.
    const res = this.result;
    const finite = res && Number.isFinite(res.confidence) && Number.isFinite(res.bpm)
      && Number.isFinite(res.beatFrame);
    if (res && !finite && this._counted !== res) { this.nonFinite++; this._counted = res; }
    const conf = res && Number.isFinite(res.confidence) ? +res.confidence.toFixed(4) : 0;

    if (this.audibleBlocks === 0) return { state: 'none', bpm: null, confidence: 0, beatFrame: null };
    if (!finite || res.confidence < this.minConfidence) {
      return { state: 'listening', bpm: null, confidence: conf, beatFrame: null };
    }
    return {
      state: 'locked',
      bpm: +res.bpm.toFixed(2),
      confidence: conf,
      beatFrame: res.beatFrame,
    };
  }

  /**
   * Diagnostics. NOT on the UI contract — this is the harness surface, and it
   * exists because `payload()` alone cannot tell "the tap looked and is not sure"
   * from "the tap has never once managed to read a block".
   */
  stats() {
    return {
      blocks: this.blocks,
      audibleBlocks: this.audibleBlocks,
      silentBlocks: this.silentBlocks,
      earlyBlocks: this.earlyBlocks,
      staleBlocks: this.staleBlocks,
      jumps: this.jumps,
      envBreaks: this.envBreaks,
      estimates: this.estimates,
      nonFinite: this.nonFinite,
      filled: this.filled,
      history: this.history,
      elapsedSec: +this.elapsedSec.toFixed(2),
      cursor: this.cursor,
      lag: this.result ? +this.result.lag.toFixed(3) : null,
      minConfidence: this.minConfidence,
    };
  }
}

/**
 * Beat phase at an arbitrary absolute frame, 0 = on the beat, 0.5 = exactly
 * between two. The ONE place the beat modulo happens (see `payload()`).
 *
 * Returns null — not 0 — when there is no lock. 0 is a legal phase and would
 * paint as a beat landing every frame.
 *
 * @param {{state:string,bpm:number|null,beatFrame:number|null}} p a payload()
 * @param {number} frame absolute stem-ring frame
 * @param {number} [sampleRate]
 * @returns {number|null} 0..1
 */
export function beatPhaseAt(p, frame, sampleRate = 44100) {
  if (!p || p.state !== 'locked' || p.bpm == null || p.beatFrame == null) return null;
  const period = (60 / p.bpm) * sampleRate;
  if (!(period > 0) || !Number.isFinite(frame)) return null;
  const q = ((frame - p.beatFrame) / period) % 1;
  return q < 0 ? q + 1 : q;
}

// ===================================================================== self-check
//
// `node extension/engine/bpmtap.js`. Everything below this line is the runnable
// check and is NOT part of the module's surface.

const _argv1 = (typeof process !== 'undefined' && process.argv && process.argv[1]) || '';
if (_argv1.endsWith('bpmtap.js') && import.meta.url.endsWith('/bpmtap.js')) selfCheck();

async function selfCheck() {
  const { StemRingWriter, PLANES } = await import('../shared/stemring.js');
  const { RING_PLANES, STEMS } = await import('../shared/config.js');

  const FS = 44100;
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // ---- synthesis. A drum kit, not a click generator: the three voices have
  // different decays and different bandwidths, because a single repeated impulse
  // is unrealistically easy and never exercises the octave logic at all.
  function kick(buf, at, amp) {
    const n = Math.round(0.12 * FS);
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.045);
    }
  }
  function snare(buf, at, amp, rnd) {
    const n = Math.round(0.09 * FS);
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      const v = ((rnd() * 2 - 1) * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.5) * Math.exp(-t / 0.030);
      if (j >= 0 && j < buf.length) buf[j] += amp * v;
    }
  }
  function hat(buf, at, amp, rnd) {
    const n = Math.round(0.025 * FS);
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * (rnd() * 2 - 1) * Math.exp(-t / 0.008);
    }
  }
  const normalise = (buf) => {
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
    if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / peak;
    return buf;
  };
  /** Bare kick on every beat — the pure octave-ambiguity stimulus. */
  function clickTrain(bpm, sec, from = 0) {
    const buf = new Float32Array(Math.round(sec * FS));
    const beat = 60 / bpm * FS;
    for (let b = 0; from + b * beat < buf.length; b++) kick(buf, Math.round(from + b * beat), 1.0);
    return normalise(buf);
  }
  /** Kick 1 3, snare 2 4, hats on the eighths — the octave trap with a beat in it. */
  function groove(bpm, sec, seed) {
    const rnd = mulberry32(seed);
    const buf = new Float32Array(Math.round(sec * FS));
    const beat = 60 / bpm * FS;
    for (let b = 0; b * beat < buf.length; b++) {
      const at = Math.round(b * beat);
      if (b % 2 === 0) kick(buf, at, 1.0); else snare(buf, at, 0.55, rnd);
      hat(buf, at, 0.18, rnd);
      hat(buf, Math.round(at + beat / 2), 0.18, rnd);
    }
    return normalise(buf);
  }

  function makeRing(cap = 1 << 19) {
    const sab = new ArrayBuffer(128 + cap * 4 * RING_PLANES);
    return new StemRingWriter(sab, cap);
  }
  /** Publish `len` frames of `pcm` on the `drums` planes, everything else silent. */
  function publish(ring, pcm, from, len, planes) {
    for (let q = 0; q < RING_PLANES; q++) planes[q].fill(0, 0, len);
    for (let i = 0; i < len; i++) {
      const v = from + i < pcm.length ? pcm[from + i] : 0;
      planes[BPM_TAP_PLANE_L][i] = v;
      planes[BPM_TAP_PLANE_R][i] = v;
    }
    return ring.write(from, planes, len);
  }
  const HOP = Math.round(1.95 * FS);   // 85995 frames = 195 envelope hops, exactly
  /**
   * Drive the tap exactly as the deck does: one hop published at a time, then
   * 20 ticks at 10 Hz across the 1.95 s the deck spends computing the next one.
   */
  function drive(pcm, o = {}) {
    const ring = makeRing(o.cap);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(HOP));
    const tap = new BpmTap(o.tap);
    let ticks = 0, maxBlocks = 0, maxEstimates = 0;
    const seen = [];      // the bpm reported after EVERY estimate, for the flicker check
    for (let p = 0; p + HOP <= pcm.length; p += HOP) {
      Atomics.store(ring.hdr, 1, Math.max(0, p - 4 * FS));   // a plausible playhead
      publish(ring, pcm, p, HOP, planes);
      for (let t = 0; t < 20; t++) {
        const e0 = tap.estimates;
        tap.tick(ring);
        ticks++;
        maxBlocks = Math.max(maxBlocks, tap.lastTickBlocks);
        maxEstimates = Math.max(maxEstimates, tap.estimates - e0);
        if (tap.estimates > e0) seen.push(tap.payload().bpm);
      }
    }
    return { tap, k: tap.payload(), s: tap.stats(), ticks, maxBlocks, maxEstimates, ring, seen };
  }
  const win = (pcm) => `window ${(HOP / FS).toFixed(2)}-${(Math.floor(pcm.length / HOP) * HOP / FS).toFixed(2)} s of a ${(pcm.length / FS).toFixed(1)} s fixture, ${BPM_WINDOW_SEC} s analysis history`;
  /** Octave-scale changes in the reported tempo across one run's estimates. */
  const flips = (seen) => {
    const s = seen.filter((v) => v !== null);
    let n = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(s[i] - s[i - 1]) > 0.05 * s[i - 1]) n++;
    return { n, of: s.length };
  };
  /**
   * THE TEMPO TOLERANCE, and it is not a flat number any more.
   *
   * The estimator's resolution is the CANDIDATE GRID, and one grid step is
   * `bpm^2 * BPM_LAG_STEP / (60 * BPM_ENV_RATE)` — 0.19 BPM at 68 and 2.67 at
   * 200, because a fixed lag step is a widening tempo step as the lag shortens.
   * A flat +-1.5 BPM was therefore ~8 grid steps of slack at the slow end and
   * barely half a step at the fast end: too loose to catch anything below 100 BPM
   * and too tight to be meaningful above 180.
   *
   * 2.0 steps: the worst measured error over the tempi asserted here is 0.93
   * steps, so this is 2.15x the observed spread — and it is still tight enough to
   * catch the comb being removed (that puts 160 BPM 3.14 BPM out, which is 2.94
   * steps).
   */
  const gridStep = (bpm) => bpm * bpm * BPM_LAG_STEP / (60 * BPM_ENV_RATE);
  const TOL_STEPS = 2.0;
  const tol = (bpm) => TOL_STEPS * gridStep(bpm);
  const near = (got, want) => got !== null && Math.abs(got - want) <= tol(want);
  const say = (got, want) => `read ${got}, err ${got === null ? 'n/a' : Math.abs(got - want).toFixed(3)} BPM = ${got === null ? 'n/a' : (Math.abs(got - want) / gridStep(want)).toFixed(2)} grid steps, tol ${TOL_STEPS} steps = +-${tol(want).toFixed(2)}`;
  /**
   * The phase gate, and the arithmetic that ties it to the tempo tolerance.
   *
   * `beatFrame` carries two error terms: the envelope quantisation (one hop,
   * 10 ms, one-sided) and the pulse train's leverage on the tempo error,
   * `(PHASE_BEATS-1)/2 * beatPeriod * bpmErr/bpm`, which is signed either way.
   * The gate has to cover both, and `phase-and-tempo-tolerances-are-consistent`
   * below checks that it does at every tempo asserted rather than assuming it.
   */
  const PHASE_GATE_MS = 15;
  const phaseBoundMs = (bpm, bpmErr) => (BPM_ENV_HOP / FS) * 1000
    + ((PHASE_BEATS - 1) / 2) * (60000 / bpm) * (bpmErr / bpm);
  /** |beatFrame - the nearest true click|, ms, for a fixture whose beats start at frame 0. */
  const phaseErrMs = (k, bpm) => {
    if (k.beatFrame === null) return null;
    const P = 60 / bpm * FS;
    const raw = ((k.beatFrame % P) + P) % P;
    return Math.min(raw, P - raw) / FS * 1000;
  };

  console.log('\x1b[1mbpmtap.js self-check\x1b[0m');

  // ==================================================== 1. the tap point
  head('1. the tap point, and the sample-rate grid');
  {
    const drumsIdx = STEMS.indexOf('drums');
    ok('tap-point-is-the-drums-stem: STEMS still puts `drums` at index 0, which is the ONLY thing BPM_TAP_PLANE_L/R are derived from',
      drumsIdx === 0, `STEMS = [${STEMS.join(', ')}], drums at ${drumsIdx}`);
    ok('tap-point-planes-follow-stemIdx*2+ch (a reorder or an inserted stem must land here, not in a plausible wrong tempo)',
      BPM_TAP_PLANE_L === drumsIdx * 2 && BPM_TAP_PLANE_R === drumsIdx * 2 + 1,
      `planes ${BPM_TAP_PLANE_L}/${BPM_TAP_PLANE_R}, stemIdx*2 = ${drumsIdx * 2}`);
    // PLANES is the ring's own hand-written authority, so this is a real second
    // opinion rather than the same expression twice.
    ok('tap-point-names-are-drums.L-and-drums.R in shared/stemring.js PLANES',
      PLANES[BPM_TAP_PLANE_L] === 'drums.L' && PLANES[BPM_TAP_PLANE_R] === 'drums.R',
      `PLANES[${BPM_TAP_PLANE_L}] = ${PLANES[BPM_TAP_PLANE_L]}, PLANES[${BPM_TAP_PLANE_R}] = ${PLANES[BPM_TAP_PLANE_R]}`);
    // AT EVERY ENTRY POINT, not just at the module constants. The grid used to be
    // checked with `BPM_BLOCK_FRAMES % BPM_ENV_HOP` — which is a statement about
    // two literals and says nothing about the instance a caller actually gets.
    // `new BpmTap({sampleRate: 48000})` was silently given the 44 100 grid.
    const a = new BpmTap(), b = new BpmTap({ sampleRate: 48000 });
    ok('the-envelope-grid-divides-the-block-exactly-at-every-sample-rate-the-constructor-accepts',
      a.hop === 441 && a.advance === 4410 && a.advance % a.hop === 0
      && b.hop === 480 && b.advance === 4800 && b.advance % b.hop === 0
      && a.sr / a.hop === BPM_ENV_RATE && b.sr / b.hop === BPM_ENV_RATE,
      `44100 -> hop ${a.hop}, block ${a.advance}, ${a.advance / a.hop} hops; 48000 -> hop ${b.hop}, block ${b.advance}, ${b.advance / b.hop} hops; envelope rate ${BPM_ENV_RATE} Hz both`);
    // The other half of honouring it: a rate the grid cannot carry must be a
    // refusal, not a silently wrong hop.
    let threw = '';
    try { new BpmTap({ sampleRate: 48001 }); } catch (e) { threw = e.message; }
    ok('a-sample-rate-the-envelope-grid-cannot-carry-is-refused-rather-than-quietly-rounded',
      /48001/.test(threw), threw || 'accepted 48001 without complaint');
  }

  // ==================================================== 2. tempo
  head('2. tempo, against a real stem ring');
  {
    const pcm = clickTrain(128, 26);
    const d = drive(pcm);
    console.log(`      128 BPM click train: ${JSON.stringify(d.k)}`);
    console.log(`      ${JSON.stringify(d.s)}`);
    ok('recovers-a-known-click-tempo (the hypothesis)',
      d.k.state === 'locked' && near(d.k.bpm, 128), `true 128.00, ${say(d.k.bpm, 128)}, ${win(pcm)}`);
    ok('the-tap-never-refused-a-block-it-should-have-had (stale is the producer lapping the consumer and must be 0)',
      d.s.staleBlocks === 0 && d.s.earlyBlocks === 0 && d.s.blocks > 100,
      `${d.s.blocks} accepted, ${d.s.earlyBlocks} early, ${d.s.staleBlocks} stale`);
    ok('a-hop-sized-jump-does-not-trip-the-catch-up-or-break-the-envelope (the cursor is supposed to walk through a hop, not skip it)',
      d.s.jumps === 0 && d.s.envBreaks === 0,
      `${d.s.jumps} jumps, ${d.s.envBreaks} envelope breaks over ${(pcm.length / FS).toFixed(0)} s at hop 1.95`);
  }
  {
    // THE CONTROL, AND IT CAN LOSE. A detector that reported a constant, or that
    // locked onto the fixture's hop rate or the tick rate instead of the music,
    // passes the assertion above and fails this one.
    //
    // (There used to be a third assertion here comparing the two answers'
    // DIFFERENCE to 36 BPM. It was deleted rather than fixed: |A-128| <= t and
    // |B-92| <= t together ENTAIL |(A-B)-36| <= 2t, so it could not go red unless
    // one of its predecessors already had, and its stated rationale — that it
    // catches a constant detector — was false, because a constant detector fails
    // this one. An assertion entailed by its neighbours is a third copy of them.)
    const pcm = clickTrain(92, 26);
    const d = drive(pcm);
    ok('recovers-a-different-known-click-tempo (the control)',
      d.k.state === 'locked' && near(d.k.bpm, 92), `true 92.00, ${say(d.k.bpm, 92)}, ${win(pcm)}`);
  }
  {
    // The octave trap with a real beat in it: hats on the eighths put a genuine
    // 184 BPM periodicity in the envelope.
    const pcm = groove(92, 30, 4242);
    const d = drive(pcm);
    console.log(`      92 BPM groove (kick 1 3, snare 2 4, hats on eighths): ${JSON.stringify(d.k)}`);
    ok('a-groove-with-eighth-note-hats-reports-the-quarter-note-pulse-and-not-the-eighths',
      d.k.state === 'locked' && near(d.k.bpm, 92),
      `true 92.00 quarters / 184.00 eighths, ${say(d.k.bpm, 92)}, conf ${d.k.confidence}, ${win(pcm)}`);
  }
  {
    // Half-time. The eighths land at 140, squarely inside the search range and
    // much nearer the prior's centre than 70 is — so the comb has to win this.
    const pcm = groove(70, 34, 77);
    const d = drive(pcm);
    console.log(`      70 BPM half-time groove: ${JSON.stringify(d.k)}`);
    ok('a-half-time-groove-reports-the-half-time-tempo-and-not-its-double',
      d.k.state === 'locked' && near(d.k.bpm, 70),
      `true 70.00 quarters / 140.00 eighths, ${say(d.k.bpm, 70)}, conf ${d.k.confidence}, ${win(pcm)}`);
  }
  {
    // The prior's own control: a bare 68 BPM train, where the prior PREFERS the
    // double and must be overruled by the comb.
    const pcm = clickTrain(68, 34);
    const d = drive(pcm);
    const t = new BpmTap();
    const w68 = t.prior[Math.round((6000 / 68 - 30) / BPM_LAG_STEP)];
    const w136 = t.prior[Math.round((6000 / 136 - 30) / BPM_LAG_STEP)];
    ok('a-bare-slow-click-train-is-not-doubled-even-though-the-tempo-prior-prefers-its-double',
      d.k.state === 'locked' && near(d.k.bpm, 68) && w136 > w68,
      `true 68.00, ${say(d.k.bpm, 68)}; the tap's OWN prior table weights 68 at ${w68.toFixed(3)} < 136 at ${w136.toFixed(3)}, so the comb is what decided, ${win(pcm)}`);
  }
  {
    // THE PRIOR IS LOAD-BEARING — and this assertion exists because the two
    // crossover checks below it did NOT prove that. Deleting the prior entirely
    // (`this.prior[c] = 1`) once left every assertion in this file green, while
    // the header claimed the prior was "the only thing" separating 160 from 80.
    // The old control recomputed the prior FORMULA in the harness and compared
    // two constants, so it survived the mechanism being removed — a second copy
    // of the measurement wearing the word "control".
    //
    // 150 BPM is the discriminator: 149.07 with the prior, 75.47 without. The
    // table is also read off the instance, so a flattened prior fails on the
    // weights before it fails on the behaviour.
    const d = drive(clickTrain(150, 26));
    const t = new BpmTap();
    let lo = Infinity, hi = 0;
    for (let c = 0; c < t.prior.length; c++) { lo = Math.min(lo, t.prior[c]); hi = Math.max(hi, t.prior[c]); }
    ok('the-tempo-prior-is-load-bearing-and-not-a-flat-table',
      d.k.state === 'locked' && near(d.k.bpm, 150) && hi / lo > 1.2,
      `150 BPM bare pulse: ${say(d.k.bpm, 150)} (a flat prior reads 75.47 here); the instance's own prior spans ${lo.toFixed(3)}..${hi.toFixed(3)} = ${(hi / lo).toFixed(2)}x`);
  }
  {
    // THE DOCUMENTED CROSSOVER, both sides of it, on the stimulus that has NO
    // other information in it — a bare pulse, where every multiple of the period
    // is an equally perfect ACF peak and only the prior can choose.
    const xover = Math.sqrt(BPM_PRIOR_CENTER * 2 * BPM_PRIOR_CENTER);
    // 160 is also the worst lag-quantisation case at 100 Hz — period 37.5 bins,
    // dead between two, with its double landing exactly on one. It read 80 until
    // the comb started summing three bins instead of sampling one, and it reads
    // 156.86 if the comb's harmonic terms are removed.
    const lo = drive(clickTrain(160, 26));
    const hi = drive(clickTrain(176, 26));
    ok('a-bare-pulse-below-the-prior-crossover-reports-itself-even-when-its-period-falls-between-envelope-bins',
      lo.k.state === 'locked' && near(lo.k.bpm, 160),
      `true 160.00 (period ${(BPM_ENV_RATE * 60 / 160).toFixed(1)} envelope bins, crossover ${xover.toFixed(2)}), ${say(lo.k.bpm, 160)}, conf ${lo.k.confidence}`);
    ok('a-bare-pulse-above-the-prior-crossover-reports-its-half, which is the documented tie-break and not a defect',
      hi.k.state === 'locked' && near(hi.k.bpm, 88) && 176 > xover && 160 < xover,
      `true 176.00, crossover ${xover.toFixed(2)}, ${say(hi.k.bpm, 88)} against the documented 88.00, conf ${hi.k.confidence}`);
  }
  {
    // THE BACKBEAT BOUNDARY, which is the thing the three-band envelope was built
    // for. A broadband envelope put it at ~148 BPM and made it NON-MONOTONE and
    // BISTABLE — 150 correct between a halved 149 and a halved 151, and a 60 s
    // fixture at 148 changing its answer 15 times on unchanging audio.
    //
    // Asserted as three separate facts because they fail independently: the
    // boundary sits where it is documented, it is a clean step rather than an
    // island, and neither side of it flickers.
    const b164 = drive(groove(164, 30, 7)), b165 = drive(groove(165, 30, 7));
    const b166 = drive(groove(166, 30, 7)), b167 = drive(groove(167, 30, 7));
    ok('the-backbeat-halving-boundary-is-where-the-ponytail-says-it-is',
      near(b165.k.bpm, 165) && near(b166.k.bpm, 83),
      `165 -> ${b165.k.bpm} (whole), 166 -> ${b166.k.bpm} (halved); documented boundary 165|166`);
    ok('the-backbeat-boundary-is-a-clean-step-with-no-island-of-correctness-inside-the-halved-side',
      near(b164.k.bpm, 164) && near(b167.k.bpm, 83.5),
      `164 -> ${b164.k.bpm}, 165 -> ${b165.k.bpm}, 166 -> ${b166.k.bpm}, 167 -> ${b167.k.bpm} — monotone across the step`);
    // 148 is the tempo the broadband build oscillated at, so it is the one that
    // must be quiet now; 165 is the new boundary and is the harder case.
    const f148 = flips(drive(groove(148, 60, 7)).seen);
    const f165 = flips(drive(groove(165, 60, 7)).seen);
    ok('a-stationary-groove-does-not-change-its-reported-octave-mid-run',
      f148.n === 0 && f165.n === 0 && f148.of > 50 && f165.of > 50,
      `148 BPM: ${f148.n} octave changes over ${f148.of} estimates (was 15 of 62 on the broadband build); 165 BPM at the boundary: ${f165.n} over ${f165.of} (was 34 of 98 before the octave hysteresis)`);
  }
  {
    const a = clickTrain(100, 12), b = clickTrain(140, 24);
    const pcm = new Float32Array(a.length + b.length);
    pcm.set(a, 0); pcm.set(b, a.length);
    const d = drive(pcm);
    ok('the-estimate-follows-a-tempo-change-rather-than-holding-the-first-answer',
      d.k.state === 'locked' && near(d.k.bpm, 140),
      `100.00 for 12 s then 140.00 for 24 s, ${say(d.k.bpm, 140)} at the end, ${BPM_WINDOW_SEC} s analysis history`);
  }
  {
    // The comb's STRUCTURE. Its existence is covered behaviourally by the 160 BPM
    // assertion above (removing the harmonic terms puts it 2.94 grid steps out),
    // but the specific weights are not: [1, 1, 1] reads identically to
    // [1, 0.5, 0.25] on every fixture in this file. That negative result is
    // recorded rather than papered over with a contrived fixture — what is
    // asserted is the invariant the design actually rests on, that a higher
    // multiple is weaker evidence than the fundamental.
    ok('comb-weights-decay-so-a-higher-multiple-is-weaker-evidence-than-the-fundamental',
      COMB_W.length === 3 && COMB_W[0] > COMB_W[1] && COMB_W[1] > COMB_W[2] && COMB_W[2] > 0,
      `[${COMB_W.join(', ')}] — note: no fixture here separates these from [1, 1, 1]; the comb's PRESENCE is covered by the 160 BPM check`);
  }

  // ==================================================== 3. refusing rather than guessing
  head('3. refusing rather than guessing');
  {
    const pcm = new Float32Array(26 * FS);   // digital silence
    const d = drive(pcm);
    ok('a-silent-drum-stem-reports-none-not-listening (a tap that can never see anything must not present as one making progress)',
      d.k.state === 'none' && d.k.bpm === null && d.k.beatFrame === null && d.k.confidence === 0
      && d.s.silentBlocks > 100 && d.s.audibleBlocks === 0,
      `${JSON.stringify(d.k)} after ${d.s.silentBlocks} silent blocks, ${d.s.audibleBlocks} audible`);
  }
  {
    // A POLARITY-INVERTED STEREO STEM. The envelope used to be built on the mono
    // sum, so L = -R cancelled to digital silence and this reported `none` for
    // ever on fully audible drums. Energy is per-channel now.
    const pcm = clickTrain(128, 26);
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(HOP));
    const tap = new BpmTap();
    for (let p = 0; p + HOP <= pcm.length; p += HOP) {
      Atomics.store(ring.hdr, 1, Math.max(0, p - 4 * FS));
      for (let q = 0; q < RING_PLANES; q++) planes[q].fill(0, 0, HOP);
      for (let i = 0; i < HOP; i++) {
        const v = p + i < pcm.length ? pcm[p + i] : 0;
        planes[BPM_TAP_PLANE_L][i] = v;
        planes[BPM_TAP_PLANE_R][i] = -v;          // the inversion
      }
      ring.write(p, planes, HOP);
      for (let t = 0; t < 20; t++) tap.tick(ring);
    }
    const k = tap.payload(), s = tap.stats();
    // The reference is the SAME fixture without the inversion. An absolute
    // `silentBlocks === 0` would be wrong here and was: a bare click train is
    // mostly digital silence between hits, so ~124 of 234 blocks are legitimately
    // silent either way. What must not change is how many carry energy.
    const ref = drive(pcm).s;
    ok('a-polarity-inverted-stereo-stem-is-audible-rather-than-cancelling-to-silence',
      k.state === 'locked' && near(k.bpm, 128)
      && s.audibleBlocks === ref.audibleBlocks && s.audibleBlocks > 100,
      `L = -R at 128 BPM: ${say(k.bpm, 128)}, ${s.audibleBlocks} audible blocks against ${ref.audibleBlocks} for the same fixture un-inverted (a mono sum reads 0 audible and reports none for ever)`);
  }
  {
    // White noise. The anti-vacuity clauses are `filled === history` and
    // `estimates > 0`: without them this would pass on a run where the tap never
    // accumulated a window, which is a low confidence for the wrong reason.
    const rnd = mulberry32(9001);
    const pcm = new Float32Array(26 * FS);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (rnd() * 2 - 1) * 0.3;
    const d = drive(pcm);
    ok('white-noise-reports-low-confidence-and-no-tempo, from a FULL analysis window rather than an empty one',
      d.k.state !== 'locked' && d.k.bpm === null && d.k.confidence < BPM_MIN_CONFIDENCE
      && d.s.filled === d.s.history && d.s.estimates > 0 && d.s.audibleBlocks > 100,
      `state ${d.k.state}, confidence ${d.k.confidence} < gate ${BPM_MIN_CONFIDENCE} (worst over 18 noise seeds and levels: 0.1482), over ${d.s.estimates} estimates on a ${d.s.filled}/${d.s.history}-sample history, ${d.s.audibleBlocks} audible blocks`);
  }
  {
    // THE EIGHT-SECOND CONTRACT. `if (N < this.history) return` is the whole of
    // it, and nothing used to notice when it was relaxed — replacing `history`
    // with 100 left every assertion green while the tap locked on 1 s of audio.
    // A fixture with only ~6 s of contiguous audio behind the write pointer must
    // still be `listening`.
    const pcm = clickTrain(128, 6.5);
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 16));
    const tap = new BpmTap();
    let published = 0;
    for (let p = 0; p + (1 << 16) <= pcm.length; p += 1 << 16) {
      Atomics.store(ring.hdr, 1, 0);
      publish(ring, pcm, p, 1 << 16, planes);
      published = p + (1 << 16);
    }
    tap.cursor = 0;
    for (let t = 0; t < 200; t++) tap.tick(ring);
    const k = tap.payload(), s = tap.stats();
    ok('no-tempo-is-reported-until-the-full-analysis-window-of-contiguous-envelope-exists',
      k.state === 'listening' && k.bpm === null && k.beatFrame === null
      && s.filled > 0 && s.filled < s.history && s.estimates > 0,
      `${(published / FS).toFixed(2)} s of audio -> ${s.filled}/${s.history} envelope samples (${(s.filled / BPM_ENV_RATE).toFixed(2)} of ${BPM_WINDOW_SEC} s), ${s.estimates} estimates ran and all refused, state ${k.state}`);
  }
  {
    // Every read lapped. The cursor sits deep inside the overwritten region and
    // near enough the write pointer that the catch-up does NOT rescue it.
    const cap = 1 << 16;
    const ring = makeRing(cap);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(8192));
    const pcm = clickTrain(120, 12);
    const tap = new BpmTap();
    tap.maxPerTick = 1;
    for (let p = 0; p + 8192 <= pcm.length; p += 8192) {
      Atomics.store(ring.hdr, 1, ring.writeFrames());
      publish(ring, pcm, p, 8192, planes);
    }
    const ticks = 20;
    tap.cursor = ring.writeFrames() - cap - ticks * BPM_BLOCK_FRAMES - 1000;
    const behind = ring.writeFrames() - tap.cursor;
    for (let t = 0; t < ticks; t++) tap.tick(ring);
    const k = tap.payload(), s = tap.stats();
    ok('a-lapped-span-is-refused-and-counted-as-stale, and the tap reports none rather than a tempo built from torn audio',
      behind < BPM_CATCHUP_FRAMES && s.jumps === 0 && s.staleBlocks === ticks && s.blocks === 0
      && s.envBreaks === ticks && k.state === 'none' && k.bpm === null,
      `${s.staleBlocks}/${ticks} stale, ${s.blocks} accepted, ${s.envBreaks} envelope breaks, state ${k.state} (cursor was ${behind} frames behind, catch-up fires at ${BPM_CATCHUP_FRAMES})`);
  }
  {
    // Before frame 0. Reachable only while the ring is young — with a bigger
    // write pointer the catch-up would jump the cursor forward first, which is
    // why this fixture is deliberately short.
    const ring = makeRing(1 << 18);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 15));
    const pcm = clickTrain(120, 4);
    const tap = new BpmTap();
    tap.maxPerTick = 1;
    for (let p = 0; p + (1 << 15) <= pcm.length; p += 1 << 15) {
      Atomics.store(ring.hdr, 1, 0);
      publish(ring, pcm, p, 1 << 15, planes);
    }
    const ticks = 5;
    tap.cursor = -ticks * BPM_BLOCK_FRAMES;
    const behind = ring.writeFrames() - tap.cursor;
    for (let t = 0; t < ticks; t++) tap.tick(ring);
    const k = tap.payload(), s = tap.stats();
    ok('a-block-before-frame-zero-is-refused-and-counted-as-early rather than read as a partly-zero window',
      behind < BPM_CATCHUP_FRAMES && s.jumps === 0 && s.earlyBlocks === ticks && s.blocks === 0
      && s.envBreaks === ticks && k.state === 'none',
      `${s.earlyBlocks}/${ticks} early, ${s.blocks} accepted, ${s.jumps} jumps, state ${k.state} (cursor started ${behind} frames behind the write pointer, catch-up fires at ${BPM_CATCHUP_FRAMES})`);
  }
  {
    // THE CATCH-UP ITSELF. Three assertions in this file say `jumps === 0`, and
    // every one of them is satisfied by a build with no catch-up at all — the
    // feature was never once exercised. This is the positive half: a gap wider
    // than the threshold must move the cursor AND throw the envelope away.
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 16));
    const pcm = clickTrain(128, 24);
    const tap = new BpmTap();
    Atomics.store(ring.hdr, 1, 0);
    publish(ring, pcm, 0, 1 << 16, planes);
    tap.cursor = 0;
    for (let t = 0; t < 200; t++) tap.tick(ring);          // consume what is there
    const before = { jumps: tap.jumps, breaks: tap.envBreaks, filled: tap.filled };
    // Now publish a span far enough ahead that the cursor is stranded. The gap
    // has to exceed BPM_CATCHUP_FRAMES and stay inside the ring.
    const gap = BPM_CATCHUP_FRAMES + 2 * BPM_BLOCK_FRAMES;
    Atomics.store(ring.hdr, 1, ring.writeFrames());
    publish(ring, pcm, ring.writeFrames(), gap, planes.map(() => new Float32Array(gap)));
    const behind = ring.writeFrames() - tap.cursor;
    tap.tick(ring);
    ok('a-gap-wider-than-the-catch-up-threshold-jumps-the-cursor-to-the-newest-audio-and-breaks-continuity',
      before.jumps === 0 && before.filled > 0 && behind > BPM_CATCHUP_FRAMES
      && tap.jumps === 1 && tap.envBreaks === before.breaks + 1 && tap.filled < before.filled,
      `cursor fell ${behind} frames behind (threshold ${BPM_CATCHUP_FRAMES}): jumps ${before.jumps} -> ${tap.jumps}, envelope breaks ${before.breaks} -> ${tap.envBreaks}, contiguous samples ${before.filled} -> ${tap.filled}`);
  }
  {
    // THE PRODUCER RESTARTED UNDER US. A new session hands the tap a fresh stem
    // ring whose write pointer begins at 0 again, leaving the cursor stranded in
    // front of it. The consume loop is `cursor + n <= w`, so a stranded cursor
    // means the loop never runs: no blocks, no refusals, no counter moving, and
    // stats() that look healthy while the tap is deaf for the rest of the session.
    // The catch-up was one-sided and covered only the opposite case.
    const pcm = clickTrain(128, 26);
    const first = drive(pcm);
    const tap = first.tap;
    const strandedAt = tap.cursor;
    const lockedBefore = first.k;

    // a brand-new ring, exactly as a restarted session produces
    const ring2 = makeRing();
    const restartAt = ring2.writeFrames();          // 0 — captured BEFORE publishing
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(HOP));
    const before = { jumps: tap.jumps, breaks: tap.envBreaks };
    const fresh = clickTrain(92, 26);
    for (let p = 0; p + HOP <= fresh.length; p += HOP) {
      Atomics.store(ring2.hdr, 1, Math.max(0, p - 4 * FS));
      publish(ring2, fresh, p, HOP, planes);
      for (let t = 0; t < 20; t++) tap.tick(ring2);
    }
    const after = tap.payload();
    // The load-bearing clause is the last one. Without the re-anchor the tap
    // carries its old envelope across the restart and reports the PREVIOUS
    // track's 127.66 while the new ring is publishing 92 — a stale number that
    // looks exactly like a good one, with jumps and envBreaks both still 0.
    ok('a-producer-that-restarts-below-the-cursor-re-anchors-instead-of-reporting-the-old-track',
      lockedBefore.state === 'locked' && strandedAt > restartAt
      && tap.jumps === before.jumps + 1 && tap.envBreaks === before.breaks + 1
      && after.state === 'locked' && near(after.bpm, 92),
      `cursor was stranded at ${strandedAt} against a ring restarting at ${restartAt}: jumps ${before.jumps} -> ${tap.jumps}, envelope breaks ${before.breaks} -> ${tap.envBreaks}, and it re-locks on the NEW audio at ${after.bpm} (previous track ${lockedBefore.bpm})`);
  }
  {
    // A PAUSED deck stops advancing the write pointer. A tap that re-read its
    // last block ten times a second would fill the whole 8 s history with four
    // seconds of audio and lock hard onto it.
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 16));
    const pcm = clickTrain(120, 8);
    const tap = new BpmTap();
    Atomics.store(ring.hdr, 1, 0);
    publish(ring, pcm, 0, 1 << 16, planes);
    tap.cursor = 0;
    for (let t = 0; t < 200; t++) tap.tick(ring);   // 20 s of ticks, no new audio
    const s = tap.stats();
    const available = Math.floor((1 << 16) / BPM_BLOCK_FRAMES);
    ok('never-counts-the-same-audio-twice: 200 ticks over a frozen write pointer take each block once and then stop',
      s.blocks + s.earlyBlocks + s.staleBlocks === available && s.blocks === available,
      `${available} blocks of audio behind the frozen pointer, ${s.blocks} accepted over 200 ticks (800 blocks' worth of opportunity)`);
  }
  {
    // A LOCK IS NOT A LATCH. `_estimate` clears `this.result` before it does
    // anything else, so an estimate that cannot reach an answer erases the old
    // one instead of leaving it standing. Removing that one line left every
    // assertion green while the header promised "it never falls back to the
    // previous answer" — so here is the promise, tested: lock on a click train,
    // then feed silence until the window is entirely silent, and the tempo must
    // go away rather than persist.
    const beat = clickTrain(128, 26);
    const pcm = new Float32Array(beat.length + 26 * FS);
    pcm.set(beat, 0);                                  // then 26 s of digital silence
    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(HOP));
    const tap = new BpmTap();
    let locked = null;
    for (let p = 0; p + HOP <= pcm.length; p += HOP) {
      Atomics.store(ring.hdr, 1, Math.max(0, p - 4 * FS));
      publish(ring, pcm, p, HOP, planes);
      for (let t = 0; t < 20; t++) tap.tick(ring);
      if (locked === null && tap.payload().state === 'locked') locked = tap.payload().bpm;
    }
    const k = tap.payload(), st = tap.stats();
    // BOTH HALVES, because the payload alone cannot see this one. `_estimate`
    // clears `result` before it does anything else; removing that line leaves a
    // stale answer behind, and on this fixture the stale answer happens to carry
    // confidence 0 — so the confidence gate reports `listening` either way and
    // the wire looks identical. The engine holding no residual estimate is the
    // actual invariant, and `stats().lag` is where it is visible.
    ok('a-lock-is-dropped-when-the-audio-stops-supporting-it-rather-than-latching',
      locked !== null && near(locked, 128) && k.state === 'listening' && k.bpm === null
      && k.beatFrame === null && st.lag === null,
      `locked at ${locked} during the beat, then 26 s of silence -> ${JSON.stringify(k)}, residual estimate ${st.lag === null ? 'none' : 'lag ' + st.lag}`);
  }

  // ==================================================== 4. phase
  head('4. beat phase');
  {
    // ACROSS A RANGE, not at one tempo. The old check tested 128 BPM alone, where
    // the error happens to be 2.5 ms — and the real worst case over a sweep was
    // 40 ms, four times the gate, with the sign going both ways. That is what
    // took PHASE_BEATS from 16 to 4.
    const TEMPI = [68, 92, 128, 140, 160];
    let worst = 0, worstAt = 0, over = 0;
    const rows = [];
    for (const bpm of TEMPI) {
      const d = drive(clickTrain(bpm, 26));
      const e = phaseErrMs(d.k, bpm);
      if (e === null) { over++; rows.push(`${bpm}:no-lock`); continue; }
      rows.push(`${bpm}:${e.toFixed(1)}`);
      if (e > PHASE_GATE_MS) over++;
      if (e > worst) { worst = e; worstAt = bpm; }
    }
    ok('the-reported-beat-lands-on-the-click-positions-across-the-tempo-range',
      over === 0 && rows.length === TEMPI.length,
      `ms from the nearest click: ${rows.join(' ')}; worst ${worst.toFixed(1)} ms @ ${worstAt} BPM against a ${PHASE_GATE_MS} ms gate (a 57-tempo sweep worst is 10.0 ms)`);

    // THE TWO TOLERANCES ARE ONE SYSTEM. A tempo error of E at tempo B moves the
    // reported beat by (PHASE_BEATS-1)/2 * beatPeriod * E/B, so a loose tempo
    // tolerance silently spends the phase budget. Checked at every tempo above.
    let worstBound = 0, boundOver = 0;
    const brows = [];
    for (const bpm of TEMPI) {
      const d = drive(clickTrain(bpm, 26));
      const err = Math.abs(d.k.bpm - bpm);
      const bound = phaseBoundMs(bpm, err);
      brows.push(`${bpm}:${bound.toFixed(1)}`);
      if (bound > PHASE_GATE_MS) boundOver++;
      if (bound > worstBound) worstBound = bound;
    }
    ok('phase-and-tempo-tolerances-are-consistent: the measured tempo error cannot spend the phase budget',
      boundOver === 0,
      `quantisation ${(BPM_ENV_HOP / FS * 1000).toFixed(1)} ms + pulse-train leverage at PHASE_BEATS ${PHASE_BEATS} -> ${brows.join(' ')} ms, worst ${worstBound.toFixed(1)} against the ${PHASE_GATE_MS} ms gate`);

    // ABSOLUTE, NOT MODULO. Every check above is a distance to the NEAREST click,
    // so displacing `beatFrame` by a whole beat is invisible to all of them by
    // construction. The beat must be the most recent one INSIDE the analysis
    // window: within one period of the window's end, and never past it.
    const d = drive(clickTrain(128, 26));
    const period = 60 / 128 * FS;
    // Against `result.windowEnd`, NOT the live `envEndFrame`: the tap keeps
    // consuming blocks after an estimate, so the live pointer has moved on and
    // measuring against it makes a correct beat look one period stale.
    const behind = d.tap.result.windowEnd - d.k.beatFrame;
    ok('the-reported-beat-is-the-most-recent-one-inside-the-analysis-window-not-an-earlier-multiple',
      d.k.beatFrame !== null && behind > 0 && behind <= period,
      `beatFrame ${d.k.beatFrame} is ${behind} frames behind its own window end ${d.tap.result.windowEnd}; one beat is ${period.toFixed(1)} frames, so the admissible range is (0, ${period.toFixed(1)}]`);

    const p0 = beatPhaseAt(d.k, d.k.beatFrame, FS);
    const pHalf = beatPhaseAt(d.k, d.k.beatFrame + period / 2, FS);
    const pBack = beatPhaseAt(d.k, d.k.beatFrame - period / 4, FS);
    ok('beatPhaseAt-is-zero-on-the-beat-half-way-between-and-wraps-positive-before-it',
      p0 === 0 && Math.abs(pHalf - 0.5) < 0.01 && Math.abs(pBack - 0.75) < 0.01,
      `on-beat ${p0}, +half ${pHalf === null ? 'n/a' : pHalf.toFixed(4)}, -quarter ${pBack === null ? 'n/a' : pBack.toFixed(4)}`);
    ok('beatPhaseAt-returns-null-rather-than-zero-when-there-is-no-lock (zero is a legal phase and would paint a beat every frame)',
      beatPhaseAt({ state: 'listening', bpm: null, beatFrame: null }, 1000, FS) === null
      && beatPhaseAt(new BpmTap().payload(), 1000, FS) === null,
      'listening -> null, fresh tap -> null');
  }

  // ==================================================== 5. the wire contract
  head('5. the wire contract');
  {
    const tap = new BpmTap();
    const fresh = tap.payload();
    ok('bpm-payload-is-exactly-the-four-contract-fields, in every state',
      JSON.stringify(Object.keys(fresh).sort()) === JSON.stringify(['beatFrame', 'bpm', 'confidence', 'state']),
      Object.keys(fresh).join(','));
    ok('a-tap-that-has-never-ticked-reports-none',
      fresh.state === 'none' && fresh.bpm === null && fresh.beatFrame === null && fresh.confidence === 0,
      JSON.stringify(fresh));

    // qa/live-wire.mjs walks every engine -> UI message for NaN and Infinity.
    const nanTap = new BpmTap();
    nanTap.audibleBlocks = 1;
    nanTap.result = { bpm: NaN, confidence: 0.9, beatFrame: 100, lag: 50 };
    const bad = nanTap.payload();
    ok('a-non-finite-estimate-never-reaches-the-wire-and-is-counted-rather-than-swallowed',
      Number.isFinite(bad.confidence) && bad.bpm === null && bad.state === 'listening'
      && nanTap.stats().nonFinite === 1 && new BpmTap().stats().nonFinite === 0,
      `${JSON.stringify(bad)}, nonFinite ${nanTap.stats().nonFinite}`);

    // AND IT IS A GETTER. The console polls `payload()`; counting on every call
    // made `nonFinite` a function of the poll rate rather than of the engine, and
    // made a method every caller treats as pure quietly stateful.
    const before = JSON.stringify(nanTap.payload());
    for (let i = 0; i < 20; i++) nanTap.payload();
    ok('payload-is-idempotent-so-polling-it-cannot-move-the-diagnostics',
      JSON.stringify(nanTap.payload()) === before && nanTap.stats().nonFinite === 1,
      `21 further calls: identical payload, nonFinite still ${nanTap.stats().nonFinite}`);

    const seen = new Set();
    const t2 = new BpmTap();
    seen.add(t2.payload().state);
    t2.audibleBlocks = 1;
    t2.result = { bpm: 120, confidence: 0.05, beatFrame: 44100, lag: 50 };
    seen.add(t2.payload().state);
    t2.result = { bpm: 120, confidence: 0.8, beatFrame: 44100, lag: 50 };
    seen.add(t2.payload().state);
    ok('state-is-only-ever-listening-locked-or-none',
      [...seen].every((s) => ['listening', 'locked', 'none'].includes(s)) && seen.size === 3,
      [...seen].join(','));
    ok('a-confidence-under-the-gate-carries-no-bpm-and-no-beatFrame (there is no best-guess field)',
      (() => {
        t2.result = { bpm: 120, confidence: BPM_MIN_CONFIDENCE - 0.001, beatFrame: 44100, lag: 50 };
        const p = t2.payload();
        return p.state === 'listening' && p.bpm === null && p.beatFrame === null && p.confidence > 0;
      })(), `gate ${BPM_MIN_CONFIDENCE}`);
  }
  {
    // CONFIDENCE IS THE AUTOCORRELATION, NOT THE COMB SCORE, and the two live on
    // different scales — the comb sums three weighted terms and tops out at 1.75.
    // Swapping one for the other left every assertion green, because the gate is
    // far below both. The discriminator is the SEPARATION: a bare click train and
    // white noise must sit on opposite sides of the gate with the same estimator.
    const strong = drive(clickTrain(128, 26)).k.confidence;
    const rnd = mulberry32(4242);
    const nz = new Float32Array(26 * FS);
    for (let i = 0; i < nz.length; i++) nz[i] = (rnd() * 2 - 1) * 0.3;
    const weak = drive(nz).k.confidence;
    ok('confidence-is-the-normalised-autocorrelation-so-it-cannot-exceed-one-and-noise-stays-under-the-gate',
      strong > BPM_MIN_CONFIDENCE && strong <= 1 && weak < BPM_MIN_CONFIDENCE && strong / weak > 4,
      `click train ${strong} (a comb score at the same lag exceeds 1 and can reach ${COMB_W.reduce((a, b) => a + b, 0)}), noise ${weak}, gate ${BPM_MIN_CONFIDENCE}, separation ${(strong / weak).toFixed(1)}x`);
  }
  {
    const pcm = clickTrain(128, 26);
    const d = drive(pcm);
    const before = d.k;
    d.tap.reset();
    const after = d.tap.payload(), s = d.tap.stats();
    ok('reset-drops-the-tempo-and-the-envelope (holding the previous track BPM over a new one is correct-looking and the worst thing this feature could do)',
      before.state === 'locked' && after.state === 'none' && after.bpm === null
      && s.filled === 0 && s.blocks === 0 && s.cursor === null && s.envBreaks === 0,
      `${before.state} ${before.bpm} -> ${after.state} ${after.bpm}, ${s.filled} envelope samples`);
  }

  // ==================================================== 6. cost and cadence
  head('6. cost and cadence');
  {
    // THE CLAIM IS CARRIED BY A COUNT, NOT BY A CLOCK. AGENTS.md, "if a claim can
    // be carried by a COUNT, do not carry it with a stopwatch". The milliseconds
    // below are PRINTED as evidence and are not a gate.
    const pcm = groove(128, 30, 5);
    const d = drive(pcm);
    ok('a-tick-never-consumes-more-blocks-than-maxPerTick-however-far-ahead-the-producer-has-jumped',
      d.maxBlocks === BPM_MAX_BLOCKS_PER_TICK && d.ticks > 100,
      `peak ${d.maxBlocks} blocks/tick against a cap of ${BPM_MAX_BLOCKS_PER_TICK}, over ${d.ticks} ticks straddling ${Math.floor(pcm.length / HOP)} hops`);

    // THE CADENCE, as a conservation law rather than as a rate. The old assertion
    // here claimed "at most one estimate per tick", which is structurally true —
    // `_estimate()` has one call site outside the loop, so two was unreachable and
    // the check could only ever fail by running zero. Meanwhile the real defect
    // was invisible: `sinceEstimate = 0` DISCARDED the remainder, so the estimator
    // ran at a measured 1.15 Hz against the 2 Hz documented. `-= every` makes
    // every accepted block accounted for exactly once, and that is falsifiable.
    ok('estimate-cadence-conserves-every-accepted-block',
      d.tap.every * d.s.estimates + d.tap.sinceEstimate === d.s.blocks && d.s.estimates > 10,
      `${d.tap.every} x ${d.s.estimates} estimates + ${d.tap.sinceEstimate} pending = ${d.tap.every * d.s.estimates + d.tap.sinceEstimate}, blocks accepted ${d.s.blocks}; effective rate ${(d.s.estimates / (d.s.blocks / 10)).toFixed(2)} Hz against the documented 2 Hz`);

    // THE WINDOW LENGTH, encoded as the thing it was chosen for. `BPM_WINDOW_SEC`
    // carries a paragraph of justification — that the longest comb lag still has
    // plenty of overlapping products — and nothing checked it; halving it to 4 s
    // left every assertion green while the slow end of the range became noise.
    // The floor is HALF THE WINDOW, not a round number. 500 was the first thing
    // written here and the real value is 499, which is the exact shape of fitting
    // a gate to a measurement. What the window length is actually for is that the
    // longest lag still correlates a MAJORITY of the window with itself.
    const overlap = BPM_ENV_HISTORY - LAG_ACF_MAX;
    ok('the-analysis-window-leaves-most-of-itself-overlapping-at-the-longest-comb-lag',
      overlap >= BPM_ENV_HISTORY / 2 && BPM_ENV_HISTORY === BPM_WINDOW_SEC * BPM_ENV_RATE,
      `${BPM_ENV_HISTORY} samples (${BPM_WINDOW_SEC} s) - longest comb lag ${LAG_ACF_MAX} = ${overlap} overlapping products, floor ${BPM_ENV_HISTORY / 2} (half the window); at 4 s it would be ${400 - LAG_ACF_MAX}`);

    const ring = makeRing();
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(1 << 17));
    publish(ring, groove(128, 4, 6), 0, 1 << 17, planes);
    const t = new BpmTap();
    t.cursor = 0;
    const reps = 400;
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) { t.cursor = (i % 20) * BPM_BLOCK_FRAMES; t.tick(ring); }
    const perTick = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    t.filled = t.history;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) t._estimate();
    const perEst = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
    console.log(`      one tick (up to ${BPM_MAX_BLOCKS_PER_TICK} x 4410-frame blocks: 2 reads + 3-band split + 40 envelope hops): ${perTick.toFixed(3)} ms`);
    console.log(`      one estimate (${NBANDS}-band normalise, ${BPM_ENV_HISTORY}-sample ACF to lag ${LAG_ACF_MAX}, comb, prior, phase): ${perEst.toFixed(3)} ms`);
    console.log(`      at 10 Hz tick / 2 Hz estimate that is ${(perTick * 10 + perEst * 2).toFixed(2)} ms per second of the offscreen MAIN thread`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
