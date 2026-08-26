/**
 * THE SEAM CONTRACT — one backend call in flight, and no caller can wedge a
 * session.
 *
 *     node tools/seam-check.mjs
 *     node tools/verify.mjs --only seam
 *
 * `workers/inference.worker.js:10-12`: *"one session, one in-flight run().
 * ORT-Web serialises run() across all sessions on a wasm instance, and a
 * rejected concurrent call permanently wedges the session (FINDINGS §6/§11)."*
 * Not slow — DEAD, for the life of the worker, with no error the user can act on
 * and no recovery short of a reload. Seed §16 made that the SEAM'S contract
 * rather than one backend's private rule — *"the seam serialises calls; no
 * caller can wedge a session"* — and `shared/host.js::serialiseBackend` is that
 * sentence.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE `test.js`'s `backend` GROUP RATHER THAN INSIDE IT
 * ---------------------------------------------------------------------------
 *
 * The `backend` group drives the same wrapper over a fake BACKEND: an object
 * that counts how many `separate()` calls are inside it at once. That answers
 * "does the queue queue", and it is the right instrument for that question.
 *
 * It cannot answer the question this file exists for, because a fake backend has
 * no opinion about being re-entered. The real one does, and its opinion is the
 * whole subject: `inference.worker.js:99` REFUSES a second `INFER`, and the
 * refusal is what leaves the session unusable. So this file fakes the WORKER
 * PORT instead — the `postMessage`/`onmessage` pair `WorkerBackend` talks to —
 * and gives it the shipped worker's own guard, its own `busy` flag, and the
 * permanence that makes the guard a last resort rather than a retry. What is
 * driven above it is the SHIPPED stack, unmodified:
 *
 *     serialiseBackend( new WorkerBackend({ assetUrl, name: 'deck A' }) )
 *     └ extension/shared/host.js  └ extension/workers/workerbackend.js
 *
 * Nothing here reimplements the queue or the protocol. Delete the queue and this
 * suite goes red; rename the worker's five message types and it goes red.
 *
 * ---------------------------------------------------------------------------
 * THE THREE LAYERS, AND WHICH ONE THIS GATE IS ABOUT
 * ---------------------------------------------------------------------------
 *
 *   1. ONE BACKEND PER DECK (`offscreen/deck.js:18-25`) — one wasm instance per
 *      deck, so the cross-SESSION form of the trap cannot fire at all.
 *   2. THIS QUEUE — per backend, and the only layer that is a property of the
 *      SEAM rather than of a policy or of an implementation.
 *   3. `GpuScheduler` (`engine/scheduler.js`) — CROSS-DECK, and a scheduling
 *      POLICY rather than a safety rule. It happens to admit one inference at a
 *      time process-wide today, which is why the wedge has never fired; that is
 *      a consequence of the current policy, not a promise it makes.
 *
 * Underneath all three sits the worker's own `busy` guard. It is a BACKSTOP, and
 * this file is what proves it unreachable through the queue: every assertion
 * about the wrapped stack below reads `guard trips 0`, and the CONTROLS show
 * what the same traffic does to the same port with the queue taken out.
 *
 * ---------------------------------------------------------------------------
 * NOT ONE ASSERTION HERE READS A CLOCK
 * ---------------------------------------------------------------------------
 *
 * Every claim is a count: how many `INFER`s were on the wire at once, how many
 * the guard refused, how many results came back, in which order the session ran
 * them, how many calls settled. The fake port's "work" is a fixed number of
 * MICROTASK TURNS, not a timer — so every number below is the same on a loaded
 * machine as on an idle one, and `AGENTS.md`'s "a gate whose verdict changes on
 * code that did not change is measuring the machine" cannot reach it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROLS, AND WHY THEY COME FIRST
 * ---------------------------------------------------------------------------
 *
 * A queue asserted over a port that does not really guard is a suite that cannot
 * fail. So the first two assertions check the FAKE against the SHIPPED WORKER —
 * its refusal is that file's own sentence, read out of it, and its `busy` flag
 * still covers what that file's `busy` covers — and the next three drive traffic
 * STRAIGHT AT the backend with the wrapper taken out, where the guard is
 * expected to fire. If those controls ever stop firing, everything after them is
 * measuring nothing, and they say so rather than passing quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { serialiseBackend } from '../extension/shared/host.js';
import { WorkerBackend } from '../extension/workers/workerbackend.js';

const ROOT = path.join(import.meta.dirname, '..');
const WORKER_SRC = path.join(ROOT, 'extension/workers/inference.worker.js');

/**
 * The shipped worker's refusal, verbatim. DUPLICATED ON PURPOSE rather than read
 * out of the file and reused: a fake that derives its guard from the thing it is
 * standing in for agrees with it by construction and can never disagree, which
 * is the vacuous-control shape `AGENTS.md` prices at a full investigation. It is
 * written here, and the FIRST assertion below is that the two still match.
 */
