/**
 * BOUNCE - the arithmetic of rendering what a deck is PLAYING, offline.
 *
 * A Bounce is not an Export. Export (E1) is the six untouched model outputs at
 * unity, for a DAW. A Bounce is ONE file: the deck's own output with its
 * settings baked in, for a listener who wants what they heard. A deliverable
 * and a mix are different things with different consumers, so they get
 * different names - desktop-app-plan.md section 13 and docs/AUDIO.md section 5.1.
 *
 * ------------------------------------------------------------ WHAT IT BAKES
 *
 * THREE THINGS, NOT FOUR: faders, mute/solo (with the crossfader, which is the
 * same stage) and transpose. SPEED IS NOT ONE OF THEM, and the word is removed
 * with its reason rather than dropped quietly.
 *
 *   offscreen/engine.js's SPEED case refuses a cached deck in terms - "there is
 *   no page rate to drive" - CachedDeck has no rate control anywhere in its
 *   surface, and a File source is the only kind a Bounce can render. A Live
 *   source's speed is already baked into the captured stems by Chrome's own
 *   renderer, upstream of the capture tap, which is why engine.js calls the
 *   deck's speed field A RECORD AND NOT A CONTROL.
 *
 *   So "bake the speed" has no referent on the only path that can bounce. A
 *   bounce at a DIFFERENT speed is new time-stretch DSP - it is not baking, and
 *   it collides with the standing key ruling (qa/speed-pitch.mjs: speed must not
 *   move the key). That is a separate, later item and must not arrive here by
 *   accident.
 *
 * ------------------------------------------------- WHY THIS FILE IS ARITHMETIC
 *
 * The DSP is ALREADY real-time-independent. offscreen/playback-processor.js
 * names no clock at all - no currentTime, no currentFrame, no Date.now, no
 * performance.* - it is driven entirely by the sample clock and the ring
 * indices, and its gain smoothing is a one-pole in SAMPLES. What is paced by
 * real time is THE RING PRODUCER, and that is what this file plans.
 *
 * -------------------------------------------- THE FAILURE MODE THIS PREVENTS
 *
 * startRendering() on an OfflineAudioContext runs as fast as the thread can
 * produce quanta and NOTHING paces a producer against it. The stem ring holds
 * STEM_RING_FRAMES = 524288 frames = 11.89 s across fourteen planes. So a naive
 * offline render yields ABOUT TWELVE SECONDS OF CORRECT AUDIO AND THEN A FADE TO
 * SILENCE - the worklet doing exactly what it was built to do when starved
 * (playback-processor.js, the `avail < n` branch: fade over fadeLen, hold, and
 * do not advance the read pointer).
 *
 * THE FIRST TWELVE SECONDS SOUND RIGHT. It passes a listen. It passes any gate
 * whose fixture is shorter than the ring. That is why bounceCushionFloor below
 * is a function rather than a comment, and why the suite's long fixture is
 * longer than the ring on purpose.
 *
 * The mechanism is suspend(t) / resume() with a ring top-up at each stop.
 * Suspension timing is EXACT rather than approximate - requested equals actual
 * at quantum-aligned values - so the refill points are deterministic and can be
 * computed here, once, and asserted without a browser.
 *
 * A WHOLE-TRACK RING WAS REJECTED ON MEMORY: fourteen planes of a four-minute
 * track is 593 MB, on top of ORT's ~1.7 GB. The ring stays the shipped size and
 * the producer stops ~40 times for a four-minute track instead.
 *
 * ---------------------------------------------------------------- THE TRIM
 *
 * The transpose lanes delay every plane by exactly PITCH_GROUP_DELAY_SAMPLES at
 * EVERY setting including 0 (the drums lane takes a matched delay of the same
 * length, which is what keeps the planes aligned). So the render is
 * `frames + 3072` long and the deliverable is that render with its first 3072
 * frames dropped. A bounce that skipped the trim would ship 69.7 ms of silence
 * in front of every file and be one group delay late against the source for
 * ever.
 *
 * ------------------------------------------------- WHAT DOES *NOT* APPLY HERE
 *
 * docs/AUDIO.md section 1.3's resampling warning - decodeAudioData() into a
 * context of a different rate goes through blink::SincResampler - DOES NOT BITE
 * A BOUNCE, and it is worth saying so before somebody cites it. A bounce renders
 * 44100 -> 44100 and instantiates no AudioBufferSourceNode at all: the stems
 * reach the graph through the SAB ring, so there is no resampler in the path to
 * be argued about. The L-rule's prohibition is on sample-rate conversion between
 * the capture clock and the model clock; a bounce crosses neither.
 *
 * `node qa/bounce.mjs` drives this file and the render path it plans.
 */

