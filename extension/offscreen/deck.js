/**
 * ONE DECK'S hardware: its tab capture, its capture ring, its inference Worker
 * (and therefore its own wasm instance and its own ORT session), and its
 * LivePipeline.
 *
 * Everything a deck does NOT own, because there is exactly one of it:
 *   - the AudioContext          (two contexts have independent hardware clocks
 *                                and drift tens of ms per minute; nothing would
 *                                beat-match — docs/AUDIO.md §8.1)
 *   - the offscreen document     (Chrome allows one, full stop)
 *   - the master bus             (offscreen/master.js — a per-deck soft clipper
 *                                cannot protect the sum)
 *   - the GPU token              (engine/scheduler.js — one GPU, one queue, one
 *                                place to express priority)
 *   - the hop and the live plan  (different hops put the two decks' output
 *                                seconds apart and make them unmixable)
 *
 * ONE BACKEND PER DECK, and this is not negotiable in the other direction either.
 * spike/FINDINGS.md §6: ORT-Web serialises `run()` across every session sharing
 * a wasm instance, and a concurrent call throws `Session already started` and
 * leaves the session permanently wedged — so two sessions inside one worker is a
 * live grenade. Separate workers give separate wasm instances, which makes that
 * failure structurally impossible; the GPU serialises the work anyway (§6
 * measured a sequential pair at 1.01x the sum of two solo runs), so the second
 * worker costs memory and buys safety.
 *
 * THE WORKER IS NOW BEHIND A SEAM (S6, seed §16's option S2). The deck asks the
 * Host for a `Backend` — `load` / `separate` / `dispose`, waveforms in and
 * waveforms out — and today's Host answers with `workers/workerbackend.js`, which
 * is that same worker unchanged inside. What the deck kept is what is
 * ORCHESTRATION: session state and its mirror to the UI, the model bytes, and
 * the cross-deck GPU scheduler. What it no longer knows is that inference
 * involves a worker at all.
 *
 * NOTE the memory: each session is ~1.7 GB of wasm heap at peak. Two decks
 * measured 2091 MB renderer + 357 MB gpu. Deck B's backend is therefore created
 * LAZILY — on its first LIVE_START, never at boot — so a Mode 1 user never pays
 * for it. `host.createBackend()` is synchronous and returns a fresh instance, so
 * WHEN a deck pays is the deck's decision and not the Host's.
 */

import { SR, SEGMENT, RING_FRAMES } from '../shared/config.js';
import { RingConsumer, ringByteLength } from '../shared/ring.js';
import { serialiseBackend, BACKEND_DUTIES } from '../shared/host.js';
import { LivePipeline } from './live.js';

