/**
 * The seven deck lanes under transpose — routing, bank switching, crossfade.
 *
 * `pitch.js` shifts ONE stereo stream. This file is the thing the deck actually
 * needs: seven stereo lanes (the six stems plus the passthrough mix) that all
 * come out with EXACTLY the same delay, a transpose that can be changed under a
 * running stream without a click, and no allocation after the first engage.
 *
 *   lane 0  drums        MatchedDelay          ALWAYS. Never shifted. product ruling.
 *   lane 1  bass         PitchShifter(k)
 *   lane 2  other        PitchShifter(k)
 *   lane 3  vocals       PitchShifter(k)
 *   lane 4  guitar       PitchShifter(k)
 *   lane 5  piano        PitchShifter(k)
 *   lane 6  passthrough  PitchShifter(k)       see "THE PASSTHROUGH DECISION"
 *
 * ZERO IMPORTS EXCEPT `./pitch.js`, ON PURPOSE, and for the same reason that file
 * has none: everything above the self-check banner is copied VERBATIM into
 * `offscreen/playback-processor.js`, where `import` does not exist. The copy is
 * not a promise — `worklet-copy-is-verbatim` below reads the worklet source and
 * diffs it against this file, so drift is a red, not a code review.
 *
 * `node extension/engine/pitchbank.js` runs the checks.
 *
 * ------------------------------------------------- WHY DRUMS ARE NOT SHIFTED
 *
 * A phase vocoder's weakest material is a broadband transient, and the whole
 * drum stem is broadband transients. Every other product has to MITIGATE that
 * (better onset handling, shorter windows, transient/steady splitting) because
 * it only has a mix. This one has the stems already, so it can REMOVE the risk
 * instead: run the five harmonic stems through the shifter and put the drums
 * through a pure integer delay of exactly the same length.
 *
 * That only works because `PITCH_GROUP_DELAY_SAMPLES` is CONSTANT across all 13
 * settings including bypass, so all fourteen planes stay sample-aligned STRUCTURALLY
 * rather than by inspection (docs/AUDIO.md §8.1: Δ between stems must be 0; a
 * 4-sample skew combs at 5.5 kHz). `all-lanes-are-one-exact-delay` is the
 * assertion, and `drums-lane-is-never-shifted` is the one that fails if someone
 * "simplifies" the routing later.
 *
 * THE DRUMS LANE IS NOT PART OF A BANK. It is one `MatchedDelay` on this object,
 * run once per block whatever else is happening. That is not a micro-optimisation
 * — it is a correctness requirement. Both banks would render the drums
 * IDENTICALLY (same delay line, same input), and crossfading two identical
 * signals under an EQUAL-POWER law is +3.01 dB, so every interval change would
 * have put a 50 ms kick-drum bump in the mix. The correlation argument below
 * decides the law; keeping drums out of the fade removes the one lane where the
 * law's premise is false.
 *
 * ------------------------------------------------- THE PASSTHROUGH DECISION
 *
 * Planes 12/13 carry the UNSEPARATED MIX, and only during a span the backpressure
 * ladder had to skip (engine/live.js LiveEmitter.gap). They ARE shifted. Both
 * options are defensible and the reasoning is written here rather than left to
 * be re-derived:
 *
 *   AGAINST shifting — the mix contains the drums, so during a dropped span the
 *   drums go through the vocoder after all. The risk we removed comes back.
 *
 *   FOR shifting, and this is the one that wins — a listener playing along in
 *   the transposed key would hear the record JUMP BACK TO CONCERT PITCH for one
 *   hop (~2 s) and then jump again. A wrong-key span is a musical error the user
 *   ACTS ON: they are fingering a horn against it. A drum-transient artefact is
 *   a quality reduction of a span that is ALREADY advertised as degraded (the
 *   console paints PASSTHROUGH, the stem faders are inert there, and QA-15 may
 *   have ducked it to silence anyway). Degrading quality on a degraded span is
 *   proportionate; changing key is not.
 *
 * Two facts make the cost small. At `semitones === 0` — the default, and the
 * state every existing soak ran in — there is no shifter in the path at all
 * (see `_bankSet`), so this costs literally nothing unless the feature is in
 * use. And the core's transient handling is specifically the fix for this
 * material: worst click position error 1 sample at +6, 10-90 % attack rise 28
 * samples, both measured in pitch.js.
 *
 * ------------------------------------------------- CHANGING THE INTERVAL
 *
 * `setSemitones()` on a live `PitchShifter` is length- and latency-exact but its
 * SYNTHESIS PHASE is discontinuous, which is an audible click on tonal material
 * (pitch.js, `setSemitones` doc). So the interval is changed by crossfading TWO
 * banks, and the schedule is forced by the group delay:
 *
 *   t0            the request lands. Bank NEW is reset to k1 and starts eating
 *                 the same input; bank OLD keeps playing.
 *   t0 .. t0+D    PRIME. NEW's output here is not usable — its output sample m
 *                 carries input m-D, which is before the stream it has seen
 *                 began, so the whole window is the vocoder's zero-padded
 *                 ramp-up. Crossfading into it any earlier is crossfading into
 *                 a hole. MEASURED against a steady-state instance fed the same
 *                 tone, at +5/-5/+6/+1: below -220 dB out to m = 2304, still
 *                 -26 to -33 dB at m = 2560, and within 1 dB of steady state at
 *                 m = D exactly. So D is not a safety margin, it is the number:
 *                 512 samples short of it is a 26 dB hole. The two assertions
 *                 `prime-window-reaches-full-level-at-the-group-delay` and
 *                 `crossfading-before-the-group-delay-would-fade-into-a-hole`
 *                 are the two ends of that, and neither can pass vacuously.
 *   t0+D .. +X    CROSSFADE. Both banks now carry the SAME INPUT INSTANT at the
 *                 same output sample (OLD: T-D; NEW: t0+(T-t0)-D = T-D), so the
 *                 fade is between two renderings of one moment, not two moments.
 *   after         OLD is released and stops being fed.
 *
 * EQUAL POWER, not linear, and this is the opposite of `SEAM_XFADE_LAW` on
 * purpose. The deciding variable is correlation, not the word "crossfade"
 * (shared/config.js says so at length). The seam law is linear because the two
 * chunks are two estimates of the SAME audio, corr ~0.99, so their AMPLITUDES
 * add. Here the two sides are the same music at two DIFFERENT PITCHES: their
 * partials are at different frequencies, so they are uncorrelated and their
 * POWERS add. Linear would dip ~2.7 dB through the middle of every transpose
 * change; `switch-holds-level-through-the-crossfade` measures it against a gate
 * that a linear law cannot pass.
 *
 * --------------------------------------------- THE FRAME-GRID STAGGER
 *
 * A shifter's cost is BIMODAL: the synthesis hop is 512 samples and the render
 * quantum is 128, so one quantum in four carries an STFT frame and the other
 * three carry only the resampler. Every shifter in a bank is reset at the same
 * instant, so without help they all hit that frame in the SAME quantum and the
 * PEAK scales with the shifter count while the mean scales with the work.
 *
 * At four shifted lanes that was survivable and was written down as a ponytail
 * (`2 decks BOTH switching non-stop`, p95 2.616 ms of 2.902). At SIX it is not.
 *
 * COUNTED, NOT TIMED, and that choice is the important part of this section.
 * This machine cannot carry a millisecond figure: three consecutive runs of one
 * build put `cost-at-+6`'s p95 at 0.997, 0.991 and 1.685 ms (max 4.17, 4.08,
 * 23.55) and the third went red on a gate the first two cleared by 30 %.
 * a median wants >= 300 s for a median and these windows are ~6 s of wall
 * clock. So the numbers this file RULES on are frame counts, which read the
 * same on a quiet box and a loud one - the three runs above produced peak 5,
 * mean 3.182, 6364 frames, identical to the last digit.
 *
 * Frames landing in the SAME render quantum, two decks both transposed:
 *
 *                                            peak    mean    lanes running
 *   4 lanes, colliding (the build that ships)   8    2.121     8
 *   6 lanes, colliding                         12    3.182    12
 *   6 lanes, STAGGERED (this build)             5    3.182    12
 *
 * Read the mean column first: 3.182 / 2.121 = 1.500, exactly, and the resampler
 * term scales 8 -> 12 the same way. SIX STEMS DO ONE AND A HALF TIMES THE WORK
 * AND NOTHING CAN MAKE THEM NOT. What the stagger moves is the PEAK, and it
 * moves it far enough that six staggered lanes pile up LESS than the four-lane
 * build that shipped - 5 against 8 - while carrying 1.5x the work.
 *
 * The one wall-clock statement worth keeping is a RATIO measured back-to-back
 * in one process, ABBA-interleaved so drift lands on both arms: collide/stagger
 * p95 is 1.63x at +6 and 2.14x at -6, eight passes, per-pass spread under 2 %.
 * The p50 ratio is 0.36x and 0.53x - i.e. the staggered median is HIGHER. That
 * pair IS the mechanism: a distribution that was cheap three quanta in four and
 * brutal on the fourth becomes flat, with the same area under it.
 *
 * `2 decks both transposed` is the row that forced this. It is STEADY STATE for
 * the flagship dual-deck gesture - no drag, no switch, just two transposed decks
 * playing - and at six lanes with the grids colliding it piles 12 frames into
 * one quantum, half again what the shipped build ever did.
 *
 * HOW IT IS DONE, and why it is NOT the upgrade path this comment used to name.
 * The old note said to change `reset()`'s `nextS`/`nextA` in pitch.js plus the
 * content anchor to match, "because otherwise every lane's delay moves and Δ
 * stops being 0". That is true of reaching into the core. It is not necessary:
 * a shifter's delay is defined in ITS OWN stream - output sample m carries input
 * m - D - so feeding it `off` samples of PRE-STREAM SILENCE and dropping the
 * `off` outputs they produce moves its grid by `off` and moves its delay by
 * NOTHING. `_stagger()` does exactly that, from outside the core, with no change
 * to pitch.js and therefore no change to the content anchor.
 * `all-lanes-are-one-exact-delay` and `drums-lane-is-never-shifted` are the
 * assertions that would catch it if that reasoning were wrong; both still read
 * -inf dB.
 *
 * The offsets are `PITCH_GRID_OFFSETS`, one render quantum apart, cycling every
 * four lanes. Six lanes over four quanta cannot be flat - the counts are
 * 2,2,1,1 - so the peak is a third of the colliding case rather than a sixth.
 * A SECOND phase between the two BANKS was built and measured and then deleted:
 * across the three multi-deck rows it moved p95 by 0.01-0.08 ms, i.e. inside the
 * run-to-run spread, and it is not worth a constant.
 *
 * ------------------------------------------------------------------- COST
 *
 * THIS SECTION DELIBERATELY CARRIES NO ABSOLUTE MILLISECOND VERDICT, and the
 * reason is evidence, not caution. Three consecutive runs of ONE build, nothing
 * in the diff moving:
 *
 *                        run 1    run 2    run 3
 *   1 deck at +6  p50    0.737    0.734    0.802
 *                 p95    0.997    0.991    1.685      <- 69 % swing, one red
 *                 max    4.173    4.077   23.554      <- 5.6x
 *   2 decks +6/-6 peak      5        5        5       <- counted, not timed
 *                 mean  3.182    3.182    3.182
 *                 frames 6364     6364     6364
 *
 * The wall clock moved by 69 % at p95 and produced a false red; the frame counts
 * did not move a digit. QA independently saw this suite take 38.4 s and 46.1 s
 * on identical code with `chroma` and `keytap` inflating ~40 % alongside. This
 * box has had up to eight agents on it all day, a median wants >= 300 s for
 * a median, and section 8 times ~6 s of wall clock per row. So:
 *
 *   - the DEADLINE is ruled on by frame COUNT (see THE FRAME-GRID STAGGER above
 *     and `bank-peak-frame-concentration-...` in section 8). Deterministic,
 *     comparable across processes, gated against the FOUR-lane build rather
 *     than against a millisecond figure from today;
 *   - the STAGGER BEING PRESENT is ruled on by reading the grids back off the
 *     running banks (`every-running-bank-has-the-frame-grid-stagger-applied`),
 *     which names the defect instead of inferring it from a slow p95;
 *   - the only wall clock left gates the semitones-0 DEFAULT state at 0.005 ms
 *     against a 0.145 ms gate — 29x headroom, and it has never moved.
 *
 * The +6 and -6 timing rows were CUT (2026-08-16), not merely relabelled.
 * Section 8 carries the full record of what they read and why shrinking them to
 * a tenth made them worse rather than better. Do not lift a millisecond figure
 * from this file into a ratified document: the ratios-and-counts rule forbids quoting
 * an absolute RTF for exactly this reason, and the p95 column above is why.
 *
 * TWO ZEROED-VECTOR p95s ARE ON RECORD - 3.529 ms (QA's `--quick`) and 3.193 ms
 * (this file's own deliberate red-check). They are TWO DIFFERENT PROCESSES, not
 * one window quoted twice; both are withdrawn milliseconds and neither is the
 * zeroed-vector p95. The zeroed configuration's honest number is a count, and it
 * reproduces exactly: two decks at +6/-6 with six colliding lanes is
 * PEAK 12, MEAN 3.182 - against PEAK 5, MEAN 3.182 staggered. Same mean, because
 * the stagger moves peaks and not work.
 *
 * ------------------------------------------------ WHAT THIS SUITE COSTS, AND WHERE
 *
 * This file is the most expensive step in `--quick` and has been called out for
 * it twice. The breakdown is here so that "pitchbank is slow" is a decision
 * anyone can make instead of folklore someone has to re-measure. Per section,
 * wall clock, one M-series Mac, and treat these as indicative for the same
 * reason everything else in this section is:
 *
 *                                        before      after
 *   4  allocation                          9.6 s      2.2 s   <- 48 s of fixture
 *                                                              audio -> 13 s
 *   7  the shipped worklet, in a VM        7.3 s      6.9 s   <- the next lever
 *   8  cost                              ~30   s     ~4   s   <- timing rows cut
 *   3  switching under a running stream    3.3 s      3.1 s
 *   1, 2, 5, 6                            ~1.6 s     ~1.6 s
 *   TOTAL                                ~40   s     18.7 s   (18.78/18.61/18.68
 *                                                              over three runs)
 *
 * THE NEXT LEVER IS SECTION 7, and it is a different trade from the two already
 * taken: it boots seven AudioWorklet processors in a `vm` realm and pumps real
 * audio through the SHIPPED file. It is the only place outside a browser that
 * the transposed live path runs at all, which is exactly why `tools/verify.mjs`
 * argued for keeping this suite in `--quick` when it cost 16.8 s. Shrink it only
 * if you are willing to say which of those seven boots is redundant.
 *
 * Section 4 and section 8 were both shrunk on 2026-08-16 and only one of them
 * was safe to shrink for its stated reason - see the note above section 4's
 * fixture. The property that decided it was COUNT vs STATISTIC, not runtime.
 *
 * READ THE FIRST NUMBER A COLD PROCESS PRODUCES WITH SUSPICION - a separate
 * effect from contention and worth knowing independently. Measured standalone,
 * `1 deck at +6` reads mean 1.70 ms with 400 quanta of burn-in and 0.77 ms with
 * 4400, FLAT across all 8000 timed quanta either way, so it never shows up as a
 * trend inside the row. It is the first shifter-heavy workload in the process
 * paying for its own optimisation, and section 7 makes it worse by driving four
 * processors at semitones 0, which makes `_bankRun`'s `unit.process` call site
 * polymorphic. Section 8 burns the optimiser in before timing anything.
 *
 * ponytail: `2 decks BOTH switching non-stop` - four banks, 24 stereo vocoders -
 * is the one configuration the stagger cannot rescue, and the argument is
 * arithmetic rather than a stopwatch. The stagger moves peaks; it cannot move
 * the MEAN, which is exactly 1.5x the four-lane build's by frame count. The
 * four-lane build already ran that row at p95 2.616 of a 2.902 ms deadline -
 * 90 %, recorded as a ceiling at the time - so 1.5x the work cannot fit, and the
 * timing runs agree (they put it at the wall) for whatever a timing run here is
 * worth. CEILING: two decks both transposed with both users dragging the
 * transpose control at once can miss a render quantum. It needs both decks
 * transposed AND both mid-switch, so it is a ~120 ms window per gesture, and
 * Mode 3 is V2 - but it is the wall, and it is `docs/SIX-STEM-CONTRACT.md` debt
 * item 1 in its post-stagger form. UPGRADE PATH: the work itself has to come
 * down, not move - a shorter synthesis window for the two new lanes, or refusing
 * a second in-flight switch while another deck is already mid-switch (the state
 * is already tracked; `pending` would just have to be honoured across decks).
 */

