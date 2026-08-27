/**
 * AHEAD-OF-TIME mode — the SYMMETRIC window, for a Source that is a whole file.
 * Pure arithmetic, no browser APIs, so `node test.js offline` exercises every line.
 *
 * WHY THIS IS NOT `engine/live.js`. That file is the CAUSAL window: chunk k reads
 * `[(k+1)·H − L, (k+1)·H)` and never a frame past its own emit point, because at
 * capture time the future does not exist yet. A file has no such constraint — every
 * sample is already on disk — and paying the causal cost for it means every window
 * separates with no right-hand context, on the one path whose output is a
 * deliverable. The two geometries are different laws over the same weights and they
 * live in different files for that reason. `pipelineVersion`'s `geometry` component
 * (shared/stemcache.js) is what stops an entry made under one being served for the
 * other.
 *
 *   window k input : [ k·STRIDE , k·STRIDE + SEGMENT )
 *   overlap        : SEGMENT − STRIDE = 85 995 frames = 1.95 s
 *
 * THE WINDOW IS STILL A FULL `SEGMENT`, so `Backend.separate(mix, out)` is called
 * exactly as the live path calls it. The seam does not move, `BACKEND_DUTIES` does
 * not change, and no Host has to know this mode exists.
 *
 * ---------------------------------------------------------------------------
 * ONE OR TWO CONTRIBUTIONS PER SAMPLE — NOT "AT LEAST TWO", AND THE DIFFERENCE IS
 * THE WHOLE OF THE WEIGHTING.
 *
 * `qa/test-edge.mjs` USED TO assert this in a NAME — "STRIDE < SEGMENT so every
 * interior sample gets >= 2 contributions" — while checking only the inequality,
 * which is true and does not imply it. At STRIDE = 0.75·SEGMENT a sample is
 * covered by `SEGMENT/STRIDE` = 1.33 windows on average: MEASURED over a
 * seven-window track, 1 375 920 samples get exactly one contribution and 515 970
 * get two. Two everywhere would need STRIDE <= SEGMENT/2, and 257 985 > 171 990.
 * That assertion is renamed to what it checks, and a second one beside it now
 * carries the real coverage property — so this paragraph and that gate agree.
 *
 * So this cannot divide by a contribution count of two, and it cannot divide by a
 * per-sample weight sum accumulated as it goes without holding the whole track. It
 * does the thing that needs neither: COMPLEMENTARY RAMPS THAT ALREADY SUM TO ONE.
 * In an overlap the outgoing window is faded by `fo` and the incoming by `fi`, and
 * `makeFades`' linear law gives `fi[j] + fo[j] = 1` exactly; everywhere else a
 * single window contributes at unity. The weights sum to 1 at every frame by
 * construction rather than by arithmetic afterwards, which is what makes the
 * identity test in `test.js` group('offline') exact rather than approximate.
 *
 * LINEAR, NOT EQUAL-POWER, and `engine/live.js:100-101` already settled why: the two
 * overlapping windows are two estimates of THE SAME AUDIO, so equal-power adds
 * +3.01 dB through the middle of every join. `SEAM_XFADE_LAW` is `'linear'`.
 *
 * THE FIRST WINDOW DOES NOT FADE IN AND THE LAST DOES NOT FADE OUT. There is
 * nothing on the other side to cross into or out of, so a ramp there would fade the
 * track's own head and tail to silence — the classic overlap-add edge case, and the
 * one the identity test is pointed at.
 *
 * ---------------------------------------------------------------------------
 * AND THE PRIMING DOCTRINE, FROM THIS SIDE OF IT. `shared/stemcache.js`'s header
 * and `offscreen/engine.js`'s `pageRate` note both say a prime is one real-time
 * pass that cannot be hurried, and both are TRUE AND UNCHANGED: what they are
 * about is the CAPTURE. Raising `video.playbackRate` still captures at 48 kHz, so
 * a fast pass throws away the top of the band and hands the separator material it
 * has never heard.
 *
 * A FILE NEVER TOUCHES THAT PATH. It is decoded whole, at the model's own clock,
 * before a single window is separated — no `playbackRate`, no tab stream, no
 * 48 kHz capture to lose the band from, no phase vocoder anywhere near it. The
 * samples the separator sees are the samples in the file, so a run here is as
 * fast as the machine allows and that is outside what those paragraphs forbid
 * rather than an exception to them. Both files carry this note, because a
 * doctrine left standing beside code that appears to contradict it is worse than
 * either alone: the next reader hits "the answer is no" and reverts the work.
 *
 * ---------------------------------------------------------------------------
 * WHAT ELSE IS IN HERE. The geometry above is the first half; `runOffline` drives
 * the window loop over an INJECTED model, and `runSeparation` drives a whole run
 * — the Host's bytes, the identity, the decode, the refusals, the wire and the
 * commit — over INJECTED PORTS. Everything platform-bound is a port for one
 * reason: `offscreen/engine.js` owns the AudioContext, the Host and the decks,
 * none of which exist under Node, so a runner that reached for them directly
 * would be a runner nothing could drive. `test.js` group('offline') drives all
 * three with no browser, no Host, no worker and no model.
 */

