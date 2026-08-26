/**
 * The drum tap — bpmtap.js's sibling on the same plane, asking a different
 * question. bpmtap asks WHEN the beats are; this asks WHAT was hit.
 *
 *   stem ring planes 0/1 (`drums`)         WIRE ORDER, upstream of the shifter
 *     -> 3-band crossover, per channel     150 Hz / 3000 Hz, one-pole-squared
 *     -> per-band RMS per 441-frame hop    100 Hz "band envelope", NO normalisation
 *     -> half-wave-rectified difference    the per-band spectral flux
 *     -> sum the three -> detection fn     PRE-normalisation, unlike bpmtap's
 *     -> peak-pick                         floor, adaptive median x 1.8,
 *                                          attack ratio, ~50 ms refractory
 *     -> classify by dominant band         GM 36 / 38 / 42 / 49, channel 10
 *     -> { pitch, vel, onFrame }
 *
 * `node extension/engine/drumtap.js` runs the checks.
 *
 * ------------------------------------------------- WHY THIS FILE EXISTS AT ALL
 *
 * The MIDI converter runs Spotify's Basic Pitch over the five PITCHED stems.
 * BASIC PITCH NEVER SEES DRUMS. That is a decision, not an oversight, and the
 * reason is worth stating because the tempting shortcut looks free: a note
 * transcriber pointed at a drum stem does not produce an empty file, it produces
 * a WRONG one. Toms and snare bodies are pitched enough to light up the note
 * head, so they come out as spurious sustained low notes that a reader would
 * take for a bass line. There is no permissively-licensed ONNX drum transcriber
 * in existence to swap in — every candidate is non-commercial, unlicensed, or
 * piano-only — so drums get hand-written DSP or they get a lie. See ADR 0002 and
 * the owner's ruling R4. DO NOT promise "empty" anywhere: the promise this file
 * makes is a coarse four-piece kit, and the ceiling is written out below.
 *
 * ---------------------------------------- THIS IS NOT A REUSE OF bpmtap.js
 *
 * It shares bpmtap.js's CROSSOVER DESIGN — 150 Hz and 3000 Hz, one-pole-squared
 * sections, three bands, a 441-frame / 100 Hz hop, a half-wave-rectified
 * difference. It does NOT and CANNOT share bpmtap.js's envelope, and that is the
 * whole reason this is a second module rather than three lines added to the
 * first one.
 *
 * bpmtap.js scales every band to unit RMS over its analysis window BEFORE the
 * three are summed, and says so in as many words in two places:
 *
 *     "PER-BAND NORMALISATION, then sum. This is the octave fix"   (_estimate)
 *     "Equalising them is the whole point: it makes a kick and a snare the
 *      same size"                                    (above its BAND_LO_HZ)
 *
 * Making a kick and a snare the same size is exactly the cue a CLASSIFIER needs,
 * and by the time bpmtap's envelope exists it has been deliberately deleted. The
 * normalisation is not a detail of bpmtap that could be made optional either: it
 * is the mechanism that stops a backbeat reading as half-tempo, so a flag that
 * turned it off would be a flag that breaks the tempo readout. Two consumers,
 * two opposite requirements, two envelopes. This file therefore keeps the THREE
 * PRE-NORMALISATION band envelopes and never sums a normalised one.
 *
 * -------------------------------------- WHERE THE CROSSOVER IS APPLIED, AND WHY
 *                                        IT IS NOT WHERE bpmtap.js APPLIES IT
 *
 * bpmtap.js filters `sqrt((L^2 + R^2) / 2)` — the RECTIFIED MAGNITUDE of the
 * audio, not the audio. That is fine for what it needs: rectification turns every
 * transient into a step regardless of its pitch, so all three of its bands see
 * every hit and the ONLY thing it asks of the split is that a kick and a hat
 * weight the three differently enough to break an octave tie.
 *
 * It is NOT fine here, and the failure is quiet. Rectifying a tone puts a large
 * DC term in the result (mean |sin| = 0.6366 of peak), and DC lands in the
 * low band whatever the tone was: under bpmtap's placement a 6 kHz sine burst
 * reads as MORE low-band than high-band, i.e. as a kick. A tempo detector cannot
 * tell and does not care; a classifier would emit note 36 for a hi-hat and be
 * confidently, silently wrong.
 *
 * So this tap runs the same crossover over the SIGNAL, per channel, and forms
 * the per-channel energy afterwards. `crossover-is-on-the-signal-not-the-
 * rectified-magnitude` in the self-check is the tripwire: it measures both
 * placements on the same two bursts and asserts that bpmtap's placement FAILS
 * the band-separation claim this file depends on. That control is the evidence
 * for this paragraph; without it this is just an opinion in a comment.
 *
 * The bands are LP150^2 / (HP150^2 -> LP3000^2) / (HP150^2 -> HP3000^2). They
 * are not power-complementary — a little energy sits in each transition and is
 * counted in neither neighbour — and that is deliberate rather than tolerated:
 * the complementary form bpmtap uses (`mid = z3 - z1`, `hi = x - z3`) is only
 * 6 dB/oct on the high side because `1 - LP^2` is not `HP^2`, which puts 33 % of
 * a 55 Hz kick's energy OUTSIDE the low band. The classifier compares bands
 * against each other, so a loss common to all three cannot move an argmax, and
 * a genuine 12 dB/oct skirt can.
 *
 * ---------------------------------------------- TWO ENVELOPES, AND WHICH IS WHICH
 *
 * Read this before changing `classify` or `_advance`. There are two per-band
 * quantities here and they answer different questions:
 *
 *   LEVEL  m[b][t]    the band's RMS over hop t. It rises at a hit and DECAYS
 *                     afterwards. This is "the band envelope".
 *   FLUX   f[b][t]    max(0, m[b][t] - m[b][t-1]). Rises only. This is the onset
 *                     detection function, and its sum over the three bands is
 *                     what the peak-picker looks at.
 *
 * The flux says WHEN. The levels say WHAT — `classify()` takes levels, all four
 * of its arguments, and that is forced rather than chosen: the hat/crash decision
 * is `hiLater >= DRUM_CRASH_SUSTAIN * hi`, a ratio of the same quantity 200 ms
 * apart, and a flux cannot decay. A half-wave-rectified difference of a decaying
 * cymbal is zero at every frame after the strike, so a flux-based decay test
 * would return "hat" for every cymbal ever recorded and would look like it was
 * working.
 *
 * On an ISOLATED hit the two orderings are identical, because the previous hop's
 * level is ~0 and the flux IS the level. They differ when a hit lands on the tail
 * of another one.
 *
 * ponytail: CEILING — a hi-hat struck 30 ms into a ringing crash is classified
 * against the crash's tail as well as its own transient, so a dense cymbal
 * passage over-reports 49. UPGRADE PATH — vote: take dominance from the flux
 * (which ignores the tail) and the decay test from the level, i.e. two more
 * arguments to `classify` and a re-tuned rule, measured on a real kit recording.
 * It is not a cleanup, it is a second classifier, and the four-piece kit this
 * file promises does not need it.
 *
 * ------------------------------------------------- WHAT THIS IS ALLOWED TO GET WRONG
 *
 * The kit is FOUR pieces. Toms, rides, open hats, rimshots and every piece of
 * hand percussion collapse into the nearest of 36/38/42/49 — a floor tom reads
 * as a kick, a ride reads as a crash or a hat depending on how long it rings.
 * That is a coarse transcription of a real performance, not a wrong one, and the
 * rhythm is right in every case.
 *
 * The sharp edge, named rather than discovered: THE MID BAND IS 150-3000 Hz AND
 * A VERY BRIGHT SNARE IS NOT IN IT. A snare whose energy is mostly wire buzz
 * above 3 kHz is air-band dominant and comes out as 42. That is the one
 * misclassification that changes how a bar reads, and it is why the one-class
 * fallback below exists and is one constant away.
 *
 * ponytail: CEILING — onset times are quantised to the 100 Hz envelope grid and
 * reported at the START of the hop the rise was measured in, so a hit is placed
 * within one hop (10 ms) and biased early by up to that much. UPGRADE PATH —
 * parabolic interpolation over the three flux values around the peak buys
 * sub-hop placement for about ten lines, and it is not taken here because
 * `offscreen/transcribe.js` rounds the wire to 1 ms on top of a tab-capture
 * delay that has never been measured; sharpening one term of a sum whose larger
 * term is unknown is arithmetic, not accuracy.
 *
 * ------------------------------------------------------------ WHAT IT PRODUCES
 *
 * `feed()` returns `{ pitch, vel, onFrame }` — an absolute stem-ring output
 * frame, on the caller's own clock. It deliberately does NOT return a duration:
 * DRUM NOTES ARE FIXED-LENGTH GATES (DRUM_NOTE_MS, 60 ms) and the length is
 * applied by `offscreen/transcribe.js` at the same moment it maps `onFrame` to a
 * source second, so what reaches the pack builder is
 * `{ pitch, vel, onSec, offSec }` — the same shape `engine/notes.js` hands it
 * for the five pitched lanes, and one code path downstream. A percussive onset
 * has no measurable release and a MIDI note-off on channel 10 is ignored by
 * every General MIDI kit anyway; a "measured" drum duration would be a number
 * with nothing behind it.
 *
 * PURE ARITHMETIC. No browser API, no `chrome.`, no clock, no allocation per
 * frame. It is fed hop-sized blocks and carries its filter, envelope and
 * peak-picker state across calls, so block-wise input and one-shot input give
 * byte-identical onsets — asserted, because that is the property the live ring
 * tap depends on and it is invisible in review when it breaks.
 */

/**
 * `drums` is stem index 0, so it is planes 0 and 1 — `stemIdx * 2 + ch`, WIRE
 * ORDER. `shared/stemring.js` PLANES is the authority.
 *
 * Same tripwire as bpmtap.js's, and for a sharper reason: a reorder would point
 * this tap at `bass`, which has onsets, so it would keep emitting a plausible
 * drum part built out of a bass line and nothing downstream could tell.
 */
