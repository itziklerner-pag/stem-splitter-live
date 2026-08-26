/**
 * BACKEND #1 — today's inference worker, behind the seam.
 *
 * `inference.worker.js`, its neighbour, is untouched by this file: ONNX Runtime on
 * WebGPU with a threaded-wasm fallback, the ~283 ms/segment JS STFT/iSTFT around
 * the hoisted-STFT ONNX graph, one ORT session, one wasm instance. What moved
 * here is everything that used to sit in `offscreen/deck.js` between the deck
 * and that worker: the five-message protocol, the pending map that correlates
 * `INFER` with `RESULT`, the three destinations an `ERROR` has, and the ORT
 * presence probe. The deck kept what is orchestration — session state, the
 * `state.model` mirror, and the GPU scheduler.
 *
 * WHY THAT LINE AND NOT ANOTHER. Seed §16 chose the AUDIO-level seam (option S2)
 * over a tensor-level one precisely so that the spectral path — the slowest
 * stage on WebGPU — is INSIDE the thing a native backend would replace, rather
 * than frozen into the interface in front of it. So `demucs.js`, the STFT, the
 * tensor names and the `[1,4,2048,336]` complex-as-channels packing are all
 * below this file and none of them is on `Backend`.
 *
 * ---------------------------------------------------------------------------
 * ⚠ THE ZERO-COPY TRANSFER RULE — quoted, because this file is where it lives
 * ---------------------------------------------------------------------------
 *
 * `offscreen/deck.js`, on the demotion path:
 *
 *     "When demoted, mixBuf/outBuf are NEVER transferred, so the caller still
 *      owns them. That invariant is load-bearing — see LivePipeline.runChunk."
 *
 * `offscreen/live.js`, on the other side of the same fact:
 *
 *     "NOTHING WAS TRANSFERRED — the scheduler returns before postMessage — so
 *      mixBuf/outBuf are still attached and must NOT be reallocated or
 *      reclaimed."
 *
 * There are exactly THREE transfers in the whole inference path and this file
 * owns two of them:
 *
 *   1. `LOAD_MODEL` posts `[buffer]` — 114,559,139 B of weights, transferred
 *      because the alternative is 109 MB duplicated across a thread boundary at
 *      the exact peak-memory moment (FINDINGS §3 measured 1761 MB renderer RSS
 *      with the duplicate resident).
 *   2. `INFER` posts `[mix, out]` — 2.75 MB + 16.51 MB, LENT for one segment.
 *   3. (the worker's own `RESULT` hands both straight back, because
 *      `inference.worker.js:105` wraps `m.out` in a VIEW rather than copying it,
 *      so `r.stems.buffer === m.out`.)
 *
 * The pair PING-PONGS: `LivePipeline` allocates them ONCE PER SESSION — "19.4 MB
 * at six stems, once" — and re-adopts them from every resolution. And the
 * demotion path must transfer NOTHING, which is a property of WHERE the transfer
 * sits rather than of a flag: `postMessage` is inside `separate()`, `separate()`
 * is inside `gpu.run()`'s `fn`, and every demotion returns BEFORE `fn` is called
 * (`deck.js`'s pre-emptive L3, `scheduler.js:185`, `scheduler.js:194`). If a
 * future backend transferred on the demotion path, the next `runChunk` would
 * throw "Cannot perform Construct on a detached ArrayBuffer" at its first line,
 * once per capture tick, for ever.
 *
 * DO NOT CHANGE WHICH BUFFERS ARE TRANSFERRED AND WHICH ARE NOT.
 *
 * ---------------------------------------------------------------------------
 * IT IS UNIT CODE THAT NO IMPORT CRAWL OF THE UNIT REACHES — read this before
 * computing the unit's file list
 * ---------------------------------------------------------------------------
 *
 * This file's ONLY importer in the tree is `offscreen/host.js`, the Host, which
 * is a declared HOLE in the unit. So a crawl that starts at
 * `offscreen/engine.js` and stops at the Host — which is what a hole means —
 * misses this file, and with it `workers/inference.worker.js`,
 * `engine/demucs.js`, the tensor contract and the six-stem layout: the most
 * unit-ish code in the repository, sitting behind the one edge a crawl must not
 * follow. `inference.worker.js` has the same property for a different reason
 * (`new URL(..., import.meta.url)` is not an import either), which is why
 * ADR 0001 decision 3 enumerates the unit's worker files BY NAME rather than by
 * graph. `workerbackend.js` is named there too, as of S6.
 *
 * A closure computed rather than listed must therefore SEED this file
 * explicitly. It is the Host's choice of backend and the unit's implementation
 * of one at the same time: which is the point of the seam, and the reason the
 * two facts have to be written down separately.
 */

