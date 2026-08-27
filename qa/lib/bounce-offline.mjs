/**
 * THE OFFLINE-RENDER HARNESS - the first one in this repository.
 *
 * There is no other. Before this file, `OfflineAudioContext` and
 * `startRendering` appeared nowhere under tools/ or qa/, and the playback
 * worklet's `process()` was driven headlessly from exactly one place -
 * extension/engine/pitchbank.js section 7, which boots the shipped file in a vm
 * realm and pumps it at the render quantum. This is that same mechanism, widened
 * from "pump N quanta" to "be an OfflineAudioContext", so the SHIPPED bounce
 * path in extension/offscreen/bounce.js can be driven end to end without a
 * browser and without the machine-global browser mutex.
 *
 * ------------------------------------------------------- WHAT IT REALLY DRIVES
 *
 * Everything in the bounce that is ours:
 *
 *   the ring producer      offscreen/bounce.js's fill(), against the real
 *                          StemRingWriter and the real contiguity refusal
 *   the refill schedule    engine/bounce.js's plan, consumed by the real
 *                          suspend/resume loop rather than by a rehearsal of it
 *   the DSP                offscreen/playback-processor.js, byte for byte, the
 *                          file the browser runs - transpose, per-sample gain
 *                          ramps, crossfader, sum, starvation fade, meter tap
 *   the deliverable        shared/wav.js's WavStreamEncoder into a fake sink
 *
 * ---------------------------------------------------------- WHAT IT CANNOT SEE
 *
 * Chromium's own OfflineAudioContext honouring the schedule. That was measured
 * separately (offscreen/bounce.js's header lists the four measurements, 3/3 on
 * the suspend/resume one) and it is NOT re-measured here. A green qa/bounce.mjs
 * is evidence about this project's code, not about the browser's.
 *
 * It is also, deliberately, STRICTER than Chromium in one place: Chromium ROUNDS
 * a suspension time to the nearest render quantum, and this refuses one that is
 * not already aligned. A plan whose stops land between quanta would work in the
 * browser and be undescribable by engine/bounce.js's arithmetic, which is the
 * kind of agreement that decays silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/** The Web Audio render quantum. Fixed by the specification. */
export const QUANTUM = 128;

/**
 * Boot one AudioWorklet module in a fresh realm.
 *
 * A FRESH REALM PER CONTEXT, WHICH IS A FRESH PROCESSOR PER RENDER. The
 * transpose lanes, the gain slots and the starvation state all live in processor
 * instance fields, so two renders sharing a realm would share nothing dangerous
 * - but two renders sharing a PROCESSOR would carry the first one's 3072 samples
 * of held audio into the second's head. One context, one realm, one processor.
 */
function bootModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  const registry = new Map();
  const sandbox = {
    sampleRate: 44100,
    currentTime: undefined,
    registerProcessor: (name, cls) => { registry.set(name, cls); },
    AudioWorkletProcessor: class {
      constructor() {
        const self = this;
        this.port = {
          onmessage: null,
          postMessage(m) { if (self._outbound) self._outbound(m); },
        };
      }
    },
    Atomics, Math, Number, Object, Array, String, Boolean, JSON, Symbol, Error, RangeError, TypeError,
    Float32Array, Float64Array, Int8Array, Int16Array, Int32Array,
    Uint8Array, Uint16Array, Uint32Array, DataView, ArrayBuffer, SharedArrayBuffer,
    isFinite, isNaN, parseInt, parseFloat, console,
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: file }).runInContext(sandbox);
  if (registry.size === 0) {
    throw new Error(`offline harness: ${path.basename(file)} registered no processor - `
      + 'the module ran and defined nothing, which is a load failure wearing a green tick');
  }
  return registry;
}

/**
 * An OfflineAudioContext that renders by pumping the processors it was given,
 * one render quantum at a time, and that honours suspend(t)/resume() at exact
 * quantum boundaries.
 *
 * THE PROPERTY THE WHOLE BOUNCE DESIGN RESTS ON is that samples written DURING a
 * suspension are in the output. It holds here for the same structural reason it
 * holds in Chromium: nothing renders while a suspension is outstanding, so a
 * producer that writes into the ring during one is writing ahead of a read
 * pointer that is not moving.
 */
