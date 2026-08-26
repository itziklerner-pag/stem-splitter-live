/**
 * THE HOST SEAM — what the unit asks of whatever is hosting it.
 *
 * The unit is the engine and the deck. It runs inside a HOST. Today the only
 * Host is this Chrome extension; ADR 0001 decision 5 builds the seam here
 * first — in the tree the existing gates already cover — so that a second Host
 * can be written against a declared interface instead of against a grep for
 * `chrome.`.
 *
 * A Host is a MODULE NAMESPACE, not a class, and each context imports exactly
 * one of them (`offscreen/host.js` for the engine; `ui/host.js` for the deck).
 * That shape is forced rather than chosen: `embed.html` is served under the
 * manifest's `script-src 'self'`, which blocks an inline `<script>boot(host)`
 * at parse time, and the deck's markup is part of the unit. A static `import`
 * from a sibling module is the only way a Host object reaches the code that
 * needs it.
 *
 * THIS FILE HAS NO IMPORTS, NAMES NO `chrome.*` AND TOUCHES NO DOM, and that is
 * a constraint rather than a coincidence: it is the one file both halves of the
 * seam share, so it has to stay readable by the unit and by a host that is not
 * a browser extension at all.
 *
 * WHY A BOOT-TIME CHECK AND NOT A TYPE. There is no type checker in this
 * build's pipeline, so the typedef below is documentation and nothing more. A
 * Host that forgets a duty would otherwise surface one layer down from the
 * mistake and at the worst possible moment: a missing `captureStream` reads as
 * `host.captureStream is not a function` at the instant the user arms a tab,
 * inside the one code path that must not fail halfway (R5 — a capture that
 * throws after the track exists must still stop the track, or the tab is left
 * permanently silent). `assertHost()` moves that failure to module evaluation,
 * before any track exists, and names the duty that is missing.
 *
 * The deck's half of the seam fails just as late and even more quietly: a
 * `DeckHost` short `send` throws at a user gesture several minutes in, and one
 * short `onMessage` is a deck that simply never paints, with nothing in the
 * console at all. `assertHost()` is the cheapest thing that turns "the deck is
 * blank" into a sentence.
 */