export class Deck {
  /**
   * @param {'A'|'B'} id
   * @param {object} shared
   * @param {() => AudioContext} shared.ctx
   * @param {() => import('./master.js').MasterBus} shared.master
   * @param {() => Promise<ArrayBuffer>} shared.modelBytes  a FRESH buffer per call
   *        (the backend's `load()` transfers it, so two decks cannot share one)
   * @param {import('../shared/host.js').EngineHost['createBackend']} shared.createBackend
   *        the Host's inference backend factory (../shared/host.js), handed down
   *        from `offscreen/engine.js`. Called ONCE PER DECK and lazily — see
   *        `ensureBackend()`.
   * @param {import('../engine/scheduler.js').GpuScheduler} shared.gpu
   * @param {(msg:object) => void} shared.send    already deck-tagged by the caller
   * @param {(line:string) => void} shared.log
   * @param {(relPath:string) => string} shared.assetUrl  the Host's asset
   *        resolver (../shared/host.js). Synchronous, unit-relative, no leading
   *        slash — the way the unit names an asset the HOST serves. Not every
   *        file the unit loads is one of those: `workers/workerbackend.js`
   *        reaches the inference worker by import, and the note there is why
   *        that one must NOT go through here.
   * @param {(deck:Deck) => void} shared.onCaptureTick
   */
  constructor(id, shared) {
    /**
     * THE BUNDLE HAS TO CARRY THE RESOLVER, and `assertHost()` cannot say so.
     *
     * `assertHost` checks the HOST — that `host.assetUrl` is a function — and it
     * runs at `engine.js` module scope before this constructor. What it cannot
     * see is the hand-off: `engine.js` copies the duty onto the `shared` bundle
     * (`assetUrl: host.assetUrl`), and a bundle that lost that one key leaves a
     * Host that passes every check. Review measured what happens then, by
     * deleting exactly that line: `--quick` GREEN and `embed-smoke` 122/122,
     * while the shipped extension dies at `decks.A.ensureBackend()` — which
     * `engine.js` calls at module scope — with `this.s.assetUrl is not a
     * function`. No INIT, no HELLO, no engine, and nothing red anywhere.
     *
     * So the deck refuses the bundle instead, in the same breath and for the
     * same reason `MasterBus` refuses a missing resolver: the alternative is a
     * TypeError from inside `ensureBackend()`, three layers from the mistake.
     */
    if (!shared || typeof shared.assetUrl !== 'function') {
      throw new TypeError(`Deck ${id}: the shared bundle from offscreen/engine.js is missing the Host's `
        + 'assetUrl — the deck hands the same resolver to LivePipeline for the playback worklet '
        + 'and to the inference backend for the ORT runtime directory '
        + `(got ${shared == null ? String(shared) : typeof shared.assetUrl}).`);
    }
    /**
     * AND IT HAS TO CARRY THE BACKEND FACTORY, for exactly the same reason and
     * with exactly the same blind spot. `createBackend` is a duty
     * `assertHost(host, ENGINE_HOST_DUTIES)` checks at engine boot; the line
     * `createBackend: host.createBackend` on the `shared` bundle is a separate
     * step with a separate way to be lost, and losing it leaves every check in
     * the tree green while the extension dies at module scope with
     * `this.s.createBackend is not a function`.
     *
     * A deck with no way to build a backend has nothing to fall back on — there
     * is no second path to inference — so this is a refusal rather than a
     * degradation.
     */
    if (typeof shared.createBackend !== 'function') {
      throw new TypeError(`Deck ${id}: the shared bundle from offscreen/engine.js is missing the Host's `
        + 'createBackend — the deck has no other way to reach inference '
        + `(got ${typeof shared.createBackend}).`);
    }
    this.id = id;
    this.s = shared;

    // ---- inference
    /** @type {import('../shared/host.js').Backend|null} this deck's own, built lazily */
    this.backend = null;
    /** 'unknown' | 'loading' | 'ready' | 'error' — this deck's SESSION, not the download */
    this.session = 'unknown';
    this.sessionError = null;
    this.sessionLoading = null;
    this.ep = null;
    this.threads = null;
    this.adapter = null;

    // ---- capture
    this.stream = null;
    this.node = null;
    this.silentSink = null;
    this.src = null;
    this.ring = null;
    /** 'export' drains the ring destructively; 'live' reads it by absolute frame */
    this.mode = 'export';
    this.blocks = [];
    this.capturedFrames = 0;
    this.status = 'idle';        // 'idle' | 'recording' | 'captured'
    this.source = null;
    this.dropped = 0;
    this.peak = [0, 0];
    this.tickCount = 0;

    // ---- dev-only output tap and synthetic sources (see offscreen.js)
    this.tap = null;
    /**
     * Has this deck been EXPLICITLY prepared (DECK_PREPARE), as opposed to
     * having a session because it is already in use?
     *
     * It is a statement of intent — "this deck will be used" — and the dual
     * console sends it on open. `armRefMs` counts it, so deck A can size its
     * cushion for a shared GPU BEFORE deck B has a capture, which is what closes
     * the ~0.70 s inter-deck offset in the "go live on A, arm B later" ordering.
     */
    this.prepared = false;
    this.devTone = null;
    this.devSrc = null;

    this.live = new LivePipeline({
      deck: id,
      ctx: shared.ctx,
      master: shared.master,
      ring: () => this.ring,
      infer: (mixBuf, outBuf, budgetMs) => this.infer(mixBuf, outBuf, budgetMs),
      ensureModel: () => this.ensureSession(),
      send: (msg) => shared.send({ deck: id, ...msg }),
      log: (line) => shared.log(`[${id}] ${line}`),
      assetUrl: shared.assetUrl,
      // What one chunk will cost THIS deck once the GPU is shared N ways. See
      // LivePipeline.armPlayback(): arming on chunk 0's luck leaves the second
      // deck permanently starved and 100 % unseparated.
      armRefMs: () => shared.armRefMs(id),
    });
  }