import { SR, SEGMENT, STEMS, STRIDE, SEAM_XFADE_LAW } from '../shared/config.js';
import { makeFades, readWindow } from './live.js';
import { fileIdFromBytes, fileRefusal, fileCommitRefusal,
  separationRefusal } from '../shared/stemcache.js';

/**
 * How many windows cover `frames`, and the geometry they sit on.
 *
 * FAILS RATHER THAN ROUNDING. A stride at or past the segment leaves gaps between
 * windows — audio no window covers — and the result would be a track with holes in
 * it that still has the right length. That is the shape this project calls
 * silently-stale, so it is a throw and not a clamp.
 */
export function makeOfflinePlan(frames, { segment = SEGMENT, stride = STRIDE } = {}) {
  if (!Number.isInteger(frames) || frames < 0) {
    throw new RangeError(`offline: frames must be a non-negative integer, got ${frames}`);
  }
  if (!(stride > 0 && stride < segment)) {
    throw new RangeError(`offline: stride ${stride} must be in (0, segment ${segment}) — `
      + 'at or past the segment the windows stop overlapping and leave gaps');
  }
  const overlap = segment - stride;
  // `frames <= segment` is one window: the model always sees a whole segment and the
  // tail past the audio is zero-padded, exactly as the live path pads its left.
  const windows = frames === 0 ? 0 : Math.max(1, Math.ceil((frames - segment) / stride) + 1);
  return { frames, segment, stride, overlap, windows };
}

/** Window k's input span. `inputEnd` may run past the track; the read zero-pads. */
export function windowPlan(k, p) {
  if (!Number.isInteger(k) || k < 0 || k >= p.windows) {
    throw new RangeError(`offline: window ${k} is outside the plan's 0..${p.windows - 1}`);
  }
  const inputStart = k * p.stride;
  return {
    k,
    inputStart,
    inputEnd: inputStart + p.segment,
    /** local index where this window's fade-out begins; === stride */
    fadeOutAt: p.stride,
    first: k === 0,
    last: k === p.windows - 1,
  };
}

/**
 * The whole-buffer stand-in for a capture ring, so `readWindow` can be REUSED.
 *
 * `engine/live.js`'s `readWindow` is duck-typed on three members and carries the
 * left zero-pad for a window that starts before frame 0. Re-deriving that pad here
 * is exactly the second copy of the geometry that keeping the runner upstream
 * exists to prevent, so this adapts the buffer to the ring's shape rather than
 * reimplementing the read.
 *
 * @param {Float32Array} l @param {Float32Array} r
 */
export function bufferRing(l, r) {
  const frames = l.length;
  if (r.length !== frames) throw new RangeError(`offline: channels differ — ${frames} vs ${r.length}`);
  return {
    cap: frames,
    writeFrames: () => frames,
    readAt(from, n, dstL, dstR, at) {
      dstL.set(l.subarray(from, from + n), at);
      dstR.set(r.subarray(from, from + n), at);
    },
  };
}

/**
 * Assembles separated windows into one contiguous track.
 *
 * HOLDS THE OUTPUT, NOT THE INPUT. `planes × frames` of Float32 is the same
 * allocation `CacheWriter` already makes for a prime, and unlike the live path
 * there is no consumer reading concurrently — so a window may be written and then
 * partly rewritten by its successor's fade, which is what lets the weights be
 * applied on the way in rather than accumulated and divided afterwards.
 */