import {
  PitchShifter, MatchedDelay,
  PITCH_GROUP_DELAY_SAMPLES, PITCH_SWITCH_XFADE_MS, PITCH_SYNTH_HOP,
  PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES,
} from './pitch.js';

// ============================================================== public constants

/** drums, bass, other, vocals, guitar, piano, passthrough — one stereo lane each. */
export const PITCH_LANES = 7;
/** shared/stemring.js PLANES, duplicated: lane L is planes 2L and 2L+1. */
export const PITCH_PLANES = 14;
/** Lane 0 is drums and is NEVER in this list. Read the header before changing it. */
export const PITCH_SHIFTED_LANES = Object.freeze([1, 2, 3, 4, 5, 6]);

/**
 * FRAME-GRID STAGGER, in samples, one per entry of `PITCH_SHIFTED_LANES` — the
 * pre-stream silence that lane's shifter eats at `_bankSet` so its STFT frames
 * land in a different render quantum from its siblings'. Read "THE FRAME-GRID
 * STAGGER" in the header: what it buys, why it costs no alignment, and why the
 * second phase between the two banks was measured and then deleted.
 *
 * ONE RENDER QUANTUM APART, cycling every `hop / quantum` = 4 lanes. The
 * granularity is the QUANTUM and not something finer because a frame either
 * lands inside a given `process()` call or it does not; two lanes 64 samples
 * apart still collide. 128 is fixed by the Web Audio spec, not by `maxBlock`.
 */
export const PITCH_GRID_OFFSETS = Object.freeze(PITCH_SHIFTED_LANES.map(
  (_l, i) => (i % (PITCH_SYNTH_HOP / 128)) * 128));

// ================================================================== PitchLanes

export class PitchLanes {
  /**
   * @param {object} [o]
   * @param {number} [o.sampleRate] 44100 on the live path. Only the crossfade
   *        length is derived from it; the shifter itself is rate-agnostic.
   * @param {number} [o.maxBlock] largest block processed in one internal pass.
   *        128 in the worklet — the render quantum. Bigger blocks loop.
   * @param {number} [o.xfadeMs]
   */
  constructor(o = {}) {
    this.sr = o.sampleRate || 44100;
    this.maxBlock = o.maxBlock || 128;
    this.xfLen = Math.max(1, Math.round(((o.xfadeMs ?? PITCH_SWITCH_XFADE_MS) / 1000) * this.sr));

    // Equal-power ramps, half-sample centred so the pair is symmetric and both
    // ends are strictly inside (0,1) — engine/live.js makeFades, same argument.
    this.fi = new Float32Array(this.xfLen);
    this.fo = new Float32Array(this.xfLen);
    for (let i = 0; i < this.xfLen; i++) {
      const u = (i + 0.5) / this.xfLen;
      this.fi[i] = Math.sqrt(u);
      this.fo[i] = Math.sqrt(1 - u);
    }

    /** Lane 0. Outside the banks on purpose — see the header. */
    this.drums = new MatchedDelay(2);

    /**
     * Two banks, lanes 1-6 only. `md` is allocated up front (a delay line is
     * 128 KB and costs nothing to build); `sh` stays null until the user first
     * engages the transpose, because allocating twelve stereo phase vocoders and
     * designing a resample kernel is ~3 ms and the default state never needs it.
     */
    this.banks = [this._makeBank(), this._makeBank()];
    this.cur = this.banks[0];
    this.nxt = this.banks[1];
    /** how many times a PitchShifter has ever been constructed here. */
    this.allocations = 0;

    /** the interval the lanes are converging to. */
    this.target = 0;
    /** the interval fully in effect (differs from `target` only mid-switch). */
    this.applied = 0;
    /** null, or a target queued because a switch was already in flight. */
    this.pending = null;

    this.switching = false;
    this.primeLeft = 0;
    this.xfPos = 0;
    this.switches = 0;

    // scratch: two sets of 14 planes, maxBlock frames. Allocated once.
    this.a = Array.from({ length: PITCH_PLANES }, () => new Float32Array(this.maxBlock));
    this.b = Array.from({ length: PITCH_PLANES }, () => new Float32Array(this.maxBlock));
    // reused argument pairs, so the hot path never builds an array
    this._i2 = [null, null];
    this._o2 = [null, null];

    // Stagger scratch: the pre-stream silence a shifter eats at `_bankSet`, and
    // somewhere to throw its output. Never on the per-block path; allocated here
    // because `_bankSet` runs inside the audio thread's message handler.
    const gmax = PITCH_GRID_OFFSETS.reduce((m, v) => (v > m ? v : m), 0);
    this._zin = [new Float32Array(gmax), new Float32Array(gmax)];
    this._zout = [new Float32Array(gmax), new Float32Array(gmax)];
  }

  _makeBank() {
    const md = new Array(PITCH_LANES).fill(null);
    for (const l of PITCH_SHIFTED_LANES) md[l] = new MatchedDelay(2);
    return { semi: 0, md, sh: null };
  }

  /** Constant, every setting, every lane. Downstream adds this to its latency readout. */
  get delaySamples() { return PITCH_GROUP_DELAY_SAMPLES; }