  // ----------------------------------------------------------------- backend
  /**
   * THIS DECK'S inference backend, built on first use.
   *
   * ONE PER DECK. `host.createBackend()` returns a FRESH instance every call and
   * this is the only place the unit calls it, so "two decks never share a wasm
   * instance" — the rule three files exist to state (`deck.js` header,
   * `engine/scheduler.js:19-23`, `workers/inference.worker.js:10-12`) — is a
   * property of the call graph rather than of anyone remembering it.
   *
   * LAZY, because a session is ~1.7 GB of wasm heap at peak. Deck A's is built
   * at boot (`engine.js` calls this at module scope, so the deck can report the
   * GPU it found before any gesture); deck B's on its first LIVE_START.
   *
   * IT DOES NOT RE-SPAWN A DEAD ONE. A backend that failed keeps its recorded
   * reason and throws it from every later call; `dispose()` is the only thing
   * that clears the slot. A worker that cannot resolve its imports dies
   * identically every time, so re-spawning here would produce one per chunk for
   * ever and the live path's failure ladder would never see a stable error to
   * halt on.
   */
  ensureBackend() {
    if (this.backend) return this.backend;
    /**
     * SERIALISED HERE, WHERE THE INSTANCE IS BORN, so nothing downstream can
     * hold the unwrapped one. `serialiseBackend` also refuses a Host whose
     * `createBackend` answered with the wrong shape — see the note there.
     */
    this.backend = serialiseBackend(this.s.createBackend({
      name: `deck ${this.id}`,
      /**
       * The hardware the backend found. Telemetry, but the kind the user is
       * shown: `state.boot.{ep,adapter,threads}` is what the deck reports as
       * "wasm threads 4 · gpu nvidia/turing". It arrives unprompted and before
       * any load, which is why it is a hook and not a return value.
       */
      onReady: (info) => {
        this.adapter = info.adapter;
        this.threads = info.threads;
        /**
         * THE LINE DESCRIBES WHAT THE BACKEND ANSWERED, and says nothing when it
         * answered nothing. Both fields are ORT-Web-shaped — a wasm thread count
         * and a WebGPU adapter's `{vendor, architecture}` — because backend #1
         * is ORT-Web. A native backend (CoreML, DirectML, CUDA) has neither and
         * can only answer `{threads: null, adapter: null}`, and the pre-seam
         * spelling of this line would then have told a user on an M-series GPU
         * "wasm threads null · gpu none", which is not degrading — it is
         * reporting someone else's hardware. S11 owns the field names when it
         * freezes Host interface v1; this is the render not pretending.
         */
        const bits = [];
        if (info.threads != null) bits.push(`wasm threads ${info.threads}`);
        if (info.adapter) bits.push(`gpu ${info.adapter.vendor}/${info.adapter.architecture}`);
        this.s.log(`deck ${this.id} backend ready${bits.length ? ` · ${bits.join(' · ')}` : ''}`);
        this.s.onWorkerState && this.s.onWorkerState(this);
      },
      /**
       * THE BACKEND DIED WITH NOTHING IN FLIGHT — a worker killed for memory, a
       * module that would not resolve, an error the wire could not attribute to
       * a call. Calls that WERE in flight reject on their own and reach the
       * caller; this is the case where nobody is listening, and without it the
       * deck goes on reporting a session it no longer has until the next arm.
       *
       * `error` is terminal and nothing else announces it: the offscreen
       * document mirrors session state to the UI, and without this the welcome
       * page sits on "preparing the GPU" for ever.
       */
      onFail: (err) => {
        this.session = 'error';
        this.sessionError = err.message;
        this.s.log(`ERROR [deck ${this.id} backend] ${err.message}`);
        this.s.onWorkerState && this.s.onWorkerState(this);
      },
    }), `Backend for deck ${this.id}`);
    return this.backend;
  }

