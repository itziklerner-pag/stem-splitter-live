/**
 * Live mode (Mode 1) — causal trailing window.  Pure arithmetic, no browser APIs,
 * so `node test.js live` exercises every line of it.
 *
 * The design is spike/FINDINGS.md §5, measured in Phase 0 and not re-derived here:
 * ring 7.8 s of PAST audio, run the model on `[t-7.8, t]`, emit only the last
 * `hop` seconds, crossfade the joins. No lookahead of any kind.
 *
 *   chunk k  input window : [ (k+1)·H − L , (k+1)·H )        L = SEGMENT = 343980
 *   chunk k  publishes    : [ k·H − X , (k+1)·H − X )        exactly H frames
 *   chunk 0  publishes    : [ 0 , H − X )                    H − X frames
 *
 * The last X frames of every chunk are *held back* as the crossfade tail for the
 * next chunk, which is what makes this a streaming writer: once a frame is
 * published it is never rewritten, so the playback worklet can be reading the
 * ring concurrently with no lock and no re-visit. (The Phase-0 reference,
 * `spike/src/demucs.js::separateCausal`, rewrites already-emitted samples in
 * place — fine for an offline array, impossible against a live consumer. Same
 * output, different bookkeeping.)
 *
 * Latency, exactly:  a frame is published at wall time (its chunk's input end) +
 * T_inf, and the oldest frame in that publication is H + X frames older, so the
 * playback start offset must be S >= H + X + T_inf for the ring never to run
 * dry. That is the whole latency story; see shared/config.js LIVE_CUSHION_SEC.
 *
 * Startup: `inputStart` is negative for the first ~4 chunks at hop 1.95. Those
 * samples are zero — the model sees silence as its left context and separation
 * quality ramps up over the first 7.8 s (FINDINGS §5 "prime latency note").
 * `primedPct` reports that ramp so the UI can show it.
 */

import { SEGMENT, SR, SEAM_XFADE_MS, SEAM_XFADE_LAW, STEMS, RING_PLANES } from '../shared/config.js';

/**
 * `STEMS.length` stems x 2 channels = 12. Plane index = stem*2 + channel; stem
 * order is STEMS. DERIVED, not a literal: this was 8 before the six-stem
 * widening and the two passthrough planes below sit immediately after it, so a
 * literal here and a literal there is two places to get the same widening wrong.
 */
export const STEM_PLANES = STEMS.length * 2;

/**
 * The passthrough pair — the LAST two planes of the ring, after every stem.
 * `shared/stemring.js` PLANES is the authority for the names; these are the same
 * two indices, derived the same way, and `test.js live` asserts the two agree.
 */
export const PASS_PLANE_L = STEM_PLANES;
export const PASS_PLANE_R = STEM_PLANES + 1;

/**
 * @param {number} hopSeconds
 * @returns {{hopSeconds:number, H:number, X:number, L:number, srcOffset:number, tailOffset:number}}
 */
export function makeLivePlan(hopSeconds, xfadeMs = SEAM_XFADE_MS) {
  const H = Math.round(hopSeconds * SR);
  const X = Math.round((xfadeMs / 1000) * SR);
  if (!(H > 0)) throw new Error(`hop must be positive, got ${hopSeconds}`);
  if (!(X > 0 && X < H)) throw new Error(`crossfade ${X} must be in (0, hop ${H})`);
  if (H + X > SEGMENT) throw new Error(`hop ${H} + crossfade ${X} exceeds the segment ${SEGMENT}`);
  return {
    hopSeconds, H, X, L: SEGMENT,
    /** where chunk k>0's published span starts inside the model output */
    srcOffset: SEGMENT - H - X,
    /** where the held-back tail starts inside the model output */
    tailOffset: SEGMENT - X,
  };
}

/**
 * Chunk k's geometry. All frame numbers are absolute, counted from the frame at
 * which live mode started (which is also the capture ring's own frame clock).
 */
export function chunkPlan(k, p) {
  const inputEnd = (k + 1) * p.H;
  const emitFrom = k === 0 ? 0 : k * p.H - p.X;
  const emitTo = inputEnd - p.X;
  return {
    k,
    inputStart: inputEnd - p.L,        // negative early on => zero-pad the left
    inputEnd,
    emitFrom,
    emitTo,
    emitLen: emitTo - emitFrom,        // H, except H - X for k = 0
    srcOffset: emitFrom - (inputEnd - p.L),
    xfade: k === 0 ? 0 : p.X,
  };
}