const GUARD = 'INFER while a run is already in flight — refusing (would wedge the session)';

/**
 * What the port answers with once the guard has fired. There is no such sentence
 * in `inference.worker.js` because the real session does not produce one — it
 * stops answering — so this is the fake making the consequence OBSERVABLE, and
 * it is deliberately worded as this file's own claim rather than as the
 * worker's.
 */
const WEDGED = 'the session was wedged by an earlier concurrent INFER and will not run again';

let checks = 0, fails = 0;
const ok = (cond, name, detail) => {
  checks++;
  if (!cond) { fails++; console.error(`FAIL ${name}  ${detail}`); } else console.log(`ok   ${name}  ${detail}`);
};

/** Comments out. Same one-liner `test.js`, `name-check` and `unit-check` use. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * ...AND STRING LITERALS OUT TOO, for the `busy` COUNT below and for nothing
 * else. Counting occurrences of an identifier in source that still carries its
 * own error messages counts the word in the sentence as a use of the flag:
 * rewording the guard to "INFER while busy" moved the count without moving a
 * single site, which is a red that names the wrong thing. Watched happening —
 * see the mutation list in `verify.mjs` beside the step.
 */
const stripStrings = (s) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

/**
 * Let the microtask queue run. THE ONLY WAITING PRIMITIVE IN THIS FILE, and it
 * is a COUNT of turns rather than a duration — see the no-clock note above.
 */
const turns = async (n) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

/**
 * Spin until `done()`, up to `limit` turns. Returns whether it happened, so the
 * caller can FAIL when it did not rather than assert against a state that never
 * arrived (`AGENTS.md`: an assertion must fail when it cannot look).
 */
const until = async (done, limit = 4000) => {
  for (let i = 0; i < limit && !done(); i++) await Promise.resolve();
  return done();
};

/* ========================================================================== */
/* The fake worker port                                                       */
/* ========================================================================== */

/**
 * A stand-in for `workers/inference.worker.js` — the port AND the session behind
 * it — built to mirror the three facts that make the seam's queue load-bearing:
 *
 *   1. `busy` GUARDS `INFER` AND NOTHING ELSE. A second `INFER` while one is in
 *      flight is refused in the shipped worker's own words.
 *   2. THE REFUSAL IS TERMINAL. The real session is not slow after a rejected
 *      concurrent `run()`, it is unusable; `wedged` latches so the consequence
 *      is something a count can see.
 *   3. `LOAD_MODEL`'s WARM-UP RUNS OUTSIDE THE GUARD. `inference.worker.js:67-71`
 *      runs `await engine.runSegment(z, z)` in the `LOAD_MODEL` case, which never
 *      touches `busy`, and `self.onmessage` is `async` with no queueing behind an
 *      outstanding `await`. An `INFER` arriving during the warm-up therefore
 *      reaches the session with the guard wide open. That is the gap the queue
 *      exists to close, and it is why `load()` and `separate()` share ONE queue.
 *
 * Everything it records is a COUNT.
 */
class FakePort {
  constructor({ runTurns, warmupTurns, refuse, sink }) {
    this.onmessage = null;
    this.onerror = null;
    this.runTurns = runTurns;
    this.warmupTurns = warmupTurns;
    this.refuse = refuse;

    /** Every message the backend posted, with its transfer list beside it. */
    this.posts = [];
    /** `terminate()` calls. The physical half of "nothing will answer it". */
    this.terminated = 0;

    // ---- the session's own state, mirroring the worker's module scope
    this.busy = false;
    this.wedged = false;
    this.warmingUp = false;

    // ---- the counts every assertion in this file is carried by
    /** `INFER` posted and not yet answered — the in-flight count. */
    this.onWire = 0;
    this.maxOnWire = 0;
    /** How many `INFER`s the `busy` guard refused. Through the queue: 0. */
    this.guardTrips = 0;
    /** How many `INFER`s reached the session while the warm-up was running. */
    this.inferDuringWarmup = 0;
    /** The ids the session actually ran, in the order it ran them. */
    this.ran = [];

    sink.push(this);
  }

