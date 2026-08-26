/**
 * THE MIDI TAKE'S ORCHESTRATION — the only file that knows a stem is a lane, a
 * lane is a stream of 22 050 Hz samples, and a sample is a SECOND OF VIDEO.
 *
 * Everything either side of it is deliberately ignorant of that. `engine/notes.js`
 * speaks lane samples and has never heard of a stem; `engine/drumtap.js` speaks
 * stem-ring frames; `shared/midi.js` speaks source seconds and has never heard of
 * a ring. This file is the three joins, and it is the only place the arithmetic
 * that connects them lives.
 *
 *   offscreen/live.js  runChunk -> covered(from, len, planes)   (the ring tap)
 *                      fill()   -> uncovered(from, len)
 *          |
 *          |  planes 0/1   -> DrumTap        44 100 Hz, per-channel energy
 *          |  planes 2..11 -> decimate2      44 100 -> 22 050, five mono lanes
 *          v
 *   window accumulation (43844 in, 36164 hop, 3840 pre-roll)
 *          |
 *          v
 *   workers/transcribe.worker.js  -> ORT -> engine/notes.js -> closed notes
 *          |                                                   (LANE SAMPLES)
 *          v
 *   srcSec()  -> MIDI_NOTES on the deck's wire                 (SOURCE SECONDS)
 *
 * ===========================================================================
 * NOTHING WAITS ON IT
 * ===========================================================================
 *
 * ADR 0002 / the owner's ruling R5: this is "a lagging, refusable,
 * non-destructive read in the manner of `keytap.js`/`bpmtap.js`. It may fall
 * arbitrarily behind and catch up." Three consequences, and all three are
 * structural rather than remembered:
 *
 *   1. `covered()` and `uncovered()` never await, never post anything the audio
 *      path owns, and never throw into `runChunk` — the whole body is inside one
 *      try/catch that latches a fault the same way `LivePipeline.tickBpm` does.
 *      A tap that took the deck down over a display-only feature would be a
 *      worse bug than the one it was reporting.
 *   2. The worker is created LAZILY, on the first take, and terminated with it.
 *      A user who never presses the button never pays for a second wasm
 *      instance (R5, and `workers/transcribe.worker.js`'s header).
 *   3. When the take is closed this file does literally nothing: `live.js` holds
 *      `this.transcriber === null` and the tap is one property read per hop.
 *
 * THE FIVE PITCHED LANES RUN AS FIVE SEQUENTIAL `RUN` MESSAGES, one in flight at
 * a time, and that is not a missing optimisation. Batching five windows into one
 * message would buy nothing measurable — the wasm session runs them serially
 * whatever the message shape, `session.run()` blocks the worker's message loop,
 * and the queue below is what makes a lane droppable. What batching WOULD cost
 * is the ability to drop a single lane's window under load, which is the only
 * backpressure this feature has.
 *
 * ===========================================================================
 * WHY `covered()` MUST COPY, AND WHY THERE IS NO `planes` REFERENCE ANYWHERE
 * ===========================================================================
 *
 * `e.planes` are `LiveEmitter`'s SCRATCH planes. The class returns the same
 * fourteen `Float32Array`s from every call and rewrites them on the next hop,
 * and the `ArrayBuffer` they are views onto (`LivePipeline.outBuf`) is DETACHED
 * the instant the next `infer()` transfers it. A reader that kept those views
 * would be reading the next hop's audio, or a detached buffer, with no error
 * either way.
 *
 * So every byte this file wants is consumed SYNCHRONOUSLY, inside `covered()`,
 * into buffers this file owns:
 *
 *   planes 0/1    `DrumTap.feed` accumulates into its own envelope state and
 *                 retains nothing; the sub-hop remainder (< 441 frames) is
 *                 copied into `_dpL`/`_dpR`, which this file allocated.
 *   planes 2..11  `decimate2` reads them and writes into `_dec`, which this file
 *                 allocated; `_dec` is then copied into the lane ring.
 *
 * `covered()` holds no reference to `planes` past its own return and posts
 * nothing backed by `outBuf` to the worker. That is a property of the call
 * graph, not a rule someone has to remember — there is no field on this class
 * that could hold one.
 *
 * ===========================================================================
 * PASSTHROUGH IS UNCOVERED, NEVER SILENCE
 * ===========================================================================
 *
 * `LiveEmitter.gap()` ZEROES the twelve stem planes. A transcriber that did not
 * know that would read a dropped span as digital silence and emit a confident
 * "no notes" over audible music — the exact failure R5 names, and the one this
 * feature is least able to notice on its own, because a wrong answer here looks
 * exactly like a quiet passage.
 *
 * It is closed AT THE SOURCE rather than by inspection: `fill()` is the only
 * place unseparated audio is published, so `uncovered()` is called there and
 * nowhere else, and the span it records is exactly the span that was published.
 *
 * `LivePipeline.passthroughNow()` and `passSpans` are the READ-POINTER view —
 * "is the audio leaving the speaker unseparated right now" — and they are on the
 * WRONG CLOCK for this question, by `latencySec()`. This file must not consult
 * them, and there is a comment saying so at both tap sites in `live.js`.
 *
 * ===========================================================================
 * THE CLOCK: SOURCE SECONDS, AND NOTHING ELSE ON THE WIRE
 * ===========================================================================
 *
 * Every note time this file publishes is a second on the VIDEO's clock. Not wall
 * time, not a live-relative frame, not a lane sample. That is what carries a
 * seek, an ad break, a pause and a non-unity speed without a special case
 * apiece — but "for free" is exactly what it is NOT, and the sentence used to say
 * so. The map is only meaningful while the pipeline's output-frame axis is
 * continuous, and `LivePipeline.start()` re-zeroes that axis at both ends every
 * time it runs. A pause, a seek and an ad break each restart the pipeline UNDER
 * AN OPEN TAKE, so `f0` is a fact about the CURRENT hop and is re-derived at
 * every one (`_anchorIfNeeded`, which carries the measurement of what latching it
 * cost). What falls out for free is the SHAPE; the tie has to be re-made.
 *
 *   f0            fromFrame - 2 * (lane samples produced BEFORE this hop)
 *   lane sample s  <->  absolute output frame  f0 + 2*s
 *   anchor        { frame, srcSec, rate }
 *   srcSec(F)     = anchor.srcSec + ((F - anchor.frame) / SR) * anchor.rate
 *
 * THE `/2` IS EXACT TO WITHIN ONE INPUT FRAME AND NOT TO THE SAMPLE, and the
 * difference is worth stating rather than glossing: `decimate2` carries the
 * odd-length remainder in its state (the default hop is 85 995 frames, which is
 * ODD), so the lane count is `floor((totalFrames + phase0) / 2)` — within one
 * input frame, 22.7 us, of `totalFrames / 2`, for the whole take. It does not
 * accumulate. Do not write a comment claiming it is exact.
 *
 * ponytail: `chrome.tabCapture` inserts an unmeasured tens-of-ms delay between
 * the page's clock and the ring, so the whole transcription is offset from the
 * video's timeline by that much. Ceiling: the times are not sample-exact against
 * the picture and do not claim to be. Upgrade path: measure the offset once with
 * a click track through the real capture path and subtract it in `anchor()` — it
 * is one constant and one measurement, and it is not worth taking on faith.
 *
 * ===========================================================================
 * BACKPRESSURE — THE ONE PLACE THIS FEATURE REFUSES WORK
 * ===========================================================================
 *
 * All five pitched lanes advance in LOCKSTEP: they are handed the same `len`
 * every hop and their decimators start at the same phase, so one shared lane
 * count and one shared window index describe all five. A window boundary
 * therefore enqueues FIVE windows at once, ~30 ms of inference each.
 *
 * A window boundary is 1.6401 s apart and five windows cost ~150 ms, so in the
 * steady state the queue is empty long before the next boundary. The queue cap
 * bites only when the machine is genuinely oversubscribed — and it is REACHABLE,
 * which is the property that matters: two publication hops with no drain in
 * between is twice the cap. On overflow the OLDEST queued window is dropped, its
 * lane gets a `BREAK` (a note may not span a hole in the audio), and its span is
 * recorded UNCOVERED FOR THAT LANE, because a span nobody transcribed is a span
 * nobody may claim.
 *
 * BOTH LIMITS ARE SIZED FROM THE PUBLICATION HOP AND NOT FROM THE MODEL'S — see
 * "the two limits" below for the derivation and for the 240 s replay that
 * measured what the model-hop sizing cost at each of `LIVE_HOPS`. The lane ring
 * is the second limit and it is sized so the two AGREE: it is exactly the bound
 * on how far behind the head a window the queue still holds can be, so the ring
 * never refuses what the cap kept. A window whose samples really have been
 * overwritten — which now takes a hop change the take has not seen yet — is
 * dropped at dispatch with the same three actions.
 *
 * ===========================================================================
 * THE RUNNABLE CHECK
 * ===========================================================================
 *
 * `node extension/offscreen/transcribe.js`. Everything below `selfCheck()` is
 * the check and not part of the module's surface. It drives the PURE arithmetic
 * — the window schedule, the pre-roll, the ring cut, the source clock, the
 * uncovered-span filter and the drum block splitter — because that arithmetic is
 * the half of this file that is easy to get wrong by one frame and impossible to
 * see wrong from the outside: an off-by-one in the window schedule produces a
 * plausible transcription that drifts. The worker half needs a browser, ORT and
 * a model, and it is checked where it lives (that file's header carries the
 * headless-Chromium measurements).
 */

import { SR, STEMS, BASIC_PITCH, LIVE_HOP_DEFAULT } from '../shared/config.js';
import { STEM_PLANES } from '../engine/live.js';
import { newDecimator, decimate2 } from '../engine/resample2.js';
import {
  DrumTap, DRUM_ENV_HOP, DRUM_NOTE_MS, DRUM_TAP_PLANE_L, DRUM_TAP_PLANE_R,
} from '../engine/drumtap.js';

// ------------------------------------------------------------------ constants
//
// These have exactly one reader — this file — so they live here and not in
// `shared/config.js`. CONTRIBUTING.md: no config for a value that never changes,
// and `config.js` is for values MORE THAN ONE file reads.

/**
 * How far the page's `currentTime` may disagree with this take's own prediction
 * before it counts as a JUMP rather than as jitter.
 *
 * 0.5 s, from the contract. It has to sit above the noise and below the smallest
 * seek a user can make with a scrubber: `PAGE_VIDEO` arrives on `timeupdate`,
 * about every 250 ms, and it carries the page's clock while this take's
 * prediction carries the capture ring's, so a few tens of ms of standing
 * disagreement is normal and is NOT a discontinuity. Re-anchoring on that would
 * break every lane four times a second.
 */
export const ANCHOR_JUMP_SEC = 0.5;

/**
 * The drums stem's index in WIRE ORDER, DERIVED from `drumtap.js`'s plane pin
 * rather than typed as 0.
 *
 * §0 of the contract is the order trap: plane index is `stemIdx * 2 + ch` over
 * WIRE ORDER, and there is a second, DIFFERENT order the deck draws in. Deriving
 * the index from the plane means that if the wire order ever moves, this line
 * moves with it — and the assertion below goes red at module load rather than
 * producing a transcription in which every stem is labelled as its neighbour.
 */
const DRUM_STEM_IDX = DRUM_TAP_PLANE_L / 2;
if (STEMS[DRUM_STEM_IDX] !== 'drums' || DRUM_TAP_PLANE_R !== DRUM_TAP_PLANE_L + 1) {
  throw new Error(`transcribe: engine/drumtap.js pins planes ${DRUM_TAP_PLANE_L}/${DRUM_TAP_PLANE_R}, which is `
    + `stem ${DRUM_STEM_IDX} = "${STEMS[DRUM_STEM_IDX]}" in WIRE ORDER [${STEMS.join(', ')}] — the drum tap and the `
    + 'stem order have drifted apart, and every lane below this line would be labelled as its neighbour.');
}

/**
 * The five lanes Basic Pitch sees, in WIRE ORDER. Drums is absent and that is
 * ADR 0002 / the owner's ruling R4, not an oversight: there is no permissively
 * licensed ONNX drum transcriber in existence, and Basic Pitch on a drum stem
 * produces a WRONG file rather than an empty one — toms and snare bodies come
 * back as spurious sustained low notes. Drums goes to `engine/drumtap.js`.
 */
const PITCHED = STEMS
  .map((stem, i) => ({ stem, planeL: i * 2, planeR: i * 2 + 1 }))
  .filter((_, i) => i !== DRUM_STEM_IDX);

// ------------------------------------------------------------ the two limits
//
// THE QUEUE CAP AND THE LANE RING ARE BOTH FUNCTIONS OF THE PUBLICATION HOP, AND
// NEITHER IS A COMPILE-TIME CONSTANT. That is the correction this section is:
// they were sized against `BASIC_PITCH.hop` — the MODEL's window stride — and
// the thing that actually decides how much audio piles up between two chances to
// cut is the LIVE PIPELINE's hop, which is a runtime setting (`SET_HOP` is on
// the wire, `LIVE_HOPS` offers four values, and `engine/live.js` derives H from
// whichever one is live).
//
// Measured, replaying the shipped arithmetic over 240 s at each of `LIVE_HOPS`
// with the old pair (LANE_RING 80 008, cap 8): hop 1.0 lost 0/146 windows,
// hop 1.95 lost 23/147 (15.6 %), hop 2.6 lost 54/147 (36.7 %), hop 3.9 lost
// 85/147 (57.8 %) — on an idle machine, with nothing else running. At the
// shipped default of 1.95 s one publication hop advances the lane clock 42 997
// samples, so every ~5th hop makes TWO model windows due at once: `_cutWindows`
// pushed 5 lanes x 2 and refused 2 against a cap of 8 before `_pump` ran, and
// `_pump` then refused the older window's remaining 3 because 86 840 samples of
// residency were wanted from an 80 008-sample ring.
//
// The two numbers below are derived so that THEY AGREE — the ring is never the
// thing that refuses — and the derivation is written out because it is the whole
// argument:
//
//   windowsPerHop  ceil(laneHop / BASIC_PITCH.hop)   model windows one
//                                                    publication hop can make due
//   queue cap      PITCHED.length * windowsPerHop    one hop's cut, all five lanes
//   lane ring      window + windowsPerHop * hop      what that cut needs resident
//
// WHY THE RING FOLLOWS THE CAP AND NOT THE OTHER WAY ROUND. Windows enter the
// queue in complete groups of five and leave it one at a time (from the FRONT,
// in both `_refuse` and `_pump`), so at most one group is ever partial and it is
// always the front one: a queue of at most `5 * K` entries therefore holds at
// most `K` DISTINCT window indices (1 + 5n <= 5K forces n <= K-1). With
// `windowEnd(_nextW) > _count` holding at every `_pump` — `_cutWindows` runs
// immediately after `_feedPitched` and before anything pumps — the oldest window
// the queue can still be holding is `_count - windowStart(w) < window + K*hop`
// behind the head. Set K = windowsPerHop and that bound IS the ring, exactly, so
// a window the queue kept is always still readable. It is also >= the residency
// the brief states, `window + laneSamplesPerPublicationHop`, because
// `windowsPerHop * BASIC_PITCH.hop >= laneHop` by construction.
//
// CORRECT FOR: every hop `makeLivePlan` will accept, which is every positive
// `hopSeconds` with `H + X <= SEGMENT` — not merely the four in `LIVE_HOPS`.
// The take sizes itself from the `len` the tap is actually handed (see
// `_sizeForHop`), so a hop this file has never heard of is sized for the first
// time it publishes, and a hop CHANGE mid-take re-sizes.

/** Lane samples one publication hop of `hopFrames` frames adds. `decimate2` carries
 *  the odd remainder, so a given hop produces this or one less; the ceiling is the
 *  one that has to fit. */
export const laneSamplesPerHop = (hopFrames) => Math.ceil(hopFrames / 2);

/** Model windows that can fall due in ONE publication hop. Never below 1: a hop
 *  shorter than a model hop still makes a window due on the hops it lands on. */
export const windowsPerHop = (hopFrames) => Math.max(1, Math.ceil(laneSamplesPerHop(hopFrames) / BASIC_PITCH.hop));

/**
 * Windows queued across ALL lanes before the oldest is refused, at a publication
 * hop of `hopFrames` frames.
 *
 * REACHABLE, which is the property that matters: two publication hops with no
 * drain in between is twice this, so the cap bites when the machine is genuinely
 * oversubscribed and not before. At the shipped default it is 10, against the 8
 * that shipped — and 10 is the number one hop can cut, not a comfort margin.
 */
export const queueMaxFor = (hopFrames) => PITCHED.length * windowsPerHop(hopFrames);

/** One pitched lane's pending-sample ring, in 22 050 Hz samples, at a publication
 *  hop of `hopFrames` frames. See the derivation above: it is exactly the bound on
 *  how far behind the head a window the queue still holds can be. */
export const laneRingFor = (hopFrames) => BASIC_PITCH.window + windowsPerHop(hopFrames) * BASIC_PITCH.hop;