/**
 * Crossfade ramps of length n.
 *
 * 'linear'     : fi + fo   = 1  — correct for coherent material (the two chunks
 *                are two estimates of the same audio). This is what upstream
 *                Demucs uses and what ARCHITECTURE §3.6 / AUDIO.md §2.4 require.
 * 'equalPower' : fi² + fo² = 1  — correct for *uncorrelated* material; on
 *                coherent material it produces +3.01 dB in the middle of the join.
 *
 * Ramps are half-sample centred ((i+0.5)/n) so the pair is symmetric and both
 * ends of the fade are strictly inside (0,1) — an integer ramp leaves
 * fo[n-1] = sqrt(1/n) ≠ 0, i.e. a step at the end of every crossfade.
 */
export function makeFades(n, law = SEAM_XFADE_LAW) {
  const fi = new Float32Array(n), fo = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    if (law === 'equalPower') { fi[i] = Math.sqrt(u); fo[i] = Math.sqrt(1 - u); }
    else { fi[i] = u; fo[i] = 1 - u; }
  }
  return { fi, fo };
}

/**
 * Turns a stream of model outputs into a contiguous stream of publishable frames
 * across RING_PLANES (14) planes: 12 stem planes
 * (drums/bass/other/vocals/guitar/piano x L/R) and 2 passthrough planes (the
 * original mix, used only when a chunk is skipped).
 *
 * Every call returns the SAME scratch planes, all written with the SAME `from`
 * and `len` — which is how stem sample-alignment is guaranteed structurally
 * rather than by inspection (docs/AUDIO.md §8.1: Δ must be 0). `test.js live`
 * asserts it with an impulse.
 */
export class LiveEmitter {
  /** @param {ReturnType<makeLivePlan>} plan */
  constructor(plan, law = SEAM_XFADE_LAW) {
    this.p = plan;
    this.law = law;
    const { fi, fo } = makeFades(plan.X, law);
    this.fi = fi; this.fo = fo;
    // The stems<->passthrough transition is between the mix and (approximately)
    // the sum of the stems, i.e. provably the same signal — always linear.
    const lin = makeFades(plan.X, 'linear');
    this.li = lin.fi; this.lo = lin.fo;

    /** STEM_PLANES x X held-back crossfade tails from the previous chunk */
    this.tail = Array.from({ length: STEM_PLANES }, () => new Float32Array(plan.X));
    this.haveTail = false;
    /** true while the passthrough plane is carrying the audio */
    this.passActive = false;

    /** scratch: RING_PLANES planes of H frames (the largest publication) */
    this.planes = Array.from({ length: RING_PLANES }, () => new Float32Array(plan.H));
    this.commit = 0;   // next absolute frame to publish
  }

  /**
   * Publish chunk k.
   * @param {number} k
   * @param {Float32Array[]} src STEM_PLANES planes of length L, from one model forward pass
   * @param {Float32Array} mixL absolute [emitFrom, emitTo) of the captured mix
   * @param {Float32Array} mixR same
   * @returns {{from:number, len:number, planes:Float32Array[]}}
   */
  chunk(k, src, mixL, mixR) {
    const p = this.p, c = chunkPlan(k, p), X = p.X, len = c.emitLen;
    if (c.emitFrom !== this.commit) {
      throw new Error(`live: chunk ${k} starts at ${c.emitFrom}, expected ${this.commit}`);
    }
    // Stems: crossfade the first X frames against whatever precedes them.
    //   normal join  -> previous chunk's held tail (this.law)
    //   after a gap  -> silence, i.e. fade the stems in while the passthrough
    //                   plane fades out over exactly the same X frames (linear)
    //   chunk 0      -> nothing precedes; straight copy
    const xf = c.xfade > 0 && (this.haveTail || this.passActive) ? X : 0;
    const fi = this.passActive ? this.li : this.fi;
    const fo = this.fo;
    for (let q = 0; q < STEM_PLANES; q++) {
      const s = src[q], d = this.planes[q], t = this.tail[q];
      const o = c.srcOffset;
      if (xf === 0) {
        for (let i = 0; i < len; i++) d[i] = s[o + i];
      } else if (this.passActive) {
        for (let i = 0; i < xf; i++) d[i] = s[o + i] * fi[i];
        for (let i = xf; i < len; i++) d[i] = s[o + i];
      } else {
        for (let i = 0; i < xf; i++) d[i] = t[i] * fo[i] + s[o + i] * fi[i];
        for (let i = xf; i < len; i++) d[i] = s[o + i];
      }
      // hold back the last X frames of the model output for the next join
      t.set(s.subarray(p.tailOffset, p.tailOffset + X));
    }
    // Passthrough: silent, except while fading out of a skipped span.
    const pl = this.planes[PASS_PLANE_L], pr = this.planes[PASS_PLANE_R];
    pl.fill(0, 0, len); pr.fill(0, 0, len);
    if (this.passActive) {
      for (let i = 0; i < xf; i++) { pl[i] = mixL[i] * this.lo[i]; pr[i] = mixR[i] * this.lo[i]; }
      this.passActive = false;
    }
    this.haveTail = true;
    this.commit = c.emitTo;
    return { from: c.emitFrom, len, planes: this.planes };
  }

