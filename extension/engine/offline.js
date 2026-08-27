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
import { makeFades } from './live.js';

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