export class OfflineAssembler {
  /** @param {ReturnType<makeOfflinePlan>} plan @param {number} planes */
  constructor(plan, planes, law = SEAM_XFADE_LAW) {
    this.p = plan;
    this.law = law;
    const { fi, fo } = makeFades(plan.overlap, law);
    this.fi = fi; this.fo = fo;
    this.out = Array.from({ length: planes }, () => new Float32Array(plan.frames));
    /** The next window this expects, so a skipped or repeated one is named. */
    this.next = 0;
  }

  /**
   * Fold window `k`'s model output in.
   * @param {number} k
   * @param {Float32Array[]} src one plane per output plane, each `segment` long
   */
  add(k, src) {
    const p = this.p;
    if (k !== this.next) {
      throw new RangeError(`offline: window ${k} arrived where ${this.next} was expected — `
        + 'the fade of a join is written by the window that follows it, so they cannot be reordered');
    }
    if (src.length !== this.out.length) {
      throw new RangeError(`offline: ${src.length} planes for a ${this.out.length}-plane assembly`);
    }
    const w = windowPlan(k, p);
    for (let q = 0; q < this.out.length; q++) {
      const s = src[q], d = this.out[q];
      if (s.length < p.segment) {
        throw new RangeError(`offline: plane ${q} of window ${k} holds ${s.length} frames, `
          + `a window is ${p.segment}`);
      }
      for (let i = 0; i < p.segment; i++) {
        const abs = w.inputStart + i;
        if (abs >= p.frames) break;               // the tail past the track is not ours
        let g = 1;
        if (!w.first && i < p.overlap) g = this.fi[i];
        else if (!w.last && i >= w.fadeOutAt) g = this.fo[i - w.fadeOutAt];
        // `+=` only inside a join: everywhere else this window is the only writer,
        // and adding into a buffer a previous window already left at unity would
        // double it.
        if (!w.first && i < p.overlap) d[abs] += s[i] * g;
        else d[abs] = s[i] * g;
      }
    }
    this.next = k + 1;
    return this;
  }

  /**
   * The finished planes. THROWS on a short run rather than returning a shorter
   * track: the plan said how many windows cover the audio, and stopping early
   * leaves the tail as zeros — silence that reads back as part of the song.
   */
  finish() {
    if (this.next !== this.p.windows) {
      throw new RangeError(`offline: ${this.next} of ${this.p.windows} windows folded in — `
        + 'the rest of the track would be silence');
    }
    return this.out;
  }
}

/**
 * DRIVE A WHOLE AHEAD-OF-TIME RUN: read each window, separate it, fold it in.
 *
 * THE MODEL IS AN INJECTED CALLBACK, and that is the design rather than a
 * testing convenience. `separate` is whatever turns one segment of mix into
 * planes — in the product it is `Deck.infer()` through the Host's Backend, and
 * here it can be an identity function. So the loop, the window sequence, the
 * progress and the cancellation are all drivable under plain Node with no
 * Backend, no Host and no worker, which is where they can actually be gated.
 *
 * CANCELLATION IS CHECKED BETWEEN WINDOWS AND NEVER INSIDE ONE. The seam
 * serialises one call per backend (`shared/host.js`) and abandoning a `run()`
 * in flight is the wedge `workers/inference.worker.js` exists to prevent: a
 * rejected concurrent call leaves the session permanently dead, with no error a
 * user can act on and no recovery short of a reload. So a cancel that arrives
 * during a window lets that window finish and stops before the next one.
 *
 * A CANCELLED RUN RETURNS `planes: null`, not a short track. The caller cannot
 * commit what it does not have — which is a stronger guarantee than returning
 * a partial result and trusting every caller to check a flag first. It is the
 * same reason `CacheWriter.abort()` is sticky rather than advisory.
 *
 * `now` IS INJECTED so the timings are arithmetic rather than weather. They are
 * a READOUT — a progress bar — and no assertion should ever gate on a duration
 * measured from a real clock on a shared machine (`AGENTS.md`: a gate whose
 * verdict changes on code that did not change is measuring the machine). With
 * `now` injected, a suite can assert the ETA arithmetic exactly and still read
 * no clock.
 *
 * @param {object} o
 * @param {ReturnType<makeOfflinePlan>} o.plan
 * @param {{cap:number, writeFrames:Function, readAt:Function}} o.ring  see `bufferRing`
 * @param {(mixL:Float32Array, mixR:Float32Array, k:number) => Promise<Float32Array[]>|Float32Array[]} o.separate
 * @param {(p:object) => void} [o.onProgress]
 * @param {() => boolean} [o.cancelled]
 * @param {number} [o.planes] output plane count
 * @param {() => number} [o.now]
 * @returns {Promise<{cancelled:boolean, windows:number, done:number, planes:Float32Array[]|null}>}
 */
