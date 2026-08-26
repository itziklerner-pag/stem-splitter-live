/**
 * The ONE master bus. Both decks sum into it; it is the only path to
 * `ctx.destination`.
 *
 *   deckA.playbackNode ─┐
 *                       ├─> meter ─> pre(1/H) ─> softClip ─> post(H) ─> destination
 *   deckB.playbackNode ─┘                                       └─> analyser (probe)
 *
 * Why it is shared rather than one chain per deck: a soft clipper per deck
 * cannot protect the sum. Two decks each peaking at 0.9 sum to 1.8 and each
 * deck's own clipper sees 0.9 and does nothing, so the only thing between the
 * mix and the DAC's hard clip would be luck. One clipper on the sum is also the
 * only place a master meter means anything (see master-meter-processor.js).
 *
 * Everything about the clipper itself is unchanged from Mode 1 and is
 * docs/AUDIO.md §4.3: a WaveShaper with 4x oversampling, NOT a
 * DynamicsCompressorNode, wrapped in the ±headroom gain pair because the
 * WaveShaper curve domain is fixed to [-1, 1] and we need to cover +6 dBFS.
 *
 * LivePipeline holds references to `pre`/`shaper`/`post`/`probe` so that every
 * Mode 1 gate that reads them off "the deck's graph" keeps working unchanged.
 * Ownership lives here; the deck only borrows.
 */

import { softClipCurve } from '../engine/mixer.js';
import { METER_HZ } from '../shared/config.js';

export class MasterBus {
  /**
   * @param {AudioContext} ctx  null at construction; see below
   * @param {(relPath: string) => string} assetUrl  the Host's asset resolver
   *
   * TWO DEPENDENCIES, ARRIVING AT TWO DIFFERENT TIMES, AND THAT IS THE WHOLE
   * REASON `assetUrl` IS A CONSTRUCTOR ARGUMENT.
   *
   * The bus is built at `offscreen/engine.js` module scope, where there is no
   * AudioContext yet — creating one at import would start hardware nobody has
   * asked for — so `ctx` is handed over later, at `ensureContext()`. `assetUrl`
   * is NOT in that position: the Host is imported before anything in this file
   * runs, and the resolver is synchronous by contract (`shared/host.js`)
   * precisely so that a constructor which runs before there is a context to
   * await on can still take it.
   *
   * So it is required here rather than assigned beside `master.ctx = c`. A late
   * setter would put the two on the same footing and make them look like the
   * same kind of dependency.
   *
   * WHAT THE REFUSAL ACTUALLY CATCHES, since it is not a short Host: a Host
   * whose `assetUrl` is missing or not callable is already refused by
   * `assertHost(host, ENGINE_HOST_DUTIES)`, which `engine.js` runs before it
   * builds anything. What is left — and what this throw is for — is the WIRING:
   * a future edit to `engine.js` that reverts to a late setter, or that
   * constructs the bus without threading the resolver through. That failure has
   * no other alarm, because a bus built without one reports nothing at boot and
   * then throws inside `_build()`, at the first arm, with a deck already
   * half-wired. It is the same hand-off gap the two decks now refuse in their
   * own constructors.
   */
  constructor(ctx, assetUrl) {
    if (typeof assetUrl !== 'function') {
      throw new TypeError('MasterBus needs the Host\'s assetUrl at construction — it resolves '
        + '`offscreen/master-meter-processor.js` in _build(), which is far too late to find out '
        + `it is missing (got ${assetUrl === null ? 'null' : typeof assetUrl}).`);
    }
    this.ctx = ctx;
    /** the Host's resolver. See the constructor's note on why it is not a setter. */
    this.assetUrl = assetUrl;
    this.headroom = 2;
    this.meterNode = null;
    this.pre = null;
    this.shaper = null;
    this.post = null;
    this.probe = null;
    this.probeBuf = null;
    /** last global master meter frame, or null before the first post */
    this.meters = null;
    this.onMeters = null;
    /** in-flight build(), so two decks arming at once cannot build two buses */
    this.building = null;
  }

  /**
   * Idempotent AND re-entrant. Must be awaited before any deck connects.
   *
   * The promise guard is not decoration: `await addModule()` is a real yield
   * point, so two decks calling build() in the same tick would both sail past a
   * plain `if (this.pre)` and create two master chains — two clippers, two
   * meters, two edges into ctx.destination, and a mix summed twice at +6 dB.
   */
  build() {
    if (this.pre) return Promise.resolve(this);
    if (this.building) return this.building;
    this.building = this._build().finally(() => { this.building = null; });
    return this.building;
  }