  /** The worker's `postMessage` back to the backend. */
  emit(m) {
    if (m.type === 'RESULT' || (m.type === 'ERROR' && m.id != null)) this.onWire--;
    if (this.onmessage) this.onmessage({ data: m });
  }

  postMessage(m, transfer) {
    this.posts.push({ m, transfer: transfer || [] });
    if (m && m.type === 'INFER') {
      this.onWire++;
      if (this.onWire > this.maxOnWire) this.maxOnWire = this.onWire;
    }
    /**
     * DELIVERED A TURN LATER, because a real port's is. Answering inside
     * `postMessage` would make the fake synchronous, and a synchronous port
     * cannot have two calls on it at once — which would hand this suite the
     * property it is here to measure.
     */
    queueMicrotask(() => this.handle(m));
  }

  /** `inference.worker.js`'s `self.onmessage`, one fake deep. */
  async handle(m) {
    try {
      switch (m.type) {
        case 'INIT':
          this.emit({ type: 'READY', numThreads: 4, adapter: null });
          return;

        case 'LOAD_MODEL': {
          // The warm-up. OUTSIDE the guard, exactly as the shipped worker's is.
          this.warmingUp = true;
          this.emit({ type: 'MODEL_PROGRESS', phase: 'warmup' });
          await turns(this.warmupTurns);
          this.warmingUp = false;
          this.emit({ type: 'MODEL_READY', ep: 'fake', createMs: 0, warmupMs: 0 });
          return;
        }

        case 'INFER': {
          /**
           * The guard, and the ORDER is the shipped worker's: the throw happens
           * BEFORE `busy = true`, so it leaves the flag held by the run that is
           * still going. `inference.worker.js:120-127` makes the same point from
           * the other side — its catch "deliberately does NOT clear `busy`".
           */
          if (this.busy) { this.guardTrips++; this.wedged = true; throw new Error(GUARD); }
          if (this.wedged) throw new Error(WEDGED);
          this.busy = true;
          if (this.warmingUp) this.inferDuringWarmup++;
          this.ran.push(m.id);
          try {
            await turns(this.runTurns);
            if (this.refuse.has(m.id)) throw new Error(`the fake session refused segment ${m.id}`);
            this.emit({
              type: 'RESULT', id: m.id, mix: m.mix, stems: m.out, prepMs: 0, inferMs: 0, postMs: 0,
            });
          } finally { this.busy = false; }
          return;
        }

        default:
      }
    } catch (err) {
      this.emit({ type: 'ERROR', id: m && m.id, message: String((err && err.message) || err) });
    }
  }

  terminate() { this.terminated++; }
}

/**
 * Stand a `WorkerBackend` up over a fake port.
 *
 * `Worker` and `fetch` are the only two things a browser would have supplied to
 * this file: `spawn()` constructs the first and `probeRuntime()` calls the
 * second. Both are restored before the next block, so one block's stub cannot
 * survive into another and answer for it.
 */
function standUp({ runTurns = 3, warmupTurns = 64, refuse = new Set(), name = 'deck A' } = {}) {
  const ports = [];
  const realWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  globalThis.Worker = class {
    constructor() { return new FakePort({ runTurns, warmupTurns, refuse, sink: ports }); }
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => ({ ok: true }), configurable: true, writable: true,
  });
  let backend;
  try {
    backend = new WorkerBackend({ assetUrl: (rel) => `stub://unit/${rel}`, name });
  } finally {
    if (realWorker) Object.defineProperty(globalThis, 'Worker', realWorker); else delete globalThis.Worker;
    if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch); else delete globalThis.fetch;
  }
  return { ports, backend, port: ports[0] };
}