  /**
   * The backend, or a throw that carries WHY there is not one.
   *
   * `infer()` must not build one: by the time a chunk is in flight the session
   * has been loaded, so a missing backend means it was disposed, and quietly
   * spawning a replacement would hand the live path a backend with no weights
   * in it.
   */
  requireBackend() {
    if (this.backend) return this.backend;
    throw new Error(this.sessionError
      || `the inference backend for deck ${this.id} is not running and reported no reason`);
  }

  /**
   * Load the weights into THIS deck's session. Idempotent and re-entrant-safe.
   *
   * The bytes come from the engine's shared loader, which re-reads and re-hashes
   * per call — `Backend.load()` TRANSFERS the ArrayBuffer, so two decks
   * physically cannot share one.
   *
   * WHAT THIS FUNCTION KEPT, now that the worker is behind a seam: the session
   * state machine and its mirror to the UI, the re-entrancy guard, and the model
   * bytes. What it no longer knows: that a worker exists, what ONNX Runtime is,
   * or where `vendor/ort/` lives. The ORT presence probe went with the backend —
   * it is a diagnosis of a runtime a native backend would not have.
   */
  ensureSession() {
    if (this.session === 'ready') return Promise.resolve();
    if (this.sessionLoading) return this.sessionLoading;
    this.sessionLoading = (async () => {
      const backend = this.ensureBackend();
      this.session = 'loading';
      this.sessionError = null;
      const buffer = await this.s.modelBytes();
      /**
       * The stages of a 109 MB load, as the backend reports them: `'session'`
       * while the graph is compiled (with a `note` when the EP falls back to
       * wasm) and `'warmup'` for the first inference. `state.model.phase` is
       * what the setup page paints from, so a load with no progress is a
       * progress bar that sits still for ~10 s.
       */
      const info = await backend.load(buffer, (phase, note) => {
        if (note) this.s.log(`deck ${this.id} ${note}`);
        this.s.onModelProgress && this.s.onModelProgress(this, { phase, note });
      });
      this.ep = info.ep;
      this.session = 'ready';
      this.s.log(`deck ${this.id} session ${info.ep} created in ${info.createMs.toFixed(0)}ms · warmup ${info.warmupMs.toFixed(0)}ms`);
      this.s.onWorkerState && this.s.onWorkerState(this);
    })().catch((e) => {
      this.session = 'error';
      this.sessionError = String((e && e.message) || e);
      this.s.onWorkerState && this.s.onWorkerState(this);
      throw e;
    }).finally(() => { this.sessionLoading = null; });
    return this.sessionLoading;
  }