export const DRUM_TAP_PLANE_L = 0;
export const DRUM_TAP_PLANE_R = 1;

/**
 * Envelope hop, frames. 441 = exactly 1/100 s at 44 100, so the envelope rate is
 * an integer 100 Hz and every millisecond constant below converts to a whole
 * number of hops with no rounding: 50 ms refractory = 5, 200 ms lookahead = 20,
 * 400 ms median window = 40. That is the only reason these numbers are quoted in
 * milliseconds at all.
 */
export const DRUM_ENV_HOP = 441;
export const DRUM_ENV_RATE = 44100 / DRUM_ENV_HOP;      // 100 Hz, integer by construction

/**
 * The crossover. THE SAME TWO FREQUENCIES bpmtap.js USES, and they are here
 * rather than imported because bpmtap.js keeps them private (`const BAND_LO_HZ`)
 * and exporting them to share two numbers would couple a display-only tempo
 * label to a transcription. `the-crossover-is-bpmtaps` in the self-check pins the
 * literals; if bpmtap's ever move, that assertion is where the two files are
 * reconciled.
 *
 * 150 Hz separates a kick's fundamental (40-80 Hz) from a snare's body
 * (150-400 Hz). 3000 Hz separates a snare's body from a cymbal's air.
 */
export const DRUM_BAND_LO_HZ = 150;
export const DRUM_BAND_HI_HZ = 3000;
/** sub / body / air. Three, and there is no fourth: see "WHAT THIS IS ALLOWED TO GET WRONG". */
export const DRUM_NBANDS = 3;

/**
 * Adaptive threshold: a peak must beat DRUM_MEDIAN_MULT x the median of the last
 * DRUM_MEDIAN_FRAMES frames of the detection function.
 *
 * 40 frames = 400 ms, which is a little under one beat at 150 BPM. Longer and a
 * fill raises the threshold for the bar after it; shorter and a single loud hit
 * dominates its own window. A MEDIAN and not a mean because the thing we are
 * trying to reject is exactly the outlier we are trying to detect: one loud kick
 * moves a 40-frame mean by 2.5 % of itself and moves the median by nothing.
 */
export const DRUM_MEDIAN_FRAMES = 40;
export const DRUM_MEDIAN_MULT = 1.8;

/**
 * THE ADAPTIVE THRESHOLD CANNOT REFUSE SILENCE, so this floor does.
 *
 * The detection function is half-wave rectified, so on a stem with no drums in
 * it the last 40 frames are all exactly 0, the median is 0, and
 * `d > DRUM_MEDIAN_MULT * 0` is true for any ripple at all — a gate whose
 * threshold is a multiple of its input can always be passed by an input of zero.
 * That is the shape AGENTS.md calls an assertion that cannot fail, one level
 * down in the code it is asserting about.
 *
 * DERIVED, not chosen: it is the smallest flux that could produce velocity 1
 * against DRUM_VEL_REF. An onset too quiet to be given the quietest velocity in
 * MIDI is not an onset, and tying the two removes a free parameter.
 */
export const DRUM_VEL_REF = 0.25;                        // flux that maps to velocity 127
export const DRUM_ONSET_FLOOR = DRUM_VEL_REF / 127;      // ~0.00197

/**
 * AN ONSET IS A RISE. The flux at a candidate must be at least this fraction of
 * what is sounding at that frame, or it is the ripple of something that was
 * already there.
 *
 * This is the second thing the median gate cannot do, and it is the one that
 * matters musically. Measuring band RMS over a 441-frame hop is a statistical
 * estimate: for a band of width W the hop holds about `441 * W / 22050`
 * independent samples, so the estimate's relative standard deviation is
 * `1 / sqrt(2N)` and the frame-to-frame DIFFERENCE ripples at about sqrt(2)
 * times that. In the air band (19 kHz wide, N ~ 380) that is 5 %, and the worst
 * of forty frames is about 2.5 sigma of it. A decaying cymbal therefore keeps
 * producing small positive fluxes forever, every one of them a strict local
 * maximum, and WITHOUT THIS GATE a two-second crash comes out as twenty-three
 * crashes 87 ms apart. That is the single worst output this module can produce.
 *
 * THE ADAPTIVE MEDIAN IS NOT SUFFICIENT AGAINST IT, and the measurement is worth
 * stating exactly because the first version of this comment overstated it and
 * the assertion below caught that. Over the 2 s cymbal there are 68 candidates:
 * the median refuses 33, the absolute floor refuses 3, and 31 pass the median
 * and are refused HERE. The median half-works because once the ripple has been
 * going for 400 ms the window fills with ripple and the running median rises
 * with it — but the candidates it lets through are the LOUDEST ripples, which
 * are precisely the ones that look most like hits, and 31 of them is still a
 * machine gun. The gate order below is floor, median, attack, refractory, so
 * `rejAttack` counts only candidates the median had already accepted; that
 * ordering is what makes the assertion evidence rather than a restatement.
 *
 * 0.25 measured, both sides, on the fixtures below: a struck attack reads 1.0000
 * because the frame before it is silent, and the worst ripple over a 2 s cymbal
 * decay reads 0.1434. The gate sits 1.7x above the ripple and 4x below the
 * attack.
 *
 * ponytail: CEILING — this is masking. A hit whose rise is under a third of what
 * is already ringing is refused, so ghost notes under a sustained crash are
 * lost, and a band with FEW independent samples per hop ripples more than the
 * bound above (the sub band is 150 Hz wide, N ~ 3), so a stem carrying decaying
 * low-frequency NOISE rather than a tonal kick tail can still re-trigger.
 * UPGRADE PATH — per-band gating with a per-band ripple bound derived from that
 * band's width, which is one line of arithmetic and a fixture with a noisy
 * floor tom in it; it is not taken now because the sub band's real content on a
 * drums stem is a tonal kick tail, whose RMS does not ripple at all.
 */
export const DRUM_ATTACK_RATIO = 0.25;

/**
 * Refractory, ms. 50 ms is 5 envelope hops and it is a musical bound, not a
 * numerical one: 50 ms is a 32nd note at 300 BPM, so nothing a human plays on a
 * kit is refused by it, and a single hit whose attack straddles two hops cannot
 * be counted twice.
 */
export const DRUM_REFRACTORY_MS = 50;

/**
 * The hat/crash decision, and the ONLY reason this tap lags.
 *
 * A closed hi-hat and a crash cymbal are the same band and different decays, so
 * the only way to tell them apart is to wait and look. An onset is therefore
 * CONFIRMED DRUM_CRASH_LOOKAHEAD_MS after it happened — the tap is 200 ms behind
 * by construction, on top of whatever the caller's hop is. That is affordable
 * here and nowhere else: nothing waits on this transcription (ruling R5), it is
 * a lagging, refusable, non-destructive read in the manner of keytap/bpmtap, and
 * a MIDI note that arrives 200 ms after the sound is still at the right time on
 * the timeline it is written to.
 *
 * 0.25 measured on synthetic cymbals: a closed hat (8-50 ms decay) is at 0.02-0.04
 * of its peak 200 ms later and a crash (0.8-2 s decay) is at 0.7-0.8, so the gate
 * sits an order of magnitude clear of both. It is not a knife edge and it should
 * not be tuned to become one.
 */
export const DRUM_CRASH_LOOKAHEAD_MS = 200;
export const DRUM_CRASH_SUSTAIN = 0.25;

/**
 * Every drum note's gate length, ms. Applied by `offscreen/transcribe.js`, not
 * here — see "WHAT IT PRODUCES". 60 ms is short enough that two 16ths at 200 BPM
 * (75 ms apart) do not overlap and long enough to be visible in a DAW's piano
 * roll. It is a display length; channel 10 ignores note-off.
 */
export const DRUM_NOTE_MS = 60;

/**
 * General MIDI percussion, channel 10. The owner's ruling R4 / ADR 0002 fixes
 * these four and only these four.
 */
export const GM_KICK = 36;      // Acoustic Bass Drum
export const GM_SNARE = 38;     // Acoustic Snare
export const GM_HAT = 42;       // Closed Hi-Hat
export const GM_CRASH = 49;     // Crash Cymbal 1

/**
 * THE ONE-CLASS FALLBACK, ONE CONSTANT AWAY (ruling R4 / ADR 0002). Set this
 * true and every onset becomes GM_SNARE: a kit-less transcription that is
 * rhythmically exact and makes no claim about which drum was hit.
 *
 * It is here because the honest failure mode of a three-band classifier is a
 * CONFIDENT MISCLASSIFICATION — a bright snare read as a hat puts the backbeat
 * on the wrong line of the stave, and a reader has no way to know. One class is
 * worse information and better information: nobody mistakes it for a kit.
 *
 * ponytail: CEILING — a build that sets this loses the kick/snare distinction
 * entirely, which is most of what a drum transcription is for, so it is a
 * fallback and not a default. UPGRADE PATH — the escape from the choice is a
 * real drum transcriber (per-instrument activation, e.g. an ADT model), and
 * there is no permissively-licensed ONNX one to vendor today; ADR 0002 records
 * the survey. Until one exists, this constant is the whole of the risk control,
 * which is why it is a constant and not a parameter: a knob would need a UI, a
 * default, and a reason for a user to understand the difference.
 */
export const DRUM_ONE_CLASS = false;