/**
 * @implements {import('../shared/host.js').Backend}
 */
export class WorkerBackend {
  /**
   * Spawns the worker and sends its `INIT` immediately — so a Host's
   * `createBackend()` stays synchronous and the caller decides when to pay for
   * one. `Deck.ensureBackend()` is that decision: deck A at boot, deck B on its
   * first `LIVE_START`, because each ORT session peaks at ~1.7 GB of wasm heap.
   *
   * @param {object} o
   * @param {(relPath: string) => string} o.assetUrl  the Host's resolver. The
   *        ONE thing this backend needs from the Host, and it needs it for one
   *        directory: `vendor/ort/`, which ORT appends its own file names to.
   * @param {string} [o.name]  a human label for error messages ("deck A")
   * @param {(info: {threads: number|null, adapter: object|null}) => void} [o.onReady]
   * @param {(err: Error) => void} [o.onFail]  the backend died with nothing in
   *        flight. Without this the death is silent until the next arm.
   */
  constructor({ assetUrl, name = 'the inference worker', onReady = () => {}, onFail = () => {} } = {}) {
    /**
     * THE RESOLVER IS NOT OPTIONAL, and the refusal is here rather than at the
     * first use for the reason `Deck` and `MasterBus` both give: without it the
     * failure is `this.assetUrl is not a function` from inside a `postMessage`
     * argument list, three layers from the Host that forgot it.
     */
    if (typeof assetUrl !== 'function') {
      throw new TypeError(`WorkerBackend (${name}): no assetUrl resolver was supplied — the backend `
        + "resolves the ORT runtime directory for the worker's INIT "
        + `(got ${assetUrl === null ? 'null' : typeof assetUrl}).`);
    }
    this.name = name;
    this.assetUrl = assetUrl;
    this.onReady = onReady;
    this.onFail = onFail;

    /** id -> {resolve, reject} for the `INFER`/`RESULT` correlation. */
    this.pending = new Map();
    this.nextId = 1;
    /** The open `LOAD_MODEL`, if any: `MODEL_READY` resolves it, `ERROR` rejects it. */
    this.loadGate = null;
    /** Where `MODEL_PROGRESS` goes while a load is open. */
    this.progress = null;
    /** Why the worker is gone, recorded at the moment it went. */
    this.deadReason = null;

    /** Set by `dispose()`. A backend given back does not come back. */
    this.disposed = false;
    /** @type {Worker|null} */
    this.worker = null;
    /** @type {Promise<string|null>|null} the ORT presence diagnosis, per spawn */
    this.probe = null;
    this.spawn();
  }