/**
 * @typedef {object} EngineHost
 *
 * @property {(msg: object) => void} send
 *   Deliver `msg` to the deck. The Host adds the envelope and swallows delivery
 *   failure: there is frequently no listener at all, and one unhandled
 *   rejection per 10 Hz heartbeat floods the console. MUST return undefined
 *   rather than a promise — twenty-two call sites end a `case` with
 *   `return send({...})` inside an `async` function, and a returned promise
 *   would be awaited there. MUST be usable at module-evaluation time, for the
 *   same reason `assetUrl` must be synchronous: the engine sends its boot
 *   `HELLO` from module scope, so a Host that needs a handshake before its
 *   transmit path opens has to QUEUE rather than drop. Nothing downstream
 *   retries and no gate would notice the loss.
 *   IT IS A FAN-OUT, NOT A POINT-TO-POINT LINK — and something already relies
 *   on that. This Host is `chrome.runtime.sendMessage`, a broadcast, and the
 *   deck is not the only listener on `to: 'ui'`: `ui/welcome.js:92` paints the
 *   model-download progress off the same `STATE` messages. A second Host that
 *   delivers only to the deck loses the setup page's progress bar, silently.
 *
 * @property {(fn: (msg: object) => void) => void} onMessage
 *   Register the engine's inbox. The Host owns the "is this addressed to the
 *   engine" routing guard, and hands `fn` the RAW envelope — normalising,
 *   re-wrapping or filtering it breaks receivers quietly. `fn` returns nothing
 *   and is never awaited.
 *   WHAT THE HOST MUST ORIGINATE — the undeclared half of this seam, and the
 *   larger half of what a second Host has to supply. Three of the engine's
 *   messages come from the Host itself rather than from the deck:
 *   `CAPTURE_START { streamId, source: { tabId, title, url }, deck? }`,
 *   `CAPTURE_STOP { deck? }` and `DECK_PREPARE { deck? }`. Two of those field
 *   names are still Chrome's. The capture PARAMETER is `sourceToken` and
 *   opaque, but the WIRE field is still `streamId`, and `source.tabId` is a tab
 *   id under a Host that need not have tabs — this engine's own dev paths
 *   already write `tabId: null` to satisfy a shape nothing reads. Nothing
 *   breaks, because both values are opaque to the unit; the names are wrong
 *   rather than the behaviour. Renaming them means editing the sender, which is
 *   host-side (`sw/service-worker.js:249`) and outside this seam's files, so
 *   S11 owns it as part of freezing Host interface v1.
 *
 * @property {(sourceToken: unknown) => Promise<MediaStream>} captureStream
 *   Open the audio of the Source that `sourceToken` names. The token is OPAQUE
 *   to the unit: the Host mints it (this one via the service worker's
 *   `chrome.tabCapture.getMediaStreamId`) and the engine only carries it back.
 *   MUST REJECT rather than resolve null — every caller is `.catch`-wrapped,
 *   and a null would travel on as a capture with no track.
 *   OWNERSHIP TRANSFERS to the engine, which stops the tracks (R5). The Host
 *   must not hold the stream or stop it itself.
 *
 * @property {(relPath: string) => string} assetUrl
 *   Resolve a unit-relative path — no leading slash — to something
 *   `audioWorklet.addModule()` and the inference worker's `INIT` can load. MUST
 *   be synchronous: it is called from constructors that run before there is an
 *   AudioContext to await on.
 *   THREE OBLIGATIONS THAT THE TYPE DOES NOT SHOW, each broken by accident by a
 *   plausible second Host, and none of them inferable from `=> string`:
 *   1. A PATH ENDING IN `/` RESOLVES TO A DIRECTORY URL AND KEEPS THE TRAILING
 *      SLASH. `offscreen/deck.js` hands `assetUrl('vendor/ort/')` to the
 *      inference worker's `INIT` and ONNX Runtime appends its own file names to
 *      it. `path.join()` and `url.pathToFileURL()` — the first two things a
 *      Node or Electron Host reaches for — both drop a trailing slash, and R0
 *      measured what that costs: ORT throws "w is not a function" several
 *      layers from the mistake. Review measured the gate's blind spot as well:
 *      strip the slash inside THIS Host and every unit-side assertion stays
 *      green, because each one resolves through a stub of its own. `test.js`'s
 *      `host` group therefore holds the shipped implementation to this rule
 *      directly, not only through the graph.
 *   2. THE RESULT MUST BE FETCHABLE, with a readable `.ok`. `deck.js` probes the
 *      ORT bundle with `fetch(url, { method: 'HEAD' })` before it spawns a
 *      worker, because a module worker that cannot resolve its static import
 *      fires `onerror` with an EMPTY message. A scheme `fetch` refuses turns
 *      that probe into a false report about a file that is present: `file://`
 *      is refused outright in Chromium, and an Electron custom scheme needs
 *      `registerSchemesAsPrivileged({ privileges: { supportFetchAPI: true } })`.
 *   3. THE URL MUST BE LOCAL TO THE UNIT'S OWN BUNDLE. M1 — no remote code — is
 *      a rule about what executes, and everything this duty resolves executes:
 *      three worklet modules and the ORT wasm runtime. A Host answering with a
 *      remote origin would put remote code on the audio thread through a duty
 *      whose name says nothing about it, and `SECURITY.md` promotes M1 to a
 *      security property. This is the one duty on this interface that can break
 *      it.
 *   AND IT IS THE ONE DUTY THAT TRAVELS DETACHED: `offscreen/engine.js` copies
 *   it onto the `shared` bundle the decks take and passes it to `MasterBus` as
 *   a constructor argument, so it is called unbound. See `assertHost` below.
 *
 * @property {(fn: () => void) => void} onTeardown
 *   Register the engine's last-gasp teardown, run when the context the engine
 *   lives in is going away. SYNCHRONOUS: `fn` will not be awaited, so it does
 *   the one thing that cannot wait — stopping the capture tracks, which is what
 *   holds the user's tab muted (R5).
 *
 * @property {(onProgress?: (phase:'cache'|'download', got:number, total:number)=>void)
 *   => Promise<{bytes: Uint8Array, fromCache: boolean}>} modelBytes
 *   Hand over the model weights, from wherever this Host keeps or gets them.
 *   A BYTE SOURCE AND NOTHING MORE — see the three rules below.
 *   THE UNIT TAKES OWNERSHIP OF `bytes`: it transfers `bytes.buffer` into the
 *   inference worker, so the Host must hand over a FRESH buffer each call and
 *   must not read it afterwards. Rule 2 says what that means and why a
 *   memoizing Host is the shape this catches.
 *   `onProgress` is OPTIONAL and the Host announces its phase BEFORE any bytes
 *   move: `fromCache` in the result arrives ~2 minutes too late to choose the
 *   wording on a progress card, and `ui/welcome.js` reads the phase to decide
 *   whether the card may quote a percentage at all.
 *
 * @property {() => Promise<boolean>} modelCached
 *   Would `modelBytes()` cost a download? Answered WITHOUT reading the bytes:
 *   the setup page and the deck both ask at boot, before any gesture, and an
 *   answer that costs a 109 MB read is an answer nobody can afford to ask for.
 *   `false` when unsure — the deck's question is "may I spend the user's data",
 *   and a wrong `true` spends it without asking. RESOLVES, NEVER REJECTS, and
 *   that is this duty's alone among the three: `engine.js`'s `STATUS` case
 *   awaits it before `ensureWorker()`, `echoXf()` and `push()`, so a rejection
 *   there is not a model error — it is a deck that paints nothing at all, with
 *   the reason written to a field nothing reads. A Host whose storage can be
 *   unavailable answers `false` and lets the download offer stand.
 *
 * @property {() => Promise<void>} clearModel
 *   Throw away whatever `modelBytes` would serve from store, so the next call
 *   goes back to source. The unit calls it for exactly one reason: the bytes it
 *   was handed failed the identity check, and bytes that failed must not be
 *   left where the next load finds them.
 *   A HOST THAT EVER REPORTS `fromCache: true` MUST REALLY DROP THAT STORE —
 *   one that silently ignores this turns one corrupt download into a
 *   permanently dead deck, failing identically for ever with no way out but
 *   clearing browser storage by hand. The MUST is scoped that way on purpose,
 *   because a Host whose bytes are immutable — the file vendored next to the
 *   binary that `offscreen/host-pin.js` names as a legitimate second shape —
 *   has nothing to throw away and would otherwise have to satisfy this duty by
 *   lying. It reports `fromCache: false`, the unit stops after one ask (rule
 *   3), and its `clearModel` is honestly a no-op.
 *   MAY REJECT (a locked file, an IPC round trip): the unit does not let a
 *   failed clear replace the integrity error that caused it, and the two-ask
 *   ceiling holds regardless.
 *
 * @property {(hooks?: {name?: string,
 *                      onReady?: (info: {threads: number|null, adapter: object|null}) => void,
 *                      onFail?: (err: Error) => void}) => Backend} createBackend
 *   Build ONE inference backend — the thing that turns 7.8 s of stereo mix into
 *   six stereo stems. This is seed §16's option S2, the AUDIO-LEVEL seam: what
 *   crosses it is waveforms, so the STFT/iSTFT and the model graph are both
 *   INSIDE the backend and neither is on this interface. Today's only
 *   implementation is `engine/workerbackend.js`, which drives
 *   `workers/inference.worker.js` — ONNX Runtime on WebGPU, falling back to
 *   threaded wasm.
 *   A FRESH INSTANCE PER CALL, AND ONE PER DECK. `offscreen/deck.js:18-25` is
 *   the reason and it is not negotiable in either direction: ORT-Web serialises
 *   `run()` across every session sharing a wasm instance and a concurrent call
 *   PERMANENTLY WEDGES the session, so two decks must not share one backend —
 *   and two sessions must not share one worker. A Host that memoises this and
 *   hands both decks the same object re-opens exactly that grenade.
 *   CALLED LAZILY, and the laziness is the unit's: deck A's backend is built at
 *   boot so the deck can report the GPU it found, deck B's on its first
 *   `LIVE_START`, because each ORT session peaks at ~1.7 GB of wasm heap. So a
 *   Host must not do anything at `createBackend()` time that a user who never
 *   arms a second deck should not pay for.
 *   SYNCHRONOUS, and it returns the Backend rather than a promise to one: it is
 *   called from `Deck.ensureBackend()`, which runs at engine module scope. A
 *   backend that needs to spawn a process starts it here and lets `load()` be
 *   where the waiting happens.
 *   `hooks` ARE THE UNIT'S, NOT THE HOST'S, and they carry the two things that
 *   arrive outside any call the unit made: `onReady` once the backend knows what
 *   hardware it got (the deck mirrors it into `STATE.boot`), and `onFail` when
 *   the backend dies with nothing in flight — a worker killed for memory, a
 *   module that would not resolve. Without `onFail` that death is silent until
 *   the next arm, and the deck goes on reporting a session it no longer has.
 *   `name` is a human label used only in error messages ("deck A").
 */

