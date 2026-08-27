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
 */

import { SEGMENT, STRIDE, SEAM_XFADE_LAW } from '../shared/config.js';
import { makeFades, readWindow } from './live.js';

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
