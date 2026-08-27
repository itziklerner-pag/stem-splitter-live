/**
 * THE ENGINE'S ORCHESTRATION. It owns audio reality: the MediaStreams, the ONE
 * AudioContext, the capture worklets, the inference workers, the master bus, the
 * stem cache and the message switch that drives all of it.
 *
 * IT IS HOST-AGNOSTIC, and that is the property to preserve when editing it.
 * Everything platform-bound THIS file needs lives behind the duties of
 * `EngineHost` (`../shared/host.js`), supplied here by `./host.js` — the Chrome
 * extension's implementation, and the only `chrome.`-speaking module this file
 * reaches for. `ENGINE_HOST_DUTIES` is the list; this is what each is for here:
 *
 *   send / onMessage    the extension message bus
 *   captureStream       getUserMedia with the tabCapture constraints
 *   assetUrl            chrome.runtime.getURL, for the worklet modules
 *   onTeardown          pagehide — a document-lifetime event, not an engine one
 *   modelBytes /        the 109 MB weights: fetch + the Cache API (S7). Where
 *   modelCached /       they come from is the Host's; whether they are the model
 *   clearModel          is the unit's (`../shared/modelcache.js`).
 *   createBackend       which inference backend a deck gets (S6). Today's is
 *                       `../workers/workerbackend.js` — ORT in a Worker — and
 *                       swapping it is the Host's one line, not a fork of this.
 *
 * `./host.js` is the ONLY file under `offscreen/` that says `chrome.` at all:
 * `deck.js`, `cacheddeck.js`, `live.js` and `master.js` reach their worklet
 * modules and the ORT runtime through `assetUrl`, handed down from here — on
 * `shared` for the two kinds of deck, and as a constructor argument to
 * `MasterBus`, which is built before there is a context to await on.
 *
 * Nothing else here is Chrome-specific, and the audit trail is the whole list
 * rather than a sample: Web Audio (`AudioContext`, `AudioWorkletNode`),
 * `SharedArrayBuffer`, OPFS (`navigator.storage.getDirectory`),
 * `navigator.mediaDevices.enumerateDevices`, `self.crossOriginIsolated`,
 * `crypto.randomUUID` and `location.href`. That is every platform global this
 * file touches — plain web platform, all of it — so a second Host supplies the
 * five duties and this file runs unchanged (ADR 0001 decision 5).
 *
 * There is NO export job — the header said there was for a long time. `state.job`
 * survives as a shape: only `status`, `error` and `stage` are ever written (by
 * `fail()`), the other five fields only by the reset literal, and no surface
 * reads any of it. It is kept, not revived, because `fail()` has nowhere else to
 * record and removing it is not this slice's change.
 *
 * ---------------------------------------------------------------------------
 * MODE 3 (dual deck). Two decks live in THIS document, because Chrome allows
 * exactly one offscreen document and because two AudioContexts have independent
 * hardware clocks and would drift tens of ms per minute (docs/AUDIO.md §8.1).
 *
 *   shared, exactly one of each      per deck (offscreen/deck.js)
 *   ---------------------------      ------------------------------------------
 *   AudioContext @ 44100             MediaStream + capture worklet + SAB ring
 *   MasterBus (meter/clip/dest)      inference Worker  (its own wasm instance)
 *   GpuScheduler (one GPU token)     ORT session
 *   hop + live plan                  LivePipeline + playback worklet + stem ring
 *   crossfader position + curve      per-stem crossfader assignment column
 *
 * Deck B is created lazily on its first LIVE_START: each session is ~1.7 GB of
 * wasm heap at peak (two decks measured 2091 MB renderer), and a Mode 1 user
 * must not pay for a deck they never armed.
 */

import { SR, SEGMENT, STEMS, MODEL, OPFS_DIR, OPFS_DEV_INPUT, OPFS_LIVE_TAP,
  DECKS, DECK_DEFAULT, XF_CURVES, XF_CURVE_DEFAULT, XF_POSITION_DEFAULT, DUAL_MASTER_TRIM_DB,
  XF_TARGETS, RING_FRAMES, STEM_CACHE_MAX_BYTES, STEM_CACHE_32F_MAX_BYTES } from '../shared/config.js';
import { RingConsumer, ringByteLength } from '../shared/ring.js';
import { loadModel } from '../shared/modelcache.js';
import { encodeWav, decodeWav, WavWindowReader } from '../shared/wav.js';
import { GpuScheduler } from '../engine/scheduler.js';
import { masterTrimDb } from '../engine/mixer.js';
import { MasterBus } from './master.js';
import { Deck } from './deck.js';
import { CachedDeck, resumeSeek } from './cacheddeck.js';
import { StemCache, CacheWriter, cacheKey, videoIdFromUrl,
  primeRefusal, commitRefusal, CACHE_DIR_32F } from '../shared/stemcache.js';
import { ExportRun, ExportError, checkExportCode } from '../engine/export.js';
// The transpose's accepted range, imported for the REFUSAL MESSAGE and nothing
// else. A hard-coded "[-6, +6]" in a log line is a second copy of a contract
// that lives in engine/pitch.js, and the day the range moves it becomes a log
// line that confidently names the wrong bound.
import { PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES } from '../engine/pitch.js';
import { effectiveXfPosition } from '../engine/mixer.js';
/**
 * THE HOST. Exactly one host-supplied module, imported statically, because
 * `embed.html`'s CSP rules out handing a Host object in at boot and the seam has
 * to be the same shape in both contexts (../shared/host.js).
 */
import * as host from './host.js';
/**
 * BOUNCE — what a deck IS PLAYING, rendered offline as one file. Distinct from
 * Export, which is the six raw stems at unity: a DAW wants the stems, a listener
 * wants what they heard, so they get different names. `engine/bounce.js` carries
 * the design, the arithmetic and the reason SPEED is not one of the things a
 * bounce bakes.
 */
import { bounceSettings, bounceRefusal, bounceWireCode, BOUNCE_CODES } from '../engine/bounce.js';
import { bounceToSink } from './bounce.js';
import { assertHost, ENGINE_HOST_DUTIES, modelSourceWord } from '../shared/host.js';

/**
 * BEFORE ANYTHING ELSE IN THIS MODULE RUNS. `MasterBus`, `Deck` and the boot
 * `HELLO` all execute at module scope below, and `HELLO` is the first thing to
 * reach `host.send` — so a Host that is short a duty must be refused here, where
 * the error names the duty, rather than at the first arm, where it names a line
 * inside `captureStart` that has already taken a track off the user's tab.
 */
assertHost(host, ENGINE_HOST_DUTIES, 'EngineHost');

/**
 * This document's identity. Two offscreen documents cannot coexist (Chrome
 * refuses the second createDocument), but a document that was REPLACED — reaped,
 * crashed, or recreated across a panel/tab transition — looks exactly like the
 * original from the outside, and the symptom is a live deck wired to an
 * AudioContext nobody is talking to any more. Every DIAG carries these two so
 * "is this the same document that started the capture?" is answerable from one
 * paste.
 */
const DOC_ID = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : String(Math.random()).slice(2, 10);
const BOOT_AT = Date.now();

// ---------------------------------------------------------------- boot asserts
// R0: SAB is available in extension contexts WITHOUT cross-origin isolation, so
// we assert on the constructor, never on crossOriginIsolated (which is false).
const SAB_OK = typeof SharedArrayBuffer === 'function';

const state = {
  boot: { sab: SAB_OK, coi: self.crossOriginIsolated === true, sampleRate: null, ep: null, adapter: null, threads: null },
  /**
   * `source` IS THE PROVENANCE AND `fromCache` IS THE RETRY DECISION — they are
   * two fields because they are two questions (#28, `shared/host.js`
   * `MODEL_SOURCES`). Wording the log line off the boolean told a Host that
   * ships its weights that 109 MB had been downloaded.
   */
  model: { status: 'unknown', phase: null, got: 0, total: MODEL.bytes, ms: 0, error: null, fromCache: null, source: null },
  /** deck A's capture, mirrored. The side panel is single-deck and reads this. */
  capture: { status: 'idle', frames: 0, seconds: 0, peak: [0, 0], dropped: 0, source: null },
  /** per-deck capture + session, for the dual console */
  decks: { A: null, B: null },
  /** the GLOBAL crossfader — position and curve are not per deck (see §contract) */
  xf: { position: XF_POSITION_DEFAULT, curve: XF_CURVE_DEFAULT },
  /**
   * Shared GPU scheduler, echoed so DECK_PRIORITY is not write-only.
   *
   * `priority` ONLY. `armed` (L3 demotion on/off) is deliberately absent from the
   * UI's surface: nothing the console can send changes it, so publishing it lets
   * a surface observe a state it cannot cause — the mirror image of the
   * write-only control this echo exists to fix. It is not becoming user-reachable
   * ("should the machine protect deck A when it runs out of GPU" is not a
   * question to ask a DJ mid-set), so it stays on the diagnostic surfaces only,
   * where a probe can both read and set it: DIAG and DUAL_STATS carry the full
   * `gpu.report()`.
   */
  gpu: { priority: 'A' },
  job: { status: 'idle', chunk: 0, chunks: 0, pct: 0, elapsedMs: 0, etaMs: null, error: null, stage: null },
  log: [],
};

function log(line) {
  const s = `${(performance.now() / 1000).toFixed(2)}s ${line}`;
  state.log.push(s);
  if (state.log.length > 200) state.log.shift();
  console.log('[engine]', line);
}

/**
 * The transmit path for the WHOLE engine, not just this file: `shared.send`
 * below hands it to every Deck, LivePipeline and CachedDeck.
 *
 * RETURNS UNDEFINED, and that is a contract rather than an accident — twenty-two
 * call sites end a `case` of `handle()` with `return send({...})` inside an
 * `async` function, so a promise returned here would be awaited by every one of
 * them.
 */
function send(msg) {
  host.send(msg);
}
let pushQueued = false;
function push(force) {
  if (force) { pushQueued = false; send({ type: 'STATE', state: snapshot() }); return; }
  if (pushQueued) return;
  pushQueued = true;
  queueMicrotask(() => { pushQueued = false; send({ type: 'STATE', state: snapshot() }); });
}
/** `state` with the live per-deck facts folded in at send time. */
function snapshot() {
  // The crossfader depends on WHICH DECKS ARE LOADED, and that changes in half a
  // dozen places. Reconcile here rather than trusting every one of them.
  reconcileXf();
  // DECK_PRIORITY was write-only: the console could say "keeps" but never
  // "is keeping" (QA-17's inferred-value trap). One field closes it.
  state.gpu = { priority: gpu.priority };
  state.capture = { ...decks.A.captureState(), frames: decks.A.capturedFrames };
  state.decks = {
    A: deckSummary(decks.A),
    B: deckB ? deckSummary(deckB) : null,
  };
  return state;
}
function deckSummary(d) {
  return {
    id: d.id,
    capture: d.captureState(),
    session: d.session, sessionError: d.sessionError, ep: d.ep,
    live: d.live.status, hopSec: d.live.plan ? d.live.plan.hopSeconds : null,
    xfAssign: d.live.xf.assign.slice(),
  };
}
function fail(stage, err) {
  const message = String((err && err.message) || err);
  log(`ERROR [${stage}] ${message}`);
  if (stage === 'model') { state.model.status = 'error'; state.model.error = message; }
  else { state.job.status = 'error'; state.job.error = message; state.job.stage = stage; }
  push(true);
}

/**
 * THE ONE PLACE AN `EXPORT_ERROR` LEAVES THIS ENGINE, and the only place its
 * code is checked.
 *
 * `code` is drawn from a CLOSED VOCABULARY the unit owns (`engine/export.js`
 * EXPORT_CODES), and `checkExportCode` is what says so out loud at the moment it
 * is wrong. That is #29's lesson applied before it can be repeated: `ARM_CODES`
 * was a closed set of eight that nothing ever checked, and a Host that invented
 * a plausible-looking member got an undismissable banner with a dead Restart
 * button and nothing red anywhere.
 *
 * IT DOES NOT USE `fail()`. `fail()` writes `state.job` and pushes the whole
 * snapshot; the export vocabulary rides its own message precisely so a run's
 * progress and its failures do not go through the coalescing snapshot push.
 *
 * The check does not throw and does not change what is sent: the user's export
 * has already failed, and replacing their problem with ours about a spelling
 * would take the first one off the screen.
 */
function exportFailed(deckId, code, message) {
  checkExportCode(code, `EXPORT_ERROR on deck ${deckId}`);
  log(`export failed [${code}] ${message}`);
  send({ type: 'EXPORT_ERROR', deck: deckId, code, message });
}