/**
 * Band levels -> a General MIDI note.
 *
 * Exported so the self-check can drive it directly and so the control that must
 * lose can be written against the same entry point the tap uses (AGENTS.md: an
 * assertion about a function with more than one caller must name the entry
 * point — this function has two, `_emit` and the suite, and they are asserted
 * separately).
 *
 * THE FIRST FOUR ARGUMENTS ARE BAND RMS LEVELS, not fluxes. See "TWO ENVELOPES"
 * in the header: `hiLater / hi` is a decay ratio and a flux cannot decay.
 *
 * `oneClass` IS A PARAMETER AND NOT A READ OF THE MODULE CONSTANT, and that is
 * the whole of what makes the fallback testable. `_emit` — the tap's own call
 * site — passes `DRUM_ONE_CLASS` explicitly, so the shipped behaviour is still
 * exactly one constant away (ruling R4); the suite passes `true` and drives THIS
 * function's real branch. The alternative, a `classify` that reads the constant
 * itself, cannot be driven from a check at all without mutating a module export,
 * and what the suite ends up asserting then is a copy of the branch written in
 * the suite — a second copy of the claim wearing the word "control", which is
 * the failure AGENTS.md records for the STFT parity gate.
 *
 * @param {number} lo       sub-band (< 150 Hz) RMS at the peak hop
 * @param {number} mid      body-band (150-3000 Hz) RMS at the peak hop
 * @param {number} hi       air-band (> 3000 Hz) RMS at the peak hop
 * @param {number} hiLater  air-band RMS DRUM_CRASH_LOOKAHEAD_MS later
 * @param {boolean} [oneClass] the fallback; defaults to the shipped constant
 * @returns {36|38|42|49}
 */
export function classify(lo, mid, hi, hiLater, oneClass = DRUM_ONE_CLASS) {
  // FIRST LINE, before anything is measured. That placement is the point: the
  // fallback must not depend on any band arithmetic being right, and
  // `one-class-holds-even-when-every-band-is-NaN` is what holds it there.
  if (oneClass) return GM_SNARE;
  if (lo >= mid && lo >= hi) return GM_KICK;
  if (mid >= hi) return GM_SNARE;
  // Air band. Still ringing a fifth of a second later -> it is a crash, not a hat.
  return hiLater >= DRUM_CRASH_SUSTAIN * hi ? GM_CRASH : GM_HAT;
}

/** Ring capacity for the envelope history, in frames. Power of two, masked.
 *
 * The deepest look-back is the median window measured from a frame that already
 * has its right-hand neighbour: 40 + 2 frames. The deepest look-forward is the
 * crash lookahead, 20 frames, and a pending onset's own frame must still be in
 * the ring when it is confirmed. 64 would fit; 128 is used so that a caller who
 * feeds one enormous block cannot silently wrap the ring between two hops of the
 * same block — `_advance` runs per hop precisely so that it never can, and this
 * is the second lock on the same door. */
const ENV_RING = 128;
const ENV_MASK = ENV_RING - 1;
/** Pending onsets awaiting their lookahead. The refractory caps this at 4 (20 / 5). */
const PEND_RING = 32;
const PEND_MASK = PEND_RING - 1;

export class DrumTap {
  /**
   * @param {{sampleRate?: number}} [o] must be a multiple of DRUM_ENV_RATE
   *
   * There are deliberately no knobs for the hop, the bands, the median window or
   * the thresholds. They are not free parameters — the hop IS the envelope rate,
   * and every millisecond constant is expressed in whole hops of it. No config
   * for a value that never changes (CONTRIBUTING.md).
   */
  constructor(o = {}) {
    // sampleRate is HONOURED, not decorative — the same defect bpmtap.js records
    // having shipped, where a caller passing 48000 silently got a 44 100 grid.
    this.sr = o.sampleRate || 44100;
    if (!Number.isFinite(this.sr) || this.sr % DRUM_ENV_RATE !== 0) {
      throw new Error(`drumtap: sampleRate ${this.sr} is not a multiple of the ${DRUM_ENV_RATE} Hz envelope rate`);
    }
    this.hop = this.sr / DRUM_ENV_RATE;                 // 441 at 44 100
    this.refractory = Math.round(DRUM_REFRACTORY_MS * DRUM_ENV_RATE / 1000);          // 5
    this.look = Math.round(DRUM_CRASH_LOOKAHEAD_MS * DRUM_ENV_RATE / 1000);           // 20

    // One-pole coefficients, in the `z += k * (x - z)` form bpmtap.js uses.
    this.kLo = 1 - Math.exp(-2 * Math.PI * DRUM_BAND_LO_HZ / this.sr);
    this.kHi = 1 - Math.exp(-2 * Math.PI * DRUM_BAND_HI_HZ / this.sr);
    /**
     * Eight filter states per channel, L then R, and the two channels are NEVER
     * mixed before filtering. `(L*L + R*R) * 0.5` and not `((L + R) / 2)^2`: a
     * polarity-inverted stereo drums stem cancels to digital silence under a
     * mono sum and this tap would then report nothing forever on fully audible
     * drums. Exactly the argument bpmtap.js makes for itself, one plane over.
     *   0,1  LP150 x2                -> lo
     *   2,3  HP150 x2                -> u  (everything above the low crossover)
     *   4,5  LP3000 x2 over u        -> mid
     *   6,7  HP3000 x2 over u        -> hi
     */
    this.z = new Float64Array(16);

    // scratch, allocated once. This runs on the offscreen main thread beside the
    // pump and must not churn.
    this.ss = new Float64Array(DRUM_NBANDS);       // per-hop band energy accumulator
    this.prevM = new Float64Array(DRUM_NBANDS);    // previous hop's band levels
    this.med = new Float64Array(DRUM_MEDIAN_FRAMES);
    this.d = new Float64Array(ENV_RING);           // detection function: sum of the three fluxes
    this.lvlLo = new Float64Array(ENV_RING);
    this.lvlMid = new Float64Array(ENV_RING);
    this.lvlHi = new Float64Array(ENV_RING);
    this.fr = new Float64Array(ENV_RING);          // absolute output frame each hop STARTS at
    this.pend = new Int32Array(PEND_RING);
    this.bandE = new Float64Array(DRUM_NBANDS);    // cumulative band energy, for the suite

    this.reset();
  }

  /**
   * TRACK CHANGE, SEEK, LIVE RESTART, UNCOVERED SPAN — everything goes. Holding
   * a filter tail or a pending onset across a discontinuity is how a tap invents
   * a hit that nobody played: the level jumps because the audio was spliced, and
   * a flux detector cannot tell that from a drummer.
   *
   * Counters are NOT reset — they are diagnostics about the take, and a reset
   * that zeroed them would hide how many discontinuities a take contained.
   */
  reset() {
    this.z.fill(0);
    this.prevM.fill(0);
    this.hasPrev = false;
    this.t = 0;              // envelope frames stored since reset
    this.examined = 0;       // frames the peak-picker has looked at
    this.lastAccept = -1;    // frame index of the last accepted peak, -1 = none
    this.pendHead = 0;
    this.pendTail = 0;
    this.d.fill(0);
    this.lvlLo.fill(0); this.lvlMid.fill(0); this.lvlHi.fill(0);
    this.fr.fill(0);
    if (this.blocks === undefined) {
      this.blocks = 0;            // feed() calls
      this.hops = 0;              // envelope frames, ever
      this.resets = 0;            // times state was thrown away
      this.candidates = 0;        // strict local maxima of the detection function
      this.rejFloor = 0;          // below DRUM_ONSET_FLOOR
      this.rejMedian = 0;         // below DRUM_MEDIAN_MULT x median
      this.rejAttack = 0;         // a ripple, not a rise: below DRUM_ATTACK_RATIO x level
      this.rejRefractory = 0;     // inside DRUM_REFRACTORY_MS of the last accepted
      this.accepted = 0;          // peaks that became pending onsets
      this.emitted = 0;           // onsets confirmed and returned
      this.flushed = 0;           // onsets confirmed by flush(), i.e. without a decay test
      this.nonFinite = 0;         // envelope values that were not a number. Must stay 0.
      this.byPitch = { 36: 0, 38: 0, 42: 0, 49: 0 };
    } else {
      this.resets++;
    }
  }

  /**
   * Consume one contiguous block of the drums stem.
   *
   * @param {Float32Array} l  plane 0 (DRUM_TAP_PLANE_L), `sr` Hz
   * @param {Float32Array} r  plane 1 (DRUM_TAP_PLANE_R), `sr` Hz
   * @param {number} n        frames; MUST be a multiple of the envelope hop
   *                          (DRUM_ENV_HOP at 44 100)
   * @param {number} fromFrame ABSOLUTE stem-ring output frame of `l[0]`
   * @returns {Array<{pitch:number, vel:number, onFrame:number}>} onsets CONFIRMED
   *   by this block. `onFrame` is absolute, on the same clock as `fromFrame`. An
   *   onset is confirmed DRUM_CRASH_LOOKAHEAD_MS after it happened, so this lags
   *   by 200 ms by construction — see DRUM_CRASH_LOOKAHEAD_MS.
   *
   * MUST NOT allocate per frame. Allocation is one array per call plus one
   * object per CONFIRMED ONSET, which is the return type and unavoidable; at a
   * plausible 8 hits a second across a 1.95 s hop that is 16 small objects.
   *
   * THROWS on a mis-sized block rather than truncating. A block that is not a
   * whole number of hops would put every later hop on a shifted grid and every
   * later onset at a wrong time, and nothing downstream could see it: the notes
   * would still be plausible, just late by a growing amount.
   */
  feed(l, r, n, fromFrame) {
    const hop = this.hop;
    if (!Number.isInteger(n) || n < 0 || n % hop !== 0) {
      throw new Error(`drumtap: feed length ${n} is not a whole number of ${hop}-frame hops`);
    }
    if (!Number.isFinite(fromFrame)) {
      throw new Error(`drumtap: fromFrame ${fromFrame} is not a frame number`);
    }
    const out = [];
    this.blocks++;
    for (let off = 0; off < n; off += hop) {
      this._hop(l, r, off, fromFrame + off);
      // PER HOP, not per block. Doing this once per block would make the result
      // depend on how the caller happened to slice its audio, and would let a
      // large block wrap the envelope ring before the peak-picker had read it.
      // Block-size independence is asserted (`streaming-matches-one-shot`).
      this._advance(out);
    }
    return out;
  }