/**
 * THE THREE RULES A HOST'S MODEL BYTES HAVE TO HOLD (S7, issue #5). All three
 * are here rather than in `offscreen/host.js` because they are what the UNIT
 * needs, not what Chrome happens to do.
 *
 * 1. THE HOST DOES NOT VERIFY, AND IS NEVER ASKED TO. The SHA-256 and the byte
 *    count live in `shared/config.js` and are checked by
 *    `shared/modelcache.js::verifyModel` over whatever arrives, on EVERY load.
 *    A Host that verified would be a Host that could decline to, and M1 is not
 *    a property the unit can delegate: the whole point of moving `MODEL.url`
 *    out of the unit is that WHERE the bytes come from stopped being the unit's
 *    business at the same moment WHAT they must be stopped being the Host's.
 *    `fetch` and the Cache API are not `chrome.*`, so no grep on the unit can
 *    catch a Host that got this wrong — only this sentence and the checks that
 *    encode it.
 *
 * 2. `bytes` OWNS ITS WHOLE BUFFER, AND IT IS FRESH EVERY CALL. The unit
 *    TRANSFERS `bytes.buffer` into the inference worker, which is the source of
 *    both halves of this rule.
 *      - A `Uint8Array` that is a VIEW into something larger transfers the
 *        larger thing, and the worker binds a session over the wrong offset:
 *        the unit verified the view and loaded the buffer, so the bytes that
 *        passed the check are not the bytes that ran.
 *        `byteOffset === 0 && byteLength === buffer.byteLength`.
 *      - A transfer DETACHES the buffer, so a Host must return a NEW one per
 *        call and must not read it after the call returns. Memoizing the bytes
 *        is the obvious optimisation once they arrive over IPC or off a
 *        vendored file, and it is wrong here: two decks exist and each one
 *        asks, so the second load would be handed a 0-byte array.
 *    `shared/modelcache.js::requireWholeBuffer` ENFORCES both, on every load,
 *    and names which of the two went wrong — because both surface late and
 *    under the wrong cause otherwise (an ORT session error long after a green
 *    integrity check; an integrity failure blaming the Host's bytes for a
 *    transfer the unit did).
 *
 * 3. `fromCache` IS LOAD-BEARING, NOT TELEMETRY. It is how the unit decides
 *    whether a failed check is worth one retry: bytes from a store can be
 *    dropped and re-fetched, bytes straight off the wire cannot be improved by
 *    asking twice. A Host that always reports `true` turns every corrupt
 *    download into a second corrupt download; one that always reports `false`
 *    turns a corrupt stored copy into a permanent failure.
 */

/**
 * The duties an `EngineHost` owes, each mapped to WHAT IT IS FOR rather than to
 * its type. The sentence is not decoration: it is what `assertHost()` puts in
 * the error, so whoever wrote the incomplete Host is told what the unit wanted,
 * not merely which identifier came back undefined.
 */
export const ENGINE_HOST_DUTIES = Object.freeze({
  send: 'deliver a message from the engine to the deck, and to anything else listening',
  onMessage: 'hand the engine every message addressed to it',
  captureStream: 'open the audio of the Source a token names, and hand the engine the stream',
  assetUrl: 'resolve a unit-relative asset path the audio graph can load',
  onTeardown: "run the engine's teardown when this context goes away",
  modelBytes: 'hand over the model weights, from wherever this Host keeps or gets them',
  modelCached: 'say whether the weights are already here, without reading them',
  clearModel: 'throw away the stored weights, so the next load goes back to source',
  createBackend: 'build one inference backend — the thing that turns a mix into six stems',
});

/**
 * @typedef {object} Backend
 *
 * THE AUDIO-LEVEL SEAM (seed §16, option S2). Waveforms in, waveforms out: the
 * STFT/iSTFT and the model graph live INSIDE an implementation, which is what
 * makes a native backend able to replace the slowest stage rather than inherit
 * it. `engine/workerbackend.js` is backend #1 and today the only one.
 *
 * THE SIGNATURE THE PLAN DECLARED, AND WHY THIS IS NOT IT. The plan wrote
 * `separate(mix Float32Array[2·SEGMENT]) -> six stereo stems`, and eleven lines
 * later required that today's zero-copy transfers not change. Both cannot hold.
 * The shape below is the second reading, because the first loses four things
 * that are load-bearing rather than incidental:
 *   1. THE CALLER-SUPPLIED OUTPUT BUFFER. `LivePipeline` allocates `mixBuf` and
 *      `outBuf` ONCE PER SESSION (19.4 MB at six stems) and lends them for one
 *      segment. Returning fresh arrays instead costs 16.5 MB of garbage per hop
 *      — about 8.5 MB/s at hop 1.95 — on the one thread that must not pause.
 *   2. THE MIX ROUND TRIP, for the same reason: 2.75 MB per hop.
 *   3. ONE FLAT BUFFER, NOT SIX ARRAYS. `engine/demucs.js` writes a single flat
 *      `Float32Array` laid out `(k*2 + ch)*SEGMENT + i` and `offscreen/live.js`
 *      builds twelve `subarray` VIEWS over it with no copy. Six objects would be
 *      six copies.
 *   4. A `Float32Array` CANNOT GO IN A TRANSFER LIST. Only its buffer can.
 * So "six stereo stems in `STEMS` order" survives as a documented property of
 * `stems` — `STEMS.length * 2` planes of `SEGMENT` floats, stem-major, left
 * before right — rather than as six objects. `tools/model-parity.mjs` is what
 * holds the ORDER; this interface holds the LAYOUT.
 *
 * DEMOTION IS NOT ON THIS INTERFACE. `GpuScheduler` decides whether a chunk runs
 * at all and returns `{demoted:true}` BEFORE the backend is ever called; that is
 * cross-deck policy and it stays in `Deck.infer`. A backend either separates or
 * throws.
 *
 * @property {(bytes: ArrayBuffer,
 *             onProgress?: (phase: string, note?: string) => void)
 *   => Promise<{ep: string, createMs: number, warmupMs: number}>} load
 *   Take the weights and become able to `separate`. IT TAKES OWNERSHIP OF
 *   `bytes` and may transfer it — `WorkerBackend` does, because the alternative
 *   is 109 MB duplicated across a thread boundary at the peak-memory moment —
 *   so the caller must treat the buffer as detached the instant it calls this,
 *   and the Host that supplied the bytes must hand over a fresh buffer per call
 *   (`modelBytes`, rule 2 above).
 *   `onProgress(phase, note)` reports the stages a 109 MB model load has and a
 *   caller cannot infer: `'session'` while the graph is being compiled (with a
 *   `note` when the EP falls back), `'warmup'` for the first inference, which is
 *   843-2584 ms of shader compile against ~450 ms steady. The resolution carries
 *   which EP actually took the model, so the deck can say `webgpu` or `wasm`.
 *
 * @property {(mix: ArrayBuffer, out: ArrayBuffer)
 *   => Promise<{mix: ArrayBuffer, stems: ArrayBuffer,
 *               prepMs: number, inferMs: number, postMs: number}>} separate
 *   Separate ONE segment. `mix` is `2 * SEGMENT` floats, left channel then
 *   right; `out` is `STEMS.length * 2 * SEGMENT` floats and is where the stems
 *   are written.
 *   BORROW AND RETURN, WHICH IS THE WHOLE OF THE ZERO-COPY CONTRACT. Both
 *   buffers may be transferred away and BOTH MUST COME BACK in the resolution —
 *   `mix` as the same buffer, `stems` as the buffer `out` became. The caller
 *   re-adopts them for the next segment. A backend that keeps either, or that
 *   returns a copy, turns a per-session allocation into a per-hop one.
 *   AND IF IT THROWS, IT MAY KEEP THEM: the caller reallocates on the failure
 *   path rather than assuming. What it must NOT do is transfer them and then
 *   return something that is not them.
 *   ONE CALL IN FLIGHT AT A TIME is guaranteed by the UNIT, not asked of the
 *   backend — see `engine/backend.js`.
 *
 * @property {() => Promise<void>} dispose
 *   Give the machine back. MUST START ITS TEARDOWN SYNCHRONOUSLY: the last
 *   caller is the engine's `onTeardown`, which does not await (R5), so whatever
 *   is not done before this returns is not done at all. `WorkerBackend`
 *   terminates the worker on the spot, which is what releases the ~1.7 GB wasm
 *   heap.
 */

