/**
 * THE SEAM'S SERIALISATION — one call in flight per backend, and the UNIT is
 * what guarantees it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROTECTS, stated in three files before it was stated here
 * ---------------------------------------------------------------------------
 *
 * `workers/inference.worker.js:10-12`: "one session, one in-flight run().
 * ORT-Web serialises run() across all sessions on a wasm instance, and a
 * rejected concurrent call permanently wedges the session (FINDINGS §6/§11)."
 * Not slow — DEAD, for the life of the worker, with no error the user can act on
 * and no recovery short of a reload.
 *
 * Seed §16 made that the seam's own contract rather than one backend's private
 * rule: "the seam serialises calls; no caller can wedge a session." This module
 * is that sentence. It is deliberately NOT inside `WorkerBackend`, because the
 * property belongs to every backend a Host can hand over — including a native
 * one with its own reasons not to be re-entered — and because a guarantee the
 * unit makes is one a Host cannot forget to make.
 *
 * THREE LAYERS, AND THIS IS THE MIDDLE ONE. They are not redundant:
 *
 *   1. ONE BACKEND PER DECK (`offscreen/deck.js:18-25`) — one wasm instance per
 *      deck, so the cross-SESSION form of the trap cannot fire at all.
 *   2. THIS QUEUE — per backend, and the only layer that is a property of the
 *      seam rather than of a policy or of an implementation.
 *   3. `GpuScheduler` (`engine/scheduler.js`) — CROSS-DECK, and a scheduling
 *      policy rather than a safety rule: it decides who gets the one GPU next
 *      and who gives up its turn (L3). It happens to admit one inference at a
 *      time process-wide today, which is why the wedge has never fired; that is
 *      a consequence of the current policy, not a promise it makes. Change the
 *      policy — two GPUs, a priority pre-empt — and layer 3 stops serialising
 *      while layer 2 does not. Both, therefore, and not either.
 *
 * Underneath all three sits the worker's own `busy` guard
 * (`inference.worker.js:99`), which turns the wedge into a named throw. It is a
 * backstop, and S8's suite is what proves it unreachable through this queue.
 *
 * ---------------------------------------------------------------------------
 * WHY `load()` IS IN THE SAME QUEUE AS `separate()`
 * ---------------------------------------------------------------------------
 *
 * Because the gap the worker's own guard does not cover is exactly there.
 * `inference.worker.js:67-71` runs the warm-up inference OUTSIDE the `busy`
 * guard (`busy` is touched only by the INFER case) and `self.onmessage` is
 * `async` with no queueing behind an outstanding `await` — so an INFER arriving
 * during LOAD_MODEL's warm-up wedges the session. It is unreachable today only
 * because the DECK happens to await `ensureSession()` before it ever calls
 * `infer()`. That is an ordering the deck enforces, not one the worker does, and
 * "the caller happens to be careful" is precisely the guarantee a seam exists to
 * replace. A backend whose `load()` and `separate()` can overlap re-opens the
 * wedge that three files exist to close.
 *
 * `dispose()` IS NOT QUEUED, and that is the one deliberate hole. Teardown is
 * the moment you most need to stop a backend that is not answering; queueing it
 * behind a hung `separate()` would make the hang permanent and take the user's
 * tab audio with it (R5). It is also unconditional — `WorkerBackend.dispose()`
 * terminates the worker outright — so there is no ordering for a queue to
 * protect.
 */

import { assertHost, BACKEND_DUTIES } from '../shared/host.js';

/**
 * Wrap a `Backend` so at most one `load()`/`separate()` is ever in flight.
 *
 * FIFO, and that is asserted rather than assumed: `LivePipeline` submits chunk
 * `k` before chunk `k+1` and `LiveEmitter` refuses a non-contiguous chunk, so a
 * queue that reordered two calls would surface as an emitter error several
 * layers away from the reorder.
 *
 * A REJECTED CALL DOES NOT POISON THE QUEUE. The chain is advanced with
 * `p.then(noop, noop)` — the same shape `offscreen/engine.js`'s `modelChain`
 * uses — because one failed inference must not stop the next: the live path's
 * `CHUNK_FAILED` ladder is what decides when to stop, after three, and a queue
 * that latched would take that decision away from it.
 *
 * @param {import('../shared/host.js').Backend} backend  what the Host handed over
 * @param {string} what  the name to use in the refusal if it is short a duty
 * @returns {import('../shared/host.js').Backend}
 */
export function serialiseBackend(backend, what = 'Backend') {
  /**
   * CHECKED HERE, WHERE THE HOST'S ANSWER FIRST ARRIVES. `assertHost` at engine
   * boot checks that `createBackend` is callable; it cannot check what it
   * RETURNS. A Host that answers with the wrong shape — an object one level too
   * deep, a promise to a backend, a half-built stub — otherwise passes every
   * boot check and fails at the first arm, inside `gpu.run()`, as
   * `backend.separate is not a function`. That is the exact late failure the
   * seam's boot check exists to move earlier, one level in.
   */
  assertHost(backend, BACKEND_DUTIES, what);

  let chain = Promise.resolve();
  const queued = (fn) => {
    const p = chain.then(fn);
    chain = p.then(() => {}, () => {});
    return p;
  };

  return {
    load: (bytes, onProgress) => queued(() => backend.load(bytes, onProgress)),
    separate: (mix, out) => queued(() => backend.separate(mix, out)),
    dispose: () => backend.dispose(),
  };
}
