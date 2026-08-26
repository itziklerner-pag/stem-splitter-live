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
 * The deck's Host. Six duties today — the bus, storage, and the arm chord; S5
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