import { SR, STEM_RING_FRAMES } from '../shared/config.js';
import { PITCH_GROUP_DELAY_SAMPLES } from './pitch.js';

/**
 * The Web Audio render quantum, fixed at 128 frames by the specification and by
 * playback-processor.js's own `Q`. It is a constant here rather than a parameter
 * with a default, because a suspension that is not quantum-aligned is rounded by
 * the implementation and the plan would then describe refills that happen
 * somewhere else.
 */
export const BOUNCE_QUANTUM = 128;

/**
 * How often the producer stops to top the ring up, in frames - HALF the ring.
 *
 * WHY A HALF AND NOT MORE. The consumer drains exactly BOUNCE_QUANTUM per render
 * step and cannot be late, so the only thing a bigger refill period buys is
 * fewer round trips; what it costs is cushion. At half the ring the floor is
 * capacity / 2 = 5.94 s of slack, which means a plan that is wrong by one refill
 * still cannot starve - the failure shows up in bounceCushionFloor rather than
 * in the audio. At `capacity - quantum` the floor is one quantum and any
 * arithmetic slip is a fade to silence.
 *
 * WHAT IT COSTS: ceil(frames / 262144) stops - 40 for a four-minute track, 2 for
 * the suite's 14-second fixture. Each stop is one promise and one memcpy.
 */
export const BOUNCE_REFILL_FRAMES = STEM_RING_FRAMES >> 1;

/**
 * THE CLOSED SET OF BOUNCE FAILURE CODES, declared before the first Host can
 * invent one.
 *
 * This is issue #29's lesson applied rather than repeated: ARM_CODES is a closed
 * set of 8 that the seam never checks, and a Host that returns a plausible
 * code outside it gets an undismissable banner with a dead button and nothing
 * red anywhere. A vocabulary that is declared and validated on receipt costs one
 * frozen object.
 */
export const BOUNCE_CODES = Object.freeze({
  NO_TRACK: 'no track is loaded on that deck, so there is nothing to bounce',
  NOT_CACHED: 'a bounce renders a separated track; this deck is live and holds no whole track',
  BUSY: 'a bounce is already running on this deck',
  SINK_REFUSED: 'the Host would not open a destination for the file',
  RENDER_FAILED: 'the offline render did not finish',
  CANCELLED: 'the bounce was cancelled before it committed',
});

/** True for a code this unit declares. Validate on receipt; never on faith. */
export const isBounceCode = (code) => Object.prototype.hasOwnProperty.call(BOUNCE_CODES, code);

/**
 * Build a bounce failure that CARRIES its code, so the wire never has to
 * recover one by matching on a message.
 *
 * IT REFUSES AN UNDECLARED CODE RATHER THAN PASSING IT ON. That is the whole
 * lesson of #29 in four lines: `ARM_CODES` is a closed set the seam never
 * checked, so a plausible-looking invention travelled all the way to a banner
 * with a dead button. A code that is not in the table is a defect in the unit
 * and it fails here, at the throw site, where the stack still names it.
 */
export function bounceError(code, detail) {
  if (!isBounceCode(code)) {
    throw new Error(`bounce: ${JSON.stringify(code)} is not a declared bounce code — `
      + `the declared set is ${Object.keys(BOUNCE_CODES).join(', ')}`);
  }
  const e = new Error(detail ? `${BOUNCE_CODES[code]} - ${detail}` : BOUNCE_CODES[code]);
  e.code = code;
  return e;
}