  /**
   * One inference, through the shared GPU scheduler.
   *
   * Returns EITHER `{demoted:true, why}` — L3 said this chunk cannot land in
   * time and the priority deck needs the GPU — or the backend's result. A
   * demotion is not an error and must not be thrown: LivePipeline routes throws
   * into the CHUNK_FAILED ladder, which halts the deck after three, and that is
   * why demotion is a `Deck` concern and not something on the `Backend`
   * interface: a backend either separates or throws.
   *
   * When demoted, `mixBuf`/`outBuf` are NEVER transferred, so the caller still
   * owns them. That invariant is load-bearing — see LivePipeline.runChunk.
   */
  async infer(mixBuf, outBuf, budgetMs = Infinity) {
    /**
     * L3, pre-emptive: while ANOTHER deck is creating its ORT session, do not
     * submit at all.
     *
     * `InferenceSession.create` compiles shaders on the GPU both decks share and
     * takes ~8 s. A chunk submitted into that window does not run slowly — it
     * does not run at all until the compile finishes, and the deck produces
     * NOTHING for the whole period. Measured with `dual-live-probe --stress-armb`
     * over 8 arms of deck B while deck A played: deck A produced 0 chunks and the
     * ladder covered 6-7 spans EVERY TIME (8 of 8, not the 1-in-3 the underrun
     * suggested), and its buffer trough decayed monotonically 0.505 -> 0.091 s
     * against a 0.12 s low-water mark, underrunning once on the way down.
     *
     * Submitting anyway is strictly worse than not: the audio is identical either
     * way (the ladder fills the span from capture history), but a submitted chunk
     * also arrives late enough to be discarded, having occupied the token. So the
     * deck degrades deliberately and counts it, instead of stalling and hoping.
     *
     * Export is exempt by construction: `budgetMs` is Infinity for export
     * segments, which can never be "too late to publish", and demoting one would
     * hand `runExport` a `{demoted:true}` it does not expect.
     */
    if (Number.isFinite(budgetMs) && this.s.othersLoading(this.id)) {
      return { demoted: true, why: 'another deck is creating its ORT session' };
    }
    const gpu = this.s.gpu;
    /**
     * BOTH QUEUES, NOT EITHER. `gpu.run` is the CROSS-DECK policy — one token,
     * FIFO with a priority jump, and the L3 demotion decisions on either side of
     * the wait. The backend's own queue (`shared/host.js`) is the PER-BACKEND
     * safety rule that keeps one `separate()` in flight whatever the policy
     * becomes. They answer different questions and neither implies the other.
     *
     * ⚠ AND THE ORDER IS THE ZERO-COPY CONTRACT. `separate()` — and therefore
     * the `postMessage` that transfers both buffers — is INSIDE `fn`, and every
     * demotion path returns before `fn` is ever called (the pre-emptive check
     * above, `scheduler.js:185`, `scheduler.js:194`). That is the mechanism, and
     * it is structural rather than a flag anyone has to set:
     *
     *   "When demoted, mixBuf/outBuf are NEVER transferred, so the caller still
     *    owns them. That invariant is load-bearing — see LivePipeline.runChunk."
     *
     * Move the transfer outside `fn` — or hand the backend the buffers before
     * the token is taken — and the next `runChunk` throws "Cannot perform
     * Construct on a detached ArrayBuffer" at its first line, once per capture
     * tick, for ever.
     */
    const r = await gpu.run(this.id, budgetMs, () => this.requireBackend().separate(mixBuf, outBuf));
    if (r.demoted) return r;
    // Feed the estimator ONLY from steady-state passes.
    //
    // `InferenceSession.create` on the other deck compiles shaders on the same
    // GPU, and a pass that overlaps it takes seconds rather than ~850 ms. Those
    // samples are real but they are not the machine's steady state, and `estMs`
    // is a p95 over the last 64 — so three of them at deck B's arm time set that
    // deck's latency for the whole session (measured: 6.20 s instead of 4.35 s)
    // and made L3 demote every chunk. A number used to make a permanent decision
    // must not be sampled during a transient.
    if (r.result && typeof r.result.inferMs === 'number' && !this.s.anyLoading()) {
      gpu.observe(r.result.inferMs + (r.result.prepMs || 0) + (r.result.postMs || 0));
    }
    return r.result;
  }