// ------------------------------------------------------- shared model loader
/**
 * A FRESH ArrayBuffer of verified weights, per call. `LOAD_MODEL` transfers the
 * buffer into the worker, so two decks physically cannot share one — the second
 * would receive a detached buffer. The Host's read plus the unit's SHA-256 costs
 * ~1 s on warm bytes, which is paid once per deck at arm time and never again.
 *
 * The download itself (and its progress) happens at most once: the first call
 * makes the Host store the bytes and every later call is served from that store.
 *
 * WHERE THE BYTES COME FROM IS THE HOST'S (`host.modelBytes`); WHETHER THEY ARE
 * THE MODEL IS THE UNIT'S (`shared/modelcache.js`). This function owns neither —
 * it owns the SERIALISATION and the `state.model` progress, which are
 * orchestration and stay here.
 *
 * This `modelBytes()` and `host.modelBytes()` share a name deliberately and are
 * not the same thing: a deck asks the engine, the engine asks the Host, and the
 * serialisation below is the whole of the difference between the two.
 */
let modelChain = Promise.resolve();
async function modelBytes() {
  // SERIALISED, not just deduped. Two decks arming at once on a cold cache would
  // otherwise both miss `cache.match` and both fetch 172 MiB — one download, two
  // copies, and P1 says the network is touched exactly once. Chaining means the
  // second caller starts after the first has written the cache entry, so it hits
  // it. On a warm cache each call is a ~1 s read + SHA-256; that is deliberate
  // (SCOPE AC-2.5.d verifies on EVERY load, not just the first).
  const p = modelChain.then(() => loadOnce());
  modelChain = p.then(() => {}, () => {});
  return p;
}
async function loadOnce() {
  state.model.status = 'loading';
  state.model.error = null;
  state.model.phase = null;
  push(true);
  let last = 0;
  try {
    const { buffer, fromCache, source, ms } = await loadModel(host, (phase, got, total) => {
      state.model.phase = phase; state.model.got = got; state.model.total = total;
      const now = performance.now();
      if (now - last > 120) { last = now; push(true); }
    });
    state.model.fromCache = fromCache;
    state.model.source = source;
    state.model.ms = ms;
    state.model.phase = 'session';
    // The words are the seam's, not this file's: `MODEL_SOURCES` is what a Host
    // picks its phase out of, so the sentence and the vocabulary cannot drift.
    log(`weights ${modelSourceWord(source)} + hash verified in ${ms.toFixed(0)}ms`);
    push(true);
    return buffer;
  } catch (e) {
    fail('model', e);
    throw e;
  }
}

// ------------------------------------------------------------- shared context
let ctx = null;
/**
 * NULL CONTEXT, REAL RESOLVER. There is no AudioContext at module evaluation and
 * creating one here would start hardware nobody asked for, so `ctx` arrives at
 * `ensureContext()` below. `assetUrl` is not in that position — the Host is
 * already imported and its resolver is synchronous by contract — so the bus
 * takes it now rather than being patched twice. See MasterBus's constructor.
 */
const master = new MasterBus(null, host.assetUrl);
const gpu = new GpuScheduler({ priority: 'A', armed: true });

async function ensureContext() {
  if (ctx) return ctx;
  const c = new AudioContext({ sampleRate: SR, latencyHint: 'playback' });
  await c.audioWorklet.addModule(host.assetUrl('offscreen/capture-processor.js'));
  if (c.state !== 'running') await c.resume().catch(() => {});
  state.boot.sampleRate = c.sampleRate;
  if (c.sampleRate !== SR) {
    // The whole no-resampling design (docs/AUDIO.md §1.2) rests on this. Never
    // publish a context we just rejected: `ctx` must stay null so a retry
    // re-checks instead of silently feeding the model the wrong sample rate.
    await c.close().catch(() => {});
    throw new Error(`AudioContext refused ${SR} Hz (got ${c.sampleRate})`);
  }
  ctx = c;
  master.ctx = c;
  return ctx;
}

// ----------------------------------------------------------------- the decks
const shared = {
  ctx: () => ctx,
  master: () => master,
  modelBytes,
  gpu,
  send,
  log,
  /**
   * THE HOST'S ASSET RESOLVER, HANDED DOWN. Every worklet module and the ORT
   * runtime are named unit-relative from here on: `Deck` passes it to
   * `LivePipeline`, `CachedDeck` takes it off this bundle, and none of the four
   * files knows what a `chrome-extension://` URL is. Synchronous by contract
   * (`../shared/host.js`) because two of its callers run before there is an
   * AudioContext to await on.
   */
  assetUrl: host.assetUrl,
  /**
   * THE HOST'S INFERENCE BACKEND FACTORY, HANDED DOWN THE SAME WAY AND WITH THE
   * SAME HAZARD. A deck calls it exactly once, lazily, and gets its own
   * instance; the engine never calls it at all. Losing this one line leaves a
   * Host that passes `assertHost` above and an extension that dies at module
   * scope in `decks.A.ensureBackend()`, so `Deck` refuses a bundle without it —
   * see the constructor.
   */
  createBackend: host.createBackend,
  /**
   * The steady-state cost of one chunk on `id`, in ms — the number a deck arms
   * its playhead against.
   *
   * With N decks serialised on one GPU, a deck's chunk takes its own inference
   * PLUS the wait behind the others, i.e. about N x p95(inference). Deck 0 of 1
   * gets 1x, which is the Mode 1 behaviour with the chunk-0 lottery removed.
   *
   * Counts decks that are RUNNING OR PRIMING, not decks that exist: a deck that
   * has been created but is idle costs nothing, and arming against it would add
   * a second of latency for no reason.
   */
  /** is ANY deck mid-`InferenceSession.create`? See Deck.infer(). */
  anyLoading: () => liveDecks().some((d) => d.sessionLoading != null),
  /** is a deck OTHER than `id` mid-session-create? See Deck.infer()'s L3 gate. */
  othersLoading: (id) => liveDecks().some((d) => d.id !== id && d.sessionLoading != null),
  armRefMs: () => {
    // Count decks that have a CAPTURE ATTACHED, not just decks already playing.
    //
    // This is the difference between deck A arming for the machine it is about
    // to be on and arming for the machine it is on right now. The dual-deck flow
    // is: arm tab A, arm tab B (both captures recording), then GO LIVE on each —
    // so at the moment deck A arms, deck B's capture already exists and the GPU
    // is about to be shared. Counting only running decks made deck A arm for a
    // machine to itself and then spend the session ~200 ms of cushion short:
    // measured at hop 2.6, deck A armed against 915 ms, settled at a 1206 ms p95
    // chunk with a 406 ms queue wait, and published 6 of 135 chunks unseparated
    // while deck B — which armed knowing about deck A — published 0 of 132.
    //
    // The residual, stated plainly because it is a real limitation and not a
    // rounding error: if the user goes live on deck A with NO deck B capture and
    // arms deck B ten minutes later, deck A is still armed for one deck and will
    // drop a few percent of chunks until it is restarted. The named fix is a
    // re-prime of deck A when a second capture appears, which costs a ~4 s
    // interruption mid-set; not obviously the better trade, so it is not done.
    // PREPARED counts too. `DECK_PREPARE` is the console saying "this deck will
    // be used", which it sends on open for both decks — so by the time deck A
    // goes live the engine knows the GPU is about to be shared, whether or not
    // deck B has a capture yet.
    //
    // This is what closes the inter-deck offset. Without it, deck A armed for
    // one deck and deck B (arriving later, with both loaded) armed for two, and
    // the two decks sat ~0.70 s apart for the session — a fixed offset in a
    // product whose whole purpose is mixing two tracks. With both captures
    // attached before going live they already agreed to within 70 ms; this makes
    // that true in the other ordering as well.
    //
    // Mode 1 and Mode 2 are untouched: nothing prepares deck B unless the dual
    // console is open, and the engine deliberately does not prepare at boot.
    // `deckIsLive` (:~496) and not a second spelling of it: this arm count and
    // `deckLoaded` must never be able to disagree about what "live" means. The
    // only thing this adds is PREPARED, which is the sentence below.
    const n = liveDecks().filter((d) => d.prepared || deckIsLive(d)).length;
    // MEDIAN, not p95 — see GpuScheduler's comment on medMs.
    //
    // MEMOISED FOR AS LONG AS ANY DECK IS LIVE, and that is the point rather
    // than an optimisation. `medMs` moves between the two arms — deck A arms
    // early on a near-empty sample set, deck B arms later once contention is in
    // the population — so computing it twice gives the two decks DIFFERENT
    // offsets and leaves them a fixed distance apart for the whole session.
    // Measured over 10 minutes at hop 2.6: deck A armed against 1691 ms, deck B
    // against 2600 ms (clamped), and they sat 0.90 s apart. At hop 1.95 the same
    // run put them 93 ms apart only because neither hit the clamp.
    //
    // A fixed inter-deck offset is not a footnote in a product whose entire
    // purpose is mixing two tracks, so the first deck to arm fixes the reference
    // and every deck that joins it uses the same number. Cleared once no deck is
    // live, so a fresh session re-measures.
    // KEYED ON `n`, not merely memoised. Reusing the reference across a CHANGE
    // in the deck count is the opposite error: deck B then inherits deck A's
    // single-deck number and arms too shallow. Measured in run-ext's ordering
    // (deck A live alone, deck B armed later): A 1917 ms, B 1535.8 ms — deck B,
    // the deck that waits, armed with LESS cushion than the deck that does not.
    //
    // Same n  -> same reference, so two decks that were both known about when
    //            they armed land on identical offsets. That is the shipping path
    //            (the console prepares both on open) and it is what closes the
    //            inter-deck offset.
    // n grew  -> recompute. A deck that went live alone genuinely armed for a
    //            machine to itself; the deck joining it must size for two, and
    //            the resulting offset is the KNOWN LIMITATION that arming both
    //            captures first avoids.
    const anyLive = liveDecks().some((d) => d.live.status !== 'idle' && d.live.status !== 'error');
    if (armRefCache && anyLive && armRefCache.n === n) return armRefCache.ms;
    armRefCache = { n, ms: gpu.medMs * Math.max(1, n) };
    return armRefCache.ms;
  },
  onCaptureTick: (d) => { if (d.id === DECK_DEFAULT && ++tickCount % 3 === 0) push(true); },
  onTrackEnded: (d) => { stopDeck(d).catch(() => {}); },
  onWorkerState: (d) => {
    if (d.id === DECK_DEFAULT) {
      state.boot.ep = d.ep || state.boot.ep;
      state.boot.adapter = d.adapter || state.boot.adapter;
      state.boot.threads = d.threads != null ? d.threads : state.boot.threads;
    }
    /**
     * BOTH TERMINAL STATES, because only handling the good one is a hang.
     *
     * This read `if (d.session === 'ready')` and nothing else. `loadOnce()`
     * catches failures in the DOWNLOAD, so a bad fetch or a hash mismatch does
     * reach the user — but session creation happens after it returns, under
     * `state.model.phase = 'session'`. A deck that ends at `session === 'error'`
     * therefore left `state.model.status` on `'loading'` for ever, and the
     * welcome page sat on "preparing the GPU" with a live progress bar and no
     * way to find out that it had already failed. Observed on a build with no
     * `vendor/ort/`: the worker died at module load, the deck recorded the
     * reason in `sessionError`, and nothing ever read it.
     *
     * `sessionError` is the deck's own recorded reason, so this reports what
     * happened rather than that something did.
     */
    if (d.session === 'ready') { state.model.status = 'ready'; state.model.phase = null; }
    else if (d.session === 'error') {
      state.model.status = 'error';
      state.model.phase = null;
      state.model.error = d.sessionError || 'The model could not be prepared on this machine.';
      log(`ERROR [session] ${state.model.error}`);
    }
    push(true);
  },
  onModelProgress: (d, m) => { state.model.phase = m.phase; push(true); },
};

/**
 * @type {Record<'A'|'B', Deck>}
 *
 * ponytail: DORMANT SECOND DECK. This build ships one deck — nothing arms B,
 * because `sw/service-worker.js` has one session key and the manifest one chord
 * — so `deckB` is never constructed and this registry is a map with one live
 * entry.
 *
 * KEPT DELIBERATELY, and the reason is the gate rather than the code. Collapsing
 * it to a single `Deck` also collapses the arming arithmetic that sizes the
 * buffer for GPU contention (`decksBusy`, the inter-deck offset below), which is
 * live-path audio behaviour measured over 10-minute soaks. The suites that
 * measured it were the two-deck ones and they went with the console. Removing
 * this on a reading rather than a measurement is exactly the trade this project
 * has paid for before.
 *
 * Ceiling: ~40 lines of unreachable branch, no runtime cost (the B branch never
 * executes). Upstream path: either port a live soak to the embedded surface and
 * then collapse it, or leave it — a second deck is the one feature most likely
 * to come back, and this is what it would come back into.
 */