  /**
   * Build the phase vocoders. Called at most once per instance, off the steady
   * state: the FIRST non-zero transpose request pays for it.
   *
   * Measured at six lanes: the whole first engage — twelve stereo instances,
   * the kernel bank, and `_bankSet`'s stagger — is ~1.8-2.1 ms warm and ~13 ms
   * on the very first call in a process, the difference being JIT and not work.
   * The kernel bank is ~2 ms the first time a given resample cutoff is seen (the
   * 128-tap Kaiser bank is 513 branches of besselI0). All seven down-shifts and
   * bypass share ONE cutoff (0.5 exactly), so only the six up-shifts can pay that
   * cost, and each pays it once per AudioWorkletGlobalScope because pitch.js
   * caches the bank at module scope — which means deck B never pays it at all.
   *
   * ponytail: that ~2 ms lands on the audio render thread, inside the port
   * message handler, once per session, at the instant the user first grabs the
   * transpose control. It fits inside the output buffer's slack (~48 ms of
   * outputLatency, 16 quanta) so it cannot underrun, but it IS a render-thread
   * task longer than one quantum. CEILING: on a machine 3x slower it is ~6 ms,
   * still inside the slack but not by much. UPGRADE PATH: design the kernel
   * banks on the offscreen MAIN thread (they are plain Float64Arrays) and post
   * them into the worklet's `kernelCache` before the first engage.
   */
  _ensureShifters() {
    for (const bank of this.banks) {
      if (bank.sh) continue;
      const sh = new Array(PITCH_LANES).fill(null);
      for (const l of PITCH_SHIFTED_LANES) { sh[l] = new PitchShifter(0, 2); this.allocations++; }
      bank.sh = sh;
    }
  }

  /**
   * Point a bank at an interval and wipe its history. Exactly the sequence
   * `PitchShifter`'s own constructor uses (`_setRatio` then `reset`), expressed
   * through the public API so this file never reaches into the core's privates:
   * `setSemitones` re-anchors (harmless — `reset` is about to wipe it) and
   * early-returns when the value has not changed (also harmless, for the same
   * reason). The kernel bank lookup inside it is the only real work.
   *
   * AT ZERO SEMITONES THERE IS NO PHASE VOCODER IN THE PATH. `bypass-is-identity`
   * and `matched-delay-tracks-the-shifter` together say a `PitchShifter(0)` and a
   * `MatchedDelay` agree to below -120 dB sample for sample, so substituting the
   * delay is inaudible by the core's own measurement — and it takes the DEFAULT
   * state, which is every session that never touches the control and every soak
   * this project has already run, from ~17 % of a core to ~0.7 %.
   */
  _bankSet(bank, k) {
    bank.semi = k;
    for (let i = 0; i < PITCH_SHIFTED_LANES.length; i++) {
      const l = PITCH_SHIFTED_LANES[i];
      if (k === 0) { bank.md[l].reset(); continue; }
      bank.sh[l].setSemitones(k);
      bank.sh[l].reset();
      this._stagger(bank.sh[l], PITCH_GRID_OFFSETS[i]);
    }
  }

  /**
   * Eat `off` samples of pre-stream silence, throwing the output away, so this
   * shifter's STFT frame grid sits `off` samples away from its siblings'.
   * `PITCH_GRID_OFFSETS` is why; the header's "THE FRAME-GRID STAGGER" is the
   * proof that it costs no alignment.
   *
   * This is the ONLY place the offset is created and it is deliberately NOT on
   * the per-block path: a shifter's delay is measured in its OWN stream, so
   * feeding it `off` extra samples ahead of the stream and dropping the `off`
   * outputs they produce leaves output sample m carrying input m - D exactly as
   * before, at every lane and every interval.
   *
   * ponytail: this is not free and it is not amortised. `_bankSet` goes from
   * 0.038 ms to 0.358 ms measured — 896 samples of vocoder work across the six
   * lanes — and it lands on the render thread inside the port message handler,
   * once per ACCEPTED interval change. That is 12 % of a render quantum against
   * ~48 ms of output-buffer slack, so it cannot underrun, and it buys the p95
   * numbers in the header. CEILING: a control being dragged coalesces to one
   * switch at a time (`pending`), so the worst case is one of these per completed
   * switch — one per 3072 + 2205 samples, ~8 per second, 0.3 % of a core.
   * UPGRADE PATH: spend the offset
   * inside the existing 3072-sample prime instead of ahead of it — the output is
   * discarded there anyway — which needs `_bankRun` to feed one bank a different
   * frame count per lane, i.e. a per-lane budget threaded through the hot path.
   * Not worth it until a profile says this spike matters.
   */
  _stagger(sh, off) {
    const zi = this._zin, zo = this._zout;
    let done = 0;
    while (done < off) {
      const m = Math.min(zi[0].length, off - done);
      sh.process(zi, zo, m);
      done += m;
    }
  }

  /**
   * Lanes 1-6 of one bank, n frames, reading `inPl` at `inOff` and writing
   * `outPl` at `outOff`.
   *
   * The `=== 0` branches exist so the worklet's hot path (one 128-frame block,
   * both offsets zero) allocates NOTHING: `subarray` mints a new TypedArray
   * object every call, and 48 of those per render quantum is GC pressure on the
   * audio thread. Every other host takes the slow path.
   */
  _bankRun(bank, inPl, inOff, outPl, outOff, n) {
    const i2 = this._i2, o2 = this._o2;
    for (const l of PITCH_SHIFTED_LANES) {
      const unit = bank.semi === 0 ? bank.md[l] : bank.sh[l];
      const iL = inPl[2 * l], iR = inPl[2 * l + 1];
      const oL = outPl[2 * l], oR = outPl[2 * l + 1];
      i2[0] = inOff === 0 ? iL : iL.subarray(inOff, inOff + n);
      i2[1] = inOff === 0 ? iR : iR.subarray(inOff, inOff + n);
      o2[0] = outOff === 0 ? oL : oL.subarray(outOff, outOff + n);
      o2[1] = outOff === 0 ? oR : oR.subarray(outOff, outOff + n);
      unit.process(i2, o2, n);
    }
  }

  /**
   * Request an interval. Integer in [-6, +6]; anything else is REFUSED and the
   * lanes keep the interval they had, because the alternative — clamping — turns
   * a UI bug into a wrong key the user cannot see.
   *
   * @returns {boolean} true if the request was accepted (a no-op counts).
   */
  setSemitones(k) {
    if (!Number.isInteger(k) || k < PITCH_MIN_SEMITONES || k > PITCH_MAX_SEMITONES) return false;
    if (k === this.target) { this.pending = null; return true; }
    // One switch at a time: a user dragging the control must not spawn a third
    // bank. The last request wins and is applied the moment this one lands.
    if (this.switching) { this.pending = k; return true; }
    this._beginSwitch(k);
    return true;
  }

  _beginSwitch(k) {
    if (k !== 0) this._ensureShifters();
    this._bankSet(this.nxt, k);
    this.target = k;
    this.switching = true;
    this.primeLeft = PITCH_GROUP_DELAY_SAMPLES;
    this.xfPos = 0;
    this.switches++;
  }

  _completeSwitch() {
    const old = this.cur;
    this.cur = this.nxt;
    this.nxt = old;
    this.applied = this.cur.semi;
    this.switching = false;
    this.primeLeft = 0;
    this.xfPos = 0;
    const p = this.pending;
    this.pending = null;
    if (p !== null && p !== this.target) this._beginSwitch(p);
  }

  /**
   * A HARD DISCONTINUITY — seek, deck load, track change, live restart.
   * docs/ARCHITECTURE.md §3.9: the input stream jumps, so the D samples of
   * history inside every lane belong to a different piece of music and must not
   * be emitted. Clearing them costs one group delay of silence at the seam,
   * which the deck's own ring gating already covers; NOT clearing them bleeds
   * 70 ms of the previous position over the new one.
   *
   * Any switch in flight is abandoned: the interval being converged to simply
   * becomes the interval, from the first sample.
   */
  reset() {
    const k = this.pending !== null ? this.pending : this.target;
    if (k !== 0) this._ensureShifters();
    this.pending = null;
    this.target = k;
    this.applied = k;
    this.switching = false;
    this.primeLeft = 0;
    this.xfPos = 0;
    this.drums.reset();
    this._bankSet(this.cur, k);
    this._bankSet(this.nxt, k);
  }

  /**
   * @param {Float32Array[]} inPl  PITCH_PLANES planes, >= n valid frames
   * @param {Float32Array[]} outPl PITCH_PLANES planes, >= n frames of room
   * @param {number} n
   *
   * Writes exactly n frames to every plane. Safe with `inPl === outPl`.
   */
  process(inPl, outPl, n) {
    let done = 0;
    while (done < n) {
      const m = Math.min(this.maxBlock, n - done);
      this._run(inPl, outPl, done, m);
      done += m;
    }
  }

  _run(inPl, outPl, off, n) {
    // ---- lane 0, drums. One delay line, run once, never crossfaded.
    {
      const i2 = this._i2, o2 = this._o2;
      i2[0] = off === 0 ? inPl[0] : inPl[0].subarray(off, off + n);
      i2[1] = off === 0 ? inPl[1] : inPl[1].subarray(off, off + n);
      o2[0] = off === 0 ? outPl[0] : outPl[0].subarray(off, off + n);
      o2[1] = off === 0 ? outPl[1] : outPl[1].subarray(off, off + n);
      this.drums.process(i2, o2, n);
    }

    if (!this.switching) { this._bankRun(this.cur, inPl, off, outPl, off, n); return; }

    this._bankRun(this.cur, inPl, off, this.a, 0, n);
    this._bankRun(this.nxt, inPl, off, this.b, 0, n);
    const a = this.a, b = this.b, fi = this.fi, fo = this.fo;

    let i = 0;
    while (i < n) {
      if (this.primeLeft > 0) {
        // Bank NEW is still filling its group delay and is emitting exact zeros.
        const m = Math.min(n - i, this.primeLeft);
        for (const l of PITCH_SHIFTED_LANES) {
          for (let c = 0; c < 2; c++) {
            const q = 2 * l + c, d = outPl[q], s = a[q];
            for (let j = 0; j < m; j++) d[off + i + j] = s[i + j];
          }
        }
        this.primeLeft -= m; i += m;
      } else if (this.xfPos < this.xfLen) {
        const m = Math.min(n - i, this.xfLen - this.xfPos);
        const p = this.xfPos;
        for (const l of PITCH_SHIFTED_LANES) {
          for (let c = 0; c < 2; c++) {
            const q = 2 * l + c, d = outPl[q], s0 = a[q], s1 = b[q];
            for (let j = 0; j < m; j++) d[off + i + j] = s0[i + j] * fo[p + j] + s1[i + j] * fi[p + j];
          }
        }
        this.xfPos += m; i += m;
      } else {
        const m = n - i;
        for (const l of PITCH_SHIFTED_LANES) {
          for (let c = 0; c < 2; c++) {
            const q = 2 * l + c, d = outPl[q], s = b[q];
            for (let j = 0; j < m; j++) d[off + i + j] = s[i + j];
          }
        }
        i += m;
      }
    }
    if (this.primeLeft === 0 && this.xfPos >= this.xfLen) this._completeSwitch();
  }

  /**
   * What the audio thread ACTUALLY has. On the diagnostic path for the same
   * reason the worklet's gain vector is: this state lives ONLY here, so without
   * it nothing outside the render thread can tell "the transpose is applied"
   * from "the message was dropped on the floor".
   */
  stats() {
    return {
      target: this.target,
      applied: this.applied,
      pending: this.pending,
      switching: this.switching,
      switches: this.switches,
      primeLeft: this.primeLeft,
      xfPos: this.xfPos,
      xfLen: this.xfLen,
      delaySamples: PITCH_GROUP_DELAY_SAMPLES,
      allocations: this.allocations,
      shifted: this.cur.semi !== 0 || (this.switching && this.nxt.semi !== 0),
    };
  }
}