  // ----------------------------------------------------------------- capture
  /**
   * Attach a MediaStream to this deck. `mode` is 'export' (destructive drain) or
   * 'live' (absolute-frame reads). The shipping CAPTURE_START cannot know which
   * mode the user will pick, so it attaches in 'export' and startLive() flips it.
   */
  async attach(mediaStream, source, mode = 'export') {
    if (this.status === 'recording') throw new Error(`deck ${this.id} is already capturing`);
    const ctx = this.s.ctx();
    this.stream = mediaStream;
    this.mode = mode;

    const sab = new SharedArrayBuffer(ringByteLength(RING_FRAMES));
    this.ring = new RingConsumer(sab, RING_FRAMES);
    this.blocks = [];
    this.capturedFrames = 0;

    const src = ctx.createMediaStreamSource(mediaStream);   // 48k track -> 44.1k ctx, native resample
    const node = new AudioWorkletNode(ctx, 'tap-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { sab, capacity: RING_FRAMES },
    });
    node.port.onmessage = () => this.onTick();
    // Chrome only pulls nodes with a path to destination. Silent sink, kept on
    // the deck so detach() can disconnect it (review finding M5).
    const silent = new GainNode(ctx, { gain: 0 });
    this.src = src;
    this.node = node;
    this.silentSink = silent;
    src.connect(node);
    node.connect(silent).connect(ctx.destination);
    // src is NEVER connected to destination: capturing already mutes the tab and
    // re-injecting it would defeat the point (docs/ARCHITECTURE.md §3.2).

    this.status = 'recording';
    this.source = source;
    this.dropped = 0;
    this.peak = [0, 0];
    this.s.log(`deck ${this.id} capture started · track ${mediaStream.getAudioTracks()[0].getSettings().sampleRate || '?'} Hz -> ctx ${ctx.sampleRate} Hz`);