const decks = { A: new Deck('A', shared), B: null };
/** Deck B is lazy — see the header note about 1.7 GB per session. */
let deckB = null;
function deck(id) {
  const k = DECKS.includes(id) ? id : DECK_DEFAULT;
  if (k === 'B' && !deckB) {
    deckB = new Deck('B', shared);
    decks.B = deckB;
    // Both decks must run the SAME hop (docs/AUDIO.md §8.1). A deck created
    // after the hop was chosen inherits it rather than silently starting at the
    // default and putting the two outputs 0.65 s apart.
    deckB.live.setHop(decks.A.live.hopSeconds);
    // The APPLIED position, not the raw control value — deck B is not loaded yet,
    // so the fader is still parked on A and that is what it must start from.
    deckB.live.setXfader(appliedXf.position != null ? appliedXf.position : state.xf.position);
    deckB.live.setXfCurve(state.xf.curve);
    // Inherit whatever the master default currently is; reconcileMaster() will
    // move BOTH decks once deck B actually becomes loaded.
    deckB.live.setMasterGain(decks.A.live.masterUserSet ? 0 : decks.A.live.masterDb, true);
    log('deck B created');
  }
  return k === 'B' ? deckB : decks.A;
}
/** Every deck that currently exists. */
const liveDecks = () => (deckB ? [decks.A, deckB] : [decks.A]);

/**
 * IS THIS DECK LIVE — capturing, or running a live pipeline?
 *
 * FACTORED OUT OF `deckLoaded` RATHER THAN COPIED. `BOUNCE_START` needs this
 * half on its own, to tell a deck that is live from a deck that is merely empty
 * (`engine/bounce.js`'s `bounceRefusal`), and a second copy of a predicate is
 * two answers that can disagree — which is the entry-point rule in AGENTS.md and
 * the reason `mixTarget` exists one screen down.
 */
const deckIsLive = (d) => !!d && (d.status === 'recording'
  || (d.live.status !== 'idle' && d.live.status !== 'error'));

/** A deck is "loaded" once it has audio to play — capture attached or already live. */
const deckLoaded = (d) => deckIsLive(d) ||
  // A cached deck has audio to play WITHOUT a capture or a live pipeline, and
  // "loaded" is what parks the crossfader and picks the master trim. Omitting it
  // would attenuate a lone cached deck 3 dB by a control nobody touched — the
  // exact bug effectiveXfPosition exists to prevent.
  !!(d && cachedDecks[d.id] && cachedDecks[d.id].track);

// ------------------------------------------------------------- the stem cache
/**
 * PRIME-THEN-PLAY (docs/AUDIO.md §8.3, ratified as the product shape).
 *
 * First listen through a track is a normal live listen that ALSO writes its
 * stems to disk. Every later listen skips the GPU entirely: instant, no
 * lookahead, no hop, and — because a cached deck is not capturing the thing it
 * is playing — the video can finally be locked to the audio clock.
 *
 * THE POLICY HERE IS DELIBERATELY THE SMALLEST ONE THAT IS HONEST. There is no
 * prime-ahead scheduler, no partial-prime interval list, no cache browser. A
 * prime is ALL OR NOTHING: it must start at the top of the track, run
 * uninterrupted, and reach the end, or it is thrown away. The alternative — a
 * cache entry that silently covers 1:47 to the end and reports itself as the
 * whole song — is the failure `shared/stemcache.js` calls the worst class of bug
 * this project can ship, and a spurious miss only costs one real-time re-prime.
 */
const cache = new StemCache(STEM_CACHE_MAX_BYTES);

/**
 * THE 32-BIT-FLOAT TIER — the DELIVERABLE's cache, and a different thing from
 * the one above with a different lifetime, its own directory and its own cap.
 * `shared/config.js` STEM_CACHE_32F_MAX_BYTES carries the arithmetic; the short
 * version is that a File source's working set is ALSO the export source, and
 * evicting it mid-export is catastrophic in a way evicting a prepared listen is
 * not, so the two must not compete for one budget.
 *
 * NOTHING IN THIS BUILD WRITES TO IT. The ahead-of-time separation runner is the
 * writer and it is a later slice; this engine only ever READS the tier, through
 * `EXPORT_START`. Constructing it here anyway is what makes the export path
 * complete for a second Host, which supplies `exportSink` and drives the same
 * message.
 *
 * WHEN A WRITER ARRIVES IT MUST PIN THE EXPORT'S KEY. `put()` calls `evict()`
 * after writing, `planEviction` takes a pin SET, and the key of the run in
 * flight is `exportRun.entry.key` right here. There is deliberately no pin set
 * yet: nothing in this file calls `cache32.evict()`, and a pin nobody reads is a
 * variable that looks like a guarantee.
 */
const cache32 = new StemCache(STEM_CACHE_32F_MAX_BYTES, CACHE_DIR_32F, { depth: 32, geometry: 'offline' });

/**
 * THE ONE EXPORT IN FLIGHT, or null. One at a time, on purpose: two runs would
 * interleave windows into each other's sinks, and `EXPORT_CANCEL` carries no way
 * to say WHICH run it means. A second `EXPORT_START` is refused by name (`BUSY`)
 * rather than queued, because a queued export whose folder dialog opened ten
 * minutes after the gesture is not the export the user asked for.
 * @type {ExportRun|null}
 */
let exportRun = null;

/** 'A' | 'B'. An absent deck field means A, the single-deck engine's convention. */
const normalizeDeckId = (id) => (DECKS.includes(id) ? id : DECK_DEFAULT);

/** @type {Record<'A'|'B', CachedDeck|null>} */
const cachedDecks = { A: null, B: null };
function cachedDeck(id) {
  const k = normalizeDeckId(id);
  if (!cachedDecks[k]) cachedDecks[k] = new CachedDeck(k, shared);
  return cachedDecks[k];
}
/** Is this deck playing from the cache right now? */
const isCached = (id) => !!(cachedDecks[id] && cachedDecks[id].track);

/**
 * WHERE A MIXER MESSAGE GOES for a deck — the cached deck when one is loaded,
 * the live pipeline otherwise.
 *
 * One accessor rather than a branch at each of the seven call sites, because a
 * fader that moves on five of them and not the other two is exactly the class of
 * defect (`AGENTS.md`, the entry-point rule)
 * same mixer surface as `LivePipeline` on purpose (its header: a cached deck and
 * a live deck must be indistinguishable to the mixer, or the crossfader between
 * them would not be a crossfader).
 */
const mixTarget = (id) => (isCached(id) ? cachedDecks[id] : deck(id).live);
/** Every deck the mixer must address, cached or live. */

/**
 * THE PAGE'S TRANSPORT, per deck: what the tab's `<video>` last told us.
 *
 * `null` means NOBODY HAS TOLD US, and it is not the same as zero. Only the
 * embedded build has a content script, so in the side-panel build this stays
 * null forever — and every decision below treats "we cannot see the playhead" as
 * a refusal to cache rather than as permission to assume the track started at
 * the beginning. That is the same rule as an assertion that must fail when it
 * cannot look (AGENTS.md), applied to a cache entry instead of a test.
 *
 * @type {Record<'A'|'B', {currentTime:number, duration:number, ended:boolean, atMs:number}|null>}
 */
const pageVideo = { A: null, B: null };

/** The cache key for what this deck is pointed at, or null if it cannot be cached. */
function trackKey(d) {
  const videoId = videoIdFromUrl(d.source && d.source.url);
  if (!videoId) return null;
  return { videoId, key: cacheKey(videoId, d.live.hopSeconds) };
}

/**
 * Start a prime, if this listen could possibly produce a complete entry. The
 * decision itself is `primeRefusal` in shared/stemcache.js, where it is pure and
 * tested; this is the effect. Returns the reason it did not start, for the log.
 */
function beginPrime(d, t) {
  const v = pageVideo[d.id];
  const why = primeRefusal(t && t.videoId, v);
  if (why) return why;
  d.live.attachCacheWriter(new CacheWriter(t.key, {
    videoId: t.videoId,
    title: (d.source && d.source.title) || null,
    hopSeconds: d.live.hopSeconds,
    // What the PAGE said the track is, kept alongside what we actually captured
    // so a short entry is visible as short rather than inferred from arithmetic.
    pageDurationSec: +v.duration.toFixed(2),
  }));
  log(`[${d.id}] priming cache: ${t.key}`);
  return null;
}

/**
 * Finish a prime. Commits only a listen that covered the whole track; anything
 * else is dropped, loudly enough to read in the log.
 */
async function endPrime(d) {
  const w = d.live.detachCacheWriter();
  if (!w) return;
  const why = commitRefusal(w, pageVideo[d.id]);
  if (why) { log(`[${d.id}] prime discarded — ${why}`); return; }
  const got = w.frames / SR;
  try {
    const r = await w.commit(cache);
    if (r) log(`[${d.id}] cached ${got.toFixed(1)} s · ${(r.bytes / 1e6).toFixed(0)} MB used of ${(r.maxBytes / 1e9).toFixed(1)} GB` +
      (r.removed.length ? ` · evicted ${r.removed.length}` : ''));
    send({ type: 'CACHE_STATE', deck: d.id, ...(await cache.report()) });
  } catch (e) {
    // A cache write that fails must not take the deck down with it: the user
    // heard the whole track, and the only loss is that the next play is not free.
    log(`[${d.id}] ERROR caching: ${String((e && e.message) || e)}`);
  }
}

/**
 * Play this deck from the cache. No capture is consumed and no GPU is touched;
 * the tab's own capture stays attached (it is what keeps Chrome muting the tab)
 * but nothing reads it.
 */
async function startCached(d, t) {
  /**
   * THE CAPTURE GOES TO `live` MODE EVEN THOUGH NOTHING WILL READ IT, and this
   * is not cosmetic. In `export` mode `deck.js` pushes every capture block into
   * `blocks` and keeps it — that is what `drainCaptured()` returns, and its one
   * caller in this tree is `DEV_DUMP`. Cached playback consumes nothing, so
   * those blocks would accumulate for the whole track: ~127 MB across six
   * minutes, retained, for audio no one will ever look at. In `live` mode the
   * capture writes into the fixed-size ring instead and nothing grows.
   *
   * `EXPORT_START` DOES NOT READ THIS, and the sentence that said it did stood
   * here for a long time describing a path that had been removed. An export
   * reads the 32-bit-float CACHE ENTRY — the untouched model outputs — never a
   * deck's captured input, which is the mix and not the stems. `Deck.mode`'s
   * `'export'` name is about the drain discipline in `deck.js` and has meant
   * nothing about exporting since.
   *
   * The capture stays ATTACHED on purpose: it is what holds Chrome's tab mute,
   * so the page's own audio cannot play underneath the stems.
   */
  d.mode = 'live';
  d.blocks = [];
  d.capturedFrames = 0;
  // Before the await: reading six WAVs back is ~254 MB of decode and takes a
  // visible moment, and a log line that only appears afterwards cannot explain
  // the pause it is describing. (Four stems was ~169 MB; the 16-bit cache scales
  // linearly with the stem count — docs/SIX-STEM-CONTRACT.md, known debt 3.)
  log(`[${d.id}] cache hit, reading stems: ${t.key}`);
  let entry = null;
  let cd = null;
  try {
    entry = await cache.get(t.key);
    if (!entry) return false;                 // evicted between has() and get()
    cd = cachedDeck(d.id);
    await cd.load({ stems: entry.stems, frames: entry.meta.frames, meta: entry.meta });
  } catch (e) {
    // A cache entry that will not load must not take the deck down with it. Drop
    // it and fall through to a live listen, which will re-prime — the failure
    // costs one real-time pass and nothing else. `cache.get` already handles a
    // missing or undecodable FILE; this is the entry that is internally wrong.
    log(`[${d.id}] ERROR reading cache, falling back to live: ${String((e && e.message) || e)}`);
    stopCached(d.id);
    await cache.delete(t.key).catch(() => {});
    return false;
  }
  playCachedAtPage(d.id);
  log(`[${d.id}] cache HIT — playing separated stems, 0 % GPU`);
  // The set of loaded decks just changed, exactly as it does on a live start.
  pushXfader(true);
  push(true);
  return true;
}

/**
 * Start or resume a cached deck at the page's playhead. The decision is
 * `resumeSeek` in cacheddeck.js, where it is pure and tested; this is the effect.
 */
function playCachedAtPage(id) {
  const cd = cachedDecks[id];
  const v = pageVideo[id];
  const to = resumeSeek(cd.positionSec(), cd.status, v ? v.currentTime : null);
  if (to != null) cd.seek(to);
  cd.play();
}

/** Tear a cached deck down and forget it. */
function stopCached(id) {
  const cd = cachedDecks[id];
  if (!cd) return;
  cd.stop();
  cd.dispose();
  cachedDecks[id] = null;
}

/**
 * Push the EFFECTIVE crossfader position to every deck. Effective, not raw:
 * a lone deck must never be attenuated 3 dB by a control the user has not
 * touched (engine/mixer.js effectiveXfPosition). Call this whenever the control
 * moves OR the set of loaded decks changes — the second one is the easy half to
 * forget, because nothing about it looks like a mixer event.
 */