/**
 * Fire `n` calls at `b.separate()` IN ONE TURN and record how each settled,
 * without ever awaiting one.
 *
 * NOT AWAITED, and that is the difference between a red and a hang. Every
 * mutation this file is aimed at — a dropped queue, a chain that latches on a
 * rejection, a `dispose()` that clears the pending map without settling it —
 * leaves at least one of these promises unsettled for ever. `await` on that is a
 * suite `verify.mjs` kills with no assertion name attached to it, which is the
 * same defect wearing a worse costume. Counting after a bounded number of
 * microtask turns turns each of them into one named FAIL instead.
 *
 * Each call carries a DIFFERENT buffer size, so "which call got which answer" is
 * identifiable without an index the wrapper could have preserved by accident.
 */
function fire(b, n) {
  const mixes = Array.from({ length: n }, (_, i) => new ArrayBuffer(8 + i));
  const outs = Array.from({ length: n }, (_, i) => new ArrayBuffer(64 + i));
  const settled = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    b.separate(mixes[i], outs[i]).then(
      (r) => { settled[i] = { ok: true, r }; },
      (e) => { settled[i] = { ok: false, why: String((e && e.message) || e) }; },
    );
  }
  return { mixes, outs, settled };
}

const done = (settled) => settled.filter(Boolean).length;
const resolved = (settled) => settled.filter((s) => s && s.ok).length;
const rejections = (settled) => settled.filter((s) => s && !s.ok).map((s) => s.why);

/* ========================================================================== */
/* 1. The fake is the shipped guard                                           */
/* ========================================================================== */
{
  const src = strip(fs.readFileSync(WORKER_SRC, 'utf8'));

  const m = src.match(/if \(busy\) throw new Error\('([^']*)'\)/);
  ok(m != null && m[1] === GUARD,
    'THE FAKE PORT REFUSES IN THE SHIPPED WORKER’S OWN WORDS  '
    + '[entry point: extension/workers/inference.worker.js, the INFER case, comments stripped]',
    m == null
      ? 'cannot look: no `if (busy) throw new Error(\'…\')` in inference.worker.js — the guard this whole file '
        + 'stands in for has moved or changed shape, so every count below is about a fake with no original'
      : m[1] === GUARD
        ? `verbatim, ${GUARD.length} chars`
        : `the worker now refuses with "${m[1]}" and this file's fake still says "${GUARD}" — the fake has `
          + 'drifted off the thing it models');

  /**
   * ...AND THE GUARD STILL COVERS ONLY `INFER`. This is the premise of the
   * shared queue, not a detail of it: if `busy` were also held across
   * `LOAD_MODEL`'s warm-up, an `INFER` during the warm-up could not reach the
   * session and `load()` would not need to be in the same queue as `separate()`.
   * It is, so it does. Counted rather than eyeballed: four `busy` sites in the
   * file, three of them inside the `INFER` case (the test, the set, the clear)
   * and exactly one outside it (the declaration at module scope).
   */
  const from = src.indexOf("case 'INFER'");
  const to = src.indexOf("case 'DISPOSE'", from + 1);
  const inCase = from < 0 || to < 0 ? [] : stripStrings(src.slice(from, to)).match(/\bbusy\b/g) || [];
  const total = stripStrings(src).match(/\bbusy\b/g) || [];
  const outside = total.length - inCase.length;
  ok(from >= 0 && to > from && inCase.length === 3 && outside === 1,
    '...AND THE SHIPPED GUARD STILL COVERS ONLY INFER, so LOAD_MODEL’s warm-up is outside it and the queue has to span both methods  '
    + '[entry point: extension/workers/inference.worker.js self.onmessage, comments stripped]',
    from < 0 || to < 0
      ? 'cannot look: the INFER and DISPOSE cases are no longer both in this switch, so nothing was counted'
      : inCase.length === 3 && outside === 1
        ? `3 busy sites inside the INFER case (test, set, clear), 1 outside it (the declaration)`
        : `${inCase.length} busy sites inside the INFER case and ${outside} outside — if the warm-up now holds the `
          + 'guard, this file’s warm-up control is asserting a gap the worker no longer has; if the INFER case has '
          + 'lost one, the backstop is weaker than the queue assumes');
}

/* ========================================================================== */
/* 2. CONTROLS — the same traffic with the wrapper taken out                  */
/* ========================================================================== */

