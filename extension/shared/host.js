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
 * is genuinely a namespace (S4's `storage`, which carries `get`/`set`/
 * `onChanged`) is therefore declared as its own callable duties, or this check
 * is widened deliberately and the widening is asserted. It is not widened by
 * accident.
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
 * The deck's Host. Two duties today; S4 adds storage and the arm shortcut, S5
 * adds the transport to the page.
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
 */

/**
 * THE FOUR RULES A `DeckHost` HAS TO HOLD. Each one is here because breaking it
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