/**
 * THE CROSSFADER POSITION THE DECKS ARE ACTUALLY RUNNING. Written by
 * `pushXfader()` and by nothing else.
 *
 * This exists because the echo used to RECOMPUTE `effective` from current deck
 * state instead of reporting what had been pushed, and the two are not the same
 * thing. `captureStart()` flips `deckLoaded(B)` to true without pushing, so
 * between capture and LIVE_START the echo published `effective: 0.5, parked:
 * null` while deck A was still running position 0 at stems [1,1,1,1] — and when
 * LIVE_START finally pushed, deck A snapped 0 -> 0.5, an audible 3 dB drop
 * mid-set. Reproduced three times by the console team.
 *
 * Deriving the echo separately from the push made the echo capable of describing
 * a world that does not exist. Same shape as the meter/crossfader split: two
 * places computing what should be one value. Now there is one value, the decks
 * get it first, and the echo can only ever report it.
 */
let appliedXf = { position: null, loaded: { A: false, B: false } };

function pushXfader(immediate = false) {
  const loaded = { A: deckLoaded(decks.A), B: deckLoaded(deckB) };
  const p = effectiveXfPosition(state.xf.position, loaded);
  // mixTarget, not `d.live`: a cached deck is on the crossfader like any other.
  for (const d of liveDecks()) mixTarget(d.id).setXfader(p);
  appliedXf = { position: p, loaded };
  // A deck loading or unloading is a discrete event that MOVES THE FADER without
  // the user touching it. That is the one echo that must never be throttled.
  echoXf(immediate);
  return p;
}

/**
 * Reconcile the crossfader against the set of loaded decks.
 *
 * Called from `snapshot()`, which is the ONE choke point every state change
 * already flows through — `attach`, `detach`, a live start or stop, a halt, a
 * disposal all call `push()`. Chasing individual mutation sites is what produced
 * the bug above: `pushXfader()` was correctly called from `startLive` and
 * `stopDeck` and missed at `captureStart`, and nothing structural said it had to
 * be anywhere. A key comparison is cheap and cannot be forgotten.
 */
/** memoised arm reference — see shared.armRefMs(). Null when no deck is live. */
let armRefCache = null;
let lastLoadedKey = null;
function reconcileXf() {
  const key = `${deckLoaded(decks.A) ? 1 : 0}${deckLoaded(deckB) ? 1 : 0}`;
  if (key === lastLoadedKey) return;
  lastLoadedKey = key;
  pushXfader(true);
  reconcileMaster();
}

/**
 * The dual-deck master trim. See shared/config.js DUAL_MASTER_TRIM_DB for why it
 * exists and why it is -3 dB.
 *
 * Keyed on how many decks are LOADED, deliberately — not on whether any stem is
 * hard-assigned. A user who loads a second deck and leaves everything on the
 * crossfader must not get a different master gain from one who routes
 * immediately; the gain staging is a property of "there are two decks in the
 * mix", not of how they are routed.
 *
 * A DEFAULT, NOT A CLAMP: any deck whose master the user has touched is skipped
 * forever after. Reverts to 0 dB when a deck is unloaded, for the same reason it
 * applied in the first place — and for the same decks, i.e. only the untouched
 * ones.
 */
function reconcileMaster() {
  const n = [decks.A, deckB].filter(deckLoaded).length;
  const want = masterTrimDb(n);
  for (const d of liveDecks()) {
    // A cached deck carries the same three master fields for exactly this loop —
    // skipping it would leave a cached/live pair without the trim, which is the
    // configuration the trim was ratified for.
    const t = mixTarget(d.id);
    if (t.masterUserSet) continue;                   // theirs now
    if (t.masterDb === want) continue;
    t.setMasterGain(want, true);
    log(`deck ${d.id} master -> ${want} dB (${n >= 2 ? 'two decks loaded' : 'single deck'}, engine default)`);
  }
}

/**
 * THE authoritative crossfader echo (settled 2026-08-09).
 *
 * The UI owns the fader widget, so it is tempting to let it be the source of
 * truth and send nothing back. That is wrong here for one specific reason:
 * `position` and `effective` DIVERGE. When only one deck is loaded the engine
 * parks the fader on that deck so a lone deck is never attenuated 3 dB by a
 * control nobody touched (effectiveXfPosition) — so what the user set and what
 * is being applied are two different numbers, and a UI that renders the first
 * while the audio follows the second is lying to a performer.
 *
 * Six bugs in this project have come from a UI inferring a value the engine knew.
 * This message exists so there is nothing left to infer:
 *
 *   XF_STATE { position, effective, parked, curve, assign:{A:[…],B:[…]}, loaded:{A,B} }
 *
 * `assign` is one entry PER STEM, in `STEMS` order — six of them now, not four.
 * A UI that writes only the first four leaves guitar and piano unassigned, which
 * engine/mixer.js §xfStemGain calls out as the failure mode of the OFF case.
 *
 *   position   0..1, what the user last set. Survives parking.
 *   effective  0..1, what the gains are actually computed from. Equal to
 *              `position` whenever both decks are loaded.
 *   parked     null, or 'A'/'B' — the deck the fader is pinned to and why the
 *              two numbers differ. Render the cap at `effective` and, if
 *              `parked`, say so rather than letting the user wonder.
 *   assign     per deck, in STEMS order, one of 'A' | 'B' | 'XF'.
 *   loaded     which decks have audio. Parking is a function of exactly this.
 *
 * Throttled to XF_ECHO_HZ: a drag produces ~60 position messages a second and
 * the echo is for OTHER surfaces and for reconnect, not for the widget that
 * just moved. Discrete changes (curve, assign, a deck loading) bypass the
 * throttle — they are rare and must never be a frame late.
 */
const XF_ECHO_HZ = 20;
let xfEchoAt = 0, xfEchoTimer = null;
function echoXf(immediate = false) {
  // REPORTS, never derives. `appliedXf` is what the decks were told; recomputing
  // it here is what let the echo run ahead of the audio.
  const l = appliedXf.loaded;
  const eff = appliedXf.position != null ? appliedXf.position : state.xf.position;
  const msg = {
    type: 'XF_STATE',
    position: state.xf.position,
    effective: eff,
    parked: eff === state.xf.position ? null : (l.A && !l.B ? 'A' : !l.A && l.B ? 'B' : null),
    curve: state.xf.curve,
    assign: { A: decks.A.live.xf.assign.slice(), B: deckB ? deckB.live.xf.assign.slice() : null },
    loaded: l,
  };
  const now = performance.now();
  if (immediate || now - xfEchoAt >= 1000 / XF_ECHO_HZ) {
    if (xfEchoTimer) { clearTimeout(xfEchoTimer); xfEchoTimer = null; }
    xfEchoAt = now;
    return send(msg);
  }
  // Trailing edge, so the LAST position of a drag is always echoed even though
  // the ones in the middle were dropped. Without it the UI's final state is
  // whatever happened to land on a throttle boundary.
  if (xfEchoTimer) return;
  xfEchoTimer = setTimeout(() => { xfEchoTimer = null; echoXf(true); },
    Math.max(0, 1000 / XF_ECHO_HZ - (now - xfEchoAt)));
}

let tickCount = 0;

// Global master meter -> the UI, ~30 Hz. Deliberately a SEPARATE message type
// from METERS: METERS is per deck and carries `deck`, and folding a global
// reading into a deck-keyed message would force the UI to infer which of the two
// copies is authoritative. See the contract note in docs.
master.onMeters = (m) => {
  if (!liveDecks().some((d) => d.live.status === 'running' || d.live.status === 'starving')) return;
  send({
    type: 'MASTER_METERS',
    peak: { l: m.peakL, r: m.peakR, master: Math.max(m.peakL, m.peakR) },
    rms: { l: m.rmsL, r: m.rmsR, master: Math.max(m.rmsL, m.rmsR) },
    clip: !!m.clip,
  });
};

// ---------------------------------------------------------------------- live
/**
 * The shipping CAPTURE_START comes from the service worker and cannot know which
 * mode the user will pick, so it attaches in 'export' mode and onTick drains the
 * ring destructively. Live mode must NOT drain: it reads the last 7.8 s by
 * absolute frame on every chunk, and a skipped chunk is filled from that same
 * history. Flip the mode here. drain() only advances the read index, it does not
 * erase the ring, so the history live mode needs is still resident.
 */
/**
 * THE FORK: cached playback if we have already separated this track, a live
 * prime if we have not.
 *
 * This is the only place the two paths are chosen between, deliberately — the
 * decision depends on the deck's source URL and the hop, both of which are
 * settled by the time anything asks to go live, and nothing downstream should
 * have to ask again.
 */
async function startLive(d) {
  // Already holding a cached track: this is a RESUME, not a fresh start. The
  // surfaces send LIVE_START for "the video started playing" and do not know
  // which kind of deck they have.
  if (isCached(d.id)) { playCachedAtPage(d.id); return; }

  const t = trackKey(d);
  /**
   * CACHED PLAYBACK REQUIRES THE PAGE TRANSPORT, for the same reason priming
   * does and it is not the same reason as the cache key. Without it we do not
   * know WHERE the user's video is, so the stems would start at 0:00 against a
   * picture already 1:30 in. Only the embedded build can tell us — so the
   * side-panel build never plays from the cache even when the entry is there,
   * and that is correct rather than a gap: it has no video to line up with.
   */
  if (t && pageVideo[d.id] && await cache.has(t.key) && await startCached(d, t)) return;

  d.mode = 'live';
  // Anything already captured belongs to a prime that is not going to happen.
  // Drop it rather than let a later `DEV_DUMP` write out a stale fragment
  // (QA-01 is the same class of bug). This used to name EXPORT_START, from the
  // removed job path; an export reads the 32f cache entry and never touches
  // `blocks`.
  d.blocks = [];
  d.capturedFrames = 0;
  const why = beginPrime(d, t);
  if (why) log(`[${d.id}] not caching this listen — ${why}`);
  await d.live.start();
  // The set of loaded decks just changed, so the EFFECTIVE crossfader position
  // may have: one deck parks hard on itself, two decks honour the control.
  pushXfader(true);
}

async function stopDeck(d) {
  // BEFORE detach(), because the commit decision reads `pageVideo` and the
  // writer, and detach() is what tears the pipeline down. A prime that is
  // complete becomes a cache entry here and nowhere else.
  await endPrime(d);
  stopCached(d.id);
  await d.detach();
  push(true);
  // load state changed -> the effective crossfader position may have too
  pushXfader(true);
}

// ------------------------------------------------------------------- capture
/**
 * `sourceToken`, and SO IS THE WIRE FIELD since S11 froze Host interface v1: the
 * token is OPAQUE to the engine. The Host mints it — under this Host, the
 * service worker's `chrome.tabCapture.getMediaStreamId` — and the engine only
 * carries it back to `host.captureStream`. It used to arrive as
 * `CAPTURE_START.streamId`, which is a Chrome noun on a wire the unit is
 * forbidden to know the Host of; the parameter here was already right and the
 * envelope was not.
 *
 * `source` IS `{title, url}` AND HAS NO TAB ID, for the same reason and with a
 * sharper edge: nothing in the unit ever read `source.tabId`, so the field cost
 * a second Host a value it had to invent to fill a shape nobody consumed.
 *
 * THE SAB CHECK IS FIRST, BEFORE THE TOKEN IS SPENT, and that ordering is R5:
 * a stream opened and then abandoned holds the user's tab muted. Everything
 * after the stream exists is inside the try/catch below for the same reason.
 */
async function captureStart(sourceToken, source, mode = 'export', id = DECK_DEFAULT) {
  if (!SAB_OK) throw new Error('SharedArrayBuffer unavailable — the capture ring cannot be built');
  const d = deck(id);
  const s = await host.captureStream(sourceToken);
  // Review finding M2: attach can throw on a re-entrant start or inside
  // ensureContext. Chrome mutes a tab the moment it is captured, so a
  // dropped-but-live track leaves the user's tab permanently silent with no
  // affordance to fix it. Stop it on every failing path.
  try {
    await ensureContext();
    await d.attach(s, source, mode);
  } catch (e) {
    s.getTracks().forEach((t) => t.stop());
    throw e;
  }
  if (d.id === DECK_DEFAULT) {
    state.job = { status: 'idle', chunk: 0, chunks: 0, pct: 0, elapsedMs: 0, etaMs: null, error: null, stage: null };
  }
  // Attaching a capture makes this deck LOADED, which changes the effective
  // crossfader position. `push(true)` reconciles via snapshot(), but say it here
  // too: this is the site whose omission caused the audible snap.
  pushXfader(true);
  push(true);
  // Model download runs in parallel with the recording — it is pure data fetch.
  d.ensureSession().catch(() => {});
}

// --------------------------------------------- dev-only output tap (?dev=1)
/**
 * Records a deck's playback worklet output back through the already-verified
 * tap-capture worklet + SAB ring, so tools/run-ext.mjs can MEASURE the live
 * output — latency, seam levels, and how long a mid-stream gain change takes to
 * appear — instead of asserting it from the code.
 *
 * Tapped BEFORE the master WaveShaper: Chrome's 4x-oversampled shaper has its
 * own up/down-sampling filter delay, which would bias a 20 ms measurement. One
 * tap per deck, so a two-deck run can cross-correlate A against B.
 */
