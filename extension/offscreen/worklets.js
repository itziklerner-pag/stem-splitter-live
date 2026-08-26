/**
 * WHERE THE PLAYBACK WORKLET IS REGISTERED — once per AudioContext, whichever
 * kind of deck gets there first.
 *
 * Mode 3 puts BOTH decks on ONE AudioContext (docs/ARCHITECTURE.md §8.1: two
 * contexts have independent hardware clocks and drift tens of ms per minute, so
 * nothing would beat-match), and both kinds of deck play through the same
 * `stem-playback` processor — `offscreen/live.js` for a live deck,
 * `offscreen/cacheddeck.js` for one streaming from the stem cache. A second
 * `addModule()` of the same processor name on the same context rejects with
 * "A processor named 'stem-playback' is already registered".
 *
 * WHY IT IS ONE MODULE AND NOT A PRIVATE SET IN EACH FILE. It was two: a
 * module-scoped `MODULE_LOADED` WeakSet in `live.js` and another in
 * `cacheddeck.js`, which did not share state — so whether the collision was
 * survivable depended on which deck got there first. `cacheddeck.js` swallowed
 * the rejection; `live.js` had no try/catch at all. A cache hit on one deck
 * (`CachedDeck.ensureGraph()`) followed by a live prime on the other
 * (`LivePipeline.build()`) therefore hit an unswallowed rejection and surfaced
 * as `START_FAILED` — a live deck that refuses to start because a cached deck
 * is already playing, which is the flagship dual-deck gesture. The state is a
 * property of the CONTEXT, so it belongs with the context and not with either
 * caller.
 *
 * ONLY THE NAME COLLISION IS SWALLOWED, and `live.js`'s rule that a genuine load
 * failure must never be swallowed is why. A collision is not a load failure:
 * the module loaded, the processor is registered, and the `AudioWorkletNode`
 * the caller constructs immediately afterwards is what proves it. Anything else
 * — a 404 on the worklet, a syntax error inside it — propagates.
 *
 * AND THE CATCH IS NOT DEAD CODE NOW THAT THE SET IS SHARED. `await addModule()`
 * is a real yield point, so two decks building in the same tick both pass the
 * membership test before either has added itself. That race is the ordinary
 * Mode 3 case — the console opens both decks at once — not a corner.
 */

/** The one processor both kinds of deck play through. */
const PLAYBACK_PROCESSOR = 'offscreen/playback-processor.js';

/** AudioContexts that already have `stem-playback` registered. */
const REGISTERED = new WeakSet();

/**
 * Make sure `stem-playback` is registered on `ctx`. Idempotent per context.
 *
 * @param {AudioContext} ctx
 * @param {(relPath: string) => string} assetUrl  the Host's asset resolver
 *        (`../shared/host.js`), handed down from `offscreen/engine.js` — this
 *        module never resolves a URL itself, so it stays as host-agnostic as
 *        the two decks that call it.
 * @returns {Promise<void>}
 */
export async function ensurePlaybackWorklet(ctx, assetUrl) {
  if (REGISTERED.has(ctx)) return;
  try {
    await ctx.audioWorklet.addModule(assetUrl(PLAYBACK_PROCESSOR));
  } catch (e) {
    if (!/already registered/i.test(String(e && e.message))) throw e;
  }
  REGISTERED.add(ctx);
}