// ===================================================================== self-check
//
// `node extension/engine/pitchbank.js`. Everything below this line is the
// runnable check and is NOT part of the module's surface; the worklet copy drops
// it, and `worklet-copy-is-verbatim` is what proves the copy stops here.

async function selfCheck() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const { rfft } = await import('./fft.js');

  const FS = 44100;
  const D = PITCH_GROUP_DELAY_SAMPLES;
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

  // ------------------------------------------------------------------ helpers
  function noise(n, seed = 1, amp = 0.5) {
    let s = seed >>> 0;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = ((s / 4294967296) * 2 - 1) * amp; }
    return x;
  }
  function sine(n, f, amp = 0.5) {
    const x = new Float32Array(n);
    const fd = Math.round(0.01 * FS);
    for (let i = 0; i < n; i++) {
      let e = 1;
      if (i < fd) e = 0.5 * (1 - Math.cos(Math.PI * i / fd));
      else if (i > n - 1 - fd) e = 0.5 * (1 - Math.cos(Math.PI * (n - 1 - i) / fd));
      x[i] = amp * e * Math.sin(2 * Math.PI * f * i / FS);
    }
    return x;
  }
  const planes = (n) => Array.from({ length: PITCH_PLANES }, () => new Float32Array(n));
  /**
   * Run `src` (14 planes) through `lanes` in q-frame blocks, applying each
   * `[when, k]` at the top of the block that contains `when`. Returns the 14
   * output planes plus the ACTUAL block-aligned sample each change fired at —
   * asserting against `when` instead would be asserting against a number the
   * code never promised.
   */
  function run(lanes, src, n, q = 128, at = null) {
    const out = planes(n);
    const ib = planes(q), ob = planes(q);
    const fired = [];
    for (let p = 0; p < n; p += q) {
      const m = Math.min(q, n - p);
      if (at) for (const [when, k] of at) if (p <= when && when < p + m) { lanes.setSemitones(k); fired.push([p, k]); }
      for (let l = 0; l < PITCH_PLANES; l++) ib[l].set(src[l].subarray(p, p + m), 0);
      lanes.process(ib, ob, m);
      for (let l = 0; l < PITCH_PLANES; l++) out[l].set(ob[l].subarray(0, m), p);
    }
    out.fired = fired;
    return out;
  }
  function rms(x, from, n) {
    let s = 0;
    for (let i = 0; i < n; i++) s += x[from + i] * x[from + i];
    return Math.sqrt(s / n);
  }
  /**
   * "out is src delayed by exactly D" as ONE number plus the evidence that there
   * was anything to look at. `residualDb` alone returns -Infinity on a silent
   * reference and would report a perfect match for two silent buffers, which is
   * the vacuous-assertion shape AGENTS.md bans — so the reference level comes
   * back with it and every caller gates on it.
   */
  function delayMatch(out, src, n) {
    let num = 0, den = 0, peak = 0;
    for (let i = 0; i < n; i++) {
      const d = out[D + i] - src[i];
      num += d * d; den += src[i] * src[i];
      const a = Math.abs(src[i]);
      if (a > peak) peak = a;
    }
    // `peak`, not rms: a sparse click train is 0.9 peak and 0.014 rms, and an
    // rms gate set for a tone would reject the one fixture that actually
    // exercises the drums lane. The gate exists to prove there was something to
    // look at, and peak says that for both.
    return { db: den === 0 ? Infinity : 10 * Math.log10(num / den), ref: Math.sqrt(den / n), peak };
  }
  /**
   * Peak frequency by parabolic interpolation on the log magnitude over a
   * 16384-point Hann window. Returns NaN when there is nothing peak-like — the
   * caller must treat that as a failure, never as an excuse (AGENTS.md).
   */
  function peakHz(x, off, n = 16384) {
    const buf = new Float64Array(n);
    for (let i = 0; i < n; i++) buf[i] = x[off + i] * 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
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
    if (mx < 20 * (sum / (n / 2))) return NaN;            // nothing peak-like here
    const a = Math.log(mag[k - 1]), b = Math.log(mag[k]), c = Math.log(mag[k + 1]);
    const den = a - 2 * b + c;
    if (!(den < 0)) return NaN;
    return (k + 0.5 * (a - c) / den) * FS / n;
  }

  console.log('\x1b[1mpitchbank.js self-check\x1b[0m');

  // ==================================================== 1. routing and delay
  head('1. routing');
  {
    // Seven DIFFERENT signals, one per lane, at semitones 0. Every plane must
    // come out as ITSELF delayed by exactly D. Catches lane cross-wiring, a
    // swapped channel pair, a lane on the wrong unit, and any delay mismatch —
    // the whole family that makes Δ != 0 (docs/AUDIO.md §8.1).
    const n = 3 * FS;
    const src = planes(n);
    for (let l = 0; l < PITCH_LANES; l++) {
      src[2 * l].set(noise(n, 11 + l * 7, 0.4));
      src[2 * l + 1].set(noise(n, 101 + l * 13, 0.4));
    }
    const lanes = new PitchLanes();
    const out = run(lanes, src, n);
    let worst = -Infinity, worstQ = -1, quietest = Infinity;
    for (let q = 0; q < PITCH_PLANES; q++) {
      const m = delayMatch(out[q], src[q], n - D);
      if (m.db > worst) { worst = m.db; worstQ = q; }
      if (m.peak < quietest) quietest = m.peak;
    }
    ok('all-lanes-are-one-exact-delay: at semitones 0 every one of the 14 planes is its own input delayed by exactly 3072',
      quietest > 0.1 && worst < -120,
      `worst plane ${worstQ} at ${worst.toFixed(1)} dB, quietest reference peak ${quietest.toFixed(3)}`);
    ok('routing-uses-no-phase-vocoder-at-semitones-0 (the default state allocates none)',
      lanes.allocations === 0 && lanes.stats().shifted === false, `${lanes.allocations} shifters constructed`);
  }

  // ==================================================== 2. drums are excluded
  head('2. the drums lane');
  {
    // Lane 0 gets a click train — the material a vocoder is worst on. Lanes 1-6
    // get a 440 Hz tone. At +6 the drums must be a BIT-EXACT delay and every
    // other lane must read a tritone up. Two positive claims; nothing is
    // asserted by absence.
    const n = 4 * FS;
    const src = planes(n);
    const clicks = new Float32Array(n);
    for (let t = 0; t < n; t += Math.round(FS * 0.25)) {
      for (let i = 0; i < 24 && t + i < n; i++) clicks[t + i] = 0.9 * Math.exp(-i / 4) * (i % 2 ? -1 : 1);
    }
    src[0].set(clicks); src[1].set(clicks);
    const tone = sine(n, 440, 0.5);
    for (const l of PITCH_SHIFTED_LANES) { src[2 * l].set(tone); src[2 * l + 1].set(tone); }

    const lanes = new PitchLanes();
    lanes.setSemitones(6);
    const out = run(lanes, src, n);
    const after = D + lanes.xfLen + FS;      // a full second past the crossfade

    const m0 = delayMatch(out[0], src[0], n - D), m1 = delayMatch(out[1], src[1], n - D);
    ok('drums-lane-is-never-shifted: lane 0 at +6 is the input delayed by 3072, bit for bit, through the switch and after it',
      m0.peak > 0.5 && Math.max(m0.db, m1.db) < -120,
      `${Math.max(m0.db, m1.db).toFixed(1)} dB over ${((n - D) / FS).toFixed(1)} s, reference peak ${m0.peak.toFixed(3)} (rms ${m0.ref.toFixed(4)} — a click train, which is the point)`);

    const want = 440 * Math.pow(2, 6 / 12);
    let moved = 0, worstErr = 0, sawNaN = false;
    for (const l of PITCH_SHIFTED_LANES) {
      const f = peakHz(out[2 * l], after);
      if (!Number.isFinite(f)) { sawNaN = true; continue; }
      const err = Math.abs(f - want);
      if (err > worstErr) worstErr = err;
      if (err < 1.0) moved++;
    }
    ok('shifted-lanes-moved-by-the-interval: bass, other, vocals, guitar, piano AND passthrough all read 622.25 Hz at +6',
      !sawNaN && moved === PITCH_SHIFTED_LANES.length,
      sawNaN ? 'a lane produced NO PEAK to interpolate — that is the failure, not an excuse from it'
        : `${moved}/${PITCH_SHIFTED_LANES.length} within 1 Hz of ${want.toFixed(2)}, worst error ${worstErr.toFixed(3)} Hz`);
  }

  // ==================================================== 3. the switch schedule
  head('3. switching under a running stream');
  {
    /**
     * WHY primeLeft IS EXACTLY D, measured rather than asserted from theory.
     *
     * Two instances of the same shifter fed the same steady tone: one running
     * from the start of the stream (the OLD bank), one reset at t0 and fed from
     * there (the NEW bank). The question the crossfade schedule turns on is
     * "when is NEW at the same level as OLD", and it has two halves, because a
     * one-sided answer cannot tell a correct wait from a superstitious one:
     *
     *   sufficient  — at m = D, NEW is within 2 dB of OLD, at every interval
     *   necessary   — at m = D/2 it is still literal silence, at every interval
     *
     * A first version of this asserted "the first D output samples are exactly
     * zero" and went red at 1647: the vocoder's ramp-up is not silence all the
     * way, it is below -110 dB out to m = 2048 and then climbs over the last
     * ~1000 samples. The code never promised zeros, so that was an assertion
     * bug, not a defect (AGENTS.md, "an assertion encoding an invariant the code
     * never promised"). Measured profile, all 13 intervals, dB relative to the
     * running instance: m = D/2 -135..-360 · D-1024 -111..-329 · D-512
     * -8.5..-318 · D -1.73..+0.71 · D+512 -1.39..+0.14.
     */
    const n = 4 * FS, t0 = Math.round(1.5 * FS), w = 512;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / FS);
    let worstAt = 0, worstHalf = -Infinity, measured = 0;
    for (let k = PITCH_MIN_SEMITONES; k <= PITCH_MAX_SEMITONES; k++) {
      const yo = new Float32Array(n);
      new PitchShifter(k, 1).process([x], [yo], n);
      const yn = new Float32Array(n - t0);
      new PitchShifter(k, 1).process([x.subarray(t0)], [yn], n - t0);
      const ref = rms(yo, t0 + D, w);
      if (!(ref > 0.05)) continue;                 // no reference: NOT measured, and the count says so
      measured++;
      const at = 20 * Math.log10(rms(yn, D, w) / ref);
      const half = 20 * Math.log10((rms(yn, D >> 1, w) || 1e-18) / ref);
      if (Math.abs(at) > Math.abs(worstAt)) worstAt = at;
      if (half > worstHalf) worstHalf = half;
    }
    const all = PITCH_MAX_SEMITONES - PITCH_MIN_SEMITONES + 1;
    ok('prime-window-reaches-full-level-at-the-group-delay: a bank reset at t0 matches a running one at t0+3072, all 13 intervals',
      measured === all && Math.abs(worstAt) < 2.0,
      `${measured}/${all} intervals measured, worst deviation ${worstAt.toFixed(2)} dB`);
    ok('crossfading-halfway-through-the-prime-would-fade-into-silence (so the wait is the number, not a superstition)',
      measured === all && worstHalf < -60,
      `${measured}/${all} intervals measured, loudest at t0+1536 is ${worstHalf.toFixed(1)} dB`);
  }
  {
    // A 440 Hz tone, not noise: the level claim below needs an estimator that
    // does not confound the crossfade law with the resampler's anti-alias cut
    // (shifting broadband noise up removes the top of the band and changes its
    // rms by ~1 dB all on its own, which is the size of the effect being tested).
    const n = 6 * FS;
    const src = planes(n);
    const tone = sine(n, 440, 0.5);
    for (let l = 0; l < PITCH_LANES; l++) { src[2 * l].set(tone); src[2 * l + 1].set(tone); }
    const lanes = new PitchLanes();
    const out = run(lanes, src, n, 128, [[2 * FS, 5]]);
    const t0 = out.fired[0][0];

    ok('switch-is-length-exact: n frames in, n frames out, across a mid-stream interval change',
      out[0].length === n && out[PITCH_PLANES - 1].length === n, `${n} in / ${out[0].length} out`);
    const s = lanes.stats();
    ok('switch-completed-and-latched', s.applied === 5 && s.target === 5 && s.switching === false && s.switches === 1,
      JSON.stringify(s));

    // No hole. A missed prime would leave 3072 samples (70 ms) of digital zero;
    // a tone crosses zero twice a cycle, so the honest gate is one millisecond.
    let longest = 0, cur = 0;
    for (let i = t0 - 1024; i < t0 + D + lanes.xfLen + 8192; i++) {
      if (out[4][i] === 0) { cur++; if (cur > longest) longest = cur; } else cur = 0;
    }
    ok('switch-leaves-no-hole: no run of digital zero longer than 1 ms anywhere in the switch window',
      longest < FS / 1000, `longest zero run ${longest} samples (${(longest * 1000 / FS).toFixed(2)} ms)`);

    // EQUAL POWER. Measured on a shifted lane over the middle half of the
    // crossfade, against the mean POWER of the two steady states either side —
    // which is exactly what an equal-power law predicts. A LINEAR law would read
    // -2.66 dB here (mean of (1-u)^2+u^2 over u in [0.25,0.75] is 0.5417), so a
    // +/-1.0 dB gate discriminates between the two laws by a factor of 2.7.
    const xf0 = t0 + D, xf1 = xf0 + lanes.xfLen;
    const q = lanes.xfLen >> 2;
    const before = rms(out[4], xf0 - 8192, 8192);
    const during = rms(out[4], xf0 + q, lanes.xfLen >> 1);
    const afterR = rms(out[4], xf1 + 2048, 8192);
    const refP = 0.5 * (before * before + afterR * afterR);
    const dip = 10 * Math.log10((during * during) / refP);
    ok('switch-holds-level-through-the-crossfade: equal power, not linear (a linear law reads -2.66 dB here)',
      before > 0.05 && afterR > 0.05 && Math.abs(dip) < 1.0,
      `${dip.toFixed(2)} dB vs the mean steady-state power (before ${before.toFixed(4)}, during ${during.toFixed(4)}, after ${afterR.toFixed(4)})`);

    const md = delayMatch(out[0], src[0], n - D);
    ok('switch-does-not-disturb-the-drums-lane (both banks would render it identically, and an equal-power fade of two identical signals is +3 dB)',
      md.peak > 0.4 && md.db < -120, `${md.db.toFixed(1)} dB, reference peak ${md.peak.toFixed(3)}`);
  }

  // ==================================================== 4. no allocation churn
  head('4. allocation');
  {
    /**
     * ONE SECOND BETWEEN SWITCHES, NOT FOUR — 10 s of fixture audio, not 40.
     * (2026-08-16. This section was 9.6 s of a ~40 s suite, the single
     * most expensive thing in it once section 8's timing rows were cut.)
     *
     * WHY THIS SHRINK IS SAFE AND SECTION 8'S WAS NOT. Read the two together;
     * they had opposite outcomes and the property that decided it is the point.
     *
     * This assertion COUNTS: allocations, switches, the interval that landed.
     * The only thing the spacing has to buy is that each switch finishes before
     * the next request arrives, or the requests coalesce through `pending` and
     * the counts legitimately change. A switch latches in
     * PITCH_GROUP_DELAY_SAMPLES + xfLen = 3072 + 2205 = 5277 samples = 120 ms,
     * so 1 s is 8x the margin it needs and 4 s bought nothing 1 s does not.
     * Shrink it and every number it reports is IDENTICAL, because no estimator
     * is involved — the quantity is exact at any sample size above the floor.
     *
     * Section 8's timing rows had no such floor. Shrinking THEM from 8000 quanta
     * to 800 made the median WORSE (1.872 / 0.918 / 0.743 ms across three runs,
     * the first a red) because 8000 samples could dilute a JIT-cold start and
     * 800 could not. A statistic over a noisy process has no sample size at
     * which it becomes exact; a count does. THAT is the property to check before
     * shrinking a fixture — not how long it happens to run.
     */
    const lanes = new PitchLanes();
    const n = 10 * FS;
    const src = planes(n);
    const x = noise(n, 9, 0.3);
    for (let l = 0; l < PITCH_LANES; l++) { src[2 * l].set(x); src[2 * l + 1].set(x); }
    const seq = [2, -3, 6, 0, -6, 1, 0, 4];
    const at = seq.map((k, i) => [Math.round((1 + i * 1) * FS), k]);
    run(lanes, src, n, 128, at);
    const s = lanes.stats();
    const wantAlloc = 2 * PITCH_SHIFTED_LANES.length;
    ok(`shifters-are-allocated-once-and-only-once: ${wantAlloc} constructions over 8 interval changes`,
      s.allocations === wantAlloc && s.switches === seq.length && s.applied === 4 && s.pending === null,
      `${s.allocations} allocations, ${s.switches} switches, applied ${s.applied}`);
  }
  {
    // The other half of the same property: a control the user is DRAGGING must
    // not spawn a bank per sample. Twenty requests inside one crossfade window
    // collapse to one queued target, and the interval that lands is the last one.
    //
    // 3 s, not 8, on the same reasoning as the block above: the last request
    // lands at FS + 19*256 = 1.11 s and at most three switches of 120 ms have to
    // drain behind it, so ~1.5 s is the floor and 3 s is twice it. The counts
    // this asserts are exact above that floor, not estimated near it.
    const lanes = new PitchLanes();
    const n = 3 * FS;
    const src = planes(n);
    const x = noise(n, 21, 0.3);
    for (let l = 0; l < PITCH_LANES; l++) { src[2 * l].set(x); src[2 * l + 1].set(x); }
    const at = [];
    for (let i = 0; i < 20; i++) at.push([FS + i * 256, ((i % 12) - 6) || 1]);
    run(lanes, src, n, 128, at);
    const s = lanes.stats();
    const last = at[at.length - 1][1];
    ok('a-dragged-control-queues-one-target-not-twenty: 20 requests in one switch window, and the last one is what lands',
      s.applied === last && s.pending === null && s.switching === false && s.switches <= 3
        && s.allocations === 2 * PITCH_SHIFTED_LANES.length,
      `${at.length} requests -> ${s.switches} switches, applied ${s.applied} (last requested ${last}), ${s.allocations} allocations`);
  }

  // ==================================================== 5. refusals and reset
  head('5. refusals and the discontinuity hook');
  {
    const lanes = new PitchLanes();
    lanes.setSemitones(3);
    const bad = [7, -7, 1.5, NaN, '3', null, undefined, Infinity];
    const refused = bad.every((v) => lanes.setSemitones(v) === false);
    ok('out-of-range-and-non-integer-intervals-are-refused-not-clamped',
      refused && lanes.target === 3,
      `target still ${lanes.target} after ${bad.length} bad requests`);

    // reset() must leave nothing of the previous stream behind: the first D
    // samples after it are silence, not 70 ms of the position we seeked away
    // from. This is docs/ARCHITECTURE.md §3.9 expressed as a measurement.
    const n = 2 * FS;
    const loud = planes(n);
    for (let l = 0; l < PITCH_LANES; l++) { loud[2 * l].fill(0.9); loud[2 * l + 1].fill(0.9); }
    const before = run(lanes, loud, n);
    let wasLoud = 0;
    for (let q = 0; q < PITCH_PLANES; q++) wasLoud = Math.max(wasLoud, Math.abs(before[q][n - 1]));
    lanes.reset();
    const silence = planes(D + 512);
    const out = run(lanes, silence, D + 512);
    let leak = 0;
    for (let q = 0; q < PITCH_PLANES; q++) for (let i = 0; i < D; i++) leak = Math.max(leak, Math.abs(out[q][i]));
    ok('reset-drops-the-history: nothing of the pre-seek stream survives into the first group delay',
      wasLoud > 0.5 && leak === 0,
      `${wasLoud.toFixed(3)} peak going in, ${leak.toExponential(2)} peak leak over ${D} samples x ${PITCH_PLANES} planes`);
    ok('reset-keeps-the-interval', lanes.target === 3 && lanes.applied === 3 && lanes.switching === false,
      `target ${lanes.target} applied ${lanes.applied}`);
  }

  // ==================================================== 6. the worklet copy
  head('6. the worklet copy');
  {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const wk = fs.readFileSync(path.join(here, '../offscreen/playback-processor.js'), 'utf8');
    /**
     * A COPY THAT IS ONLY PROMISED IS A COPY THAT HAS ALREADY DRIFTED.
     * shared/stemring.js:21-25 documents why the worklet has to duplicate rather
     * than import; this is the other half of that deal. Normalisation is exactly
     * two rules, both forced by the worklet being a classic script:
     *   - a leading `export ` cannot appear there
     *   - the `import ... from './pitch.js'` block cannot appear there
     * Anything else that differs is drift and goes red.
     */
    const norm = (s) => s
      .replace(/^import \{[\s\S]*?\} from '\.\/pitch\.js';\n/m, '')
      .replace(/^export /gm, '')
      .replace(/\s+$/, '');
    const cut = (s, file) => {
      const m = s.match(/\n\/\/ ={10,} self-check/);
      if (!m) throw new Error(`${file}: could not find the self-check banner`);
      return s.slice(0, m.index);
    };
    const between = (s, name) => {
      const open = `// ---8<--- BEGIN VERBATIM COPY: ${name} ---8<---\n`;
      const close = `// ---8<--- END VERBATIM COPY: ${name} ---8<---`;
      const a = s.indexOf(open), b = s.indexOf(close);
      if (a < 0 || b < 0) return null;
      return s.slice(a + open.length, b);
    };
    for (const file of ['pitch.js', 'pitchbank.js']) {
      const name = `extension/engine/${file}`;
      const want = norm(cut(fs.readFileSync(path.join(here, file), 'utf8'), file));
      const got = between(wk, name);
      let detail;
      if (got === null) detail = 'no BEGIN/END VERBATIM COPY markers in playback-processor.js';
      else if (norm(got) === want) detail = `${want.length} chars identical`;
      else {
        const g = norm(got);
        let i = 0;
        while (i < g.length && i < want.length && g[i] === want[i]) i++;
        detail = `DIFFERS: source ${want.length} chars, copy ${g.length} chars, first difference at char ${i}: ` +
          `source "${want.slice(i, i + 60).replace(/\n/g, '\\n')}" vs copy "${g.slice(i, i + 60).replace(/\n/g, '\\n')}"`;
      }
      ok(`worklet-copy-is-verbatim: ${name}`, got !== null && norm(got) === want, detail);
    }
  }

  // ============================================ 7. the SHIPPED worklet, driven
  //
  // REACHABILITY, not rendering. test.js:26-53 draws the line: a test that
  // CONSTRUCTS the state it is testing cannot prove the production path ever
  // reaches that state, and five groups in test.js are marked RENDERING ONLY for
  // exactly that reason. Everything above this point is rendering-only by the
  // same rule — it drives `PitchLanes` directly, which is the class the worklet
  // COPIES, not the worklet.
  //
  // This section loads `offscreen/playback-processor.js` — the shipped file,
  // byte for byte, the one the browser runs — into a VM with the three globals
  // an AudioWorkletGlobalScope provides, builds a ring the way the offscreen
  // document does, and pumps it 128 frames at a time. So it can see the things
  // the sections above structurally cannot: that the file parses in a scope with
  // no imports, that the processor constructs, that PASS 1 / PASS 2 / PASS 3 are
  // wired to each other, that `{t:'pitch'}` reaches the lanes, and that the
  // gains are downstream of the transpose rather than upstream.
  //
  // It is still not the browser: there is no real audio thread and no deadline
  // here. `tools/run-ext.mjs` is what covers that half.
  head('7. the shipped worklet, driven at the render quantum');
  {
    const vm = await import('node:vm');
    const here7 = path.dirname(url.fileURLToPath(import.meta.url));
    const wkPath = path.join(here7, '../offscreen/playback-processor.js');
    const wkSrc = fs.readFileSync(wkPath, 'utf8');

    const CAP = 1 << 16, HB = 128, NP = PITCH_PLANES, QN = 128;
    /** Build the worklet in a fresh realm and hand back a driver. */
    function boot() {
      let Registered = null;
      const posted = [];
      const sandbox = {
        sampleRate: FS,
        registerProcessor: (_name, cls) => { Registered = cls; },
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; } },
        Atomics, Float32Array, Float64Array, Int32Array, Math, Number, Array, Object,
      };
      vm.createContext(sandbox);
      new vm.Script(wkSrc, { filename: wkPath }).runInContext(sandbox);
      if (!Registered) throw new Error('playback-processor.js did not call registerProcessor');

      const sab = new ArrayBuffer(HB + CAP * 4 * NP);
      const hdr = new Int32Array(sab, 0, 32);
      const pl = [];
      for (let q = 0; q < NP; q++) pl.push(new Float32Array(sab, HB + q * CAP * 4, CAP));
      Atomics.store(hdr, 2, CAP);
      Atomics.store(hdr, 3, 1);                     // H_PLAY
      const proc = new Registered({ processorOptions: { sab, capacity: CAP, sampleRate: FS, panicFadeMs: 20, lowWaterSec: 0.05, meterHz: 30, healthHz: 10 } });
      const outs = [[new Float32Array(QN), new Float32Array(QN)]];
      let W = 0;
      return {
        proc, posted, hdr,
        send: (m) => proc.port.onmessage({ data: m }),
        /** Publish `src` on ONE stereo lane and pump it through, 128 at a time. */
        pump(lane, src, n, at) {
          const y = new Float32Array(n);
          // prime the ring so the very first quantum is not a starve
          for (let i = 0; i < 4096 && i < n; i++) { pl[2 * lane][(W + i) & (CAP - 1)] = src[i]; pl[2 * lane + 1][(W + i) & (CAP - 1)] = src[i]; }
          W += Math.min(4096, n);
          Atomics.store(hdr, 0, W);
          let got = 0;
          while (got + QN <= n) {
            if (at && at.k !== undefined && got >= at.at && !at.done) { this.send({ t: 'pitch', semitones: at.k }); at.done = true; }
            if (W + QN <= n) {
              for (let i = 0; i < QN; i++) { pl[2 * lane][(W + i) & (CAP - 1)] = src[W + i]; pl[2 * lane + 1][(W + i) & (CAP - 1)] = src[W + i]; }
              W += QN;
              Atomics.store(hdr, 0, W);
            }
            proc.process([], outs);
            y.set(outs[0][0], got);
            got += QN;
          }
          return { y, frames: got };
        },
        /**
         * Publish a CONSTANT per-plane level on all PITCH_PLANES planes and pump
         * n frames, returning both output channels. DC on purpose: at semitones
         * 0 every lane is a pure integer delay, so a constant in is the same
         * constant out and the sum is checkable to the last bit — which is what
         * the null test below needs and what a tone could not give.
         */
        pumpDC(vals, n) {
          const yL = new Float32Array(n), yR = new Float32Array(n);
          const put = (from, count) => {
            for (let q = 0; q < NP; q++) {
              const p2 = pl[q], v = vals[q];
              for (let i = 0; i < count; i++) p2[(from + i) & (CAP - 1)] = v;
            }
          };
          // The writer stays a fixed cushion AHEAD of the reader and `W` is
          // cumulative across calls. Bounding the writes by this call's `n` — as
          // `pump` above does, because it publishes a finite `src` — makes a
          // SECOND call on the same boot write nothing and the processor starve,
          // which drives the output to silence through the panic fade. That
          // would make every "the output is exactly zero" assertion below pass
          // for the wrong reason, so it is worth the four extra lines.
          put(W, 4096); W += 4096; Atomics.store(hdr, 0, W);
          let got = 0;
          while (got + QN <= n) {
            put(W, QN); W += QN; Atomics.store(hdr, 0, W);
            proc.process([], outs);
            yL.set(outs[0][0], got); yR.set(outs[0][1], got);
            got += QN;
          }
          return { yL, yR, frames: got };
        },
      };
    }

    // ---- a: drums (lane 0) at +6 must come out bit-exact, delayed by D.
    const nA = 3 * FS;
    const clicks = new Float32Array(nA);
    for (let t = 0; t < nA; t += Math.round(FS * 0.25)) {
      for (let i = 0; i < 24 && t + i < nA; i++) clicks[t + i] = 0.9 * Math.exp(-i / 4) * (i % 2 ? -1 : 1);
    }
    const A = boot();
    A.send({ t: 'pitch', semitones: 6 });
    const ra = A.pump(0, clicks, nA);
    let num = 0, den = 0, pk = 0;
    for (let i = 0; i < ra.frames - D; i++) {
      const d = ra.y[D + i] - clicks[i];
      num += d * d; den += clicks[i] * clicks[i];
      if (Math.abs(clicks[i]) > pk) pk = Math.abs(clicks[i]);
    }
    const dbA = den === 0 ? Infinity : 10 * Math.log10(num / den);
    ok('shipped-worklet-does-not-shift-the-drums-plane: planes 0/1 at +6 come out of the real processor delayed by 3072 and otherwise untouched',
      pk > 0.5 && dbA < -120, `${dbA.toFixed(1)} dB over ${((ra.frames - D) / FS).toFixed(1)} s, reference peak ${pk.toFixed(3)}`);

    // ---- b: bass (lane 1), 440 Hz, transposed to +5 mid-stream by a real
    // `{t:'pitch'}` message on the real port.
    const nB = 5 * FS;
    const tone = sine(nB, 440, 0.5);
    const B = boot();
    const rb = B.pump(1, tone, nB, { at: FS, k: 5 });
    const fB = peakHz(rb.y, rb.frames - 16384 - 1024);
    const wantB = 440 * Math.pow(2, 5 / 12);
    ok('shipped-worklet-transposes-on-a-real-{t:pitch}-message: 440 Hz on planes 2/3 reads 587.33 Hz out of the real processor',
      Number.isFinite(fB) && Math.abs(fB - wantB) < 1.0,
      Number.isFinite(fB) ? `${fB.toFixed(3)} Hz, want ${wantB.toFixed(3)}` : 'NO PEAK in the worklet output — that is the failure, not an excuse from it');

    // ---- c: the boundary. A malformed interval must be refused and counted,
    // and the refusal must be visible from OUTSIDE the render thread.
    B.send({ t: 'pitch', semitones: 9 });
    B.send({ t: 'pitch', semitones: 2.5 });
    B.send({ t: 'pitch', semitones: 'up' });
    B.send({ t: 'report', id: 42 });
    const rep = B.posted.filter((m) => m.t === 'report' && m.id === 42).pop();
    ok('shipped-worklet-refuses-a-malformed-interval-and-says-so-on-the-report-channel',
      !!rep && rep.pitch && rep.pitch.refused === 3 && rep.pitch.target === 5 && rep.pitch.delaySamples === D,
      rep ? JSON.stringify(rep.pitch) : 'the processor answered no report at all');

    // ---- d: the gains are DOWNSTREAM of the transpose. A mute must reach the
    // output on the mute ramp's own schedule (6 tau = 18 ms at TAU.mute), not
    // 18 ms + one group delay. This is the check that would go red if someone
    // moved the gain block back above `this.pitch.process`.
    const nC = 2 * FS;
    const dc = new Float32Array(nC).fill(0.5);
    const C = boot();
    // run past the group delay so the output is real audio, then mute lane 1
    const half = Math.round(0.5 * FS);
    const r1 = C.pump(1, dc, half);
    let live = 0;
    for (let i = half - 512; i < half; i++) live = Math.max(live, Math.abs(r1.y[i]));
    C.send({ t: 'gain', i: 1, value: 0, tau: 0.003 });
    const outs2 = [[new Float32Array(QN), new Float32Array(QN)]];
    void outs2;
    const r2 = C.pump(1, dc, Math.round(0.2 * FS));
    let silentAt = -1;
    for (let i = 0; i < r2.frames; i++) if (Math.abs(r2.y[i]) < 1e-9) { silentAt = i; break; }
    const muteMs = silentAt < 0 ? Infinity : (silentAt * 1000) / FS;
    ok('shipped-worklet-applies-the-stem-gain-DOWNSTREAM-of-the-transpose: mute reaches silence on the 6-tau ramp, not one group delay later',
      live > 0.4 && muteMs < 25,
      `${live.toFixed(3)} before the mute, silence ${muteMs === Infinity ? 'never reached' : muteMs.toFixed(1) + ' ms'} after it ` +
      `(6 tau = 18.0 ms; upstream gains would make this ~88 ms — one group delay is ${(D * 1000 / FS).toFixed(1)} ms)`);

    // ---- e/f/g: the WIDTH of the mixer, driven through the real processor.
    //
    // PASS 1 and PASS 3 in playback-processor.js were hand-unrolled for four
    // stems — ten named plane reads, `pk0..pk3`, a five-term sum — and are now
    // rolled over NSTEMS. That roll is the highest-risk edit in the six-stem
    // migration and nothing outside a browser drove it, so it is driven here,
    // on the shipped file, at the render quantum.
    //
    // Every lane gets a DIFFERENT DC level, so a swapped plane pair, an
    // off-by-one gain slot and a meter wired to the wrong lane are three
    // distinguishable failures rather than one.
    const NST = PITCH_LANES - 1;                 // stems; the last lane is the passthrough
    const P_L = 2 * NST, P_R = 2 * NST + 1;
    const G_PASS = NST, G_MASTER = NST + 1;
    const lvl = new Array(PITCH_PLANES).fill(0);
    for (let k = 0; k < NST; k++) { lvl[2 * k] = 0.02 * (k + 1); lvl[2 * k + 1] = -0.02 * (k + 1); }
    lvl[P_L] = 0.1; lvl[P_R] = -0.1;
    const stemSum = lvl.slice(0, 2 * NST).filter((_v, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
    const nE = 2 * FS;

    {
      const E = boot();
      E.pumpDC(lvl, nE);
      const met = E.posted.filter((m) => m.t === 'meters').pop();
      let worst = 0, worstK = -1;
      if (met) {
        for (let k = 0; k < NST; k++) {
          const e = Math.abs(met.peak[k] - 0.02 * (k + 1));
          if (e > worst) { worst = e; worstK = k; }
        }
      }
      const wantMaster = stemSum + lvl[P_L];
      ok(`shipped-worklet-meters-${NST}-stems-post-fader-and-never-the-passthrough: ${NST} channel taps plus the master, each reading its OWN lane`,
        !!met && met.peak.length === NST + 1 && met.rms.length === NST + 1
          && worst < 1e-6 && Math.abs(met.peak[NST] - wantMaster) < 1e-6,
        met ? `${met.peak.length} taps, worst channel error ${worst.toExponential(1)} at stem ${worstK}, master ${met.peak[NST].toFixed(4)} want ${wantMaster.toFixed(4)} (stems ${stemSum.toFixed(2)} + passthrough ${lvl[P_L]})`
          : 'the processor posted NO meters message at all — that is the failure, not an excuse from it');
    }

    {
      // THE NULL TEST. Rolling the sum must not turn an exactly-zero mix into a
      // 1e-18 one: `0 + y === y` for every finite y is the reason the rolled
      // accumulator is bit-identical to the unrolled literal sum, and this is
      // the assertion that says so on the shipped file.
      const F = boot();
      const r0 = F.pumpDC(lvl, Math.round(0.3 * FS));
      // The reference. Zero output is the CLAIM here, so "it was loud a moment
      // ago" has to be measured too — a starved processor fades to exactly zero
      // as well, and this assertion could not tell the two apart without it.
      const live = Math.abs(r0.yL[r0.frames - 1]);
      for (let i = 0; i <= G_PASS; i++) F.send({ t: 'gain', i, value: 0, tau: 0.003 });
      const r = F.pumpDC(lvl, Math.round(0.3 * FS));
      let nz = 0; const from = Math.round(0.05 * FS);
      for (let i = from; i < r.frames; i++) if (r.yL[i] !== 0 || r.yR[i] !== 0) nz++;
      ok(`shipped-worklet-sums-to-EXACT-zero-with-all-${NST}-stems-and-the-passthrough-muted`,
        r.frames > from && Math.abs(live - (stemSum + lvl[P_L])) < 1e-6 && nz === 0,
        `${live.toFixed(4)} on the bus before the mute (want ${(stemSum + lvl[P_L]).toFixed(4)}), ` +
        `${r.frames - from} samples inspected past the 6-tau ramp, ${nz} of them non-zero`);
    }

    {
      // THE SLOT MAP, which the wire protocol's JSDoc claims and nothing checked:
      // 0..NST-1 stems, NST passthrough, NST+1 master. Muting the passthrough
      // must remove EXACTLY the passthrough; muting the master must remove
      // everything. Two positive claims, one boot each so neither can mask the
      // other.
      const G = boot();
      G.pumpDC(lvl, Math.round(0.3 * FS));
      G.send({ t: 'gain', i: G_PASS, value: 0, tau: 0.003 });
      const rp = G.pumpDC(lvl, Math.round(0.3 * FS));
      const settled = Math.round(0.05 * FS);
      let passErr = 0;
      for (let i = settled; i < rp.frames; i++) passErr = Math.max(passErr, Math.abs(rp.yL[i] - stemSum));

      const H = boot();
      const h0 = H.pumpDC(lvl, Math.round(0.3 * FS));
      const hLive = Math.abs(h0.yL[h0.frames - 1]);
      H.send({ t: 'gain', i: G_MASTER, value: 0, tau: 0.003 });
      const rm = H.pumpDC(lvl, Math.round(0.3 * FS));
      let mNz = 0;
      for (let i = settled; i < rm.frames; i++) if (rm.yL[i] !== 0) mNz++;

      ok(`shipped-worklet-gain-slot-map-is-0..${NST - 1}-stems-${G_PASS}-passthrough-${G_MASTER}-master`,
        rp.frames > settled && rm.frames > settled
          && Math.abs(hLive - (stemSum + lvl[P_L])) < 1e-6 && passErr < 1e-6 && mNz === 0,
        `slot ${G_PASS} left the ${NST} stems at ${stemSum.toFixed(2)} (worst error ${passErr.toExponential(1)}), ` +
        `slot ${G_MASTER} left ${mNz} non-zero samples of ${rm.frames - settled} from a bus carrying ${hLive.toFixed(4)}`);
    }
  }

  // ==================================================== 8. cost
  head('8. cost per render quantum');
  {
    const Q = 128, quantumMs = (Q / FS) * 1000;
    /**
     * Wall-clock, ONE deck, 800 quanta — A TENTH OF WHAT THIS USED TO SAMPLE.
     *
     * WITHDRAWN, 2026-08-16, NOT LOST: this function used to run 8000
     * quanta at three intervals, ~30 s of the suite's ~40 s, and the millisecond
     * figures it produced are UNINTERPRETABLE ON A CONTENDED MACHINE. The
     * evidence is in the header's COST section — three runs of identical code
     * put p95 at 0.997 / 0.991 / 1.685 ms and max at 4.17 / 4.08 / 23.55, and
     * the third fired a red on a gate the first two cleared by 30 %, while the
     * frame counts underneath were bit-identical all three times.
     *
     * A gate that goes red on unmodified code is not slow, it is broken. So the
     * deadline ruling moved to `bank-peak-frame-concentration-...` below, which
     * counts, and what is left here is a 2x smoke check on the MEDIAN. Do not
     * grow it back without re-reading that table; the sample size was never the
     * problem, the estimator was.
     */
    const measure = (k, quanta = 800) => {
      const lanes = new PitchLanes({ maxBlock: Q });
      lanes.setSemitones(k);
      const ib = planes(Q), ob = planes(Q);
      let ph = 0;
      for (let q = 0; q < 300; q++) lanes.process(ib, ob, Q);   // burn the switch off
      const t = [];
      for (let q = 0; q < quanta; q++) {
        for (let i = 0; i < Q; i++) {
          const v = 0.4 * Math.sin(ph) + 0.2 * Math.sin(ph * 2.51);
          for (let l = 0; l < PITCH_LANES; l++) { ib[2 * l][i] = v; ib[2 * l + 1][i] = v * 0.9; }
          ph += 2 * Math.PI * 220 / FS;
        }
        const t0 = process.hrtime.bigint();
        lanes.process(ib, ob, Q);
        t.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      t.sort((a, b) => a - b);
      return {
        n: t.length,
        mean: t.reduce((a, b) => a + b, 0) / t.length,
        p50: t[t.length >> 1], p95: t[Math.floor(0.95 * t.length)], max: t[t.length - 1],
      };
    };

    /**
     * PEAK FRAME CONCENTRATION — how many shifters take an STFT frame in the
     * SAME render quantum, counted off the shifters' own `stats.frames`. No
     * clock is read, so the answer is identical on an idle machine and on one
     * with eight agents on it, and it is comparable across processes and
     * sessions. `frames` and `quanta` come back so the caller can prove the
     * measurement looked at something.
     */
    const concentration = (ks, quanta) => {
      const decks = ks.map(() => new PitchLanes({ maxBlock: Q }));
      decks.forEach((d, i) => d.setSemitones(ks[i]));
      const ib = planes(Q), ob = planes(Q);
      // long enough for every switch to latch, so `cur` is stable below
      for (let q = 0; q < 400; q++) for (const d of decks) d.process(ib, ob, Q);
      const units = [];
      for (const d of decks) for (const l of PITCH_SHIFTED_LANES) units.push(d.cur.sh[l]);
      const prev = units.map((u) => u.stats.frames);
      let peak = 0, frames = 0, ph = 0;
      for (let q = 0; q < quanta; q++) {
        for (let i = 0; i < Q; i++) {
          const v = 0.4 * Math.sin(ph) + 0.2 * Math.sin(ph * 2.51);
          for (let l = 0; l < PITCH_LANES; l++) { ib[2 * l][i] = v; ib[2 * l + 1][i] = v * 0.9; }
          ph += 2 * Math.PI * 220 / FS;
        }
        for (const d of decks) d.process(ib, ob, Q);
        let n = 0;
        for (let u = 0; u < units.length; u++) { const f = units[u].stats.frames; n += f - prev[u]; prev[u] = f; }
        if (n > peak) peak = n;
        frames += n;
      }
      return { peak, frames, quanta, units: units.length, mean: frames / quanta };
    };
    /**
     * ============ WHAT USED TO BE HERE, AND WHY IT IS NOT (2026-08-16)
     *
     * Three 8000-quantum wall-clock rows — semitones 0, +6 and -6 — plus a
     * 4000-quantum burn-in. About 30 s of a ~40 s suite. WITHDRAWN AS
     * UNINTERPRETABLE ON A CONTENDED MACHINE, superseded by the frame COUNT
     * below. Deleting a measurement without its reason leaves a hole someone
     * re-digs, so here is the whole record:
     *
     *   three runs, IDENTICAL CODE, `1 deck at +6`, 8000 quanta
     *     p95    0.997   0.991   1.685    <- 69 % swing; the third fired a RED
     *     max    4.173   4.077  23.554       on a gate the first two cleared
     *     p50    0.737   0.734   0.802       by 30 %
     *   the frame counts underneath, same three runs
     *     peak       5       5       5    <- identical
     *     mean   3.182   3.182   3.182
     *     frames  6364    6364    6364
     *
     * The obvious repair — keep a smoke check, sample it at a tenth, gate the
     * MEDIAN with 1.8x headroom — WAS TRIED AND FAILED, and the failure is
     * worth recording because it is counter-intuitive: at 800 quanta the median
     * read 1.872 / 0.918 / 0.743 ms across three runs and the first went red.
     * SHRINKING THE WINDOW MADE IT WORSE. 8000 samples could dilute a slow
     * start; 800 cannot, so the median inherited the warm-up that the p95 used
     * to hide. There is no window size that fixes an estimator problem.
     *
     * The warm-up itself is real and separate from contention: `1 deck at +6`
     * reads ~1.7-2.0 ms cold and ~0.77 ms warm, FLAT across every timed quantum
     * either way, so it never appears as a trend inside a row. Section 7 causes
     * it by driving four processors at semitones 0, which makes `_bankRun`'s
     * `unit.process` call site polymorphic (MatchedDelay AND PitchShifter).
     *
     * WHAT WAS DELETED, BY NAME, so a `git log` reader and a drift banner agree:
     *
     *     median-cost-at-+6-leaves-half-the-quantum-for-everything-else
     *
     * is GONE, not renamed and not shrunk. It began the day as
     * `cost-at-+6-leaves-half-the-quantum-for-everything-else` reading p95, was
     * relabelled to the median when the p95 fired a false red, and was cut when
     * the median fired one too. Assertion count 29 -> 28, deliberately. If a
     * coverage-drift banner shows that pair, this paragraph is the reason.
     *
     * WHAT SURVIVES, and why each one earns its place:
     *   - `concentration()`, which reads no clock. It carries the deadline.
     *   - the semitones-0 row, which is 0.005 ms against a 0.145 ms gate — 29x
     *     headroom, bit-stable across every run above including the cold one,
     *     and it guards the state EVERY user is in by default.
     *
     * If you want a wall-clock regression alarm, build it somewhere that can
     * hold still for 300 s (`AGENTS.md`), not inside `--quick`.
     */
    /**
     * `concentration()` RUNS FIRST ON PURPOSE — do not reorder this to put the
     * timing above it. It reads no clock, so its own numbers are indifferent to
     * optimiser state, and running it first leaves `PitchLanes.process` and
     * `_bankRun` warm for the semitones-0 row below. That is why this section no
     * longer needs the dedicated 4000-quantum burn-in it used to carry: two
     * decks x 2400 quanta is strictly more shifter work, for free.
     */
    const conc = concentration([6, -6], 2000);
    const z = measure(0);
    console.log(`      2 decks +6/-6, FRAMES per quantum: peak ${conc.peak}, mean ${conc.mean.toFixed(3)}, over ${conc.quanta} quanta of ${conc.units} shifters  [the ruling number — counted, not timed]`);
    console.log(`      1 deck, semitones 0: mean ${z.mean.toFixed(3)} ms  p50 ${z.p50.toFixed(3)}  p95 ${z.p95.toFixed(3)}  max ${z.max.toFixed(3)}  over ${z.n} quanta  [the DEFAULT state]`);
    ok('cost-at-semitones-0-is-negligible (the default state, and every soak this project has already run)',
      z.mean < 0.05 * quantumMs, `${z.mean.toFixed(3)} ms of a ${quantumMs.toFixed(3)} ms quantum, ${z.n} quanta`);

    /**
     * ======================= THE DEADLINE, AND WHY IT IS COUNTED, NOT TIMED
     *
     * PICK THE ESTIMATOR FOR THE CLAIM (AGENTS.md). The claim is "the bank's
     * worst-case work in one render quantum has not regressed past what the
     * shipped build carried". The obvious estimator — wall-clock p95 against
     * 2.902 ms — CANNOT CARRY IT ON THIS MACHINE. `cost-at-+6`'s p95 was
     * observed at 1.204, 1.639 and 1.643 ms across three runs of one build, a
     * 36 % spread; the parity track saw ~25 % between sessions on the same box;
     * and `AGENTS.md` wants >= 300 s for a median where the row above times
     * ~6 s of wall clock. An absolute gate here is a false-red generator, and a
     * suite that cries wolf is the expensive failure, not the cheap one.
     *
     * So this counts instead of timing. The bank's cost per quantum is
     * `lanes * resampler + framesThisQuantum * frame`; the resampler term is
     * every lane every quantum and no scheduling can change it, so the ONLY
     * thing the stagger can move — and the only thing that regressed when the
     * model widened — is how many STFT frames pile into one quantum. That is an
     * integer. No clock is read, the value is identical on a quiet machine and
     * on one with eight agents on it, and it is comparable across processes and
     * across sessions, which is what lets it be gated against the FOUR-lane
     * build rather than against a number from today.
     *
     * Measured this way, deterministically, two decks both transposed:
     *
     *     4 lanes, grids colliding  (the build that shipped)   peak  8
     *     6 lanes, grids colliding                             peak 12
     *     6 lanes, staggered        (this build)               peak  5
     *
     * The mean is exactly 1.5x the four-lane build in both terms (2.121 ->
     * 3.182 frames per quantum, and 8 -> 12 lanes of resampler): six stems do
     * one and a half times the work and nothing can make them not. What the
     * stagger buys is the PEAK, and it buys enough of it that the six-lane peak
     * is BELOW the four-lane build's own.
     */
    /**
     * ===================== IS THE STAGGER ACTUALLY ON THE BANK THAT IS RUNNING
     *
     * The concentration assertion below reads a CONSEQUENCE. This one reads the
     * CAUSE, and it exists because QA saw `PITCH_GRID_OFFSETS` print as
     * `[0,0,0,0,0,0]` on one run and `[0,128,256,384,0,128]` on another ten
     * minutes later. (That was a tree mid-edit — five collide-baselines were
     * taken by zeroing the vector — but "the vector was not applied" and "the
     * vector was applied and something undid it" produce the same p95, and a
     * timing assertion on a contended machine names neither.)
     *
     * THE INVARIANT: every lane of a bank is fed the same number of samples by
     * `_bankRun`, and `_bankSet` leaves lane i's shifter having consumed exactly
     * `PITCH_GRID_OFFSETS[i]`. So `outCount[i] - outCount[0]` equals the offset
     * vector, on every bank, forever, whatever the deck has been through. It is
     * an integer identity — no clock, no percentile, no machine.
     *
     * TWO HALVES, because either alone passes vacuously. A vector of all zeros
     * IS "applied" in the trivial sense, so the first half asserts the constant
     * separates the lanes into distinct render quanta at all; the second asserts
     * the running banks carry it. QA's observed `[0,0,0,0,0,0]` fails the first.
     *
     * THE `semi === 0` EXCEPTION IS ENCODED, NOT DOCUMENTED-AND-SKIPPED
     * (AGENTS.md: an assertion whose comment describes an exception must encode
     * it). At 0 semitones `_bankRun` selects `bank.md[l]`, a pure integer delay
     * with no STFT grid — those banks have nothing to stagger and their idle
     * shifters legitimately sit at phase 0. That is only safe if the delay lines
     * are really there, so the exception CHECKS for them rather than assuming.
     */
    {
      const q = PITCH_SYNTH_HOP / 128;
      const spread = new Set(PITCH_GRID_OFFSETS.map((o) => Math.floor(o / 128) % q)).size;
      const wantSpread = Math.min(PITCH_SHIFTED_LANES.length, q);
      const want = PITCH_GRID_OFFSETS.map((o) => o - PITCH_GRID_OFFSETS[0]);
      const ibG = planes(Q), obG = planes(Q);
      const spin = (l, n) => { for (let i = 0; i < n; i++) l.process(ibG, obG, Q); };

      let banks = 0, shifted = 0, bad = 0;
      const note = [];
      const inspect = (label, lanes) => {
        for (const bank of lanes.banks) {
          banks++;
          if (bank.semi === 0) {
            // the encoded exception: delay lanes, positively verified
            if (!PITCH_SHIFTED_LANES.every((l) => bank.md[l] && typeof bank.md[l].process === 'function')) {
              bad++; note.push(`${label}: a semitones-0 bank has no MatchedDelay to run`);
            }
            continue;
          }
          if (!bank.sh) { bad++; note.push(`${label}: bank at ${bank.semi} has NO shifters`); continue; }
          const oc = PITCH_SHIFTED_LANES.map((l) => bank.sh[l].outCount);
          if (!oc.every((v) => Number.isFinite(v))) { bad++; note.push(`${label}: outCount unreadable — that is the failure, not an excuse from it`); continue; }
          shifted++;
          const got = oc.map((v) => v - oc[0]);
          if (!got.every((v, i) => v === want[i])) { bad++; note.push(`${label}: phases ${JSON.stringify(got)} != ${JSON.stringify(want)}`); }
        }
      };

      // Every way a bank can reach a running state. Cheap: a few hundred quanta each.
      { const l = new PitchLanes({ maxBlock: Q }); l.setSemitones(6); inspect('first engage, unrendered', l);
        spin(l, 60); inspect('first engage, mid-switch', l);
        spin(l, 240); inspect('first engage, latched', l); }
      { const l = new PitchLanes({ maxBlock: Q }); l.setSemitones(6); spin(l, 300);
        l.setSemitones(-6); spin(l, 300); inspect('second switch', l);
        l.setSemitones(0); spin(l, 300); inspect('back down to 0', l);
        l.setSemitones(5); spin(l, 300); inspect('re-engaged from 0', l); }
      { const l = new PitchLanes({ maxBlock: Q }); l.setSemitones(6); spin(l, 300);
        l.reset(); spin(l, 300); inspect('reset() at +6 — the seek path', l); }
      { const l = new PitchLanes({ maxBlock: Q }); l.setSemitones(6); spin(l, 20);
        l.reset(); spin(l, 300); inspect('reset() DURING a switch', l); }
      { const l = new PitchLanes({ maxBlock: Q }); l.setSemitones(6); spin(l, 5);
        for (let i = 0; i < 20; i++) { l.setSemitones(((i % 12) - 6) || 1); spin(l, 3); }
        spin(l, 600); inspect('dragged control', l); }
      { // the worklet's quantum-change rebuild, verbatim from playback-processor.js
        const l = new PitchLanes({ sampleRate: FS, maxBlock: 256 });
        l.target = -4; l.reset();
        const ib2 = planes(256), ob2 = planes(256);
        for (let i = 0; i < 150; i++) l.process(ib2, ob2, 256);
        inspect('worklet rebuild at a wider quantum', l); }

      ok(`every-running-bank-has-the-frame-grid-stagger-applied: PitchLanes._bankSet() on all ${banks} bank states nine construction paths reach, and PITCH_GRID_OFFSETS separates ${wantSpread} render quanta`,
        spread === wantSpread && shifted > 0 && banks > 0 && bad === 0,
        bad ? note.slice(0, 3).join(' | ')
          : `${shifted} shifter banks carry ${JSON.stringify(want)}, ${banks - shifted} at semitones 0 run MatchedDelay, offsets span ${spread}/${wantSpread} quanta of the ${PITCH_SYNTH_HOP}-sample hop`);
    }

    const peakRef = 2 * 4;         // two decks x the four-lane build's four lanes
    const c = conc;                // measured at the top of this section, printed there
    /**
     * It cannot pass without looking. `quanta` is the number of quanta actually
     * stepped, `units` is the shifter list it read the counters off, and
     * `frames` is the total it saw move — so an empty `PITCH_SHIFTED_LANES`, a
     * loop that never ran, or a `stats.frames` that stopped being incremented
     * all fail here rather than reporting a comfortable peak of nothing.
     */
    ok(`bank-peak-frame-concentration-at-the-configured-shifter-count: PitchLanes.process(), 128-frame quantum, Mode 3 steady state (two decks, +6 and -6) — at most ${peakRef} shifters may take an STFT frame in any one quantum, which is what the four-lane build carried`,
      c.quanta === 2000 && c.units === 2 * PITCH_SHIFTED_LANES.length && c.frames > 0 && c.peak <= peakRef,
      `peak ${c.peak} of ${c.units} shifters (four-lane reference ${peakRef}), mean ${c.mean.toFixed(3)}, ` +
      `${c.frames} frames counted over ${c.quanta} quanta, ` +
      `${PITCH_SHIFTED_LANES.length} lanes staggered by ${JSON.stringify(PITCH_GRID_OFFSETS)}`);
  }

  console.log(fail ? `\n\x1b[31m${fail} FAILURE(S)\x1b[0m of ${pass + fail}\n` : `\nall ${pass} pitchbank checks passed\n`);
  process.exit(fail ? 1 : 0);
}

// Node only, and only when this file IS the entry point.
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return selfCheck();
  }).catch((e) => { console.error(e); process.exit(1); });
}