/**
 * WHICH REFUSAL A DECK EARNS, as a pure function of the deck - so a suite can
 * DRIVE each state and read the code back.
 *
 * THIS FUNCTION EXISTS BECAUSE THE INLINE VERSION WAS UNREACHABLE FOR A WHOLE
 * REVIEW CYCLE. offscreen/engine.js used to decide it at the call site:
 *
 *     if (!cd || !cd.track) bounceFailed(id, isCached(id) ? 'NO_TRACK' : 'NOT_CACHED');
 *
 * and `isCached(id)` is `!!(cachedDecks[id] && cachedDecks[id].track)`
 * (engine.js:534) - which is EXACTLY `!(!cd || !cd.track)`, with no await
 * between the two statements. So inside the `if`, the ternary's condition was
 * ALWAYS FALSE and `NO_TRACK` could never be produced: every refusal reported
 * `NOT_CACHED`. The failing case is ordinary - a deck that HAD a track and was
 * unloaded (`cacheddeck.js` sets `this.track = null` in two places) asks for a
 * bounce and is told "this deck is live and holds no whole track" about a deck
 * that is not live. The one sentence the user needs could never be printed.
 *
 * AND IT SURVIVED REVIEW BECAUSE THE ASSERTION NAMED FOR EXACTLY THAT PROPERTY
 * WAS A SCAN FOR STRING LITERALS in engine.js's source: both codes appear in the
 * file, so both counted as "covered". A scan for a string is not a test of
 * reachability, and no mutation that deletes ONE literal can expose it.
 *
 * So the decision moves here, where it is a value rather than a control-flow
 * accident - the shape `stemcache.js`'s `primeRefusal` and `separationRefusal`
 * already have, for the same reason: a refusal nobody can drive is a refusal
 * nobody has seen.
 *
 * THE TWO STATES ARE GENUINELY DIFFERENT PROBLEMS WITH DIFFERENT FIXES, which is
 * the whole reason for two codes:
 *
 *   NOT_CACHED   the deck IS LIVE - capturing, or running the live pipeline.
 *                There is audio; it is simply not a whole separated track yet.
 *                The fix is to let the prime finish and play it from the cache.
 *   NO_TRACK     the deck holds nothing and is not live - never loaded, or
 *                unloaded. The fix is to load something.
 *
 * ------------------------------- AND IT TAKES THE LIVENESS FACT, WHICH IS WHY
 *
 * The first repair of this defect took the deck's `CachedDeck` and read
 * `!cd -> NOT_CACHED`, `!cd.track -> NO_TRACK`. That is still wrong, and wrong
 * in the reviewer's own failing case, because of one line in the caller:
 * `CachedDeck.stop()` and `.dispose()` have exactly ONE caller between them -
 * `stopCached()` in `offscreen/engine.js` - and its next statement is
 * `cachedDecks[id] = null`. So a deck that HAD a track and was unloaded arrives
 * with NO `CachedDeck` AT ALL, indistinguishable from a live one, and is told
 * "this deck is live and holds no whole track" about a deck that is not live -
 * which is the sentence the review was about. `NO_TRACK` would then be
 * reachable in exactly one state: the window inside `await cd.load()`, where
 * the deck is arguably the most live it ever is.
 *
 * LIVENESS IS NOT DERIVABLE FROM `cachedDecks`. It lives on `Deck` - capture
 * status and the live pipeline's status - so the caller passes it in, and the
 * two facts this takes are INDEPENDENT. That is the property that makes the
 * original defect impossible to write again: a ternary over one fact cannot
 * express this, and no fixture can make the two inputs the same input.
 *
 * @param {{cachedTrack:boolean, live:boolean}} [d] the two facts, from the
 *        engine: does this deck hold a whole cached track, and is it live?
 *        Absent means neither, which is a deck the engine has never seen.
 * @returns {'NO_TRACK'|'NOT_CACHED'|null} the code to refuse with, or `null` to
 *          proceed. Never a code outside `BOUNCE_CODES`.
 */