export async function runOffline({
  plan, ring, separate, onProgress, cancelled, planes = 2, now = Date.now,
}) {
  // REJECTS RATHER THAN THROWS, because this function is async and there is no
  // way for it to do both. Said out loud so a caller writes `await` around the
  // check rather than a bare try/catch that never fires.
  if (typeof separate !== 'function') {
    throw new TypeError('offline: `separate` must be the function that turns one window of mix '
      + `into planes (got ${typeof separate}) — note this REJECTS, it does not throw synchronously`);
  }
  const asm = new OfflineAssembler(plan, planes);
  const mixL = new Float32Array(plan.segment);
  const mixR = new Float32Array(plan.segment);
  const t0 = now();
  let done = 0;
  for (let k = 0; k < plan.windows; k++) {
    // BEFORE the window, so a cancel that arrived during the previous one is
    // seen here and the backend is never abandoned mid-call.
    if (cancelled && cancelled()) return { cancelled: true, windows: plan.windows, done, planes: null };
    readWindow(ring, windowPlan(k, plan).inputStart, plan.segment, mixL, mixR);
    let out;
    try {
      out = await separate(mixL, mixR, k);
    } catch (e) {
      // Named with the window, because "the model threw" three layers down is
      // the report this project keeps having to reconstruct after the fact.
      throw new Error(`offline: window ${k} of ${plan.windows} failed to separate: `
        + `${String((e && e.message) || e)}`);
    }
    asm.add(k, out);
    done = k + 1;
    if (onProgress) {
      const elapsedMs = now() - t0;
      onProgress({
        stage: 'separate',
        window: done,
        windows: plan.windows,
        pct: done / plan.windows,
        elapsedMs,
        // Linear on windows completed. Honest about what it is: an average so
        // far projected forward, not a prediction. null until there is one
        // window to average over, rather than a division by zero dressed up.
        etaMs: done ? Math.round((elapsedMs / done) * (plan.windows - done)) : null,
      });
    }
  }
  if (cancelled && cancelled()) return { cancelled: true, windows: plan.windows, done, planes: null };
  return { cancelled: false, windows: plan.windows, done, planes: asm.finish() };
}

/* ------------------------------------------------------------------- the wire
 * `SEPARATE_ERROR`'s CODE IS A CLOSED VOCABULARY, DECLARED BEFORE THE FIRST ONE
 * SHIPS. This is #29's lesson applied one message earlier than #29 was.
 *
 * `ARM_ERROR` grew its vocabulary by accident: `ARM_CODES` (`ui/audio-math.js`)
 * is a closed set of eight that nothing checked for a year, five of whose
 * members are tab nouns, and a second Host that invents a plausible-looking code
 * gets a banner the user CANNOT DISMISS with a Restart control that cannot fix
 * it — silent, user-facing, and on the first screen a tester sees. The fix
 * landed in v0.3.0 as a set plus a checker. This message is new, so it gets both
 * on its first day instead.
 *
 * EACH CODE IS A DIFFERENT THING THE RECEIVER CAN DO, which is the only test
 * that keeps a vocabulary from becoming a list of adjectives:
 *
 *   BUSY              wait — this engine is already separating something
 *   GEOMETRY_UNSUPPORTED  the caller asked for a window this build cannot run
 *   SOURCE_UNREADABLE the Host could not hand over the file's bytes
 *   SOURCE_REJECTED   the bytes are not a Source we can key (empty, unhashable)
 *   DECODE_FAILED     the bytes are not audio this platform can decode, or it
 *                     decoded them at a clock that is not the model's
 *   CACHE_FULL        it decoded, and the result does not fit in the tier
 *   CACHE_UNREADABLE  the tier could not be read, so nothing can be sized
 *   SEPARATE_FAILED   the model failed on a window
 *   COMMIT_REFUSED    the run finished and the POLICY refuses the entry
 *   COMMIT_FAILED     the policy said yes and the WRITE failed
 *   CANCELLED         the user stopped it
 *
 * `COMMIT_REFUSED` and `COMMIT_FAILED` are two codes on purpose: one says the
 * separation is not a complete track and re-running will not help, the other
 * says the disk did not take it and re-running might. Collapsing them is how a
 * UI ends up offering Retry for the one thing retrying cannot fix.
 *
 * IT IS A PLAIN `Set`, NOT A FROZEN ONE, and that is not an oversight:
 * `Object.freeze` does not stop `Set.prototype.add`, so freezing it would
 * announce a guarantee the language does not make. What holds the set closed is
 * the assertion in `test.js` that every code this file can emit is a member and
 * that a non-member is reported — same shape as `ARM_CODES`.
 */
