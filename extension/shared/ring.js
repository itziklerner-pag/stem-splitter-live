/**
 * Single-producer (AudioWorklet) / single-consumer (offscreen main thread)
 * lock-free stereo ring over a SharedArrayBuffer. No Atomics.wait anywhere.
 *
 * Layout
 *   byte 0..63   Int32 header, 16 slots
 *                  [0] writeFrames  monotonic, producer only
 *                  [1] readFrames   monotonic, consumer only
 *                  [2] capacity     (frames, power of two)
 *                  [3] peakL_q15    producer publishes; no messaging
 *                  [4] peakR_q15
 *   byte 64..    Float32 plane L (capacity floats), then plane R
 *
 * NOTE (R0): AudioWorkletGlobalScope does NOT define `SharedArrayBuffer` or
 * `crossOriginIsolated` when the document is not cross-origin isolated — and we
 * deliberately are not. The worklet side therefore lives in
 * offscreen/capture-processor.js and never names either identifier; it takes the
 * SAB through processorOptions and goes straight to `new Float32Array(sab, off)`.
 *
 * ponytail: the frame counters are Int32 and monotonic, so they wrap after
 * 2^31 frames = 13 h 32 m of continuous capture at 44100 Hz. Past that,
 * `writeFrames` goes negative and every derived quantity (available, cushion,
 * absolute reads) is garbage. Irrelevant for a DJ set, real for a long stream.
 * Upgrade path: keep the Int32 slot as the low half and add a wrap counter in
 * an adjacent slot, or rebase both indices on a chunk boundary when the write
 * index passes 2^30. Do NOT switch to Float64 in the header — the release/
 * acquire pair depends on Atomics, and Atomics do not work on Float64Array.
 */

import { RING_FRAMES, RING_HEADER_BYTES } from './config.js';

export function ringByteLength(capacity = RING_FRAMES) {
  return RING_HEADER_BYTES + capacity * 4 * 2;
}

export class RingConsumer {
  /** @param {SharedArrayBuffer} sab */
  constructor(sab, capacity = RING_FRAMES) {
    this.sab = sab;
    this.cap = capacity;
    this.mask = capacity - 1;
    this.hdr = new Int32Array(sab, 0, 16);
    this.l = new Float32Array(sab, RING_HEADER_BYTES, capacity);
    this.r = new Float32Array(sab, RING_HEADER_BYTES + capacity * 4, capacity);
    Atomics.store(this.hdr, 0, 0);
    Atomics.store(this.hdr, 1, 0);
    Atomics.store(this.hdr, 2, capacity);
  }

  writeFrames() { return Atomics.load(this.hdr, 0); }
  readFrames() { return Atomics.load(this.hdr, 1); }
  available() { return this.writeFrames() - this.readFrames(); }
  /** true if the producer lapped us — capture is then not lossless */
  overflowed() { return this.available() > this.cap; }
  peaks() {
    return [Atomics.load(this.hdr, 3) / 32767, Atomics.load(this.hdr, 4) / 32767];
  }

  /**
   * NON-DESTRUCTIVE absolute read — live mode's window into the past.
   *
   * The export path drains the ring; live mode must not, because every chunk
   * re-reads the last 7.8 s (the causal trailing window, spike/FINDINGS.md §5)
   * and because a skipped chunk is filled from this same retained history. So
   * live mode never calls drain(): it reads by absolute frame number and lets
   * the producer lap the tail naturally.
   *
   * The caller is responsible for checking the range is still resident
   * (`from >= writeFrames() - cap`); engine/live.js::readWindow does that and
   * zero-fills what is missing.
   *
   * @param {number} from absolute frame
   * @param {number} n frames
   * @param {Float32Array} dstL @param {Float32Array} dstR
   * @param {number} dstOff
   */
  readAt(from, n, dstL, dstR, dstOff = 0) {
    const start = from & this.mask;
    const first = Math.min(n, this.cap - start);
    dstL.set(this.l.subarray(start, start + first), dstOff);
    dstR.set(this.r.subarray(start, start + first), dstOff);
    if (n > first) {
      dstL.set(this.l.subarray(0, n - first), dstOff + first);
      dstR.set(this.r.subarray(0, n - first), dstOff + first);
    }
  }

  /**
   * Copy every unread frame out. Returns null when there is nothing.
   * @returns {{l:Float32Array, r:Float32Array, dropped:number}|null}
   */
  drain() {
    const w = this.writeFrames();
    let rd = this.readFrames();
    let n = w - rd;
    if (n <= 0) return null;
    let dropped = 0;
    if (n > this.cap) { dropped = n - this.cap; rd = w - this.cap; n = this.cap; }
    const l = new Float32Array(n), r = new Float32Array(n);
    const start = rd & this.mask;
    const first = Math.min(n, this.cap - start);
    l.set(this.l.subarray(start, start + first), 0);
    r.set(this.r.subarray(start, start + first), 0);
    if (n > first) {
      l.set(this.l.subarray(0, n - first), first);
      r.set(this.r.subarray(0, n - first), first);
    }
    Atomics.store(this.hdr, 1, w);
    return { l, r, dropped };
  }
}
