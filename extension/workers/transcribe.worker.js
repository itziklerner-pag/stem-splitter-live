/**
 * THE SECOND ORT SESSION — Basic Pitch's — and the reason it is a second WORKER.
 *
 * `workers/inference.worker.js` next door owns htdemucs. This file owns
 * `models/nmp.onnx` (Spotify Basic Pitch, icassp_2022) and it owns it from
 * inside a Worker of its own, which is what buys it a wasm instance of its own.
 * That is not tidiness. `offscreen/deck.js:18-25`:
 *
 *   "ORT-Web serialises `run()` across every session sharing a wasm instance,
 *    and a concurrent call throws `Session already started` and leaves the
 *    session permanently wedged — so two sessions inside one worker is a live
 *    grenade."
 *
 * PERMANENTLY, and it takes BOTH sessions with it: the deck stops separating,
 * the transcription stops, and there is nothing on screen that says why. Two
 * workers give two instances and make the collision structurally impossible
 * (spike/FINDINGS.md §6/§11, the owner's ruling R5). The cost is the second
 * instance's memory, and it is the price of the feature, not an oversight.
 *
 * There is a second, quieter reason the two cannot share a realm:
 * `ort.env.wasm.numThreads` is ONE number per realm, and these two sessions want
 * different ones — `min(4, cores/2)` for htdemucs (`inference.worker.js:49`) and
 * a flat 2 here (R5). One realm could not hold both answers even if the wedge
 * did not exist.
 *
 * `engine/notes.js` decodes the three heads INSIDE this file, so the raw
 * activations never cross a thread boundary — see THE DECODE below.
 *
 * ------------------------------------------------------------ WASM ONLY
 *
 * `executionProviders: ['wasm']`, from the `BASIC_PITCH` pin, and it is not a
 * missing optimisation. WebGPU CANNOT RUN THIS GRAPH. The exact failure, kept
 * here in full so the next reader does not spend an afternoon rediscovering it:
 *
 *   [WebGPU] Kernel "[Mul] model_1/cq_t2010v2_1/mul_1;model_1/cq_t2010v2_1/mul_1"
 *   failed. Error: Can't perform binary op on the given tensors
 *
 * The GPU therefore sees no new work at all from this feature, which is the
 * measurement R5 rests on: five pitched lanes at 2 threads is +0.091 RTF on the
 * WASM EP, against htdemucs at 0.4527 on the GPU.
 *
 * ------------------------------------------------- 2 THREADS, NOT 4
 *
 * `BASIC_PITCH.threads` is 2 (R5), and the reason is the neighbour: this session
 * runs BESIDE a WebGPU htdemucs session that is already using the machine, and
 * nothing waits on this one. Four threads here would buy a faster window that
 * nobody is waiting for by taking cores off the one thing that has a deadline.
 * READY reports the number ORT actually settled on rather than the number asked
 * for: ORT contains a `!crossOriginIsolated -> 1` branch, and a Host that serves
 * the unit without COOP/COEP gets one thread whatever this line says.
 *
 * -------------------------------------------- THE OUTPUT NAMES ARE A TRAP
 *
 * The session declares its outputs in the order `:2, :1, :0`, and the SEMANTIC
 * order is note, onset, contour. Every read below is BY NAME, out of the pin:
 *
 *   note    StatefulPartitionedCall:1   [1, 172,  88]
 *   onset   StatefulPartitionedCall:2   [1, 172,  88]
 *   contour StatefulPartitionedCall:0   [1, 172, 264]
 *
 * MEASURED, because the shape of the mistake matters more than the warning:
 * `session.outputNames` really is `[:2, :1, :0]`, so a reader who maps it
 * positionally onto [note, onset, contour] gets NOTE AND ONSET SWAPPED — the
 * contour lands in the contour slot by coincidence. That swap does not throw and
 * it does not even move the bins: both 88-bin heads peak at the same three
 * pitches. It shows up only in the decode, as notes that quietly go missing —
 * see THE CONTROL at the bottom of this header. `head()` below is what turns a
 * renamed or re-exported graph into a loud error at the first window instead of
 * a quiet transposition of the whole take.
 *
 * ------------------------------------------------------------ THE DECODE
 *
 * It happens HERE, not on the caller's thread. One window's three heads are
 * 172*88 + 172*88 + 172*264 = 75 680 floats = 302 KB, and five pitched lanes at
 * a 1.6401 s hop is 3.05 windows/s — 0.92 MB/s of structured-clone traffic the
 * wire never carries. What crosses instead is `engine/notes.js`'s note list —
 * a handful of small objects. `engine/notes.js` is pure and knows nothing about
 * ORT, workers or stems, which is what lets `node extension/engine/notes.js`
 * gate the decode without a browser anywhere near it.
 *
 * -------------------------------------------- THE WINDOW BUFFER PING-PONGS
 *
 * `RUN.window` is LENT, exactly the way `workerbackend.js` documents `mix`/`out`
 * for the deck's path: it is transferred in, wrapped in a VIEW rather than
 * copied, and transferred straight back on the answer. The caller allocates one
 * `Float32Array(BASIC_PITCH.window)` per lane at `start()` and re-adopts it from
 * every reply. This file MUST NOT copy it and MUST NOT keep it.
 *
 * That is also why the ERROR for a RUN carries the buffer back (the one field
 * this file adds to the frozen shape): a run that failed still holds the lane's
 * only buffer, and dropping it on the floor would turn one bad window into a
 * lane that reallocates 175 KB for ever. The caller may ignore the field; it
 * cannot get the buffer back if it is not there.
 *
 * ------------------------------------------------ NOTHING HAPPENS AT BOOT
 *
 * Module evaluation imports and declares. The session is created on INIT and
 * nowhere else, and the orchestrator sends INIT on the first `MIDI_START` — so
 * the first click is what pays for the session, and a user who never transcribes
 * never pays at all (the owner's ruling R5).
 *
 * AND THERE IS NO WARM-UP, unlike the sibling. `inference.worker.js` warms up
 * because its first inference is 843-2584 ms of shader compile in front of a
 * hop deadline. This worker has no deadline — R5: "Nothing waits on it. It may
 * fall arbitrarily behind and catch up" — so a slow first window is a
 * transcription that lags by one window, not a dropped chunk.
 *
 * ponytail: no warm-up, so the session's one-off set-up lands on the caller's
 * first window. Measured below: the first window has run 32.5-60.7 ms across
 * seven runs against a 30.2-36.6 ms steady median — at worst 2x, which is at
 * most 30 ms, against a 1640 ms hop. That is the ceiling, and it is why this is
 * a shortcut rather than a bug. Upgrade path: run one window of zeros inside
 * INIT before READY is posted, and run it THROUGH the same `busy` guard the RUN
 * case uses — `tools/seam-check.mjs`'s warm-up control exists because the
 * sibling's warm-up sits OUTSIDE its guard, and that gap must not be reproduced
 * here.
 *
 * -------------------------------------------------------- IT DEGRADES
 *
 * An inference failure is a reported error the caller can survive, never an
 * unhandled rejection: one `try` around the whole handler, one `ERROR` out, and
 * the take goes `bad` in the deck rather than the deck going down. The `catch`
 * DELIBERATELY DOES NOT CLEAR `busy` — see the note on it.
 *
 * ------------------------------------------------------------ THE PROTOCOL
 *
 *   INIT   { wasmDirUrl, modelUrl }  -> READY { threads, inputNames, outputNames }
 *   RUN    { id, lane, w, window }   -> NOTES { id, lane, w, notes, window,
 *                                               inferMs, decodeMs }
 *   BREAK  { lane }                  -> NOTES { lane, w: -1, notes }
 *   FLUSH  {}                        -> NOTES per lane, then FLUSHED {}
 *   DISPOSE{}                        -> the session is released
 *   ...and any of them -> ERROR { id, message, stack, window }, where `window` is
 *   the lent buffer if this failure still had it and `null` otherwise.
 *
 * `window` is an ArrayBuffer of BASIC_PITCH.window float32, mono, 22 050 Hz,
 * un-normalised, transferred both ways. `notes` are in LANE SAMPLES at
 * 22 050 Hz; turning those into source seconds is `offscreen/transcribe.js`'s
 * job and this file has no idea what a second of video is.
 *
 * IT FETCHES NOTHING AND RESOLVES NOTHING. `modelUrl` and `wasmDirUrl` arrive
 * from the Host's `assetUrl` through the orchestrator; there is no URL literal
 * in this file and no call to `fetch`. ORT reads `modelUrl` itself, and under
 * this Host that is an extension-origin asset, not a network path (P1/M1).
 *
 * ------------------------------------------------------ HOW IT WAS CHECKED
 *
 * There is no `node` suite for this file — it needs a browser, ORT's threaded
 * wasm and a cross-origin-isolated document, and `extension/unit.json` declares
 * no suite for it. It was driven in headless Chromium instead, over the shipped
 * `extension/vendor/ort/` and the committed `extension/models/nmp.onnx` served
 * under COOP/COEP so `crossOriginIsolated` is true. Stimulus: one window holding
 * a synthetic C-major triad — 261.63 / 329.63 / 392.00 Hz, silent for the first
 * 0.25 s so there is a real onset to find. Measured, and reproducible:
 *
 *   crossOriginIsolated  true, and READY.threads 2 — the pin's 2, not ORT's
 *                        one-thread fallback
 *   outputNames          [:2, :1, :0] — the declared order, exactly as pinned
 *   top three note bins  39, 43, 46 = MIDI 60, 64, 67 = C4 E4 G4
 *   the decoded notes    pitches 60, 64, 67, out of the worker itself
 *   a second INIT        refused, so this wasm instance never gets a second
 *                        session even if the orchestrator asks twice
 *   a burst of 8 RUNs    8 answers, 0 refusals, in the order they were posted
 *   a bad window, a RUN before INIT, an unknown message: each one ERROR, each
 *                        one naming what was wrong, the worker still answering
 *                        afterwards, and the lent buffer handed back
 *   session.run          seven runs of 12 windows, M2 Max, headless, deck idle:
 *                        the first window 32.5-60.7 ms (that spread tracks the
 *                        machine's own warm-up, not the session's), then a
 *                        median of 30.2-36.6 ms over the eleven after it
 *   ...as an RTF         a window is 1.9884 s of audio, so 0.0152-0.0184 per
 *                        lane and 0.076-0.092 across five pitched lanes, which
 *                        brackets the +0.091 R5 budgets for at these 2 threads
 *
 * THE CONTROL, because the output-name trap is the thing here most able to pass
 * while wrong. Both 88-bin heads peak at the SAME three bins — note 39/43/46 and
 * onset 39/43/46 — so a bin measurement cannot see a note/onset swap at all;
 * `outputNames[0]` is `:2`, the ONSET head, and a positional reader gets exactly
 * that swap. Decoding the same two tensors the positional way returns NO notes
 * against by-name's 60/64/67 (322 note cells over the frame threshold against
 * the onset head's 26). That is the control, and it loses.
 *
 * AND WHAT COULD NOT BE MADE TO FIRE, said out loud: the `busy` guard. On the
 * wasm EP `session.run()` blocks this worker's message loop — a RUN and an
 * unknown message posted in the same task answered NOTES first and the unknown
 * message second, though the second costs nanoseconds — so a second RUN cannot
 * be DISPATCHED while one is in flight and the guard is unreachable from the
 * message queue in this build. It is a BACKSTOP, in exactly the sense
 * `tools/seam-check.mjs` uses the word about the sibling's, and it stays: the
 * thing that makes it unreachable is a property of today's EP, not a promise.
 */