/**
 * SIXTEEN CONCURRENT `separate()` STRAIGHT AT THE BACKEND.
 *
 * This is what `Deck.ensureBackend()` would hand the live path if it held the
 * Host's backend unwrapped, and it is the only block in this file that does. The
 * guard is expected to FIRE here: fifteen refusals in the worker's own words,
 * one survivor, and a session that never runs again.
 *
 * IT HAS TO BE ABLE TO LOSE. If this control ever reads `0 guard trips`, the
 * fake port is not guarding anything and every `guard trips 0` below is a
 * statement about nothing.
 */
{
  const { backend, port } = standUp();
  const N = 16;
  const { settled } = fire(backend, N);
  await until(() => done(settled) === N);

  const refusals = rejections(settled).filter((w) => w === GUARD);
  ok(port.guardTrips === N - 1 && refusals.length === N - 1 && resolved(settled) === 1 && port.maxOnWire === N,
    'CONTROL — 16 CONCURRENT separate() STRAIGHT AT THE BACKEND TRIP THE GUARD  '
    + '[entry point: extension/workers/workerbackend.js separate(), with serialiseBackend() deliberately not in the way]',
    port.guardTrips === 0
      ? 'the fake port refused NOTHING under 16 concurrent calls — it is not modelling the shipped guard at all, '
        + 'so every "guard trips 0" in this file is a statement about a port that would have said yes anyway'
      : `${port.maxOnWire} INFERs on the wire at once, ${port.guardTrips} refused by the guard, `
        + `${resolved(settled)} result, ${refusals.length} refusals in the worker’s own words`);

  // ...and it is not a retry. A well-behaved call, alone, on the same session.
  const after = [];
  backend.separate(new ArrayBuffer(8), new ArrayBuffer(64)).then(
    () => after.push('(it RESOLVED)'), (e) => after.push(String(e.message || e)),
  );
  await until(() => after.length === 1);
  ok(after.length === 1 && after[0] === WEDGED,
    '...AND THE SESSION IS DEAD AFTERWARDS, NOT SLOW — one concurrent call costs the worker, not the chunk  '
    + '[entry point: extension/workers/workerbackend.js separate(), the same port after the burst above]',
    after.length === 0
      ? 'the next call neither resolved nor rejected, so the permanence of the wedge was not measured at all'
      : after[0] === WEDGED
        ? 'a single well-behaved call on the same session is still refused'
        : `the session answered "${after[0]}" — this fake forgives a concurrent INFER, and the real one does not`);

  await backend.dispose();
}

/**
 * AN `INFER` DURING `LOAD_MODEL`'s WARM-UP — the gap `busy` does not cover.
 *
 * `inference.worker.js:67-71` runs the warm-up inference in the `LOAD_MODEL`
 * case, which never touches `busy`, and `self.onmessage` is `async` with no
 * queueing behind an outstanding `await`. So this control expects the opposite
 * outcome to the one above: the guard does NOT fire, and the segment runs
 * straight into a session that is already running one.
 *
 * It is unreachable in the product today only because `Deck.ensureSession()` is
 * awaited before `infer()` is ever called — an ordering the DECK enforces and the
 * worker does not, which is exactly the guarantee a seam exists to replace.
 */
{
  const { backend, port } = standUp();
  const load = [];
  backend.load(new ArrayBuffer(4)).then(() => load.push('ok'), (e) => load.push(String(e.message || e)));
  const posted = await until(() => port.posts.some((p) => p.m && p.m.type === 'LOAD_MODEL'));
  const inWarmup = posted && await until(() => port.warmingUp);
  const seg = [];
  if (inWarmup) {
    backend.separate(new ArrayBuffer(8), new ArrayBuffer(64)).then(
      () => seg.push('ok'), (e) => seg.push(String(e.message || e)),
    );
  }
  await until(() => load.length === 1 && seg.length === 1);

  ok(inWarmup && port.inferDuringWarmup === 1 && port.guardTrips === 0,
    'CONTROL — AN INFER DURING LOAD_MODEL’S WARM-UP REACHES THE SESSION AND THE busy GUARD NEVER SEES IT  '
    + '[entry point: extension/workers/workerbackend.js separate(), posted while load() is open and serialiseBackend() not in the way]',
    !inWarmup
      ? 'the fake never entered its warm-up window, so no INFER could have been aimed at one and this control '
        + 'inspected nothing'
      : port.inferDuringWarmup === 1 && port.guardTrips === 0
        ? '1 segment ran inside the warm-up window, 0 guard trips — the gap is real and open'
        : `${port.inferDuringWarmup} segments reached the warm-up and the guard refused ${port.guardTrips} — if the `
          + 'guard fired here, this fake now holds `busy` across the warm-up and the shared-queue assertion below '
          + 'is asserting a gap it has closed for itself');

  await backend.dispose();
}