  /**
   * One hop -> three band levels, three fluxes, one detection-function sample.
   *
   * The crossover runs over the SIGNAL, per channel — see the header's "WHERE
   * THE CROSSOVER IS APPLIED". The per-channel band outputs are then combined as
   * `(bandL^2 + bandR^2) * 0.5`, which is the per-channel energy rule stated in
   * the contract, applied one stage later than bpmtap applies it.
   */
  _hop(l, r, off, absFrame) {
    const hop = this.hop, z = this.z, kLo = this.kLo, kHi = this.kHi, ss = this.ss;
    ss[0] = 0; ss[1] = 0; ss[2] = 0;
    for (let i = off, end = off + hop; i < end; i++) {
      // ---- left channel, states 0..7
      const sl = l[i];
      z[0] += kLo * (sl - z[0]);
      z[1] += kLo * (z[0] - z[1]);
      const loL = z[1];
      z[2] += kLo * (sl - z[2]);
      const p1L = sl - z[2];
      z[3] += kLo * (p1L - z[3]);
      const uL = p1L - z[3];
      z[4] += kHi * (uL - z[4]);
      z[5] += kHi * (z[4] - z[5]);
      const midL = z[5];
      z[6] += kHi * (uL - z[6]);
      const q1L = uL - z[6];
      z[7] += kHi * (q1L - z[7]);
      const hiL = q1L - z[7];

      // ---- right channel, states 8..15
      const sr = r[i];
      z[8] += kLo * (sr - z[8]);
      z[9] += kLo * (z[8] - z[9]);
      const loR = z[9];
      z[10] += kLo * (sr - z[10]);
      const p1R = sr - z[10];
      z[11] += kLo * (p1R - z[11]);
      const uR = p1R - z[11];
      z[12] += kHi * (uR - z[12]);
      z[13] += kHi * (z[12] - z[13]);
      const midR = z[13];
      z[14] += kHi * (uR - z[14]);
      const q1R = uR - z[14];
      z[15] += kHi * (q1R - z[15]);
      const hiR = q1R - z[15];

      ss[0] += (loL * loL + loR * loR) * 0.5;
      ss[1] += (midL * midL + midR * midR) * 0.5;
      ss[2] += (hiL * hiL + hiR * hiR) * 0.5;
    }

    const i = this.t & ENV_MASK;
    let d = 0;
    for (let b = 0; b < DRUM_NBANDS; b++) {
      const m = Math.sqrt(ss[b] / hop);
      if (!Number.isFinite(m)) this.nonFinite++;
      this.bandE[b] += m * m;
      // THE HALF-WAVE-RECTIFIED DIFFERENCE, and it is the whole onset detector:
      // keep energy RISES, discard falls, so a decaying cymbal is one event and
      // not forty. Identical in form to bpmtap.js's, and NOT normalised.
      //
      // The first hop after a reset has no previous level to difference against.
      // Its flux is 0 rather than `m`: a tap that starts in the middle of a hit
      // has no rise to measure and must not invent one. It also cannot be a
      // candidate anyway — a peak needs a left-hand neighbour.
      const f = this.hasPrev ? (m > this.prevM[b] ? m - this.prevM[b] : 0) : 0;
      this.prevM[b] = m;
      d += f;
      if (b === 0) this.lvlLo[i] = m;
      else if (b === 1) this.lvlMid[i] = m;
      else this.lvlHi[i] = m;
    }
    this.hasPrev = true;
    this.d[i] = d;
    this.fr[i] = absFrame;
    this.t++;
    this.hops++;
  }

  /**
   * Peak-pick everything that can now be looked at, then confirm everything that
   * now has its full lookahead. Called once per hop.
   *
   * A frame is EXAMINABLE once its right-hand neighbour exists, so the picker
   * always runs one frame behind the audio; a frame is CONFIRMABLE once the
   * lookahead frame exists, so an accepted peak surfaces 20 frames behind that.
   * Both delays are structural and neither is a timer.
   */
  _advance(out) {
    while (this.examined + 1 < this.t) {
      const c = this.examined++;
      // Frame 0 of a take has no left-hand neighbour, so it is not a candidate.
      if (c < 1) continue;
      const d = this.d[c & ENV_MASK];
      // STRICT local maximum on both sides. Strict, so a plateau (two equal
      // frames, which is what digital silence produces everywhere) yields no
      // candidate at all rather than one per frame.
      if (!(d > this.d[(c - 1) & ENV_MASK]) || !(d > this.d[(c + 1) & ENV_MASK])) continue;
      this.candidates++;
      // Four gates, in increasing cost and with a counter each, so the suite can
      // assert WHICH one refused a thing rather than only that something did.
      if (!(d >= DRUM_ONSET_FLOOR)) { this.rejFloor++; continue; }
      if (!(d > DRUM_MEDIAN_MULT * this._median(c))) { this.rejMedian++; continue; }
      const i = c & ENV_MASK;
      const lvl = this.lvlLo[i] + this.lvlMid[i] + this.lvlHi[i];
      if (!(d >= DRUM_ATTACK_RATIO * lvl)) { this.rejAttack++; continue; }
      if (this.lastAccept >= 0 && c - this.lastAccept < this.refractory) { this.rejRefractory++; continue; }
      this.lastAccept = c;
      this.pend[this.pendTail & PEND_MASK] = c;
      this.pendTail++;
      this.accepted++;
    }
    while (this.pendTail > this.pendHead) {
      const c = this.pend[this.pendHead & PEND_MASK];
      if (this.t <= c + this.look) break;
      this.pendHead++;
      out.push(this._emit(c, this.lvlHi[(c + this.look) & ENV_MASK]));
    }
  }

  /**
   * Median of the detection function over the DRUM_MEDIAN_FRAMES frames ending
   * at `c` inclusive.
   *
   * Frames before the start of the take count as 0 rather than being excluded.
   * That biases the threshold DOWN for the first 400 ms — the gate is more
   * permissive there, not less — which is the right direction: the alternative
   * is a tap that is deaf for the first four hundred milliseconds of every take,
   * and DRUM_ONSET_FLOOR still applies. Say it out loud rather than leave it to
   * be discovered.
   *
   * Sorts 40 doubles in place, 100 times a second. No allocation.
   */
  _median(c) {
    const s = this.med;
    for (let i = 0; i < DRUM_MEDIAN_FRAMES; i++) {
      const k = c - i;
      s[i] = k >= 0 ? this.d[k & ENV_MASK] : 0;
    }
    s.sort();
    return s[DRUM_MEDIAN_FRAMES >> 1];
  }

  /** Turn a confirmed peak into a note. The tap's own call site for `classify`. */
  _emit(c, hiLater) {
    const i = c & ENV_MASK;
    // The constant is passed HERE, at the tap's own call site, rather than read
    // inside `classify` — see the note on `oneClass` there.
    const pitch = classify(this.lvlLo[i], this.lvlMid[i], this.lvlHi[i], hiLater, DRUM_ONE_CLASS);
    // Velocity from the FLUX magnitude, not the level: how hard it was hit is how
    // fast the energy rose, and a hit on top of a ringing crash must not inherit
    // the crash's loudness. DRUM_VEL_REF is the flux that maps to 127; louder
    // saturates, which is honest for a 7-bit field and is why the clamp is here
    // and not a scale factor somewhere upstream.
    const vel = Math.max(1, Math.min(127, Math.round(127 * this.d[i] / DRUM_VEL_REF)));
    this.emitted++;
    this.byPitch[pitch]++;
    return { pitch, vel, onFrame: this.fr[i] };
  }

  /**
   * Confirm every pending onset immediately, at the cost of the decay test.
   *
   * A pending onset without its full lookahead is classified with `hiLater = 0`,
   * so an air-band hit at the very end of a take becomes a CLOSED HAT and never
   * a crash. Naming the bias rather than hiding it: flush cannot see the future,
   * and 42 is the answer that claims less. It costs at most the last 200 ms of a
   * take, and only for cymbals.
   *
   * @returns {Array<{pitch:number, vel:number, onFrame:number}>}
   */
  flush() {
    const out = [];
    while (this.pendTail > this.pendHead) {
      const c = this.pend[this.pendHead & PEND_MASK];
      this.pendHead++;
      const ready = this.t > c + this.look;
      if (!ready) this.flushed++;
      out.push(this._emit(c, ready ? this.lvlHi[(c + this.look) & ENV_MASK] : 0));
    }
    return out;
  }

  /**
   * Counters for the wire and for the suite. NOT the UI contract.
   *
   * `bandEnergy` is the cumulative sum of squared band levels since construction
   * — a COUNT of energy rather than a clock, which is what the band-separation
   * assertions are written against (AGENTS.md: if a claim can be carried by a
   * count, do not carry it with a stopwatch).
   */
  stats() {
    return {
      blocks: this.blocks,
      hops: this.hops,
      resets: this.resets,
      candidates: this.candidates,
      rejFloor: this.rejFloor,
      rejMedian: this.rejMedian,
      rejAttack: this.rejAttack,
      rejRefractory: this.rejRefractory,
      accepted: this.accepted,
      emitted: this.emitted,
      flushed: this.flushed,
      pending: this.pendTail - this.pendHead,
      nonFinite: this.nonFinite,
      byPitch: { ...this.byPitch },
      bandEnergy: [this.bandE[0], this.bandE[1], this.bandE[2]],
    };
  }
}

// ===================================================================== self-check
//
// `node extension/engine/drumtap.js`. Everything below this line is the runnable
// check and is NOT part of the module's surface.

const _argv1 = (typeof process !== 'undefined' && process.argv && process.argv[1]) || '';
if (_argv1.endsWith('drumtap.js') && import.meta.url.endsWith('/drumtap.js')) selfCheck();

