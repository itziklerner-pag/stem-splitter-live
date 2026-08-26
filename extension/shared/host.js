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
 * WHY A BOOT-TIME CHECK AND NOT A TYPE. There is no type checker in this
 * build's pipeline, so the typedef below is documentation and nothing more. A
 * Host that forgets a duty would otherwise surface one layer down from the
 * mistake and at the worst possible moment: a missing `captureStream` reads as
 * `host.captureStream is not a function` at the instant the user arms a tab,
 * inside the one code path that must not fail halfway (R5 — a capture that
 * throws after the track exists must still stop the track, or the tab is left
 * permanently silent). `assertHost()` moves that failure to module evaluation,
 * before any track exists, and names the duty that is missing.
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
 *   would be awaited there.
 *
 * @property {(fn: (msg: object) => void) => void} onMessage
 *   Register the engine's inbox. The Host owns the "is this addressed to the
 *   engine" routing guard, and hands `fn` the RAW envelope — normalising,
 *   re-wrapping or filtering it breaks receivers quietly. `fn` returns nothing
 *   and is never awaited.
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
  send: 'deliver a message from the engine to the deck',
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
