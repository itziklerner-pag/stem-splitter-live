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
 * ONE WORKER PER DECK, and this is not negotiable in the other direction either.
 * spike/FINDINGS.md §6: ORT-Web serialises `run()` across every session sharing
 * a wasm instance, and a concurrent call throws `Session already started` and
 * leaves the session permanently wedged — so two sessions inside one worker is a
 * live grenade. Separate workers give separate wasm instances, which makes that
 * failure structurally impossible; the GPU serialises the work anyway (§6
 * measured a sequential pair at 1.01x the sum of two solo runs), so the second
 * worker costs memory and buys safety.
 *
 * NOTE the memory: each session is ~1.7 GB of wasm heap at peak. Two decks
 * measured 2091 MB renderer + 357 MB gpu. Deck B's worker is therefore created
 * LAZILY — on its first LIVE_START, never at boot — so a Mode 1 user never pays
 * for it.
 */

import { SR, SEGMENT, RING_FRAMES } from '../shared/config.js';
import { RingConsumer, ringByteLength } from '../shared/ring.js';
import { LivePipeline } from './live.js';

export class Deck {
  /**
   * @param {'A'|'B'} id
   * @param {object} shared
   * @param {() => AudioContext} shared.ctx
   * @param {() => import('./master.js').MasterBus} shared.master
   * @param {() => Promise<ArrayBuffer>} shared.modelBytes  a FRESH buffer per call
   *        (LOAD_MODEL transfers it, so two decks cannot share one)
   * @param {import('../engine/scheduler.js').GpuScheduler} shared.gpu
   * @param {(msg:object) => void} shared.send    already deck-tagged by the caller
   * @param {(line:string) => void} shared.log
   * @param {(relPath:string) => string} shared.assetUrl  the Host's asset
   *        resolver (../shared/host.js). Synchronous, unit-relative, no leading
   *        slash — the way the unit names an asset the HOST serves. Not every
   *        file the unit loads is one of those: `ensureWorker()` reaches the
   *        inference worker by import, and the note there is why that one must
   *        NOT go through here.
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
     * while the shipped extension dies at `decks.A.ensureWorker()` — which
     * `engine.js` calls at module scope — with `this.s.assetUrl is not a
     * function`. No INIT, no HELLO, no engine, and nothing red anywhere.
     *
     * So the deck refuses the bundle instead, in the same breath and for the
     * same reason `MasterBus` refuses a missing resolver: the alternative is a
     * TypeError from inside `ensureWorker()`, three layers from the mistake.
     */
    if (!shared || typeof shared.assetUrl !== 'function') {
      throw new TypeError(`Deck ${id}: the shared bundle from offscreen/engine.js is missing the Host's `
        + 'assetUrl — the deck resolves the ORT runtime directory for the inference worker\'s INIT '
        + 'and hands the same resolver to LivePipeline for the playback worklet '
        + `(got ${shared == null ? String(shared) : typeof shared.assetUrl}).`);
    }
    this.id = id;
    this.s = shared;

    // ---- inference
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    /** 'unknown' | 'loading' | 'ready' | 'error' — this deck's SESSION, not the download */
    this.session = 'unknown';
    this.sessionError = null;
    this.sessionLoading = null;
    this.sessionReady = null;
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

