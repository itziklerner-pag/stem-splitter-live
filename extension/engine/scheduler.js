/**
 * The shared GPU scheduler — Mode 3.
 *
 * Two decks, two inference Workers, two ORT sessions, ONE GPU. This is the
 * single place that decides who runs next and who does not run at all.
 *
 * ---------------------------------------------------------------------------
 * Why serialise at all, when the decks are in separate workers?
 *
 * spike/FINDINGS.md §6 measured a sequential pair of inferences at 1.01x the sum
 * of two solo runs — linear, no contention penalty — because the GPU serialises
 * the work regardless of how many queues feed it. So letting both decks submit
 * concurrently cannot make the pair finish sooner; it can only make BOTH decks
 * finish late instead of one deck finishing on time. Serialising costs nothing
 * measurable and buys the only thing that matters when the machine is
 * oversubscribed: a defined answer to "who wins".
 *
 * (The other reason is not applicable here but is worth writing down so nobody
 * removes the token and then re-adds it for the wrong reason: `Promise.all` over
 * two ORT sessions sharing ONE wasm instance throws `Session already started`
 * and permanently wedges both. One worker per deck means one wasm instance per
 * deck, so that specific trap cannot fire. The token is about scheduling, not
 * about that bug.)
 *
 * ---------------------------------------------------------------------------
 * The policy, in one sentence: when the machine cannot separate both decks in
 * time, the priority deck keeps its stems and the other deck degrades to
 * unseparated audio — never the other way round, and never both at once.
 *
 * L2 (per deck, engine/live.js `skipFrames`) already handles "this deck is
 * late": the deck fills the span from its own capture history and keeps playing.
 * That is correct and unchanged, and it is what happens when only ONE deck falls
 * behind for reasons of its own.
 *
 * L3 (here) handles "the shared resource is oversubscribed": the non-priority
 * deck is denied the GPU *before* it takes it, so the priority deck's next chunk
 * starts immediately instead of queueing behind an inference that was going to
 * miss its deadline anyway. Running a doomed inference is worse than skipping
 * it — it costs the same GPU time and delays the deck that could still make it.
 */

/**
 * Should this deck give up its turn without taking the GPU?
 *
 * Pure, so `node test.js sched` can drive it against a simulated clock instead
 * of a GPU.
 *
 * @param {object} s
 * @param {'A'|'B'} s.deck        the deck asking
 * @param {'A'|'B'} s.priority    the deck that wins ties
 * @param {number}  s.waitMs      how long this request has already been queued
 * @param {number}  s.estMs       p95 estimate of one inference on this machine
 * @param {number}  s.budgetMs    frames of headroom left for this chunk, in ms
 *                                (its deadline minus the time already spent)
 * @param {boolean} s.armed       is L3 enabled at all
 * @returns {{demote:boolean, why:string}}
 */
/**
 * Minimum observations before the estimate may REFUSE a deck the GPU.
 *
 * `estMs` is a p95, and a p95 over n samples is `v[floor(0.95n)]` — which for
 * n < 20 is simply the MAXIMUM. So a single slow early chunk (the one right
 * after a session is created is always slow) sets the estimate above a whole hop
 * and every subsequent decision is made against that outlier.
 */
export const MIN_EVIDENCE = 8;

