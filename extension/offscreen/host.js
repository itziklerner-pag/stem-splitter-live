/**
 * THE EXTENSION'S EngineHost — the Chrome half of the engine, and the only file
 * under `offscreen/` that says `chrome.` at all.
 *
 * That is now true of the whole directory and not just of `engine.js`. The five
 * `chrome.runtime.getURL` calls that used to sit in `deck.js`, `cacheddeck.js`,
 * `live.js` and `master.js` — bypassing the seam entirely, so a second Host
 * could implement all five duties and still be blindsided by four sibling files
 * reaching for Chrome on their own — all resolve through `assetUrl` below
 * (S2, #4). The one URL that deliberately does NOT is the inference worker
 * itself, built with `new URL(..., import.meta.url)` inside
 * `../workers/workerbackend.js`: that one is about the unit's own directory
 * layout, which is the unit's contract and not the Host's.
 *
 * AND HALF OF WHAT IS HERE IS NOT `chrome.` AT ALL. `captureStream` is
 * `getUserMedia` with Chrome-proprietary constraints; `onTeardown` is a
 * document-lifetime event; the three model duties are `fetch` and the Cache API.
 * A gate that greps the unit for `chrome.` sees none of them, which is why the
 * seam is a DECLARED interface rather than an inferred one — and why moving the
 * model's URL out of `shared/config.js` (S7) is the only edit that actually
 * removed the network path from the unit.
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

import { MODEL } from '../shared/config.js';
import { BUS } from '../shared/host.js';
import { WorkerBackend } from '../workers/workerbackend.js';
import { MODEL_URL, MODEL_CACHE_NAME } from './host-pin.js';

/**
 * This context's address on the extension message bus, READ OUT OF THE SEAM'S
 * OWN DECLARATION rather than spelled here.
 *
 * It was `const ME = 'off'` until Host interface v1 (S11): three files spelled
 * three literals and nothing connected them, so "hand the engine every message
 * addressed to it" was a duty a second Host could read in full and still not
 * know how to discharge. `BUS` is where the addresses are frozen.
 */
const ME = BUS.engine;

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
  chrome.runtime.sendMessage({ v: 1, to: BUS.deck, from: ME, ...msg }).catch(() => {});
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
 * A path that ends in `/` resolves to a directory URL and keeps its trailing
 * slash — `../workers/workerbackend.js` hands `assetUrl('vendor/ort/')` to
 * the inference worker's `INIT`, and ORT appends its own file names to it.
 */
export const assetUrl = (relPath) => chrome.runtime.getURL(relPath);

/**
 * @type {import('../shared/host.js').EngineHost['createBackend']}
 *
 * THE HOST PICKS THE BACKEND — that is the whole of what this duty is for, and
 * under this Host there is exactly one to pick. `WorkerBackend` is unit code
 * (`../workers/workerbackend.js`), not Chrome code: it needs a `Worker`, a
 * `fetch` and somewhere to resolve `vendor/ort/`, and none of those is
 * `chrome.*`. What makes it THIS Host's choice is the line below and nothing
 * else, which is what a desktop Host replaces when a native backend exists —
 * one line, against an interface, rather than a fork of the engine.
 *
 * A FRESH INSTANCE EVERY CALL. Memoising is the obvious optimisation and it is
 * the one shape this duty must never take: two decks sharing one worker means
 * two ORT sessions on one wasm instance, and a concurrent `run()` there
 * PERMANENTLY WEDGES both (`offscreen/deck.js:18-25`). `new` on every call is
 * how that stays structurally impossible rather than merely unlikely.
 *
 * `assetUrl` is passed as the module's own function, unbound, exactly as
 * `engine.js` passes it to `MasterBus` and to the decks.
 *
 * THE HOOKS ARE FORWARDED WHOLE, and that is the one part of this duty
 * `assertHost(backend, BACKEND_DUTIES)` structurally cannot check. `onReady` and
 * `onFail` arrive OUTSIDE any call the unit made — the hardware the backend
 * found, and a death with nothing in flight — so a Host that built the backend
 * and dropped them answers with an object that owes every declared duty and
 * still loses both: the deck's `state.boot.{ep,adapter,threads}` line goes
 * blank, and an idle backend death is silent again until the next arm. Review
 * measured exactly that: `new WorkerBackend({ assetUrl })` left `node test.js`
 * at 602 passed and `embed-smoke` at 130/130. `test.js`'s `host` group now
 * drives the hooks through THIS function rather than around it.
 *
 * `...hooks` FIRST, `assetUrl` LAST, so the unit cannot overwrite the resolver
 * the Host chose. The declared hook type has no `assetUrl` in it, so nothing
 * reaches this today; the order is what keeps "the Host decides where its files
 * live" a property of the code rather than of the caller's good manners.
 */