async function selfCheck() {
  const { STEMS } = await import('../shared/config.js');
  const { PLANES } = await import('../shared/stemring.js');

  const FS = 44100;
  const HOP = DRUM_ENV_HOP;
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // ---- synthesis. A four-piece kit, not a click generator. Each voice is built
  // from what actually distinguishes it in the three bands this tap has, and the
  // ones that are deliberately easy are labelled as such.
  //
  // PADDING. Every fixture opens with 0.2 s of silence, and that is not
  // cosmetic: the first envelope frame after a reset carries no flux by
  // construction (`_hop`), so a hit at sample 0 has no rise to be detected in
  // and would be missed. The live ring feeds this tap from silence, so the pad
  // is the real case and a hit at sample 0 is not.
  const PAD_SEC = 0.2;
  const PAD = Math.round(PAD_SEC * FS);         // 8820 = exactly 20 hops

  /** Kick: a 55 Hz sine with a 45 ms decay. bpmtap.js's, unchanged. */
  function kick(buf, at, amp) {
    const n = Math.round(0.12 * FS);
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.045);
    }
  }
  /**
   * Snare: a 200 Hz body plus noise SHAPED by a 2 kHz two-pole lowpass, 30 ms
   * decay.
   *
   * The lowpass is the honest part of this fixture and it is stated rather than
   * buried: a real snare's shell and head energy peaks in the low mid and its
   * wire buzz extends well past 3 kHz. Feeding this tap flat white noise would
   * put 86 % of the noise power above the 3 kHz crossover — a snare made of
   * white noise IS air-band dominant, and it classifies as a hi-hat. That is the
   * ceiling named in the header ("A VERY BRIGHT SNARE IS NOT IN THE MID BAND"),
   * not something this fixture is hiding. The fixture is a snare whose body
   * dominates, because that is the case the classifier claims to handle, and the
   * band margin it produces is printed by `snare-fixture-is-body-dominant` so a
   * reader can see how much room there is.
   */
  function snare(buf, at, amp, rnd) {
    const n = Math.round(0.09 * FS);
    const kN = 1 - Math.exp(-2 * Math.PI * 2000 / FS);
    let z0 = 0, z1 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      z0 += kN * ((rnd() * 2 - 1) - z0);
      z1 += kN * (z0 - z1);
      const v = (z1 * 2.4 * 0.62 + Math.sin(2 * Math.PI * 200 * t) * 0.55) * Math.exp(-t / 0.030);
      if (j >= 0 && j < buf.length) buf[j] += amp * v;
    }
  }
  /** Closed hat: a short bright noise burst, 8 ms decay. bpmtap.js's, unchanged. */
  function hat(buf, at, amp, rnd) {
    const n = Math.round(0.025 * FS);
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * (rnd() * 2 - 1) * Math.exp(-t / 0.008);
    }
  }
  /** A cymbal with a settable decay — the SAME generator produces the hat and the crash. */
  function cymbal(buf, at, amp, rnd, tau, durSec) {
    const n = Math.round(durSec * FS);
    for (let i = 0; i < n; i++) {
      const t = i / FS, j = at + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * (rnd() * 2 - 1) * Math.exp(-t / tau);
    }
  }
  /** A steady tone, ramped in and out over 5 ms so the edges are not a click. */
  function tone(hz, sec, amp = 0.9) {
    const n = Math.round(sec * FS), r = Math.round(0.005 * FS);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const g = Math.min(1, i / r, (n - 1 - i) / r);
      buf[i] = amp * g * Math.sin(2 * Math.PI * hz * i / FS);
    }
    return buf;
  }
  const normalise = (buf, peak = 0.9) => {
    let p = 0;
    for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
    if (p > 0) for (let i = 0; i < buf.length; i++) buf[i] *= peak / p;
    return buf;
  };
  /** Round a length up to a whole number of envelope hops. `feed` refuses anything else. */
  const hops = (n) => Math.ceil(n / HOP) * HOP;

  /** Drive a fresh tap with one block, or with `blockHops`-sized blocks. */
  function run(pcm, o = {}) {
    const tap = new DrumTap();
    const n = pcm.length;
    const l = pcm, r = o.right || pcm;
    const notes = [];
    const step = o.blockHops ? o.blockHops * HOP : n;
    for (let off = 0; off < n; off += step) {
      const len = Math.min(step, n - off);
      notes.push(...tap.feed(l.subarray(off, off + len), r.subarray(off, off + len), len, off));
    }
    notes.push(...tap.flush());
    return { tap, notes, s: tap.stats() };
  }
  const seq = (notes) => notes.map((x) => x.pitch);
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const secs = (notes) => notes.map((x) => +(x.onFrame / FS).toFixed(4));
  const distinct = (a) => new Set(a).size;

  console.log('\x1b[1mdrumtap.js self-check\x1b[0m');

  // ==================================================== 0. the tap point
  head('0. the tap point');
  {
    const drumsIdx = STEMS.indexOf('drums');
    ok('tap-point-is-the-drums-stem: STEMS still puts `drums` at index 0, which is the ONLY thing DRUM_TAP_PLANE_L/R are derived from',
      drumsIdx === 0, `STEMS = [${STEMS.join(', ')}], drums at ${drumsIdx}`);
    ok('tap-point-planes-follow-stemIdx*2+ch (a reorder would point this tap at `bass`, which HAS onsets, so it would keep emitting a plausible drum part built out of a bass line)',
      DRUM_TAP_PLANE_L === drumsIdx * 2 && DRUM_TAP_PLANE_R === drumsIdx * 2 + 1,
      `planes ${DRUM_TAP_PLANE_L}/${DRUM_TAP_PLANE_R}, stemIdx*2 = ${drumsIdx * 2}`);
    ok('tap-point-names-are-drums.L-and-drums.R in shared/stemring.js PLANES (a second, hand-written authority, not the same expression twice)',
      PLANES[DRUM_TAP_PLANE_L] === 'drums.L' && PLANES[DRUM_TAP_PLANE_R] === 'drums.R',
      `PLANES[${DRUM_TAP_PLANE_L}] = ${PLANES[DRUM_TAP_PLANE_L]}, PLANES[${DRUM_TAP_PLANE_R}] = ${PLANES[DRUM_TAP_PLANE_R]}`);
    const a = new DrumTap(), b = new DrumTap({ sampleRate: 48000 });
    ok('the-envelope-grid-is-honoured-at-every-sample-rate-the-constructor-accepts (bpmtap.js shipped the defect where a caller passing 48000 silently got the 44 100 grid)',
      a.hop === DRUM_ENV_HOP && b.hop === 480 && a.sr / a.hop === DRUM_ENV_RATE && b.sr / b.hop === DRUM_ENV_RATE,
      `44100 -> hop ${a.hop}, 48000 -> hop ${b.hop}, both ${DRUM_ENV_RATE} Hz`);
    let threw = '';
    try { new DrumTap({ sampleRate: 44101 }); } catch (e) { threw = e.message; }
    ok('a-sample-rate-that-does-not-divide-into-100-Hz-is-refused-rather-than-rounded', threw.includes('44101'), threw || 'did not throw');
    let threw2 = '';
    try { a.feed(new Float32Array(100), new Float32Array(100), 100, 0); } catch (e) { threw2 = e.message; }
    ok('a-block-that-is-not-a-whole-number-of-hops-is-refused (truncating would shift every later onset by a growing amount and every note would still look plausible)',
      threw2.includes('100'), threw2 || 'did not throw');
  }

  // ==================================================== 1. the crossover
  head('1. the crossover is bpmtap.js\'s, and it is on the signal');
  {
    ok('the-crossover-is-bpmtaps: 150 Hz and 3000 Hz, three bands (the literals bpmtap.js keeps private; this is where the two files are reconciled if they ever move)',
      DRUM_BAND_LO_HZ === 150 && DRUM_BAND_HI_HZ === 3000 && DRUM_NBANDS === 3,
      `lo ${DRUM_BAND_LO_HZ} Hz, hi ${DRUM_BAND_HI_HZ} Hz, ${DRUM_NBANDS} bands`);

    const frac = (e, b) => e[b] / (e[0] + e[1] + e[2]);
    const lowT = hops(Math.round(0.5 * FS));
    const low = new Float32Array(lowT); low.set(tone(55, 0.5));
    const highT = hops(Math.round(0.5 * FS));
    const high = new Float32Array(highT); high.set(tone(6000, 0.5));
    const eLow = run(low).s.bandEnergy;
    const eHigh = run(high).s.bandEnergy;
    ok('a-55-Hz-burst-puts-over-80-percent-of-its-band-energy-in-lo',
      frac(eLow, 0) > 0.8, `lo ${(100 * frac(eLow, 0)).toFixed(1)} % / mid ${(100 * frac(eLow, 1)).toFixed(1)} % / hi ${(100 * frac(eLow, 2)).toFixed(1)} %`);
    ok('a-6-kHz-burst-puts-over-80-percent-of-its-band-energy-in-hi',
      frac(eHigh, 2) > 0.8, `lo ${(100 * frac(eHigh, 0)).toFixed(1)} % / mid ${(100 * frac(eHigh, 1)).toFixed(1)} % / hi ${(100 * frac(eHigh, 2)).toFixed(1)} %`);

    // THE CONTROL FOR THE PLACEMENT DECISION. bpmtap.js filters the RECTIFIED
    // MAGNITUDE, and the header claims that placement cannot carry a
    // classification. Here is that placement, measured on the same two bursts.
    // If it passed, this file's extra eight filter states would be waste.
    const bpmtapPlacement = (pcm) => {
      const aLo = Math.exp(-2 * Math.PI * DRUM_BAND_LO_HZ / FS);
      const aHi = Math.exp(-2 * Math.PI * DRUM_BAND_HI_HZ / FS);
      const z = new Float64Array(4);
      const e = [0, 0, 0];
      for (let i = 0; i < pcm.length; i++) {
        const v = (pcm[i] * pcm[i] + pcm[i] * pcm[i]) * 0.5;
        const x = Math.sqrt(v);
        z[0] += (1 - aLo) * (x - z[0]);
        z[1] += (1 - aLo) * (z[0] - z[1]);
        z[2] += (1 - aHi) * (x - z[2]);
        z[3] += (1 - aHi) * (z[2] - z[3]);
        const lo = z[1], mid = z[3] - z[1], hi = x - z[3];
        e[0] += lo * lo; e[1] += mid * mid; e[2] += hi * hi;
      }
      return e;
    };
    const cHigh = bpmtapPlacement(high);
    ok('crossover-is-on-the-signal-not-the-rectified-magnitude: THE CONTROL THAT MUST LOSE — bpmtap.js\'s placement FAILS the 6 kHz band-separation claim, because rectifying a tone puts 0.6366 of its peak at DC and DC is low band whatever the tone was',
      !(frac(cHigh, 2) > 0.8) && cHigh[0] > cHigh[2],
      `rectified-magnitude placement: lo ${(100 * frac(cHigh, 0)).toFixed(1)} % / mid ${(100 * frac(cHigh, 1)).toFixed(1)} % / hi ${(100 * frac(cHigh, 2)).toFixed(1)} % — a 6 kHz sine reads as a KICK; this file's placement: hi ${(100 * frac(eHigh, 2)).toFixed(1)} %`);
  }

  // ==================================================== 2. four to the floor
  head('2. four to the floor: the note numbers AND the onset times');
  {
    const BEAT = 0.5;                                    // 120 BPM
    const N = 8;
    const len = hops(PAD + Math.round((BEAT * N + 0.4) * FS));
    const buf = new Float32Array(len);
    const wantSec = [];
    for (let k = 0; k < N; k++) {
      const at = PAD + Math.round(k * BEAT * FS);
      kick(buf, at, 1.0);
      wantSec.push(at / FS);
    }
    normalise(buf);
    const { notes, s } = run(buf);
    const got = secs(notes);
    ok('four-to-the-floor-yields-exactly-eight-onsets-in-four-seconds (a COUNT, not a clock: 8 kicks in, 8 notes out)',
      notes.length === N, `${notes.length} onsets, candidates ${s.candidates}, rejected floor ${s.rejFloor} / median ${s.rejMedian} / attack ${s.rejAttack} / refractory ${s.rejRefractory}`);
    ok('four-to-the-floor-is-all-GM_KICK-36',
      notes.length === N && notes.every((x) => x.pitch === GM_KICK), `pitches [${seq(notes).join(', ')}]`);
    const errMs = got.map((g, i) => Math.abs(g - wantSec[i]) * 1000);
    const worst = Math.max(...errMs);
    ok('every-onset-lands-within-one-envelope-hop-of-the-kick-that-caused-it (the times, not just the notes)',
      notes.length === N && worst <= 1000 * HOP / FS,
      `worst ${worst.toFixed(2)} ms, hop ${(1000 * HOP / FS).toFixed(2)} ms; got [${got.join(', ')}] want [${wantSec.map((v) => +v.toFixed(4)).join(', ')}]`);
    const gaps = [];
    for (let i = 1; i < got.length; i++) gaps.push(got[i] - got[i - 1]);
    ok('consecutive-onsets-are-half-a-second-apart-to-within-one-hop',
      gaps.length === N - 1 && gaps.every((g) => Math.abs(g - BEAT) <= HOP / FS),
      `gaps [${gaps.map((g) => g.toFixed(4)).join(', ')}] s`);
  }

  // ==================================================== 3. the backbeat
  head('3. a kick/snare backbeat classifies both ways');
  const WANT_BACKBEAT = [GM_KICK, GM_SNARE, GM_KICK, GM_SNARE, GM_KICK, GM_SNARE, GM_KICK, GM_SNARE];
  let backbeat = null;
  {
    const rnd = mulberry32(0x5eed);
    const BEAT = 0.5;
    const N = 8;
    const len = hops(PAD + Math.round((BEAT * N + 0.4) * FS));
    const buf = new Float32Array(len);
    const wantSec = [];
    for (let k = 0; k < N; k++) {
      const at = PAD + Math.round(k * BEAT * FS);
      if (k % 2 === 0) kick(buf, at, 1.0); else snare(buf, at, 0.85, rnd);
      wantSec.push(at / FS);
    }
    normalise(buf);
    backbeat = run(buf);
    const { notes, s } = backbeat;

    // The band margin the classification actually turned on, printed so a reader
    // can see how much room there is rather than take the verdict on trust.
    const eKick = run(((b) => { const x = new Float32Array(hops(PAD + Math.round(0.5 * FS))); kick(x, PAD, 1.0); return normalise(x); })()).s.bandEnergy;
    const eSnare = run(((b) => { const x = new Float32Array(hops(PAD + Math.round(0.5 * FS))); snare(x, PAD, 0.85, mulberry32(1)); return normalise(x); })()).s.bandEnergy;
    const fr = (e, i) => (100 * e[i] / (e[0] + e[1] + e[2])).toFixed(1);
    ok('kick-fixture-is-sub-dominant', eKick[0] > eKick[1] && eKick[0] > eKick[2], `lo ${fr(eKick, 0)} % / mid ${fr(eKick, 1)} % / hi ${fr(eKick, 2)} %`);
    ok('snare-fixture-is-body-dominant (the margin this classification turns on; a snare made of FLAT white noise would be air-band dominant and would read as a hat — the ceiling named in the header)',
      eSnare[1] > eSnare[0] && eSnare[1] > eSnare[2], `lo ${fr(eSnare, 0)} % / mid ${fr(eSnare, 1)} % / hi ${fr(eSnare, 2)} %`);

    ok('backbeat-pitch-sequence-is-36-38-36-38-36-38-36-38',
      same(seq(notes), WANT_BACKBEAT), `got [${seq(notes).join(', ')}], want [${WANT_BACKBEAT.join(', ')}]`);
    const got = secs(notes);
    const worst = notes.length === N ? Math.max(...got.map((g, i) => Math.abs(g - wantSec[i]) * 1000)) : Infinity;
    ok('backbeat-onset-times-land-within-one-envelope-hop-of-the-hits-that-caused-them',
      worst <= 1000 * HOP / FS, `worst ${worst === Infinity ? 'n/a' : worst.toFixed(2) + ' ms'}; got [${got.join(', ')}]`);
    /**
     * A COUNT AND AN EXACT VALUE. This line used to read
     * `notes.every((x) => x.vel >= 1 && x.vel <= 127)`, which is two things that
     * cannot fail at once: it restates `_emit`'s own
     * `Math.max(1, Math.min(127, ...))` a few hundred lines up, and with no
     * length guard `[].every(...)` is `true`, so it reported "the velocities are
     * in range" over a take with no notes in it. What is actually TRUE of this
     * fixture is that every hit is normalised to full scale and every flux
     * therefore clears DRUM_VEL_REF, so all eight read the ceiling exactly — a
     * measurement of the saturation named beside that constant rather than a
     * restatement of the clamp. Section 3b is where velocity is asserted over a
     * range it can move in.
     *
     * WATCHED IT FAIL, three times, and the old form survived all three:
     *   DRUM_VEL_REF 0.25 -> 1.0 (eight hits still detected, none saturating):
     *     old PASS, new `FAIL ... vels [78, 42, 78, 41, 78, 45, 78, 49]`.
     *   DRUM_VEL_REF 0.25 -> 25: old PASS, new
     *     `FAIL ... vels [3, 2, 3, 2, 3, 2, 3, 2]`.
     *   DRUM_ONSET_FLOOR forced to 1, so the peak-picker accepts NOTHING and the
     *     note list is EMPTY: old PASS — that is the vacuity, `[].every(...)` —
     *     new `FAIL ... vels [] over 0 note(s), want 8 at 127`.
     * Reverted, 55/55.
     */
    ok('backbeat-velocities-are-ALL-127, which is the DRUM_VEL_REF saturation measured, not the 1..127 clamp restated',
      notes.length === N && notes.every((x) => x.vel === 127),
      `vels [${notes.map((x) => x.vel).join(', ')}] over ${notes.length} note(s), want ${N} at 127: every hit here is normalised to full scale, so every flux clears DRUM_VEL_REF ${DRUM_VEL_REF}`);
    ok('nothing-non-finite-reached-the-envelope', s.nonFinite === 0, `nonFinite ${s.nonFinite}`);
  }

  // ==================================================== 3b. velocity
  head('3b. velocity tracks how hard it was hit, over a range it can move in');
  {
    // THREE amplitudes 12 dB apart, and the ASSERTION IS ABOUT THE TWO QUIET
    // ONES. AGENTS.md, "range, not just precision": DRUM_VEL_REF saturates every
    // hit whose flux exceeds 0.25, so a fixture of full-scale hits reads 127
    // three times and would report coverage it does not have — which is exactly
    // what the backbeat above does, and why it does not carry this claim.
    const AMPS = [1.0, 0.25, 0.06];
    const len = hops(PAD + Math.round((0.5 * AMPS.length + 0.4) * FS));
    const buf = new Float32Array(len);
    for (let k = 0; k < AMPS.length; k++) kick(buf, PAD + Math.round(k * 0.5 * FS), AMPS[k]);
    normalise(buf);
    const { notes } = run(buf);
    const vels = notes.map((x) => x.vel);
    ok('three-kicks-12-dB-apart-yield-three-notes', notes.length === 3, `vels [${vels.join(', ')}]`);
    ok('velocity-falls-monotonically-with-the-hit (not a constant, and not an inversion)',
      vels.length === 3 && vels[0] > vels[1] && vels[1] > vels[2], `vels [${vels.join(', ')}] for amplitudes [${AMPS.join(', ')}]`);
    ok('the-quiet-hits-are-strictly-inside-1..127, so the mapping is being exercised rather than clamped at both ends',
      vels.length === 3 && vels[1] > 1 && vels[1] < 127 && vels[2] > 1 && vels[2] < 127,
      `vels [${vels.join(', ')}]`);
    // ponytail: CEILING — every hit whose flux exceeds DRUM_VEL_REF is velocity
    // 127, and on a normalised drum stem that is most of them, so velocity here
    // is a coarse accent and not a dynamic curve; the loudest hit above reads
    // 127 and so would one twice as loud. UPGRADE PATH — divide the flux by a
    // slow running maximum of the detection function so velocity is relative to
    // the take. That needs a decision about how fast that maximum may fall and a
    // fixture with a real crescendo in it, and it makes velocity depend on the
    // take's history, which is a bigger claim than this one.
    ok('the-saturation-ceiling-is-where-DRUM_VEL_REF-says-it-is (the loudest hit is clamped, and that is stated rather than discovered)',
      vels[0] === 127, `loudest ${vels[0]}, DRUM_VEL_REF ${DRUM_VEL_REF}`);
  }

  // ==================================================== 4. the control that must lose
  head('4. THE CONTROL THAT MUST LOSE');
  {
    // The degenerate detector: the same tap, the same onsets, ONE CLASS for all
    // of them. It ignores its four arguments, which is the definition of the
    // thing being ruled out, and it is a real function called once per onset —
    // not a literal array written to look like one.
    const allKick = (lo, mid, hi, hiLater) => GM_KICK;
    const stubSeq = backbeat.notes.map((n) => allKick(0, 0, 0, 0));
    const realSeq = seq(backbeat.notes);

    // Guard on the guard: if the expectation had only one distinct value, an
    // all-36 classifier would satisfy it and the control could not lose. That is
    // exactly the failure AGENTS.md records for the STFT parity gate, where a
    // channel-swap control on mono-duplicated stereo was a mathematical no-op.
    ok('the-expectation-can-distinguish-two-classes (without this the control below is a second copy of the measurement wearing the word "control")',
      distinct(WANT_BACKBEAT) === 2, `want [${WANT_BACKBEAT.join(', ')}], ${distinct(WANT_BACKBEAT)} distinct`);
    ok('the-control-detects-the-same-number-of-onsets (it differs from the real classifier in classification and in nothing else)',
      stubSeq.length === realSeq.length && stubSeq.length === WANT_BACKBEAT.length,
      `control ${stubSeq.length}, real ${realSeq.length}, want ${WANT_BACKBEAT.length}`);
    ok('a-classifier-that-returns-36-for-every-onset-FAILS-assertion-3 (same fixture, same comparison, run for real)',
      !same(stubSeq, WANT_BACKBEAT) && same(realSeq, WANT_BACKBEAT),
      `control [${stubSeq.join(', ')}] vs want [${WANT_BACKBEAT.join(', ')}] -> ${same(stubSeq, WANT_BACKBEAT) ? 'MATCHES (control could not lose)' : 'does not match'}; real [${realSeq.join(', ')}] -> ${same(realSeq, WANT_BACKBEAT) ? 'matches' : 'DOES NOT MATCH'}`);
  }

  // ==================================================== 5. hat vs crash
  head('5. hat vs crash: the DECAY decides, not the band');
  {
    const rnd = mulberry32(0xc1a5);
    const mk = (tau, durSec) => {
      const len = hops(PAD + Math.round((durSec + 0.4) * FS));
      const buf = new Float32Array(len);
      cymbal(buf, PAD, 1.0, rnd, tau, durSec);
      return normalise(buf);
    };
    const shortDecay = run(mk(0.05, 0.2));          // gone in ~200 ms
    const longDecay = run(mk(0.8, 2.0));            // still ringing at 2 s
    ok('a-200-ms-decay-air-band-burst-is-a-closed-hat-42',
      shortDecay.notes.length === 1 && shortDecay.notes[0].pitch === GM_HAT,
      `${shortDecay.notes.length} onset(s) [${seq(shortDecay.notes).join(', ')}]`);
    ok('a-2-s-decay-air-band-burst-is-a-crash-49',
      longDecay.notes.length === 1 && longDecay.notes[0].pitch === GM_CRASH,
      `${longDecay.notes.length} onset(s) [${seq(longDecay.notes).join(', ')}]`);
    // Not a restatement of the count above: it names WHICH gate did the work,
    // and the gate ORDER is what makes it evidence. `rejAttack` is only reached
    // by candidates that already passed the floor and the median, so a non-zero
    // count is a count of spurious crashes the adaptive median accepted. Before
    // DRUM_ATTACK_RATIO existed this fixture emitted 23 of them, 87 ms apart.
    // An assertion on the emitted count alone would go green again the day
    // someone deletes the mechanism and the fixture happens to get quieter.
    ok('a-decaying-cymbal-does-not-retrigger, and DRUM_ATTACK_RATIO is what stops it: the adaptive median is NOT sufficient here — every candidate counted below had already passed it',
      longDecay.s.rejAttack > 0 && longDecay.s.emitted === 1,
      `candidates ${longDecay.s.candidates}, rejected by floor ${longDecay.s.rejFloor} -> median ${longDecay.s.rejMedian}`
      + ` -> attack-ratio ${longDecay.s.rejAttack} -> refractory ${longDecay.s.rejRefractory}, emitted ${longDecay.s.emitted};`
      + ` the ${longDecay.s.rejAttack} the median passed are the loudest ripples, i.e. the ones most like hits`);

    // Same band shape, three lookahead values, driven through `classify`
    // directly — the SECOND call site, named per AGENTS.md's entry-point rule.
    const LO = 0.01, MID = 0.02, HI = 0.30;
    ok('classify-with-a-sustained-air-band-gives-49', classify(LO, MID, HI, 0.5 * HI) === GM_CRASH,
      `classify(${LO}, ${MID}, ${HI}, ${0.5 * HI}) = ${classify(LO, MID, HI, 0.5 * HI)}`);
    ok('classify-with-a-decayed-air-band-gives-42', classify(LO, MID, HI, 0.05 * HI) === GM_HAT,
      `classify(${LO}, ${MID}, ${HI}, ${(0.05 * HI).toFixed(3)}) = ${classify(LO, MID, HI, 0.05 * HI)}`);
    ok('classify-with-hiLater-forced-to-0-gives-42-on-the-SAME-band-shape (so the decay test is what decides, not the band)',
      classify(LO, MID, HI, 0) === GM_HAT && classify(LO, MID, HI, 0.5 * HI) !== classify(LO, MID, HI, 0),
      `hiLater 0 -> ${classify(LO, MID, HI, 0)}, hiLater ${0.5 * HI} -> ${classify(LO, MID, HI, 0.5 * HI)}`);
    ok('the-sustain-gate-is-where-DRUM_CRASH_SUSTAIN-says-it-is (just under -> 42, just over -> 49)',
      classify(LO, MID, HI, (DRUM_CRASH_SUSTAIN - 0.01) * HI) === GM_HAT
      && classify(LO, MID, HI, (DRUM_CRASH_SUSTAIN + 0.01) * HI) === GM_CRASH,
      `DRUM_CRASH_SUSTAIN = ${DRUM_CRASH_SUSTAIN}`);
  }

  // ==================================================== 6. the refractory
  head('6. the refractory can fire, and can decline to');
  {
    const two = (gapSec) => {
      const len = hops(PAD + Math.round((gapSec + 0.5) * FS));
      const buf = new Float32Array(len);
      kick(buf, PAD, 1.0);
      kick(buf, PAD + Math.round(gapSec * FS), 1.0);
      return run(normalise(buf));
    };
    const close = two(0.02);        // 20 ms = 2 hops, inside the 5-hop refractory
    const apart = two(0.08);        // 80 ms = 8 hops, outside it
    ok('two-onsets-20-ms-apart-yield-ONE-note (the refractory fires)',
      close.notes.length === 1, `${close.notes.length} note(s), rejRefractory ${close.s.rejRefractory}`);
    ok('two-onsets-80-ms-apart-yield-TWO-notes (and it declines to fire, so the constant is exercised in both directions)',
      apart.notes.length === 2, `${apart.notes.length} note(s), rejRefractory ${apart.s.rejRefractory}, times [${secs(apart.notes).join(', ')}]`);
    ok('the-refractory-is-the-thing-that-rejected-it (a count, so a peak lost to the median gate cannot masquerade as one lost to the refractory)',
      close.s.rejRefractory >= 1 && apart.s.rejRefractory === 0,
      `close ${close.s.rejRefractory}, apart ${apart.s.rejRefractory}`);
  }

  // ==================================================== 7. silence and the floor
  head('7. silence is refused, and it is the FLOOR that refuses it');
  {
    const len = hops(Math.round(3 * FS));
    const quiet = new Float32Array(len);
    ok('digital-silence-produces-no-onsets', run(quiet).notes.length === 0, '3 s of zeros');
    const rnd = mulberry32(7);
    const dither = new Float32Array(len);
    for (let i = 0; i < len; i++) dither[i] = (rnd() * 2 - 1) * 1e-4;
    const d = run(dither);
    ok('a-noise-floor-80-dB-down-produces-no-onsets, and the FLOOR is the gate that refuses it (it runs first, and it refuses every candidate)',
      d.notes.length === 0 && d.s.rejFloor === d.s.candidates && d.s.candidates > 0,
      `${d.notes.length} note(s), candidates ${d.s.candidates}, rejected by the floor ${d.s.rejFloor}, by the median ${d.s.rejMedian}`);

    // WHY THE FLOOR EXISTS SEPARATELY FROM DRUM_ATTACK_RATIO. A hit that rises
    // out of digital silence has d/lvl = 1.0000 no matter how quiet it is, so
    // the attack ratio waves it through; and the median of a half-wave-rectified
    // silence is 0, so `d > 1.8 * 0` waves it through too. Two gates that both
    // pass it, and one that does not.
    const tiny = new Float32Array(hops(PAD + Math.round(0.5 * FS)));
    kick(tiny, PAD, 1.0);
    for (let i = 0; i < tiny.length; i++) tiny[i] *= 1e-5;
    const q = run(tiny);
    ok('a-hit-too-quiet-to-be-given-velocity-1-is-not-an-onset, even though it rises cleanly out of silence and both other gates admit it',
      q.notes.length === 0 && q.s.rejFloor >= 1 && q.s.rejAttack === 0,
      `${q.notes.length} note(s), candidates ${q.s.candidates}, floor ${q.s.rejFloor}, median ${q.s.rejMedian}, attack ${q.s.rejAttack}`);
  }

  // ==================================================== 8. streaming
  head('8. streaming: block-wise input gives the same onsets as one-shot');
  {
    const rnd = mulberry32(0xb0a7);
    const len = hops(PAD + Math.round(6.5 * FS));
    const buf = new Float32Array(len);
    const BEAT = 0.5;
    for (let k = 0; k * BEAT < 6; k++) {
      const at = PAD + Math.round(k * BEAT * FS);
      if (k % 2 === 0) kick(buf, at, 1.0); else snare(buf, at, 0.85, rnd);
      hat(buf, Math.round(at + BEAT * FS / 2), 0.30, rnd);
    }
    normalise(buf);
    const one = run(buf);
    // 195 hops is the 1.95 s live hop; 1 hop is the pathological slice; 7 is a
    // size that divides nothing evenly, which is the one that finds an off-by-one.
    const chunked = [195, 7, 1].map((h) => ({ h, r: run(buf, { blockHops: h }) }));
    ok('one-shot-input-detects-something-to-compare (an assertion over two empty lists is the vacuous pass AGENTS.md is mostly about)',
      one.notes.length >= 8, `${one.notes.length} onsets, pitches [${seq(one.notes).join(', ')}]`);
    for (const { h, r } of chunked) {
      const idem = one.notes.length === r.notes.length
        && one.notes.every((n, i) => n.pitch === r.notes[i].pitch && n.vel === r.notes[i].vel && n.onFrame === r.notes[i].onFrame);
      ok(`blocks-of-${h}-hops-give-byte-identical-onsets-to-one-shot (filters, envelope, median and pending queue all carry across calls)`,
        idem, `one-shot ${one.notes.length} notes, blocked ${r.notes.length}; ${idem ? 'identical' : 'first difference at ' + one.notes.findIndex((n, i) => !r.notes[i] || n.pitch !== r.notes[i].pitch || n.vel !== r.notes[i].vel || n.onFrame !== r.notes[i].onFrame)}`);
    }
    // The mono-sum trap, and it is the reason `_hop` filters L and R separately.
    const inv = new Float32Array(len);
    for (let i = 0; i < len; i++) inv[i] = -buf[i];
    const polarity = run(buf, { right: inv });
    const idem2 = one.notes.length === polarity.notes.length
      && one.notes.every((n, i) => n.pitch === polarity.notes[i].pitch && n.onFrame === polarity.notes[i].onFrame);
    ok('a-polarity-inverted-stereo-drums-stem-reports-the-SAME-onsets (a mono sum would cancel it to digital silence and this tap would report nothing forever on fully audible drums)',
      idem2, `L=+x R=-x: ${polarity.notes.length} onsets, in-phase ${one.notes.length}`);
  }

  // ==================================================== 9. the one-class fallback
  head('9. DRUM_ONE_CLASS really is one constant away');
  {
    /**
     * BOTH COLUMNS COME OUT OF THE SHIPPED `classify`. The first version of this
     * section did not: it defined `const ONE_CLASS_LOCAL = true` and a local
     * `classifyOneClass` that returned GM_SNARE, so `every(p => p === GM_SNARE)`
     * was true BY CONSTRUCTION OF THE SUITE and the shipped fallback was never
     * executed. That is AGENTS.md's "a control that cannot distinguish the
     * hypothesis from its negation is a second copy of the measurement wearing
     * the word control", and it was sitting under a section head claiming the
     * fallback is one constant away.
     *
     * What made it fixable is that `classify` now TAKES the flag (default
     * `DRUM_ONE_CLASS`, passed explicitly by `_emit`), so the fallback branch has
     * an entry point a check can reach without mutating a module export. Same
     * function, same branch, both columns, one call each.
     *
     * WATCHED IT FAIL: `if (oneClass) return GM_SNARE;` deleted from `classify`.
     * The old form stayed GREEN at 54/54 — it never called the branch. This form
     * prints `FAIL the-one-class-branch ... got [36, 38, 42, 49]` and
     * `FAIL one-class-holds-even-when-every-band-is-NaN ... flag on -> 42`.
     * Restored, 55/55.
     */
    const SHAPES = [
      ['kick', 0.40, 0.05, 0.01, 0.00, GM_KICK],
      ['snare', 0.05, 0.30, 0.10, 0.01, GM_SNARE],
      ['hat', 0.01, 0.04, 0.25, 0.01, GM_HAT],
      ['crash', 0.01, 0.05, 0.30, 0.20, GM_CRASH],
    ];

    // Left column: the shipped configuration, the flag left to its default.
    // Right column: the SAME function, the same four shapes, the flag on.
    const shipped = SHAPES.map(([, lo, mid, hi, hl]) => classify(lo, mid, hi, hl));
    const oneClass = SHAPES.map(([, lo, mid, hi, hl]) => classify(lo, mid, hi, hl, true));
    ok('the-shipped-classifier-separates-all-four-shapes (the control half: without it, a classify() hardwired to 38 would satisfy the one-class assertion below)',
      same(shipped, SHAPES.map((s) => s[5])) && distinct(shipped) === 4,
      `got [${shipped.join(', ')}], want [${SHAPES.map((s) => s[5]).join(', ')}], ${distinct(shipped)} distinct`);
    ok('the-one-class-branch-turns-all-four-shapes-into-38 (the SHIPPED classify, its fifth argument on — not a copy of the branch written here)',
      oneClass.length === SHAPES.length && oneClass.every((p) => p === GM_SNARE) && distinct(oneClass) === 1,
      `got [${oneClass.join(', ')}] for [${SHAPES.map((s) => s[0]).join(', ')}]; the same four shapes through the same function with the flag off give [${shipped.join(', ')}], so the flag is what decided`);
    ok('one-class-holds-even-when-every-band-is-NaN (the branch is the FIRST line of classify, so the fallback does not depend on any band arithmetic being right)',
      classify(NaN, NaN, NaN, NaN, true) === GM_SNARE && classify(NaN, NaN, NaN, NaN, false) !== GM_SNARE,
      `flag on -> ${classify(NaN, NaN, NaN, NaN, true)}, flag off -> ${classify(NaN, NaN, NaN, NaN, false)} (every comparison against NaN is false, so the band rules fall through to the hat/crash line)`);
    ok('DRUM_ONE_CLASS-ships-false, and `_emit` passes THAT constant, so the branch above is the fallback and not the behaviour',
      DRUM_ONE_CLASS === false, `DRUM_ONE_CLASS = ${DRUM_ONE_CLASS}`);
    ok('DRUM_ONSET_FLOOR-is-derived-from-DRUM_VEL_REF (an onset too quiet to be given velocity 1 is not an onset; deriving it removes a free parameter)',
      Math.abs(DRUM_ONSET_FLOOR - DRUM_VEL_REF / 127) < 1e-15, `${DRUM_ONSET_FLOOR.toExponential(3)}`);
    ok('the-four-GM-numbers-are-the-ones-the-owner\'s-ruling-fixes: 36 kick, 38 snare, 42 closed hat, 49 crash',
      GM_KICK === 36 && GM_SNARE === 38 && GM_HAT === 42 && GM_CRASH === 49,
      `${GM_KICK}/${GM_SNARE}/${GM_HAT}/${GM_CRASH}`);
    ok('every-drum-note-is-a-fixed-length-gate, applied downstream by offscreen/transcribe.js — a "measured" percussive release would be a number with nothing behind it',
      DRUM_NOTE_MS === 60, `${DRUM_NOTE_MS} ms`);
  }

  // ==================================================== 10. reset
  head('10. reset throws the state away');
  {
    const rnd = mulberry32(11);
    const len = hops(PAD + Math.round(1.0 * FS));
    const buf = new Float32Array(len);
    kick(buf, PAD, 1.0);
    kick(buf, PAD + Math.round(0.5 * FS), 1.0);
    normalise(buf);
    const tap = new DrumTap();
    const first = tap.feed(buf, buf, len, 0);
    const beforeStats = tap.stats();
    tap.reset();
    // Same audio, a new absolute frame origin. A tap that kept its filter tail
    // or its `lastAccept` would drop the first hit of the new span.
    const second = tap.feed(buf, buf, len, 10 * len);
    const after = [...second, ...tap.flush()];
    const before = [...first, ...tap.flush()];
    ok('after-reset-the-same-audio-detects-the-same-number-of-onsets (a seek is a discontinuity, and a tap that carried its refractory or its filter tail across one would silently drop the first hit after it)',
      after.length === 2, `before reset ${before.length + beforeStats.pending}, after reset ${after.length}`);
    ok('after-reset-the-onset-frames-follow-the-new-origin, not the old one',
      after.length === 2 && after[0].onFrame === 10 * len + PAD,
      `first onset at ${after.length ? after[0].onFrame : 'n/a'}, origin ${10 * len}, pad ${PAD}`);
    ok('reset-is-counted-and-the-diagnostics-survive-it (a reset that zeroed the counters would hide how many discontinuities a take contained)',
      tap.stats().resets === 1 && tap.stats().hops > beforeStats.hops,
      `resets ${tap.stats().resets}, hops ${beforeStats.hops} -> ${tap.stats().hops}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