  // ------------------------------------------------------------------ worker
  ensureWorker() {
    if (this.worker) return this.worker;
    /**
     * THE WORKER URL IS RELATIVE ON PURPOSE, and it does not go through
     * `assetUrl`. `import.meta.url` resolves against THIS module's own location,
     * so the expression says "the sibling directory `workers/`" and nothing
     * about where the unit is mounted — which is what makes it correct under a
     * `chrome-extension://` origin and under a desktop Host alike.
     *
     * `assetUrl` exists for the files the unit does NOT reach by import: worklet
     * modules, which `addModule()` fetches by URL, and the ORT runtime, which
     * the worker resolves against its own directory. Routing this one through
     * the Host as well would hand the Host authority over the unit's internal
     * directory layout, and that layout is part of the unit's contract
     * (ADR 0001 decision 3). Do not "fix" it to `assetUrl`.
     */
    const w = new Worker(new URL('../workers/inference.worker.js', import.meta.url), { type: 'module' });
    // Review finding M1: any failure that does not arrive as {type:'ERROR'} — a
    // module load failure, an uncaught rejection, an OOM that kills the worker —
    // leaves every `pending` entry unsettled, so `await infer(...)` hangs forever
    // with no cancel path. Reject them all and drop the worker so the next job
    // re-spawns. Per deck: deck B dying must not settle deck A's promises.
    w.onerror = (e) => {
      const err = new Error(e.message || `inference worker (deck ${this.id}) crashed`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      if (this.sessionReady) { const r = this.sessionReady; this.sessionReady = null; r.rej(err); }
      this.sessionLoading = null;
      this.session = 'error';
      this.sessionError = err.message;
      this.worker = null;
      this.s.log(`ERROR [deck ${this.id} worker] ${err.message}`);
      // The offscreen document mirrors session state to the UI. Without this the
      // welcome page stays on "preparing the GPU" for ever, because `error` is a
      // terminal state that nothing announced.
      this.s.onWorkerState && this.s.onWorkerState(this);
    };
    w.onmessage = (e) => this.onWorker(e.data);
    // A DIRECTORY URL, trailing slash and all: ORT appends its own file names to
    // it. R0 measured the file-URL form failing inside the runtime with
    // "w is not a function", several layers from the mistake.
    w.postMessage({ type: 'INIT', wasmDirUrl: this.s.assetUrl('vendor/ort/') });
    this.worker = w;
    return w;
  }

  /**
   * The worker handle, or a throw that carries WHY it is gone.
   *
   * `onerror` above nulls `this.worker` so the next job re-spawns, and every
   * send site then dereferenced it anyway — `this.worker.postMessage(...)` on
   * null throws a TypeError naming `postMessage`, which is the one fact in the
   * failure that does not matter. The real reason was recorded in
   * `this.sessionError` one tick earlier and then never read.
   *
   * Re-spawning here instead would be worse: a worker that cannot resolve its
   * imports dies identically every time, so `infer()` would spawn one per chunk
   * forever and the ladder would never see a stable error to halt on.
   */
  requireWorker() {
    if (this.worker) return this.worker;
    throw new Error(this.sessionError
      || `the inference worker for deck ${this.id} is not running and reported no reason`);
  }

  onWorker(m) {
    switch (m.type) {
      case 'READY':
        this.adapter = m.adapter;
        this.threads = m.numThreads;
        this.s.log(`deck ${this.id} worker ready · wasm threads ${m.numThreads} · gpu ${m.adapter ? m.adapter.vendor + '/' + m.adapter.architecture : 'none'}`);
        this.s.onWorkerState && this.s.onWorkerState(this);
        break;
      case 'MODEL_PROGRESS':
        if (m.note) this.s.log(`deck ${this.id} ${m.note}`);
        this.s.onModelProgress && this.s.onModelProgress(this, m);
        break;
      case 'MODEL_READY':
        this.ep = m.ep;
        this.session = 'ready';
        this.s.log(`deck ${this.id} session ${m.ep} created in ${m.createMs.toFixed(0)}ms · warmup ${m.warmupMs.toFixed(0)}ms`);
        if (this.sessionReady) { this.sessionReady.res(); this.sessionReady = null; }
        this.s.onWorkerState && this.s.onWorkerState(this);
        break;
      case 'RESULT': {
        const r = this.pending.get(m.id);
        if (r) { this.pending.delete(m.id); r.resolve(m); }
        break;
      }
      case 'ERROR': {
        const r = m.id != null && this.pending.get(m.id);
        if (r) { this.pending.delete(m.id); r.reject(new Error(m.message)); }
        else if (this.sessionReady) { const s = this.sessionReady; this.sessionReady = null; s.rej(new Error(m.message)); }
        else {
          this.session = 'error'; this.sessionError = m.message;
          this.s.log(`ERROR [deck ${this.id} worker] ${m.message}`);
          this.s.onWorkerState && this.s.onWorkerState(this);
        }
        break;
      }
    }
  }

  /**
   * Load the weights into THIS deck's session. Idempotent and re-entrant-safe.
   * The bytes come from the shared cache loader, which re-reads and re-hashes
   * per call — LOAD_MODEL transfers the ArrayBuffer, so two decks physically
   * cannot share one.
   */
  ensureSession() {
    if (this.session === 'ready') return Promise.resolve();
    if (this.sessionLoading) return this.sessionLoading;
    this.sessionLoading = (async () => {
      /**
       * THE RUNTIME IS NOT IN GIT, AND ITS ABSENCE HAS TO BE NAMED HERE.
       *
       * `workers/inference.worker.js` STATICALLY imports
       * `../vendor/ort/ort.all.bundle.min.mjs`, which `.gitignore` excludes —
       * `tools/fetch-vendor.sh` puts it there. Load the extension without
       * running that and the module worker fails to resolve its import, which
       * fires `onerror` with an EMPTY message. The deck then nulls `this.worker`
       * and the next send halts the ladder on "Cannot read properties of null
       * (reading 'postMessage')", three chunks and one useless error later.
       *
       * Nothing in that chain ever names the missing file. So check the one file
       * that is not in git, before spawning anything, and say what to run.
       */
      const ortUrl = this.s.assetUrl('vendor/ort/ort.all.bundle.min.mjs');
      const head = await fetch(ortUrl, { method: 'HEAD' }).catch(() => null);
      if (!head || !head.ok) {
        /**
         * NAME THE URL THAT FAILED, not just the file that is usually missing.
         * Under this Host the two are the same sentence. Under a second Host
         * they are not: a resolver that answers with something `fetch` refuses
         * — `file://` is refused outright in Chromium, and a custom scheme
         * needs `supportFetchAPI` — lands here for a file that is present, and
         * "run fetch-vendor.sh" is then advice for the wrong problem. The URL
         * is what tells the two apart, so it goes in the message.
         */
        throw new Error(
          `ONNX Runtime is missing from this build: ${ortUrl} could not be read. `
          + 'extension/vendor/ort/ is not in git — run `bash tools/fetch-vendor.sh` '
          + 'and reload.',
        );
      }
      this.ensureWorker();
      this.session = 'loading';
      this.sessionError = null;
      const buffer = await this.s.modelBytes();
      const ready = new Promise((res, rej) => { this.sessionReady = { res, rej }; });
      this.requireWorker().postMessage({ type: 'LOAD_MODEL', buffer }, [buffer]);
      await ready;
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
   * time and the priority deck needs the GPU — or the worker's RESULT message.
   * A demotion is not an error and must not be thrown: LivePipeline routes
   * throws into the CHUNK_FAILED ladder, which halts the deck after three.
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
    const r = await gpu.run(this.id, budgetMs, () => {
      // Resolved BEFORE `pending.set`: a throw inside the executor rejects the
      // promise correctly, but leaves an entry nothing will ever settle.
      const w = this.requireWorker();
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        w.postMessage({ type: 'INFER', id, mix: mixBuf, out: outBuf }, [mixBuf, outBuf]);
      });
    });
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
    await this.live.stop();
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
    await this.live.stop().catch(() => {});
    this.live.dispose();
    await this.detach().catch(() => {});
    if (this.worker) { this.worker.postMessage({ type: 'DISPOSE' }); this.worker.terminate(); this.worker = null; }
    this.pending.clear();
    this.session = 'unknown';
    this.status = 'idle';
    this.prepared = false;
  }
}