export const SEPARATE_CODES = new Set([
  'BUSY', 'GEOMETRY_UNSUPPORTED', 'SOURCE_UNREADABLE', 'SOURCE_REJECTED',
  'DECODE_FAILED', 'CACHE_FULL', 'CACHE_UNREADABLE', 'SEPARATE_FAILED',
  'COMMIT_REFUSED', 'COMMIT_FAILED', 'CANCELLED',
]);

/**
 * IS THIS A CODE THE RECEIVER KNOWS WHAT TO DO WITH? The `SEPARATE_ERROR` half
 * of `checkArmCode` (`ui/audio-math.js`), and deliberately the same shape:
 *
 * IT DOES NOT THROW AND IT DOES NOT CHANGE THE MESSAGE. The run has already
 * failed; replacing its reason with a second failure would take the user's
 * actual problem off the screen. The Host or slice that invented the code is
 * told, loudly, on the console; the user sees what they saw before.
 *
 * IT IS CALLED ON THE SEND SIDE AS WELL AS THE RECEIVE SIDE. `checkArmCode` is a
 * receiver's check because `ARM_ERROR` is a message a HOST originates. This one
 * is originated by the unit, so the unit checks its own: a slice that adds a
 * raise site with a code it did not declare finds out at the first failure it
 * causes rather than at the first banner a user cannot dismiss.
 *
 * @param {string} code
 * @param {string} [where] the entry point that produced it, quoted in the error
 * @returns {null|string} null when legal, otherwise the sentence that was logged
 */
export function checkSeparateCode(code, where = 'SEPARATE_ERROR') {
  if (SEPARATE_CODES.has(code)) return null;
  const msg = `${where}: code ${JSON.stringify(code)} is not one of the ${SEPARATE_CODES.size} `
    + `a receiver knows what to do with — ${[...SEPARATE_CODES].join(', ')}. An unknown code is a `
    + 'failure nothing can offer the user an action for. Pick a member of that set, or add one here.';
  console.error(msg);
  return msg;
}

/**
 * BUILD A `SEPARATE_ERROR`, AND CHECK ITS CODE ON THE WAY OUT.
 *
 * ONE CONSTRUCTION SITE FOR THE WHOLE UNIT, which is what makes the check
 * unavoidable rather than remembered: `runSeparation` raises nine of the ten
 * codes and `offscreen/engine.js` raises `BUSY`, and a raise site that built the
 * envelope by hand would be a raise site the vocabulary does not cover. That is
 * exactly how `ARM_ERROR` spent a year with a closed set nothing consulted.
 *
 * @param {'A'|'B'} deck @param {string} code @param {string} message
 */
export function separateError(deck, code, message) {
  checkSeparateCode(code, 'SEPARATE_ERROR');
  return { type: 'SEPARATE_ERROR', deck, code, message };
}