/**
 * The duties a `Backend` owes. Checked with `assertHost` — the same function,
 * for the same reason one level in: `host.createBackend()` is the one duty
 * whose RETURN VALUE the unit then calls, so a Host that answers it with the
 * wrong shape is a Host that passes every boot check and fails at the first
 * arm, which is the failure `assertHost` exists to move earlier.
 */
export const BACKEND_DUTIES = Object.freeze({
  load: 'take the model weights and become able to separate',
  separate: 'separate one segment of mix into six stereo stems',
  dispose: 'give the machine back',
});

/**
 * Refuse to boot on a Host that cannot do the job, and say which job.
 *
 * FAILS WHEN IT CANNOT LOOK, in both of the two ways it could be blind:
 *
 *   - An ABSENT host. `!host || host.send` — the shape this function exists to
 *     replace — reports "the Host supplied everything" most confidently when
 *     there is no Host at all. That is the exact green-on-nothing failure
 *     `AGENTS.md` calls out as the one a seam check is most prone to, so a
 *     missing host is the loudest error here rather than the quietest.
 *   - An EMPTY duty list. A caller that passes `{}` — or a duties module that
 *     lost its export — would otherwise wave every object through. Nothing can
 *     be asserted about a Host when nothing was asked of it, so that throws too.
 *
 * A DUTY MUST BE CALLABLE. `typeof host[k] === 'function'` and nothing weaker:
 * an object where a function was meant is the likeliest wrong shape — an
 * Electron preload bridge wrapped one level too deep hands over `{ send: fn }`
 * — and waving it through returns the seam to the failure this check exists to
 * move, `host.send is not a function` at the first gesture. A future duty that
 * is genuinely a namespace was to be declared as its own callable duties, or
 * this check widened deliberately with the widening asserted — never widened by
 * accident. S4 TOOK THE FIRST BRANCH: the deck's storage arrived as three FLAT
 * duties (`storageGet`, `storageSet`, `onStorageChanged`) rather than as a
 * `storage` namespace carrying `get`/`set`/`onChanged`, so this line still
 * reads `=== 'function'` and the not-callable refusal below still has teeth.
 * The cost is four more names in a duty list; what it buys is that the one
 * thing this check does is still the thing it does.
 *
 * A DUTY MAY BE CALLED UNBOUND, and one already is. A Host is a module
 * namespace and the unit treats its duties as plain functions: rather than
 * calling `host.assetUrl(...)` at each site, `offscreen/engine.js` hands
 * `host.assetUrl` ITSELF to `MasterBus` and to every deck. A duty implemented
 * as a method that needs its `this` — an object literal with shorthand methods
 * closing over a root path, an Electron preload bridge — passes this check,
 * works for the four duties the engine calls through the namespace, and fails
 * only at the first worklet load, which is the late half-wired failure the seam
 * exists to move earlier. Bind it, or close over what it needs.
 *
 * IT HAS TWO CALLERS — `offscreen/engine.js` for `ENGINE_HOST_DUTIES` and
 * `ui/embed.js` for `DECK_HOST_DUTIES`. AGENTS.md counts five defects here that
 * were a value being right at one call site and wrong at another, so the
 * assertions in `test.js` name the list they check, never "a host".
 *
 * @param {object} host    the module namespace the context imported
 * @param {Record<string, string>} duties  duty name -> what it is for
 * @param {string} what    the interface's name, for the message
 * @returns {object} `host`, so a caller can check and bind in one expression
 */
export function assertHost(host, duties, what = 'Host') {
  const names = duties ? Object.keys(duties) : [];
  if (!names.length) {
    throw new Error(`${what}: no duties were declared, so this check has no coverage — `
      + 'assertHost was handed an empty duty list and would accept any object at all.');
  }
  if (!host || (typeof host !== 'object' && typeof host !== 'function')) {
    throw new Error(`${what}: no host module was supplied (got ${host === null ? 'null' : typeof host}). `
      + `It owes ${names.length} duties: ${names.join(', ')}.`);
  }
  const missing = names.filter((k) => typeof host[k] !== 'function');
  if (missing.length) {
    throw new Error(`${what} is missing ${missing.length} of its ${names.length} duties: `
      + missing.map((k) => `${k}() — ${duties[k]}`).join('; '));
  }
  return host;
}

/* ========================================================================= */
/* DeckHost — the deck's Host (S3, issue #3). APPEND BELOW, do not reorder.  */
/* ========================================================================= */