/** The hop the embedded deck runs at and the only one it can run at — `ui/embed.js`
 *  never sends `SET_HOP`. It is the size `start()` allocates before any audio has
 *  arrived, and every other hop grows it at the first tap. */
export const DEFAULT_HOP_FRAMES = Math.round(LIVE_HOP_DEFAULT * SR);

/** The default hop's pair, for the readers that want a number rather than a
 *  function. NOT the sizes a take necessarily runs at — see `_sizeForHop`. */
export const TRANSCRIBE_QUEUE_MAX = queueMaxFor(DEFAULT_HOP_FRAMES);   // 10
export const LANE_RING = laneRingFor(DEFAULT_HOP_FRAMES);              // 116 172

/**
 * How many PUBLICATION HOPS of note history a take keeps so that a refusal can
 * hand back the notes the deck's last-pass-wins rule is about to drop. See
 * `_publish`.
 *
 * DERIVED FROM THE HOP, not chosen. `laneRingFor` IS the bound on how far behind
 * the head a window the queue can still refuse begins — that is the whole point
 * of the derivation above — so the oldest second a refusal can name is that many
 * lane samples back, which is this many hops. +2: one because `_count` has
 * already advanced within the hop being published, one because a refusal raised
 * at DISPATCH rather than at cut is reported a hop later than the cut.
 *
 * IN HOPS AND NOT IN MESSAGES, and the difference is a measurement rather than a
 * preference: a refusing hop sends a message per refused span as well as its own,
 * so `seq` runs ahead of the hop count exactly when the history is most needed.
 * Counted in messages at the default hop, a forced-refusal fixture held 33 of 46
 * drum notes — the hand-back was pruning the notes it existed to return. In hops,
 * 46 of 46.
 */
export const recentHopsFor = (hopFrames) =>
  Math.ceil(laneRingFor(hopFrames) / laneSamplesPerHop(hopFrames)) + 2;

// ------------------------------------------------------- the pure arithmetic
//
// Exported so `selfCheck()` can drive them at their own entry points rather than
// through the class — AGENTS.md's "an assertion about a function with more than
// one caller must name the entry point", applied before the fact.

/**
 * The FIRST lane sample window `w` reads. NEGATIVE for `w = 0`, and that is the
 * pre-roll: Basic Pitch prepends `BASIC_PITCH.preroll` zeros before the first
 * window, and `3840 = 15 * 256` is not a free parameter — it is exactly the 15
 * frames `BASIC_PITCH.trim` throws away from the front of every window, so the
 * pre-roll and the trim cancel and kept frame `k` of window `w` lands at
 * `w*hop + k*fftHop` with no correction term. See `keptFrameSample` below.
 *
 * @param {number} w window index, 0-based
 * @returns {number} lane sample, may be negative
 */
export function windowStart(w) {
  return w * BASIC_PITCH.hop - BASIC_PITCH.preroll;
}

/** One past the LAST lane sample window `w` reads. @returns {number} */
export function windowEnd(w) {
  return windowStart(w) + BASIC_PITCH.window;
}

/**
 * Kept frame `k` of window `w` -> lane sample. The mapping `engine/notes.js`
 * fixes at the WINDOW rather than at the stream.
 *
 * It is here as well as there because the two files own different halves of the
 * same claim and neither can check the other: `notes.js` produces `onSample`
 * with it, this file turns `onSample` into a second with it, and if they
 * disagreed the notes would be plausible and late by a growing amount. The
 * NEGATIVE CONTROL in `selfCheck()` is the naive `(w*142 + k)*256` map that a
 * reader writes by concatenating kept frames into one uniform stream: it drifts
 * by exactly 188 samples per window, 8.5 ms, 0.52 % — about 1.25 s over a
 * four-minute song.
 *
 * @param {number} w window index  @param {number} k kept frame, 0..141
 * @returns {number} lane sample at 22 050 Hz
 */
export function keptFrameSample(w, k) {
  return w * BASIC_PITCH.hop + k * BASIC_PITCH.fftHop;
}

/**
 * How many windows are cuttable, given `count` lane samples produced in total
 * and `nextW` as the next window not yet cut.
 *
 * A COUNT, deliberately: the alternative shape is "is a window due?" called in a
 * loop, which is the same arithmetic with the loop moved somewhere it cannot be
 * asserted against.
 */
export function windowsDue(count, nextW) {
  let n = 0;
  while (count >= windowEnd(nextW + n)) n++;
  return n;
}

/**
 * Lane sample -> absolute output frame. `f0` is the `from` of the first hop this
 * take saw, and the factor is 2 because `RS2_IN_RATE / RS2_OUT_RATE` is 2 — see
 * the header on what "exact" means here.
 */
export function laneToFrame(f0, s) {
  return f0 + 2 * s;
}

/**
 * Absolute output frame -> source second on the VIDEO's clock.
 *
 * `rate` is the page's `playbackRate`: at 0.75x the video advances 0.75 s of
 * ITS OWN timeline per second of captured audio, so the captured span maps onto
 * a SHORTER stretch of the video and the note times must shrink with it. Speed
 * is key-locked in this build (CONTRIBUTING.md), so the rate moves time and
 * nothing else — there is no pitch correction to apply here and adding one would
 * be inventing a second one.
 *
 * @param {{frame:number, srcSec:number, rate:number}} a
 * @param {number} F absolute output frame
 * @returns {number} seconds, unrounded
 */
export function srcSecAt(a, F) {
  return a.srcSec + ((F - a.frame) / SR) * a.rate;
}

/**
 * The 1 ms grid every time on the wire sits on.
 *
 * The wire is JSON and an unrounded double is fifteen digits of noise per note
 * with nothing downstream that can use them: `shared/midi.js` writes onto a tick
 * grid that is 1.04 ms at 120 BPM, so a millisecond is already finer than the
 * format, and the 11.6 ms model frame grid upstream is ten times coarser again.
 */