function attachTap(d) {
  if (!d.live.node) throw new Error(`deck ${d.id}: no live graph to tap`);
  const sab = new SharedArrayBuffer(ringByteLength(RING_FRAMES));
  const r = new RingConsumer(sab, RING_FRAMES);
  const n = new AudioWorkletNode(ctx, 'tap-capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { sab, capacity: RING_FRAMES },
  });
  const silent = new GainNode(ctx, { gain: 0 });
  d.live.node.connect(n);
  n.connect(silent).connect(ctx.destination);
  // Both worklets advance 128 frames per render quantum in the same audio
  // thread, so capture-ring frame `tapBase + t` and tap frame `t` are the SAME
  // instant. That is what lets the harness measure end-to-end latency by
  // cross-correlating the two recordings instead of trusting a formula.
  //
  // It is also what makes the TWO-DECK alignment gate possible: both taps are
  // driven by the same audio clock, so tap-A frame t and tap-B frame t are the
  // same instant too.
  d.tap = { ring: r, node: n, silent, blocks: [], frames: 0, dropped: 0, marks: [],
            tapBase: d.ring ? d.ring.writeFrames() : 0 };
  n.port.onmessage = () => drainTap(d);
}
/**
 * A tap on the MASTER BUS — the sum of both decks, before the soft clipper.
 *
 * AC-3.1.c needs the combination measured, not the decks. Tapped at
 * `master.input()` (the meter node's output) so it is exactly what the two decks
 * summed to, with no clipper non-linearity in the way, and it is driven by the
 * same audio clock and the same 128-frame quantum as the per-deck taps — so
 * master frame t and deck frame t are the SAME INSTANT by construction. That is
 * what makes a null possible at all without any alignment step.
 */
let masterTap = null;
function attachMasterTap() {
  if (masterTap) return;
  if (!master.input()) throw new Error('no master bus to tap');
  const sab = new SharedArrayBuffer(ringByteLength(RING_FRAMES));
  const r = new RingConsumer(sab, RING_FRAMES);
  const n = new AudioWorkletNode(ctx, 'tap-capture', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { sab, capacity: RING_FRAMES },
  });
  const silent = new GainNode(ctx, { gain: 0 });
  master.input().connect(n);
  n.connect(silent).connect(ctx.destination);
  masterTap = { ring: r, node: n, silent, blocks: [], frames: 0, dropped: 0, marks: [] };
  n.port.onmessage = () => drainTap(masterTap);
}

function drainTap(d) {
  // Accepts a Deck (drains `d.tap`) or a bare tap object (the master tap).
  const t = d && d.tap !== undefined ? d.tap : d;
  if (!t) return;
  const x = t.ring.drain();
  if (!x) return;
  t.blocks.push(x);
  t.frames += x.l.length;
  t.dropped += x.dropped;
}
/** Stamp a deck's tap frame clock at the instant a mixer message is handled. */
function markTap(d, kind, detail) {
  if (!d.tap) return;
  d.tap.marks.push({ kind, ...detail, atFrame: d.tap.ring.writeFrames() });
}
/** Stamp EVERY attached tap — for global controls (crossfader, curve). */
function detachTap(d) {
  if (!d.tap) return null;
  d.tap.node.port.postMessage('stop');
  d.tap.node.port.onmessage = null;
  d.tap.node.disconnect();
  d.tap.silent.disconnect();
  const t = d.tap;
  d.tap = null;
  return t;
}

// -------------------------------------------------- dev-only synthetic source
// Exercises the whole Phase-1 capture graph (AudioContext@44100 + worklet + SAB
// ring + drain) without tabCapture, and re-verifies R0's Q7b in our own code: a
// tone generated in a 48 kHz context must read back at its true frequency, not
// at 44100/48000 of it. Dev-only; nothing in the shipped UI sends it.
async function devCapture(hz, id = DECK_DEFAULT) {
  await ensureContext();
  const d = deck(id);
  const tctx = new AudioContext({ sampleRate: 48000 });   // pretend to be a tab
  const dest = tctx.createMediaStreamDestination();
  const osc = tctx.createOscillator();
  osc.frequency.value = hz;
  const g = new GainNode(tctx, { gain: 0.5 });
  osc.connect(g).connect(dest);
  osc.start();
  d.devTone = { ctx: tctx, osc };
  await d.attach(dest.stream, { title: `dev tone ${hz} Hz @ 48 kHz`, url: 'synthetic' });
  push(true);
}

/**
 * Dev-only live source: plays the OPFS fixture through a *second* AudioContext's
 * MediaStreamAudioDestinationNode, i.e. through the identical MediaStream path
 * tabCapture uses. The stand-in context runs at 44100 so the
 * AudioBufferSourceNode plays at its native rate — at a different rate Blink
 * would resample it with LINEAR interpolation (docs/AUDIO.md §1.3), which would
 * corrupt the fixture before the model ever saw it.
 *
 * `file` lets deck B play a DIFFERENT fixture, which is the only way a two-deck
 * gate can prove the two decks are not accidentally the same signal.
 * `offsetSec` starts the same fixture at a different point, for the same reason.
 */
async function devLive({ hop, tap: wantTap, attachOnly, deck: id = DECK_DEFAULT, file, offsetSec = 0, autoStart = true } = {}) {
  await ensureContext();
  const d = deck(id);
  const buf = await readOpfsRoot(file || OPFS_DEV_INPUT);
  const wav = decodeWav(buf);
  if (wav.sampleRate !== SR) throw new Error(`fixture is ${wav.sampleRate} Hz — live needs ${SR}`);
  const tctx = new AudioContext({ sampleRate: SR });
  const ab = tctx.createBuffer(2, wav.channels[0].length, SR);
  ab.copyToChannel(wav.channels[0], 0);
  ab.copyToChannel(wav.channels[1] || wav.channels[0], 1);
  const dest = tctx.createMediaStreamDestination();
  const src = tctx.createBufferSource();
  src.buffer = ab;
  src.loop = true;
  src.connect(dest);
  src.start(0, offsetSec % ab.duration);
  d.devSrc = { ctx: tctx, src };
  // The hop is GLOBAL. Setting it on one deck and not the other is the exact
  // failure docs/AUDIO.md §8.1 warns about, so set it on every deck.
  if (hop) for (const x of liveDecks()) x.live.setHop(hop);
  // attach in the DEFAULT mode, exactly like the shipping CAPTURE_START path,
  // so startLive()'s mode flip is what the harness exercises
  await d.attach(dest.stream, { title: `dev live fixture ${d.id}`, url: file || 'fixture' });
  push(true);
  // `attachOnly` stops HERE, leaving the capture running in export mode with
  // nothing but the gain-0 sink attached to ctx.destination — which is the state
  // the side panel's START CAPTURE leaves behind while the user is still finding
  // the DJ console. LIVE_START then arrives from that other surface, seconds
  // later, exactly as it does for a human.
  if (attachOnly || !autoStart) return;
  await startLive(d);
  if (wantTap) attachTap(d);
}

/** Drop every previously exported stem. See QA-03 / SCOPE P7. */
async function writeRoot(root, name, buf) {
  const fh = await root.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
}
async function readOpfsRoot(name) {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(name);
  return (await fh.getFile()).arrayBuffer();
}

// ------------------------------------------------------------------ messages
/**
 * THE PAGE'S PLAYBACK RATE, per deck — the engine's record of how fast the tab's
 * own player is running. `1` until somebody says otherwise, which is also the
 * right answer for every build that has no content script to say it.
 *
 * IT IS A RECORD AND NOT A CONTROL. Nothing in the engine drives this number:
 * the rate is applied by `content.js` on the page's own `<video>`, the
 * capture tap sees the result, and every stage downstream of it is byte-for-byte
 * the code that ships today — one integer sample clock at 44 100 Hz, no JS
 * resampler, nothing about the ratified conversion line moved.
 *
 * AND IT MUST NEVER BE READ AS PERMISSION TO PRIME A CAPTURE FASTER THAN REAL TIME
 * (the spec ruling; `docs/AUDIO.md` §8.3 and `shared/stemcache.js`'s header settled
 * it on audio grounds long before it was a control). Capture is at 48 kHz whatever
 * the rate, so a fast pass throws away the top of the band and hands the separator
 * material it has never heard. Priming from a capture is one real-time pass. If a
 * future reader wants THIS FIELD for a prime decision, the answer is still no, and
 * the reason is unchanged: the rate is the page's, the capture follows it, and the
 * band is gone before the separator sees anything.
 *
 * THAT IS A STATEMENT ABOUT CAPTURE, NOT ABOUT SEPARATION, and the distinction
 * became load-bearing when a Source stopped always being a tab. A FILE is decoded
 * whole at the model's clock before any window runs — no capture, no
 * `playbackRate`, nothing this field describes — so separating one ahead of time,
 * as fast as the machine allows, is outside what this paragraph forbids rather
 * than an exception to it. See `engine/offline.js`, which carries the same note
 * from the other side. The prohibition here is on reading `pageRate` and deciding
 * a capture may be hurried; that has not moved.
 *
 * @type {Record<'A'|'B', number>}
 */
const pageRate = { A: 1, B: 1 };

/**
 * ONE BOUNCE PER DECK AT A TIME, and a cancel flag beside it.
 *
 * TWO FLAGS AND NOT ONE, because they answer different questions: `bouncing`
 * refuses a second start while a render is in flight (two renders on one deck
 * would fight over the same track and both write to the Host's one gesture), and
 * `bounceCancelled` is polled BETWEEN producer stops, never mid-quantum, for the
 * same reason the ahead-of-time runner's cancel is checked between windows.
 *
 * `bounceCancelled` is cleared at the START of a run rather than at the end of
 * one, so a cancel that arrives after a run has already finished cannot silently
 * kill the next one.
 */
const bouncing = { A: false, B: false };
const bounceCancelled = { A: false, B: false };

/**
 * Report a bounce failure on the wire, with a code from the CLOSED set.
 *
 * The validation is `bounceWireCode` in `engine/bounce.js` and not a ternary
 * here, because it is the RUN-TIME half of #29 and a run-time property takes a
 * function a suite can run. The call site that needs it is the catch below —
 * `bounceFailed(id, e && e.code, …)`, where `e` is not always one of ours: a
 * disk-full inside `writeBounce`'s `pipeTo` arrives carrying `.code = 'ENOSPC'`.
 * Unvalidated that reaches `BOUNCE_ERROR.code`, which is ARM_CODES again — a
 * plausible code no table declares, on a surface, with nothing red anywhere.
 */
function bounceFailed(id, code, detail) {
  const c = bounceWireCode(code);
  const message = detail || BOUNCE_CODES[c];
  log(`ERROR [${id}] bounce ${c}: ${message}`);
  send({ type: 'BOUNCE_ERROR', deck: id, code: c, message });
}

/**
 * HOW MANY TIMES A TRANSPORT DRIVE HAS ASKED THIS DECK FOR A RATE IT CANNOT
 * PLAY AT, since the last release. A COUNT AND NOT A FLAG, because a Host whose
 * lock re-asserts at ~4 Hz for a whole track and one that asked once are
 * different facts about that Host and only the count tells them apart.
 *
 * It is a counter of REFUSALS and never a rate: nothing here stores what was
 * asked for, so this record cannot become the reader `pageRate` above says it
 * must not grow.
 *
 * @type {Record<'A'|'B', number>}
 */
const transportRateRefusals = { A: 0, B: 0 };

// The Host owns the routing guard and the listener's return value; `handle` is
// handed the raw envelope and its promise is deliberately not awaited — every
// case reports through `send`/`push`, and `handle`'s own catch is the only
// error path (see `fail()`).
host.onMessage(handle);