/**
 * The deck's Host. EIGHT members: the bus (`send` + `onMessage`), storage
 * (`storageGet`, `storageSet`, `onStorageChanged`) and the arm chord
 * (`armShortcut`) from S4, plus the page the deck is drawn into and the player
 * above it when there is one, from S5.
 *
 * `page` and `transport` are NAMESPACES rather than callable duties, so they are
 * deliberately not in `DECK_HOST_DUTIES` — `assertHost` requires
 * `typeof host[k] === 'function'` and nothing weaker, which is also why S4's
 * storage is three flat duties rather than a `storage` namespace. Each of the
 * two is gated by its own duty list at the deck's boot instead:
 * `assertHost(host.page, DECK_PAGE_DUTIES, …)` and `assertHostOption(host,
 * 'transport', DECK_TRANSPORT_DUTIES, …)`, both at `extension/ui/embed.js`
 * module scope, and `test.js` asserts that the deck really does call all three
 * there rather than only that they refuse when called from a suite.
 *
 * @typedef {object} DeckHost
 *
 * @property {(msg: object) => void} send
 *   Put one FINISHED message on the bus. Returns nothing, and delivery failure
 *   is the Host's to swallow.
 *
 * @property {(fn: (msg: object) => void) => void} onMessage
 *   Call `fn` for each message addressed to THIS context, with the raw
 *   envelope. What `fn` returns is dropped.
 *
 * @property {(area: 'local'|'session', key: string) => Promise<unknown>} storageGet
 *   Read back the value stored at `key`, or `null` if nothing is stored there.
 *   ABSENT RESOLVES `null`; A FAILED READ REJECTS, and the two must not be
 *   folded together. A fresh profile holds no preferences and that is the
 *   ordinary case, not a fault. Storage that could not be READ is a fault, and a
 *   Host that answered `null` for it would tell the deck "the user has no
 *   preferences" on precisely the run where it could not tell — the
 *   green-on-nothing shape AGENTS.md is written against. Both readers carry
 *   their own catch already, so rejecting costs nothing and says something.
 *   WHAT THE HOST MUST ORIGINATE — the undeclared half of the deck's storage,
 *   and the counterpart of the clause `EngineHost.onMessage` carries above. One
 *   of the two keys the deck reads is written by NOBODY IN THE UNIT: the durable
 *   arm refusal at `ARM_ERROR_KEY` (`shared/config.js`) in the `'session'` area
 *   is written and removed entirely by the Host — in this Host by the service
 *   worker (`sw/service-worker.js`: `raiseArm()` writes
 *   `{ code, message, at, seq }` — `at` in EPOCH milliseconds, because the
 *   record is written in one context and read in another and
 *   `performance.now()`'s origin is per-context; `seq` monotonic, because it is
 *   the record's identity on the dismissal path. The reader also accepts an
 *   optional `deck`. `clearArm()` removes the record on every successful arm,
 *   which is what stops a stale refusal outliving the problem it described). A Host that implements all six
 *   duties perfectly and never writes that record is not broken in any way a
 *   gate can see: the deck simply never explains a refusal to arm, which is the
 *   one failure this read exists for. The other key, `PREFS_KEY` in `'local'`,
 *   the unit writes itself and the Host need only store.
 *
 * @property {(area: 'local'|'session', key: string, value: unknown) => void} storageSet
 *   Store `value` at `key`. Fire and forget, exactly like `send`: MUST return
 *   undefined rather than a promise, and the Host swallows the failure. The one
 *   caller is a checkbox and a picker whose truth is already on screen; there is
 *   nothing a rejected write could tell the user that the next read would not
 *   tell them better.
 *   SWALLOWING IS FOR A WRITE THAT FAILED, NOT FOR AN AREA THAT WAS NEVER ASKED
 *   FOR: see rule 5 for the area refusal, which is the deck being wrong rather
 *   than the platform, and is loud on purpose.
 *
 * @property {(area: 'local'|'session', key: string, fn: (value: unknown) => void) => void} onStorageChanged
 *   Call `fn` with the NEW VALUE whenever `key` changes in `area`. The Host owns
 *   the area/key filter for the same reason it owns the address guard on
 *   `onMessage`: the platform delivers changes in whatever batched shape it
 *   likes, and unpicking that shape is transport work. `fn` returns nothing.
 *   IT IS NOT SUGAR OVER `storageGet`. The deck is not the only writer of what
 *   it reads — the same key is written by a second deck in a second tab and read
 *   by the extension host's own content script — so a deck that read only at
 *   boot would sit there disagreeing with the behaviour the user is watching.
 *
 * @property {() => Promise<string|null>} armShortcut
 *   The accelerator this platform has bound to the arm gesture, AS THE PLATFORM
 *   SPELLS IT (`'Ctrl+Shift+9'`; or `'⌃⇧9'`, because Chrome hands macOS back
 *   already drawn), or `null` when nothing is bound.
 *   RAW, NOT RENDERED, and that split is why this is one duty and not two.
 *   Turning an accelerator into the pair of strings a surface DRAWS and
 *   ANNOUNCES is `chordLabel()` in `ui/embed-state.js`: unit code, gated without
 *   a browser, and already wrong once in a way no Host would have got right on
 *   its own — a chord drawn in words was announced as a graphic on every
 *   non-Mac machine, suppressing text a screen reader could already read. A Host
 *   that returned the rendered pair would be a second copy of that judgement per
 *   Host, outside the gate that caught it.
 *   `null` RATHER THAN `''`, because "no chord is bound" is a different sentence
 *   for the caller to print, not an empty key cap.
 *   RAW IS NOT THE SAME AS ARBITRARY, and this is the implicit half of the
 *   contract made explicit: the unit spells the string with `chordLabel()`,
 *   whose vocabulary is `MacCtrl`, `Ctrl`, `Command`, `Alt` and `Shift` — the
 *   `chrome.commands` manifest tokens — plus the four glyphs `⌃ ⌘ ⌥ ⇧` that
 *   Chrome hands back already drawn on macOS. `'+'` separates tokens; glyphs may
 *   simply be concatenated. ANYTHING ELSE IS DRAWN ON THE KEY CAP VERBATIM, so a
 *   Host answering in its own accelerator grammar — Electron's
 *   `'CommandOrControl+Shift+9'`, or `'Super+…'` — puts the word
 *   "CommandOrControl" in front of the user. It renders, so nothing goes red;
 *   the failure is entirely cosmetic and entirely silent, which is why the token
 *   set is written down here rather than left to be discovered.
 *   AND THE SENTENCE AROUND THE CHORD IS STILL THIS PLATFORM'S. The deck's
 *   not-armed hint reads "Click the Stem Splitter Live toolbar icon on this tab
 *   to arm it, or press <chord>", and a Host with no toolbar and no tabs has no
 *   truthful version of the first half — `null` here is exactly the branch such
 *   a Host takes, and it prints that sentence alone. The string predates the
 *   seam and is left in the unit deliberately for now; S11 owns deciding whether
 *   host-specific instruction prose is sourced from the Host or declared out of
 *   scope when it freezes Host interface v1.
 *
 * @property {DeckPage} page
 *   Where the deck is drawn: its keys, its height, its life on the page, and the
 *   host's autoplay-next report. EVERY DeckHost owes this, including one with no
 *   player at all — a deck still has to size itself and take its keys. Declared
 *   below, with `DECK_PAGE_DUTIES` as the list it must satisfy.
 *
 * @property {DeckTransport|null} transport
 *   The player the host's page is showing, or `null` — SPELLED, never merely
 *   omitted. `host.transport != null` is the single question that decides
 *   whether this deck is hosted, so a Host that meant to supply one and
 *   misspelled the key must not read as a Host that deliberately has none;
 *   `assertHostOption` below is what refuses the omission. Declared below, with
 *   `DECK_TRANSPORT_DUTIES` as its list.
 *
 * THE TWO STORAGE AREAS ARE A LIFETIME, AND THE UNIT NAMES WHICH ONE IT MEANT.
 * `'local'` outlives the browser; `'session'` lasts as long as this run of it.
 * They are a parameter and never a Host default, because the deck's two uses
 * differ in exactly that: a preference the user set must survive a restart, and
 * a refusal to arm must NOT — a stale one paints as current, which turns a fix
 * for a silent failure into a new false-alarm source. A Host that guessed would
 * be guessing about which of those two mistakes to make.
 */