export function msGrid(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Merge `[a, b)` into a sorted, non-overlapping span list, in place, and return
 * it. Source seconds.
 *
 * The list grows with the number of DISTINCT drop episodes, not with time: a
 * take that drops one hop every hop for four minutes merges into ~120 spans, and
 * one that drops nothing holds none. There is no cap for that reason — a cap
 * here would silently forget an uncovered stretch, and the note filter below
 * would then let notes out of a span nobody read.
 */
export function mergeSpan(spans, a, b) {
  if (!(b > a)) return spans;
  let i = 0;
  while (i < spans.length && spans[i][1] < a) i++;
  let lo = a, hi = b, j = i;
  while (j < spans.length && spans[j][0] <= hi) {
    lo = Math.min(lo, spans[j][0]);
    hi = Math.max(hi, spans[j][1]);
    j++;
  }
  spans.splice(i, j - i, [lo, hi]);
  return spans;
}

/**
 * Take `[a, b)` back OUT of a merged span list, in place, and return it. The
 * inverse of `mergeSpan`, and the second half of ONE rule.
 *
 * THE RULE IS "LAST PASS WINS" AND ITS OWNER IS `MidiTake` (`shared/midi.js`).
 * The deck is where a take lives, and `MidiTake.accept` has always applied both
 * directions: a replayed span that comes back COVERED is unioned into the covered
 * list and SUBTRACTED from the uncovered one. This file only ever grew its own
 * list, so the two halves of one rule did opposite things — seek back over a
 * passage the first pass could not read, play it through correctly, and the deck
 * would un-mark it while this file went on refusing to emit a single note inside
 * it. A user replays a passage precisely because the first pass was bad, and the
 * second pass was being discarded in silence.
 *
 * This side is the one that was wrong, and it is corrected to match rather than
 * the other way round: the deck's behaviour is what the FAQ already tells people
 * to expect, and a note filter that contradicts the coverage figure printed next
 * to it is the more expensive of the two mistakes.
 *
 * ponytail: this is `MidiTake`'s `subtractSpan` written out a second time, six
 * lines of it, because that one is module-private and `shared/midi.js` is not
 * this slice's to change. Ceiling: two implementations of one rule can drift, and
 * nothing here would notice. Upgrade path: export `subtractSpan` from
 * `shared/midi.js` and import it — one added word in that file and one import in
 * this one, at which point the rule has one owner in code as well as in prose.
 */
export function cutSpan(spans, a, b) {
  if (!(b > a)) return spans;
  const out = [];
  for (const [x, y] of spans) {
    if (y <= a || x >= b) { out.push([x, y]); continue; }
    if (x < a) out.push([x, a]);
    if (y > b) out.push([b, y]);
  }
  spans.length = 0;
  for (const s of out) spans.push(s);
  return spans;
}

/** Is `t` inside any `[a, b)` of a merged span list? */
export function inSpans(spans, t) {
  for (let i = 0; i < spans.length; i++) {
    if (t < spans[i][0]) return false;          // sorted: nothing later can match
    if (t < spans[i][1]) return true;
  }
  return false;
}

/**
 * Split one contiguous block into what `DrumTap.feed` will accept.
 *
 * `feed` THROWS on a block that is not a whole number of envelope hops, and it
 * is right to: a partial hop would put every later hop on a shifted grid and
 * every later onset at a wrong time, with nothing downstream able to see it. But
 * the ring tap's hop is `plan.H` frames, which is 85 995 at the default (a whole
 * 195 hops, by luck) and is NOT guaranteed to be at any other hop setting or at
 * the short chunk 0 — so this file carries the remainder rather than assuming.
 *
 * @param {number} pendN frames already stashed from the previous block, 0..hop-1
 * @param {number} len   frames in this block
 * @param {number} hop   DRUM_ENV_HOP
 * @returns {{fill:number, completes:boolean, whole:number, tail:number}}
 *   `fill` frames go to the stash, `whole` frames are fed directly from the
 *   block, `tail` frames are stashed for next time, and
 *   `fill + whole + tail === len` — which is the accounting `selfCheck()`
 *   asserts, because losing a frame here is silent and permanent.
 */
export function drumSplit(pendN, len, hop) {
  if (!Number.isInteger(pendN) || pendN < 0 || pendN >= hop) {
    throw new Error(`drumSplit: stash is ${pendN}, which is not a partial ${hop}-frame hop`);
  }
  if (!Number.isInteger(len) || len < 0) {
    throw new Error(`drumSplit: block length ${len} is not a frame count`);
  }
  const fill = pendN > 0 ? Math.min(hop - pendN, len) : 0;
  const completes = pendN > 0 && pendN + fill === hop;
  const rest = len - fill;
  const whole = rest - (rest % hop);
  return { fill, completes, whole, tail: rest - whole };
}

/**
 * Copy window `w` out of a lane ring into `dst`, zero-filling the pre-roll.
 *
 * @param {Float32Array} ring  LANE_RING samples, indexed modulo its length
 * @param {number} count  total lane samples ever written into `ring`
 * @param {number} w  window index
 * @param {Float32Array} dst  BASIC_PITCH.window samples
 * @param {boolean} [tail]  THE TAKE IS OVER AND THIS IS ITS LAST WINDOW. Only
 *   then may the samples past `count` be zeros: there is no audio after them, so
 *   the pad is the end of the recording rather than a hole in the middle of it,
 *   and `_ingest` drops anything the model reports from inside it anyway.
 * @throws {Error} if the window's samples are not all resident — either they
 *   have been overwritten (the lane fell too far behind) or they have not
 *   arrived yet (the caller's schedule is wrong). IT THROWS RATHER THAN PADDING:
 *   a short window padded with zeros decodes into a plausible note list with a
 *   silent gap in it, and nothing downstream could tell that from a quiet bar.
 *   `tail` is the ONE case where that argument does not apply, and it is a
 *   caller's explicit claim rather than a fallback this function takes on its own.
 */
export function cutWindow(ring, count, w, dst, tail = false) {
  const cap = ring.length;
  const from = windowStart(w), to = windowEnd(w);
  if (count < to && !tail) {
    throw new Error(`cutWindow: window ${w} ends at lane sample ${to} and only ${count} have been produced`);
  }
  if (count - Math.max(0, from) > cap) {
    throw new Error(`cutWindow: window ${w} starts at lane sample ${from}, ${count - from} behind the head, `
      + `and the ring holds ${cap}`);
  }
  if (dst.length < BASIC_PITCH.window) {
    throw new Error(`cutWindow: dst holds ${dst.length}, needs ${BASIC_PITCH.window}`);
  }
  for (let i = 0, s = from; s < to; i++, s++) {
    // s < 0 is the pre-roll: zeros BEFORE the take's first sample. It happens
    // only for w = 0 and it is exactly BASIC_PITCH.preroll samples wide.
    // s >= count is the TAIL pad: zeros AFTER the take's last sample, and only
    // when the caller has said the take is over.
    dst[i] = (s < 0 || s >= count) ? 0 : ring[s % cap];
  }
  return dst;
}

/**
 * The last lane sample any window up to `nextW - 1` actually read a KEPT frame
 * over — one frame's extent past the last kept frame's start.
 *
 * The kept grids of consecutive windows OVERLAP by 188 samples
 * (`keep*fftHop - hop`), so this really is a continuous coverage front and not a
 * per-window figure: everything below it has been through the model, everything
 * above it has not. `flush()` is the only caller and it is what tells it how many
 * final windows the tail still needs.
 */
export function keptThrough(nextW) {
  if (nextW <= 0) return 0;
  return keptFrameSample(nextW - 1, BASIC_PITCH.keep - 1) + BASIC_PITCH.fftHop;
}

// =========================================================== the orchestrator

/**
 * One deck's MIDI take.
 *
 * Created by `offscreen/engine.js` on `MIDI_START`, handed to
 * `LivePipeline.attachTranscriber` so the ring tap can reach it, and destroyed
 * on `MIDI_STOP`. One per deck; the engine holds at most two.
 */
export class Transcriber {
  /**
   * @param {object} d
   * @param {(rel: string) => string} d.assetUrl  the Host's resolver, handed
   *        down by offscreen/engine.js. THE ONE THING THIS NEEDS FROM A HOST,
   *        and it is an EXISTING duty: the model is a unit-relative asset
   *        (`BASIC_PITCH.asset`) exactly like the worklet modules and the ORT
   *        runtime, so adding a Host duty for it would be inventing a second way
   *        to answer a question `assetUrl` already answers.
   * @param {(msg: object) => void} d.send  the engine's deck-tagged send
   * @param {(line: string) => void} d.log
   * @param {() => {currentTime:number, duration:number, ended:boolean}|null} d.videoNow
   * @param {() => number} d.rateNow  the page rate this deck is at
   * @param {'A'|'B'} d.deck
   */
  constructor(d) {
    if (!d || typeof d.assetUrl !== 'function') {
      // The message names the duty, not the module: `test.js` scans this file's
      // STRINGS as well as its code for `host.<name>` reaches, so a path written
      // as "(shared/host.js)" reads to that scan as an undeclared duty called
      // `js`. Say the duty out loud instead; it is the more useful sentence
      // anyway.
      throw new TypeError('Transcriber: no assetUrl resolver — the model and the ORT runtime are both '
        + "unit-relative assets and this class resolves neither on its own. See EngineHost's assetUrl duty.");
    }
    this.d = d;
    this.deck = d.deck;

    /** the second wasm instance. null until the first covered hop of a take. */
    this._worker = null;
    this._ready = false;
    this._inFlight = false;
    this._runId = 0;

    /** open take? `covered`/`uncovered` are a single compare when this is false. */
    this._open = false;
    this._draining = false;
    this._flushSent = false;

    /** the FIRST hop's absolute output frame; null until it arrives. */
    this._f0 = null;
    /** {frame, srcSec, rate} — the video clock's tie to the ring. */
    this._anchor = null;

    /** wire bookkeeping */
    this._seq = 0;
    this._notesSent = 0;
    this._coveredSec = 0;
    this._uncoveredSec = 0;
    this._lastSpanTo = 0;
    this._dropped = 0;
    this._fault = null;

    /** closed notes waiting for the next published hop. */
    this._outbox = [];
    /**
     * PER STEM, merged uncovered spans, SOURCE SECONDS. See mergeSpan().
     *
     * ONE LIST PER STEM AND NOT ONE LIST, because a refusal is a fact about ONE
     * LANE. A refused `bass` window says nothing about what the piano lane read
     * over the same seconds and nothing at all about drums, which never goes
     * through a model window. A single shared list threw away every stem's notes
     * over a span one stem could not read.
     */
    this._unc = null;
    /** spans refused since the last publish, merged, SOURCE SECONDS. */
    this._refused = [];
    /** notes already published, tagged with the PUBLICATION HOP that carried
     *  them, so a refusal can hand back what the deck's last-pass-wins rule is
     *  about to drop. */
    this._recent = [];
    this._recentHops = recentHopsFor(DEFAULT_HOP_FRAMES);
    /** published hops, which is NOT `_seq`: a refusing hop sends more than one
     *  message. It is the unit `_recentHops` is derived in. */
    this._hops = 0;

    /** per-lane DSP + buffers; built by start(), dropped by stop(). */
    this._lanes = null;
    this._drum = null;
    this._dec = null;         // decimator output scratch, sized on first hop
    this._dpL = null;         // drums sub-hop remainder
    this._dpR = null;
    this._dpN = 0;
    this._dpFrom = 0;

    /** the publication hop this take has been sized for, in FRAMES. The largest
     *  `len` the tap has been handed; 0 until the first hop. See _sizeForHop(). */
    this._hopFrames = 0;
    this._queueMax = TRANSCRIBE_QUEUE_MAX;

    /** shared across the five pitched lanes — they advance in lockstep. */
    this._count = 0;          // lane samples produced this take
    this._nextW = 0;          // next window index to cut
    this._queue = [];         // [{stem, w, tail?}], oldest first
  }

  // ------------------------------------------------------------- the lifecycle

  /**
   * Open a take. `seq` resets to 0 so the deck's first message is 1.
   *
   * THE WORKER IS CREATED HERE, AND HERE IS THE ONLY PLACE IT IS. Lazily, on the
   * first take and never at boot — a user who never presses the button never
   * pays for a second wasm instance (ADR 0002 / the owner's ruling R5).
   *
   * "MIDI_START COSTS NO BYTES" is about the 109 MB htdemucs weights, which this
   * does not touch: the Basic Pitch weights are 225 KiB and committed to the
   * tree, so they are already on disk under any Host that has the unit at all.
   * Arming must not become a download prompt the user did not ask for, and this
   * is not one.
   *
   * AT `start()` AND NOT AT THE FIRST HOP, which is a real difference and not a
   * tidy-up: creating the session takes time, the first window is due ~1.86 s
   * after the first hop, and the queue below refuses work when it backs up. Made
   * at the first hop, a slow session creation would eat the opening of the take
   * and mark it lossy for no reason. Made here, it overlaps the wait.
   */
  start() {
    this.stop();
    this._open = true;
    this._unc = new Map(STEMS.map((s) => [s, []]));
    this._lanes = new Map();
    for (const p of PITCHED) {
      this._lanes.set(p.stem, {
        planeL: p.planeL,
        planeR: p.planeR,
        st: newDecimator(),
        // THE DEFAULT HOP'S RING, and it is a starting size rather than the
        // answer: no audio has arrived, so the hop this deck is about to run at
        // is not knowable here. `_sizeForHop` grows it at the first tap if the
        // hop turns out to be a bigger one, before a sample is written.
        ring: new Float32Array(LANE_RING),
        // ONE window buffer per lane, allocated here and ping-ponged with the
        // worker for the life of the take. `null` while the worker holds it —
        // and because exactly one RUN is in flight at a time, at most one lane
        // is ever in that state.
        win: new Float32Array(BASIC_PITCH.window),
      });
    }
    this._drum = new DrumTap({ sampleRate: SR });
    this._dpL = new Float32Array(DRUM_ENV_HOP);
    this._dpR = new Float32Array(DRUM_ENV_HOP);
    this._dpN = 0;
    this._ensureWorker();
    this.d.log(`deck ${this.deck} MIDI take open — ${PITCHED.length} pitched lanes + drums`);
  }

  /**
   * The take is over. Drop the DSP state and terminate the worker.
   *
   * `terminate()` and not just `DISPOSE`: the graceful release is posted first
   * because it hands ORT's wasm heap back, but terminating is what actually
   * frees the instance, and a take that ended because the deck went away must
   * not leave 100+ MB of wasm resident until the offscreen document is reaped.
   */
  stop() {
    if (this._worker) {
      try { this._worker.postMessage({ type: 'DISPOSE' }); } catch { /* already gone */ }
      this._worker.onmessage = null;
      this._worker.onerror = null;
      this._worker.terminate();
      this._worker = null;
    }
    this._ready = false;
    this._inFlight = false;
    this._open = false;
    this._draining = false;
    this._flushSent = false;
    this._lanes = null;
    this._drum = null;
    this._dec = null;
    this._dpL = this._dpR = null;
    this._dpN = 0;
    this._f0 = null;
    this._anchor = null;
    this._seq = 0;
    this._notesSent = 0;
    this._coveredSec = 0;
    this._uncoveredSec = 0;
    this._lastSpanTo = 0;
    this._dropped = 0;
    this._fault = null;
    this._outbox = [];
    this._unc = null;
    this._refused = [];
    this._recent = [];
    this._recentHops = recentHopsFor(DEFAULT_HOP_FRAMES);
    this._hops = 0;
    this._hopFrames = 0;
    this._queueMax = TRANSCRIBE_QUEUE_MAX;
    this._count = 0;
    this._nextW = 0;
    this._queue = [];
  }

  /** Is a take open? The engine's `NOT_RUNNING` test. */
  get open() { return this._open; }

  // ----------------------------------------------------------------- the tap

  /**
   * A COVERED hop. Called from `LivePipeline.runChunk`, AFTER `this.out.write()`.
   *
   * @param {number} fromFrame absolute live-relative output frame of `planes[q][0]`
   * @param {number} len frames
   * @param {Float32Array[]} planes the emitter's SCRATCH planes — copied out
   *        before this returns, never retained. See the header.
   *
   * IT CANNOT THROW INTO `runChunk`. One try/catch around the whole body,
   * latching the way `LivePipeline.tickBpm` latches: counted, logged once,
   * `state: 'fault'` on the wire from then on, and the take stops publishing.
   * A tap that silently carried on with torn DSP state would produce a confident
   * wrong transcription, which is the one output this feature must never make.
   */
  covered(fromFrame, len, planes) {
    if (!this._open || this._fault || len <= 0) return;
    try {
      this._sizeForHop(len);
      this._anchorIfNeeded(fromFrame);
      this._feedDrums(fromFrame, len, planes);
      this._feedPitched(len, planes);
      this._cutWindows();
      this._pump();
      this._publish(fromFrame, len, true);
    } catch (e) {
      this._faulted('the ring tap', 'WORKER_FAILED', e);
    }
  }

  /**
   * An UNCOVERED hop. Called from `LivePipeline.fill()`, AFTER `this.out.write()`.
   *
   * NOTHING IS READ FROM THE PLANES, and the signature does not take them:
   * `LiveEmitter.gap()` has zeroed the twelve stem planes, so there is nothing
   * there but silence that is not silence.
   *
   * @param {number} fromFrame absolute live-relative output frame
   * @param {number} len frames
   */
  uncovered(fromFrame, len) {
    if (!this._open || this._fault || len <= 0) return;
    try {
      this._sizeForHop(len);
      this._anchorIfNeeded(fromFrame);
      /**
       * ZEROS, NOT A HOLE, into every pitched lane. The lane sample <-> frame map
       * is affine (`f0 + 2*s`) and a hop that advanced the frame clock without
       * advancing the lane clock would bend it permanently — every note after the
       * first drop would be early by the length of the drop. `len >> 1` is the
       * same count `decimate2` would have returned for a block of this length at
       * phase 0, so the map keeps the same within-one-input-frame property the
       * header states.
       */
      const zeros = len >> 1;
      for (const lane of this._lanes.values()) this._append(lane, null, zeros);
      this._count += zeros;
      // The audio is GONE for this span, so nothing may span it: every lane's
      // carry is closed at its last real frame and the drum tap's filter tail,
      // pending onsets and medians go with it.
      this._breakAll();
      this._drumFlush();
      this._drum.reset();
      this._dpN = 0;
      // Windows may now be due over the zeros. Cutting them is correct and
      // cheap: the model reads silence, finds nothing, and the lane's window
      // counter stays in step with the lane's sample counter — which is what the
      // BREAK above depends on.
      this._cutWindows();
      this._pump();
      this._publish(fromFrame, len, false);
    } catch (e) {
      this._faulted('the passthrough tap', 'WORKER_FAILED', e);
    }
  }

  /**
   * SIZE THE TWO LIMITS FOR THE HOP THIS DECK IS ACTUALLY RUNNING AT.
   *
   * THE HOP IS LEARNED FROM THE TAP AND NOT ASKED FOR, and that is not laziness:
   * a take is created by `MIDI_START` and may never be attached to a live
   * pipeline at all (`offscreen/engine.js` accepts the gesture whether or not
   * live is running), it OUTLIVES the pipeline that feeds it — `LIVE_STOP`
   * detaches the tap and the next `LIVE_START` re-attaches into the SAME take —
   * and `SET_HOP` is deferred to that next start. So the hop is not a property
   * of the take's birth; it is a property of each hop that arrives, and it can
   * change under a take that is already open. The `len` the emitter hands over
   * IS the publication hop, which is the number both limits are functions of.
   *
   * IT ONLY EVER GROWS, over the largest `len` this take has seen. A ring sized
   * for a longer hop is correct at a shorter one — residency is a minimum, and
   * the cap is a floor on how much work may be in flight — while shrinking would
   * throw away audio a window already queued still needs. The cost of never
   * shrinking is bounded by the longest hop the session used, which is at most
   * `LIVE_HOPS`'s largest: 152 336 samples per lane, 609 KiB, five lanes.
   *
   * CHUNK 0 IS SHORT (`H - X`) and that is fine rather than lucky: it is sized
   * from what it is, and hop 1 grows it if `ceil(laneHop / BASIC_PITCH.hop)` came
   * out larger. At all four of `LIVE_HOPS` the short chunk 0 already lands on the
   * same `windowsPerHop` as the steady hop (1, 2, 2, 3), so nothing regrows at
   * any hop this build offers — but the regrow path is what makes that a
   * measurement rather than an assumption, and `selfCheck()` drives it.
   *
   * @param {number} len frames published in this hop
   */
  _sizeForHop(len) {
    if (len <= this._hopFrames) return;
    this._hopFrames = len;
    this._queueMax = queueMaxFor(len);
    this._recentHops = recentHopsFor(len);
    const cap = laneRingFor(len);
    if (!this._lanes) return;
    for (const lane of this._lanes.values()) {
      const old = lane.ring;
      if (cap <= old.length) continue;
      // The resident samples move with the ring, because the ring is indexed
      // modulo its length and the length is what just changed. Copying by lane
      // sample rather than by slot is the only shape that survives that.
      const next = new Float32Array(cap);
      for (let s = Math.max(0, this._count - old.length); s < this._count; s++) {
        next[s % cap] = old[s % old.length];
      }
      lane.ring = next;
    }
    if (cap > LANE_RING) {
      this.d.log(`deck ${this.deck} MIDI sized for a ${(len / SR).toFixed(2)}s hop — `
        + `ring ${cap}, queue ${this._queueMax}`);
    }
  }

  /**
   * Tie this take's frame clock to the video's clock, or re-tie it after a jump.
   *
   * @param {number} frame absolute output frame the reading belongs to — the
   *        CAPTURE head (`LivePipeline.frameNow()`), because the audio being
   *        captured now is the audio the picture is showing now. Using the
   *        emitter's commit instead would bake `latencySec()` — seconds — into
   *        every note time.
   * @param {number} srcSec the page's `currentTime` at that frame
   * @param {number} rate the page's `playbackRate`
   *
   * THE JUMP TEST LIVES HERE, not at the call site, and that is deliberate:
   * §8.9 of the contract gives "what second a sample is" to this file, and
   * `PAGE_VIDEO` arrives about four times a second, so a caller that re-anchored
   * on every one of them would `BREAK` every lane four times a second and no
   * note would ever survive long enough to be written. What the caller supplies
   * is a READING; what this decides is whether the reading is a discontinuity.
   */
  anchor(frame, srcSec, rate) {
    if (!this._open) return;
    if (!Number.isFinite(frame) || !Number.isFinite(srcSec) || srcSec < 0) return;
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    if (this._anchor) {
      const drift = srcSec - srcSecAt(this._anchor, frame);
      if (r === this._anchor.rate && Math.abs(drift) <= ANCHOR_JUMP_SEC) return;
      this.d.log(`deck ${this.deck} MIDI re-anchor at ${srcSec.toFixed(2)}s `
        + `(${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s, rate ${this._anchor.rate} -> ${r})`);
      // A seek and a speed change are both discontinuities in the SOURCE clock,
      // and a note may not span one: what sounded before the jump and what
      // sounds after it are different parts of the song.
      this._breakAll();
      this._drumFlush();
      this._drum.reset();
      this._dpN = 0;
    }
    this._anchor = { frame, srcSec, rate: r };
  }

  /**
   * Close everything, drain the worker, then send the last `MIDI_NOTES` and
   * `MIDI_FLUSHED`.
   *
   * The final `MIDI_NOTES` carries a ZERO-LENGTH span at the take's last
   * `spanTo`. That is not a placeholder: `spanFrom`/`spanTo` describe COVERAGE,
   * and this message covers nothing new — it delivers notes that CLOSED during
   * the drain, which is exactly what the wire format says a message's notes are.
   * `MidiTake.accept` only unions a span when `to > from`, so a zero-length span
   * adds no seconds to the coverage figure, which is the honest answer.
   *
   * THE TAIL IS CUT HERE, and it is the reason `coveredSec` is not a flattering
   * number. Windows are cut when a WHOLE one has arrived, so at the moment the
   * user presses Convert the audio past the last complete window has had no model
   * pass — measured on a clean 12 s fixture with zero drops: `coveredSec` said
   * 12.000 s, the last lane sample any window read was 253 336 (11.489 s), and
   * the scored piano note at 11.5 s was absent from the pack. That is a coverage
   * claim that is wrong in the FLATTERING direction, in a feature whose whole
   * argument is that the figure never overstates. `_cutTail()` closes it.
   */
  flush() {
    if (!this._open || this._draining) return;
    this._draining = true;
    try {
      this._drumFlush();
      this._cutTail();
      this._pump();
    } catch (e) {
      this._faulted('the drain', 'WORKER_FAILED', e);
    }
    /**
     * NO SESSION MEANS NOTHING TO DRAIN, so finish here rather than wait for a
     * reply that cannot come. `!this._ready` is the case worth naming: a user
     * who arms and converts within a second of each other flushes while the ORT
     * session is still being created, and `_pump()` will not post a FLUSH into a
     * worker that has not answered READY. Without this the deck would sit in
     * `finishing` until its own `latencySec + 2 s` deadline and then call a
     * perfectly good (if short) take `bad`.
     */
    if (!this._worker || !this._ready || this._fault) this._finishFlush();
  }

  /**
   * The `midi` field on `LIVE_STATE` (§4.3 of the wire). NEVER THROWS.
   *
   * The same discipline `LivePipeline.bpmPayload()` applies, for the same reason:
   * a tap that silently stopped presents as one that is listening and has not
   * decided. A `state` of `'fault'` with a non-null `fault` is the SECOND
   * carrier of the news that the take cannot be trusted — `MIDI_ERROR` is the
   * first — and it is here because the news that must not go missing is exactly
   * the news a single carrier is worst at delivering.
   *
   * THE SPANS ARE NOT HERE. They are on `MIDI_NOTES` and nowhere else; this
   * field carries counters, and its job is to be a SECOND CARRIER OF `seq` — if
   * the engine's `seq` runs ahead of the highest the deck holds, the deck has
   * lost a message that would have told it so itself.
   */
  payload() {
    let state = 'off';
    if (this._fault) state = 'fault';
    else if (this._draining) state = 'draining';
    else if (this._open) state = 'running';
    return {
      state,
      seq: this._seq,
      notes: this._notesSent,
      coveredSec: msGrid(this._coveredSec),
      uncoveredSec: msGrid(this._uncoveredSec),
      queued: this._queue.length + (this._inFlight ? 1 : 0),
      dropped: this._dropped,
      fault: this._fault,
    };
  }

  // -------------------------------------------------------------- the drums

  /**
   * Planes 0/1 -> `DrumTap`, at 44 100 Hz, per channel, NEVER mono-summed: a
   * polarity-inverted stereo drums stem cancels to digital silence under a mono
   * sum and this tap would then report nothing forever on fully audible drums.
   * `drumtap.js` and `bpmtap.js` both make that argument for themselves.
   */
  _feedDrums(fromFrame, len, planes) {
    const l = planes[DRUM_TAP_PLANE_L], r = planes[DRUM_TAP_PLANE_R];
    const hop = DRUM_ENV_HOP;
    const s = drumSplit(this._dpN, len, hop);
    let off = 0;
    if (s.fill > 0) {
      this._dpL.set(l.subarray(0, s.fill), this._dpN);
      this._dpR.set(r.subarray(0, s.fill), this._dpN);
      this._dpN += s.fill;
      off = s.fill;
      if (s.completes) {
        this._collect(this._drum.feed(this._dpL, this._dpR, hop, this._dpFrom));
        this._dpN = 0;
      }
    }
    if (s.whole > 0) {
      this._collect(this._drum.feed(
        l.subarray(off, off + s.whole), r.subarray(off, off + s.whole), s.whole, fromFrame + off,
      ));
      off += s.whole;
    }
    if (s.tail > 0) {
      // The stash is a COPY into buffers this file owns — `planes` is scratch
      // that the next hop rewrites, so a view kept here would silently become
      // the next hop's audio.
      this._dpL.set(l.subarray(off, off + s.tail), 0);
      this._dpR.set(r.subarray(off, off + s.tail), 0);
      this._dpN = s.tail;
      this._dpFrom = fromFrame + off;
    }
  }

  /** DrumTap onsets -> the outbox, as wire notes on the source clock. */
  _collect(onsets) {
    for (const o of onsets) {
      // `onFrame` is ALREADY an absolute output frame — the drum tap runs on the
      // ring's own clock — so it goes straight through `srcSec` with no lane
      // arithmetic. That is the one lane in this file with no `/2` in it.
      this._pushNote(STEMS[DRUM_STEM_IDX], o.pitch, o.vel,
        this._srcSec(o.onFrame), this._srcSec(o.onFrame) + DRUM_NOTE_MS / 1000);
    }
  }

  /**
   * Confirm every pending drum onset immediately, at the cost of the decay test.
   * `DrumTap.flush()` classifies an unfinished onset with `hiLater = 0`, so an
   * air-band hit at a discontinuity becomes a CLOSED HAT and never a crash —
   * flush cannot see the future, and 42 is the answer that claims less.
   */
  _drumFlush() {
    if (this._drum) this._collect(this._drum.flush());
  }

  // ------------------------------------------------------- the pitched lanes

  /**
   * Planes 2..11 -> five 22 050 Hz mono lanes.
   *
   * All five are handed the same `len` and their decimators started at the same
   * phase, so they MUST return the same count. That is checked rather than
   * assumed: the shared `_count` and `_nextW` below are what make one window
   * schedule describe five lanes, and a lane that had silently drifted by a
   * sample would put its notes on a different clock from its neighbours' with
   * nothing to show for it. AGENTS.md — if the thing being inspected disagrees,
   * that IS the failure.
   */
  _feedPitched(len, planes) {
    const want = (len + 1) >> 1;                 // ceil: the phase decides which
    if (!this._dec || this._dec.length < want) this._dec = new Float32Array(want);
    let wrote = -1;
    for (const [stem, lane] of this._lanes) {
      const n = decimate2(lane.st, planes[lane.planeL], planes[lane.planeR], this._dec, len);
      if (wrote < 0) wrote = n;
      else if (n !== wrote) {
        throw new Error(`lane ${stem} decimated ${len} frames to ${n} samples where the lanes before it `
          + `produced ${wrote} — the five pitched lanes must advance in lockstep or they are on five clocks`);
      }
      this._append(lane, this._dec, n);
    }
    this._count += wrote;
  }

  /** Append `n` samples of `src` (or `n` zeros when `src` is null) to a lane ring. */
  _append(lane, src, n) {
    const ring = lane.ring, cap = ring.length;
    let head = this._count % cap;
    let i = 0;
    while (i < n) {
      const run = Math.min(n - i, cap - head);
      if (src) ring.set(src.subarray(i, i + run), head);
      else ring.fill(0, head, head + run);
      i += run;
      head = (head + run) % cap;
    }
  }

  /**
   * Enqueue every window that has become cuttable, oldest first.
   *
   * The queue holds DESCRIPTORS, not buffers, and the audio is cut out of the
   * ring at DISPATCH time. That is what lets a lane hold two pending windows
   * against one ping-pong buffer — and it is why the dispatch has to re-check
   * that the samples are still resident.
   */
  _cutWindows() {
    const due = windowsDue(this._count, this._nextW);
    for (let i = 0; i < due; i++) {
      const w = this._nextW++;
      for (const stem of this._lanes.keys()) this._queue.push({ stem, w });
    }
    while (this._queue.length > this._queueMax) this._refuse(this._queue.shift(), 'the queue is full');
  }

  /**
   * The take is over: cut whatever the window schedule has not reached, padded
   * with zeros out to `BASIC_PITCH.window` because the model takes a fixed-size
   * input.
   *
   * TWO WINDOWS AT MOST, and it is a loop rather than a `+1` because which it is
   * depends on where `_count` fell. Window `w`'s kept frames cover lane samples
   * up to `w*hop + keep*fftHop` = `w*hop + 36 352`, and `_count` may sit up to
   * `windowEnd(w) - 1` = `w*hop + 40 003`, so one window can leave 3 651 samples
   * (0.166 s) still unread and a second one always finishes it.
   *
   * IT DOES NOT GO THROUGH `_cutWindows` AND IS NOT CAPPED. The cap exists to
   * refuse work that would pile up behind more work; nothing more is coming, and
   * the residency these windows need is trivially satisfied — `_count` is inside
   * window `_nextW` by construction, so `_count - windowStart(_nextW) < window`
   * and the next one is nearer still.
   *
   * THE PAD IS NOT A HOLE. `cutWindow`'s docstring is emphatic that a short
   * window padded with zeros decodes into a plausible note list with a silent gap
   * in it — true everywhere except here, where the zeros are after the last
   * sample of the take rather than in the middle of it. Zeros produce no onsets;
   * `_ingest` drops anything the model reports from past `_count` regardless.
   */
  _cutTail() {
    if (!this._lanes || this._count <= 0) return;
    let cut = 0;
    while (keptThrough(this._nextW) < this._count && cut < 2) {
      const w = this._nextW++;
      for (const stem of this._lanes.keys()) this._queue.push({ stem, w, tail: true });
      cut++;
    }
    if (cut) {
      this.d.log(`deck ${this.deck} MIDI tail — ${cut} final window${cut === 1 ? '' : 's'} `
        + `for lane samples ${keptThrough(this._nextW - cut)}..${this._count}`);
    }
  }

  /**
   * Refuse one queued window. THE THREE ACTIONS ARE ONE ACTION and they are here
   * together so they cannot come apart:
   *
   *   1. the lane gets a `BREAK` — a note may not span a hole in the audio;
   *   2. the window's span is recorded UNCOVERED FOR THAT LANE — a span nobody
   *      transcribed is a span nobody may claim, and every note of THAT LANE
   *      that lands inside it is dropped on the way out;
   *   3. `dropped` goes up, so `payload()` says the take is lossy rather than
   *      presenting as one that heard nothing there.
   *
   * THE SPAN IS THE WINDOW'S, NOT THE HOP'S, and `_publish` is what puts it on
   * the wire under its own `covered: false`. That correction is the whole of the
   * second defect this section carries: the refused window's kept span and the
   * hop that refuses it are 1.81 s apart at the default hop, so reporting the hop
   * told the deck the wrong seconds were uncovered AND deleted a whole hop of
   * correctly transcribed notes from every stem — drums included, which never
   * goes through a model window at all. Measured before the fix, on a 34 s
   * fixture: `MidiTake.uncoveredSpans` came back `[[11.65,13.6],[21.4,23.35],
   * [31.15,33.1]]` where the untranscribed spans were `[[9.84,11.48],
   * [19.68,21.32],[29.52,31.16]]`.
   */
  _refuse(q, why) {
    this._dropped++;
    this._break(q.stem);
    const a = this._srcSec(laneToFrame(this._f0 ?? 0, keptFrameSample(q.w, 0)));
    const b = this._srcSec(laneToFrame(this._f0 ?? 0, keptFrameSample(q.w, BASIC_PITCH.keep - 1)));
    // THE 1 ms GRID, here as well as in `_pushNote`, because these two numbers
    // reach the wire as a span: `_publishRefusals` sends them as `spanFrom` /
    // `spanTo`, and §4.2 puts every time on that grid. It also makes the span and
    // the `onSec` it is compared against commensurable, which an unrounded span
    // and a rounded note time are not.
    const lo = msGrid(Math.min(a, b)), hi = msGrid(Math.max(a, b));
    mergeSpan(this._unc.get(q.stem), lo, hi);
    mergeSpan(this._refused, lo, hi);
    // Notes ALREADY in the outbox for this lane inside the span go no further.
    // The filter is per-stem, so the other four lanes' notes and the drum notes
    // over the same seconds stay exactly where they are.
    this._outbox = this._outbox.filter((n) => !inSpans(this._unc.get(n.stem), n.onSec));
    if (this._dropped === 1 || this._dropped % 10 === 0) {
      this.d.log(`deck ${this.deck} MIDI dropped ${q.stem} window ${q.w} — ${why} (${this._dropped} total)`);
    }
  }

  // ------------------------------------------------------------- the worker

  /**
   * Create the second wasm instance, once, from `start()` and nowhere else.
   *
   * NEVER INSIDE `inference.worker.js`. A concurrent `run()` on one wasm
   * instance permanently wedges BOTH sessions — the deck stops separating, the
   * transcription stops, and nothing on screen says why (`offscreen/deck.js:18-25`,
   * the owner's ruling R5). Two workers give two instances and make the
   * collision structurally impossible.
   */
  _ensureWorker() {
    if (this._worker || this._fault) return;
    /**
     * THE WORKER URL IS RELATIVE AND DOES NOT GO THROUGH `assetUrl`, for the
     * reason `workerbackend.js` spells out: `import.meta.url` says "the file next
     * to this one", which is true under a `chrome-extension://` origin and under
     * a desktop Host alike, and routing it through the Host would hand the Host
     * authority over the unit's own directory layout. `assetUrl` is for the files
     * the unit does NOT reach by import — the ORT runtime and the model.
     */
    try {
      const w = new Worker(new URL('../workers/transcribe.worker.js', import.meta.url), { type: 'module' });
      /**
       * A module worker that cannot resolve its static imports fires `onerror`
       * with an EMPTY message, which is the one failure mode this path has that
       * says nothing at all. `transcribe.worker.js` statically imports
       * `../vendor/ort/ort.all.bundle.min.mjs`, which `.gitignore` excludes and
       * `tools/fetch-vendor.sh` puts there — so that is the sentence to write
       * when the browser has none.
       */
      w.onerror = (e) => this._faulted('the transcription worker', 'WORKER_FAILED',
        new Error((e && e.message)
          || `it crashed before it could say why — most likely ${this.d.assetUrl('vendor/ort/')} `
          + 'is not readable, which is what `bash tools/fetch-vendor.sh` puts there'));
      w.onmessage = (e) => this._receive(e.data);
      w.postMessage({
        type: 'INIT',
        // A DIRECTORY URL, trailing slash and all: ORT appends its own file names
        // to it. The file-URL form fails inside the runtime with "w is not a
        // function", several layers from the mistake.
        wasmDirUrl: this.d.assetUrl('vendor/ort/'),
        modelUrl: this.d.assetUrl(BASIC_PITCH.asset),
      });
      this._worker = w;
      this.d.log(`deck ${this.deck} MIDI worker spawned — ${BASIC_PITCH.label}, `
        + `${BASIC_PITCH.threads} threads, wasm only`);
    } catch (e) {
      // `start()` is called straight out of the message switch, so a throw here
      // would surface as a generic engine failure with the take's own reason
      // buried in it. Latch it instead: the deck gets MIDI_ERROR and the row
      // says what happened.
      this._faulted('spawning the transcription worker', 'WORKER_FAILED', e);
    }
  }

  /**
   * Dispatch at most one `RUN`. ONE IN FLIGHT, EVER — the worker refuses a
   * second and is right to, and the queue is this side's half of that contract.
   *
   * Because exactly one run is outstanding, every lane's ping-pong buffer is in
   * hand whenever this line is reached, which is what makes "one window buffer
   * per lane" enough.
   */
  _pump() {
    if (!this._worker || !this._ready || this._inFlight || this._fault) return;
    while (this._queue.length) {
      const q = this._queue[0];
      const lane = this._lanes.get(q.stem);
      // The samples may have been overwritten while this waited. That is the
      // ring's own limit and it is a REFUSAL, not a pad: a window padded with
      // zeros decodes to a plausible note list with a silent hole in it.
      if (this._count - windowStart(q.w) > lane.ring.length) {
        this._refuse(this._queue.shift(), 'its audio has been overwritten');
        continue;
      }
      this._queue.shift();
      cutWindow(lane.ring, this._count, q.w, lane.win, q.tail === true);
      const buf = lane.win.buffer;
      lane.win = null;                 // LENT. It comes back on NOTES or on ERROR.
      this._inFlight = true;
      this._worker.postMessage({ type: 'RUN', id: ++this._runId, lane: q.stem, w: q.w, window: buf }, [buf]);
      return;
    }
    if (this._draining && !this._flushSent) {
      this._flushSent = true;
      this._worker.postMessage({ type: 'FLUSH' });
    }
  }

  _break(stem) {
    if (this._worker && this._ready) this._worker.postMessage({ type: 'BREAK', lane: stem });
  }

  _breakAll() {
    if (!this._lanes) return;
    for (const stem of this._lanes.keys()) this._break(stem);
  }

  /** Every message the worker sends. It never throws back at the worker. */
  _receive(m) {
    try {
      switch (m && m.type) {
        case 'READY':
          this._ready = true;
          this.d.log(`deck ${this.deck} MIDI session ready — ${m.threads} thread${m.threads === 1 ? '' : 's'}`);
          return this._pump();

        case 'NOTES': {
          // The lent buffer comes home first, before anything can throw, or the
          // lane loses its only window buffer over a decode problem.
          if (m.window) this._adoptWindow(m.lane, m.window);
          if (m.w >= 0) this._inFlight = false;
          this._ingest(m.lane, m.notes);
          return this._pump();
        }

        case 'FLUSHED':
          return this._finishFlush();

        case 'ERROR': {
          if (m.window) this._adoptWindow(null, m.window);
          this._inFlight = false;
          return this._faulted('the transcription session', 'SESSION_FAILED',
            new Error(m.message || 'the worker did not say'));
        }

        default:
          return;
      }
    } catch (e) {
      this._faulted('a worker reply', 'WORKER_FAILED', e);
    }
  }

  /**
   * Re-adopt a lent window buffer. `lane` is null on an ERROR, where the worker
   * hands the buffer back without saying whose it was — so the buffer goes to
   * whichever lane is missing one, and there is at most one of those because
   * there is at most one run in flight.
   */
  _adoptWindow(lane, buf) {
    if (!this._lanes) return;
    const view = new Float32Array(buf);
    const l = lane && this._lanes.get(lane);
    if (l && !l.win) { l.win = view; return; }
    for (const other of this._lanes.values()) {
      if (!other.win) { other.win = view; return; }
    }
  }

  /** One lane's closed notes, in LANE SAMPLES, turned into wire notes. */
  _ingest(stem, notes) {
    if (!Array.isArray(notes) || !notes.length) return;
    const f0 = this._f0;
    if (f0 === null) return;          // notes for a take whose clock never started
    for (const n of notes) {
      // A note that STARTS past the last sample this take was ever handed came
      // out of `_cutTail`'s zero pad. Zeros produce no onsets, so this has never
      // been seen — it is here because the alternative to a two-line guard is a
      // note dated after the end of the recording with nothing able to notice.
      if (n.onSample >= this._count) continue;
      this._pushNote(stem, n.pitch, n.vel,
        this._srcSec(laneToFrame(f0, n.onSample)), this._srcSec(laneToFrame(f0, n.offSample)));
    }
  }

  // ------------------------------------------------------------- the wire

  /**
   * One wire note, on the 1 ms grid, unless it falls in a span this take could
   * not read.
   *
   * THE UNCOVERED FILTER LIVES HERE and `engine/notes.js` stays span-unaware and
   * pure: the span list is this file's, the decode is not, and a decoder that
   * knew about coverage would need a second reason to exist.
   *
   * THE SPAN LIST IS THIS STEM'S. A passthrough hop merges into all six, because
   * `LiveEmitter.gap()` really did blind every lane; a refused window merges into
   * one, because it really did blind one.
   */
  _pushNote(stem, pitch, vel, onSec, offSec) {
    if (!Number.isFinite(onSec) || !Number.isFinite(offSec)) return;
    const on = msGrid(Math.max(0, onSec));
    if (inSpans(this._unc.get(stem) || [], on)) return;
    // `offSec` must be strictly after `onSec` or `MidiTake` refuses the whole
    // message. A note shorter than the grid is real — the drum gate is 60 ms and
    // a 0.75x rate shrinks it — so it is widened to one grid step rather than
    // dropped, which is the smallest honest thing this format can say.
    const off = Math.max(msGrid(offSec), on + 0.001);
    this._outbox.push({ stem, pitch, vel, onSec: on, offSec: off });
  }

  /**
   * Publish ONE `MIDI_NOTES` for the hop that has just been written.
   *
   * ONE MESSAGE PER PUBLISHED HOP, not on a clock — at the default hop that is
   * 0.51 Hz, and at hop 1.0 it is 1.0 Hz. That IS the rate limit and it is
   * structural rather than a timer: the tap is called once per hop, so there is
   * no cadence to invent and nothing to coalesce. `seq` is +1 per message for
   * the life of the take, which is the one claim in this feature that can
   * actually fail — a gap means the deck is missing notes it can never recover,
   * and it must SAY so rather than paper over it.
   *
   * `spanFrom`/`spanTo` describe COVERAGE, not the extent of the notes in this
   * message. A note is delivered in the hop it CLOSED in, not the hop it started
   * in, so `onSec` routinely sits before `spanFrom` — and `offSec` may sit after
   * `spanTo`. Both are the format working as specified.
   *
   * A REFUSED WINDOW GETS ITS OWN `covered: false` MESSAGE AT ITS OWN SPAN, sent
   * BEFORE this hop's, and the hop itself stays `covered: true`. That is the
   * correction, and both halves of it were defects:
   *
   *   - THE SPAN. `covered` is the deck's "were these seconds actually written"
   *     question (ADR 0002 §8.6), and the seconds that were not written are the
   *     refused WINDOW's, which at the default hop end 1.81 s before the hop that
   *     refuses them. Reporting the hop marked the wrong 1.95 s of the video.
   *   - THE NOTES. `MidiTake.accept` drops every held note inside the span of any
   *     message, so marking the hop `covered: false` deleted a whole hop of
   *     correctly transcribed notes from every stem — including drums, which
   *     never goes through a model window and cannot be affected by a refusal.
   *
   * THE ORDER IS LOAD-BEARING AND SO IS THE HAND-BACK. The refusal message goes
   * first, because the deck's last-pass-wins rule drops the notes it already
   * holds inside that span — which is right for the refused lane and wrong for
   * the other five. So the notes this take still knows are good over that span
   * are put back into the outbox and go out again on the hop's own
   * `covered: true` message, which lands after the drop. `accept()` adds a
   * message's notes unconditionally, so a note re-delivered this way survives;
   * `_recent` is what makes it available, and `_notesSent` is walked back by the
   * same count so the counter still equals what the deck holds.
   *
   * AND THE HOP'S OWN CLAIM IS CLIPPED so it cannot hand a refused span straight
   * back: `covered: true` SUBTRACTS from the deck's uncovered list, so at a hop
   * shorter than a model window — hop 1.0, where a refused window's span reaches
   * into the hop that refuses it — an unclipped hop message would undo the
   * message sent two lines earlier.
   *
   * ponytail: everything from the earliest overlapping refusal to the end of the
   * hop goes unclaimed, rather than being published as the one or two covered
   * pieces it really is. Ceiling, derived rather than guessed: `claimTo` is
   * `max(lo, a)`, so the loss is at most `hi - lo` — ONE publication hop of
   * coverage per hop that reports an overlapping refusal, at any hop setting.
   * Measured on the forced-refusal fixture (12 refused windows over 23.4 s at the
   * default hop) it cost NOTHING: the engine reported 3.756 s covered and
   * 19.644 s uncovered, which sums to the 23.400 s fed, because every refusal
   * there named a window that had ended before its reporting hop began. And what
   * is lost is a CLAIM, not a report — the seconds go unmentioned rather than
   * uncovered, so the figure moves in the direction that claims LESS, which is
   * the only direction it is allowed to be wrong in. Upgrade path: subtract the
   * refused spans from the hop's span and send one `covered: true` message per
   * remaining piece, hanging the notes on the last — the wire already allows it
   * (a message's notes need not lie inside its span, §4.2), so it is a loop here
   * and no wire change at all.
   */
  _publish(fromFrame, len, covered) {
    const spanFrom = msGrid(this._srcSec(fromFrame));
    const spanTo = msGrid(this._srcSec(fromFrame + len));
    const lo = Math.min(spanFrom, spanTo), hi = Math.max(spanFrom, spanTo);
    this._hops++;
    const refused = this._publishRefusals();
    if (!covered) {
      this._uncoveredSec += hi - lo;
      // EVERY lane, because `LiveEmitter.gap()` zeroed all twelve stem planes.
      for (const spans of this._unc.values()) mergeSpan(spans, lo, hi);
      // Notes already in the outbox that land inside a span this take has just
      // called unreadable must not go out: they were decoded from the zeros
      // `LiveEmitter.gap()` wrote, or they belong to a window nobody read.
      // Notes OUTSIDE it stay in the outbox and go out with the next covered
      // hop — they came from audio this take did read, and a passthrough span
      // is not a reason to throw them away.
      this._outbox = this._outbox.filter((n) => !inSpans(this._unc.get(n.stem) || [], n.onSec));
      // The deck drops what it already holds in this span too, so the counter
      // has to follow it down or `payload().notes` outruns the take.
      this._forget(lo, hi, false);
      this._lastSpanTo = hi;
      // `notes` is [] whenever `covered` is false — `MidiTake` refuses a message
      // that says it could not read a span and then carries notes from it, and it
      // is right to: the sender is wrong about one of the two and there is no way
      // to tell which.
      return this._sendNotes(lo, hi, false, []);
    }
    let claimTo = hi;
    for (const [a, b] of refused) {
      if (b > lo && a < claimTo) claimTo = Math.max(lo, a);
    }
    // LAST PASS WINS, the same direction `MidiTake.accept` applies it in: a span
    // this take has just read is no longer a span it may not emit notes into.
    // Without it a backwards seek over a passage the first pass missed replayed
    // correctly and was thrown away here — see `cutSpan`.
    for (const spans of this._unc.values()) cutSpan(spans, lo, claimTo);
    this._coveredSec += claimTo - lo;
    this._lastSpanTo = hi;
    this._sendNotes(lo, claimTo, true, this._takeOutbox());
  }

  /**
   * One `covered: false` message per span refused since the last publish, and the
   * hand-back that keeps the other lanes' notes.
   *
   * `_refused` is merged, so this is one message in the ordinary case however
   * many lanes of one window were refused — five lanes of one window are one
   * span, not five.
   *
   * @returns {Array<[number, number]>} the spans it sent, for the caller to clip
   *   its own claim against.
   */
  _publishRefusals() {
    if (!this._refused.length) return [];
    const spans = this._refused;
    this._refused = [];
    for (const [a, b] of spans) {
      this._uncoveredSec += b - a;
      // These seconds were claimed covered by an earlier hop and are being taken
      // back. Both counters follow the deck's own two lists rather than drifting
      // from them; the floor is there because a refusal may reach into a hop that
      // was never claimed, and a negative figure is not a figure.
      this._coveredSec = Math.max(0, this._coveredSec - (b - a));
      this._sendNotes(a, b, false, []);
      this._forget(a, b, true);
    }
    return spans;
  }

  /**
   * The deck has just been told `[a, b)` is uncovered and has dropped every note
   * it held inside it. Walk `_notesSent` back by the same count, and — when
   * `handBack` — return the ones that came from lanes this take DID read to the
   * outbox, so the next `covered: true` message delivers them again.
   */
  _forget(a, b, handBack) {
    const keep = [];
    let dropped = 0;
    for (const r of this._recent) {
      if (r.n.onSec >= a && r.n.onSec < b) {
        dropped++;
        if (handBack && !inSpans(this._unc.get(r.n.stem) || [], r.n.onSec)) this._outbox.push(r.n);
      } else keep.push(r);
    }
    this._recent = keep;
    this._notesSent -= dropped;
  }

  _takeOutbox() {
    const out = this._outbox;
    this._outbox = [];
    out.sort((a, b) => a.onSec - b.onSec || a.pitch - b.pitch);
    return out;
  }

  _sendNotes(spanFrom, spanTo, covered, notes) {
    this._seq++;
    this._notesSent += notes.length;
    this.d.send({ type: 'MIDI_NOTES', seq: this._seq, spanFrom, spanTo, covered, notes });
    // The note history a refusal hands back from, pruned by PUBLICATION HOP and
    // not by a clock: `_recentHops` is derived from the ring (see
    // `recentHopsFor`), which makes it exact in the only unit that matters here
    // and independent of the page's rate, where a source-second window would not
    // be. Not by `seq`, which a refusing hop runs ahead of the hop count.
    for (const n of notes) this._recent.push({ h: this._hops, n });
    const oldest = this._hops - this._recentHops;
    if (this._recent.length && this._recent[0].h <= oldest) {
      this._recent = this._recent.filter((r) => r.h > oldest);
    }
  }

  /** The drain is complete: the last `MIDI_NOTES`, then `MIDI_FLUSHED`. */
  _finishFlush() {
    if (!this._draining) return;
    this._draining = false;
    // A window refused during the drain is still a span nobody transcribed, and
    // this is the last chance to say so. It also hands its span's good notes back
    // into the outbox, which the line below then delivers.
    this._publishRefusals();
    const at = msGrid(this._lastSpanTo);
    this._sendNotes(at, at, true, this._takeOutbox());
    this.d.send({ type: 'MIDI_FLUSHED', seq: this._seq });
    // The take is closed for notes but NOT torn down: the deck still holds it,
    // still has to be able to save it, and sends `MIDI_STOP` when it is done.
    // Until then the tap is one compare per hop.
    this._open = false;
    this.d.log(`deck ${this.deck} MIDI take flushed — ${this._notesSent} notes, `
      + `${this._coveredSec.toFixed(1)}s covered, ${this._uncoveredSec.toFixed(1)}s not, ${this._dropped} dropped`);
  }

  // ------------------------------------------------------------- the clock

  /**
   * The FALLBACK anchor, and it only fires when the engine could not supply one.
   *
   * `offscreen/engine.js` anchors from `PAGE_VIDEO` at the capture head as soon
   * as the take opens, which is the accurate tie. This covers the build that has
   * no page transport at all: there is then no source clock to be on, so the
   * take's times are relative to its own first hop, which is honest and never
   * throws. A take with no clock at all would have to discard every note.
   */
  _anchorIfNeeded(fromFrame) {
    /**
     * `_f0` IS RE-DERIVED EVERY HOP AND NOT LATCHED ON THE FIRST ONE, because the
     * absolute output-frame axis it names is NOT continuous for the life of a
     * take. `LivePipeline.start()` re-zeroes it at both ends every time it runs —
     * a new `LiveEmitter` puts `commit` back to 0, so the `fromFrame` handed here
     * restarts at 0, and `baseFrame` is re-read so `frameNow()` restarts with it
     * — and a restart UNDER AN OPEN TAKE is the ordinary path rather than a
     * corner: `offscreen/engine.js`'s `startLive()` deliberately re-attaches the
     * SAME take across one, `ui/embed-state.js`'s `follow()` turns an ordinary
     * PAUSE into `LIVE_STOP` + `LIVE_START`, and every seek goes through
     * `onContentJump()` -> `restartLive()` to the same pair.
     *
     * Latched, the lane clock and the frame clock came apart by exactly the
     * duration the take had already heard, and only for the FIVE PITCHED LANES —
     * `_collect()` sends drum onsets through `_srcSec` with no lane arithmetic,
     * so drums stayed right while the melodic stems slid, which is what made the
     * file read as plausible rather than as broken. Measured over a fake worker
     * port at the shipped hop: arm at 0:00, play 120.9 s, pause, resume; the note
     * at the first kept frame after the resume came out at `onSec 240.627`
     * against a continuous-axis control of `119.727` — late by 120.900 s, the
     * played duration exactly.
     *
     * The re-derivation is exact rather than approximate: lane sample `_count` IS
     * output frame `fromFrame` at the top of a hop, because this runs before
     * `_feedPitched` in `covered()` and before the zero-append in `uncovered()`,
     * so `_count` is the pre-hop count at both call sites. `_f0` still starts
     * null and stays null for a take that never saw a hop, which is what
     * `_ingest`'s own guard reads.
     */
    this._f0 = fromFrame - 2 * this._count;
    if (this._anchor) return;
    const v = this.d.videoNow && this.d.videoNow();
    const rate = (this.d.rateNow && this.d.rateNow()) || 1;
    this._anchor = {
      frame: fromFrame,
      srcSec: v && Number.isFinite(v.currentTime) ? Math.max(0, v.currentTime) : 0,
      rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    };
  }

  _srcSec(F) {
    return this._anchor ? srcSecAt(this._anchor, F) : 0;
  }

  /**
   * Latch a fault. Once per take, logged once, on the wire twice.
   *
   * TWO CARRIERS ON PURPOSE: `MIDI_ERROR` is the message the deck turns into
   * `bad` with `message` in the row's `title`, and `payload().fault` is the same
   * sentence again at 10 Hz. Either one alone would be a single point of
   * failure for the news that the take cannot be trusted — which is precisely
   * the news that must not go missing.
   *
   * THE CODE SET IS FROZEN AT FOUR AND THIS FILE USES TWO OF THEM.
   * `SESSION_FAILED` is an `ERROR` from the worker — the session is the thing
   * that broke. `WORKER_FAILED` is everything else that kills the take,
   * including an engine-side DSP fault, because the frozen set has no word for
   * that and inventing a fifth is a wire change the contract froze; the `where`
   * string carries the real distinction into the sentence the user sees.
   *
   * `MODEL_MISSING` IS DELIBERATELY NEVER SENT FROM HERE, and that is a fact
   * about this build rather than an omission: the Basic Pitch weights are
   * COMMITTED (ADR 0002 / the owner's ruling R3), so "the model is not there" is
   * a broken checkout and not a state a running extension can be in. If the
   * asset really cannot be read, ORT says so with the URL it tried, and that
   * message is more useful than a code that only says "missing".
   */
  _faulted(where, code, err) {
    if (this._fault) return;
    this._fault = `${where}: ${String((err && err.message) || err)}`;
    this.d.log(`ERROR [midi] deck ${this.deck} ${this._fault}`);
    this.d.send({ type: 'MIDI_ERROR', code, message: this._fault });
    if (this._draining) this._finishFlush();
  }
}

// ===================================================================== self-check
//
// `node extension/offscreen/transcribe.js`. Everything below this line is the
// runnable check and is NOT part of the module's surface.
//
// It drives the arithmetic and only the arithmetic. Every fixture is a COUNT or
// an exact array comparison; nothing here reads a clock, and nothing here needs
// ORT, a Worker, a model or a browser.

async function selfCheck() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
  };
  const head = (s) => console.log(`\n${s}`);
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const { window: WIN, hop: HOP, preroll: PRE, fftHop: FH, keep: KEEP } = BASIC_PITCH;

  head('1. the window schedule, and the naive map that must lose');
  {
    ok('start-of-window-0-is-the-pre-roll', windowStart(0) === -PRE, `${windowStart(0)}`);
    ok('pre-roll-is-fifteen-frames', PRE === BASIC_PITCH.trim * FH, `${PRE} = ${BASIC_PITCH.trim} * ${FH}`);
    let strides = 0;
    for (let w = 0; w < 8; w++) if (windowStart(w + 1) - windowStart(w) === HOP) strides++;
    ok('windows-advance-by-the-hop', strides === 8, `${strides}/8 strides are ${HOP}`);
    ok('window-length-is-the-model-window', windowEnd(3) - windowStart(3) === WIN, `${windowEnd(3) - windowStart(3)}`);

    // THE FRAME MAP, and the control. Upstream concatenates each window's 142
    // kept frames and indexes them as one uniform stream; 142*256 = 36352
    // against a hop of 36164, so a naive global index gains 188 samples a
    // window. Both maps are computed here so the assertion is about the DRIFT
    // rather than about a formula copied twice.
    const naive = (w, k) => (w * KEEP + k) * FH;
    let agree = 0, drifts = 0;
    for (let w = 0; w < 4; w++) {
      for (const k of [0, KEEP - 1]) {
        if (keptFrameSample(w, k) === w * HOP + k * FH) agree++;
        if (naive(w, k) - keptFrameSample(w, k) === 188 * w) drifts++;
      }
    }
    ok('frame-map-is-per-window', agree === 8, `${agree}/8`);
    ok('naive-stream-map-drifts-188-per-window', drifts === 8, `${drifts}/8 differ by exactly 188*w`);
    ok('control-the-naive-map-disagrees', naive(1, 0) !== keptFrameSample(1, 0),
      `naive ${naive(1, 0)} vs ${keptFrameSample(1, 0)}`);
    ok('kept-span-exceeds-the-hop', KEEP * FH - HOP === 188, `${KEEP * FH} - ${HOP}`);
  }

  head('2. when a window becomes due  (a COUNT, at both entry points)');
  {
    ok('window-0-needs-40004-lane-samples', windowEnd(0) === WIN - PRE, `${windowEnd(0)}`);
    ok('nothing-is-due-one-sample-short', windowsDue(windowEnd(0) - 1, 0) === 0);
    ok('one-is-due-exactly-at-the-end', windowsDue(windowEnd(0), 0) === 1);
    ok('two-are-due-at-the-second-end', windowsDue(windowEnd(1), 0) === 2, `${windowsDue(windowEnd(1), 0)}`);
    ok('due-is-relative-to-nextW', windowsDue(windowEnd(1), 1) === 1, `${windowsDue(windowEnd(1), 1)}`);

    // Block-size independence, as an exact comparison: the same total fed as one
    // block and as odd-length hops must make the same windows due. 85 995 is the
    // default hop's ODD frame count, so its lane half is 42 997 or 42 998
    // depending on the phase — which is the whole reason decimate2 carries one.
    const total = 42997 * 6 + 3;
    let stepped = 0, nextW = 0;
    for (let i = 0, c = 0; i < 6; i++) {
      c += 42997 + (i === 5 ? 3 : 0);
      const due = windowsDue(c, nextW);
      nextW += due; stepped += due;
    }
    ok('blocked-equals-one-shot', stepped === windowsDue(total, 0),
      `${stepped} windows in six blocks, ${windowsDue(total, 0)} in one`);

    // THE CONTROL THAT MUST LOSE. A reader who forgets the overlap schedules
    // windows back to back at `(w+1)*window`, which is a real, plausible,
    // wrong answer: it produces FEWER windows and leaves 7680 samples of every
    // window's audio unread.
    const naiveDue = (c) => Math.floor(c / WIN);
    ok('control-non-overlapping-schedule-loses', naiveDue(total) !== windowsDue(total, 0),
      `non-overlapping ${naiveDue(total)} vs ${windowsDue(total, 0)}`);
  }

  head('3. the ring cut, the pre-roll, and the wrap');
  {
    const ring = new Float32Array(LANE_RING);
    const dst = new Float32Array(WIN);
    // A ramp whose value IS its lane sample index, so every assertion below is
    // about WHICH sample landed where and not about a value being plausible.
    const write = (from, to) => { for (let s = from; s < to; s++) ring[s % LANE_RING] = s; };

    write(0, windowEnd(0));
    cutWindow(ring, windowEnd(0), 0, dst);
    let zeros = 0; for (let i = 0; i < PRE; i++) if (dst[i] === 0) zeros++;
    ok('window-0-opens-with-the-pre-roll', zeros === PRE, `${zeros}/${PRE} zeros`);
    let aligned = 0;
    for (const i of [PRE, PRE + 1, WIN - 1]) if (dst[i] === i - PRE) aligned++;
    ok('window-0-then-lane-sample-0', aligned === 3, `${aligned}/3 probes`);

    // Window 1 starts at 32 324, well inside the ring, and window 2 at 68 488
    // forces a wrap — LANE_RING is 80 008, so window 2 ends at 108 492.
    write(windowEnd(0), windowEnd(2));
    cutWindow(ring, windowEnd(2), 2, dst);
    let ramp = 0;
    for (const i of [0, 1, 12345, WIN - 1]) if (dst[i] === windowStart(2) + i) ramp++;
    ok('window-2-survives-the-ring-wrap', ramp === 4, `${ramp}/4 probes at ${windowStart(2)}..`);

    // CONTROL: a cut without the pre-roll puts lane sample 0 at index 0 and is
    // 3840 samples early for the whole window. It is the mistake this arithmetic
    // is most able to have, and it produces a transcription that is 174 ms early
    // and otherwise perfect.
    ok('control-a-pre-roll-less-cut-differs', dst[0] !== 0 && windowStart(0) !== 0,
      `windowStart(0) = ${windowStart(0)}, not 0`);

    ok('cut-throws-when-the-window-has-not-arrived',
      threw(() => cutWindow(ring, windowEnd(3) - 1, 3, dst)), 'one sample short');
    ok('cut-throws-when-the-audio-is-gone',
      threw(() => cutWindow(ring, windowEnd(2) + LANE_RING, 2, dst)), 'a whole ring behind');
    ok('cut-throws-on-a-short-destination',
      threw(() => cutWindow(ring, windowEnd(0), 0, new Float32Array(WIN - 1))));

    // ---- THE TAIL CUT, which is the ONE case that may pad. Window 3 is short by
    // one sample above and throws; the same cut with `tail` returns the audio it
    // has and zeros after it. Both halves, because a `tail` flag that padded
    // unconditionally would pass the second line on its own and the ordinary cut
    // is the one that must never pad.
    const short = windowEnd(3) - 1;
    write(windowEnd(2), short);
    cutWindow(ring, short, 3, dst, true);
    ok('a-tail-cut-keeps-the-audio-it-has',
      dst[PRE] === windowStart(3) + PRE && dst[short - windowStart(3) - 1] === short - 1,
      `dst[${PRE}] = ${dst[PRE]}, last real sample ${dst[short - windowStart(3) - 1]}`);
    ok('a-tail-cut-zero-fills-past-the-last-sample',
      dst[short - windowStart(3)] === 0 && dst[WIN - 1] === 0, `${WIN - (short - windowStart(3))} pad samples`);
    ok('control-the-ordinary-cut-of-the-same-window-still-throws',
      threw(() => cutWindow(ring, short, 3, dst)), 'padding is a caller\'s claim, never a fallback');

    // `keptThrough` is what decides how many tail windows there are, and the
    // property that makes it a coverage FRONT rather than a per-window figure is
    // that consecutive kept grids overlap — 188 samples, section 1's number.
    ok('kept-coverage-advances-by-the-model-hop',
      keptThrough(4) - keptThrough(3) === HOP, `${keptThrough(4) - keptThrough(3)}`);
    ok('kept-coverage-lags-the-window-end-by-3652',
      windowEnd(3) - keptThrough(4) === 3652, `${windowEnd(3) - keptThrough(4)} samples, 0.166 s`);
    ok('nothing-is-kept-before-the-first-window', keptThrough(0) === 0, `${keptThrough(0)}`);
  }

  head('4. the source clock');
  {
    const a = { frame: 44100, srcSec: 10, rate: 1 };
    ok('the-anchor-frame-is-the-anchor-second', srcSecAt(a, 44100) === 10);
    ok('one-second-of-frames-is-one-second', srcSecAt(a, 88200) === 11, `${srcSecAt(a, 88200)}`);
    ok('before-the-anchor-runs-backwards', srcSecAt(a, 0) === 9, `${srcSecAt(a, 0)}`);
    const slow = { frame: 0, srcSec: 0, rate: 0.75 };
    ok('a-slowed-video-covers-less-of-itself', srcSecAt(slow, SR) === 0.75, `${srcSecAt(slow, SR)}`);
    const fast = { frame: 0, srcSec: 0, rate: 2 };
    ok('a-doubled-video-covers-twice-as-much', srcSecAt(fast, SR) === 2, `${srcSecAt(fast, SR)}`);
    // The lane join: lane sample s is frame f0 + 2s, so one second of LANE
    // samples must be one second of video at unity rate.
    ok('lane-samples-join-the-frame-clock', laneToFrame(1000, BASIC_PITCH.sr) === 1000 + SR,
      `${laneToFrame(1000, BASIC_PITCH.sr)}`);
    ok('a-lane-second-is-a-video-second',
      srcSecAt({ frame: 0, srcSec: 0, rate: 1 }, laneToFrame(0, BASIC_PITCH.sr)) === 1);
    ok('ms-grid-rounds-to-a-millisecond', msGrid(12.51042) === 12.51, `${msGrid(12.51042)}`);
    ok('ms-grid-rounds-and-does-not-truncate', msGrid(0.0015) === 0.002, `${msGrid(0.0015)}`);
  }

  head('5. uncovered spans, and the filter that must be able to keep a note');
  {
    const s = [];
    mergeSpan(s, 10, 20);
    mergeSpan(s, 30, 40);
    ok('two-disjoint-spans-stay-two', s.length === 2, JSON.stringify(s));
    mergeSpan(s, 18, 32);
    ok('an-overlap-merges-all-three', s.length === 1 && s[0][0] === 10 && s[0][1] === 40, JSON.stringify(s));
    mergeSpan(s, 5, 7);
    ok('an-earlier-span-sorts-first', s[0][0] === 5 && s[1][0] === 10, JSON.stringify(s));
    ok('a-zero-length-span-is-not-a-span', mergeSpan([], 3, 3).length === 0);

    const u = mergeSpan(mergeSpan([], 10, 20), 30, 40);
    ok('inside-is-inside', inSpans(u, 15) === true);
    ok('the-open-end-is-outside', inSpans(u, 20) === false, 'spans are [a, b)');
    ok('the-closed-start-is-inside', inSpans(u, 10) === true);
    ok('between-two-spans-is-outside', inSpans(u, 25) === false);
    ok('after-everything-is-outside', inSpans(u, 99) === false);
    // THE CONTROL. A filter hardwired to "drop it" passes the drop half of this
    // and fails here, which is the half that says the take still contains music.
    ok('control-a-note-outside-every-span-is-kept', inSpans(u, 9.999) === false, '9.999 is before [10, 20)');
  }

  head('6. the drum block splitter  (nothing may be lost at a join)');
  {
    const H = DRUM_ENV_HOP;
    ok('the-default-hop-is-whole-hops', 85995 % H === 0, `85995 / ${H} = ${85995 / H}`);
    let accounted = 0, wholes = 0;
    // 83790 is chunk 0's short emit, 85995 the steady hop, and 1000/1/440 are the
    // awkward lengths a hop change or a partial gap fill can produce.
    for (const len of [83790, 85995, 1000, 1, 440, 441, 882, 0]) {
      for (const pend of [0, 1, 220, H - 1]) {
        const s = drumSplit(pend, len, H);
        if (s.fill + s.whole + s.tail === len) accounted++;
        if (s.whole % H === 0) wholes++;
      }
    }
    ok('every-frame-is-accounted-for', accounted === 32, `${accounted}/32 splits sum to their block`);
    ok('only-whole-hops-are-ever-fed', wholes === 32, `${wholes}/32`);

    // The streaming property, as a COUNT: pushing a total through in awkward
    // blocks must feed the same number of whole hops as one call would, and the
    // stash must hold exactly the remainder.
    const lens = [1000, 1, 440, 441, 882, 83790, 7];
    const total = lens.reduce((a, b) => a + b, 0);
    let pend = 0, fed = 0;
    for (const len of lens) {
      const s = drumSplit(pend, len, H);
      if (s.completes) fed += H;
      fed += s.whole;
      pend = s.completes || pend === 0 ? s.tail : pend + s.fill;
    }
    ok('streaming-feeds-every-whole-hop', fed === total - (total % H), `${fed} of ${total}, ${total % H} left`);
    ok('the-stash-holds-exactly-the-remainder', pend === total % H, `${pend}`);
    ok('the-stash-can-never-be-a-whole-hop', pend < H, `${pend} < ${H}`);
    ok('split-refuses-a-full-stash', threw(() => drumSplit(H, 100, H)), `pendN = ${H}`);
    ok('split-refuses-a-fractional-block', threw(() => drumSplit(0, 10.5, H)));
  }

  head('7. the lane table  (WIRE ORDER, derived and not typed)');
  {
    ok('drums-is-the-drum-tap-plane', STEMS[DRUM_STEM_IDX] === 'drums', `stem ${DRUM_STEM_IDX}`);
    ok('five-lanes-reach-the-model', PITCHED.length === STEMS.length - 1, `${PITCHED.length}`);
    ok('drums-never-reaches-the-model', !PITCHED.some((p) => p.stem === 'drums'),
      PITCHED.map((p) => p.stem).join(', '));
    let planes = 0;
    for (const p of PITCHED) if (p.planeL === STEMS.indexOf(p.stem) * 2 && p.planeR === p.planeL + 1) planes++;
    ok('plane-index-is-stemIdx-times-two', planes === PITCHED.length, `${planes}/${PITCHED.length}`);
    const highest = Math.max(...PITCHED.map((p) => p.planeR));
    ok('no-lane-reaches-the-passthrough-planes', highest === STEM_PLANES - 1,
      `highest plane ${highest}, stem planes ${STEM_PLANES}`);
    /**
     * THIS ASSERTION USED TO READ `LANE_RING === windowEnd(1) - windowStart(0)`
     * — "the ring holds exactly two pending windows", 80 008 — and it is changed
     * rather than deleted because the thing it encoded turned out to be the
     * defect, not the invariant. Two MODEL windows is the wrong unit: what has to
     * fit is the audio one PUBLICATION hop can put in front of the cutter, and at
     * the shipped default hop that is 86 842 samples against the 80 008 the old
     * identity pinned. The claim it is replaced by is the one the sizing actually
     * makes — that the ring covers the residency the hop demands, at every hop —
     * and it is checked over all four of `LIVE_HOPS` in section 9 rather than at
     * one of them here.
     */
    ok('the-ring-covers-the-default-hop-residency',
      LANE_RING >= BASIC_PITCH.window + laneSamplesPerHop(DEFAULT_HOP_FRAMES),
      `${LANE_RING} >= ${BASIC_PITCH.window + laneSamplesPerHop(DEFAULT_HOP_FRAMES)}`);
  }

  head('8. the whole tap, at its real entry point, over a fake worker port');
  {
    /**
     * The seven assertions above are about the arithmetic in isolation. This one
     * is about the COMPOSITION — `covered()` -> decimate2 -> the lane ring ->
     * `cutWindow` -> the wire — because AGENTS.md's entry-point rule cuts both
     * ways: every function here has one caller, and it is this one.
     *
     * The port is a fake and not a mock of ORT: it answers INIT with READY, RUN
     * with the note list the fixture wants, hands the lent buffer straight back
     * (which is the ping-pong the real worker also does), and records everything
     * it was sent. It is the same device `qa/` already uses to gate the seam's
     * serialisation without a browser.
     */
    const H = 85995;                             // the default hop, in frames — ODD
    const posted = [];
    const snap = new Map();                      // "lane@w" -> the window as posted
    const wanted = new Map();                    // "lane@w" -> notes to answer with
    let mute = false;                            // a port that never answers at all
    globalThis.Worker = class {
      constructor() { this.onmessage = null; this.onerror = null; }
      terminate() {}
      postMessage(m) {
        posted.push(m);
        if (mute) return undefined;
        if (m.type === 'INIT') return this._reply({ type: 'READY', threads: 2 });
        if (m.type === 'RUN') {
          // A COPY, taken before the buffer is handed back and re-used. The
          // real worker never keeps it either; this one keeps a snapshot so the
          // check can compare what was actually sent.
          if (m.lane === 'bass') snap.set(`${m.lane}@${m.w}`, new Float32Array(m.window).slice());
          return this._reply({
            type: 'NOTES', id: m.id, lane: m.lane, w: m.w, window: m.window,
            notes: wanted.get(`${m.lane}@${m.w}`) || [],
          });
        }
        if (m.type === 'FLUSH') return this._reply({ type: 'FLUSHED' });
        return undefined;
      }
      _reply(d) { if (this.onmessage) this.onmessage({ data: d }); }
    };

    const sent = [];
    const t = new Transcriber({
      deck: 'A', assetUrl: (r) => `stub://${r}`, send: (m) => sent.push(m), log: () => {},
      videoNow: () => null, rateNow: () => 1,
    });
    t.start();
    t.anchor(0, 100, 1);                         // output frame 0 is 100.000 s of video

    // A ramp on the pitched planes so the window content is checkable sample by
    // sample, and SILENCE on the drum planes so the only notes in this fixture
    // are the ones the fixture asked for.
    const planes = Array.from({ length: STEM_PLANES }, () => new Float32Array(H));
    const fullL = new Float32Array(3 * H), fullR = new Float32Array(3 * H);
    for (let h = 0; h < 3; h++) {
      for (let i = 0; i < H; i++) { fullL[h * H + i] = h * H + i; fullR[h * H + i] = h * H + i; }
    }
    // One note on `bass` at window 0's very first kept frame, so its source
    // second is the take's anchor exactly and any pre-roll or hop error moves it.
    wanted.set('bass@0', [{ pitch: 60, vel: 100, onSample: keptFrameSample(0, 0), offSample: 11025 }]);

    for (let h = 0; h < 3; h++) {
      for (let q = 2; q < STEM_PLANES; q++) planes[q].set(fullL.subarray(h * H, (h + 1) * H));
      planes[0].fill(0); planes[1].fill(0);
      t.covered(h * H, H, planes);
    }

    ok('the-tap-did-not-fault', t.payload().fault === null, String(t.payload().fault));
    const runs = posted.filter((m) => m.type === 'RUN');
    ok('three-hops-cut-three-windows', runs.length === 3 * PITCHED.length,
      `${runs.length} RUNs, ${PITCHED.length} lanes x 3 windows`);
    const wSeq = [...new Set(runs.map((m) => m.w))].join(',');
    ok('the-window-indices-are-0-1-2', wSeq === '0,1,2', wSeq);
    const lanesPerW = runs.filter((m) => m.w === 1).map((m) => m.lane).sort().join(',');
    ok('every-pitched-lane-cuts-every-window',
      lanesPerW === PITCHED.map((p) => p.stem).sort().join(','), lanesPerW);

    // Blocked == one-shot, through the WHOLE tap: the window the tap cut out of
    // its ring must equal the window cut from a stream decimated in ONE call.
    // An exact array comparison, and the thing it would catch is a lost or
    // duplicated sample at an odd-length hop join — the defect `decimate2`
    // carries a phase bit to prevent and that this file could still undo.
    const one = new Float32Array(3 * H);
    const streamed = decimate2(newDecimator(), fullL, fullR, one, 3 * H);
    /**
     * The reference ring is wound forward to the SAME head the tap's was at when
     * it cut this window — `cutWindow` refuses a window the head has run past,
     * and it is right to. Window 0 is cut at 40 004 lane samples and window 2 at
     * the full 128 992, which is 68 488 into an 80 008-sample ring: WINDOW 2
     * WRAPS, and window 0 does not. Both are checked, because a ring that
     * ignored its head entirely would still hand back a correct window 0.
     */
    const oneShot = (w, count) => {
      const ring = new Float32Array(LANE_RING);
      for (let s = 0; s < count; s++) ring[s % LANE_RING] = one[s];
      return cutWindow(ring, count, w, new Float32Array(BASIC_PITCH.window));
    };
    const cmp = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === b[i]) n++; return n; };
    const ref0 = oneShot(0, windowEnd(0));
    const ref2 = oneShot(2, streamed);
    ok('window-0-is-the-one-shot-window', cmp(snap.get('bass@0'), ref0) === ref0.length,
      `${cmp(snap.get('bass@0'), ref0)}/${ref0.length} samples identical`);
    ok('window-2-is-the-one-shot-window-across-the-wrap',
      cmp(snap.get('bass@2'), ref2) === ref2.length,
      `${cmp(snap.get('bass@2'), ref2)}/${ref2.length}, window 2 starts at ${windowStart(2)} in a ${LANE_RING} ring`);
    // CONTROLS. The first: the ramp means the two windows are almost entirely
    // DIFFERENT audio, so the two comparisons above are not two readings of one
    // buffer. The second: the window is not a block of zeros that would match
    // anything — only the 3840-sample pre-roll may be zero.
    ok('control-the-two-windows-are-different-audio', cmp(ref0, ref2) < 64,
      `${cmp(ref0, ref2)} of ${ref0.length} samples coincide`);
    let nonZero = 0;
    for (let i = 0; i < ref0.length; i++) if (ref0[i] !== 0) nonZero++;
    ok('control-the-window-is-not-all-zeros', nonZero > BASIC_PITCH.window - BASIC_PITCH.preroll - 32,
      `${nonZero} non-zero of ${ref0.length}, pre-roll is ${BASIC_PITCH.preroll}`);

    const notes = sent.filter((m) => m.type === 'MIDI_NOTES');
    ok('one-message-per-published-hop', notes.length === 3, `${notes.length}`);
    ok('seq-is-gapless-from-one', notes.map((m) => m.seq).join(',') === '1,2,3',
      notes.map((m) => m.seq).join(','));
    ok('spans-are-source-seconds-and-contiguous',
      notes[0].spanFrom === 100 && notes[0].spanTo === 101.95 && notes[1].spanFrom === 101.95,
      `${notes[0].spanFrom} -> ${notes[0].spanTo} -> ${notes[1].spanTo}`);
    ok('every-hop-says-it-was-covered', notes.every((m) => m.covered === true));
    const n0 = notes[0].notes[0];
    ok('the-lane-note-arrived-on-the-video-clock',
      !!n0 && n0.stem === 'bass' && n0.pitch === 60 && n0.onSec === 100,
      n0 ? `${n0.stem} ${n0.pitch} at ${n0.onSec}s` : 'no note');
    ok('the-note-length-came-through-the-lane-clock',
      !!n0 && n0.offSec === msGrid(100 + 11025 * 2 / SR), n0 ? `${n0.offSec}` : 'no note');

    // ---- the passthrough hop. It must be UNCOVERED, carry no notes, and take a
    // note that lands inside it away from a LATER covered hop.
    t.uncovered(3 * H, H);
    const gap = sent.filter((m) => m.type === 'MIDI_NOTES')[3];
    ok('a-passthrough-hop-is-uncovered', gap.covered === false);
    ok('a-passthrough-hop-carries-no-notes', gap.notes.length === 0, `${gap.notes.length}`);
    ok('the-uncovered-second-is-counted', t.payload().uncoveredSec === 1.95, `${t.payload().uncoveredSec}`);
    ok('the-covered-second-is-counted-separately', t.payload().coveredSec === 5.85,
      `${t.payload().coveredSec}`);
    const breaks = posted.filter((m) => m.type === 'BREAK').map((m) => m.lane).sort().join(',');
    ok('a-passthrough-hop-breaks-every-lane',
      breaks === PITCHED.map((p) => p.stem).sort().join(','), breaks);

    // A note the worker hands back for audio inside the passthrough span is
    // DISCARDED; one just outside it is KEPT. Both halves, or the filter is a
    // second copy of "drop everything" wearing the word control.
    // The passthrough hop is source seconds [105.85, 107.80); window 4 is the one
    // cut during the covered hop AFTER it, so that is where the fixture's notes
    // are answered from.
    const inGap = laneSampleAt(106.35, 100);
    const outGap = laneSampleAt(105.35, 100);
    wanted.set('bass@4', [
      { pitch: 61, vel: 100, onSample: inGap, offSample: inGap + 11025 },
      { pitch: 62, vel: 100, onSample: outGap, offSample: outGap + 11025 },
    ]);
    for (let q = 2; q < STEM_PLANES; q++) planes[q].fill(0);
    t.covered(4 * H, H, planes);
    const after = sent.filter((m) => m.type === 'MIDI_NOTES')[4];
    const pitches = after.notes.map((n) => n.pitch).join(',');
    ok('a-note-inside-a-passthrough-span-is-discarded', !after.notes.some((n) => n.pitch === 61), pitches);
    ok('control-a-note-outside-it-is-delivered', after.notes.some((n) => n.pitch === 62), pitches);

    // ---- the drain. The last MIDI_NOTES claims NO new coverage, and FLUSHED
    // carries the seq the deck must be holding up to.
    const before = t.payload().seq;
    t.flush();
    const last = sent.filter((m) => m.type === 'MIDI_NOTES').pop();
    const flushed = sent.find((m) => m.type === 'MIDI_FLUSHED');
    ok('the-last-message-claims-no-new-coverage', last.spanFrom === last.spanTo,
      `[${last.spanFrom}, ${last.spanTo}]`);
    ok('flushed-carries-the-last-seq', !!flushed && flushed.seq === before + 1,
      flushed ? `${flushed.seq} after ${before}` : 'no MIDI_FLUSHED');
    ok('the-take-is-closed-for-notes', t.open === false);
    ok('a-closed-take-ignores-the-tap', (() => {
      const n = sent.length;
      t.covered(9 * H, H, planes);
      return sent.length === n;
    })(), 'covered() after flush sent nothing');

    t.stop();
    ok('stop-reports-off', t.payload().state === 'off', t.payload().state);

    /**
     * ---- THE TAP CANNOT THROW INTO `runChunk`, AND A FAULT IS NOT SILENT.
     *
     * This is the assertion that stands behind the whole "nothing waits on it"
     * rule: `LivePipeline.runChunk` calls `covered()` on the hop path, and an
     * exception escaping it would take the audio deck down over a feature the
     * deck can survive losing. The stimulus is a plane array that is short by
     * ten planes — the shape a caller bug or a changed stem count would
     * produce — and it is checked in BOTH directions, because a `covered()`
     * hardwired to `return` would pass the first half on its own.
     */
    const noisy = [];
    const bad = new Transcriber({
      deck: 'A', assetUrl: (r) => `stub://${r}`, send: (m) => noisy.push(m), log: () => {},
      videoNow: () => null, rateNow: () => 1,
    });
    bad.start();
    bad.anchor(0, 0, 1);
    ok('a-fresh-take-is-not-faulted', bad.payload().fault === null && bad.payload().state === 'running',
      bad.payload().state);
    let escaped = null;
    try { bad.covered(0, H, [new Float32Array(4)]); } catch (e) { escaped = e; }
    const err = noisy.find((m) => m.type === 'MIDI_ERROR');
    ok('a-broken-hop-does-not-throw-into-the-caller', escaped === null,
      escaped ? String(escaped.message) : 'nothing escaped');
    ok('a-broken-hop-is-reported-as-a-fault', !!err && bad.payload().state === 'fault',
      err ? `${err.code}` : 'no MIDI_ERROR was sent');
    ok('the-fault-is-latched-once',
      (() => { bad.covered(H, H, [new Float32Array(4)]); return noisy.filter((m) => m.type === 'MIDI_ERROR').length === 1; })(),
      `${noisy.filter((m) => m.type === 'MIDI_ERROR').length} MIDI_ERROR message(s)`);
    bad.stop();

    /**
     * ---- A FLUSH THAT ARRIVES BEFORE THE SESSION DOES STILL ANSWERS.
     *
     * Arm and convert within a second of each other and the ORT session is still
     * being created: there is a worker, it has not said READY, and no FLUSH can
     * be posted into it. The take is short but it is not broken, and the deck
     * must not be left in `finishing` until its own deadline turns a good take
     * `bad`. A mute port is the whole fixture.
     */
    mute = true;
    const quiet = [];
    const early = new Transcriber({
      deck: 'A', assetUrl: (r) => `stub://${r}`, send: (m) => quiet.push(m), log: () => {},
      videoNow: () => null, rateNow: () => 1,
    });
    early.start();
    early.anchor(0, 0, 1);
    early.flush();
    ok('a-flush-before-READY-still-answers', quiet.some((m) => m.type === 'MIDI_FLUSHED'),
      quiet.map((m) => m.type).join(',') || 'nothing was sent');
    ok('...and-the-answer-carries-the-last-seq',
      (() => { const f = quiet.find((m) => m.type === 'MIDI_FLUSHED');
        const n = quiet.filter((m) => m.type === 'MIDI_NOTES').pop();
        return !!f && !!n && f.seq === n.seq; })(),
      JSON.stringify(quiet.map((m) => `${m.type}:${m.seq}`)));
    early.stop();
    mute = false;

    delete globalThis.Worker;
  }

  /**
   * A FAKE WORKER PORT, factored out because sections 10 to 14 each need one with
   * a different opinion about answering. Same device as section 8's: it answers
   * INIT with READY, RUN with whatever `wanted` holds for that lane and window,
   * hands the lent buffer straight back, and records everything it was sent. The
   * one knob is `answers`: how many RUNs it will reply to before it goes deaf,
   * which is what lets a fixture force the queue to back up on demand.
   */
  const fakePort = (o = {}) => {
    const st = { posted: [], wanted: o.wanted || new Map(), answers: o.answers ?? Infinity };
    globalThis.Worker = class {
      constructor() { this.onmessage = null; this.onerror = null; }
      terminate() {}
      postMessage(m) {
        st.posted.push(m);
        if (m.type === 'INIT') return this._reply({ type: 'READY', threads: 2 });
        if (m.type === 'FLUSH') return this._reply({ type: 'FLUSHED' });
        if (m.type === 'RUN') {
          if (st.answers <= 0) return undefined;          // deaf: the queue backs up
          st.answers--;
          return this._reply({
            type: 'NOTES', id: m.id, lane: m.lane, w: m.w, window: m.window,
            notes: st.wanted.get(`${m.lane}@${m.w}`) || [],
          });
        }
        return undefined;
      }
      _reply(d) { if (this.onmessage) this.onmessage({ data: d }); }
    };
    return st;
  };
  const newTake = (sent, logs) => new Transcriber({
    deck: 'A', assetUrl: (r) => `stub://${r}`, send: (m) => sent.push(m),
    log: (l) => (logs ? logs.push(l) : undefined), videoNow: () => null, rateNow: () => 1,
  });
  const silence = (n) => Array.from({ length: STEM_PLANES }, () => new Float32Array(n));

  head('9. the two limits, at every hop the engine can be set to');
  {
    /**
     * THE ARITHMETIC HALF of the sizing correction. It reads `LIVE_HOPS` and
     * `makeLivePlan` rather than four numbers typed in, so a hop added to that
     * list is covered here on the day it is added; and it asserts the RESIDENCY
     * RELATION rather than the sizes, because the sizes are a means and the
     * relation is the claim.
     *
     * The value that makes it go red is reachable and was the shipped one:
     * `LANE_RING = BASIC_PITCH.window + BASIC_PITCH.hop` (80 008) with a cap of
     * 8, which fails the first assertion at hops 1.95, 2.6 and 3.9 and the second
     * at all three.
     */
    const { LIVE_HOPS } = await import('../shared/config.js');
    const { makeLivePlan, chunkPlan } = await import('../engine/live.js');
    let residency = 0, capsFit = 0, agree = 0, rows = [];
    for (const hs of LIVE_HOPS) {
      const p = makeLivePlan(hs);
      // Chunk 0 emits H - X and every later chunk H, so BOTH are hops this take
      // can be sized from and both have to hold.
      for (const len of [chunkPlan(0, p).emitLen, p.H]) {
        const laneHop = laneSamplesPerHop(len);
        const ring = laneRingFor(len);
        const cap = queueMaxFor(len);
        if (ring >= BASIC_PITCH.window + laneHop) residency++;
        if (cap >= PITCHED.length * Math.ceil(laneHop / BASIC_PITCH.hop)) capsFit++;
        // The two agree when the ring covers everything the cap can still hold:
        // at most `cap / lanes` DISTINCT windows, and `_count` inside the next
        // one. That is the derivation in "the two limits", asserted.
        if (ring >= BASIC_PITCH.window + (cap / PITCHED.length) * BASIC_PITCH.hop) agree++;
      }
      rows.push(`${hs}:${laneRingFor(p.H)}/${queueMaxFor(p.H)}`);
    }
    const n = LIVE_HOPS.length * 2;
    ok('every-hop-gets-a-ring-that-holds-window-plus-one-hop', residency === n, `${residency}/${n}  ${rows.join(' ')}`);
    ok('every-hop-gets-a-cap-of-five-times-the-windows-one-hop-can-cut', capsFit === n, `${capsFit}/${n}`);
    ok('the-ring-and-the-cap-agree-at-every-hop', agree === n, `${agree}/${n}`);
    // THE CONTROL THAT MUST LOSE: the shipped pair, replayed against the same
    // relation. If it passed, the three lines above would be asserting nothing.
    const shipped = BASIC_PITCH.window + BASIC_PITCH.hop;             // 80 008
    let shippedFails = 0;
    for (const hs of LIVE_HOPS) {
      if (shipped < BASIC_PITCH.window + laneSamplesPerHop(makeLivePlan(hs).H)) shippedFails++;
    }
    ok('control-the-model-hop-sizing-loses-at-three-of-the-four-hops', shippedFails === 3,
      `${shippedFails}/${LIVE_HOPS.length} hops need more than ${shipped} samples`);
    ok('a-hop-shorter-than-a-model-hop-still-gets-one-window', windowsPerHop(2205) === 1, `${windowsPerHop(2205)}`);
    ok('the-default-hop-can-make-two-windows-due-at-once',
      windowsPerHop(DEFAULT_HOP_FRAMES) === 2, `${windowsPerHop(DEFAULT_HOP_FRAMES)}`);
  }

  head('10. TWELVE HOPS AT THE SHIPPED DEFAULT HOP  (the drop nothing could see)');
  {
    /**
     * THE COMPOSITION CHECK THAT WOULD HAVE CAUGHT IT, and the reason it did not
     * exist: section 8 drives THREE hops, and the first drop is at hop 6.
     *
     * `ui/embed.js` never sends `SET_HOP`, so 1.95 s is the only hop the embedded
     * deck can run at — this drives that hop and nothing else, twelve times,
     * ON AN IDLE PORT THAT ANSWERS EVERY RUN. There is no load here at all: the
     * refusals it used to produce were pure arithmetic. One 1.95 s hop advances
     * the lane clock 42 997 samples against a 36 164-sample model hop, so every
     * ~5th hop makes TWO windows due at once, and `_cutWindows` pushed 5 lanes x 2
     * against a cap of 8 before `_pump` ran.
     *
     * WATCHED GOING RED, per AGENTS.md. With `laneRingFor` and `queueMaxFor`
     * restored to the shipped pair (`() => BASIC_PITCH.window + BASIC_PITCH.hop`
     * and `() => 8`) and nothing else changed, this section printed, verbatim:
     *
     *   FAIL twelve-hops-cut-every-window-that-fell-due  (60 RUNs, 14 windows x 5 lanes)
     *   FAIL twelve-hops-at-the-default-hop-refuse-nothing  (10 refused)
     *   FAIL ...and-every-hop-is-published-covered  (12 of 14)
     *   FAIL ...and-no-span-is-reported-uncovered  (2 spans)
     *   FAIL ...and-the-coverage-figure-is-the-audio-that-was-fed  (18.176s of 23.400s)
     *
     * — ten lane-windows lost out of seventy, in two drop episodes, over twelve
     * hops of an IDLE fixture. The whole file went 111 passed, 11 failed on that
     * one mutation (section 9's three, section 3's residency line and section
     * 14's pair go with it); reverting returned 122 passed, 0 failed. The
     * INSTRUMENT line below is what stops this passing on a run where no window
     * ever fell due at all.
     */
    const H = DEFAULT_HOP_FRAMES;                 // 85 995 — the ONLY hop the deck runs at
    const HOPS = 12;
    const port = fakePort();
    const sent = [];
    const t = newTake(sent);
    t.start();
    t.anchor(0, 0, 1);
    const planes = silence(H);
    let twoAtOnce = 0;
    for (let h = 0; h < HOPS; h++) {
      const before = t._nextW;
      t.covered(h * H, H, planes);
      if (t._nextW - before >= 2) twoAtOnce++;
    }
    const runs = port.posted.filter((m) => m.type === 'RUN');
    ok('INSTRUMENT-two-windows-really-do-fall-due-in-one-hop', twoAtOnce >= 2,
      `${twoAtOnce} of ${HOPS} hops cut two windows — without one this section asserts nothing`);
    ok('twelve-hops-cut-every-window-that-fell-due', runs.length === t._nextW * PITCHED.length,
      `${runs.length} RUNs, ${t._nextW} windows x ${PITCHED.length} lanes`);
    ok('twelve-hops-at-the-default-hop-refuse-nothing', t.payload().dropped === 0,
      `${t.payload().dropped} refused`);
    const notes = sent.filter((m) => m.type === 'MIDI_NOTES');
    ok('...and-every-hop-is-published-covered', notes.every((m) => m.covered === true),
      `${notes.filter((m) => m.covered).length} of ${notes.length}`);
    ok('...and-no-span-is-reported-uncovered', notes.every((m) => m.covered || m.spanTo === m.spanFrom),
      `${notes.filter((m) => !m.covered).length} spans`);
    ok('...and-the-coverage-figure-is-the-audio-that-was-fed',
      Math.abs(t.payload().coveredSec - HOPS * H / SR) < 0.002,
      `${t.payload().coveredSec}s of ${(HOPS * H / SR).toFixed(3)}s`);
    t.stop();
    delete globalThis.Worker;
  }

  head('11. a refused window reports ITS OWN span, and keeps the other lanes\' notes');
  {
    /**
     * THE OTHER HALF of the same defect, and it needs a refusal to exist at all —
     * which after section 10 no longer happens on its own. So the port is made
     * DEAF after one answer: the queue backs up, windows are refused, and the
     * lane whose one RUN was answered has delivered notes sitting inside the span
     * the refusals are about to declare uncovered.
     *
     * Two claims, and they were both wrong in opposite directions:
     *   - the span reported uncovered was the HOP's, 1.81 s away from the window
     *     that was actually not transcribed;
     *   - the refusing hop was published `covered: false`, so the deck's
     *     last-pass-wins rule deleted a whole hop of correctly transcribed notes
     *     from every stem.
     *
     * WATCHED GOING RED. With `_publish` restored to marking the whole refusing
     * HOP `covered: false` and merging that hop span into every lane, and nothing
     * else changed, this section printed, verbatim:
     *
     *   FAIL an-uncovered-span-is-a-model-window-not-a-hop  (0 of 6 spans are window spans, 6 are hop spans)
     *   FAIL a-transcribed-lane-keeps-its-notes-through-another-lanes-refusal
     *        (note 60 delivered in message 1, first refusal was message 3)
     *
     * 120 passed, 2 failed: every reported span the wrong 1.95 s, and the
     * delivered note never handed back after the deck was told to drop it.
     * `the-refusing-hop-is-still-published-covered` stayed GREEN under that
     * mutation, because other hops in this fixture are still covered — it is here
     * for the change that marks them all, and it is honest to record that it did
     * not carry this one.
     *
     * Replayed through the real `MidiTake` — a 23.4 s fixture whose DRUMS
     * transcribe perfectly while every model window is refused — the same
     * mutation took `uncoveredSpans` from twelve model-window spans to one
     * hop-shaped `[[1.95, 23.4]]`, and the drum notes the deck ends up holding
     * from 46 of 46 down to 3.
     */
    const port = fakePort({ answers: 1 });
    const sent = [], logs = [];
    const t = newTake(sent, logs);
    // The one RUN that will be answered is the FIRST lane of window 0, and
    // `_lanes` is in PITCHED order, so it is `bass@0`. Give it a note at its own
    // first kept frame — inside window 0's span, and inside nothing else's.
    port.wanted.set('bass@0', [{ pitch: 60, vel: 100,
      onSample: keptFrameSample(0, 0), offSample: keptFrameSample(0, 0) + 11025 }]);
    t.start();
    t.anchor(0, 0, 1);
    const H = DEFAULT_HOP_FRAMES;
    const planes = silence(H);
    for (let h = 0; h < 8; h++) t.covered(h * H, H, planes);
    const msgs = sent.filter((m) => m.type === 'MIDI_NOTES');
    const unc = msgs.filter((m) => !m.covered);
    ok('INSTRUMENT-the-deaf-port-forced-a-refusal', t.payload().dropped > 0 && unc.length > 0,
      `${t.payload().dropped} refused, ${unc.length} uncovered spans on the wire`);
    // A window's kept span, computed here from `keptFrameSample` and not from the
    // class, so this is not the class asserted against itself.
    const winSpan = (w) => [msGrid(keptFrameSample(w, 0) / BASIC_PITCH.sr),
      msGrid(keptFrameSample(w, BASIC_PITCH.keep - 1) / BASIC_PITCH.sr)];
    let asWindow = 0, asHop = 0;
    for (const m of unc) {
      for (let w = 0; w < 12; w++) {
        const [a, b] = winSpan(w);
        if (m.spanFrom === a && m.spanTo === b) asWindow++;
      }
      // The hop spans are the multiples of 1.95 this fixture publishes. A span
      // that is one of THOSE is the defect.
      if (Math.abs((m.spanTo - m.spanFrom) - H / SR) < 1e-9) asHop++;
    }
    ok('an-uncovered-span-is-a-model-window-not-a-hop', asWindow === unc.length && asHop === 0,
      `${asWindow} of ${unc.length} spans are window spans, ${asHop} are hop spans`);
    ok('the-refusing-hop-is-still-published-covered',
      msgs.some((m) => m.covered && m.spanTo > m.spanFrom),
      `${msgs.filter((m) => m.covered && m.spanTo > m.spanFrom).length} covered hops`);
    // THE HAND-BACK. `bass@0`'s note is inside window 0's kept span, which the
    // refusals declare uncovered — for the lanes that were refused, not for bass,
    // whose window ran. It must be on the wire after the refusal, not before it
    // only.
    const last = msgs.map((m, i) => ({ m, i })).filter((x) => x.m.notes.some((n) => n.pitch === 60)).pop();
    const firstUnc = msgs.findIndex((m) => !m.covered);
    ok('a-transcribed-lane-keeps-its-notes-through-another-lanes-refusal',
      !!last && last.i > firstUnc,
      last ? `note 60 delivered in message ${last.i + 1}, first refusal was message ${firstUnc + 1}`
        : 'note 60 was never delivered');
    ok('...and-the-take-still-reports-it', t.payload().notes === 1, `${t.payload().notes}`);
    /**
     * THE CONTROL, and it is the per-lane claim itself: window 0's five lanes are
     * cut together and then come apart — `bass@0` is answered, and the lanes
     * behind it in the queue are refused one at a time from the front. So SOME
     * lane must be blind over window 0's span and `bass` must not be. A single
     * shared `_unc` would put every lane in that list, including the one whose
     * window ran, which is exactly the shape that used to delete the drums.
     */
    const w0 = winSpan(0)[0] + 0.001;
    const blind = PITCHED.map((p) => p.stem).filter((st) => inSpans(t._unc.get(st), w0));
    ok('control-the-refusal-is-PER-LANE-and-not-the-whole-take',
      blind.length > 0 && !blind.includes('bass'),
      `window 0 is uncovered for [${blind.join(', ')}] and covered for bass, whose window ran`);
    t.stop();
    delete globalThis.Worker;
  }

  head('12. the tail is TRANSCRIBED, not merely counted');
  {
    /**
     * `flush()` used to drain the queue and post FLUSH without cutting a final
     * window, so the audio past the last COMPLETE window got no model pass — and
     * `coveredSec` counted it anyway. Measured on a clean 12 s fixture with zero
     * drops: `coveredSec` 12.000, the last lane sample any window read 253 336
     * (11.489 s), and the scored note at 11.5 s absent from the pack. A coverage
     * claim wrong in the FLATTERING direction, in the one feature whose argument
     * is that the figure never overstates.
     *
     * WATCHED GOING RED: with the `this._cutTail()` line commented out of
     * `flush()` and nothing else changed, this section printed, verbatim:
     *
     *   FAIL the-tail-is-cut-at-the-flush  (kept through 253336 of 264600 lane samples)
     *   FAIL every-second-counted-covered-went-through-a-window  (12s claimed, 11.489s transcribed)
     *
     * 120 passed, 2 failed; both green with the line back. Those are the same two
     * numbers the browser fixture reports — 253 336 lane samples IS 11.489 s —
     * and over the real model the scored piano note at 11.5 s went from absent to
     * `11.492`.
     */
    const port = fakePort();
    const sent = [];
    const t = newTake(sent);
    t.start();
    t.anchor(0, 0, 1);
    // The real geometry: chunk 0 emits H - X, then five whole hops, then the
    // remainder of a 12 s fixture. `_cutTail` is the only thing that reaches the
    // last 11 264 lane samples of it.
    const lens = [83790, 85995, 85995, 85995, 85995, 85995, 15435];
    let at = 0;
    for (const len of lens) { t.covered(at, len, silence(len)); at += len; }
    const before = keptThrough(t._nextW);
    const count = t._count;
    ok('INSTRUMENT-the-hops-alone-leave-a-tail-unread', before < count,
      `${count - before} lane samples past the last complete window`);
    t.flush();
    ok('the-tail-is-cut-at-the-flush', keptThrough(t._nextW) >= count,
      `kept through ${keptThrough(t._nextW)} of ${count} lane samples`);
    // The kept grid of the LAST window runs on into the zero pad, so the honest
    // comparison is against the audio that existed: `min(keptThrough, count)`.
    const read = msGrid(Math.min(keptThrough(t._nextW), count) / BASIC_PITCH.sr);
    ok('every-second-counted-covered-went-through-a-window',
      t.payload().coveredSec <= read + 0.001, `${t.payload().coveredSec}s claimed, ${read}s transcribed`);
    ok('the-tail-costs-at-most-two-windows', t._nextW * BASIC_PITCH.hop - count < 2 * BASIC_PITCH.hop,
      `${t._nextW} windows for ${count} lane samples`);
    t.stop();
    delete globalThis.Worker;
  }

  head('13. the output-frame axis RESTARTS under an open take');
  {
    /**
     * `LivePipeline.start()` re-zeroes the absolute output-frame axis at both
     * ends — a new `LiveEmitter` puts `commit` back to 0 and `baseFrame` is
     * re-read — and a restart under an open take is the ordinary path: a PAUSE
     * (`embed-state.js::follow` returns 'stop'), a seek (`onContentJump` ->
     * `restartLive`) and an ad break all take it, and `engine.js::startLive`
     * deliberately re-attaches the SAME take across one.
     *
     * SECTION 8 NEVER RESTARTS THE AXIS, which is the only reason this survived:
     * every hop it drives is `h * H` on one continuous axis, so a `_f0` latched
     * on the first hop is right for the whole fixture. This section is that
     * fixture with one thing changed.
     *
     * WATCHED GOING RED. With `_anchorIfNeeded` back to
     * `if (this._f0 === null) this._f0 = fromFrame;` and nothing else changed:
     *
     *   FAIL a-restart-does-not-move-the-notes  (continuous axis 27.882s,
     *        restarted axis 57.132s after 29.25s played)
     *
     * — late by 29.250 s, the played duration exactly. Driven at 120.9 s played
     * instead, the same fixture reads 240.627 against a control of 119.727, and
     * the error is again the played duration to the millisecond. That mutation
     * also reds section 14's `...and-its-notes-are-delivered`, because a seek
     * restarts the axis too: 120 passed, 2 failed, and 122/0 with the
     * re-derivation back. The other two lines here stayed green under it — the
     * INSTRUMENT one by design, and the schedule one because it reads the CONTROL
     * run, which never restarts.
     *
     * DRUMS STAY RIGHT EITHER WAY, and that is why the file read as plausible:
     * `_collect()` sends drum onsets through `_srcSec` with no lane arithmetic.
     * The bug moved the five melodic stems and left the twelfth-of-a-file that
     * would have made it obvious alone.
     */
    const H = DEFAULT_HOP_FRAMES;
    const PLAYED = 15;                                   // 29.25 s before the pause
    const runAxis = (restart) => {
      const port = fakePort();
      const sent = [];
      const t = newTake(sent);
      t.start();
      t.anchor(0, 0, 1);
      const planes = silence(H);
      for (let h = 0; h < PLAYED; h++) t.covered(h * H, H, planes);
      const playedSec = PLAYED * H / SR;
      const base = restart ? 0 : PLAYED * H;
      // What `midiAnchor()` does at the resume: the page's clock against the NEW
      // capture head, which the take reads as a jump and re-ties to.
      if (restart) t.anchor(0, playedSec, 1);
      const w = t._nextW;
      port.wanted.set(`bass@${w}`, [{ pitch: 60, vel: 100,
        onSample: keptFrameSample(w, 0), offSample: keptFrameSample(w, 0) + 11025 }]);
      for (let h = 0; h < 3; h++) t.covered(base + h * H, H, planes);
      t.stop();
      delete globalThis.Worker;
      const n = sent.filter((m) => m.type === 'MIDI_NOTES').flatMap((m) => m.notes)
        .find((x) => x.pitch === 60);
      return { onSec: n ? n.onSec : null, playedSec, w };
    };
    const cont = runAxis(false), broke = runAxis(true);
    ok('INSTRUMENT-the-control-produced-a-note-to-compare-against',
      cont.onSec !== null && broke.onSec !== null,
      `continuous ${cont.onSec}, restarted ${broke.onSec}`);
    ok('a-restart-does-not-move-the-notes', cont.onSec === broke.onSec,
      `continuous axis ${cont.onSec}s, restarted axis ${broke.onSec}s after ${cont.playedSec}s played`);
    // The absolute value as well as the equality: two identically-wrong axes
    // would satisfy the line above. Window `w`'s first kept frame is
    // `w*hop / 22050` seconds into a take anchored at 0.
    ok('...and-the-note-is-where-the-window-schedule-puts-it',
      cont.onSec === msGrid(keptFrameSample(cont.w, 0) / BASIC_PITCH.sr),
      `${cont.onSec}s vs ${msGrid(keptFrameSample(cont.w, 0) / BASIC_PITCH.sr)}s for window ${cont.w}`);
  }

  head('14. LAST PASS WINS — a backwards seek over a span the first pass missed');
  {
    /**
     * `MidiTake.accept` SUBTRACTS a replayed covered span out of the deck's
     * uncovered list; this file's `_unc` only ever grew, and `_pushNote` refused
     * every note inside it. Two halves of one rule doing opposite things: the
     * deck un-marked the span, the engine went on discarding the second pass, and
     * the user replays a passage precisely because the first pass was bad.
     *
     * WATCHED GOING RED: with the `cutSpan` line removed from `_publish` and
     * nothing else changed, this section printed, verbatim:
     *
     *   FAIL a-span-read-on-the-second-pass-stops-being-uncovered  ([[5.85,7.8]])
     *   FAIL ...and-its-notes-are-delivered  (0 notes in [5.85, 7.8): [])
     *
     * 120 passed, 2 failed. Replayed through the real `MidiTake`, the same
     * mutation puts the disagreement itself on screen: the deck's own
     * `uncoveredSpans` comes back `[]` — it had already un-marked the span — while
     * the engine emitted nothing inside it. With the line back: 1 note on the
     * wire, 1 note held.
     */
    const port = fakePort();
    const sent = [];
    const t = newTake(sent);
    const H = DEFAULT_HOP_FRAMES;
    for (let w = 0; w < 24; w++) {
      port.wanted.set(`bass@${w}`, [{ pitch: 60 + (w % 12), vel: 100,
        onSample: keptFrameSample(w, 0), offSample: keptFrameSample(w, 0) + 11025 }]);
    }
    t.start();
    t.anchor(0, 0, 1);
    const planes = silence(H);
    for (let h = 0; h < 3; h++) t.covered(h * H, H, planes);
    t.uncovered(3 * H, H);                               // passthrough over [5.85, 7.80)
    const GAP = [5.85, 7.8];
    ok('INSTRUMENT-the-first-pass-left-the-span-uncovered',
      inSpans(t._unc.get('bass'), 6.5) && inSpans(t._unc.get('drums'), 6.5),
      JSON.stringify(t._unc.get('bass')));
    // The seek. The pipeline restarts, so the axis restarts with it — which is
    // section 13's fixture arriving here for a second reason.
    t.anchor(0, GAP[0], 1);
    for (let h = 0; h < 6; h++) t.covered(h * H, H, planes);
    const replayed = sent.filter((m) => m.type === 'MIDI_NOTES')
      .flatMap((m) => m.notes).filter((n) => n.onSec >= GAP[0] && n.onSec < GAP[1]);
    ok('a-span-read-on-the-second-pass-stops-being-uncovered',
      !inSpans(t._unc.get('bass'), 6.5), JSON.stringify(t._unc.get('bass')));
    ok('...and-its-notes-are-delivered', replayed.length > 0,
      `${replayed.length} notes in [${GAP[0]}, ${GAP[1]}): ${JSON.stringify(replayed.map((n) => n.onSec))}`);
    // CONTROL: the rule is LAST pass wins, not "uncovered never sticks". A span
    // no second pass ever reached must still be refused.
    ok('control-a-span-nobody-replayed-is-still-refused',
      cutSpan(mergeSpan(mergeSpan([], 10, 20), 30, 40), 10, 20).length === 1,
      'subtracting one of two spans leaves the other');
    t.stop();
    delete globalThis.Worker;
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

/**
 * The inverse of the take's own clock, for the fixture above: which lane sample
 * carries source second `srcSec` when the take was anchored at `anchorSec` on
 * output frame 0 at unity rate? Written out longhand rather than reusing the
 * class's own path, so the fixture is not asserting a function against itself.
 */
function laneSampleAt(srcSec, anchorSec) {
  return Math.round((srcSec - anchorSec) * BASIC_PITCH.sr);
}

// Node only, and only when this file IS the entry point. No top-level await: the
// offscreen document imports this module synchronously.
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return selfCheck();
  }).catch((e) => { console.error(e); process.exit(1); });
}