  async _build() {
    if (this.pre) return this;
    const ctx = this.ctx;
    await ctx.audioWorklet.addModule(this.assetUrl('offscreen/master-meter-processor.js'));

    this.meterNode = new AudioWorkletNode(ctx, 'master-meter', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { sampleRate: ctx.sampleRate, meterHz: METER_HZ },
    });
    this.meterNode.port.onmessage = (e) => {
      const m = e.data;
      if (!m || m.t !== 'master') return;
      this.meters = m;
      if (this.onMeters) this.onMeters(m);
    };

    const h = this.headroom;
    this.pre = new GainNode(ctx, { gain: 1 / h });
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve(0.7079, h);
    this.shaper.oversample = '4x';
    this.post = new GainNode(ctx, { gain: h });
    this.meterNode.connect(this.pre).connect(this.shaper).connect(this.post).connect(ctx.destination);

    // AUDIBILITY PROBE — see LivePipeline.build()'s comment, which this replaces
    // verbatim in intent: the analyser sits on `post`, the LAST node before
    // ctx.destination, so it is the only thing in the system that can say the
    // audio survived pre -> shaper -> post. It cannot see the terminal edge
    // itself; `probeTerminal()` interrogates that separately.
    this.probe = ctx.createAnalyser();
    this.probe.fftSize = 2048;
    this.probeBuf = new Float32Array(this.probe.fftSize);
    this.post.connect(this.probe);
    return this;
  }

  /** Where a deck's playback worklet connects. */
  input() { return this.meterNode; }

  /** Peak at `post`, the last node before ctx.destination. Cheap; 10 Hz is fine. */
  busPeak() {
    if (!this.probe) return null;
    this.probe.getFloatTimeDomainData(this.probeBuf);
    const b = this.probeBuf;
    let p = 0;
    for (let i = 0; i < b.length; i++) { const a = b[i] < 0 ? -b[i] : b[i]; if (a > p) p = a; }
    return p;
  }

  /** Full end-of-chain report. Shape is unchanged from Mode 1's outputProbe(). */
  probeState() {
    const ctx = this.ctx;
    if (!ctx || !this.post || !this.probe) return { built: false };
    this.probe.getFloatTimeDomainData(this.probeBuf);
    const b = this.probeBuf;
    let peak = 0, sq = 0;
    for (let i = 0; i < b.length; i++) { const a = b[i] < 0 ? -b[i] : b[i]; if (a > peak) peak = a; sq += b[i] * b[i]; }
    const curve = this.shaper.curve;
    return {
      built: true,
      busPeak: +peak.toFixed(6),
      busRms: +Math.sqrt(sq / b.length).toFixed(6),
      ctxState: ctx.state,
      sampleRate: ctx.sampleRate,
      outputLatency: Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : null,
      baseLatency: Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : null,
      preGain: this.pre.gain.value,
      postGain: this.post.gain.value,
      curveLength: curve ? curve.length : 0,
      curveUnitySlope: curve ? +(curve[curve.length >> 1] - curve[(curve.length >> 1) - 1]).toFixed(6) : 0,
      oversample: this.shaper.oversample,
    };
  }

  /**
   * Does the edge `post -> ctx.destination` EXIST right now? Interrogates the
   * graph rather than trusting our own bookkeeping: `disconnect(node)` throws
   * InvalidAccessError when the edge is not there. Put straight back in the same
   * task, so no render quantum sees the change — but it IS a mutation, so this
   * stays on the dev/diagnostic path only.
   */
  probeTerminal() {
    const ctx = this.ctx;
    if (!ctx || !this.post) return { terminalIsDestination: false, why: 'no graph' };
    try {
      this.post.disconnect(ctx.destination);
    } catch (e) {
      return { terminalIsDestination: false, why: String((e && e.name) || e) };
    }
    this.post.connect(ctx.destination);
    return { terminalIsDestination: true, why: 'edge present' };
  }

  dispose() {
    if (this.meterNode) {
      this.meterNode.port.postMessage({ t: 'stop' });
      this.meterNode.port.onmessage = null;
    }
    for (const n of [this.meterNode, this.pre, this.shaper, this.post, this.probe]) {
      try { n && n.disconnect(); } catch { /* already gone */ }
    }
    this.meterNode = this.pre = this.shaper = this.post = this.probe = null;
    this.probeBuf = null;
    this.meters = null;
  }
}
