/**
 * THE EXTENSION'S EngineHost — the Chrome half of the engine, and the only file
 * under `offscreen/` that is allowed to say `chrome.`.
 *
 * `engine.js` is the orchestration and knows nothing about the browser it is
 * in; this module is what makes it run inside a Chrome extension's offscreen
 * document. The duties, and why each is shaped the way it is, are declared once
 * in `../shared/host.js` (`EngineHost`) — read them there. What follows is only
 * what is peculiar to THIS Host.
 *
 * What the offscreen document can and cannot do (measured): its entire
 * `chrome.*` surface is `runtime.{getURL, onMessage, sendMessage}`. It cannot
 * reach `chrome.storage`, `chrome.tabs` or `chrome.runtime.getManifest`.
 * Anything persistent goes through the service worker; anything large goes
 * through OPFS. That is why the seam is this narrow — there was never much
 * `chrome.` here to hide.
 *
 * EVERY LOOKUP IS AT CALL TIME, never `.bind()`ed at module scope. Test harnesses
 * replace the `chrome.runtime.sendMessage` PROPERTY after a context has booted
 * in order to observe what it sends; a bound copy captures the original and the
 * observation silently records nothing.
 */

/** This context's address on the extension message bus. */
const ME = 'off';

/**
 * @type {import('../shared/host.js').EngineHost['send']}
 *
 * `chrome.runtime.sendMessage` is a BROADCAST — every extension context with a
 * listener receives it — so `to` is the routing and not the transport. The
 * `.catch(() => {})` is load-bearing rather than defensive: with no surface
 * open there is no listener, and an unhandled rejection per 10 Hz heartbeat
 * fills the console with a condition that is entirely normal.
 */
export const send = (msg) => {
  chrome.runtime.sendMessage({ v: 1, to: 'ui', from: ME, ...msg }).catch(() => {});
};

/**
 * @type {import('../shared/host.js').EngineHost['onMessage']}
 *
 * `return false` is deliberate and belongs to the Host, not to the engine: MV3
 * reads a truthy return as "I will call `sendResponse` asynchronously" and would
 * hold the message channel open for every message the engine ever receives.
 * `fn` is handed the raw envelope and its result is discarded.
 */
export const onMessage = (fn) => {
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.to !== ME) return;
    fn(m);
    return false;
  });
};

/**
 * @type {import('../shared/host.js').EngineHost['captureStream']}
 *
 * The token is minted by the service worker (`chrome.tabCapture.getMediaStreamId`),
 * which is the only context that can see `chrome.tabs`; the engine carries it
 * here without ever looking inside it. Note this is NOT a `chrome.*` call — it is
 * `getUserMedia` with Chrome-proprietary constraints, which a grep for `chrome.`
 * cannot see. That is exactly why the duty is declared rather than inferred.
 *
 * Rejects on failure, as the duty requires: `getUserMedia` already does.
 */
export const captureStream = (sourceToken) => navigator.mediaDevices.getUserMedia({
  audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: sourceToken } },
  video: false,
});

/**
 * @type {import('../shared/host.js').EngineHost['assetUrl']}
 *
 * Extension-root-relative, no leading slash: `assetUrl('offscreen/capture-processor.js')`.
 */
export const assetUrl = (relPath) => chrome.runtime.getURL(relPath);

/**
 * @type {import('../shared/host.js').EngineHost['onTeardown']}
 *
 * Under this Host the engine's lifetime IS the offscreen document's, so the
 * teardown signal is `pagehide`. It is host-coupled with no `chrome.` in it —
 * a document-lifetime event that a renderer-hosted engine would raise from
 * somewhere else entirely — which is why it is a duty and not a line in
 * `engine.js`.
 */
export const onTeardown = (fn) => { addEventListener('pagehide', fn); };