/**
 * ONE AHEAD-OF-TIME SEPARATION, END TO END: the Host's bytes in, a 32-bit-float
 * cache entry out, and a message on the wire at every stage.
 *
 *   sourceBytes -> SHA-256 identity -> decode at the model clock -> capacity
 *   -> STRIDE-advanced windows through `runOffline` -> CacheWriter -> commit
 *
 * EVERY PLATFORM-BOUND STEP IS A PORT, for the same reason `runOffline` takes
 * the model as a callback: `offscreen/engine.js` owns the AudioContext, the
 * Host and the decks, and none of those can be built under Node — so a runner
 * that reached for them directly would be a runner nothing could drive. What is
 * left here is the ORDER, the refusals and the wire, which is the part that can
 * be wrong in a way no gate downstream would notice.
 *
 * THE ORDER IS THE DESIGN. Each step's cost is roughly ten times the last, so
 * every refusal is placed in front of the first expensive thing it can rule out:
 *
 *   sourceBytes    ~100 MB read           refused by nothing — it is the input
 *   SHA-256        ~1 s on 100 MB         `fileRefusal` refuses AFTER it
 *   decode         seconds, ~500 MB       `separationRefusal` refuses AFTER it
 *   the model      minutes, ~1.7 GB       both refusals are in front of it
 *
 * AND `separationRefusal` IS NOT WHERE THE CONTRACT PUT IT — this is a
 * DELIBERATE DEVIATION, stated here rather than left to be found. The Phase 4
 * contract says it is "checked when SEPARATE_START arrives, before `sourceBytes`
 * is called". Its first argument is the source's DURATION IN SECONDS, and
 * nothing knows that before the decode: the wire message carries a token and a
 * title, the encoded bytes carry a duration only a container parser could reach,
 * and inventing one would be a capacity decision made against a number nobody
 * measured. So it is checked at the first moment it CAN be checked — after the
 * decode, before the model — which keeps the property the refusal exists for
 * (never run the model for an entry that cannot be stored) and drops only the
 * claim about ordering that could not be honoured.
 *
 * THE BYTES ARE READ ONCE AND ONLY ONCE, and `fetchOnce` below is the enforcement
 * rather than the intention. `sourceBytes`' own declaration puts the obligation
 * on the UNIT — "THE UNIT CALLS THIS EXACTLY ONCE PER SOURCE and holds the
 * decoded result for the life of the run" — because a Host is free to mint a
 * ONE-SHOT token, and a second call against a consumed one fails in a way that
 * presents as a corrupt file. A retry loop added here later would be an
 * exception, not a crash, and it would name what it did.
 *
 * ...AND THE PLATFORM ENFORCES THE OTHER HALF. `decodeAudioData` TAKES OWNERSHIP
 * of the buffer and detaches it, so the identity must be taken BEFORE the decode
 * and no later reader can re-hash the file even by mistake. That ordering is not
 * a preference: swap the two lines and `fileIdFromBytes` hashes a detached
 * buffer.
 *
 * PROGRESS RIDES ITS OWN MESSAGE AND NEVER `STATE`. `push()` coalesces on a
 * microtask and ships the whole snapshot, so a per-window tick would either be
 * dropped by the coalescer or drag the full state hundreds of times a track.
 * `state.job`'s five never-written fields are the SHAPE this payload revives;
 * the object itself is retired in `offscreen/engine.js`.
 *
 * `elapsedMs` AND `etaMs` MEASURE DIFFERENT SPANS, on purpose, and it is worth
 * one sentence because a reader will otherwise assume they compose: `elapsedMs`
 * is the whole run, `etaMs` is the SEPARATION's remainder and nothing else. The
 * fetch, the decode and the commit are not in the estimate because nothing here
 * can predict them — a linear average over completed windows is honest about a
 * loop of identical work and would be a guess about anything else. Both are a
 * READOUT. No assertion in this project may gate on either; every one of them
 * reads a count.
 *
 * @param {object} o
 * @param {'A'|'B'} o.deck                     which deck the run belongs to
 * @param {unknown} o.token                    the Host's Source token
 * @param {{title?:string, url?:string}|null} [o.source]
 * @param {number} o.hopSeconds                folded into the key for shape only
 * @param {object} o.cache                     the 32f `StemCache`
 * @param {string|Iterable<string>|null} [o.pins]
 * @param {(token:unknown) => Promise<ArrayBuffer>} o.sourceBytes   the Host duty
 * @param {(bytes:ArrayBuffer) => Promise<{l:Float32Array, r:Float32Array, frames:number, sampleRate:number}>} o.decode
 * @param {(mixL:Float32Array, mixR:Float32Array, k:number) => Promise<Float32Array[]>} o.separate
 * @param {(key:string, meta:object) => {append:Function, abort:Function, commit:Function, frames:number, aborted:boolean}} o.makeWriter
 * @param {(msg:object) => void} o.emit
 * @param {() => boolean} [o.cancelled]
 * @param {() => number} [o.now]
 * @returns {Promise<{ok:boolean, code:string|null, message:string|null, key:string|null, frames:number, seconds:number}>}
 */