export function bounceRefusal(d) {
  if (d && d.cachedTrack) return null;
  return d && d.live ? 'NOT_CACHED' : 'NO_TRACK';
}

/**
 * The code a bounce failure reaches the WIRE with. Validated on receipt, and the
 * fallback is named rather than assumed.
 *
 * THE PATH THAT NEEDS THIS IS REACHABLE AND IS NOT A LITERAL. `BOUNCE_START`'s
 * catch reports `e && e.code`, and not every error that arrives there is one of
 * ours: `writeBounce`'s `enc.pipeTo()` runs OUTSIDE the SINK_REFUSED try/catch,
 * so a disk-full mid-write hands this an OS error whose `.code` is `'ENOSPC'`.
 * Unvalidated, that reaches `BOUNCE_ERROR.code` on the wire - which is the
 * ARM_CODES failure (#29) exactly, one layer further out: a plausible code no
 * table declares, a surface that renders it, and nothing red anywhere.
 *
 * A scan of engine.js's source cannot see this, because there is no literal to
 * find at that call site. It is a run-time property, so it takes a function that
 * can be run.
 */
export function bounceWireCode(code) {
  return isBounceCode(code) ? code : 'RENDER_FAILED';
}

/**
 * THE RENDER PLAN. Pure: no context, no ring, no clock.
 *
 * @param {object} o
 * @param {number} o.frames        frames of TRACK - what the deliverable holds
 * @param {number} [o.capacity]    stem-ring capacity, frames, a power of two
 * @param {number} [o.refillEvery] frames between producer stops
 * @param {number} [o.trim]        head frames to drop; the transpose group delay
 * @param {number} [o.sampleRate]
 * @returns {{
 *   trimFrames:number, outputFrames:number, renderFrames:number,
 *   quantaFrames:number, capacity:number, quantum:number, refillEvery:number,
 *   prefill:number, refills:{frame:number, seconds:number}[]
 * }}
 *
 * `quantaFrames` is the one an implementer gets wrong. Web Audio renders
 * ceil(length / quantum) WHOLE quanta and truncates the buffer afterwards, so
 * the ring has to carry the ROUNDED-UP count. Feed it renderFrames and the final
 * quantum starves - which fades the last 20 ms of every bounce out and looks
 * like a taste decision rather than a bug.
 */
export function bouncePlan(o = {}) {
  const frames = o.frames;
  const capacity = o.capacity == null ? STEM_RING_FRAMES : o.capacity;
  const quantum = BOUNCE_QUANTUM;
  const trim = o.trim == null ? PITCH_GROUP_DELAY_SAMPLES : o.trim;
  const sampleRate = o.sampleRate == null ? SR : o.sampleRate;
  const refillEvery = o.refillEvery == null ? BOUNCE_REFILL_FRAMES : o.refillEvery;

  if (!Number.isInteger(frames) || frames < 1) {
    throw new RangeError(`bounce: frames must be a positive integer, got ${frames} - `
      + 'a bounce of nothing is a file that is silently not the track');
  }
  if (!Number.isInteger(capacity) || capacity < 1 || (capacity & (capacity - 1)) !== 0) {
    throw new RangeError(`bounce: ring capacity must be a power of two, got ${capacity}`);
  }
  if (!Number.isInteger(trim) || trim < 0) {
    throw new RangeError(`bounce: trim must be a frame count, got ${trim}`);
  }
  if (!Number.isInteger(refillEvery) || refillEvery < quantum || refillEvery % quantum !== 0) {
    throw new RangeError(`bounce: refillEvery must be a positive multiple of the ${quantum}-frame render `
      + `quantum, got ${refillEvery} - a stop between quanta is rounded by the implementation and the `
      + 'plan would describe refills that happen somewhere else');
  }
  if (refillEvery > capacity - quantum) {
    throw new RangeError(`bounce: refillEvery ${refillEvery} does not fit a ${capacity}-frame ring - `
      + 'the consumer would drain past the end before the producer is next allowed to write');
  }

  const renderFrames = frames + trim;
  const quantaFrames = Math.ceil(renderFrames / quantum) * quantum;
  const refills = [];
  for (let f = refillEvery; f < quantaFrames; f += refillEvery) {
    refills.push({ frame: f, seconds: f / sampleRate });
  }
  return {
    trimFrames: trim,
    outputFrames: frames,
    renderFrames,
    quantaFrames,
    capacity,
    quantum,
    refillEvery,
    prefill: Math.min(quantaFrames, capacity),
    refills,
  };
}