import * as ort from '../vendor/ort/ort.all.bundle.min.mjs';
import { BASIC_PITCH } from '../shared/config.js';
import { newDecoder, decodeWindow, breakDecoder, flushDecoder } from '../engine/notes.js';

/** The one session. Null before INIT and again after DISPOSE. */
let session = null;
/**
 * INIT is awaited, so `session` is null for the whole of it. Without this a
 * second INIT arriving during the first one creates a SECOND session on this
 * wasm instance — the exact thing the whole file exists to make impossible.
 */
let creating = false;
/** One `run()` in flight, ever. See the RUN case. */
let busy = false;

/**
 * lane -> `engine/notes.js` carry, created on first sight of the lane.
 *
 * The carry is what holds a note that is still sounding at the end of a window,
 * so it is per-lane and it OUTLIVES a window by construction. It is the only
 * state this file keeps between messages, and `notes.js` owns its shape.
 */
const carry = new Map();

const post = (m, transfer) => self.postMessage(m, transfer || []);

const decoderFor = (lane) => {
  let st = carry.get(lane);
  if (!st) { st = newDecoder(); carry.set(lane, st); }
  return st;
};

/**
 * One output head, BY NAME, with its geometry checked.
 *
 * IT THROWS WHEN IT CANNOT LOOK. A missing name is not "no notes this window",
 * it is a different graph — and the three names are pinned against a pinned
 * sha256, so the only way to get here is a re-export nobody re-pinned.
 *
 * THE DIMS ARE CHECKED TOO, and not for tidiness: `engine/notes.js` indexes
 * these as `frame * bins + bin` over exactly [1, 172, N], so a graph that came
 * back on any other shape would be READ as if it had this one — the failure this
 * file is most able to have and least able to notice.
 *
 * MEASURED, so nobody reads more into this guard than it says: creating the same
 * session with `freeDimensionOverrides` LEFT OUT still answered [1, 172, 88],
 * because the input tensor's own [1, 43844, 1] resolves the four `unk__74x`
 * symbols at run time. This guard is about the graph, not about that option.
 */
