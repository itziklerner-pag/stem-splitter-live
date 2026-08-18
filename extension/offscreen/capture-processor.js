/**
 * Capture AudioWorklet. Writes the tab's audio into a SharedArrayBuffer ring.
 *
 * HARD RULE (R0, probe/R0-RESULTS.md §"Q4 in detail"): this file must never name
 * `SharedArrayBuffer` and must never read `crossOriginIsolated`. Both identifiers
 * are UNDEFINED in AudioWorkletGlobalScope when the document is not cross-origin
 * isolated, and we deliberately ship without the COOP/COEP manifest keys.
 * The SAB arrives through processorOptions and is used directly.
 *
 * Graph gotcha: Chrome only pulls nodes with a path to ctx.destination, so this
 * node declares one (silent) output which the offscreen document routes through
 * a gain of 0 into the destination.
 */

const HEADER_BYTES = 64;
const TICK_QUANTA = 32;   // 32 * 128 = 4096 frames ~= 92.9 ms

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.cap = o.capacity;
    this.mask = this.cap - 1;
    this.hdr = new Int32Array(o.sab, 0, 16);
    this.l = new Float32Array(o.sab, HEADER_BYTES, this.cap);
    this.r = new Float32Array(o.sab, HEADER_BYTES + this.cap * 4, this.cap);
    this.ticks = 0;
    this.pkL = 0;
    this.pkR = 0;
    this.running = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.running = false; };
  }

  process(inputs) {
    if (!this.running) return false;
    const inp = inputs[0];
    if (!inp || inp.length === 0 || !inp[0]) return true;
    const L = inp[0];
    const R = inp.length > 1 && inp[1] ? inp[1] : inp[0];   // up-mix mono defensively
    const n = L.length;
    const w = Atomics.load(this.hdr, 0);
    const mask = this.mask;
    let pl = this.pkL, pr = this.pkR;
    for (let i = 0; i < n; i++) {
      const idx = (w + i) & mask;
      const a = L[i], b = R[i];
      this.l[idx] = a;
      this.r[idx] = b;
      const aa = a < 0 ? -a : a; if (aa > pl) pl = aa;
      const bb = b < 0 ? -b : b; if (bb > pr) pr = bb;
    }
    Atomics.store(this.hdr, 0, w + n);
    this.pkL = pl; this.pkR = pr;

    if (++this.ticks >= TICK_QUANTA) {
      this.ticks = 0;
      Atomics.store(this.hdr, 3, (pl * 32767) | 0);
      Atomics.store(this.hdr, 4, (pr * 32767) | 0);
      this.pkL = 0; this.pkR = 0;
      this.port.postMessage(w + n);   // the pipeline's only clock
    }
    return true;
  }
}

registerProcessor('tap-capture', CaptureProcessor);