  /**
   * Start a worker and hand it its `INIT`.
   *
   * CALLED FROM THE CONSTRUCTOR AND FROM `load()`, AND FROM NOWHERE ELSE. That
   * pairing is the pre-seam behaviour kept intact, and the asymmetry in it is
   * deliberate: `ensureSession()` used to call `ensureWorker()`, which spawned a
   * replacement when the last one had died, so a worker killed for memory cost
   * the user one gesture rather than a reload. `infer()` called `requireWorker()`
   * instead, which refused — because a worker that cannot resolve its imports
   * dies identically every time, and re-spawning per chunk would produce one per
   * capture tick while the failure ladder never saw a stable error to halt on.
   * `load()` is once per gesture; `separate()` is once per 1.95 s. Same rule,
   * same two sides, one module further in.
   */
  spawn() {
    /**
     * THE PROBE IS STARTED HERE AND AWAITED IN `load()`.
     *
     * `./inference.worker.js` STATICALLY imports
     * `../vendor/ort/ort.all.bundle.min.mjs`, which `.gitignore` excludes —
     * `tools/fetch-vendor.sh` puts it there. A module worker that cannot resolve
     * its static import fires `onerror` with an EMPTY message, so without this
     * the whole chain never names the missing file.
     *
     * It moved from the deck's `ensureSession()` to the backend because it is a
     * diagnosis of the RUNTIME this backend needs, and a native backend has no
     * ORT bundle to look for. Starting it at spawn also overlaps it with the
     * worker's own module load instead of serialising it in front of the model.
     * The one visible consequence: on a checkout that never ran
     * `fetch-vendor.sh`, the deck now reads the weights before it reports the
     * missing runtime, instead of after. Deck A's backend is built at boot, so
     * by the time anyone arms, this has been settled for minutes.
     *
     * RE-RUN ON EVERY SPAWN, because the answer can change: the whole point of
     * the message is that someone goes and runs the script.
     */
    this.probe = this.probeRuntime();

    /**
     * THE WORKER URL IS RELATIVE ON PURPOSE, and it does not go through
     * `assetUrl`. `import.meta.url` resolves against THIS module's own location,
     * so the expression says "the file next to this one" and nothing about where
     * the unit is mounted — which is what makes it correct under a
     * `chrome-extension://` origin and under a desktop Host alike.
     *
     * `assetUrl` exists for the files the unit does NOT reach by import: worklet
     * modules, which `addModule()` fetches by URL, and the ORT runtime, which
     * the worker resolves against its own directory. Routing this one through
     * the Host as well would hand the Host authority over the unit's internal
     * directory layout, and that layout is part of the unit's contract
     * (ADR 0001 decision 3). Do not "fix" it to `assetUrl`.
     */
    const w = new Worker(new URL('./inference.worker.js', import.meta.url), { type: 'module' });
    /**
     * Review finding M1, carried across the seam unchanged: any failure that
     * does not arrive as `{type:'ERROR'}` — a module load failure, an uncaught
     * rejection, an OOM that kills the worker — leaves every `pending` entry
     * unsettled, so `await separate(...)` hangs for ever with no cancel path.
     * Reject them all. PER BACKEND: deck B dying must not settle deck A's calls,
     * which is one more thing a fresh instance per deck buys.
     */
    w.onerror = (e) => this.die(new Error((e && e.message) || `inference worker (${this.name}) crashed`));
    w.onmessage = (e) => this.receive(e.data);
    // A DIRECTORY URL, trailing slash and all: ORT appends its own file names to
    // it. R0 measured the file-URL form failing inside the runtime with
    // "w is not a function", several layers from the mistake.
    w.postMessage({ type: 'INIT', wasmDirUrl: this.assetUrl('vendor/ort/') });
    this.deadReason = null;
    this.worker = w;
    return w;
  }

  /**
   * Is the ORT bundle actually readable? Resolves to a repair instruction, or
   * to null when there is nothing to say. NEVER REJECTS: it is a diagnosis, and
   * a diagnosis that throws replaces the fault it was called to explain.
   */
  async probeRuntime() {
    const url = this.assetUrl('vendor/ort/ort.all.bundle.min.mjs');
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (head && head.ok) return null;
    /**
     * NAME THE URL THAT FAILED, not just the file that is usually missing.
     * Under the extension Host the two are the same sentence. Under a second
     * Host they are not: a resolver that answers with something `fetch` refuses
     * — `file://` is refused outright in Chromium, and an Electron custom scheme
     * needs `supportFetchAPI` — lands here for a file that is present, and "run
     * fetch-vendor.sh" is then advice for the wrong problem. The URL is what
     * tells the two apart, so it goes in the message.
     */
    return `ONNX Runtime is missing from this build: ${url} could not be read. `
      + 'extension/vendor/ort/ is not in git — run `bash tools/fetch-vendor.sh` '
      + 'and reload.';
  }