function head(res, name, bins) {
  const t = res[name];
  if (!t) {
    throw new Error(`the session returned no "${name}" — it returned [${Object.keys(res).join(', ')}]. `
      + `${BASIC_PITCH.label}'s tensor names are pinned in shared/config.js; a graph that declares `
      + 'other names is a different graph and the pin has to move first.');
  }
  const want = [1, BASIC_PITCH.frames, bins];
  if (String(t.dims) !== String(want)) {
    throw new Error(`"${name}" came back on dims [${t.dims}] and the pin says [${want}] — this graph has `
      + `been re-exported, or the window handed in was not ${BASIC_PITCH.window} samples. engine/notes.js `
      + 'indexes these as frame * bins + bin and cannot see the difference.');
  }
  return t.data;
}

/**
 * Create the one session. Called from INIT and from nowhere else.
 *
 * @param {string} wasmDirUrl a DIRECTORY url, trailing slash and all — ORT
 *        appends its own file names to it. R0 measured the file-URL form failing
 *        inside the runtime with "w is not a function", several layers from the
 *        mistake.
 * @param {string} modelUrl the Host's `assetUrl(BASIC_PITCH.asset)`.
 */
async function init(wasmDirUrl, modelUrl) {
  if (session || creating) {
    throw new Error('INIT while this worker already has a session — refusing (a second session on one '
      + 'wasm instance is the wedge this worker exists to make impossible)');
  }
  if (!wasmDirUrl || !modelUrl) {
    throw new Error(`INIT needs both URLs from the Host — got wasmDirUrl=${wasmDirUrl}, modelUrl=${modelUrl}. `
      + 'This file resolves no asset of its own; both come from EngineHost.assetUrl.');
  }
  creating = true;
  try {
    // All four must be set BEFORE the session is created. The first three are the
    // sibling's settings for the sibling's reasons — a directory URL, and no proxy
    // because ORT's proxy worker uses a `blob:` URL that our CSP blocks and we are
    // already off the main thread. The fourth is this session's own, from the pin.
    ort.env.wasm.wasmPaths = wasmDirUrl;
    ort.env.wasm.proxy = false;
    ort.env.wasm.numThreads = BASIC_PITCH.threads;
    ort.env.logLevel = 'warning';

    const s = await ort.InferenceSession.create(modelUrl, {
      // ['wasm'] ONLY — the kernel string at the top of this file is why.
      executionProviders: BASIC_PITCH.executionProviders,
      // 'basic', matching the sibling: 'all' is untested for this graph.
      graphOptimizationLevel: 'basic',
      // The four unk__74x symbols, resolved AT CREATION so ORT can plan shapes
      // before the first window rather than at it. Measured, because it is easy
      // to over-read: leaving them out still answered [1, 172, 88] here — the
      // input tensor resolves the symbols at run time either way. They stay
      // because they are part of the pin and because this is the configuration
      // the numbers in this file's header were taken on.
      freeDimensionOverrides: BASIC_PITCH.freeDimensionOverrides,
    });

    /**
     * THE PIN IS CHECKED AGAINST THE GRAPH, ONCE, HERE. Every read below is by
     * name, so a name that is not there would fail at the first window with a
     * message about a tensor rather than about the model. Fail at INIT instead:
     * the take has not started, the deck can say `MODEL_MISSING`-shaped things
     * before a single window is queued, and the session is given back rather
     * than left holding an instance nothing can use.
     */
    const missing = [
      [BASIC_PITCH.input, s.inputNames],
      [BASIC_PITCH.noteOut, s.outputNames],
      [BASIC_PITCH.onsetOut, s.outputNames],
      [BASIC_PITCH.contourOut, s.outputNames],
    ].filter(([name, have]) => !have.includes(name)).map(([name]) => name);
    if (missing.length) {
      await s.release().catch(() => {});
      throw new Error(`this model does not declare ${missing.join(', ')} — it declares inputs `
        + `[${s.inputNames.join(', ')}] and outputs [${s.outputNames.join(', ')}]. The names are pinned `
        + `against ${BASIC_PITCH.label} (sha256 ${BASIC_PITCH.sha256.slice(0, 12)}…); a different graph `
        + 'needs a different pin, not a different reader.');
    }
    session = s;
  } finally {
    creating = false;
  }

  // The number ORT SETTLED ON, not the number we asked for — see 2 THREADS above.
  post({
    type: 'READY',
    threads: ort.env.wasm.numThreads,
    inputNames: session.inputNames,
    outputNames: session.outputNames,
  });
}

