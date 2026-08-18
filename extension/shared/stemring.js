/**
 * Playback ring — single producer (offscreen main thread, one hop at a time),
 * single consumer (the playback AudioWorklet, 128 frames at a time). Lock-free,
 * no Atomics.wait.
 *
 * All fourteen planes share ONE ring and ONE pair of indices. That is the whole
 * sample-alignment guarantee (docs/AUDIO.md §8.1: Δ between stems must be 0, a
 * 4-sample skew combs at 5.5 kHz): there is no per-stem write pointer that could
 * drift, and `write()` refuses a non-contiguous `from`.
 *
 * Layout
 *   byte 0..127   Int32 header, 32 slots
 *                   [0] writeFrames    monotonic, producer only
 *                   [1] readFrames     monotonic, consumer only
 *                   [2] capacity       (frames, power of two)
 *                   [3] play           0 = hold silence, 1 = consume
 *                   [4] underruns      consumer only
 *                   [5] underrunFrames consumer only
 *   byte 128..    RING_PLANES (14) x Float32 planes of `capacity` frames, in
 *                 PLANE order.
 *
 * NOTE: this module is imported by the offscreen document and by node (test.js).
 * It is NOT imported by the worklet — AudioWorkletGlobalScope does not define
 * `SharedArrayBuffer`, so the worklet reconstructs the same views from the raw
 * buffer it receives through processorOptions. The offsets are duplicated there
 * and asserted equal in test.js.
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

import { STEM_RING_FRAMES, STEM_RING_HEADER_BYTES, RING_PLANES } from './config.js';

/**
 * Plane order. Stems first, in model order (`STEMS`), then the passthrough mix.
 * Plane index = `stemIdx * 2 + ch`; passthrough is the LAST pair, so it moved
 * from 8/9 to 12/13 when the model widened to six stems. Anything that hard-codes
 * the passthrough index rather than deriving it from `PLANES.length - 2` is a
 * defect waiting for the next widening.
 */
export const PLANES = [
  'drums.L', 'drums.R', 'bass.L', 'bass.R', 'other.L', 'other.R',
  'vocals.L', 'vocals.R', 'guitar.L', 'guitar.R', 'piano.L', 'piano.R',
  'pass.L', 'pass.R',
];

export const H_WRITE = 0, H_READ = 1, H_CAP = 2, H_PLAY = 3, H_UNDERRUNS = 4, H_UNDERFRAMES = 5;

export function stemRingByteLength(capacity = STEM_RING_FRAMES) {
  return STEM_RING_HEADER_BYTES + capacity * 4 * RING_PLANES;
}

export class StemRingWriter {
  /** @param {SharedArrayBuffer} sab */
  constructor(sab, capacity = STEM_RING_FRAMES) {
    if ((capacity & (capacity - 1)) !== 0) throw new Error('capacity must be a power of two');
    this.sab = sab;
    this.cap = capacity;
    this.mask = capacity - 1;
    this.hdr = new Int32Array(sab, 0, 32);
    this.planes = [];
    for (let q = 0; q < RING_PLANES; q++) {
      this.planes.push(new Float32Array(sab, STEM_RING_HEADER_BYTES + q * capacity * 4, capacity));
    }
    this.overruns = 0;
    this.reset();
  }

  reset() {
    for (let q = 0; q < RING_PLANES; q++) this.planes[q].fill(0);
    Atomics.store(this.hdr, H_WRITE, 0);
    Atomics.store(this.hdr, H_READ, 0);
    Atomics.store(this.hdr, H_CAP, this.cap);
    Atomics.store(this.hdr, H_PLAY, 0);
    Atomics.store(this.hdr, H_UNDERRUNS, 0);
    Atomics.store(this.hdr, H_UNDERFRAMES, 0);
  }

  writeFrames() { return Atomics.load(this.hdr, H_WRITE); }
  readFrames() { return Atomics.load(this.hdr, H_READ); }
  /** frames of finished audio the consumer has not played yet — THE health number */
  cushion() { return this.writeFrames() - this.readFrames(); }
  underruns() { return Atomics.load(this.hdr, H_UNDERRUNS); }
  underrunFrames() { return Atomics.load(this.hdr, H_UNDERFRAMES); }
  play(on) { Atomics.store(this.hdr, H_PLAY, on ? 1 : 0); }
  playing() { return Atomics.load(this.hdr, H_PLAY) === 1; }

  /**
   * @param {number} from absolute frame — must equal writeFrames (contiguity)
   * @param {Float32Array[]} src RING_PLANES planes, each with >= len valid frames
   * @param {number} len
   * @returns {boolean} false if the write would lap the consumer (counted as an
   *          overrun and dropped rather than corrupting frames being read)
   */
  write(from, src, len) {
    const w = this.writeFrames();
    if (from !== w) throw new Error(`stem ring: non-contiguous write at ${from}, expected ${w}`);
    if (src.length !== RING_PLANES) throw new Error(`stem ring: expected ${RING_PLANES} planes, got ${src.length}`);
    if (len > this.cap) throw new Error(`stem ring: ${len} frames exceeds capacity ${this.cap}`);
    if (w - this.readFrames() + len > this.cap) { this.overruns++; return false; }

    const start = w & this.mask;
    const first = Math.min(len, this.cap - start);
    for (let q = 0; q < RING_PLANES; q++) {
      const d = this.planes[q], s = src[q];
      d.set(s.subarray(0, first), start);
      if (len > first) d.set(s.subarray(first, len), 0);
    }
    Atomics.store(this.hdr, H_WRITE, w + len);   // release: publishes all RING_PLANES planes at once
    return true;
  }
}