class FakeOfflineContext {
  constructor(numberOfChannels, length, sampleRate, extDir) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = { channelCount: numberOfChannels };
    this.audioWorklet = { addModule: (file) => this._addModule(file) };
    this._extDir = extDir;
    this._registry = new Map();
    this._nodes = [];
    this._suspends = new Map();
    this._current = null;
    this._rendered = false;
    /** Every suspension the render actually stopped at. An independence check. */
    this.stoppedAt = [];
  }

  async _addModule(file) {
    for (const [name, cls] of bootModule(file)) this._registry.set(name, cls);
  }

  /** The `audio.workletNode` seam offscreen/bounce.js takes. */
  makeNode(name, options = {}) {
    const Cls = this._registry.get(name);
    if (!Cls) {
      throw new Error(`offline harness: no processor named ${JSON.stringify(name)} is registered - `
        + `known: ${[...this._registry.keys()].join(', ') || '(none)'}`);
    }
    const proc = new Cls({ processorOptions: options.processorOptions || {} });
    const posted = [];
    const node = {
      proc,
      posted,
      port: {
        onmessage: null,
        postMessage(m) {
          if (typeof proc.port.onmessage !== 'function') {
            throw new Error('offline harness: the processor never installed a port.onmessage, '
              + 'so every setting this bounce posted went nowhere');
          }
          proc.port.onmessage({ data: m });
        },
      },
      connect: (dst) => { node._connected = dst; return dst; },
      disconnect: () => { node._connected = null; },
    };
    proc._outbound = (m) => { posted.push(m); if (node.port.onmessage) node.port.onmessage({ data: m }); };
    this._nodes.push(node);
    return node;
  }

  suspend(seconds) {
    const exact = seconds * this.sampleRate;
    const frame = Math.round(exact);
    if (Math.abs(exact - frame) > 1e-6 || frame % QUANTUM !== 0) {
      return Promise.reject(new RangeError(`offline harness: suspend(${seconds}) is frame ${exact}, `
        + `which is not a whole multiple of the ${QUANTUM}-frame render quantum`));
    }
    if (frame <= 0 || frame >= this.length) {
      return Promise.reject(new RangeError(`offline harness: suspend(${seconds}) is frame ${frame}, `
        + `outside the render's 1..${this.length - 1}`));
    }
    if (this._suspends.has(frame)) {
      return Promise.reject(new Error(`offline harness: a suspension is already scheduled at frame ${frame}`));
    }
    let reached, release;
    const at = new Promise((res) => { reached = res; });
    const resumed = new Promise((res) => { release = res; });
    this._suspends.set(frame, { frame, reached, resumed, release });
    return at;
  }

  resume() {
    if (!this._current) return Promise.resolve();
    const s = this._current;
    this._current = null;
    s.release();
    return Promise.resolve();
  }

  async startRendering() {
    if (this._rendered) throw new Error('offline harness: startRendering() twice on one context');
    this._rendered = true;
    if (this._nodes.length !== 1) {
      throw new Error(`offline harness: ${this._nodes.length} nodes are connected; this harness sums `
        + 'nothing, so a bounce that built a second source node would be silently half-rendered');
    }
    const node = this._nodes[0];
    const L = new Float32Array(this.length);
    const R = new Float32Array(this.length);
    const qL = new Float32Array(QUANTUM), qR = new Float32Array(QUANTUM);
    const outs = [[qL, qR]];
    const quanta = Math.ceil(this.length / QUANTUM);
    for (let q = 0; q < quanta; q++) {
      const frame = q * QUANTUM;
      this.currentTime = frame / this.sampleRate;
      const s = this._suspends.get(frame);
      if (s) {
        this._current = s;
        this.stoppedAt.push(frame);
        s.reached();
        await s.resumed;
      }
      qL.fill(0); qR.fill(0);
      node.proc.process([], outs);
      const n = Math.min(QUANTUM, this.length - frame);
      L.set(qL.subarray(0, n), frame);
      R.set(qR.subarray(0, n), frame);
    }
    this.currentTime = this.length / this.sampleRate;
    return {
      numberOfChannels: 2,
      length: this.length,
      sampleRate: this.sampleRate,
      getChannelData: (i) => (i === 0 ? L : R),
    };
  }
}

/**
 * The pair offscreen/bounce.js takes as `audio`, plus the `assetUrl` resolver a
 * Host would supply, plus a handle on the last context so a suite can read the
 * stops it really made.
 *
 * @param {string} extDir absolute path to `extension/`
 */
export function makeOfflineHarness(extDir) {
  const h = {
    /** the last context built, for the independence checks */
    last: null,
    assetUrl: (rel) => path.join(extDir, rel),
    audio: {
      offlineContext: (channels, length, sampleRate) => {
        h.last = new FakeOfflineContext(channels, length, sampleRate, extDir);
        return h.last;
      },
      workletNode: (ctx, name, options) => ctx.makeNode(name, options),
    },
  };
  return h;
}

/**
 * A `WritableStream`-shaped sink that keeps the bytes, so a suite can read a
 * deliverable back without OPFS, a dialog or a disk.
 *
 * `WavStreamEncoder.pipeTo` calls getWriter/write/close/abort/releaseLock, and
 * ABORTS rather than closes on a refusal - the sink records which of the two
 * happened, because "the file is not a file" is the claim that separates a
 * cancelled bounce from a truncated one.
 */
export function makeFakeSink() {
  const chunks = [];
  const state = { closed: false, aborted: null, chunks };
  const writable = {
    getWriter: () => ({
      write: async (u8) => { chunks.push(u8.slice()); },
      close: async () => { state.closed = true; },
      abort: async (e) => { state.aborted = e; },
      releaseLock: () => {},
    }),
  };
  state.writable = writable;
  state.bytes = () => {
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  };
  return state;
}