/* ========================================================================== */
/* 3. The queue                                                               */
/* ========================================================================== */

/**
 * THE SAME SIXTEEN CALLS, THROUGH THE SHIPPED WRAPPER.
 *
 * `offscreen/deck.js::ensureBackend()` is the one caller of `serialiseBackend`
 * in the tree, and `test.js`'s `backend` group reads that call site out of the
 * build. This is what it buys: the same burst that killed the session above
 * leaves the backstop untouched.
 */
{
  const { backend, port } = standUp();
  const b = serialiseBackend(backend, 'Backend for deck A');
  const N = 16;
  const { mixes, outs, settled } = fire(b, N);
  await until(() => done(settled) === N);

  ok(port.maxOnWire === 1 && port.guardTrips === 0,
    'AT MOST ONE CALL IS ON THE WIRE, ACROSS 16 CONCURRENT separate() — and the worker’s own guard is never reached  '
    + '[entry point: extension/shared/host.js serialiseBackend(), reached from deck.js Deck.ensureBackend()]',
    port.maxOnWire === 1 && port.guardTrips === 0
      ? '16 calls, max 1 INFER on the wire, 0 guard trips — the backstop is unreachable through the queue'
      : `${port.maxOnWire} INFERs were on the wire at once and the guard refused ${port.guardTrips} of them; with a `
        + 'real ORT session that is a permanently wedged worker, not a slow one');

  const order = port.ran.join(',');
  const expected = Array.from({ length: N }, (_, i) => i + 1).join(',');
  const own = settled.every((s, i) => s && s.ok && s.r.mix === mixes[i] && s.r.stems === outs[i]);
  ok(resolved(settled) === N && order === expected && own,
    '...AND ALL 16 RESOLVE, IN CALL ORDER, each with the buffers ITS OWN call lent  '
    + '[entry point: extension/shared/host.js serialiseBackend()]',
    resolved(settled) !== N
      ? `${resolved(settled)} of 16 resolved; the rest: ${rejections(settled).slice(0, 3).join(' | ') || '(still unsettled)'}`
      : order !== expected
        ? `the session ran them ${order} — LivePipeline submits chunk k before k+1 and LiveEmitter refuses a `
          + 'non-contiguous chunk, so a reorder here surfaces as an emitter error several layers away'
        : own
          ? `16 results, session order ${order}`
          : 'a caller was handed another call’s buffers — the queue crossed two segments over');

  await b.dispose();
}

/**
 * `load()` AND `separate()` SHARE ONE QUEUE, which is the half of the contract
 * the worker's own guard cannot cover — see the warm-up control above.
 */
{
  const { backend, port } = standUp();
  const b = serialiseBackend(backend, 'Backend for deck A');
  const both = [];
  b.load(new ArrayBuffer(4)).then(() => both.push('load'), (e) => both.push(`load failed: ${e.message}`));
  b.separate(new ArrayBuffer(8), new ArrayBuffer(64)).then(
    () => both.push('separate'), (e) => both.push(`separate failed: ${e.message}`),
  );
  await until(() => both.length === 2);

  const wire = port.posts.map((p) => p.m && p.m.type).filter((t) => t === 'LOAD_MODEL' || t === 'INFER').join(',');
  ok(port.inferDuringWarmup === 0 && port.guardTrips === 0 && both.join(',') === 'load,separate' && wire === 'LOAD_MODEL,INFER',
    'load() AND separate() SHARE ONE QUEUE — no INFER reaches the session while the model is warming up  '
    + '[entry point: extension/shared/host.js serialiseBackend(), reached from deck.js Deck.ensureSession() and Deck.infer()]',
    port.inferDuringWarmup !== 0
      ? `${port.inferDuringWarmup} segment(s) reached the session during the warm-up — the one overlap the worker’s `
        + '`busy` guard cannot see, and the reason this queue spans two methods rather than one'
      : both.join(',') !== 'load,separate'
        ? `they settled ${both.join(',') || '(neither settled)'}`
        : `wire ${wire}, 0 segments in the warm-up window, 0 guard trips`);

  await b.dispose();
}