/**
 * One window in, one window's closed notes out.
 *
 * Called ONLY from the RUN case, inside the `busy` guard. Everything it can
 * throw is caught by the one handler at the bottom of this file, which hands the
 * lent buffer back — so a bad window costs the caller a window and nothing else.
 */
async function runWindow(m) {
  if (!session) {
    throw new Error('RUN before there is a session — INIT has not completed. This worker creates nothing '
      + 'on its own and never will: the session is the first click\'s cost, not the boot\'s.');
  }
  const win = m.window;
  const need = BASIC_PITCH.window * 4;
  if (!(win instanceof ArrayBuffer) || win.byteLength !== need) {
    throw new Error(`RUN window is ${win instanceof ArrayBuffer ? `${win.byteLength} B` : String(win)} — `
      + `this graph takes exactly ${need} B, i.e. ${BASIC_PITCH.window} float32, MONO, ${BASIC_PITCH.sr} Hz, `
      + 'un-normalised. A short window is the caller\'s lane arithmetic being wrong, not something to pad.');
  }

  /**
   * A VIEW over the lent buffer, never a copy — 175 KB per window, five lanes,
   * every 1.64 s. ORT copies it into the wasm heap during `run()` and keeps
   * nothing afterwards, which is what makes it safe to transfer straight back.
   */
  const feeds = {
    [BASIC_PITCH.input]: new ort.Tensor('float32', new Float32Array(win), [1, BASIC_PITCH.window, 1]),
  };

  const t0 = performance.now();
  const res = await session.run(feeds);
  const inferMs = performance.now() - t0;

  const note = head(res, BASIC_PITCH.noteOut, BASIC_PITCH.bins);
  const onset = head(res, BASIC_PITCH.onsetOut, BASIC_PITCH.bins);
  const contour = head(res, BASIC_PITCH.contourOut, BASIC_PITCH.contourBins);

  const t1 = performance.now();
  const notes = decodeWindow(decoderFor(m.lane), note, onset, contour, m.w);
  const decodeMs = performance.now() - t1;

  /**
   * `inferMs`/`decodeMs` are here so R5's +0.091 RTF stays MEASURABLE in the
   * shipped build rather than only in the spike — the same reason the sibling's
   * RESULT carries prepMs/inferMs/postMs. They are counters, not a clock the
   * caller may wait on.
   */
  post({ type: 'NOTES', id: m.id, lane: m.lane, w: m.w, notes, window: win, inferMs, decodeMs }, [win]);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'INIT':
        return void await init(m.wasmDirUrl, m.modelUrl);

      case 'RUN': {
        /**
         * THE GUARD. One `run()` in flight, and a second one is REFUSED rather
         * than issued: issuing it is what wedges the session permanently, and a
         * refused window is a window this take does not have. The caller owns the
         * queue (`TRANSCRIBE_QUEUE_MAX`), so reaching this line is the caller
         * over-sending, and it must hear about it.
         *
         * Same shape as `inference.worker.js:99` — test, set, clear under
         * `finally`, and the clear is INSIDE this case rather than in the catch.
         *
         * IT IS A BACKSTOP AND IT COULD NOT BE MADE TO FIRE — see the last
         * section of this file's header for the measurement. Today's wasm `run()`
         * blocks the message loop, so nothing can be dispatched behind it. That
         * is a property of the EP, not a guarantee, and the failure it stands in
         * front of is permanent.
         */
        if (busy) throw new Error('RUN while a run is already in flight — refusing (would wedge the session)');
        busy = true;
        try {
          await runWindow(m);
        } finally { busy = false; }
        return;
      }

      /**
       * The lane's stream was cut — an uncovered span, or a window the caller
       * dropped. Close whatever is open at the last decoded frame and mark the
       * carry so the next window is a fresh start rather than a continuation. A
       * lane that has never been seen gets a fresh carry and answers `[]`, which
       * is the same sentence: there is nothing open.
       */
      case 'BREAK':
        return void post({
          type: 'NOTES', id: m.id ?? null, lane: m.lane, w: -1,
          notes: breakDecoder(decoderFor(m.lane)),
        });

      /**
       * The take is closing. Every lane hands back what it still holds, then one
       * FLUSHED so the caller knows the drain is complete and can send its own
       * last MIDI_NOTES before MIDI_FLUSHED.
       *
       * A FLUSH that arrives while a RUN is in flight is not refused, and does
       * not need to be: it touches only the per-lane carry, which the in-flight
       * RUN reads AFTER its `await` returns. That window's notes still come back
       * against an empty carry, so nothing is duplicated and nothing is lost —
       * and per the contract the caller drains the queue before it flushes
       * anyway.
       */
      case 'FLUSH': {
        for (const [lane, st] of carry) {
          post({ type: 'NOTES', id: m.id ?? null, lane, w: -1, notes: flushDecoder(st) });
        }
        post({ type: 'FLUSHED' });
        return;
      }

      /**
       * `release()` gives ORT's wasm heap back. It is worth sending and worth
       * awaiting HERE, unlike the sibling's — `workerbackend.js::dispose` dropped
       * its DISPOSE message because it posted and terminated in the same task, so
       * the handler had no task to run in. This worker's caller terminates on
       * `MIDI_STOP`, one message later, and `terminate()` is what actually frees
       * the instance either way; this is the graceful half.
       */
      case 'DISPOSE': {
        const s = session;
        session = null;
        carry.clear();
        if (s) await s.release().catch(() => {});
        return;
      }

      default:
        throw new Error(`unknown message "${m && m.type}" — this worker speaks INIT, RUN, BREAK, FLUSH `
          + 'and DISPOSE, and a message it does not know is a caller talking to the wrong worker');
    }
  } catch (err) {
    /**
     * Deliberately does NOT clear `busy`, for exactly the reason
     * `inference.worker.js:120-127` gives: the only writer is the RUN case, which
     * owns it under try/finally, and clearing it here would release the guard on
     * behalf of a run that is still in flight — which is how you get two
     * concurrent `session.run()` calls and a permanently wedged session.
     *
     * The lent window goes back if this failure still has it. A transferred
     * buffer reads 0 bytes here, so `byteLength` is the test for "did the reply
     * that would have returned it already go out" — see THE WINDOW BUFFER
     * PING-PONGS.
     */
    const win = m && m.window instanceof ArrayBuffer && m.window.byteLength > 0 ? m.window : null;
    post({
      type: 'ERROR',
      id: m && m.id,
      message: String((err && err.message) || err),
      stack: err && err.stack,
      window: win,
    }, win ? [win] : []);
  }
};