  /**
   * Publish `len` frames of unseparated audio because the chunk that should have
   * covered them was skipped (backpressure L2). Never silence — the user keeps
   * hearing the music, in sync, with the stem faders temporarily inert.
   *
   * @param {number} len frames, <= plan.H
   * @param {Float32Array} mixL absolute [commit, commit+len) of the captured mix
   * @param {Float32Array} mixR same
   */
  gap(len, mixL, mixR) {
    const p = this.p, X = p.X;
    if (len > p.H) throw new Error(`live: gap ${len} exceeds one hop ${p.H}`);
    const entering = !this.passActive;
    const xf = entering && this.haveTail ? Math.min(X, len) : 0;
    for (let q = 0; q < STEM_PLANES; q++) {
      const d = this.planes[q], t = this.tail[q];
      // run the held tail out under a linear fade, then silence
      for (let i = 0; i < xf; i++) d[i] = t[i] * this.lo[i];
      d.fill(0, xf, len);
    }
    const pl = this.planes[PASS_PLANE_L], pr = this.planes[PASS_PLANE_R];
    for (let i = 0; i < xf; i++) { pl[i] = mixL[i] * this.li[i]; pr[i] = mixR[i] * this.li[i]; }
    for (let i = xf; i < len; i++) { pl[i] = mixL[i]; pr[i] = mixR[i]; }
    this.passActive = true;
    this.haveTail = false;      // the tail has been spent; do not reuse it
    const from = this.commit;
    this.commit += len;
    return { from, len, planes: this.planes };
  }
}

/**
 * Read absolute frames [from, from+n) of the mix out of the capture ring into a
 * chunk-sized buffer, zero-filling anything before frame 0 (startup) and
 * anything the ring has already overwritten (should never happen: the ring holds
 * 23.78 s and the deepest read is 7.8 s).
 *
 * Returns false if any part of the range was lost, so the caller can count it
 * rather than silently separating stale audio.
 */
export function readWindow(ring, from, n, dstL, dstR) {
  dstL.fill(0, 0, n); dstR.fill(0, 0, n);
  const lo = Math.max(0, from);
  const hi = Math.min(ring.writeFrames(), from + n);
  if (hi <= lo) return from + n <= 0;
  const oldest = ring.writeFrames() - ring.cap;
  const ok = lo >= oldest;
  const start = Math.max(lo, oldest);
  if (hi > start) ring.readAt(start, hi - start, dstL, dstR, start - from);
  return ok;
}

/**
 * The backpressure L2 decision, as pure arithmetic so it can be driven against a
 * simulated clock instead of a GPU (`node test.js live`).
 *
 * Returns the number of frames to publish from the input ring's retained
 * history (passthrough) because chunk `k` cannot be delivered in time, or 0 to
 * carry on. Two triggers:
 *
 *   behind   — the capture clock has run a full hop past the window we were
 *              about to process. That chunk can never be on time.
 *   starving — the playhead is about to catch the write pointer. THIS is the
 *              load-bearing one at high utilisation: at RTF ~0.85 the schedule
 *              never falls a whole hop behind, it just bleeds the cushion a few
 *              tens of ms per chunk until the worklet runs dry. Measured on an
 *              M2 Max at hop 1.0 s: 1 underrun / 22 ms of silence in 35 s with
 *              only `behind`; none with both.
 *
 * The caller may act on this while a chunk is still in flight — a passthrough
 * fill is a memcpy and does not need the worker — and must then discard that
 * chunk when it lands. That is what makes "skip the late chunk" arrive in time
 * to be useful.
 */
export function skipFrames({ cap, commit, plan, k, playing, cushion, lowWater }) {
  const c = chunkPlan(k, plan);
  const behind = cap - c.inputEnd >= plan.H;
  const starving = playing && cushion < lowWater;
  if (!behind && !starving) return 0;
  // never fill audio we have not captured, and never re-fill a filled span
  if (c.emitTo > cap || c.emitTo <= commit) return 0;
  return c.emitTo - commit;
}

/** Seconds of real (non-zero-padded) history the model is seeing. 0..1. */
export const primedPct = (capturedFrames) => Math.min(1, capturedFrames / SEGMENT);