export const createBackend = (hooks) => new WorkerBackend({ ...hooks, assetUrl });

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

/* ------------------------------------------------------------------ the model
 * THE MODEL'S BYTES — the P1 surface, and the half of the model pin that is this
 * Host's. `MODEL_URL` and the Cache API bucket come from `./host-pin.js`; the
 * SHA-256 and the byte count stay in the unit, which checks them over whatever
 * arrives here (`../shared/modelcache.js`). NOTHING BELOW VERIFIES ANYTHING, and
 * that is the design: a Host that could verify is a Host that could decline to.
 * -------------------------------------------------------------------------- */

/**
 * Drain a `Response` into one contiguous `Uint8Array`, reporting progress.
 *
 * `MODEL.bytes` is the fallback total, and it is COSMETIC: a `Content-Length`
 * is normally there, and when it is not, a progress bar with a plausible total
 * beats one with none. The number that decides anything is the unit's, checked
 * after the last byte lands.
 */
async function readAll(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || MODEL.bytes;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

/**
 * @type {import('../shared/host.js').EngineHost['modelBytes']}
 *
 * P1 IS HELD BY THE ORDER OF THESE LINES: `cache.match` short-circuits before
 * `fetch` is even referenced, so after the first successful download this
 * function makes zero network requests. M1 is held by what it does with them —
 * the bytes are data, and nothing here is ever `import`ed or evaluated.
 *
 * The cache is written BEFORE the unit has verified a byte, because the
 * alternative is buffering 109 MB twice, and the unit's `loadModel` is written
 * knowing it: bytes that fail the check take `clearModel()` with them on the way
 * out. That contract is stated in `../shared/modelcache.js` and asserted there.
 *
 * The phase is announced BEFORE any bytes move. `fromCache` in the return value
 * is a post-hoc record and arrives ~2 minutes too late to choose the wording on
 * a progress card; `phase` is the authoritative signal, and this is what makes
 * it authoritative from the instant the answer is known rather than from the
 * first byte of a fetch whose headers may take a second.
 */
export const modelBytes = async (onProgress = () => {}) => {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const hit = await cache.match(MODEL_URL);
  onProgress(hit ? 'cache' : 'download', 0, MODEL.bytes);
  if (hit) {
    return { bytes: await readAll(hit, (g, t) => onProgress('cache', g, t)), fromCache: true };
  }

  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model fetch failed: HTTP ${res.status}`);
  const bytes = await readAll(res, (g, t) => onProgress('download', g, t));
  await cache.put(MODEL_URL, new Response(bytes, {
    headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' },
  }));
  return { bytes, fromCache: false };
};

/**
 * @type {import('../shared/host.js').EngineHost['modelCached']}
 *
 * Cheap on purpose — `cache.match` resolves a `Response` without reading its
 * body, so this answers the setup page's "will arming cost 109 MB?" without
 * spending anything. It is the reason `STATUS` can answer at boot.
 *
 * `false` WHEN IT CANNOT LOOK, which is the duty's own wording and is why the
 * `catch` is here rather than at the call site. Both awaits below can reject —
 * the Cache API is unavailable when storage is blocked or partitioned away —
 * and `engine.js`'s `STATUS` case awaits this BEFORE `ensureBackend()`,
 * `echoXf()` and `push()`, so a rejection does not become a model error: it
 * abandons the rest of the case, and `handle()`'s catch writes the reason to
 * `state.job.error`, which nothing paints. The deck simply stays blank. `false`
 * is also the safe direction of the two: the user is offered a download they
 * may decline, rather than having 109 MB spent on a `true` nobody checked.
 */
export const modelCached = async () => {
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    return !!(await cache.match(MODEL_URL));
  } catch {
    return false;
  }
};

/**
 * @type {import('../shared/host.js').EngineHost['clearModel']}
 *
 * Drops the whole bucket rather than the one entry: the bucket holds exactly
 * one thing, and "delete the store" is the duty a Host that keeps its bytes in a
 * file rather than a Cache can actually implement.
 */
export const clearModel = async () => {
  await caches.delete(MODEL_CACHE_NAME);
};