export async function runSeparation({
  deck, token, source = null, hopSeconds, cache, pins = null,
  sourceBytes, decode, separate, makeWriter, emit, cancelled, now = Date.now,
}) {
  const t0 = now();
  const say = (stage, window, windows, pct) => emit({
    type: 'SEPARATE_PROGRESS', deck, stage, window, windows, pct,
    elapsedMs: now() - t0, etaMs: null,
  });
  const fail = (code, message) => {
    // Through `separateError`, which is where the code is checked — this
    // function never builds the envelope itself, for the reason stated there.
    emit(separateError(deck, code, message));
    return { ok: false, code, message, key: null, frames: 0, seconds: 0 };
  };
  const why = (e) => String((e && e.message) || e);

  // ---------------------------------------------------------------- 1. fetch
  let read = 0;
  const fetchOnce = async () => {
    /**
     * A ONE-SHOT TOKEN IS A THING A HOST IS ALLOWED TO MINT, so a second call
     * here is not a slow path — it is a failure that arrives dressed as a
     * corrupt file. Named, so that if some future retry is added it announces
     * itself instead of being diagnosed for a day.
     */
    if (read) {
      throw new Error(`offline: sourceBytes was called ${read + 1} times for one Source — `
        + 'a Host may mint a one-shot token, so the second read fails and presents as a corrupt '
        + 'file. Decode once, keep the result, export from the cache.');
    }
    read++;
    return sourceBytes(token);
  };
  say('fetch', 0, 0, 0);
  let bytes;
  try {
    bytes = await fetchOnce();
  } catch (e) {
    return fail('SOURCE_UNREADABLE', `the Host could not hand over this file: ${why(e)}`);
  }

  // ------------------------------------------------- 2. identity, then the key
  let fileId;
  try {
    fileId = await fileIdFromBytes(bytes);
  } catch (e) {
    return fail('SOURCE_UNREADABLE', why(e));
  }
  const whyFile = fileRefusal(fileId, bytes);
  if (whyFile) return fail('SOURCE_REJECTED', whyFile);
  /**
   * THE KEY COMES OFF THE INSTANCE, not from `cacheKey` or `fileIdentity` with a
   * tier argument assembled here. `StemCache.keyFor` folds in the depth and the
   * geometry the instance will actually WRITE, so a key and its bytes cannot
   * disagree — which is the whole reason U2 put the tier on the instance rather
   * than on `put()`.
   */
  const key = cache.keyFor(fileId, hopSeconds);

  // --------------------------------------------------------------- 3. decode
  say('decode', 0, 0, 0);
  let track;
  try {
    track = await decode(bytes);
  } catch (e) {
    return fail('DECODE_FAILED', `this file could not be decoded: ${why(e)}`);
  }
  if (!track || !track.l || !track.r || !(track.frames > 0)) {
    return fail('DECODE_FAILED', 'the decoder produced no audio, and a zero-length track caches '
      + 'as a track that is silently not the track');
  }
  /**
   * FAILS WHEN IT CANNOT LOOK. The decode is documented to happen at the model's
   * clock and the engine's one AudioContext is built at `SR` or refused
   * (`ensureContext`), so this can only fire if a Host wired a second context —
   * which is exactly the case where a silent pass would hand the separator
   * material at the wrong rate and cache it under a key that says otherwise.
   */
  if (track.sampleRate !== SR) {
    return fail('DECODE_FAILED', `this file decoded at ${track.sampleRate} Hz and the model's `
      + `clock is ${SR} Hz — separating it would feed the model material at a rate it has never `
      + 'heard, and cache the result under a key that says otherwise');
  }

  // ---------------------------------------------------- 4. does it fit? (W3)
  const seconds = track.frames / SR;
  let entries;
  try {
    entries = await cache.list();
  } catch (e) {
    return fail('CACHE_UNREADABLE', `the stem tier could not be read, so there is no way to tell `
      + `whether this track fits in it: ${why(e)}`);
  }
  const whyCap = separationRefusal(seconds, entries, cache.maxBytes, pins, cache.depth);
  if (whyCap) return fail('CACHE_FULL', whyCap);

  // ------------------------------------------------------------- 5. the run
  const plan = makeOfflinePlan(track.frames);
  const ring = bufferRing(track.l, track.r);
  const writer = makeWriter(key, {
    fileId,
    title: (source && source.title) || null,
    hopSeconds,
  });
  let res;
  try {
    res = await runOffline({
      plan,
      ring,
      separate,
      cancelled,
      now,
      planes: STEMS.length * 2,
      // Re-stamped with the WHOLE run's elapsed, so one message's `elapsedMs`
      // does not mean something different from the next one's. `etaMs` is left
      // exactly as the runner computed it — see the header.
      onProgress: (p) => emit({ type: 'SEPARATE_PROGRESS', deck, ...p, elapsedMs: now() - t0 }),
    });
  } catch (e) {
    writer.abort();
    return fail('SEPARATE_FAILED', why(e));
  }

  // ------------------------------------------------------------ 6. cancelled
  if (res.cancelled) {
    writer.abort();
    /**
     * `abort()` IS NOT WHAT MAKES THIS LAND NOTHING TODAY, and saying so is the
     * point of this paragraph. MEASURED: delete the `abort()` above and the
     * cancel path still commits nothing, because THIS RUNNER APPENDS ONCE,
     * AFTER the loop — a cancelled run has never called `append`, so
     * `writer.frames` is 0 and `commit()` returns null on that alone.
     *
     * It is still called, and the suite still asserts that the writer comes out
     * ABORTED rather than merely empty, for one reason: the append is a single
     * call only because the assembler holds the whole track, and the moment that
     * changes — a per-window append to bound the memory is the obvious next
     * move — `abort()` becomes the ONLY thing standing between a cancel and a
     * part-separated track under the whole track's key. An assertion that reads
     * "nothing landed" would go on passing right through that change; one that
     * reads `aborted` does not.
     *
     * AND IT GOES THROUGH `commit()` RATHER THAN AROUND IT, so there is exactly
     * one path from this function to the cache. If `abort()` ever stops being
     * sticky, this reports it instead of quietly landing a partial track.
     */
    let landed = null;
    try { landed = await writer.commit(cache); } catch { landed = null; }
    if (landed) {
      return fail('COMMIT_FAILED', 'a cancelled run committed an entry — CacheWriter.abort() is '
        + 'documented as sticky and commit() must return null after it');
    }
    return fail('CANCELLED', 'the separation was cancelled');
  }

  // --------------------------------------------------------------- 7. commit
  /**
   * THE ASSEMBLER'S OUTPUT IS HANDED OVER AND DROPPED IN THE SAME BREATH.
   * `append` copies (`slice(0, len)`), so for the moment both exist the run
   * holds the track twice: ~508 MB per copy for four minutes at six stems, 32f.
   * Releasing the assembler's array here caps that at two rather than three,
   * because `stems()` allocates the third when it concatenates. That is the
   * known whole-track-in-RAM cost `shared/stemcache.js`'s header prices and the
   * Phase 4 contract records as a limitation rather than a discovery — it is not
   * made worse here, and it is not fixed here either.
   */
  const planes = res.planes;
  res.planes = null;
  writer.append(planes, plan.frames);
  planes.length = 0;

  const whyCommit = fileCommitRefusal(writer, { frames: track.frames });
  if (whyCommit) {
    writer.abort();
    return fail('COMMIT_REFUSED', whyCommit);
  }
  say('commit', plan.windows, plan.windows, 1);
  let committed;
  try {
    committed = await writer.commit(cache);
  } catch (e) {
    return fail('COMMIT_FAILED', `the entry could not be written: ${why(e)}`);
  }
  if (!committed) {
    return fail('COMMIT_FAILED', 'the writer had nothing to commit, so no entry was made');
  }
  const frames = committed.frames;
  emit({
    type: 'SEPARATE_DONE',
    deck,
    key,
    frames,
    seconds: +(frames / SR).toFixed(2),
    cache: committed,
  });
  return { ok: true, code: null, message: null, key, frames, seconds: frames / SR };
}