async function handle(m) {
  try {
    switch (m.type) {
      case 'STATUS':
        if (state.model.status === 'unknown') {
          state.model.status = (await host.modelCached()) ? 'cached' : 'absent';
        }
        decks.A.ensureBackend();
        echoXf(true);
        return push(true);

      case 'MODEL_LOAD':
        return void decks.A.ensureSession().catch(() => {});

      case 'CAPTURE_START':
        if (!m.deck || m.deck === DECK_DEFAULT) {
          state.job = { status: 'idle', chunk: 0, chunks: 0, pct: 0, elapsedMs: 0, etaMs: null, error: null, stage: null };
        }
        return void await captureStart(m.sourceToken, m.source, 'export', m.deck || DECK_DEFAULT)
          .catch((e) => fail('capture', e));

      case 'CAPTURE_STOP':
        return void await stopDeck(deck(m.deck || DECK_DEFAULT));

      // ------------------------------------------------- live (Modes 1 and 3)
      // These are the fast path: UI -> here in one hop, applied inside the
      // playback worklet. A fader move must not wait for a chunk boundary.
      case 'LIVE_START': {
        const d = deck(m.deck || DECK_DEFAULT);
        if (d.status !== 'recording') {
          send({ type: 'LIVE_ERROR', deck: d.id, code: 'NOT_CAPTURING', message: `Start capture on deck ${d.id} first — live mode needs the tab stream.` });
          return;
        }
        return void await startLive(d).catch((e) => d.live.fail('START_FAILED', e));
      }

      case 'LIVE_STOP': {
        const d = deck(m.deck || DECK_DEFAULT);
        // A cached deck has no live pipeline to stop, and stopping the one it
        // does not have would leave it playing. Both kinds answer to this
        // message because the surfaces that send it do not know which they have.
        if (isCached(d.id)) { cachedDecks[d.id].pause(); return; }
        await endPrime(d);
        return void await d.live.stop();
      }

      /**
       * THE PAGE'S TRANSPORT. Only the embedded build can send this — it is the
       * only one with a content script — and it is the input three separate
       * decisions read: whether a prime may start, whether a prime may commit,
       * and where a cached deck's playhead belongs after the user scrubs.
       *
       * It carries `currentTime` and `duration` and nothing else about the
       * media. L1: this is the same transport state `content.js` has read
       * since it was written, widened from one number to three. No `src`, no
       * `buffered`, no `currentSrc`.
       */
      case 'PAGE_VIDEO': {
        const id = normalizeDeckId(m.deck);
        const t = Number(m.currentTime), dur = Number(m.duration);
        if (!Number.isFinite(t)) return;
        pageVideo[id] = {
          currentTime: t,
          duration: Number.isFinite(dur) ? dur : 0,
          ended: m.ended === true,
          atMs: Date.now(),
        };
        // A scrub moves a cached deck's playhead; there is no re-prime to pay
        // for, which is the whole difference from a live deck (cacheddeck.js
        // seek()). The live path handles its own jump elsewhere.
        if (m.seeking === true && isCached(id)) cachedDecks[id].seek(t);
        return;
      }

      /**
       * THE OTHER END OF A DeckTransport WHOSE PLAYER IS THIS ENGINE.
       *
       * A Host whose Source is a FILE has no `<video>` to report or to write,
       * so it presents a `DeckTransport` backed by the cached deck's own
       * playback clock: it relays `TRANSPORT_STATE` (cacheddeck.js
       * pushTransport) to the deck as `onState`, and it sends these two back.
       * That is what makes a File source a hosted deck rather than one
       * declaring `transport: null` — which reads as "nobody will ever tell me
       * whether a player is playing" and makes `follow()` start a capture and a
       * 109 MB model load on boot. Upstream #43; `shared/host.js`'s
       * `DeckTransport` typedef carries the duty prose.
       *
       * `m` IS PASSED WHOLE, ENVELOPE AND ALL, ON PURPOSE. The write set is
       * closed inside `CachedDeck.drive()`, which reads three named fields and
       * ignores everything else — so this call site is also the proof that the
       * closure is the DECK's and not a filter some caller can forget. A field a
       * Host smuggles in reaches here and lands nowhere.
       *
       * NOTHING TO DRIVE IS SAID RATHER THAN SWALLOWED. A drive for a deck with
       * no cached track is a Host and an engine that disagree about what is
       * loaded, and a silent drop leaves a lock that believes it was taken.
       */
      case 'TRANSPORT_DRIVE': {
        const id = normalizeDeckId(m.deck);
        if (!isCached(id)) {
          log(`[${id}] ignored a transport drive: no cached deck is loaded on it`);
          return;
        }
        cachedDecks[id].drive(m);
        /**
         * THE THIRD FIELD OF THE WRITE SET, REFUSED HERE AND NOT IN THE DECK.
         *
         * `qa/speed-pitch.mjs` asserts that no file under
         * `extension/{engine,offscreen,workers,shared}/` names the page rate in
         * code except this one, which owns the record above — so the deck
         * cannot spell this field, and that is the gate working rather than an
         * inconvenience. A cached deck has no rate to be driven to: the ring is
         * consumed by the audio device at its own rate, there is no resampler
         * on this path, and the transpose is length-exact. Same refusal, same
         * reason and nearly the same sentence as the `SPEED` handler's
         * `why: 'cache'` branch below.
         *
         * COUNTED ALWAYS, LOGGED ONCE PER DECK. A Host's video lock re-asserts
         * a correction at ~4 Hz, so one line per refusal buries the first and
         * only useful one — the same contract `cacheddeck.js`'s tempo-tap fault
         * keeps, for the same reason. The latch is cleared by a release, which
         * is the Host saying it has stopped driving.
         */
        const rate = Number(m.playbackRate);
        if (Number.isFinite(rate) && rate !== 1) {
          transportRateRefusals[id]++;
          if (transportRateRefusals[id] === 1) {
            log(`[${id}] TRANSPORT_DRIVE REFUSED ${rate} — this deck is playing stems from disk, so there `
              + 'is no page rate to drive and no resampler to make one. Counted from here, logged once.');
          }
        }
        return;
      }

      case 'TRANSPORT_RELEASE': {
        const id = normalizeDeckId(m.deck);
        if (!isCached(id)) {
          log(`[${id}] ignored a transport release: no cached deck is loaded on it`);
          return;
        }
        // Cleared FIRST, so a release that reports a total also ends the latch:
        // the next lock is a new lock and gets its own first line.
        if (transportRateRefusals[id]) {
          log(`[${id}] transport released after ${transportRateRefusals[id]} refused rate write(s)`);
          transportRateRefusals[id] = 0;
        }
        cachedDecks[id].release();
        return;
      }

      /** What the cache holds, for a surface that wants to show it. */
      case 'CACHE_STATUS':
        return void send({ type: 'CACHE_STATE', ...(await cache.report()) });

      case 'CACHE_CLEAR':
        await cache.clear();
        log('stem cache cleared');
        return void send({ type: 'CACHE_STATE', ...(await cache.report()) });

      /**
       * E1 — THE DELIVERABLE. The six untouched model outputs out of the 32f
       * tier, through `WavStreamEncoder`, into the writables the Host's
       * `exportSink` hands back. `engine/export.js` owns the run; this case owns
       * the three things that are not the run's business — which cache tier the
       * key names, where a frame comes from, and how a failure reaches the deck.
       *
       * `EXPORT_START { deck?, key, stems?, format? }`. The KEY is the caller's,
       * not a videoId: the entry was filed under whatever identity its Source
       * had (a content hash for a file, a video id for a tab), and the export
       * does not re-derive it. Re-deriving would be a second chance to look at
       * the wrong entry, which `shared/stemcache.js`'s header prices as the
       * worst failure this project can ship.
       *
       * IT IS NOT AWAITED HERE. `handle()`'s own catch reports through `fail()`,
       * which writes `state.job` — the wrong surface for this, because progress
       * and completion ride their own messages (a per-window tick through
       * `push()` would be coalesced away or would drag the whole snapshot
       * hundreds of times a track). So the run reports through `send` on the
       * export vocabulary, and every exit from it is one of the three messages
       * below.
       */
      case 'EXPORT_START': {
        const deckId = normalizeDeckId(m.deck);
        if (exportRun) {
          return void exportFailed(deckId, 'BUSY',
            'an export is already running — stop it before starting another, or two runs write windows into '
            + "each other's files");
        }
        const key = String(m.key || '');
        // The lookup itself is guarded, so a broken storage layer reports as an
        // export failure rather than falling through to `handle()`'s catch,
        // which writes `state.job` — a surface nothing renders and no export
        // reads.
        let entry;
        try { entry = await cache32.entry(key); } catch (e) {
          return void exportFailed(deckId, 'READ_FAILED',
            `the ${CACHE_DIR_32F} manifest could not be read — ${String((e && e.message) || e)}`);
        }
        if (!entry) {
          return void exportFailed(deckId, 'NO_ENTRY',
            `nothing is cached under ${JSON.stringify(key)} in the ${CACHE_DIR_32F} tier — separate the track first`);
        }
        const run = new ExportRun({
          entry,
          stems: Array.isArray(m.stems) ? m.stems : undefined,
          format: m.format || null,
          /**
           * ONE STEM, WINDOWED. `cache32.get(key)` would decode all six whole —
           * ~508 MB for four minutes — and would put back exactly the ceiling
           * the streaming writer exists to remove.
           */
          openStem: async (stem) => new WavWindowReader(await cache32.stemFile(key, stem)).open(),
          exportSink: (plan) => host.exportSink(plan),
          onProgress: (p) => send({ type: 'EXPORT_PROGRESS', deck: deckId, ...p }),
        });
        exportRun = run;
        log(`export ${key}: ${entry.frames} frames`);
        run.run().then(
          (r) => {
            log(`export done: ${r.files.length} file(s), ${r.bytes} bytes`);
            send({ type: 'EXPORT_DONE', deck: deckId, files: r.files, bytes: r.bytes });
          },
          (e) => exportFailed(deckId, e instanceof ExportError ? e.code : 'WRITE_FAILED', String((e && e.message) || e)),
        ).finally(() => { if (exportRun === run) exportRun = null; });
        return;
      }

      /**
       * A flag, checked between windows. There is no way to abandon a write
       * mid-window that leaves a file a reader can align, and there is nothing
       * to gain: a window is 4 s of one stem.
       */
      case 'EXPORT_CANCEL':
        if (exportRun) { exportRun.cancel(); log('export cancel requested'); }
        return;

      case 'SET_HOP': {
        // GLOBAL, no deck field. Two decks on different hops emit audio seconds
        // apart and nothing beat-matches (docs/AUDIO.md §8.1).
        const s = Number(m.seconds);
        for (const d of liveDecks()) d.live.setHop(s);
        return;
      }

      // Every one of these goes through `mixTarget`, never `d.live`. A fader that
      // works on a live deck and does nothing on a cached one is the same defect
      // four times over, which is why the branch is in one accessor.
      case 'STEM_GAIN': {
        const d = deck(m.deck || DECK_DEFAULT);
        markTap(d, 'gain', { stem: m.stem, gainDb: m.gainDb });
        return void mixTarget(d.id).setStemGain(m.stem, Number(m.gainDb));
      }

      case 'STEM_MUTE': {
        const d = deck(m.deck || DECK_DEFAULT);
        markTap(d, 'mute', { stem: m.stem, muted: !!m.muted });
        return void mixTarget(d.id).setStemMute(m.stem, m.muted);
      }

      case 'STEM_SOLO': {
        const d = deck(m.deck || DECK_DEFAULT);
        markTap(d, 'solo', { stem: m.stem, soloed: !!m.soloed });
        return void mixTarget(d.id).setStemSolo(m.stem, m.soloed);
      }

      case 'MASTER_GAIN': {
        const d = deck(m.deck || DECK_DEFAULT);
        markTap(d, 'master', { gainDb: m.gainDb });
        // `auto: false` — this latches `masterUserSet` and the engine's dual-deck
        // default stops touching this deck from here on.
        return void mixTarget(d.id).setMasterGain(Number(m.gainDb), false);
      }

      /**
       * THE TRANSPOSE. `{ type: 'PITCH', deck, semitones }`, integer in
       * [PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES], through `mixTarget` like every
       * other mixer message — a control that works on a live deck and does
       * nothing on a cached one is the defect the accessor exists to prevent, and
       * for this one the cached deck is the LIKELIER case: it is the deck that
       * can seek, so it is the deck a play-along user practises against.
       *
       * A REFUSAL IS SAID OUT LOUD, and this router is the only place that can
       * say it. Both deck kinds REFUSE an out-of-range interval rather than
       * clamping it (live.js setPitch, cacheddeck.js setPitch) and both return
       * false; `return void target.setPitch(...)` would drop that verdict on the
       * floor, and the UI — which holds its own copy of the number and composes
       * the key readout from it — would go on displaying a key the audio is not
       * in. That failure is silent by construction: the audio plays perfectly,
       * in the wrong key, with nothing on screen to say so.
       *
       * So a refusal does two things a caller can act on: a named log line (which
       * rides out on STATE.log and on DIAG), and a FORCED LIVE_STATE, whose
       * `pitchSemitones` is the engine's own value — one echo and the UI can put
       * itself back in step. Neither is emitted on the accepted path: the 10 Hz
       * heartbeat already carries `pitchSemitones`, and live.js logs the change.
       */
      case 'PITCH': {
        const d = deck(m.deck || DECK_DEFAULT);
        const t = mixTarget(d.id);
        const accepted = t.setPitch(m.semitones);
        // Marked with what was APPLIED and whether it was taken — never with what
        // was merely asked for. The marks are cross-correlated against the tap
        // recording, so a mark for a refused request would tell the probe a pitch
        // change happened at a frame where nothing changed.
        markTap(d, 'pitch', { semitones: t.semitones, requested: m.semitones, accepted });
        if (!accepted) {
          log(`[${d.id}] PITCH REFUSED ${JSON.stringify(m.semitones)} — not an integer semitone in ` +
            `[${PITCH_MIN_SEMITONES}, ${PITCH_MAX_SEMITONES}]; deck stays at ${t.semitones}`);
          t.pushState(true);   // the ENGINE's pitchSemitones, so the UI can correct itself
          push(true);          // ...and the log line, on the surface every other refusal uses
        }
        return;
      }

      /**
       * THE SPEED. `{ type: 'SPEED', deck, rate }`, the rate the tab's own
       * player is now running at. Routed here for the reasons PITCH is: this is
       * the one place that can tell a live deck from a cached one, and it is the
       * one place a refusal can be SAID.
       *
       * A CACHED DECK REFUSES, and that is the product ruling rather than an
       * implementation limit: a cached deck is playing our own stems off disk,
       * so the page's `<video>` is a picture and there is no page rate to drive.
       * Silently accepting would leave the deck's readout claiming a speed the
       * audio is not at — the same failure PITCH's refusal exists to prevent, and
       * silent by construction in the same way: everything plays perfectly, at
       * the wrong tempo, with nothing on screen to say so.
       *
       * IT ECHOES ON BOTH PATHS, and that is where it differs from PITCH. PITCH
       * can stay quiet on the accepted path because the 10 Hz heartbeat already
       * carries `pitchSemitones`; nothing on the heartbeat carries the page rate,
       * so an accepted SPEED with no echo would be a message with no receipt. One
       * message per discrete gesture, not a 10 Hz stream.
       *
       * THE RANGE IS NOT RE-CHECKED HERE, deliberately. `[0.5, 2.0]` is the last
       * gate before `video.playbackRate`, and that gate is in
       * `speed.js` — where the write happens, and where it is asserted. A
       * second copy of the two bounds in a file that cannot import them is how a
       * constant ends up right at one call site and wrong at another. What IS
       * checked here is the only thing this file can check on its own: that the
       * number is a number.
       */
      case 'SPEED': {
        const id = normalizeDeckId(m.deck);
        const r = Number(m.rate);
        if (!Number.isFinite(r) || r <= 0) {
          log(`[${id}] SPEED REFUSED ${JSON.stringify(m.rate)} — not a positive finite rate; `
            + `deck stays at ${pageRate[id]}`);
          push(true);
          return void send({ type: 'SPEED_STATE', deck: id, rate: pageRate[id], accepted: false, why: 'unreadable' });
        }
        if (isCached(id)) {
          log(`[${id}] SPEED REFUSED ${r} — this deck is playing stems from disk, so there is `
            + `no page rate to drive; deck stays at ${pageRate[id]}`);
          push(true);
          return void send({ type: 'SPEED_STATE', deck: id, rate: pageRate[id], accepted: false, why: 'cache' });
        }
        pageRate[id] = r;
        // `decks[id]`, not `deck(id)`: a record message must not CREATE deck B.
        // Marked with what was applied, never with what was merely asked for —
        // the marks are cross-correlated against the tap recording, and a mark
        // for a refused request would tell the probe something changed at a
        // frame where nothing did.
        if (decks[id]) markTap(decks[id], 'speed', { rate: r, accepted: true });
        return void send({ type: 'SPEED_STATE', deck: id, rate: r, accepted: true, why: null });
      }

      // ------------------------------------------------------ crossfader (M3)
      case 'DEV_DECK_DISPOSE': {
        // Probe-only: destroy a deck completely — worker, ORT session, capture —
        // so the NEXT arm of that deck creates a real InferenceSession again.
        //
        // This exists to make a fault-injection test deterministic. "Deck A must
        // not underrun while deck B arms" is a once-per-browser event otherwise,
        // because a Deck keeps its session for the life of the document, so a
        // 1-in-3 defect needed a 1-in-3 gate. With this, the scenario repeats in
        // ~15 s and the gate can run it ten times.
        if (m.deck !== 'B' || !deckB) return send({ type: 'DECK_DISPOSED', deck: m.deck, ok: false });
        await deckB.dispose().catch(() => {});
        detachTap(deckB);
        deckB = null;
        decks.B = null;
        pushXfader(true);        // one deck again -> the fader parks back on A
        log('deck B disposed (probe)');
        push(true);
        return send({ type: 'DECK_DISPOSED', deck: 'B', ok: true });
      }

      case 'DEV_SCHED':
        // Probe-only: arm/disarm L3 demotion so the gate can measure both. Not a
        // user setting — "should the machine protect deck A when it runs out of
        // GPU" is not a question a DJ should be asked mid-set.
        if (m.armed != null) gpu.armed = !!m.armed;
        if (m.deck) gpu.setPriority(m.deck);
        log(`scheduler: L3 ${gpu.armed ? 'armed' : 'off'}, priority ${gpu.priority}`);
        return send({ type: 'SCHED', ...gpu.report() });

      case 'DECK_PREPARE': {
        /**
         * Create a deck's ORT session NOW, with nothing playing, so that arming
         * it later costs nothing.
         *
         * `InferenceSession.create` compiles shaders on the shared GPU for ~8 s.
         * Doing that while another deck is live is the acute cause of STATUS §4a
         * A1: the live deck produces NOTHING for the whole period (measured 8 of
         * 8 arms) and its buffer trough never recovers. The work is unavoidable;
         * WHEN it happens is entirely our choice.
         *
         * Memory says this is nearly free to hold: two resident sessions measured
         * 753 MB against 772 MB for one (tools/mem-probe.mjs) because the weights
         * live in the GPU process, not the renderer heap. The ~1.15 GB is a
         * `create` transient, so the sessions are still created ONE AT A TIME —
         * `ensureSession` is serialised through `modelChain` for the byte load and
         * awaited here — rather than overlapping two transients.
         *
         * Deliberately NOT automatic at boot. A Mode 1 or Mode 2 user would pay
         * ~8 s of GPU work and a second worker for a deck they never arm, and
         * doing it during deck A's prime would push first playback from ~3.4 s to
         * ~10 s. The caller decides, because only the UI knows whether the user
         * is heading for the dual console.
         */
        const id = m.deck === 'B' ? 'B' : 'A';
        const d = deck(id);
        // Mark intent BEFORE the await: `armRefMs` counts prepared decks, and a
        // deck A that goes live during deck B's ~2.3 s prepare must already know
        // a second deck is coming or it arms for a machine to itself.
        d.prepared = true;
        const t0 = performance.now();
        try {
          await d.ensureSession();
          log(`deck ${id} session prepared in ${((performance.now() - t0) / 1000).toFixed(1)} s (nothing was playing)`);
          push(true);
          return send({ type: 'DECK_PREPARED', deck: id, ok: true, ms: Math.round(performance.now() - t0), ep: d.ep });
        } catch (e) {
          return send({ type: 'DECK_PREPARED', deck: id, ok: false, message: String((e && e.message) || e) });
        }
      }

      case 'DEV_CAPTURE':
        return void await devCapture(m.hz || 1000, m.deck || DECK_DEFAULT);

      case 'DEV_LIVE':
        return void await devLive({
          hop: m.hop, tap: m.tap !== false, attachOnly: !!m.attachOnly,
          deck: m.deck || DECK_DEFAULT, file: m.file, offsetSec: m.offsetSec || 0,
        }).catch((e) => { deck(m.deck || DECK_DEFAULT).live.fail('DEV_LIVE_FAILED', e); throw e; });

      case 'DEV_MASTER_TAP':
        attachMasterTap();
        return send({ type: 'MASTER_TAP_ON', ok: true });

      case 'DEV_ATTACH_TAP':
        // Companion to DEV_LIVE {attachOnly:true}: the tap can only hang off
        // live.node, which does not exist until the real LIVE_START has built
        // the playback graph.
        attachTap(deck(m.deck || DECK_DEFAULT));
        return;

      case 'DEV_LIVE_SNAP_IN': {
        // Freeze the alignment reference NOW rather than at dump time. The
        // capture ring only retains 23.6 s, so if the harness spends 20 s moving
        // faders before it dumps, the input covering the window it wants to
        // analyse has already been lapped.
        const d = deck(m.deck || DECK_DEFAULT);
        if (!d.tap) throw new Error(`deck ${d.id}: no tap attached`);
        const root = await navigator.storage.getDirectory();
        const inEnd = d.ring.writeFrames();
        const inFrames = Math.min(d.ring.cap - 8192, inEnd);
        const inStart = inEnd - inFrames;
        const il = new Float32Array(inFrames), ir = new Float32Array(inFrames);
        d.ring.readAt(inStart, inFrames, il, ir, 0);
        await writeRoot(root, d.id === DECK_DEFAULT ? 'live-in.wav' : `live-in-${d.id}.wav`,
          encodeWav([il, ir], { sampleRate: SR, bitDepth: 32, float: true }));
        d.tap.inSnap = { inStart, inFrames };
        log(`deck ${d.id} live input reference snapped: ${(inFrames / SR).toFixed(1)} s ending at capture frame ${inEnd}`);
        return send({ type: 'LIVE_SNAP_IN', deck: d.id, inStart, inFrames });
      }

      case 'DEV_FORCE_DROP': {
        const d = deck(m.deck || DECK_DEFAULT);
        return send({ type: 'LIVE_FORCED_DROP', deck: d.id, ...d.live.forceDrop(), drops: d.live.drops });
      }

      case 'DEV_LIVE_STATS': {
        const d = deck(m.deck || DECK_DEFAULT);
        return send({
          type: 'LIVE_STATS', deck: d.id, stats: d.live.stats(),
          tap: d.tap ? { frames: d.tap.frames, dropped: d.tap.dropped, marks: d.tap.marks } : null,
          gpu: gpu.report(),
        });
      }

      case 'DEV_OUTPUT_PROBE': {
        const d = deck(m.deck || DECK_DEFAULT);
        return send({ type: 'LIVE_OUTPUT_PROBE', deck: d.id, ...d.live.outputProbe(), ...d.live.probeTerminal(), deckEdge: d.live.probeDeckEdge() });
      }

      case 'DEV_LIVE_DUMP': {
        // Dump BOTH sides of the pipeline so the harness can measure end-to-end
        // latency and null the output against its own input, rather than
        // trusting a counter or a formula.
        const d = deck(m.deck || DECK_DEFAULT);
        const stats = d.live.stats();
        const outLatency = ctx ? ctx.outputLatency : null;
        const baseLatency = ctx ? ctx.baseLatency : null;
        await d.live.stop();
        drainTap(d);
        const t = detachTap(d);
        if (!t) throw new Error(`deck ${d.id}: no tap attached`);
        const root = await navigator.storage.getDirectory();
        const suffix = d.id === DECK_DEFAULT ? '' : `-${d.id}`;

        const l = new Float32Array(t.frames), r = new Float32Array(t.frames);
        let o = 0;
        for (const b of t.blocks) { l.set(b.l, o); r.set(b.r, o); o += b.l.length; }
        await writeRoot(root, suffix ? `live-tap${suffix}.wav` : OPFS_LIVE_TAP,
          encodeWav([l, r], { sampleRate: SR, bitDepth: 32, float: true }));

        // the matching slice of what actually went IN, straight off the ring —
        // unless DEV_LIVE_SNAP_IN already froze one, which is the robust path
        let { inStart, inFrames } = t.inSnap || {};
        if (!t.inSnap) {
          const inEnd = d.ring.writeFrames();
          inFrames = Math.min(d.ring.cap - 8192, inEnd);
          inStart = inEnd - inFrames;
          const il = new Float32Array(inFrames), ir = new Float32Array(inFrames);
          d.ring.readAt(inStart, inFrames, il, ir, 0);
          await writeRoot(root, `live-in${suffix}.wav`, encodeWav([il, ir], { sampleRate: SR, bitDepth: 32, float: true }));
        }

        log(`deck ${d.id} live tap dumped: ${t.frames} out frames (${t.dropped} dropped), ${inFrames} in frames`);
        return send({
          type: 'LIVE_TAP', deck: d.id, frames: t.frames, dropped: t.dropped, marks: t.marks, stats,
          tapBase: t.tapBase, inStart, inFrames, outLatency, baseLatency,
        });
      }

      /**
       * ONE PASTE. Everything that decides whether live mode makes a sound, read
       * out of the running system rather than inferred from the code.
       *
       * Deliberately NOT behind ?dev=1: it exists to be run by a user whose deck
       * is silent, in the session that is silent. Read-only except for
       * `probeTerminal()`/`probeDeckEdge()`, which remove and re-add one graph
       * edge inside a single task — no render quantum sees the change — and
       * those edges existing is the single most load-bearing fact here.
       */
      case 'DIAG': {
        const c = ctx;
        let devices = null;
        try {
          devices = (await navigator.mediaDevices.enumerateDevices())
            .filter((x) => x.kind === 'audiooutput')
            .map((x) => ({ id: x.deviceId, label: x.label || '(no label — needs mic permission)' }));
        } catch (e) { devices = String(e.message || e); }
        /**
         * ONE DECK'S half of the paste.
         *
         * THERE IS DELIBERATELY NO TOP-LEVEL `capture` / `live` / `worklet`
         * MIRROR OF DECK A, and that is a breaking change to the "one paste"
         * contract made on purpose.
         *
         * A mirror is the obvious kindness: every existing habit, every doc
         * example and `tools/order-probe.mjs` all read `D.capture.mode`, and
         * keeping deck A at the top level would have cost one line. It is
         * refused because of what it would do on the day it matters. This
         * diagnostic exists for a user whose deck is SILENT. With two decks, the
         * silent one is as likely to be B as A — and a top-level block that
         * always describes A would answer "why is my deck silent?" with a
         * confident, well-formatted, entirely accurate description of the deck
         * that is working fine. The reader would then trust it, because it looks
         * like an answer.
         *
         * That is the exact shape of the four green-and-silent defects this
         * project has already shipped: a correct measurement of the wrong thing,
         * presented as if it were a measurement of the right thing. Every one of
         * them was caught late precisely because something upstream looked
         * healthy. Here the failure is foreseeable, so it is designed out rather
         * than diagnosed later: `decks.A` and `decks.B` both exist, both are
         * always present (B is `null` when it has never been created), and the
         * reader is forced to say which deck they mean.
         *
         * Shared facts — `ctx`, `gpu`, `xf`, `output`, `devices`, `doc` — appear
         * ONCE, at the top level, for the mirror-image reason: there is exactly
         * one of each, and duplicating them per deck would invite the reader to
         * compare two copies of the same number and infer a difference.
         */
        const deckDiag = async (d) => ({
          id: d.id,
          session: d.session, sessionError: d.sessionError, ep: d.ep,
          capture: {
            mode: d.mode, status: d.status, seconds: +d.seconds().toFixed(2),
            dropped: d.dropped, peak: d.peak, source: d.source,
            trackState: d.stream ? d.stream.getAudioTracks().map((t) => ({ readyState: t.readyState, muted: t.muted, enabled: t.enabled, settings: t.getSettings() })) : null,
            ringWrite: d.ring ? d.ring.writeFrames() : null,
            ringRead: d.ring ? d.ring.readFrames() : null,
            ringCap: d.ring ? d.ring.cap : null,
            // `blocks` is the destructive-drain backlog: it MUST be 0 while live
            // runs, and anything else means something is still eating the ring.
            drainedBlocks: d.blocks.length, frameCounter: d.capturedFrames,
          },
          live: {
            outputAlarm: d.live.outputAlarm, outputAlarmVariant: d.live.outputAlarmVariant,
            // The "playing and producing NOTHING" watchdog. `outputChecks` is
            // here so a reader can tell a watchdog that looked from one that
            // never ran — the two report the same `null` alarm.
            outputVerdict: d.live.outputVerdict, outputChecks: d.live.outputChecks,
            deadTicks: d.live.deadTicks, inputPeak: d.ring ? d.ring.peaks() : null,
            healthAgeMs: d.live.lastHealthAt ? +(performance.now() - d.live.lastHealthAt).toFixed(0) : null,
            status: d.live.status, phase: d.live.phase, hopSec: d.live.plan ? d.live.plan.hopSeconds : null,
            k: d.live.k, drops: d.live.drops, demotions: d.live.demotions,
            overruns: d.live.overruns, staleReads: d.live.staleReads,
            chunkFails: d.live.chunkFails, inFlight: d.live.inFlight, stopped: d.live.stopped,
            baseFrame: d.live.baseFrame, graphBuilt: !!d.live.node,
            armTimerPending: !!d.live.startTimer, pushTimerRunning: !!d.live.pushTimer,
            playing: d.live.out ? d.live.out.playing() : null,
            stemRingWrite: d.live.out ? d.live.out.writeFrames() : null,
            stemRingRead: d.live.out ? d.live.out.readFrames() : null,
            cushionSec: d.live.out ? +(d.live.out.cushion() / SR).toFixed(3) : null,
            underruns: d.live.health.underruns, underrunFrames: d.live.health.underrunFrames,
            latencySec: +d.live.latencySec().toFixed(3),
            mix: d.live.mix, xf: d.live.xf, lastMeters: d.live.lastMeters,
            // is THIS deck wired into the shared master at all? The shared bus
            // cannot answer that — the other deck's signal masks it.
            deckEdge: d.live.probeDeckEdge(),
          },
          worklet: await d.live.workletReport(),
        });
        const diag = {
          when: new Date().toISOString(),
          doc: { id: DOC_ID, bootAt: new Date(BOOT_AT).toISOString(), upSec: +((Date.now() - BOOT_AT) / 1000).toFixed(1), url: location.href },
          boot: state.boot,
          model: { status: state.model.status, phase: state.model.phase, fromCache: state.model.fromCache, source: state.model.source, error: state.model.error },
          ctx: c ? {
            state: c.state, sampleRate: c.sampleRate, currentTime: +c.currentTime.toFixed(2),
            baseLatency: c.baseLatency,
            outputLatency: c.outputLatency,
            sinkId: typeof c.sinkId === 'string' ? (c.sinkId || '(default)') : c.sinkId ? 'object' : '(unsupported)',
          } : null,
          devices,
          jobStatus: state.job.status, jobError: state.job.error,
          gpu: gpu.report(),
          xf: { ...state.xf },
          decks: { A: await deckDiag(decks.A), B: deckB ? await deckDiag(deckB) : null },
          output: { ...master.probeState(), ...master.probeTerminal(), meters: master.meters },
          log: state.log.slice(-40),
        };
        console.log('[engine] DIAG', diag);
        return send({ type: 'DIAG_REPORT', diag });
      }

      case 'DEV_DUMP': {
        const { l, r } = decks.A.drainCaptured();
        const root = await navigator.storage.getDirectory();
        await writeRoot(root, 'dev-capture.wav', encodeWav([l, r], { sampleRate: SR, bitDepth: 32, float: true }));
        log(`dev capture dumped: ${l.length} frames`);
        return push(true);
      }

      // ------------------------------------------------------------- bounce
      /**
       * A FILE SOURCE IS THE ONLY KIND A BOUNCE CAN RENDER, and the refusal says
       * WHICH of the two reasons applies rather than reporting one for both: a
       * deck with nothing loaded and a deck playing live are different problems
       * with different fixes, and a single "cannot bounce" would make the user
       * guess which they have.
       *
       * The settings are read ONCE, here, into a flat record. A render takes
       * minutes and a user who moves a fader during one must not silently change
       * what is already half-written — a bounce is of the settings AS THEY WERE
       * WHEN IT WAS ASKED FOR, which is also the only definition a progress bar
       * can be honest about.
       */
      case 'BOUNCE_START': {
        const id = normalizeDeckId(m.deck);
        const cd = cachedDecks[id];
        if (bouncing[id]) return void bounceFailed(id, 'BUSY');
        /**
         * THE REFUSAL IS A VALUE, NOT A TERNARY HERE, AND THAT IS THE FIX FOR A
         * DEFECT THAT SHIPPED. This line read
         *
         *     if (!cd || !cd.track) bounceFailed(id, isCached(id) ? 'NO_TRACK' : 'NOT_CACHED');
         *
         * and `isCached` (`:534`) is `!!(cachedDecks[id] && cachedDecks[id].track)`
         * — the exact negation of the `if`, with no await between them. So
         * `NO_TRACK` was UNREACHABLE and every refusal said `NOT_CACHED`.
         * `engine/bounce.js`'s `bounceRefusal` carries the decision and the whole
         * story; qa/bounce.mjs drives every state through it and reads the code
         * back, because the assertion that used to guard this scanned this file
         * for the two STRING LITERALS and both were present the whole time.
         *
         * AND IT TAKES TWO FACTS, NOT A `CachedDeck`. The first repair passed
         * `cd` and read `!cd -> NOT_CACHED`, which leaves the reviewer's own
         * failing case unfixed: `stopCached()` a few hundred lines up sets
         * `cachedDecks[id] = null` immediately after `cd.stop()`, so a deck that
         * HAD a track and was unloaded arrives here with no `CachedDeck` at all
         * and is indistinguishable, by that test, from a live one. Liveness is
         * not derivable from `cachedDecks`; it is `deckIsLive`, and it is passed
         * in so the two facts stay independent.
         */
        const refusal = bounceRefusal({
          cachedTrack: !!(cd && cd.track),
          // `decks[id]`, never `deck(id)` — `deck('B')` CONSTRUCTS deck B, which
          // is 1.7 GB of session state built by a refusal.
          live: deckIsLive(decks[id]),
        });
        if (refusal) return void bounceFailed(id, refusal);
        bouncing[id] = true;
        bounceCancelled[id] = false;
        const t0 = Date.now();
        const title = (cd.track.meta && (cd.track.meta.title || cd.track.meta.videoId)) || `deck ${id}`;
        try {
          const r = await bounceToSink({
            track: cd.track,
            settings: bounceSettings(cd),
            title,
            assetUrl: host.assetUrl,
            // A WRAPPER, AND NOT FOR THE REASON THIS COMMENT USED TO GIVE. It
            // claimed a bare `exportSink: host.exportSink,` would be invisible to
            // the seam scan in test.js. It would not: that scan is
            // `reached = dutyCalls ∪ dutyRefs`, and `dutyRefs` matches
            // `host.<name>` followed by a comma — i.e. exactly the hand-off form.
            // The wrapper stays because it puts THIS file and THIS line in the
            // stack of a Host that throws, which is what `SINK_REFUSED`'s detail
            // is read off; it is not load-bearing for the exemption bookkeeping.
            exportSink: (plan) => host.exportSink(plan),
            cancelled: () => bounceCancelled[id],
            /**
             * PROGRESS RIDES ITS OWN MESSAGE, not `STATE`. `push()` coalesces on
             * a microtask and ships the whole snapshot, so a per-stop tick would
             * either be dropped by the coalescer or drag the full state dozens of
             * times a track.
             */
            onProgress: (p) => send({
              type: 'BOUNCE_PROGRESS', deck: id, stage: 'render',
              frame: p.frame, frames: p.frames, pct: +p.pct.toFixed(4),
              elapsedMs: Date.now() - t0,
            }),
          });
          log(`[${id}] bounced ${(r.frames / SR).toFixed(1)} s to ${r.files[0]} · `
            + `${(r.bytes / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
          return void send({ type: 'BOUNCE_DONE', deck: id, files: r.files, bytes: r.bytes, frames: r.frames });
        } catch (e) {
          return void bounceFailed(id, e && e.code, String((e && e.message) || e));
        } finally {
          bouncing[id] = false;
        }
      }

      case 'BOUNCE_CANCEL': {
        const id = normalizeDeckId(m.deck);
        bounceCancelled[id] = true;
        log(`[${id}] bounce cancel requested${bouncing[id] ? '' : ' — nothing is running'}`);
        return;
      }

      case 'TEARDOWN':
        return void await teardown();

    }
  } catch (e) {
    fail(m.type, e);
  }
}

/**
 * Review finding M5: nothing used to be torn down — the worker, the ORT session
 * (~1.7 GB of wasm heap), the AudioContext and one GainNode per capture all
 * lived until the offscreen document died.
 *
 * ponytail: teardown is manual (this handler + Deck.detach). The ceiling is that
 * a user who exports once and then leaves the panel open holds ~2 GB (4 GB with
 * two decks armed) until the browser closes, because there is deliberately no
 * idle reaper on the offscreen document (its reasons impose no lifetime —
 * probe/R0-RESULTS.md). The upgrade path is an idle timer in the service worker
 * that sends TEARDOWN after N minutes with no capture, no live deck and no job;
 * the pieces it would call are already here.
 */
async function teardown() {
  for (const d of liveDecks()) { detachTap(d); await d.dispose().catch(() => {}); }
  gpu.drain();
  master.dispose();
  deckB = null;
  decks.B = null;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  master.ctx = null;
  state.model.status = 'unknown';
  log('torn down');
  push(true);
}

/**
 * R5's third and last track-stop. The Host says WHEN this context is going away
 * — `pagehide` here, something else under another Host — and the engine says
 * WHAT cannot be left behind.
 *
 * Reaches into `Deck` internals rather than calling `d.dispose()` because
 * `dispose()` is async and teardown will not await it.
 */
host.onTeardown(() => {
  // Synchronous best effort — teardown will not await. The tracks are the part
  // that matters: a live track left running keeps the user's tab muted.
  for (const d of liveDecks()) {
    if (d.stream) d.stream.getTracks().forEach((t) => t.stop());
    /**
     * `Backend.dispose()` returns a promise nothing here can await, and the
     * interface says so: it must do its irreversible work SYNCHRONOUSLY, which
     * for `WorkerBackend` is `terminate()` and the ~1.7 GB wasm heap that goes
     * with it. `Promise.resolve` is only so a rejection cannot escape as an
     * unhandled one on the way out of the document.
     */
    if (d.backend) Promise.resolve(d.backend.dispose()).catch(() => {});
  }
});

// ponytail: this boot line names the Chrome offscreen document, in a file whose
// header says it is host-agnostic. It is a RUNTIME STRING, so S11's prose pass
// will not sweep it up, and a second Host would announce itself as a document it
// does not have. Left alone here on purpose: it sits inside the load-bearing
// boot-order triple below, and rewording it buys no gate. Upgrade path: S9 is
// already enumerating host-coupled residue — rename it there, or in S11.
log(`offscreen up · SAB ${SAB_OK} · crossOriginIsolated ${self.crossOriginIsolated}`);
decks.A.ensureBackend();
send({ type: 'HELLO' });