export function demotionDecision({ deck, priority, waitMs, estMs, budgetMs, armed = true,
                                   samples = Infinity, grantedToDeck = Infinity }) {
  if (!armed) return { demote: false, why: 'L3 disarmed' };
  /**
   * NEVER DEMOTE A DECK THAT HAS NEVER RUN. This is the anti-lockout invariant
   * and it is not a heuristic — it closes a self-reinforcing loop.
   *
   * A demoted deck completes no chunk, so it contributes no timing sample, so
   * the estimate stays whatever the OTHER deck's worst chunk made it, so the
   * same decision repeats forever. Measured under mashup routing: deck B was
   * demoted 15 times in 15 hops while holding a 1.665 s buffer trough, produced
   * nothing at all for the entire run, and the flagship gesture was deck A
   * alone. Refusing a deck the GPU on an estimate it was never allowed to
   * influence is circular; you learn what a deck costs by letting it run.
   */
  if (grantedToDeck === 0) return { demote: false, why: 'deck has never run — no evidence to refuse it on' };
  if (samples < MIN_EVIDENCE) {
    return { demote: false, why: `only ${samples} timing samples, need ${MIN_EVIDENCE} before refusing work` };
  }
  // The priority deck is never demoted by the scheduler. If it cannot make its
  // deadline, its own L2 ladder converts the span to passthrough — which is a
  // deck-local decision made with deck-local information, and is strictly better
  // than a global one because it can still recover mid-hop.
  if (deck === priority) return { demote: false, why: 'priority deck' };
  // It can still make it. Let it run.
  if (waitMs + estMs <= budgetMs) return { demote: false, why: 'fits' };
  // It cannot. Taking the GPU now would burn `estMs` of the priority deck's
  // budget to produce audio that arrives too late to be published.
  return { demote: true, why: `would finish ${Math.round(waitMs + estMs - budgetMs)} ms late` };
}

/**
 * One token, priority-ordered, with L3 demotion.
 *
 * `run()` is the only entry point: it acquires, runs, and releases under
 * try/finally, because an early return between acquire and release deadlocks
 * both decks permanently and that is exactly the kind of bug this codebase has
 * shipped before (LivePipeline.runChunk's detached-buffer comment is the same
 * shape).
 */
export class GpuScheduler {
  /**
   * @param {object} [o]
   * @param {'A'|'B'} [o.priority]  which deck wins when both are ready
   * @param {boolean} [o.armed]     enable L3 demotion
   * @param {() => number} [o.now]  injectable clock, for tests
   */
  constructor(o = {}) {
    this.priority = o.priority || 'A';
    this.armed = o.armed !== false;
    this.now = o.now || (() => performance.now());
    this.busy = null;            // deck id currently holding the token
    /** @type {{deck:string, at:number, resolve:Function}[]} */
    this.q = [];
    /**
     * Two statistics over the same samples, because two decisions need
     * different things from them.
     *
     *   estMs  p95   — what L3 demotes against. A tail statistic, because the
     *                  question is "could this chunk miss", and a mean cannot
     *                  see a distribution that straddles the deadline (the whole
     *                  hop-1.0 lesson (`AGENTS.md`).
     *   medMs  p50   — what a deck ARMS against. A robust statistic, because the
     *                  question is "what will this cost every hop for the next
     *                  ten minutes", the answer is baked in permanently, and p95
     *                  over a window that happened to contain three transients
     *                  put deck B 1.7 s further behind than deck A for an entire
     *                  session (measured at hop 2.6: T = 2600 ms clamped, when
     *                  the deck's real steady state was 813 ms).
     */
    this.estMs = 900;
    this.medMs = 900;
    this.samples = [];
    this.stats = { granted: { A: 0, B: 0 }, demoted: { A: 0, B: 0 }, waitMs: { A: 0, B: 0 }, maxWaitMs: { A: 0, B: 0 } };
    /**
     * Full per-deck series of TOKEN-HELD time (ms) and QUEUE-WAIT time (ms).
     *
     * Held separately from LivePipeline.chunkLog on purpose. A deck's chunk wall
     * time is `wait + held + overhead`, and when the machine is oversubscribed
     * those two move in opposite directions — the wait grows while the held time
     * stays flat. A single number cannot distinguish "the GPU got slower" from
     * "the other deck is in front of me", and that distinction is the whole
     * dual-deck question. Capped at 4096 each (= 2.2 h at hop 1.95).
     */
    this.runMs = { A: [], B: [] };
    this.waitLog = { A: [], B: [] };
  }

  setPriority(deck) { if (deck === 'A' || deck === 'B') this.priority = deck; }