/**
 * THE SEVEN RULES A `DeckHost` HAS TO HOLD. Each one is here because breaking it
 * is silent — the deck goes on looking exactly as it does now.
 *
 * 1. `send` TAKES A FINISHED MESSAGE. The `{ v: 1, to, from, ...payload }`
 *    envelope is the UNIT's protocol, not the host's: `to` is routing and the
 *    host is only the transport. A host that stamps, rewrites, normalises or
 *    filters the envelope breaks the two blocks in `tools/embed-smoke.mjs`
 *    that inject a raw `{v:1,to:'ui',from:'off',type:'LIVE_STATE',…}` from the
 *    service worker — and it breaks them QUIETLY, because a `LIVE_STATE` that
 *    never arrives leaves the previous value on screen.
 *
 * 2. `send` RESOLVES THE TRANSPORT AT CALL TIME, never at module load. Stated
 *    portably: a Host must not capture its transport at import. The reason it
 *    is a RULE and not a preference is local to this Host and lives with it, in
 *    `ui/host.js`: `tools/embed-smoke.mjs` replaces the *property*
 *    `chrome.runtime.sendMessage` after the deck has booted, and that patch is
 *    the only window onto the outgoing wire. A host that bound the function at
 *    import leaves the recorder empty, and `[].every()` and `![].some()` are
 *    both true, so the transpose-ceiling and speed/ad-gate assertions go GREEN
 *    while inspecting nothing.
 *
 * 3. `send` RETURNS NOTHING AND IS NEVER AWAITED, and delivery failure is the
 *    host's to swallow. On the extension bus there is frequently no listener
 *    at all, and one unhandled rejection per message — at 10 Hz, for the
 *    heartbeat — floods the console.
 *
 * 4. `onMessage` DELIVERS ONLY WHAT IS ADDRESSED HERE, and ignores what `fn`
 *    returns. Both are transport facts, and both are why they are the host's
 *    and not the deck's: the extension bus is a BROADCAST, so every context
 *    hears every message; and MV3 reads a truthy return from a listener as "I
 *    will call `sendResponse` later" and holds the channel open for it.
 *
 * 5. THE STORAGE AREA IS THE DECK'S TO NAME AND THE HOST'S TO HONOUR, never to
 *    default. `'local'` outlives the browser and `'session'` does not, and the
 *    deck's two uses are one of each on purpose: a preference must survive a
 *    restart, and a refusal to arm must not — a stale refusal painted as current
 *    turns a fix for a silent failure into a new false-alarm source, which is
 *    the more expensive of the two defects because it teaches the user to ignore
 *    the banner. A Host that picked one area for everything would be picking
 *    which of those two mistakes to make, silently, for both call sites.
 *    AND AN AREA OUTSIDE THOSE TWO IS REFUSED, not honoured and not ignored.
 *    `'local'` and `'session'` are the whole set the unit has words for, so a
 *    third is a call site that is wrong about a value it wrote itself — and on
 *    THIS Host it is also a P1 hazard, because `chrome.storage.sync` is a
 *    network write and the areas being a parameter is what first made it
 *    reachable from the deck at all. `storageGet` REJECTS (the deck's
 *    preferences read is a module-scope `.then().catch()` that a synchronous
 *    throw would jump past, taking the rest of boot with it, and one duty must
 *    not answer two ways); `storageSet` and `onStorageChanged` THROW at the call
 *    site, which is the cheapest place to be told. A Host that
 *    quietly substituted an area it did have would be inventing a lifetime the
 *    deck never asked for.
 *
 * 6. `storageGet` SEPARATES ABSENT FROM UNREADABLE — `null` for the first, a
 *    rejection for the second. Folding them together is the `!x || (real check)`
 *    shape one layer out: the deck would apply its defaults most confidently on
 *    the run where storage could not be read at all, and a preference silently
 *    reset to default is indistinguishable from one the user chose.
 *
 * 7. `armShortcut` RETURNS THE ACCELERATOR RAW. The Host reads the binding; the
 *    unit spells it. A Host that returned a rendered chord would be re-deciding,
 *    per Host and outside the gate, a question this repo has already got wrong
 *    once: whether the announced form differs from the drawn one. It does on a
 *    glyph platform and must not anywhere else, and `chordLabel()` is where that
 *    is written down and checked.
 *
 * WHICH CONTEXT IS "HERE" is the one piece of unit protocol a second DeckHost
 * has to know, and today it is a literal in `ui/host.js` (`const ME = 'ui'`)
 * with its counterpart `from: 'ui'` on the other side of the seam in
 * `embed.js`. Note also that rule 1 is true of a BROADCAST transport and only
 * of one: on a point-to-point transport the Host must read `msg.to` to route
 * `'off'` from `'sw'`, which is envelope knowledge rule 1 otherwise says is not
 * the host's. Both are inputs to S11, which freezes this interface and owns
 * exporting the address set from `shared/config.js`.
 */
export const DECK_HOST_DUTIES = Object.freeze({
  send: 'put one finished message from the deck on the bus',
  onMessage: 'hand the deck every message addressed to it',
  storageGet: 'read one stored value back, from the area whose lifetime the deck named',
  storageSet: 'store one value, in the area whose lifetime the deck named',
  onStorageChanged: 'tell the deck when one stored value changes underneath it',
  armShortcut: 'report the key chord this platform has bound to the arm gesture',
});