/* ========================================================================== */
/* 4. The wedge rule — a rejected call does not take the queue with it        */
/* ========================================================================== */

/**
 * ONE SEGMENT THE SESSION REFUSES, IN THE MIDDLE OF SIXTEEN.
 *
 * The chain is advanced with `p.then(noop, noop)` — the same shape
 * `offscreen/engine.js`'s `modelChain` uses — because one failed inference must
 * not stop the next: the live path's `CHUNK_FAILED` ladder is what decides when
 * to stop, after three, and a queue that latched would take that decision away
 * from it and turn one bad segment into a dead deck.
 *
 * The refusal is a `{type:'ERROR', id}` from the port, which is the shape the
 * real worker's catch posts — so the rejection has to come back to the ONE call
 * it belongs to and to no other.
 */
{
  const BAD = 8;
  const { backend, port } = standUp({ refuse: new Set([BAD]) });
  const b = serialiseBackend(backend, 'Backend for deck A');
  const N = 16;
  const { settled } = fire(b, N);
  await until(() => done(settled) === N);

  const why = settled[BAD - 1] && !settled[BAD - 1].ok ? settled[BAD - 1].why : null;
  const others = settled.filter((s, i) => i !== BAD - 1);
  ok(resolved(settled) === N - 1 && why != null && why.includes(`segment ${BAD}`)
    && others.every((s) => s && s.ok) && port.ran.length === N && port.guardTrips === 0 && port.maxOnWire === 1,
    'ONE REJECTED CALL DOES NOT WEDGE THE QUEUE — 15 results and 1 rejection that names its own segment  '
    + '[entry point: extension/shared/host.js serialiseBackend(), reached from live.js LivePipeline.runChunk via Deck.infer()]',
    done(settled) !== N
      ? `${done(settled)} of 16 calls ever settled — the chain latched on the rejection, so every segment after the `
        + 'bad one waits for ever and the CHUNK_FAILED ladder never gets to decide anything'
      : why == null
        ? `segment ${BAD} was REFUSED by the session and the caller was told it succeeded`
        : !why.includes(`segment ${BAD}`)
          ? `the rejection does not name its segment: "${why}"`
          : resolved(settled) !== N - 1
            ? `${resolved(settled)} of the other 15 resolved — the rejection reached calls it does not belong to`
            : `15 results, 1 rejection ("${why}"), all ${port.ran.length} segments reached the session, 0 guard trips`);

  await b.dispose();
}

/* ========================================================================== */
/* 5. dispose() settles what it takes away                                    */
/* ========================================================================== */