/**
 * THE MINIMUM CUSHION THE PLAN LEAVES, in frames - the whole design as one
 * number, computed without a context, a worklet or a clock.
 *
 * It simulates the only two things that move the ring: the consumer takes
 * `quantum` frames per render step and never varies, and the producer refills to
 * the ring's brim at each planned stop. If this ever returns less than
 * `quantum`, the worklet starves at that step and the bounce fades out from
 * there - so the assertion over it is `>= quantum`, and the number gets SMALLER
 * as the plan gets worse rather than merely flipping a verdict.
 *
 * It is the second instrument on the same claim the long-fixture render gate
 * makes, and deliberately independent of it: this one cannot be fooled by a
 * fixture that is shorter than the ring, and that one cannot be fooled by an
 * arithmetic model that has drifted from the shipped producer.
 *
 * A CORRECT PLAN'S FLOOR IS EXACTLY ONE QUANTUM, AT THE LAST STEP, BY
 * CONSTRUCTION - the ring is meant to run dry exactly as the render ends, and
 * nothing is owed after that. So the number to read is not how large the floor
 * is but WHERE it is and whether it dropped below a quantum: a plan missing one
 * refill reports a floor of 0 at the frame the ring ran out, which names the
 * ring rather than the last sample. The frame is returned for that reason.
 *
 * @returns {{frames:number, at:number}} the smallest cushion and the render
 *          frame it occurs at. `frames` may go NEGATIVE, which is the honest
 *          reading of "the consumer asked for samples nobody had written".
 */
export function bounceCushionFloor(plan) {
  const refillAt = new Set(plan.refills.map((r) => r.frame));
  let filled = plan.prefill;
  let floor = Infinity;
  let at = 0;
  for (let f = 0; f < plan.quantaFrames; f += plan.quantum) {
    if (refillAt.has(f)) filled = Math.min(plan.quantaFrames, f + plan.capacity);
    const cushion = filled - f;
    if (cushion < floor) { floor = cushion; at = f; }
  }
  return { frames: floor === Infinity ? 0 : floor, at };
}

/**
 * The deliverable's base name. ONE file, and the extension is .wav because a
 * bounce is 32-bit float at the model clock like every other deliverable this
 * project writes (docs/AUDIO.md section 4.5).
 *
 * The Host owns the directory, the dialog and the collision policy - see
 * exportSink in shared/host.js. All this owes it is a base name that is a base
 * name: no separator may survive, or a Host that joins it to a directory writes
 * outside the folder the user picked.
 */
export function bounceFileName(title) {
  const t = String(title == null ? '' : title).replace(/[\\/:*?"<>|]/g, '_').trim();
  return `${t.slice(0, 120) || 'bounce'}.wav`;
}

/**
 * WHAT THE BOUNCE BAKES, read off a deck, as one flat record - so the render
 * path takes a VALUE rather than a live deck and the suite can state a fixture
 * without constructing one.
 *
 * `mix` and `assign` are copied rather than referenced: a render takes minutes
 * and a user who moves a fader during one must not silently change what is
 * already half-written. The bounce is of the settings AS THEY WERE WHEN IT WAS
 * ASKED FOR, which is also the only definition a progress bar can be honest
 * about.
 */
export function bounceSettings(deck) {
  return {
    id: deck.id,
    mix: deck.mix.map((m) => ({ gainDb: m.gainDb, muted: !!m.muted, soloed: !!m.soloed })),
    xf: { position: deck.xf.position, curve: deck.xf.curve, assign: deck.xf.assign.slice() },
    masterDb: deck.masterDb,
    semitones: deck.semitones,
  };
}