/**
 * WHY `EngineHost.send` AND `DeckHost.send` ARE NOT THE SAME CONTRACT, now that
 * both are written down in one file and S11 is about to freeze them.
 *
 * `EngineHost.send` STAMPS the envelope (`{ v: 1, to: 'ui', from: 'off' }`);
 * `DeckHost.send` carries a finished one. Same bytes on the wire, two contracts
 * under one duty name, and that is deliberate rather than an oversight of the
 * integration:
 *
 *   - The engine has exactly ONE correspondent. Every message it sends is
 *     `to: 'ui'`, so an address parameter would be a constant at all 22 call
 *     sites, and `engine.js` keeps a non-host `send()` wrapper over the duty
 *     precisely so those sites stay `return send({ type: … })`.
 *   - The deck has TWO (`'off'` and `'sw'`). A stamping `DeckHost.send` would
 *     need the address passed in, which is the envelope crossing the seam by
 *     another route, and it would put the Host in a position to normalise what
 *     it stamps — the thing rule 1 exists to forbid.
 *
 * Reconciling them means changing behaviour on one side, so it is S11's call
 * and not the integrator's. What is not deferred is saying so: the asymmetry is
 * now a sentence in the file that gets frozen, rather than a difference a
 * second-host author discovers by reading both implementations.
 */

/* ========================================================================= */
/* DeckHost.page and DeckHost.transport (S5, issue #7). APPEND BELOW.        */
/* ========================================================================= */

/**
 * WHY THE DECK'S HOST HAS TWO MORE NAMESPACES, AND WHY THEY ARE TWO AND NOT ONE.
 *
 * The deck is drawn INTO something, and in this build that something also owns
 * a player the deck follows. Those are two different facts about a Host, and a
 * second Host can have the first without the second: a deck opened on its own,
 * a harness, or a window with no video in it is still drawn into a page.
 *
 * So `page` is a duty every DeckHost owes and `transport` is one it may
 * legitimately not have — and the deck asks the difference exactly once, as
 * `host.transport != null`. That question used to be `window.parent !== window`,
 * which is a fact about FRAMES rather than about hosting: under a desktop Host
 * the deck is the top-level document and yet it IS hosted, so the old test said
 * "nobody will ever tell me whether the video is playing", and `follow()` reads
 * that as licence to START THE PIPELINE ON BOOT — a capture, and behind it a
 * 109 MB model download, on a page nobody had pressed play on.
 *
 * They are NOT one namespace because the postMessage boundary carries more than
 * transport. `KEY`, `AUTONAV`, `HEIGHT`, `READY`, `CLOSE` and `DECK` are all
 * about the deck's life on somebody's page and none of them are about a player;
 * folding them into `transport` would leave a Host with no video unable to size
 * its own frame.
 */

/**
 * @typedef {object} DeckPage
 *   Where the deck is drawn. Every DeckHost owes this.
 *
 * @property {(fn: (d: {code: string, key: string, shift: boolean, alt: boolean,
 *   repeat: boolean}) => void) => void} onKey
 *   A key the HOST took out of its own page's hands and gave to the deck.
 *   `typing` is deliberately not carried: the host checked its own document,
 *   which is the only one that had a focus target, so the deck must not
 *   re-derive it against a document that never had one.
 *
 * @property {(fn: (d: {state: string}) => void) => void} onAutonav
 *   The host's report on suppressing its page's autoplay-next. Advisory: three
 *   of the states mean the feature is not working, and none of them may stop
 *   the deck.
 *   FLAGGED, NOT RECONCILED: THIS IS ONLY THE REPORT HALF. What actually tells
 *   the host to suppress is not a duty at all — the deck writes
 *   `prefs.autoplayNext` into `chrome.storage.local` and `content.js` reads the
 *   same key back, live, through an `onChanged` listener. A shared storage key
 *   is doing the work of a deck -> host instruction, so a second Host that
 *   implements all six page duties still has a dead autoplay checkbox. S4
 *   (issue #6) puts storage behind a duty, which does not by itself close this:
 *   the unit and the host would still be agreeing on a key name out of band.
 *   S11 owns declaring the instruction, the way it owns the `send` asymmetry.
 *
 * @property {(claim: {armed: boolean, keys: string[]}) => void} claimKeys
 *   Which key codes are the deck's right now, and whether a deck is armed at
 *   all. THE HOST MUST ACT ON IT: with no deck armed those keys belong to the
 *   page and must reach it untouched — we are a guest there. The list is sent
 *   rather than duplicated host-side, because it is the unit that knows which
 *   keys this build has.
 *
 * @property {(px: number) => void} setHeight
 *   How tall the deck has measured itself to be. Advice, not a command: this
 *   Host clamps it, and a Host that cannot resize may ignore it.
 *
 * @property {() => void} ready
 *   The deck has its handlers up. THE HOST OWES A RE-SEND of everything it
 *   reports on change — player state, speed, autoplay — because a deck mounted
 *   onto an already-playing video is the common case and "on change" would
 *   leave it blank until something moved.
 *
 * @property {() => void} close
 *   Take the deck off the page. THE AUDIO DOES NOT STOP: capture and separation
 *   live in the engine and never depended on this surface existing.
 */