  /**
   * The worker handle, or a throw that carries WHY it is gone.
   *
   * `die()` nulls `this.worker`, and every send site then dereferenced it
   * anyway — `postMessage` on null throws a TypeError naming `postMessage`,
   * which is the one fact in the failure that does not matter. The real reason
   * was recorded one tick earlier and then never read.
   *
   * IT DELIBERATELY DOES NOT RE-SPAWN. A worker that cannot resolve its imports
   * dies identically every time, so re-spawning here would produce one per chunk
   * for ever and the live path's failure ladder would never see a stable error
   * to halt on.
   */
  require() {
    if (this.worker) return this.worker;
    throw new Error(this.deadReason
      || `the inference worker for ${this.name} is not running and reported no reason`);
  }

  /** The worker is gone. Settle everything waiting on it, and say so once. */
  die(err) {
    this.deadReason = err.message;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    if (this.loadGate) { const g = this.loadGate; this.loadGate = null; g.rej(err); }
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; }
    this.worker = null;
    this.onFail(err);
  }

  /**
   * The worker's five outbound messages.
   *
   * `ERROR` HAS THREE DESTINATIONS, IN PRIORITY ORDER, and all three are load
   * bearing: an id that is still pending rejects THAT call; otherwise an open
   * load rejects the load; otherwise nothing is waiting and the only way anyone
   * hears about it is `onFail`. Case 2 has no id on the wire, so a `LOAD_MODEL`
   * failure and a stray worker error are indistinguishable here — which is why
   * the order matters rather than the shape.
   */
  receive(m) {
    if (!m) return;
    switch (m.type) {
      case 'READY':
        this.onReady({ threads: m.numThreads, adapter: m.adapter });
        return;
      case 'MODEL_PROGRESS':
        if (this.progress) this.progress(m.phase, m.note);
        return;
      case 'MODEL_READY':
        if (this.loadGate) {
          const g = this.loadGate;
          this.loadGate = null;
          g.res({ ep: m.ep, createMs: m.createMs, warmupMs: m.warmupMs });
        }
        return;
      case 'RESULT': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        /**
         * EXACTLY THE DECLARED SHAPE, rebuilt rather than passed through. The
         * worker's message also carries `type` and `id`, which are this
         * protocol's business and not the seam's; a caller that started reading
         * them would be reading `WorkerBackend`'s wire, and the next backend
         * would have to invent them. `mix` and `stems` are the same two buffers
         * that went out — see the transfer rule at the head of this file.
         */
        p.resolve({
          mix: m.mix, stems: m.stems, prepMs: m.prepMs, inferMs: m.inferMs, postMs: m.postMs,
        });
        return;
      }
      case 'ERROR': {
        const p = m.id != null && this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); p.reject(new Error(m.message)); return; }
        if (this.loadGate) {
          const g = this.loadGate;
          this.loadGate = null;
          g.rej(new Error(m.message));
          return;
        }
        // Nothing is waiting. The worker is still alive — this is a report, not
        // a death — so it is not `die()`: the session is latched as failed by
        // whoever owns session state, and the next call still reaches a worker.
        this.onFail(new Error(m.message));
        return;
      }
      default:
    }
  }

  /**
   * @type {import('../shared/host.js').Backend['load']}
   *
   * TRANSFERS `bytes`. The caller must treat it as detached from here on, and
   * the Host that supplied it must hand over a fresh buffer per call — two decks
   * each ask, and the second would otherwise be handed a 0-byte array
   * (`shared/host.js`, model-bytes rule 2).
   */
  async load(bytes, onProgress = () => {}) {
    // The ONE place a dead worker is replaced — see `spawn()` for why it is here
    // and not in `separate()`.
    if (!this.worker && !this.disposed) this.spawn();
    const missing = await this.probe;
    if (missing) throw new Error(missing);
    const w = this.require();
    this.progress = onProgress;
    const ready = new Promise((res, rej) => { this.loadGate = { res, rej }; });
    w.postMessage({ type: 'LOAD_MODEL', buffer: bytes }, [bytes]);
    try {
      return await ready;
    } finally {
      this.progress = null;
    }
  }

  /**
   * @type {import('../shared/host.js').Backend['separate']}
   *
   * `require()` IS CALLED BEFORE `pending.set`, and the order is the whole
   * point: a throw after the entry exists leaves something nothing will ever
   * settle, and `await separate(...)` then hangs for ever.
   */
  async separate(mix, out) {
    const w = this.require();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // BOTH BUFFERS ARE LENT, NOT GIVEN — see the transfer rule at the head of
      // this file. They come back in the RESULT and the caller re-adopts them.
      w.postMessage({ type: 'INFER', id, mix, out }, [mix, out]);
    });
  }

  /**
   * @type {import('../shared/host.js').Backend['dispose']}
   *
   * SYNCHRONOUS IN ITS BODY, because its last caller cannot await it: the
   * engine's `onTeardown` runs at `pagehide` and returns immediately (R5). The
   * `async` keyword is the interface's, not this implementation's.
   *
   * THE `DISPOSE` MESSAGE IS GONE, AND THAT IS THE DECISION RATHER THAN AN
   * OVERSIGHT. `deck.js` used to post it and call `terminate()` in the same
   * task, so `inference.worker.js`'s handler — an `await engine.session.release()`
   * — had no task to run in and essentially never ran; the second teardown path,
   * `pagehide`, never posted it at all. There is no ack on the wire to await,
   * either, so "post and hope" was the only shape available and it was
   * indistinguishable from not posting. `terminate()` is what actually releases
   * the ~1.7 GB wasm heap, and it is unconditional. A backend that CAN
   * acknowledge a graceful shutdown should await one here; this one cannot, so
   * it says so instead of pretending.
   *
   * IT SETTLES EVERYTHING IT TAKES AWAY, AND THAT IS A BEHAVIOUR CHANGE RATHER
   * THAN A PORT (S8, #9). `deck.js` cleared the pending map without rejecting it
   * and this file inherited that: every call in flight at teardown was left
   * unsettled for ever. Nothing times an inference out and there is no cancel
   * path, so `await separate(...)` inside `LivePipeline.runChunk` simply never
   * returned — Review finding M1 arriving through the one door `die()` does not
   * cover, because a deliberate teardown is not a death.
   *
   * IT IS NOT `die()`, for exactly that reason. `die()` announces through
   * `onFail`, and `Deck`'s `onFail` latches `session = 'error'` and logs
   * `ERROR [deck A backend]`. Giving a backend back on purpose is not an error
   * and must not be reported as one, so the rejection here is silent to
   * everything except the calls it settles.
   *
   * THE REASON IS RECORDED AS WELL AS THROWN. `serialiseBackend` does NOT queue
   * `dispose()` — teardown is the moment you most need to stop a backend that is
   * not answering — so calls can still be sitting in that queue when this runs,
   * and each of them reaches `separate()` afterwards. `require()` is what refuses
   * them, out of `deadReason`; without a reason recorded here it would tell a
   * caller the backend "is not running and reported no reason" about a teardown
   * this very method performed.
   *
   * BOTH MESSAGES NAME THE BACKEND. Two decks own one each, they fail
   * independently, and "the inference worker is gone" names neither.
   */
  async dispose() {
    const w = this.worker;
    this.disposed = true;
    this.worker = null;
    this.deadReason = `${this.name}: the inference backend was disposed — a backend given back does not come back`;
    const gone = new Error(`${this.name}: the inference backend was disposed with a call still in flight — `
      + 'its worker is terminated, so nothing will ever answer it');
    for (const [, p] of this.pending) p.reject(gone);
    this.pending.clear();
    if (this.loadGate) { const g = this.loadGate; this.loadGate = null; g.rej(gone); }
    this.progress = null;
    if (w) { w.onmessage = null; w.onerror = null; w.terminate(); }
  }
}