  /** Feed a measured inference time back in so `estMs` tracks the machine. */
  observe(ms) {
    if (!(ms > 0)) return;
    this.samples.push(ms);
    if (this.samples.length > 64) this.samples.shift();
    const v = this.samples.slice().sort((a, b) => a - b);
    this.estMs = v[Math.min(v.length - 1, Math.floor(0.95 * v.length))];
    this.medMs = v[v.length >> 1];
  }

  /**
   * @param {'A'|'B'} deck
   * @param {number} budgetMs  ms of headroom left before this chunk is useless
   * @param {() => Promise<any>} fn  the inference
   * @returns {Promise<{demoted:true, why:string} | {demoted:false, result:any, waitMs:number}>}
   *
   * NOTE the return shape: a demotion is NOT an exception. It is an ordinary,
   * expected outcome that the caller converts into a passthrough span, and
   * making it a throw would route it through the CHUNK_FAILED ladder, which
   * halts the deck after three of them.
   */
  async run(deck, budgetMs, fn) {
    const t0 = this.now();
    // Pre-check before queueing: if it cannot fit even with the token free,
    // there is no point taking a place in the queue.
    const ev = { samples: this.samples.length, grantedToDeck: this.stats.granted[deck] };
    let d = demotionDecision({ deck, priority: this.priority, waitMs: 0, estMs: this.estMs, budgetMs, armed: this.armed, ...ev });
    if (d.demote) { this.stats.demoted[deck]++; return { demoted: true, why: d.why }; }

    await this.acquire(deck);
    const waitMs = this.now() - t0;
    // Re-check after waiting: the world moved while we were queued.
    d = demotionDecision({ deck, priority: this.priority, waitMs, estMs: this.estMs, budgetMs, armed: this.armed, ...ev });
    if (d.demote) {
      this.release(deck);
      this.stats.demoted[deck]++;
      return { demoted: true, why: d.why };
    }
    this.stats.granted[deck]++;
    this.stats.waitMs[deck] += waitMs;
    if (waitMs > this.stats.maxWaitMs[deck]) this.stats.maxWaitMs[deck] = waitMs;
    const held = this.now();
    try {
      const result = await fn();
      return { demoted: false, result, waitMs };
    } finally {
      const ms = this.now() - held;
      if (this.runMs[deck].length < 4096) this.runMs[deck].push(Math.round(ms));
      if (this.waitLog[deck].length < 4096) this.waitLog[deck].push(Math.round(waitMs));
      this.release(deck);
    }
  }

  acquire(deck) {
    if (this.busy === null) { this.busy = deck; return Promise.resolve(); }
    return new Promise((resolve) => { this.q.push({ deck, at: this.now(), resolve }); });
  }

  release(deck) {
    if (this.busy !== deck) return;      // never release someone else's token
    this.busy = null;
    if (!this.q.length) return;
    // Priority deck first; otherwise FIFO, so a starved deck cannot be held off
    // forever by a stream of same-priority requests.
    let i = this.q.findIndex((w) => w.deck === this.priority);
    if (i < 0) i = 0;
    const w = this.q.splice(i, 1)[0];
    this.busy = w.deck;
    w.resolve();
  }

  /** Wake everything up and refuse further work. Used on teardown. */
  drain() {
    const q = this.q;
    this.q = [];
    this.busy = null;
    for (const w of q) w.resolve();
  }

  report() {
    return {
      priority: this.priority, armed: this.armed, estMs: Math.round(this.estMs), medMs: Math.round(this.medMs),
      samples: this.samples.length,
      busy: this.busy, queued: this.q.length,
      granted: { ...this.stats.granted }, demoted: { ...this.stats.demoted },
      maxWaitMs: { A: Math.round(this.stats.maxWaitMs.A), B: Math.round(this.stats.maxWaitMs.B) },
      runMs: { A: this.runMs.A.slice(), B: this.runMs.B.slice() },
      waitMs: { A: this.waitLog.A.slice(), B: this.waitLog.B.slice() },
    };
  }
}