/**
 * @typedef {object} DeckTransport
 *   The player the host's page is showing, if it has one. A DeckHost that has
 *   none declares `transport: null`.
 *
 * @property {(fn: (d: object) => void) => void} onState
 *   The player moved. PUSH, NEVER POLL — a contract, not a taste: the deck
 *   follows these transitions, and a poll misses every one that opens and
 *   closes between two samples.
 *   The payload this Host sends is `{playing, currentTime, duration, ended,
 *   playbackRate, hasMedia, adShowing, seeking}`, on every media event that can
 *   move any of them plus a ~4 Hz tick.
 *   WHAT THE DECK ACTUALLY READS is `playing`, `currentTime`, `duration`,
 *   `ended`, `playbackRate` and `seeking`. `hasMedia` and `adShowing` are on the
 *   wire but the unit never looks at them: they are consumed HOST-side, by
 *   `content.js`/`speed.js`, before the SPEED verdict is composed. A second Host
 *   that has no notion of an ad break owes them nothing beyond a value its own
 *   speed logic can read.
 *   FLAGGED, NOT RECONCILED: ADR 0001 decision 4 words the READ side as three
 *   values — `paused`, `currentTime`, `duration` — and the shipped payload is
 *   wider than that wording, by `ended`, `playbackRate` and `seeking`, all three
 *   of which the deck reads today. S11 freezes Host interface v1 and owns the
 *   reconciliation; narrowing the payload is an L1 decision and belongs to the
 *   owner, not to a seam slice.
 *
 * @property {(fn: () => void) => void} onJump
 *   The content moved under the deck — a seek, or the page swapping in another
 *   video. What is already in the ring is now audio from somewhere else.
 *
 * @property {(fn: (d: {state: string, why: string|null,
 *   applied: number}) => void) => void} onSpeedReport
 *   The host's verdict on the player's rate: whether one can be set at all
 *   right now, what it applied, and why not. It is the ONLY thing that greys
 *   the deck's speed control, and `why: 'yield'` is the only signal that can
 *   tell the page's own speed menu from the deck's write still in flight.
 *   `state` MUST BE THE LITERAL `'ok'` when a rate can be set. `speedGate`
 *   (`ui/embed-state.js`) ungreys on that one string and locks on every other,
 *   showing the state name to the user — so a Host that implements this
 *   signature faithfully and reports `state: 'playing'` ships a control that is
 *   permanently greyed, with no error anywhere. A transport that never reports
 *   at all leaves it locked as `'unreported'` forever.
 *   IT IS ALSO THE DECK'S PROOF THAT A TRANSPORT EXISTS. Only a transport can
 *   report, and `onSpeedReport` is the only writer of the state `speedGate`
 *   reads, which is why `setSpeed` calls `requestSpeed` with no
 *   `host.transport &&` in front of it. Anything that lets another path report
 *   `'ok'` breaks that, silently, at a user gesture.
 *
 * @property {(patch: {muted?: boolean, playbackRate?: number,
 *   currentTime?: number}) => void} drive
 *   Write the player, for the cached deck's clock lock. THE WRITE SET IS CLOSED
 *   AND IT IS ADR 0001 decision 4's: `muted`, `playbackRate`, `currentTime`,
 *   and nothing else, ever. A Host implements the closure — it writes the three
 *   it was given and ignores anything else in the patch — so that widening it
 *   is an edit to a Host and to this list, and never a field a caller smuggles
 *   through.
 *   IT IS A MECHANISM PER HOST, NOT ONE MECHANISM FOR ALL HOSTS, and until S11
 *   says otherwise both ends carry it: `ui/host.js` filters what it puts on the
 *   wire, AND the unit names its three fields at the call site rather than
 *   spreading a patch object into it (`test.js` holds both halves). A Host that
 *   did the obvious `Object.assign(player, patch)` would reopen the write set
 *   with nothing in this tree to see it — which is why the caller-side closure
 *   is not redundant. L1 is a security property (`SECURITY.md`): this channel
 *   reaches a `<video>` on somebody else's page.
 *
 * @property {() => void} release
 *   Hand the player back the way it was found: unmuted, rate 1, key lock on.
 *   A muted 1.02x video left behind is a bug the user cannot explain and cannot
 *   undo, so a Host that drives MUST be able to undo it.
 *
 * @property {(rate: number) => void} requestSpeed
 *   The USER's speed, which is not the same thing as `drive({playbackRate})`
 *   and must not be folded into it. It is a CLAIM with its own lifetime: this
 *   Host re-asserts it across an ad and drops it on a source swap, while a
 *   drive correction is a single value with its own dedupe against a 4 Hz loop.
 *   One duty behind both would be one dedupe behind two lifetimes.
 *   The VALUE is not filtered here: a rate the host cannot apply is refused and
 *   REPORTED back through `onSpeedReport`, which is strictly better than a
 *   silent drop.
 */

export const DECK_PAGE_DUTIES = Object.freeze({
  onKey: "hand the deck the keys the host took out of its own page's hands",
  onAutonav: "report what happened to the page's autoplay-next",
  claimKeys: 'take the key codes the deck names, and leave the rest to the page',
  setHeight: 'size the deck to the height it measured',
  ready: 'the deck is listening — re-send everything reported on change',
  close: 'take the deck off the page, without stopping the audio',
});

/**
 * `drive`'s sentence says "mute, rate and position" and NOT the three property
 * names, which are spelled in the typedef above instead. `qa/speed-pitch.mjs`
 * asserts that nothing under `extension/{engine,offscreen,workers,shared}/`
 * references the page rate IN CODE — comments stripped, so the typedef is
 * invisible to it and a duty string is not. That gate is how this project knows
 * the engine never shifts on the page's rate, and a seam declaration is not a
 * reason to carve a second file out of it. The error message loses nothing: it
 * still names the closed write set, in words.
 */
export const DECK_TRANSPORT_DUTIES = Object.freeze({
  onState: "push the player's state to the deck, on every event that moves it",
  onJump: 'tell the deck the content moved under it',
  onSpeedReport: "give the deck the host's verdict on the player's rate",
  drive: "write the player's mute, its rate and its position — those three and nothing else",
  release: 'hand the player back the way it was found',
  requestSpeed: "carry the user's speed claim, and re-assert it as the page needs",
});

/**
 * A duty NAMESPACE a Host may legitimately not have — AND MUST SAY IT DOES NOT.
 *
 * `assertHost` answers "did this Host supply everything". This answers the
 * different question an optional namespace raises: "did this Host DECIDE, or
 * did it just not mention it?" An absent property and a deliberate absence look
 * identical from the inside, and here they must not, because the deck reads
 * `host.transport != null` as a fact about the world — is there a player above
 * me — and acts on it at boot. A Host that meant to supply a transport and
 * misspelled the key would be read as a Host with no player at all, which is
 * the state `follow()` treats as "nobody is ever going to tell me, so run": a
 * capture and a model download nobody asked for. This repo has already paid for
 * that exact outcome once, by a different route.
 *
 * So the KEY is required and the VALUE may be null. `transport: null` is a
 * sentence a second-host author has to write, and writing it is the point.
 *
 * FAILS WHEN IT CANNOT LOOK, the same two ways `assertHost` does: no host at
 * all is the loudest error rather than the quietest, and a namespace that IS
 * present goes straight to `assertHost`, so an empty duty list still throws.
 *
 * @param {object} host   the module namespace the context imported
 * @param {string} key    the optional namespace's name on it
 * @param {Record<string, string>} duties  duty name -> what it is for
 * @param {string} what   the interface's name, for the message
 * @returns {object|null} the namespace, or null if the Host declared it absent
 */
export function assertHostOption(host, key, duties, what = 'Host') {
  if (!host || (typeof host !== 'object' && typeof host !== 'function')) {
    throw new Error(`${what}: no host module was supplied (got ${host === null ? 'null' : typeof host}), `
      + `so whether it has a ${key} cannot even be asked.`);
  }
  if (!(key in host)) {
    throw new Error(`${what}: nothing was said about ${key}. A Host that has none must declare `
      + `\`${key}: null\` — an absent property and a deliberate absence read the same, and this seam `
      + 'reads that silence as a decision about how the deck boots.');
  }
  const got = host[key];
  if (got == null) return null;
  return assertHost(got, duties, `${what}.${key}`);
}