/**
 * THE BEHAVIOUR CHANGE THIS SLICE OWNS, and it is a change rather than a port:
 * `offscreen/deck.js` cleared the pending map without rejecting it, and
 * `WorkerBackend.dispose()` inherited that. Every call in flight at teardown was
 * therefore left unsettled for ever — `await separate(...)` with no timeout
 * anywhere and no cancel path, which is Review finding M1 arriving through the
 * one door `die()` does not cover.
 *
 * `dispose()` IS NOT QUEUED — teardown is exactly when a backend that has stopped
 * answering must still be stoppable — so it can land on three different
 * populations at once, and all three are asserted here: the call ON THE WIRE, an
 * open `load()`, and the calls still WAITING IN THE QUEUE behind them.
 *
 * BY NAME, in every case. Two decks each own a backend; "the inference worker is
 * gone" names neither of them, and the deck's own log line is `ERROR [deck A
 * backend] …`.
 */
{
  const { backend, port } = standUp();
  const b = serialiseBackend(backend, 'Backend for deck A');
  const N = 4;
  const { settled } = fire(b, N);
  const onWire = await until(() => port.posts.some((p) => p.m && p.m.type === 'INFER'));

  // NOT awaited before the drain, for the reason `fire()` gives: the mutation
  // this block exists to catch leaves these promises pending for ever.
  const disposing = b.dispose();
  await turns(200);

  const inFlight = settled[0];
  ok(onWire && inFlight != null && !inFlight.ok && inFlight.why.includes('deck A'),
    'dispose() REJECTS THE CALL ON THE WIRE, AND NAMES THE BACKEND  '
    + '[entry point: extension/workers/workerbackend.js dispose(), reached from deck.js Deck.dispose() and engine.js onTeardown]',
    !onWire
      ? 'no INFER ever reached the port, so nothing was in flight when dispose() ran and this inspected nothing'
      : inFlight == null
        ? 'the in-flight separate() is STILL PENDING after dispose() — the worker is terminated, so nothing will '
          + 'ever answer it, and LivePipeline.runChunk awaits it for the life of the document'
        : inFlight.ok
          ? 'the in-flight call RESOLVED after its worker was terminated'
          : inFlight.why.includes('deck A')
            ? inFlight.why
            : `it rejected without naming the backend: "${inFlight.why}" — two decks own one each`);

  const queued = settled.slice(1);
  const infers = port.posts.filter((p) => p.m && p.m.type === 'INFER').length;
  ok(queued.length === N - 1 && queued.every((s) => s && !s.ok && s.why.includes('deck A') && /dispos/i.test(s.why))
    && infers === 1 && port.terminated === 1,
    '...AND THE CALLS STILL WAITING IN THE QUEUE, saying it was disposed rather than “reported no reason”  '
    + '[entry point: extension/workers/workerbackend.js require(), reached from separate() after dispose()]',
    queued.some((s) => s == null)
      ? `${queued.filter(Boolean).length} of ${N - 1} queued calls settled — the rest are behind a call that never will`
      : queued.some((s) => s.ok)
        ? 'a call queued behind the teardown was ACCEPTED by a disposed backend'
        : port.terminated !== 1
          ? `the worker was terminated ${port.terminated} time(s), so the ~1.7 GB wasm heap this refusal claims is `
            + 'gone may still be resident'
          : infers !== 1
            ? `${infers} INFERs reached the port — a terminated worker was posted to after it was gone`
            : queued.every((s) => s.why.includes('deck A') && /dispos/i.test(s.why))
              ? `3 queued calls refused, worker terminated once: "${queued[0].why}"`
              : `the refusal does not name the backend, or does not say it was disposed: "${queued[0].why}" — the `
                + 'second is require()\'s "reported no reason" branch, which is what a backend whose reason was '
                + 'never recorded says');

  await disposing;
}

/**
 * AND AN OPEN `load()`, which is the same defect through the other gate.
 * `Deck.ensureSession()` awaits `backend.load(...)` and memoises the promise in
 * `sessionLoading`; a load that never settles is a deck stuck on `loading` with
 * no way back, and the setup page sits on "preparing the GPU" for ever.
 */
{
  const { backend, port } = standUp({ warmupTurns: 4000 });
  const b = serialiseBackend(backend, 'Backend for deck A');
  const load = [];
  b.load(new ArrayBuffer(4)).then(() => load.push('(it RESOLVED)'), (e) => load.push(String(e.message || e)));
  const posted = await until(() => port.posts.some((p) => p.m && p.m.type === 'LOAD_MODEL'));

  const disposing = b.dispose();
  await turns(200);

  ok(posted && load.length === 1 && load[0] !== '(it RESOLVED)' && load[0].includes('deck A'),
    '...AND AN OPEN load(), so a deck torn down mid-load does not sit on “loading” for ever  '
    + '[entry point: extension/workers/workerbackend.js dispose(), reached from deck.js Deck.dispose() while ensureSession() is open]',
    !posted
      ? 'no LOAD_MODEL ever reached the port, so no load was open when dispose() ran and this inspected nothing'
      : load.length === 0
        ? 'the open load() is STILL PENDING after dispose() — `sessionLoading` is memoised, so the deck can never '
          + 'load again either'
        : load[0] === '(it RESOLVED)'
          ? 'the load RESOLVED after its worker was terminated'
          : load[0].includes('deck A')
            ? load[0]
            : `it rejected without naming the backend: "${load[0]}"`);

  await disposing;
}

console.log(`\nseam-check: ${checks - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