    const track = mediaStream.getAudioTracks()[0];
    track.onended = () => { this.s.log(`deck ${this.id} source track ended`); this.s.onTrackEnded && this.s.onTrackEnded(this); };
  }

  onTick() {
    if (!this.ring) return;
    if (this.mode === 'live') {
      // Live mode NEVER drains: every chunk re-reads the last 7.8 s of history
      // and a skipped chunk is filled from that same history. The ring laps
      // itself at 23.78 s, which is 3x the deepest read.
      this.capturedFrames = this.ring.writeFrames();
      this.peak = this.ring.peaks();
      this.s.onCaptureTick && this.s.onCaptureTick(this);
      // Review finding P3-M1: pump() runs the backpressure ladder synchronously and
      // can throw. Unguarded, that throw escapes into a worklet port handler:
      // no fail(), no LIVE_ERROR, no banner. Route it into the failure ladder.
      try { this.live.pump(); } catch (e) { this.live.fail('PUMP_FAILED', e); }
      this.tickCount++;
      return;
    }
    const d = this.ring.drain();
    if (d) {
      this.blocks.push(d);
      this.capturedFrames += d.l.length;
      this.dropped += d.dropped;
    }
    this.peak = this.ring.peaks();
    this.s.onCaptureTick && this.s.onCaptureTick(this);
    this.tickCount++;
  }

  seconds() { return this.capturedFrames / SR; }

  /** Stop the capture graph and release the tab. Live playback is stopped first. */
  async detach() {
    if (this.status !== 'recording') return;
    /**
     * R5 — THE TRACKS MUST BE STOPPED EVEN IF THE STOP PATH REJECTS, and this
     * `.catch` is the asymmetry with `dispose()` below closed. `stop()` awaits
     * one more inference and publishes it through a HOST-SUPPLIED writer, so it
     * is a path that can reject for reasons the capture graph has nothing to do
     * with. Before `drain()` existed, `stop()` contained no `await` at all and
     * could not reject; it can now, and an unhandled rejection here skips
     * `getTracks().forEach((t) => t.stop())` seven lines down — the tab stays
     * captured, the recording indicator stays lit, and only a reload releases
     * it. Swallowed but NAMED: `drain()` counts its own abandonment, so this
     * log is for a failure that came from somewhere else in `stop()`.
     */
    await this.live.stop().catch((e) => this.s.log(
      `deck ${this.id} live stop failed, releasing the capture anyway: ${(e && e.message) || e}`));
    if (this.node) { this.node.port.postMessage('stop'); this.node.port.onmessage = null; }
    this.onTick();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());   // restores the tab's own audio
    this.stream = null;
    if (this.src) { this.src.disconnect(); this.src = null; }
    if (this.node) { this.node.disconnect(); this.node = null; }
    if (this.silentSink) { this.silentSink.disconnect(); this.silentSink = null; }
    this.ring = null;
    this.mode = 'export';
    if (this.devTone) { try { this.devTone.osc.stop(); } catch { /* stopped */ } await this.devTone.ctx.close().catch(() => {}); this.devTone = null; }
    if (this.devSrc) { try { this.devSrc.src.stop(); } catch { /* ended */ } await this.devSrc.ctx.close().catch(() => {}); this.devSrc = null; }
    this.status = 'captured';
    this.s.log(`deck ${this.id} capture stopped · ${this.seconds().toFixed(2)} s (${this.capturedFrames} frames), dropped ${this.dropped}`);
  }

  /**
   * Drains the captured blocks into two planar channels. DESTRUCTIVE.
   * See offscreen.js's QA-01/QA-07/QA-14 note: the length comes from `blocks`
   * and NOWHERE else, so an export can never be longer than the audio in it.
   */
  drainCaptured() {
    let n = 0;
    for (const b of this.blocks) n += b.l.length;
    const l = new Float32Array(n), r = new Float32Array(n);
    let o = 0;
    for (const b of this.blocks) { l.set(b.l, o); r.set(b.r, o); o += b.l.length; }
    this.blocks = [];
    this.capturedFrames = 0;
    return { l, r };
  }

  captureState() {
    return {
      status: this.status, frames: this.capturedFrames, seconds: this.seconds(),
      peak: this.peak, dropped: this.dropped, source: this.source, mode: this.mode,
    };
  }

  async dispose() {
    // `{ drain: false }` — ruling 24: a deck being disposed is a teardown-shaped
    // path and may not block on one more inference. The abandonment is counted
    // by `stop()` rather than skipped silently. A user's own stop reaches
    // `detach()` above, which drains.
    await this.live.stop({ drain: false }).catch(() => {});
    this.live.dispose();
    await this.detach().catch(() => {});
    /**
     * THE SLOT IS CLEARED, so `requireBackend()` refuses the next call rather
     * than a disposed backend accepting one. `ensureBackend()` is what builds a
     * replacement, and only a caller that means to start again reaches it.
     *
     * THE AWAIT IS UNBOUNDED ON PURPOSE, AND R5 DOES NOT DEPEND ON IT. The
     * typedef says `dispose()` MUST START ITS TEARDOWN SYNCHRONOUSLY, and
     * `WorkerBackend`'s body is synchronous — but a Host whose backend answers
     * over IPC could return a promise that never settles, and `.catch()` does
     * nothing about a hang. What that costs is bounded by the ORDERING above:
     * `this.detach()` — the track stop that unmutes the user's tab, which is
     * what R5 is about — has already run two lines up, and `engine.js`'s
     * `pagehide` teardown deliberately does not await this at all. So the worst
     * case is a `stopDeck()` that never resolves, not a tab left muted.
     * Deliberately not raced against a timer: the same "await it and hope" that
     * `WorkerBackend.dispose()` refuses to do on the wire is not worth
     * re-inventing here with a clock.
     */
    if (this.backend) { const b = this.backend; this.backend = null; await b.dispose().catch(() => {}); }
    this.session = 'unknown';
    this.status = 'idle';
    this.prepared = false;
  }
}
