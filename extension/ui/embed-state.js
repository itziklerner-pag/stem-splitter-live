/**
 * The decisions the embedded deck makes, kept pure so they have a check. No
 * DOM, no chrome.*, no imports. Runnable check:
 *
 *     node extension/ui/embed-state.js
 *
 * ONE EXCEPTION, named here so the line above stays true: `isMac()` reads the
 * ambient `navigator` when it is given no argument, guarded by `typeof`. It
 * takes the object as a parameter for exactly that reason — every assertion
 * passes one, so nothing in this file's check depends on the machine it runs
 * on.
 *
 * THERE IS NO START BUTTON. The user's own player is the only transport in this
 * build, so "should the pipeline be running" is derived, not clicked — and a
 * derived answer that nobody can press is exactly the kind of thing that has to
 * be testable without a browser and a 172 MiB download in the way.
 *
 * ---------------------------------------------------------------------------
 * THE OFFSET IS STRUCTURAL. Read this before trying to close it.
 * ---------------------------------------------------------------------------
 * Our output at wall time T is the content the tab RENDERED at T − Δ, where Δ
 * is the pipeline's buffer (hop + floor, ~2.4 s). The video shows V(T). Sync
 * would require V(T − Δ) = V(T): the video at the position it held Δ seconds
 * ago. For a playing video that is false at every T.
 *
 * Every fix that suggests itself moves the INPUT by the same amount, because
 * the video we would manipulate is the source of the audio we capture:
 *   - seek back by Δ  -> synced for exactly Δ s, then the replayed audio
 *                        arrives and it is Δ behind again
 *   - skip the replay -> empties the buffer, forces a re-prime, Δ behind again
 *   - playbackRate    -> scales both sides; the gap shrinks by the rate and
 *                        never reaches zero
 *   - pause to prime  -> a paused tab produces no audio; it deadlocks
 * The only escape is rendering the user a DELAYED COPY of the video, which
 * means reading the media stream. That is L1, and it is a different product.
 *
 * So the deck is honest about Δ instead: it shows it. The one lever that
 * genuinely shrinks it is the hop, and that is the engine's call, not this
 * file's.
 */

/**
 * The statuses in which the deck is producing (or about to produce) audio.
 * `priming` counts: a deck filling its ring has already taken the tab's audio.
 */
export const RUNNING = new Set(['priming', 'running', 'starving']);

/**
 * SHOULD THE PIPELINE BE RUNNING RIGHT NOW?
 *
 * `videoPlaying` is TRI-STATE, and what the third value MEANS depends on
 * `hosted` — which is the correction for a real defect, not a refinement:
 *   true  — the page told us its player is playing
 *   false — the page told us it is paused
 *   null  — nobody has told us. Then:
 *             hosted  -> WAIT. There is a page above us and it has not spoken
 *                        yet; this is the boot window, not the absence of a
 *                        signal.
 *             not     -> RUN. Nothing is ever going to tell us (opened
 *                        directly, a harness, a future host), and a feature
 *                        that silently does nothing when its input is missing
 *                        is the worst of the outcomes.
 *
 * **Measured, on the first run of tools/embed-smoke.mjs.** Without the `hosted`
 * split, `null` meant "run" from the instant the deck booted — so opening it on
 * a PAUSED video started a capture ~1.2 s before the page reported `paused`,
 * and the engine begins fetching 172 MiB of weights the moment a capture
 * attaches (offscreen.js captureStart). The engine log said `deck A capture
 * started` with nothing playing. The deck then stopped itself when the real
 * signal landed, which is exactly why it was invisible: every state the UI
 * showed afterwards was correct.
 *
 * `hosted` IS A FACT ABOUT THE HOST, NOT ABOUT FRAMES. It is
 * `host.transport != null` — does whatever is hosting this deck report a
 * player. It used to be "am I in a frame", and that was the same answer only by
 * accident of there being one Host: a Host that draws this deck as a top-level
 * document and reports its player would have been read here as "nobody is ever
 * going to tell me", i.e. as licence to start a capture, and behind it a model
 * download, on boot.
 *
 * ponytail: ceiling — a Host that DECLARES a transport and then never speaks
 * leaves this waiting for ever instead of falling back. Today the Host that
 * declares one is the page that created this frame, so it cannot happen.
 * Upgrade path: a deadline (fall back after ~2 s of silence) if a second host
 * ever embeds this deck.
 *
 * `halted` is the latch a failure sets. Without it, "armed + playing + idle" is
 * true again on the next 10 Hz status message and the deck restarts in a loop
 * around a banner nobody has read.
 *
 * @param {{armed:boolean, halted:boolean, status:string,
 *          videoPlaying:boolean|null, hosted:boolean}} s
 * @returns {'start'|'stop'|'hold'}
 */
export function follow(s) {
  const status = (s && s.status) || 'idle';
  const running = RUNNING.has(status);
  if (!s) return 'hold';
  // Anything that stops the deck stops it regardless of why, and none of these
  // may auto-start it again.
  if (s.halted || status === 'error' || !s.armed) return running ? 'stop' : 'hold';
  // UNKNOWN NEVER STOPS A RUNNING DECK. A quiet page is not evidence that the
  // user paused, and taking audio away on no evidence is worse than carrying on.
  // It only decides whether to START, and there the two hosts differ.
  if (s.videoPlaying == null) return running || s.hosted ? 'hold' : 'start';
  if (s.videoPlaying && !running) return 'start';
  if (!s.videoPlaying && running) return 'stop';
  return 'hold';
}

/**
 * THE BOOT COMPOSITION — the layer the \`transport: null\` defect lived in, and
 * the layer nothing used to drive.
 *
 * \`follow()\` above is a pure function of five values, and it has been asserted
 * from every direction for as long as it has existed. THAT WAS NOT ENOUGH, and
 * the reason is worth the paragraph: the defect was never in \`follow()\`. It was
 * in the wiring one level up, where \`videoPlaying\` and \`hosted\` come FROM.
 *
 *   \`hosted\`       is \`host.transport != null\`, asked once.
 *   \`videoPlaying\` is TRI-STATE, and its only writer is the report the
 *                  transport pushes — so with \`transport: null\` there is no
 *                  \`onState\` to register on, and the third value is not a value
 *                  the deck is waiting for, it is a value the deck can never
 *                  leave. \`follow()\` then reads "nobody is ever going to tell
 *                  me" as licence to START: a capture, and behind it a 109 MB
 *                  model load, before the user has touched anything.
 *
 * A Host that declares \`transport: null\` because its Source is a file — a deck
 * that IS the player, running off the engine's playback clock — reproduces
 * exactly that. Four separate documents ratified it before anyone drove the
 * boot path (\`.handoff/PHASE4-CONTRACT.md\` §1.E, §2 W6, §8 C6; upstream #5).
 *
 * SO THE COMPOSITION IS THE UNIT, AND IT IS HERE RATHER THAN IN \`embed.js\`.
 * \`extension/ui/embed.js\` builds a DOM at module scope and cannot be evaluated
 * from Node, so anything that lives there can only be checked as TEXT or in a
 * browser — and the browser gate is blind to this by construction: under the
 * one shipping Host the two paths behave identically, because that Host always
 * has a player. Moving the composition here is what lets a suite hand it a
 * transport and COUNT what the deck asked for.
 *
 * THIS OBJECT HOLDS STATE, WHICH THE REST OF THIS FILE DOES NOT, AND THAT IS
 * THE POINT. \`videoPlaying\` has to be UNREACHABLE from outside: a fixture that
 * could assign it would be able to make the hosted and unhosted cases identical
 * inputs, and a gate whose fixture makes two inputs identical is blind to
 * whatever distinguishes them. The only way in is the transport's own report.
 *
 * @param {{onState:Function, onJump:Function, onSpeedReport:Function}|null} transport
 *   the Host's player, as \`assertHostOption\` handed it back — an object, or
 *   \`null\` for a Host with genuinely no player at all.
 * @param {{onState:(d:object)=>void, onPlaying:(playing:boolean)=>void,
 *          onJump:()=>void, onSpeedReport:(d:object)=>void,
 *          start:()=>void, stop:()=>void}} o  the deck's effects.
 *   \`onState\` is everything the deck does with a report; \`onPlaying\` is the
 *   part that runs only when play/pause actually FLIPPED; \`start\` and \`stop\`
 *   are the two effects \`follow()\` names.
 * @returns {{hosted:boolean, videoPlaying:boolean|null,
 *            listen:()=>void, decide:(s:object)=>string}}
 */
export function makeFollower(transport, o) {
  /**
   * REFUSED AT CONSTRUCTION, NAMING THE EFFECT — the same shape and the same
   * reason as \`assertHost\`. An effects bag short \`start\` would leave
   * \`decide()\` returning \`'start'\` to nobody: the deck would decide to run and
   * then not run, with nothing thrown and nothing painted. That is a failure
   * that has to land at boot, not at the first play.
   */
  const EFFECTS = ['onState', 'onPlaying', 'onJump', 'onSpeedReport', 'start', 'stop'];
  const missing = EFFECTS.filter((k) => typeof (o || {})[k] !== 'function');
  if (missing.length) {
    throw new TypeError('makeFollower: the deck did not supply '
      + missing.map((k) => k + '()').join(', ')
      + ' — every effect follow() can name has to be there before the first report arrives, '
      + 'or the deck decides to start and nothing starts.');
  }

  /**
   * DOES THIS DECK HAVE A HOST THAT REPORTS A PLAYER? Asked ONCE, here, and
   * nowhere else in the unit. It used to be \`window.parent !== window\` in
   * \`embed.js\`, which is a fact about FRAMES and not about hosting.
   */
  const hosted = transport != null;

  /**
   * The player's state, per the transport. TRI-STATE: true playing, false
   * paused, **null nobody has told us** — and see \`follow()\` above for why the
   * third value is not the same as \`false\`.
   */
  let videoPlaying = null;
  let listening = false;

  return {
    get hosted() { return hosted; },
    get videoPlaying() { return videoPlaying; },

    /**
     * PUT THE HANDLERS UP. Separate from construction because ORDER IS
     * BEHAVIOUR: the deck registers its transport handlers at one specific
     * point in its boot, after its own bus listener and before it tells the
     * page it is ready, and a report that arrives before that point is dropped
     * on purpose. Constructing the follower earlier — so that \`hosted\` is
     * settled before anything reads it — must not move that point.
     */
    listen() {
      if (listening) return;
      listening = true;
      if (!transport) return;
      transport.onState((d) => {
        o.onState(d);
        const playing = !!(d && d.playing === true);
        // UNCHANGED IS NOT AN EVENT. The report arrives on a heartbeat as well
        // as on a transition, and rerunning the play/pause effects at 4-10 Hz
        // would clear the failure latch on every tick of a video that has been
        // playing all along.
        if (playing === videoPlaying) return;
        videoPlaying = playing;
        o.onPlaying(playing);
      });
      transport.onJump(o.onJump);
      transport.onSpeedReport(o.onSpeedReport);
    },

    /**
     * THE FOLLOW LOOP'S ONE STEP: decide, then do. Called after every input
     * that can change the answer — a status message, a session change, the
     * player reporting play/pause, and the arm switch itself.
     *
     * @param {{halted:boolean, armed:boolean, status:string}} s
     *   the three the deck owns. The other two are this object's and are NOT
     *   parameters, which is the whole of the fix: a caller cannot hand in a
     *   \`videoPlaying\` the transport never reported.
     * @returns {'start'|'stop'|'hold'}
     */
    decide(s) {
      const what = follow({
        halted: !!(s && s.halted),
        armed: !!(s && s.armed),
        status: (s && s.status) || 'idle',
        videoPlaying,
        hosted,
      });
      if (what === 'start') o.start();
      else if (what === 'stop') o.stop();
      return what;
    },
  };
}

/**
 * THE ONE READOUT, in the place a Start button used to be. It is now the whole
 * of the deck's self-report, so its wording is the feature: a user who pressed
 * play and hears nothing for two seconds must be able to see why.
 *
 * @param {{armed:boolean, halted:boolean, status:string, videoPlaying:boolean|null,
 *          passthrough:boolean, primedPct:number, modelPct:number|null}} s
 * @returns {{kind:''|'run'|'wait'|'warn'|'err', label:string}}
 */
export function chip(s) {
  const v = s || {};
  const status = v.status || 'idle';
  if (!v.armed && !RUNNING.has(status)) return { kind: '', label: 'Not armed' };
  if (v.halted || status === 'error') return { kind: 'err', label: 'Stopped' };
  if (status === 'starving') return { kind: 'warn', label: 'Starving' };
  if (status === 'running') {
    // Passthrough is the UNSEPARATED mix reaching the speaker. The deck is
    // playing, but the faders are doing nothing — calling that "Live" would be
    // the UI claiming a separation that is not happening.
    return v.passthrough ? { kind: 'warn', label: 'Passthrough' } : { kind: 'run', label: 'Live' };
  }
  if (status === 'priming') {
    // Two different waits wearing one status. The model download is minutes;
    // the ring fill is seconds. Telling them apart is the difference between
    // "nearly there" and "go and make coffee".
    return v.modelPct != null
      ? { kind: 'wait', label: `Model ${Math.round(v.modelPct)}%` }
      : { kind: 'wait', label: `Priming ${Math.round((v.primedPct || 0) * 100)}%` };
  }
  // Idle. The paused case is the one that used to be an OUTPUT_DEAD banner, and
  // it is now an instruction naming the control the user actually has.
  return v.videoPlaying === false
    ? { kind: '', label: 'Press play' }
    : { kind: 'wait', label: 'Ready' };
}

/**
 * PEAK-HOLD BALLISTICS for the stem meters, which the vertical trough needs and
 * the old 6 px horizontal bar did not. A peak tick that follows the wire
 * frame-for-frame at 30 Hz is a flicker, not a reading: the number a DJ wants is
 * "how loud did this stem just get", and that answer has to stay on screen long
 * enough to be read (DESIGN §7.1 — hold 1200 ms, then fall 20 dB/s).
 *
 * Pure, because it is the only new arithmetic this surface added and because the
 * behaviour it encodes is a timing rule — the kind that is invisible in a
 * screenshot and expensive to check by hand in a browser.
 *
 * THE ONE ENTRY POINT is the `METERS` handler in embed.js, called once per stem
 * per message (~30 Hz) with the dt since the previous message. It is never
 * called from an animation frame: the ballistics are advanced by the arrival of
 * data, so when the engine stops sending, the meter stops moving rather than
 * decaying towards a silence nobody measured.
 *
 * @param {{db:number, holdUntil:number, clipUntil:number}|null} prev
 * @param {number} inDb  this frame's peak in dBFS; -Infinity for silence
 * @param {{now:number, dtMs:number, silent:boolean, floorDb:number,
 *          ballistics:{peakHoldMs:number, peakFallDbPerS:number,
 *                      clipDb:number, clipLatchMs:number}}} o
 *   `ballistics` and `floorDb` are passed in rather than imported: this file has
 *   no imports by design, and audio-math owns both values. A copy here would be
 *   a second place for DESIGN §7.1 to live.
 * @returns {{db:number, holdUntil:number, clipUntil:number}}
 */
export function peakTick(prev, inDb, o) {
  const p = prev || { db: -Infinity, holdUntil: 0, clipUntil: 0 };
  const b = o.ballistics;
  const now = o.now;
  /**
   * A LATCHED CLIP OUTLIVES THE SIGNAL THAT CAUSED IT, including a mute — the
   * user muted the stem *because* it was clipping, and clearing the indicator
   * on that gesture would erase the reason. It is cleared by time or by a click
   * on the meter, and by nothing else.
   */
  const clipUntil = isFinite(inDb) && inDb >= b.clipDb ? now + b.clipLatchMs : p.clipUntil;

  /**
   * A muted or ducked stem is silent within 18 ms (AUDIO.md §3.3), so holding a
   * peak from audio that no longer exists would be a lie. SNAP, do not release.
   */
  if (o.silent) return { db: -Infinity, holdUntil: 0, clipUntil };

  // `>=`, not `>`: a signal sitting at exactly the held level is still present,
  // and re-arming the hold is what keeps the tick up on a steady tone.
  if (isFinite(inDb) && inDb >= p.db) return { db: inDb, holdUntil: now + b.peakHoldMs, clipUntil };
  if (now <= p.holdUntil) return { db: p.db, holdUntil: p.holdUntil, clipUntil };

  let db = isFinite(p.db) ? p.db - b.peakFallDbPerS * (o.dtMs / 1000) : -Infinity;
  // The meter law zeroes at or below floorDb, so a tick below it is off-scale
  // and would otherwise keep falling forever at 20 dB/s.
  if (db <= o.floorDb) db = -Infinity;
  return { db, holdUntil: p.holdUntil, clipUntil };
}

/**
 * =========================================================================
 * KEYBOARD. DESIGN §11, trimmed to the one deck this build has.
 * =========================================================================
 *
 * THE HARD PART IS NOT THE BINDING, IT IS THE FOCUS. This deck is a
 * cross-origin `chrome-extension://` iframe inside somebody else's page, and a
 * key event never crosses that boundary. In the gesture the feature exists for
 * — the user clicks YouTube's play button and then reaches for a digit — focus
 * is on the YOUTUBE document, where YouTube's own handler reads 1-9 as
 * seek-to-percentage. A listener in the deck alone is a feature that works only
 * after you have clicked the deck.
 *
 * So there are two entry points and this file serves both:
 *
 *   1. `content.js`, capture phase on the host page. It decides only WHETHER to
 *      intercept, from `hostKeys()` below, and forwards the event to the deck.
 *   2. `embed.js`, the deck's own document, when the frame already has focus.
 *
 * Both then call `shortcut()`, which is where what-the-key-does lives. The
 * split is deliberate: the host has to answer "is this ours" BEFORE it can call
 * `preventDefault`, and it cannot import this file (a content script is a
 * classic script in an isolated world). `hostKeys()` is therefore SENT to it —
 * the deck posts the list, the host stores it — so the two entry points cannot
 * disagree about which keys we take.
 */

/**
 * WHY 1-6 ARE CONDITIONAL AND SPACE IS NOT TAKEN AT ALL.
 *
 * We are a guest on YouTube's page. `content.js` only intercepts these while a
 * deck is ARMED (product ruling): with no deck, YouTube's seek-to-percentage must
 * behave exactly as it does with the extension uninstalled.
 *
 * ONE DIGIT PER STRIP, SIX STRIPS, SIX DIGITS — ratified 2026-08-17,
 * retiring the `Digit5`-`Digit8` carve-out. That carve-out was written when this
 * surface had FOUR strips and `5`-`8` was deck B's block on the console; the
 * console went, the sixth stem landed, and the clause was never revisited. Its
 * stated reason — a key we take is a key YouTube stops getting — is true, and it
 * does not distinguish `5` from `1`: this build had already spent `1`-`4` and
 * `0` on exactly that trade. A rack where two of six strips are pointer-only is
 * the artifact, not the policy. `7` `8` `9` still reach YouTube's
 * seek-to-70/80/90 %, which is where the trade now sits.
 *
 * NOT HERE, and each absence is a decision rather than an omission:
 *   7 8 9       the surviving seek digits. Six strips need six keys and no more,
 *               so these are the ones the page keeps — the boundary is
 *               `KEYED_STEMS` below and it is asserted at both entry points.
 *   Q W E R T Y the crossfader assign matrix, which this build does not have
 *   A S D F G H the console's per-stem solo row (new with six stems). Shift+1-6
 *               is solo HERE, because there is no deck B for Shift to name.
 *   [ ] \       the crossfader
 *   `           deck focus, with one deck
 *   Space       YouTube's transport is the ONLY transport in this build
 *               (ARCHITECTURE §6.5). Taking it would put two controls on one
 *               piece of audio and the user would have to work out which wins.
 */
const STEM_DIGITS = [
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6',
];
const ZERO_DIGITS = ['Digit0', 'Numpad0'];

/**
 * HOW MANY STRIPS HAVE A DIGIT IN THIS BUILD. Six, against six strips — which is
 * the point, and it is why this is still a named constant rather than being
 * folded away as "all of them": the number is the same fact `STEM_DIGITS`, the
 * `n > KEYED_STEMS` guard in `shortcut()` and `stemKeyHint()` all encode, and
 * three copies of one boundary is how a boundary moves by accident. `embed.js`
 * builds the key hint from `stemKeyHint()` below, so a strip cannot be drawn
 * with a digit the handler refuses.
 */
export const KEYED_STEMS = 6;

/**
 * The hint printed in a strip's header — the digit that selects it, or the
 * EMPTY STRING for an index that is not a strip.
 *
 * IT IS STILL NOT A CONSTANT `index + 1`. The empty branch is what stops a rack
 * that grows a seventh strip from advertising `7` — which `shortcut()` refuses,
 * because `7` is YouTube's seek-to-70 %. A hint the handler does not honour is
 * worse than no hint: the user presses it, the page jumps, and the deck is what
 * looks broken.
 *
 * ENTRY POINT: `buildStrips()` in embed.js, once per strip at boot.
 *
 * @param {number} index position in the fixed display order, 0-based
 * @returns {string} `'1'`..`'6'`, or `''` for an index with no key
 */
export function stemKeyHint(index) {
  return Number.isInteger(index) && index >= 0 && index < KEYED_STEMS ? String(index + 1) : '';
}

/**
 * The codes `content.js` intercepts on the host page — i.e. the ones it calls
 * `preventDefault()` + `stopPropagation()` on, so YouTube never sees them.
 *
 * ESCAPE IS CONDITIONAL, and that is the whole reason this is a function and
 * not a constant. Esc on YouTube exits full screen and closes their menus. We
 * may only take it when we have something to do with it — a solo to clear or an
 * overlay to close — because "the extension broke Escape" is indistinguishable
 * from "the page is broken" to the person it happens to.
 *
 * `?` is not here: it is a CHARACTER, not a key position (Shift+Slash on a US
 * layout and somewhere else entirely on others), so the host matches it on
 * `event.key` exactly as the host does.
 *
 * @param {{anySolo:boolean, overlayOpen:boolean}} s
 * @returns {string[]} `event.code` values
 */
export function hostKeys(s) {
  const v = s || {};
  const out = [...STEM_DIGITS, ...ZERO_DIGITS];
  if (v.anySolo || v.overlayOpen) out.push('Escape');
  return out;
}

/** Nothing to do, and nothing to say about it. */
const NO_ACT = { act: 'none', index: -1 };

/**
 * WHAT A KEY DOES. The one decision, called from both entry points named above
 * with the same fields, so a key cannot mean two things depending on where the
 * focus happened to be.
 *
 * `typing`, `ctrl` and `meta` are refused here rather than at the call sites:
 * stealing a digit out of YouTube's search box or a half-written comment is the
 * failure users report as "it ate my comment", and it must not be possible to
 * add a third caller that forgets the guard.
 *
 * AUTOREPEAT DOES NOTHING. Holding `1` on a toggle would flicker the vocal at
 * the OS repeat rate. The host still intercepts the repeats — `hostKeys()` is
 * repeat-blind on purpose, because letting them through would hand YouTube a
 * seek for a key the user is holding for us.
 *
 * @param {{code:string, key?:string, shift?:boolean, alt?:boolean, ctrl?:boolean,
 *          meta?:boolean, repeat?:boolean, typing?:boolean, hasSolo?:boolean,
 *          overlayOpen?:boolean}} s
 * @returns {{act:'none'|'mute'|'solo'|'reset'|'unmute-all'|'clear-solo'
 *            |'help-open'|'help-close', index:number}}
 *   `index` is the stem's position in the fixed left-to-right order, or -1.
 */
export function shortcut(s) {
  const v = s || {};
  if (v.ctrl || v.meta || v.typing) return NO_ACT;
  const code = v.code || '';

  // The overlay swallows everything while it is up, exactly as the console's
  // does: a shortcut fired from behind a list of shortcuts is a surprise.
  if (v.overlayOpen) {
    return code === 'Escape' || v.key === '?' ? { act: 'help-close', index: -1 } : NO_ACT;
  }
  // DESIGN §11.4: Esc closes the top-most overlay; with none open it is the
  // "get me back to normal" key. With no solo up there is nothing to get back
  // from, and we hand it to YouTube — see hostKeys().
  if (code === 'Escape') return v.hasSolo ? { act: 'clear-solo', index: -1 } : NO_ACT;
  if (v.key === '?') return { act: 'help-open', index: -1 };

  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!m) return NO_ACT;
  const n = Number(m[1]);
  /**
   * THE BOUNDARY, which is now the rack's own width.
   *
   * `1`-`6` are the six strips; `7`-`9` stay YouTube's seek-to-70/80/90 %. The
   * old boundary was 4 and it was deck B's, not this rack's — see the
   * `STEM_DIGITS` header for why it went. A key we take is a key the page stops
   * getting, so the rack does not take more digits than it has strips.
   *
   * `KEYED_STEMS`, not the literal 6, so the hint printed on the strip and the
   * key that is honoured here cannot disagree about which strips have one.
   */
  if (n > KEYED_STEMS) return NO_ACT;
  if (v.repeat) return NO_ACT;
  if (n === 0) return { act: 'unmute-all', index: -1 };
  return { act: v.alt ? 'reset' : v.shift ? 'solo' : 'mute', index: n - 1 };
}

/**
 * =========================================================================
 * WHAT THE KEY IS CALLED ON THE KEYBOARD IN FRONT OF THE USER
 * =========================================================================
 * NOTHING BELOW CHANGES WHAT ANY KEY DOES, and the distinction is the whole
 * defect. The bindings above were already correct on a Mac: the Option key is
 * what sets `event.altKey` in the DOM, and every digit is matched on
 * `event.code` — the key's POSITION, not the character Option puts on it
 * (`⌥`+`1` is "¡" on a US layout). `Alt`+`1` has always reset the vocal fader
 * on a MacBook.
 *
 * What was wrong is the LABEL. Apple calls that key `option` and prints `⌥` on
 * it; the overlay said `Alt`, which is a key a Mac user does not have. A
 * shortcut a user cannot recognise is a shortcut they do not have, so the
 * feature was missing on that hardware while working perfectly.
 *
 * THE RULE THIS FILE ENCODES, because it is the thing that will be argued
 * about: a KEY CAP gets the glyph, PROSE gets the word. `⌥` in a `.kbd` chip
 * is what is printed on the key the hand is looking for; `⌥` inside a sentence
 * or a tooltip is a character most screen readers cannot say. So every chip
 * carries an accessible name alongside the glyph (`say` below), and the
 * remaining prose in the deck names `Shift` — which is what a Mac keyboard
 * prints too, and therefore was never part of this defect.
 */
const MOD_LABEL = {
  alt:   { word: 'Alt',   glyph: '⌥', say: 'Option' },
  shift: { word: 'Shift', glyph: '⇧', say: 'Shift' },
  ctrl:  { word: 'Ctrl',  glyph: '⌃', say: 'Control' },
  cmd:   { word: 'Cmd',   glyph: '⌘', say: 'Command' },
};

/**
 * One modifier, spelled for one platform.
 *
 * ENTRY POINTS: `relabel()` in embed.js, over every `[data-mod]` chip in the
 * deck's document, at boot; and `chordLabel()` below.
 *
 * `null` FOR A NAME THIS TABLE HAS NEVER HEARD OF, rather than a blank or the
 * name itself. `relabel()` leaves such a chip alone, so the markup keeps
 * whatever it was authored with — and the pin in the check at the foot of this
 * file goes red, which is where a typo'd `data-mod` is meant to be caught. A
 * fallback that returned the raw name would render `meta` on a key cap and
 * look deliberate.
 *
 * @param {string} mod one of `alt` `shift` `ctrl` `cmd`
 * @param {boolean} mac Apple keyboard — `isMac()` below, resolved once
 * @returns {{text:string, say:string}|null} `text` is drawn, `say` is announced
 */
export function modLabel(mod, mac) {
  const m = MOD_LABEL[mod];
  if (!m) return null;
  return mac ? { text: m.glyph, say: m.say } : { text: m.word, say: m.word };
}

/**
 * IS THIS AN APPLE KEYBOARD? Asked ONCE per surface, at boot, and only ever to
 * pick a spelling — no binding, no capability and no code path branches on it.
 *
 * `navigator.userAgentData.platform` FIRST because `navigator.platform` is
 * deprecated, and the deprecated one SECOND because UA-Client-Hints is not
 * guaranteed present in every context this code runs in (it is absent in
 * Node, and `userAgentData` is unavailable on non-secure origins in some
 * builds). Both absent, the user-agent string is the last resort.
 *
 * NOT `navigator.maxTouchPoints`-style sniffing and not a feature test: there
 * is no feature to test. The question is literally "what is printed on the
 * key", which only the platform name answers.
 *
 * ABSENT EVIDENCE IS "NOT A MAC", and that is a labelling default rather than
 * an assertion excusing itself: the words are the correct spelling on every
 * platform that is not this one, so the fallback is the majority case and not
 * a shrug. (The assertions below never call this with the ambient navigator —
 * Node 24 reports `navigator.platform === 'MacIntel'` on a Mac, so a bare call
 * would make the verdict a property of the machine running the suite.)
 *
 * ENTRY POINTS: boot in embed.js (the `?` overlay) and boot in welcome.js (the
 * arm chord in step 2). Both resolve it once into a `const`.
 *
 * @param {{userAgentData?:{platform?:string}, platform?:string, userAgent?:string}} [nav]
 *   defaults to the ambient `navigator`; passed explicitly by the checks
 * @returns {boolean}
 */
export function isMac(nav) {
  const n = nav || (typeof navigator === 'undefined' ? null : navigator);
  if (!n) return false;
  const hinted = n.userAgentData && n.userAgentData.platform;
  if (typeof hinted === 'string' && hinted !== '') return hinted === 'macOS';
  return /Mac/i.test(String(n.platform || n.userAgent || ''));
}

/**
 * What a modifier can be called inside a `chrome.commands` accelerator, mapped
 * onto the table above — BOTH SPELLINGS, because Chrome uses both.
 *
 * MEASURED, not assumed, and the measurement corrected this file: on macOS
 * `chrome.commands.getAll()` returns the shortcut ALREADY DRAWN as `⌃⇧9`, not
 * as the `MacCtrl+Shift+9` token the manifest declares. (`tools/embed-smoke.mjs`
 * reads the raw string out of the real extension and prints it in its own
 * assertion, so the day that changes it is a red with the new value in it.) The
 * manifest tokens are kept because they are what the accelerator IS on the
 * other platforms — and because a function that only understood the form it
 * happened to be handed once is how this comment came to be wrong the first
 * time.
 */
const ACCEL_MOD = {
  MacCtrl: 'ctrl', Ctrl: 'ctrl', Command: 'cmd', Alt: 'alt', Shift: 'shift',
  '⌃': 'ctrl', '⌘': 'cmd', '⌥': 'alt', '⇧': 'shift',
};

/**
 * The toolbar chord, spelled for the platform: `⌃⇧9` on a Mac, `Ctrl+Shift+9`
 * everywhere else — the convention README.md line 47 already uses.
 *
 * TWO ENTRY POINTS, BOTH ON THE SAME STRING: welcome.js's step 2, and the deck's
 * not-armed hint (`paintArmHint()` in embed.js). Each spells the `shortcut`
 * field of the `arm-tab` command, welcome.js from `chrome.commands.getAll()`
 * directly and the deck through `host.armShortcut()`. It is READ FROM THE
 * BROWSER rather than typed into the markup because the user can rebind it, so
 * this has to cope with any accelerator and not just the manifest's — and both
 * callers make the same `say !== text` decision on the result, which is why that
 * comparison is a documented answer here and not a convention they share by
 * accident.
 *
 * THE HALF THAT IS WORK ON A GLYPH PLATFORM, since Chrome hands back the
 * glyphs on macOS already: `say`. `⌃⇧9` read out character by character is not
 * an instruction, so the chip gets `role="img"` and "Control Shift 9" as its
 * accessible name. A sighted Mac user was never affected here; a screen-reader
 * one was.
 *
 * AND OFF A GLYPH PLATFORM IT IS NOT WORK, WHICH IS WHY THE SEPARATOR IS
 * SHARED. `modLabel()` already returns `text === say` for every modifier it
 * spells in words, so the only thing that could ever have made the two strings
 * differ off a Mac was the JOIN — and it did, for every chord with a modifier
 * in it. That is not a cosmetic difference: `welcome.js` keys `role="img"` +
 * `aria-label` on `say !== text`, so a chord already drawn as `Ctrl+Shift+9`
 * was announced as a graphic named "Ctrl Shift 9" — the visible text
 * suppressed and nothing gained, on every non-Mac machine. The announced form
 * therefore uses the separator that is DRAWN, and a space stands in only where
 * nothing is drawn between the glyphs, because "ControlShift9" is not an
 * instruction either. `say !== text` then means exactly "this platform draws
 * glyphs", which is the question the caller is actually asking.
 *
 * TOKENISING TAKES BOTH FORMS. `'+'` separates manifest tokens; Apple glyphs
 * are simply concatenated, so leading glyph characters are peeled off one at a
 * time. `rest.length > 1` stops the last token — the key itself — from being
 * eaten even in the impossible case that it is a glyph.
 *
 * `null` WHEN THERE IS NOTHING TO SPELL — no command, or a command with no
 * chord bound — because the caller's fallback ("set one at
 * chrome://extensions/shortcuts") is a different sentence, not an empty key
 * cap. An unbound chord rendered as `''` is the failure this returns null for.
 *
 * @param {string|null|undefined} accel e.g. `'⌃⇧9'` or `'Ctrl+Shift+9'`
 * @param {boolean} mac
 * @returns {{text:string, say:string}|null}
 */
export function chordLabel(accel, mac) {
  const s = typeof accel === 'string' ? accel.trim() : '';
  if (s === '') return null;
  const drawn = [], said = [];
  const take = (tok) => {
    const l = modLabel(ACCEL_MOD[tok], mac);
    drawn.push(l ? l.text : tok);
    said.push(l ? l.say : tok);
  };
  for (const chunk of s.split('+')) {
    let rest = chunk;
    while (rest.length > 1 && ACCEL_MOD[rest[0]]) { take(rest[0]); rest = rest.slice(1); }
    if (rest !== '') take(rest);
  }
  const sep = mac ? '' : '+';
  return { text: drawn.join(sep), say: said.join(sep || ' ') };
}

/**
 * =========================================================================
 * TRANSPOSE
 * =========================================================================
 * Semitones, integer, [-6, +6] — the range `engine/pitch.js` ships ratios for.
 * Anything else is clamped rather than refused: this is the last gate before a
 * number goes on the wire to the shifter, and the shifter's contract is the
 * integer range, not "whatever the UI happened to hold".
 *
 * THESE TWO NUMBERS ARE THE ENGINE'S, COPIED. `engine/pitch.js` exports
 * `PITCH_MIN_SEMITONES`/`PITCH_MAX_SEMITONES` and `offscreen.js` refuses
 * anything outside them independently, so the clamp below and that refusal are
 * two copies of one range — and this file may not import, so the copy cannot be
 * removed. What CAN be removed is the DRIFT: the check at the bottom imports
 * pitch.js and pins the pair, so widening the engine's range without widening
 * this one (or the reverse, which silently makes the engine's refusal path
 * reachable from the UI) is a red rather than a discovery. Four defects in this
 * repo have come from a value being right at one call site and wrong at another.
 */
export const SEMITONE_MIN = -6;
export const SEMITONE_MAX = 6;

/** @param {number} n @returns {number} integer in [-6, +6]; 0 for anything unreadable. */
export function clampSemitones(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 0;
  return v < SEMITONE_MIN ? SEMITONE_MIN : v > SEMITONE_MAX ? SEMITONE_MAX : v;
}

/**
 * =========================================================================
 * SPEED — the ladder, and the four decisions that read it
 * =========================================================================
 *
 * KEY-LOCKED, NOT VARISPEED. The page's own `<video>` does the work — the same
 * `playbackRate` YouTube's own speed menu writes, with `preservesPitch` left
 * TRUE — so the TEMPO moves and the key does not. Nothing here resamples
 * anything of ours and nothing here is on the capture->model path, which is what
 * CONTRIBUTING.md's absolute prohibition covers.
 *
 * SPEED IS KEY-LOCKED, reversing an earlier varispeed design. This paragraph used
 * to say the pitch followed the speed the way a turntable does, and it did:
 * `content.js::driveRate` cleared `preservesPitch` on every write, the element
 * rendered transposed audio, and the capture tap sits DOWNSTREAM of it — so the
 * separator was fed the wrong key and TRANSPOSE was the manual undo. TRANSPOSE
 * is now the only control that moves the key, at any speed, and the two compose.
 * `qa/speed-pitch.mjs` holds it at ±2 cents.
 *
 * THE STEP IS A MUSICAL INTERVAL, NOT A PERCENTAGE, and that survives the
 * reversal — but for a smaller reason than it used to have. 2 % steps across a
 * 4x range would be ~70 presses end to end; nudge buttons cannot carry that, and
 * the fix is not a second widget. A third of a semitone near home (which
 * DISPLAYS as the 2 % grid the sync-correction note in embed.js argues about)
 * and a whole semitone outside it gives ~29 rungs with a usable feel at both
 * ends. What it is NO LONGER for is composing with TRANSPOSE: under varispeed
 * each rung was a pitch the user could cancel by hand, and the geometric spacing
 * made that arithmetic exact. Nothing is transposed now, so the ladder's ratios
 * are a STEP SIZE and not an interval anyone hears. Do not re-derive a musical
 * meaning from this array.
 *
 * THERE IS NO STEP CONSTANT, BECAUSE THE STEP IS NOT CONSTANT. `SPEED_M` is the
 * specification. A `SPEED_STEP` with zone rules would be three numbers and a
 * branch expressing what one frozen array states outright — and a constant can
 * be wrong, where an array is what it is.
 */
const SPEED_M = Object.freeze([
  ...[-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1].map((s) => s * 3),
  -2, -1, 0, 1, 2,
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => s * 3),
]);

/**
 * The 29 rungs, as rates. Exponents in THIRTY-SIXTHS OF AN OCTAVE, so a whole
 * semitone is 3 and the ends are 2**-1 and 2**1 — EXACTLY 0.5 and 2.0, by
 * construction and not by rounding.
 */
export const SPEED_RATES = Object.freeze(SPEED_M.map((m) => 2 ** (m / 36)));
/**
 * DERIVED FROM THE LADDER'S ENDS, never declared. A separately-declared bound
 * can disagree with the array; these cannot. The 2.00x ceiling is structural in
 * exactly this sense: `stepSpeed()` can only return a rung, so there is no
 * arithmetic path in this file that produces the 2.05x that stalls YouTube's
 * own buffer. (`speed.js` clamps independently, at the last gate before
 * the element — two gates on one number, one grid and one guard rail.)
 */
export const SPEED_MIN = SPEED_RATES[0];
export const SPEED_MAX = SPEED_RATES[SPEED_RATES.length - 1];
export const SPEED_HOME = 1;

/**
 * Rates are compared with a tolerance and never with `===`, because the value
 * this file is handed has been through `video.playbackRate` and a message
 * channel. 1e-9 is far below the closest two rungs (1.9 % apart) and far above
 * double rounding, so it can only ever mean "the same rung".
 */
const RATE_EPS = 1e-9;
/** Same idea in semitones, for the ±6 boundary: 12*log2(2**(6/12)) is 6.000000000000002. */
const SEMI_EPS = 1e-9;

/** @returns {number} index of the rung `r` IS, or -1 when it is off the grid. */
const rungIndex = (r) => {
  for (let i = 0; i < SPEED_RATES.length; i++) if (Math.abs(SPEED_RATES[i] - r) <= RATE_EPS) return i;
  return -1;
};
const readableRate = (r) => typeof r === 'number' && Number.isFinite(r) && r > 0;

/**
 * THE NEAREST RUNG. ENTRY POINT: a rate arriving from somewhere that is not our
 * buttons — the Shift branch's halve/double, and any value that has to be put
 * back on the grid.
 *
 * NEAREST IN LOG SPACE, because the ladder is geometric: the nearest rung to a
 * rate is the nearest INTERVAL, not the nearest ratio difference. Linear
 * nearest would bias every snap upward, by more the further from home it is.
 *
 * IT IS NOT `stepSpeed`, AND THE TWO MUST NEVER BE COLLAPSED: a button using
 * "nearest" can move the value backwards, or not at all, which is a control that
 * visibly does nothing when pressed. Different entry points, different question.
 *
 * @param {number} r
 * @returns {number} a ladder rate; SPEED_HOME for anything unreadable — a NaN
 *   written to `playbackRate` throws in Blink and the element must never see one.
 */
export function snapSpeed(r) {
  if (!readableRate(r)) return SPEED_HOME;
  let best = SPEED_RATES[0];
  let bestD = Infinity;
  for (const v of SPEED_RATES) {
    const d = Math.abs(Math.log2(v / r));
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/**
 * ONE PRESS. ENTRY POINT: the two nudge buttons, `#sp-dn` and `#sp-up`, and
 * nothing else.
 *
 * STRICTLY DIRECTIONAL. The rate on screen is the ELEMENT'S, and YouTube's own
 * slider reaches it in 0.05 steps from 0.25x — so off-grid values are a normal
 * state, not an error. A press must move the value the way it was pushed and
 * land it back on the grid; "nearest" would sometimes move it the other way.
 *
 * THE END STOP AND THE OUT-OF-RANGE CASE ARE ONE MECHANISM: with no rung in the
 * requested direction the input is returned UNCHANGED, which is also what
 * disables the button. Two facts, one line, so they cannot disagree.
 *
 * `coarse` is the Shift branch — halve or double, snapped back onto the ladder,
 * clamped by the ladder's own ends. When that lands on the rung we are already
 * on (at either end) it falls back to the single step, so Shift can never move
 * the value backwards either.
 *
 * @param {number} r current rate
 * @param {number} dir -1 or +1
 * @param {boolean} [coarse] Shift held
 * @returns {number} a ladder rate, or `r` unchanged when there is none that way
 */
export function stepSpeed(r, dir, coarse = false) {
  // A step from a rate we cannot read is a step to the one rate that is always
  // safe. Returning `r` here would hand NaN straight back to the caller.
  if (!readableRate(r)) return SPEED_HOME;
  const up = dir > 0;
  if (coarse) {
    const snapped = snapSpeed(up ? r * 2 : r / 2);
    if (up ? snapped > r + RATE_EPS : snapped < r - RATE_EPS) return snapped;
    return stepSpeed(r, dir, false);
  }
  if (up) {
    for (const v of SPEED_RATES) if (v > r + RATE_EPS) return v;
    return r;
  }
  for (let i = SPEED_RATES.length - 1; i >= 0; i--) if (SPEED_RATES[i] < r - RATE_EPS) return SPEED_RATES[i];
  return r;
}

/**
 * FAR FROM 1.00x — far enough that the stems' roughness is worth disclosing?
 *
 * WHAT THIS USED TO MEAN, AND WHY IT CHANGED (2026-08-17). Under varispeed
 * this function answered "is there still a remedy?": the rate transposed the
 * audio, TRANSPOSE could put the key back inside ±6 semitones, and past that
 * the shifter had no ratio left. That question no longer exists — the rate
 * transposes nothing and there is nothing to put back.
 *
 * WHAT IT MEANS NOW is one thing only: the element phase-vocodes at every rate
 * off 1.00x, so the separator meets smeared material and the stems come back
 * rougher the further you push. That cost is REAL AT EVERY NON-UNITY RATE and it
 * grows continuously — there is no cliff in the physics — so this threshold is a
 * DISCLOSURE JUDGEMENT about when it is worth a sentence, not a boundary in the
 * signal. It must keep meaning "you pushed it" and never "you used the feature"
 * (CONTRIBUTING.md settles that for the clip indicator; the same logic governs here),
 * which is why it is silent at 0.75x and speaks at 0.63x.
 *
 * ponytail: THE NUMBER IS STILL SPELLED `SEMITONE_MIN`/`SEMITONE_MAX` AND THAT
 * IS NOW A COINCIDENCE, NOT A DERIVATION. Those constants are TRANSPOSE's clamp
 * and are pinned to `engine/pitch.js` at the foot of this file, which is still
 * correct FOR TRANSPOSE — but nothing ties the shifter's reach to where speed
 * roughness deserves a warning any more. Ceiling: widening `pitch.js` to ±7
 * would silently move this disclosure line, which is the entry-point family
 * again — one constant, right for one caller, coincidental for the other.
 * Upgrade path: give this its own `SPEED_FAR_M` (in the ladder's thirty-sixths,
 * so it is the array's unit) and drop the borrow. Held rather than done because
 * the VALUE is ratified behaviour — silent at 0.75x, speaking at 0.63x — and
 * changing where the number lives is a separate change from changing what it is.
 *
 * IT IS SYMMETRIC IN THE LADDER'S OWN UNIT even though it looks lopsided in
 * percent: 0.707x and 1.414x are the same distance from home in ratio, and
 * percent is not the axis. That is why `semitones` still comes back — it is the
 * RUNG COORDINATE, the array's exponent over three, and it is not a pitch
 * anybody hears. Callers must not print it as one.
 *
 * @param {number} r
 * @returns {{far:boolean, semitones:number|null}} `semitones` is null off the grid
 */
export function speedFar(r) {
  if (!readableRate(r)) return { far: false, semitones: null };
  const d = 12 * Math.log2(r);
  const i = rungIndex(r);
  return {
    far: d > SEMITONE_MAX + SEMI_EPS || d < SEMITONE_MIN - SEMI_EPS,
    // From the ladder's own exponent, not from the log: a third of a semitone
    // is 1/3 exactly here and 0.33333333333333326 out of Math.log2, and the
    // whole point of the outer rungs is that they are WHOLE semitones.
    semitones: i < 0 ? null : SPEED_M[i] / 3,
  };
}

/**
 * MAY THE CONTROL ACT RIGHT NOW, AND WHAT DOES IT SAY IF NOT?
 *
 * A GREYED CONTROL WITH A REASON IS CORRECT; A CONTROL THAT MOVES AND DOES
 * NOTHING IS THE BUG. Every refusal here carries a non-empty `text`, because a
 * lockout with no reason is the exact failure this control was shaped to avoid.
 *
 * ANY `state` THAT IS NOT `'ok'` IS A LOCKOUT — enumerated by its ABSENCE, not
 * by a list. `speed.js`'s `speedPlan` owns the states and can grow one;
 * a `switch` here would let the new state fall through to "fine", which is the
 * permissive branch taken precisely when we do not understand what we are
 * looking at. An unknown `why` still greys, and still says the word.
 *
 * `source` is the DECK'S own field (`live.source`), not a payload one — and it
 * is checked anyway, because "we have not been told which kind of deck this is"
 * must not read as "live". A cached deck is playing our stems off disk, so the
 * page's `<video>` is a picture and there is no page rate to drive;
 * `offscreen.js` refuses SPEED on one independently.
 *
 * @param {{state?:string, why?:string, source?:string}} s
 *   `state` and `why` are `speed.js`'s, forwarded by content.js on its
 *   `SPEED` report. `source` is 'live' | 'cache'.
 * @returns {{ok:boolean, why:string|null, text:string}}
 */
export function speedGate(s) {
  const v = s || {};
  const lock = (why) => ({ ok: false, why, text: SPEED_LOCK_TEXT[why] || `Speed is unavailable: ${why}.` });
  if (v.source !== 'live' && v.source !== 'cache') return lock('nodeck');
  if (v.source === 'cache') return lock('cache');
  if (v.state === 'ok') return { ok: true, why: null, text: '' };
  // The transport's own word, in order of specificity, and NEVER an empty one.
  return lock((typeof v.why === 'string' && v.why) || (typeof v.state === 'string' && v.state) || 'unreported');
}

/**
 * The reason, in words, for every lockout this build can reach. It is here and
 * not in embed.js because the assertion that every lockout HAS one has to be
 * able to read it. A `why` with no entry still greys, with the fallback string
 * `speedGate` builds — so a new transport state is legible rather than silent.
 */
const SPEED_LOCK_TEXT = Object.freeze({
  cache: 'Cached play — audio is from disk.',
  missing: 'No video on this page.',
  looking: 'Looking for the video…',
  ad: 'Ad playing — comes back after it.',
  'ad-unknown': 'The page is not saying whether an ad is playing.',
  nodeck: 'This deck has not said what it is playing.',
  unreported: 'The page is not reporting its player.',
});

/**
 * =========================================================================
 * BPM — may we show a number, and is the SOURCE tempo safe to derive?
 * =========================================================================
 *
 * ROWS 5-8 ARE THE SPECIFICATION: every one of them renders an em dash and NOT
 * ONE of them renders a digit. There is no "low-confidence number in grey" —
 * a grey number is read as a number, and the person reading it is about to play
 * along with it. A confident-looking wrong BPM is worse than a blank.
 *
 * `bad` is VISIBLE, for `keyPlan`'s own reason: a view that guarded with
 * `bpm && bpm.bpm` and otherwise drew nothing would look healthy on exactly the
 * runs where the engine sent something wrong. The engine's `fault` state (a tap
 * that threw and is off until the next start, live.js `bpmPayload`) lands here,
 * which is right — the box says so and the payload goes in its title.
 *
 * NOTHING HERE HOLDS A SECOND OPINION ABOUT THE TEMPO. `engine/bpmtap.js` owns
 * the confidence floor and the octave hysteresis and the wire carries the
 * winner, not the candidate set — the same division `keyPlan` documents.
 */

/**
 * THE DETECTOR'S SEARCH RANGE, copied from `engine/bpmtap.js`'s `BPM_MIN` /
 * `BPM_MAX` and pinned to them by the check at the foot of this file. This file
 * may not import at runtime, so the copy is deliberate; what the pin removes is
 * the drift.
 */
export const BPM_SEARCH_MIN = 60;
export const BPM_SEARCH_MAX = 200;

/**
 * THE TEMPO RANGE MUSIC OCCUPIES. These are OURS and they are NOT pinned to the
 * engine, which is the whole point of the pair being named separately: they
 * equal `BPM_SEARCH_MIN`/`MAX` today only because that detector was built for
 * audio at its own rate. Pin both to bpmtap.js and widening the search range
 * would widen the requirement with it, and `bpmSourceSafe()` below could never
 * become true. One pair is a property of the detector; one is a property of
 * music.
 */
export const BPM_MUSIC_MIN = 60;
export const BPM_MUSIC_MAX = 200;

/**
 * MAY `detected / speed` BE RENDERED AT ALL?
 *
 * The speed change is UPSTREAM of the capture tap, so the detector sees the
 * source tempo multiplied by the rate: at 2.00x a 128 BPM track is 256 BPM of
 * audio. `engine/bpmtap.js` searches [60, 200] and does not report when it
 * folded, so out there it silently returns 128 — and `detected / speed` is then
 * wrong by a factor of two with nothing on screen to say so. That is exactly the
 * failure this readout exists to avoid, so THE SOURCE FIGURE IS NOT RENDERED
 * unless the detector's search range covers the whole speed range.
 *
 * THE FOLD IS MEASURED, NOT FEARED (engine, 2026-08-16, at 1 BPM steps through
 * the real ring): whole to 165 and halved from 166 — 165 -> 165.5, 166 -> 83.0 —
 * and it is monotone and stable, 0 flips across 98 estimates with the octave
 * hysteresis in. So the boundary is SHARP, which is what makes this a refusal
 * rather than a caution.
 *
 * IT IS ALSO WHY THERE IS NO PER-TRACK CARVE-OUT. Given a reported D the true
 * played tempo is any of D, 2D (folded down above 166) or D/2 (folded up below
 * the 60 floor), and the only band where two of the three are impossible is
 * D > 166 — reachable solely from a track that is genuinely 166-200 BPM at the
 * rate it is playing. A sliver of coverage, bought with the exact reasoning
 * whose failure mode is a confidently wrong number. The categorical answer is
 * the one the spec asks for and the one that cannot be subtly wrong.
 *
 * IT IS FALSE IN THIS BUILD. It is written as a predicate over the detector's
 * range rather than as `false` so that it becomes true on its own the day the
 * engine widens — [30, 400] is what the 0.50x-2.00x range asks for — and so that
 * the claim has a negative control instead of being a constant nobody can test.
 *
 * @param {number} searchMin @param {number} searchMax the detector's own range
 * @returns {boolean}
 */
/**
 * ponytail: THE BOUND USED HERE IS THE SEARCH WINDOW, AND THE TRUER ONE IS THE
 * MEASURED FOLD BOUNDARY. `bpmtap.js` exports `BPM_MIN`/`BPM_MAX` (60/200) and
 * those are what the pin below ties to; the 166 above is a measurement in that
 * module's own self-check and is not exported, so it cannot be read here without
 * being typed in — which is the thing this whole construction exists to avoid.
 * Ceiling: the predicate is answered against a window slightly WIDER than the
 * range the detector is actually whole over, so it is if anything optimistic —
 * and it still returns false, so nothing on screen depends on the difference.
 * Upgrade path: `engine/bpmtap.js` exports its measured fold boundary (say
 * `BPM_FOLD_MAX`), this file copies and pins it exactly as it does the window,
 * and `bpmSourceSafe` takes that instead.
 */
export function bpmSourceSafe(searchMin, searchMax) {
  return searchMin <= BPM_MUSIC_MIN * SPEED_MIN && searchMax >= BPM_MUSIC_MAX * SPEED_MAX;
}
export const BPM_SOURCE_SAFE = bpmSourceSafe(BPM_SEARCH_MIN, BPM_SEARCH_MAX);

/** The four "I don't know" reasons. Their REMEDIES differ — wait, or do not wait. */
const BPM_WHY = new Set(['silent', 'free', 'ambiguous', 'respeed']);

/**
 * @param {{state?:string, bpm?:number, confidence?:number, beatFrame?:number,
 *          why?:string}|null} b the engine's `bpm` field on LIVE_STATE, or the
 *   UI's own `{state:'unsure', why:'respeed'}` while a speed change is in flight
 * @param {number} speed the ELEMENT'S current rate, so the source is DERIVED at
 *   paint time and never stored — `paintKey`'s double-shift trap, one row over:
 *   store the scaled figure and scale it again and it is wrong by twice the
 *   excursion with nothing on screen to say so
 * @returns {{show:'none'|'listening'|'bpm'|'unsure'|'bad', why:string|null,
 *            bpm:number|null, source:number|null, confidence:number}}
 *   `bpm` is null in every state but `bpm`. `source` is null whenever it must
 *   not be drawn — off the safe range, or identical to the primary at 1.00x.
 */
export function bpmPlan(b, speed) {
  const k = b || null;
  const conf = Number(k && k.confidence) || 0;
  const out = (show, why = null, bpm = null, source = null) => ({ show, why, bpm, source, confidence: conf });
  if (!k) return out('none');
  if (k.state === 'none') return out('none');
  if (k.state === 'listening') return out('listening');
  if (k.state === 'unsure') return BPM_WHY.has(k.why) ? out('unsure', k.why) : out('bad');
  /**
   * THE DETECTOR THREW AND IS LATCHED OFF FOR THE SESSION (live.js
   * `bpmPayload`). It gets the `bad` PRESENTATION — no digit, warn-coloured, the
   * payload in the box's title — and its own sub-reason, because "the detector
   * stopped" and "looked and heard nothing" are different facts and must not
   * render identically.
   */
  if (k.state === 'fault') return out('bad', 'fault');
  /**
   * ...AND ANYTHING ELSE IS `bad` TOO, BY FALLING OFF THE END rather than by
   * being listed. The engine can grow a sixth state; a `switch` with a
   * "everything else is fine" arm is the permissive branch taken precisely when
   * we do not understand what we are looking at.
   */
  if (k.state !== 'locked') return out('bad');

  const n = k.bpm;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return out('bad');
  /**
   * A LOCKED PAYLOAD OWES A BEAT FRAME. `bpmtap.js::payload()` never emits
   * `locked` without one, and it is what `beatPhaseAt` needs — so a locked
   * state that arrives without it is a payload this view cannot read, not a
   * number to render anyway with the pulse quietly switched off.
   */
  if (typeof k.beatFrame !== 'number' || !Number.isFinite(k.beatFrame)) return out('bad');

  /**
   * AN UNREADABLE RATE DROPS THE SOURCE LINE AND NOTHING ELSE, and that is a
   * reason rather than an excuse: the primary number is measured DOWNSTREAM of
   * the rate, off the stems the user is hearing, so it does not depend on it.
   * Only the derivation does.
   */
  const r = readableRate(speed) ? speed : null;
  const home = r !== null && Math.abs(r - 1) <= RATE_EPS;
  const src = BPM_SOURCE_SAFE && r !== null && !home ? Math.round(n / r) : null;
  return out('bpm', null, Math.round(n), src);
}

/** DESIGN §13.8: nothing in the UI flashes faster than this. Not exported: it is
 *  read by `beatPulse` and by nothing else, here or anywhere. */
const MAX_FLASH_HZ = 3;
/** How far the running animation may drift before it is worth re-phasing. At
 *  10 Hz with a ±0.5 BPM estimate this is reached in about ten seconds. */
const BEAT_REPHASE_MS = 40;

/**
 * THE BEAT PULSE, as ONE CSS animation: the period is the beat and the phase is
 * a negative `animation-delay`. It runs on the compositor and JS touches it only
 * when the tempo changes or the phase has drifted — about once per ten seconds,
 * not ten times per second.
 *
 * WHY NOT DRIVE IT FROM THE MESSAGES. The payload arrives at ~10 Hz; a pulse
 * stepped by those samples is a 100 ms-quantised stutter, and a rAF loop is a
 * second animation loop competing with the meters for frames on a machine
 * holding a separation deadline.
 *
 * DESIGN §13.8 — NOTHING IN THE UI FLASHES FASTER THAN 3 Hz. 180 BPM is 3.0 Hz
 * exactly, so `MAX_FLASH_HZ` is expressed as the rate and the comparison is
 * exact at the boundary: 60000/180 and 1000/3 are the same double. Above it the
 * pulse halves, which is also how anyone reads a metronome at that tempo. At
 * 2.00x anything over 90 source BPM crosses 180, so this is the NORMAL reading
 * at the top of the range and not an edge case.
 *
 * IT MUST FAIL WHEN IT CANNOT LOOK. No phase, no bpm, or a phase outside [0,1)
 * returns `run:false` — the dot goes static rather than pulsing at an invented
 * phase. A beat indicator out of time with the music is a confidently wrong
 * signal, which is the one thing this readout refuses to be.
 *
 * @param {{bpm:number|null, phase:number|null, ageMs:number, now:number,
 *          prev:{periodMs:number, offsetMs:number, atMs:number}|null}} s
 *   `phase` is `bpmtap.js::beatPhaseAt()`, 0 on the beat; `ageMs` is how old
 *   the sample was when it arrived (a 10 Hz sample is up to 100 ms old and the
 *   correction is not optional — `audioClockAt`'s argument); `prev` is what was
 *   last written to the element and WHEN, so the drift is measurable.
 * @returns {{run:boolean, periodMs:number, halved:boolean, offsetMs:number, write:boolean}}
 */
export function beatPulse(s) {
  const v = s || {};
  const off = { run: false, periodMs: 0, halved: false, offsetMs: 0, write: false };
  const bpm = v.bpm;
  const phase = v.phase;
  if (!readableRate(bpm)) return off;
  if (typeof phase !== 'number' || !Number.isFinite(phase) || phase < 0 || phase >= 1) return off;
  const age = typeof v.ageMs === 'number' && Number.isFinite(v.ageMs) && v.ageMs >= 0 ? v.ageMs : null;
  if (age === null) return off;

  let periodMs = 60000 / bpm;
  let halved = false;
  while (periodMs < 1000 / MAX_FLASH_HZ) { periodMs *= 2; halved = true; }
  const mod = (x) => ((x % periodMs) + periodMs) % periodMs;
  const offsetMs = mod(phase * periodMs + age);

  const p = v.prev;
  let write = true;
  if (p && p.periodMs === periodMs && Number.isFinite(p.offsetMs) && Number.isFinite(p.atMs)
      && Number.isFinite(v.now)) {
    // Where the running animation IS, against where it should be. Circular,
    // because 1 ms before the beat and 1 ms after it are 2 ms apart, not P-2.
    const d = Math.abs(mod(p.offsetMs + (v.now - p.atMs)) - offsetMs);
    write = Math.min(d, periodMs - d) > BEAT_REPHASE_MS;
  }
  return { run: true, periodMs, halved, offsetMs, write };
}

/**
 * =========================================================================
 * THE KEY READOUT — may we show one, and what may we show?
 * =========================================================================
 *
 * WHAT THIS DOES NOT DO: it does not decide the key, and it does not hold a
 * hysteresis gate. `extension/engine/chroma.js` owns both (`createKeyDisplay`,
 * `DISPLAY_POLICY`) and the engine runs them, because the gate needs the full
 * 24-way `scores` vector to compare a challenger against the INCUMBENT and the
 * wire carries only the winner. A second gate here would be a second opinion
 * about the same signal, on data that cannot support one.
 *
 * What it does own is the one thing a view must never get wrong: WHEN THE
 * PAYLOAD CANNOT BE READ, SAY SO. `displayKey()` throws on a bad tonic, a bad
 * mode or an unknown state — so a view that guards with `key && key.tonic` and
 * otherwise renders nothing would show an empty, healthy-looking readout on
 * precisely the runs where the engine sent something wrong. That is the
 * `!x || (check)` shape AGENTS.md has four logged instances of, one level up in
 * the UI. `bad` is a visible state.
 *
 * @param {{state?:string, concertTonic?:number, mode?:string, confidence?:number}|null} key
 *   the engine's `key` field on LIVE_STATE. ABSENT is not an error: an engine
 *   that has not started has nothing to say about the key.
 * @returns {{show:'none'|'listening'|'key'|'bad', tonic:number,
 *            mode:string|null, confidence:number}}
 */
export function keyPlan(key) {
  const k = key || null;
  const out = (show, tonic = -1, mode = null) => ({
    show, tonic, mode, confidence: Number(k && k.confidence) || 0,
  });
  if (!k) return out('none');
  if (k.state === 'none') return out('none');
  if (k.state === 'listening') return out('listening');
  if (k.state !== 'locked') return out('bad');
  const t = k.concertTonic;
  const okTonic = Number.isInteger(t) && t >= 0 && t <= 11;
  const okMode = k.mode === 'major' || k.mode === 'minor';
  return okTonic && okMode ? out('key', t, k.mode) : out('bad');
}

// ------------------------------------------------------------------- check
async function demo() {
  let fails = 0;
  const eq = (got, want, what) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${what}\n  got  ${g}\n  want ${w}`); fails++; }
    else console.log(`ok   ${what}`);
  };

  // --- follow -------------------------------------------------------------
  const F = (o) => follow({ armed: true, halted: false, status: 'idle', videoPlaying: true, hosted: true, ...o });

  eq(F({}), 'start', 'armed + the video is playing -> start. There is no switch to also press');
  eq(F({ status: 'running' }), 'hold', '...and once running, nothing more to do');
  eq(F({ videoPlaying: false }), 'hold', 'the video is paused and the deck is idle -> stay idle');
  eq(F({ videoPlaying: false, status: 'running' }), 'stop',
    'the user paused the video -> stop, before three seconds of silence become OUTPUT_DEAD');
  eq(F({ videoPlaying: false, status: 'priming' }), 'stop',
    '...and a deck still priming stops too — priming a paused video is the exact defect this replaces');

  /**
   * THE TRI-STATE, both halves. These two are the assertion the defect would
   * have failed: the first one is the boot window, and it used to say 'start'.
   */
  eq(F({ videoPlaying: null, hosted: true }), 'hold',
    'HOSTED and not yet told: WAIT. Starting here captures a paused video and begins a 172 MiB download');
  eq(F({ videoPlaying: null, hosted: false }), 'start',
    '...but with no host to wait for, "armed means run" — an unheard deck must not be a dead one');
  eq(F({ videoPlaying: null, hosted: false, status: 'running' }), 'hold', '...and does not thrash it once running');
  eq(F({ videoPlaying: null, hosted: true, status: 'running' }), 'hold',
    '...and NEITHER host stops a running deck on an unknown signal: a quiet page is not a pause');

  eq(F({ armed: false }), 'hold', 'no source, nothing to start — the video is irrelevant');
  eq(F({ armed: false, status: 'running' }), 'stop', '...but a running deck whose tab went away is stopped');

  /**
   * The retry-loop guard, at both of its entry points. Without it, every 10 Hz
   * status message re-starts a deck the user has not finished reading about.
   */
  eq(F({ status: 'error' }), 'hold', 'an ENGINE error is never auto-restarted');
  eq(F({ halted: true }), 'hold', '...nor a HALT the page latched itself (a failed arm, a capture timeout)');
  eq(F({ halted: true, status: 'running' }), 'stop', '...and latching a halt while running stops it');
  eq(F({ status: 'error', videoPlaying: false }), 'hold', '...on a paused video too');

  eq(follow(undefined), 'hold', 'no state at all does nothing');

  // --- chip ---------------------------------------------------------------
  const C = (o) => chip({
    armed: true, halted: false, status: 'idle', videoPlaying: true,
    passthrough: false, primedPct: 0, modelPct: null, ...o,
  });

  eq(C({ videoPlaying: false }).label, 'Press play',
    'a paused video is told what to press — the control the user HAS, not one we could add');
  eq(C({ videoPlaying: null }).label, 'Ready', '...and with no signal at all it does not invent a paused video');
  eq(C({ status: 'priming', primedPct: 0.4 }).label, 'Priming 40%',
    'priming shows how far, because silence with no explanation is what made this feel broken');
  eq(C({ status: 'priming', modelPct: 12 }).label, 'Model 12%',
    '...and a MODEL wait is named as one: minutes, not seconds');
  eq(C({ status: 'running' }), { kind: 'run', label: 'Live' }, 'running is Live');
  eq(C({ status: 'running', passthrough: true }), { kind: 'warn', label: 'Passthrough' },
    '...but not while the unseparated mix is what you are hearing — the faders are inert there');
  eq(C({ status: 'starving' }).kind, 'warn', 'starving warns');
  eq(C({ status: 'error' }), { kind: 'err', label: 'Stopped' }, 'an engine error reads Stopped');
  eq(C({ halted: true }), { kind: 'err', label: 'Stopped' }, '...and so does a latched halt, identically');
  eq(C({ armed: false }).label, 'Not armed', 'no grant, no deck');
  eq(C({ armed: false, status: 'running' }).label, 'Live',
    '...unless it is still playing — the tab-closed window must not paint a live deck as absent');
  eq(chip(undefined).label, 'Not armed', 'no state at all is "not armed"');

  // --- peakTick -----------------------------------------------------------
  /**
   * ENTRY POINT: the METERS handler in embed.js, one stem, one message. Every
   * case below is stated in the units that handler uses — dBFS on the wire,
   * milliseconds from performance.now().
   */
  const B = { peakHoldMs: 1200, peakFallDbPerS: 20, clipDb: -0.1, clipLatchMs: 2000 };
  const P = (prev, inDb, o) => peakTick(prev, inDb, {
    now: 1000, dtMs: 33, silent: false, floorDb: -60, ballistics: B, ...o,
  });

  eq(P(null, -6).db, -6, 'the first frame IS the peak — a meter that has to charge up under-reads the transient');
  eq(P({ db: -12, holdUntil: 900, clipUntil: 0 }, -3).db, -3, 'a louder frame takes the tick immediately: peak attack is instantaneous');
  eq(P({ db: -12, holdUntil: 900, clipUntil: 0 }, -3).holdUntil, 2200, '...and re-arms the 1200 ms hold from now');
  eq(P({ db: -3, holdUntil: 900, clipUntil: 0 }, -3).holdUntil, 2200,
    'a frame at EXACTLY the held level re-arms it too — a steady tone must not start falling');

  // The hold and the fall, as two separate claims about the same prev state:
  // one inside the window, one outside it.
  eq(P({ db: -3, holdUntil: 1200, clipUntil: 0 }, -30).db, -3,
    'a quieter frame INSIDE the hold window does not move the tick — that is what the hold is');
  eq(P({ db: -3, holdUntil: 900, clipUntil: 0 }, -30, { dtMs: 100 }).db, -5,
    '...and once the window has passed it falls at 20 dB/s: 100 ms of dt is exactly 2 dB');
  // String(), not the value: eq() compares JSON, and JSON.stringify turns
  // -Infinity, Infinity and NaN alike into `null` — so a bare -Infinity claim
  // here would pass on any of the three.
  eq(String(P({ db: -59, holdUntil: 0, clipUntil: 0 }, -Infinity, { dtMs: 100 }).db), '-Infinity',
    '...to -Infinity at the meter floor, not on for ever at 20 dB/s below a trough that reads zero');
  eq(String(P({ db: -Infinity, holdUntil: 0, clipUntil: 0 }, -Infinity).db), '-Infinity',
    'silence in, silence out — and no arithmetic on -Infinity');

  /**
   * MUTE SNAPS. The stem is silent within 18 ms, so a held tick would be
   * showing audio that no longer exists.
   */
  eq(String(P({ db: -3, holdUntil: 5000, clipUntil: 0 }, -3, { silent: true }).db), '-Infinity',
    'a muted or ducked stem snaps to silence mid-hold rather than releasing');
  eq(P({ db: -3, holdUntil: 5000, clipUntil: 4321 }, -Infinity, { silent: true }).clipUntil, 4321,
    '...but the CLIP LATCH survives the mute: muting is often the reaction TO the clip, and clearing it erases the reason');
  eq(P({ db: -20, holdUntil: 0, clipUntil: 0 }, -0.05).clipUntil, 3000,
    'a frame at or above the clip knee latches the indicator for 2 s');
  eq(P({ db: -20, holdUntil: 0, clipUntil: 2500 }, -20).clipUntil, 2500,
    '...and a quiet frame neither sets nor clears it — only time and a click do');

  // --- shortcut -----------------------------------------------------------
  /**
   * TWO ENTRY POINTS, and every case below is stated for BOTH — the capture
   * listener in content.js (which asks `hostKeys()` whether to intercept) and
   * the document listener in embed.js (which asks `shortcut()` what to do).
   * AGENTS.md's entry-point rule: a binding that works on the deck and not on
   * the page is the defect this whole file exists to prevent.
   */
  const K = (o) => shortcut({
    code: 'Digit1', key: '1', shift: false, alt: false, ctrl: false, meta: false,
    repeat: false, typing: false, hasSolo: false, overlayOpen: false, ...o,
  });

  eq(K({}), { act: 'mute', index: 0 }, '1 mutes the FIRST strip — the digits map to the fixed left-to-right order');
  eq(K({ code: 'Digit4' }), { act: 'mute', index: 3 }, '...and 4 the fourth');
  /**
   * THE FIFTH AND SIXTH STRIPS, added 2026-08-17 when the `Digit5`-`Digit8`
   * carve-out was retired. Asserted at the index, not just as "not NO_ACT": the
   * failure this catches is the boundary moving while the MAPPING stays four
   * wide, which would mute `other` when the user pressed `5`.
   */
  eq(K({ code: 'Digit5' }), { act: 'mute', index: 4 }, '...and 5 GUITAR, the fifth strip');
  eq(K({ code: 'Digit6' }), { act: 'mute', index: 5 }, '...and 6 PIANO, the sixth and last');
  eq(K({ shift: true }), { act: 'solo', index: 0 }, 'Shift+1 solos it');
  eq(K({ code: 'Digit6', shift: true }), { act: 'solo', index: 5 },
    '...and the modifiers reach the new digits unchanged: Shift+6 solos piano');
  eq(K({ alt: true }), { act: 'reset', index: 0 }, 'Alt+1 resets that fader to unity');
  eq(K({ code: 'Digit5', alt: true }), { act: 'reset', index: 4 }, '...and Alt+5 guitar\'s');
  eq(K({ alt: true, shift: true }), { act: 'reset', index: 0 }, '...and Alt wins over Shift, as on the console');
  eq(K({ code: 'Numpad2' }), { act: 'mute', index: 1 }, 'the numpad digits are the same six keys');
  eq(K({ code: 'Numpad6' }), { act: 'mute', index: 5 }, '...including the two new ones');
  eq(K({ code: 'Digit0' }), { act: 'unmute-all', index: -1 }, '0 is unmute-all + clear solo');
  eq(K({ code: 'Digit0', shift: true }), { act: 'unmute-all', index: -1 },
    '...and it is 0 with or without a modifier — the panic key must not need a clean press');

  /**
   * THE KEYS THIS BUILD DELIBERATELY DOES NOT TAKE. Asserted rather than
   * omitted, because the failure is somebody porting the console's handler
   * wholesale and taking Space off YouTube's own player.
   *
   * THE LIST IS A CONSTANT so the two directions cannot cover different sets.
   * A key is "not taken" only if BOTH `shortcut()` returns NO_ACT for it AND
   * `hostKeys()` leaves it off the intercept list; either one alone is half a
   * claim. `REPS` below are the seven that carry the REASON in their own prose;
   * `REST` are the nine that carry the COVERAGE. The last assertion in this
   * block requires REPS + REST to BE this list, so adding a key here without
   * asserting it is a red rather than a silent gap — which is exactly how
   * `KeyP` went a whole build with nothing in either direction.
   */
  const NOT_OURS = [
    'Space', 'Digit7', 'Digit8', 'Digit9', 'KeyQ', 'KeyW', 'KeyE',
    'KeyR', 'KeyT', 'KeyY', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH',
    'KeyM', 'KeyP', 'KeyX', 'Backquote', 'BracketLeft', 'BracketRight', 'Backslash',
  ];
  const REPS = ['Digit7', 'Digit9', 'Space', 'KeyQ', 'KeyA', 'Backquote', 'BracketLeft', 'KeyM'];
  eq(K({ code: 'Digit7' }), NO_ACT,
    'THE BOUNDARY: 7 is the first digit past the rack and is NOT a shortcut here — it stays YouTube\'s seek-to-70 %, and this is the assertion that stops the rack widening past its own strip count');
  eq(K({ code: 'Digit9' }), NO_ACT, '...and so does 9, the last of them');
  eq(K({ code: 'KeyA', key: 'a' }), NO_ACT,
    'A S D F G H are the console\'s per-stem SOLO row, added with the sixth stem; this build solos on Shift+1-6 and takes none of them');
  eq(K({ code: 'Space', key: ' ' }), NO_ACT,
    'SPACE IS YOUTUBE\'S. Their transport is the only transport in this build; two play controls on one piece of audio is the defect');
  eq(K({ code: 'KeyQ', key: 'q' }), NO_ACT, 'Q W E R are the assign matrix, which this build does not have');
  eq(K({ code: 'Backquote', key: '`' }), NO_ACT, '` swaps deck focus, and there is one deck');
  eq(K({ code: 'BracketLeft', key: '[' }), NO_ACT, '[ ] \\ are the crossfader, which this build does not have');
  eq(K({ code: 'KeyM', key: 'm' }), NO_ACT, '...and M is the two-deck panic');

  /**
   * ...AND THE REST OF EVERY GROUP, one line each. The seven above carry the
   * REASON; these carry the COVERAGE, and the two are not the same thing — a
   * representative pins its group only for as long as the group is handled by
   * one branch, and `shortcut()` handles these by falling off the end of a
   * regex, which is a different mechanism per key position.
   *
   * KeyP is why this loop exists. It was the one key on ARCHITECTURE §'s
   * not-taken list with NO assertion in either direction — `hostKeys()` never
   * emits it, so the behaviour was right and unpinned, and `P` on the console
   * is re-prime, which on this build would restart the user's audio from a key
   * they pressed for the page.
   */
  const REST = [
    ['KeyP', 'p', 'P is the console\'s re-prime, and restarting the audio is the LAST thing a stray key should do'],
    ['KeyW', 'w', 'W E R T Y finish the Q W E R T Y assign matrix — six keys now, one per stem'],
    ['KeyE', 'e', '...E'],
    ['KeyR', 'r', '...R'],
    ['KeyT', 't', '...T, which is guitar\'s assign key on the console and nothing at all here'],
    ['KeyY', 'y', '...and Y, piano\'s'],
    ['KeyS', 's', 'S D F G H finish the console\'s A S D F G H solo row'],
    ['KeyD', 'd', '...D'],
    ['KeyF', 'f', '...F'],
    ['KeyG', 'g', '...G'],
    ['KeyH', 'h', '...H, which is piano\'s solo key on the console'],
    ['BracketRight', ']', '] finishes [ ] \\, the crossfader nudge'],
    ['Backslash', '\\', '...and \\ is the crossfader slam'],
    ['Digit8', '8', '8 finishes 7-9, the seek digits this rack does not need — YouTube must keep getting them'],
    ['KeyX', 'x', 'X slams the crossfader on the console; there is no crossfader here'],
  ];
  for (const [code, key, why] of REST) eq(K({ code, key }), NO_ACT, `${code} is not ours: ${why}`);

  /**
   * ...AND THE LIST ITSELF IS PINNED. Without this, adding a key to `NOT_OURS`
   * and forgetting the `shortcut()` case would leave the hostKeys assertion
   * below looking complete while nothing checked what the key DOES if the deck
   * has focus. It is the same defect as `KeyP`, one level up.
   */
  eq([...REPS, ...REST.map(([c]) => c)].slice().sort(), NOT_OURS.slice().sort(),
    'every key on the not-taken list has a shortcut() assertion of its own — the list and the coverage are the same set, checked, not assumed');

  /** The guards. Each one is a key we must NOT take, for a different reason. */
  eq(K({ typing: true }), NO_ACT,
    'never while the user is typing — a digit stolen from a half-written YouTube comment is what gets reported as "it ate my comment"');
  eq(K({ ctrl: true }), NO_ACT, '...nor with Ctrl held: that is the browser\'s');
  eq(K({ meta: true }), NO_ACT, '...nor with Cmd held');
  eq(K({ repeat: true }), NO_ACT,
    'autorepeat does NOTHING — holding 1 would flicker the vocal at the OS repeat rate');
  eq(shortcut(undefined), NO_ACT, 'no event at all does nothing');

  // Escape and ?, including the overlay's own two cases.
  eq(K({ code: 'Escape', key: 'Escape' }), NO_ACT,
    'Esc with no solo and no overlay is NOT ours — it exits YouTube\'s full screen and we are a guest here');
  eq(K({ code: 'Escape', key: 'Escape', hasSolo: true }), { act: 'clear-solo', index: -1 },
    '...but with a solo up it is the "get me back to normal" key (DESIGN §11.4)');
  eq(K({ key: '?', code: 'Slash', shift: true }), { act: 'help-open', index: -1 },
    '? opens the shortcut overlay, matched on the CHARACTER — Shift+Slash is only "?" on some layouts');
  eq(K({ key: '?', code: 'Slash', shift: true, overlayOpen: true }), { act: 'help-close', index: -1 },
    '...and closes it again');
  eq(K({ code: 'Escape', key: 'Escape', overlayOpen: true, hasSolo: true }), { act: 'help-close', index: -1 },
    'Esc closes the TOP-MOST overlay first and leaves the solo alone — one press, one effect');
  eq(K({ overlayOpen: true }), NO_ACT,
    'and no other shortcut fires from behind the list of shortcuts');

  // --- hostKeys -----------------------------------------------------------
  /**
   * ENTRY POINT: the capture-phase listener in content.js, which intercepts
   * exactly this list (and `event.key === '?'`) and hands everything else to
   * YouTube untouched. The list is POSTED to the host rather than copied into
   * it — content.js is a classic script in an isolated world and cannot import
   * this file — so these assertions are the only place the two agree.
   */
  const H = (o) => hostKeys({ anySolo: false, overlayOpen: false, ...o });
  eq(H({}).includes('Digit1') && H({}).includes('Digit6'), true, 'the host intercepts 1-6, or YouTube seeks to 10 % instead of muting the vocal');
  eq(H({}).includes('Digit0'), true, '...and 0');
  eq(H({}).includes('Numpad1') && H({}).includes('Numpad6'), true, '...and the numpad row, which is the same six keys to the user');
  eq(H({}).includes('Digit7'), false,
    'it does NOT take 7-9: the rack has six strips, so YouTube\'s seek-to-70 % still works');
  eq(H({}).includes('Space'), false, '...and never Space — that is YouTube\'s play/pause');

  /**
   * THE BOUNDARY AS A COUNT, at both entry points, because the two prose
   * assertions above pin `Digit7` and would go on passing if `Digit8` were
   * taken. The deck has SIX strips and every one of them has a key, on both
   * keyboards (`Digit` and `Numpad`) — so the digit half of the intercept list
   * is 2 * KEYED_STEMS long and nothing else.
   */
  const digitsTaken = H({}).filter((c) => /^(?:Digit|Numpad)[1-9]$/.test(c)).sort();
  eq(digitsTaken,
    ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
      'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6'],
    `the host intercepts exactly ${KEYED_STEMS} digits per keyboard and no more — 7-9 reach YouTube, and that is now the whole of what the page keeps`);
  eq(digitsTaken.length, KEYED_STEMS * 2,
    '...and the count IS KEYED_STEMS, so moving the boundary cannot be done in one place quietly');
  /**
   * ...AND NONE OF THE CONSOLE-ONLY KEYS, as a SET DIFFERENCE rather than three
   * `||`s. Two reasons, and both are AGENTS.md's: an `a || b || c` that is
   * expected to be false names no offender when it goes red, and a three-key
   * sample was not the list — `KeyP` was absent from it, and from every other
   * assertion in the tree, in either direction.
   *
   * Asserted at the WIDEST state the function has (solo up AND overlay open),
   * because `hostKeys()` only ever GROWS with state: a key absent here is
   * absent from every narrower call, so this one entry point covers all four.
   */
  const HW = hostKeys({ anySolo: true, overlayOpen: true });
  eq(NOT_OURS.filter((c) => HW.includes(c)), [],
    'the host intercepts NONE of the console-only keys at its widest state — Space, P, Q W E R, M, X, ` , [ ] \\ and 7-9 all reach YouTube');
  eq(H({}).includes('Escape'), false,
    'ESCAPE IS NOT TAKEN WHEN WE HAVE NOTHING TO DO WITH IT — it exits YouTube\'s full screen, and "the extension broke Escape" reads as a broken page');
  eq(H({ anySolo: true }).includes('Escape'), true, '...but a solo that is up is something to clear, so we take it');
  eq(H({ overlayOpen: true }).includes('Escape'), true, '...and so is our own overlay');
  eq(hostKeys(undefined).includes('Digit1'), true, 'no state at all still names the six digits — the deck is armed or the host never asked');

  // --- stemKeyHint --------------------------------------------------------
  /**
   * ENTRY POINT: `buildStrips()` in embed.js, once per strip at boot. It is the
   * OTHER half of the boundary — `shortcut()` refuses `7`, and this is what
   * stops a strip printing one anyway. A hint the handler does not honour is
   * worse than no hint: the user presses it, YouTube seeks, and the deck is what
   * looks broken.
   */
  eq([0, 1, 2, 3, 4, 5].map(stemKeyHint), ['1', '2', '3', '4', '5', '6'],
    'all six strips print their digit — guitar and piano got 5 and 6 on 2026-08-17 and the rack no longer has a pointer-only strip');
  eq(stemKeyHint(KEYED_STEMS - 1) !== '' && stemKeyHint(KEYED_STEMS) === '', true,
    `...and the boundary is KEYED_STEMS (${KEYED_STEMS}) itself, so the hint and the \`n > KEYED_STEMS\` guard in shortcut() cannot disagree`);
  eq([-1, 1.5, NaN, undefined].map(stemKeyHint), ['', '', '', ''],
    'an index this function cannot read prints no hint rather than a digit off the end of the row');
  /**
   * THE TWO HALVES, JOINED, AND OVER THE WHOLE DIGIT SPACE RATHER THAN OVER THE
   * RACK. Six of six strips are keyed now, so an implication run over indices
   * 0-5 alone would have no case where the hint is empty — every row would be
   * `true === true` and the assertion could only go red in one direction. Run
   * over `1`-`9` it keeps both: 1-6 must print AND act, 7-9 must print NEITHER.
   * That is the difference between a control and a second copy of the
   * measurement (AGENTS.md, "check that the control CAN LOSE"), and it is what
   * catches the two failures that matter — a strip advertising a key YouTube
   * still owns, and a key we honour with nothing on screen to say so.
   */
  eq([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
    const hint = stemKeyHint(i);
    const acts = shortcut({ code: `Digit${i + 1}` }).act === 'mute';
    return (hint !== '') === acts;
  }), [true, true, true, true, true, true, true, true, true],
    'over every digit 1-9: a digit is PRINTED on a strip exactly when pressing it mutes that strip — 1-6 both, 7-9 neither');

  // --- the on-screen overlay ----------------------------------------------
  /**
   * THE THIRD PLACE THE MAP IS WRITTEN DOWN, AND UNTIL NOW THE ONLY UNCHECKED
   * ONE. `shortcut()` is what a key does, `stemKeyHint()` is what a strip
   * prints, and `embed.html`'s `.keytbl` is what the `?` overlay TELLS the user
   * — read by more people than either, gated by nothing. It carried the retired
   * `Digit5`-`Digit8` carve-out in prose for as long as the carve-out lived, and
   * would have gone on carrying it after this commit with no red anywhere.
   *
   * THE CLAIM, and it is the one the code already promises everywhere else: the
   * overlay's KEY COLUMN advertises exactly the digits `shortcut()` acts on. It
   * can lose in both directions — advertise a `7` and the sets differ, widen
   * `KEYED_STEMS` without touching the table and they differ the other way.
   *
   * THE KEY COLUMN ONLY — the first `<td>` of each row. The description column
   * is prose and names YouTube's surviving digits, which is a sentence about
   * somebody else's bindings and not a promise this file may pin.
   *
   * The read is the same shape as the `speed.js` pin at the foot of this file:
   * a file that cannot be read, or a table that cannot be found, is reported as
   * a FAILED COMPARISON and never as an absence. `[]` would otherwise mean
   * "nothing advertised", which is the one answer that must not pass.
   */
  let advertised;
  try {
    const fs = await import('node:fs/promises');
    const html = await fs.readFile(new URL('./embed.html', import.meta.url), 'utf8');
    const tbl = /<table class="keytbl">([\s\S]*?)<\/table>/.exec(html);
    if (!tbl) throw new Error('no <table class="keytbl"> in embed.html');
    const rows = tbl[1].match(/<tr>[\s\S]*?<\/tr>/g) || [];
    if (!rows.length) throw new Error('the keytbl has no rows');
    const digits = new Set();
    for (const row of rows) {
      const td = /<td>([\s\S]*?)<\/td>/.exec(row);
      if (!td) continue;
      for (const m of td[1].matchAll(/<span class="kbd">(\d)<\/span>/g)) digits.add(m[1]);
    }
    advertised = [...digits].sort();
  } catch (e) {
    advertised = [`unreadable: ${e && e.message}`];
  }
  const acted = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
    .filter((d) => shortcut({ code: `Digit${d}` }).act !== 'none');
  eq(advertised, acted,
    'THE OVERLAY IS A DRAWING OF THE HANDLER: the digits embed.html\'s `?` list advertises in its key column ARE the digits shortcut() acts on, so the list cannot teach a binding the handler refuses (or hide one it honours)');

  // --- the key caps, lettered for the keyboard ------------------------------
  /**
   * ENTRY POINT for all of these: `relabel()` in embed.js, which is the ONLY
   * caller of `modLabel()` in the deck, and — for `chordLabel()` — welcome.js's
   * step 2 and the deck's own not-armed hint. `isMac()` is called once at boot
   * on each of those two surfaces, and the deck's one call feeds both.
   *
   * WHY THIS BLOCK EXISTS. The bindings were never broken on a Mac — Option
   * sets `event.altKey` and the digits match on `event.code` — so nothing here
   * asserts behaviour. It asserts that the two SPELLINGS are actually two, and
   * that the overlay never prints a modifier the handler refuses.
   */
  eq(modLabel('alt', true), { text: '⌥', say: 'Option' },
    'ENTRY relabel(mac=true): the alt chip draws Apple\'s glyph and is ANNOUNCED as "Option" — the word printed on the key, which is the half a screen-reader user needs and the glyph alone cannot carry');
  eq(modLabel('alt', false), { text: 'Alt', say: 'Alt' },
    'ENTRY relabel(mac=false): the same chip is the word everywhere else, and it needs no separate accessible name because the text already is one');
  /**
   * THE CONTROL, AND IT CAN LOSE. A table entry that forgot its glyph would
   * render the identical string on both platforms — which is precisely the
   * shipped defect, and it would be invisible to any assertion that only
   * checked the mac branch against a literal. Run over EVERY entry the table
   * has, so a fifth modifier added without a glyph is a red rather than a
   * silent `Alt` on a Mac.
   */
  eq(['alt', 'shift', 'ctrl', 'cmd'].map((m) => (modLabel(m, true) || {}).text !== (modLabel(m, false) || {}).text),
    [true, true, true, true],
    'every modifier this file can spell is spelled DIFFERENTLY on the two platforms — an entry whose glyph was left as the word would draw "Alt" on a Mac and no other assertion here would notice');
  eq(modLabel('meta', true), null,
    'a modifier name this table has never heard of is null, not a plausible-looking blank: relabel() then leaves the markup alone and the pin below reports the typo');

  /**
   * `isMac()`, ALWAYS WITH AN EXPLICIT navigator. Node 24 reports
   * `navigator.platform === 'MacIntel'` on a Mac, so a bare `isMac()` here
   * would be a gate whose verdict is a property of the machine running the
   * suite — the exact failure AGENTS.md's "b" clause names, one instrument
   * over.
   */
  eq(isMac({ userAgentData: { platform: 'macOS' } }), true,
    'ENTRY boot: UA-Client-Hints says macOS, so the deck letters itself for an Apple keyboard');
  eq(isMac({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }), false,
    '...and the HINT WINS over the deprecated navigator.platform when both are present — an implementation that OR-ed the two would letter a Windows machine with ⌥ and this is the only assertion that separates them');
  eq(isMac({ platform: 'MacIntel' }), true,
    '...with no hints available, the deprecated navigator.platform is the fallback and still answers correctly');
  eq(isMac({ platform: 'Win32' }), false, '...and answers correctly the other way');
  eq(isMac({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true,
    '...and with neither, the user-agent string is the last resort');
  eq(isMac({}), false,
    'a navigator that says nothing at all letters the deck with WORDS — the correct spelling on every platform but one, so the default is the majority case rather than a shrug');

  /**
   * THE CHORD IN WELCOME.HTML STEP 2, and the SIGHTED half of it was never
   * broken: Chrome hands `getAll()` back already drawn as `⌃⇧9` on macOS —
   * measured through the real extension by tools/embed-smoke.mjs, which is what
   * corrected this block's first version. The work here is the announced half
   * and the manifest-token form the other platforms use.
   */
  eq(chordLabel('⌃⇧9', true), { text: '⌃⇧9', say: 'Control Shift 9' },
    'ENTRY welcome.js step 2 and the deck\'s not-armed hint: the glyph form Chrome actually returns on macOS is left exactly as it is on screen and given "Control Shift 9" to be ANNOUNCED as — read out character by character it is not an instruction');
  eq(chordLabel('MacCtrl+Shift+9', true), { text: '⌃⇧9', say: 'Control Shift 9' },
    '...and the MANIFEST TOKEN form reaches the same two strings, so a Chrome that hands back what the manifest declared does not put the word "MacCtrl" — a key no keyboard is printed with — into step 2');
  eq(chordLabel('Ctrl+Shift+9', false), { text: 'Ctrl+Shift+9', say: 'Ctrl+Shift+9' },
    '...and off a Mac the accelerator is already the instruction, so what is drawn is unchanged AND it is what is announced — the two strings are one string, which is how welcome.js AND paintArmHint() both know to leave the accessible name off — one branch, asserted once, made by two callers');
  /**
   * THE PLATFORM QUESTION, WHICH IS THE ONE BOTH CALLERS ACTUALLY ASK. welcome.js
   * and the deck's `paintArmHint()` each branch on `chord.say !== chord.text` to
   * decide whether to set `role="img"` and an `aria-label`, so this pair IS that
   * branch, evaluated: it must be true where the chord is drawn in glyphs and
   * false where it is drawn in words.
   *
   * IT WAS TRUE ON BOTH FOR THE LIFE OF THE FUNCTION, because `say` was joined
   * with a space while `text` was joined with `'+'` — so every multi-key chord
   * on every non-Mac machine got `role="img"` and an accessible name, replacing
   * text a screen reader could already read with a graphic. tools/embed-smoke's
   * "the chord is ANNOUNCED in words when it is DRAWN in glyphs" assertion
   * catches it in the real extension, but that one needs a browser and CI runs
   * `--quick`, so the regression has to be catchable here too.
   *
   * BOTH COLUMNS, BECAUSE EITHER ALONE IS SATISFIABLE BY A CONSTANT. An
   * implementation that returned `say === text` always passes the second column
   * and fails the first; the shipped one passed the first and failed the second.
   * Three chords, so the claim is about the JOIN and not about one literal —
   * and `Alt+Shift+K` carries no digit and no Ctrl, so it cannot pass on the
   * manifest's own chord being special-cased.
   */
  const chordSplits = (a, mac) => { const c = chordLabel(a, mac); return c.say !== c.text; };
  eq(['Ctrl+Shift+9', 'Alt+Shift+K', 'MacCtrl+Shift+F9'].map((a) => [chordSplits(a, true), chordSplits(a, false)]),
    [[true, false], [true, false], [true, false]],
    'ENTRY welcome.js step 2 and the deck\'s not-armed hint: a chord is ANNOUNCED differently from how it is DRAWN exactly when the platform draws GLYPHS, which is the whole of welcome.js\'s role="img" test — a say that differs off a Mac as well suppresses the visible text and buys nothing');
  eq(chordLabel('Command+Shift+9', true).text, '⌘⇧9',
    '...a user who rebinds the chord onto ⌘ gets ⌘, not the manifest\'s ⌃: the string is READ, never assumed');
  /**
   * THE ONE ANSWER THE TWO CALLERS DO DIFFERENT THINGS WITH, which is why it is
   * the one most worth naming both of them on. welcome.js prints a sentence
   * telling the user where to set a chord; the deck keeps `armChord` null and
   * prints the toolbar-icon instruction with no key cap after it.
   *
   * AND IT IS THE ONE THE BROWSER GATE CANNOT REACH. `tools/embed-smoke.mjs`
   * drives a real Chrome with the manifest's suggested key bound, and there is
   * no API that unbinds a command — so the deck's no-chord fallback is gated
   * HERE and nowhere else. Read that as scope, not as coverage: this line pins
   * the value the fallback keys on, not the sentence it prints.
   */
  eq([chordLabel('', true), chordLabel(undefined, true), chordLabel(null, false)], [null, null, null],
    'ENTRY welcome.js step 2 and the deck\'s not-armed hint: no chord bound is NULL rather than an empty key cap — welcome.js prints "set one at chrome://extensions/shortcuts", and the deck leaves `armChord` null and falls back to the toolbar-icon sentence alone, which is the one case where the two callers do DIFFERENT things with the same answer');

  /**
   * THE MODIFIER HALF OF THE OVERLAY PIN, and the same shape as the digit pin
   * above: a file that cannot be read, or a document with no `data-mod` in it
   * at all, is a FAILED COMPARISON and never an absence.
   *
   * THE WHOLE FILE, not the key column — `relabel()` walks the whole document
   * with `querySelectorAll('[data-mod]')`, so the pin's scope is the applier's
   * scope. (The digit pin is key-column-only because a bare "7" in prose is a
   * sentence about YouTube's bindings; `data-mod` is an authored claim about
   * ours and is unambiguous wherever it appears.)
   *
   * THE CLAIM: the modifiers embed.html prints are exactly the modifiers that
   * give a stem digit a DIFFERENT meaning in `shortcut()`. `ctrl` and `meta`
   * are refused at the top of that function, and a modifier it does not read at
   * all leaves the digit meaning what it meant — both of which are excluded,
   * so the set is {alt, shift} from the handler's side and from the markup's.
   * It can lose in both directions: add a `data-mod="ctrl"` row and it goes red
   * against a modifier the handler throws away; delete the reset row and it
   * goes red against a binding the user is no longer told about. If a future
   * binding does take a third modifier, teaching `shortcut()` about it is what
   * this pin requires, which is the point.
   */
  let printedMods, unwired;
  try {
    const fs = await import('node:fs/promises');
    const html = await fs.readFile(new URL('./embed.html', import.meta.url), 'utf8');
    const found = [...html.matchAll(/data-mod="([^"]*)"/g)].map((m) => m[1]);
    if (!found.length) throw new Error('embed.html has no data-mod chips at all');
    printedMods = [...new Set(found)].sort();
    /**
     * THE PER-CHIP CHECK, because the set above is blind to ONE chip of four
     * losing its attribute — the other three keep `shift` in the set and the
     * pin stays green while that cap says "Alt" beside three that say "⌥".
     * Found by breaking it on purpose; it is the only breakage of the ten that
     * the set-pin could not see.
     */
    const WORD = { Alt: 'alt', Shift: 'shift', Ctrl: 'ctrl', Cmd: 'cmd' };
    const chips = [...html.matchAll(/<span class="kbd"([^>]*)>([^<]*)<\/span>/g)];
    if (!chips.length) throw new Error('embed.html has no <span class="kbd"> chips at all');
    unwired = chips
      .filter((m) => WORD[m[2].trim()] && !m[1].includes(`data-mod="${WORD[m[2].trim()]}"`))
      .map((m) => m[0]);
  } catch (e) {
    printedMods = [`unreadable: ${e && e.message}`];
    unwired = [`unreadable: ${e && e.message}`];
  }
  const plain = shortcut({ code: 'Digit1' }).act;
  const readMods = ['alt', 'shift', 'ctrl', 'cmd'].filter((m) => {
    const r = shortcut({ code: 'Digit1', [m]: true });
    return r.act !== 'none' && r.act !== plain;
  });
  eq(printedMods, readMods,
    'EVERY MODIFIER THE OVERLAY PRINTS IS ONE THE HANDLER READS: the `data-mod` chips in embed.html are exactly the modifiers that change what a stem digit does in shortcut(), so the deck cannot advertise a chord it throws away — nor hide one it honours');
  eq(printedMods.map((m) => modLabel(m, true) !== null), [true, true],
    '...and each of those chips has a spelling for BOTH keyboards, which is what stops relabel() silently leaving the word "Alt" on a Mac');
  eq(unwired, [],
    '...and NO key cap spelling a modifier is left unwired: every <span class="kbd"> whose text is Alt/Shift/Ctrl/Cmd carries the matching data-mod, so one chip of four cannot be missed and sit there saying "Alt" beside three that say "⌥"');

  // --- clampSemitones -----------------------------------------------------
  /** ENTRY POINT: the transpose control in embed.js, immediately before the
   *  `{ type: 'PITCH', deck, semitones }` message it posts to the engine. NOT
   *  `{ t: 'pitch' }` — that is the worklet's internal shape, one hop further
   *  down, and this comment named it for a whole batch after the UI->engine
   *  wire was moved onto the `type`/`deck` convention every other message uses.
   *  The engine ships ratios for exactly the 13 integers in [-6, +6]. */
  eq(clampSemitones(0), 0, 'zero is zero — the home position, and the only one that is not a shift');
  eq(clampSemitones(6), 6, 'the top of the range is +6');
  eq(clampSemitones(7), 6, '...and one past it clamps rather than wrapping to -5, which would be a tritone the user did not ask for');
  eq(clampSemitones(-7), -6, '...both ends');
  eq(clampSemitones(2.6), 3, 'a fractional value rounds to a semitone: the shifter has no ratio for 2.6');
  eq(clampSemitones(NaN), 0, 'and anything unreadable is the home position, never a silent shift');

  /**
   * THE RANGE IS THE ENGINE'S, AND THIS IS THE ONLY THING HOLDING THE TWO
   * COPIES TOGETHER.
   *
   * `clampSemitones` clamps to [SEMITONE_MIN, SEMITONE_MAX] before the message
   * is built, and `offscreen.js` refuses anything outside
   * [PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES] after it arrives. That is two
   * copies of one range, and this file may not import at RUNTIME — it is loaded
   * in the deck frame, where pulling in a 1300-line DSP module for two integers
   * is not a trade anyone would make — so the copy is deliberate and cannot be
   * removed. What this pins is the DRIFT:
   *
   *   - engine widens, UI does not  -> the user cannot reach a range the
   *                                    shifter ships ratios for
   *   - UI widens, engine does not  -> the UI sends a value the engine REFUSES,
   *                                    the deck silently stays where it was, and
   *                                    the readout says something else. That
   *                                    refusal path is meant to be unreachable
   *                                    by construction; this is the construction.
   *
   * The import is DYNAMIC and inside the check, so the shipped module still has
   * no imports (build-embed.mjs's import-graph walk only scans line-initial
   * `import`, and the path above resolves in the source tree, not the build).
   * A failure to load it is reported as a FAILED comparison rather than swallowed
   * — an assertion that cannot look must not pass.
   */
  let PITCH;
  try {
    PITCH = await import('../../extension/engine/pitch.js');
  } catch (e) {
    PITCH = { PITCH_MIN_SEMITONES: `unreadable: ${e && e.message}`, PITCH_MAX_SEMITONES: null };
  }
  eq([SEMITONE_MIN, SEMITONE_MAX], [PITCH.PITCH_MIN_SEMITONES, PITCH.PITCH_MAX_SEMITONES],
    'the UI\'s clamp range IS the engine\'s PITCH_MIN/MAX_SEMITONES — two copies of one range, and a drift between them makes the engine\'s refusal path reachable from the UI');

  // --- keyPlan ------------------------------------------------------------
  /**
   * ENTRY POINT: the LIVE_STATE handler in embed.js, one `key` field per
   * message. The engine sends CONCERT TONIC ONLY; the shift and the horn are
   * applied by chroma.js's `displayKey` at the single call site in embed.js.
   * Nothing here shifts anything — storing a shifted tonic and shifting it
   * again is the double-count chroma.js's header names.
   */
  eq(keyPlan(null).show, 'none', 'an engine that has said nothing about the key gets no readout — absence is not a failure');
  eq(keyPlan({ state: 'none' }).show, 'none', '...and neither is an explicit "no key here"');
  eq(keyPlan({ state: 'listening' }).show, 'listening',
    'the first ~8 s are LISTENING and say so — chroma.js DISPLAY_POLICY.minListenSec, and an early guess costs the user\'s trust in the whole feature');
  eq(keyPlan({ state: 'listening', concertTonic: 6, mode: 'minor' }).show, 'listening',
    '...even when a tonic is already attached: the engine\'s state is the gate, not the presence of a number');
  eq(keyPlan({ state: 'locked', concertTonic: 6, mode: 'minor', confidence: 0.2 }),
    { show: 'key', tonic: 6, mode: 'minor', confidence: 0.2 },
    'a locked key is shown, and the tonic is passed through UNSHIFTED for displayKey to compose');
  eq(keyPlan({ state: 'locked', concertTonic: 0, mode: 'major' }).tonic, 0,
    '...including tonic 0, which a falsy test would drop');

  /**
   * THE PAYLOAD WE CANNOT READ. `displayKey` throws on every one of these, so a
   * view that quietly rendered nothing would look HEALTHY on exactly the runs
   * where the engine sent something wrong — the `!x || (check)` shape, one
   * level up in the UI.
   */
  eq(keyPlan({ state: 'locked', concertTonic: 12, mode: 'major' }).show, 'bad',
    'a tonic outside 0-11 is a VISIBLE failure, not an empty readout');
  eq(keyPlan({ state: 'locked', concertTonic: 6, mode: 'dorian' }).show, 'bad', '...and so is a mode displayKey cannot spell');
  eq(keyPlan({ state: 'locked', concertTonic: 6.5, mode: 'minor' }).show, 'bad', '...and a fractional tonic');
  eq(keyPlan({ state: 'locked', mode: 'minor' }).show, 'bad', '...and a locked state with no tonic at all');
  eq(keyPlan({ state: 'settled', concertTonic: 6, mode: 'minor' }).show, 'bad',
    'an unknown state is a payload this build does not understand, and it says so rather than showing the tonic anyway');

  // --- SPEED: the ladder ---------------------------------------------------
  /**
   * THE ARRAY IS THE SPECIFICATION, so the assertion has to be about the array's
   * PROPERTIES and it has to be able to REJECT a wrong one. `ladderVerdict`
   * returns the names of the properties a candidate ladder fails; three wrong
   * ladders are run through the same function below, and each is rejected by a
   * NAMED subset. Without those three this is a description of whatever array
   * happens to be there — "a control that cannot distinguish the hypothesis from
   * its negation is not a control" (AGENTS.md).
   */
  const ladderVerdict = (rates) => {
    const bad = [];
    const st = rates.map((r) => 12 * Math.log2(r));
    const whole = (x) => Math.abs(x - Math.round(x)) <= 1e-9;
    const inFine = (x) => Math.abs(x) <= 1 + 1e-9;
    if (rates.length !== 29) bad.push('twenty-nine-rungs');
    if (!rates.every((v, i) => i === 0 || v > rates[i - 1])) bad.push('strictly-increasing');
    // `===`, not a tolerance: 0.4999 is a rate, and 2.0001 is a stalled video.
    if (!(rates[0] === 0.5 && rates[rates.length - 1] === 2)) bad.push('ends-on-the-octave');
    if (!rates.includes(1)) bad.push('contains-home');
    if (new Set(rates.map((r) => r.toFixed(2))).size !== rates.length) bad.push('distinct-labels');
    if (rates.filter((r, i) => inFine(st[i])).map((r) => r.toFixed(2)).join(' ')
        !== '0.94 0.96 0.98 1.00 1.02 1.04 1.06') bad.push('fine-band-is-the-two-percent-grid');
    if (!st.every((x) => inFine(x) || whole(x))) bad.push('whole-semitones-outside-the-fine-band');
    return bad;
  };

  eq(ladderVerdict([...SPEED_RATES]), [],
    'THE LADDER: 29 rungs, strictly increasing, ends on 0.5 and 2.0 by ===, contains 1, 29 distinct labels, the fine band prints the 2 % grid, and every rung outside it is a whole semitone');

  /**
   * ...AND THE SAME FUNCTION REJECTING THREE WRONG LADDERS, which is the half
   * that makes the assertion above mean anything. The first is the subtle one:
   * a uniform geometric ladder of the same LENGTH across the same RANGE agrees
   * on five of the seven properties and is rejected by exactly the two that
   * carry the design.
   */
  const uniformSpan = Array.from({ length: 29 }, (_, i) => 0.5 * 4 ** (i / 28));
  eq(ladderVerdict(uniformSpan), ['fine-band-is-the-two-percent-grid', 'whole-semitones-outside-the-fine-band'],
    'CONTROL: a UNIFORM 29-rung ladder over the same range passes length, order, ends and home — and is rejected on the two properties that are the control (a 5.08 % step is neither the 2 % grid nor a semitone)');
  const uniform2pct = Array.from({ length: 29 }, (_, i) => 0.5 * 1.02 ** i);
  eq(ladderVerdict(uniform2pct),
    ['ends-on-the-octave', 'contains-home', 'fine-band-is-the-two-percent-grid', 'whole-semitones-outside-the-fine-band'],
    'CONTROL: the SPEED_STEP = 0.02 ladder revision 1 specified reaches 0.87x in 29 presses — rejected on four properties at once, and it is the one somebody will try to bring back');
  const shortOfTwo = [...SPEED_RATES.slice(0, 28), 1.98];
  eq(ladderVerdict(shortOfTwo), ['ends-on-the-octave', 'whole-semitones-outside-the-fine-band'],
    'CONTROL: a ladder ending on 1.98 instead of 2.0 is rejected — the ceiling is structural, and "nearly 2" is a rung stepSpeed could hand the element for ever');

  eq([SPEED_MIN, SPEED_MAX, SPEED_HOME], [0.5, 2, 1],
    'SPEED_MIN and SPEED_MAX are READ OFF the ladder\'s ends rather than declared, so a declared bound cannot disagree with the array');

  // --- snapSpeed -----------------------------------------------------------
  /** ENTRY POINT: the Shift branch, and any rate that has to be put back on the grid. */
  eq(snapSpeed(1), 1, 'snapSpeed: home is already a rung');
  eq(+snapSpeed(1.75).toFixed(4), 1.7818,
    'snapSpeed: NEAREST IN LOG SPACE — the ladder is geometric, so the nearest rung to a rate is the nearest interval; linear nearest would bias every snap upward');
  eq(snapSpeed(4), 2, 'snapSpeed: above the ceiling the nearest rung IS the ceiling, so there is no separate clamp to forget');
  eq(snapSpeed(0.1), 0.5, '...and below the floor, the floor');
  eq([snapSpeed(NaN), snapSpeed(undefined), snapSpeed('1.5'), snapSpeed(0), snapSpeed(-1)], [1, 1, 1, 1, 1],
    'snapSpeed: EVERY unreadable value is home. A NaN written to playbackRate throws in Blink and the element must never see one, and a string is a broken sender rather than a rate');

  // --- stepSpeed -----------------------------------------------------------
  /**
   * ENTRY POINT: the two nudge buttons, `#sp-dn` and `#sp-up`. Every case below
   * is stated for a press, which is the only caller — `snapSpeed` is the other
   * function and it answers a different question, at a different entry point.
   */
  eq([stepSpeed(1, 1).toFixed(2), stepSpeed(1, -1).toFixed(2)], ['1.02', '0.98'],
    'one press from home is the 2 % grid AS DISPLAYED, which is the claim the microcopy makes — asserting the raw 1.0194 would assert the arithmetic and not the claim');

  eq(SPEED_RATES.map((r, i) => stepSpeed(r, 1) === (i + 1 < SPEED_RATES.length ? SPEED_RATES[i + 1] : r)),
    SPEED_RATES.map(() => true),
    'from every rung a press up lands on the ADJACENT rung — and from the top rung it returns the rate unchanged, which is the same fact as the button being disabled');
  eq(SPEED_RATES.map((r, i) => stepSpeed(r, -1) === (i > 0 ? SPEED_RATES[i - 1] : r)),
    SPEED_RATES.map(() => true), '...and the same downward, with the end stop at the floor');

  eq(SPEED_RATES.flatMap((r) => [[r, stepSpeed(r, 1)], [r, stepSpeed(r, -1)]])
    .filter(([a, b]) => a !== b && a.toFixed(2) === b.toFixed(2))
    .map(([a, b]) => `${a.toFixed(4)}->${b.toFixed(4)}`), [],
    'every press that MOVES the rate also moves the LABEL — a ladder refined until two rungs print the same string is a control that visibly does nothing when pressed');

  /** OFF GRID. YouTube's own slider is 0.05 steps from 0.25x, so this is normal. */
  eq(+stepSpeed(1.75, 1).toFixed(4), 1.7818,
    'off grid, up: the first rung STRICTLY ABOVE, never the nearest — "nearest" from 1.75 is 1.7818 here but would be BELOW at 1.79, which is a press that moves the value backwards');
  eq(+stepSpeed(1.75, -1).toFixed(4), 1.6818, '...and off grid, down: the first rung strictly below');
  eq([stepSpeed(1.7818, 1) > 1.7818, stepSpeed(1.7818, -1) < 1.7818], [true, true],
    '...and a rate that IS a rung to within float noise still steps off it rather than returning itself');

  /** OUT OF RANGE. The end stop and this are ONE mechanism, or one of them is untested. */
  eq(stepSpeed(0.25, 1), 0.5, 'out of range below: 0.25x is reachable from YouTube\'s menu, and a press up climbs back onto the floor rung');
  eq(stepSpeed(0.25, -1), 0.25, '...and a press down returns the rate UNCHANGED, which is the same line that disables the button at the floor');
  eq(stepSpeed(2.5, 1), 2.5, 'out of range above: nothing is offered past the ceiling, so the rate comes back unchanged');
  eq(stepSpeed(2.5, -1), 2, '...and a press down lands on the ceiling rung, back on the grid');
  eq([stepSpeed(SPEED_MAX, 1), stepSpeed(SPEED_MIN, -1)], [2, 0.5],
    'the two end stops, by ===: there is no arithmetic path in this file that produces 2.05x');

  /** COARSE — the Shift branch, the one-press gesture the range was widened for. */
  eq([stepSpeed(1, 1, true), stepSpeed(1, -1, true)], [2, 0.5],
    'Shift from home is ONE press to the ceiling or the floor, and it is exactly 2.0 and 0.5 by ===');
  const coarseFrom = [...SPEED_RATES, 0.62, 1.75, 1.33333];
  const onLadder = (v) => SPEED_RATES.some((x) => Math.abs(x - v) <= 1e-9);
  eq(coarseFrom.flatMap((r) => [[r, 1], [r, -1]])
    .map(([r, d]) => [r, d, stepSpeed(r, d, true)])
    .filter(([, , v]) => !onLadder(v) || v < 0.5 || v > 2)
    .map(([r, d, v]) => `${r.toFixed(4)}${d > 0 ? '+' : '-'}=>${v}`), [],
    'Shift from any rung OR any in-range off-grid rate lands ON a rung and inside the range — never off one, never outside it');
  eq(coarseFrom.flatMap((r) => [[r, 1], [r, -1]])
    .map(([r, d]) => [r, d, stepSpeed(r, d, true)])
    .filter(([r, d, v]) => (d > 0 ? v < r : v > r))
    .map(([r, d, v]) => `${r.toFixed(4)}${d > 0 ? '+' : '-'}=>${v}`), [],
    '...and Shift never moves the rate BACKWARDS: where doubling would overshoot the ladder it falls back to the single step rather than snapping the wrong way');
  eq([stepSpeed(2, 1, true), stepSpeed(0.5, -1, true)], [2, 0.5],
    'Shift AT an end stop returns the rate unchanged, exactly as the single step does — one mechanism, both gestures');

  eq([stepSpeed(NaN, 1), stepSpeed(undefined, -1), stepSpeed('1.5', 1, true)], [1, 1, 1],
    'a press from a rate this file cannot read goes HOME — returning the input would hand NaN straight to playbackRate, and 1.00x is the one rate that is always safe');

  // --- speedFar ------------------------------------------------------------
  /**
   * ENTRY POINT: `paintSpeed()` in embed.js, once per repaint, on the rate the
   * ELEMENT reports.
   *
   * RE-GROUNDED 2026-08-17 with the key-lock reversal. These assertions used to
   * encode the VARISPEED composition claim — "0.75x is a fourth down and
   * TRANSPOSE can undo it", "the fine rungs do not compose". The code stopped
   * promising any of that the moment `driveRate()` began key-locking the
   * element, and AGENTS.md calls an assertion demanding an invariant the code
   * never promised the single most-repeated failure in this repo's history. So
   * each one below is either re-aimed at what the code DOES promise, or gone.
   *
   * The two boundary pairs still test a real coupling — `speedFar` genuinely
   * reads SEMITONE_MIN/MAX — but read the `ponytail:` on `speedFar`: that
   * coupling is now COINCIDENTAL. These are the assertions that would go red if
   * someone widened pitch.js and silently moved this disclosure line with it,
   * which is the reason to keep them pointed at the constant rather than at 6.
   */
  eq(speedFar(2 ** (SEMITONE_MAX / 12)).far, false,
    'EXACTLY at the threshold it is still silent — the boundary is inclusive on the quiet side, so the rung that sits on it does not warn');
  eq(speedFar(2 ** ((SEMITONE_MAX + 1) / 12)).far, true,
    '...and one rung past it, it speaks');
  eq(speedFar(2 ** (SEMITONE_MIN / 12)).far, false, 'the same at the bottom, because the threshold is symmetric in the ladder\'s own unit');
  eq(speedFar(2 ** ((SEMITONE_MIN - 1) / 12)).far, true, '...and one rung below it');

  /**
   * THE "YOU PUSHED IT" LAW, and it is the half of this function the ruling
   * ratified rather than the number behind it. A warning that fires in the
   * normal case teaches the user to ignore it — CONTRIBUTING.md settles that for the
   * clip indicator and the same logic governs here.
   */
  eq([1.10, 1.25, 2 ** (-5 / 12)].map((r) => speedFar(r).far), [false, false, false],
    'IT DOES NOT NAG: the everyday rates — 1.10x, 1.25x and 0.75x, the one a learner actually reaches for — are all SILENT');
  eq([0.5, 2 ** (-7 / 12), 2 ** (7 / 12), 2].map((r) => speedFar(r).far), [true, true, true, true],
    '...and it fires at 0.50x, 0.63x, 1.50x and 2.00x — "you pushed it", never "you used the feature"');
  eq([speedFar(2 ** (7 / 12)).semitones, speedFar(2 ** (-5 / 12)).semitones], [7, -5],
    'THE RUNG COORDINATE IS SIGNED AND SYMMETRIC — it is the array exponent over three, used to tell an on-grid rate from an off-grid one, and it is NOT a pitch: nothing prints it as an interval any more');

  /**
   * WRITTEN THIS WAY BECAUSE THE OBVIOUS VERSION CANNOT FAIL, and it was written
   * first. `filter(r => speedFar(r).semitones === null)` over SPEED_RATES asks
   * whether every member of an array can be found IN THAT ARRAY — `rungIndex`
   * searches SPEED_RATES itself, so it answers yes for whatever the rates are.
   * Vacuous by construction, and no perturbation of the rungs can make it red.
   *
   * The ROUND TRIP is the version with content: the coordinate must rebuild the
   * rate it came from, which is false the moment `rungIndex` hands back an index
   * that did not produce `r`. Multiplying one rung by 1.003 turns it red (with
   * THE LADDER and the symmetry check beside it), observed before it was kept.
   *
   * A NOTE ON HOW THAT WAS OBSERVED, because it cost two runs: the foot of this
   * file gates `demo()` on `argv[1]` ending in `embed-state.js`, so a break test
   * run against a RENAMED COPY executes nothing and exits 0 — which reads
   * exactly like "the assertion did not notice". Patch this file in place and
   * restore it; a copy under another name is an instrument that cannot look.
   */
  eq(SPEED_RATES.filter((r) => Math.abs(2 ** (speedFar(r).semitones / 12) - r) > 1e-12)
    .map((r) => r.toFixed(4)), [],
    'THE RUNG COORDINATE REBUILDS ITS OWN RATE, all 29, to 1e-12 — SPEED_M and SPEED_RATES cannot drift apart unnoticed, and `semitones` is the value paintSpeed branches on to tell "our button set this" from "YouTube\'s menu did"');
  eq(SPEED_RATES.filter((r) => !Number.isInteger(speedFar(r).semitones)).map((r) => r.toFixed(2)),
    ['0.96', '0.98', '1.02', '1.04'],
    'THE FINE BAND IS FOUR RUNGS AND THEY ARE THIRDS — kept because the ladder is still non-uniform and paintSpeed still branches on it; the claim it used to carry, that thirds "do not compose with TRANSPOSE", died with varispeed and is not restated');

  eq(speedFar(1.75), { far: true, semitones: null },
    'an OFF-GRID rate still gets the verdict and gets NO semitone figure — the disclosure is about the rate, the composition hint is about a rung');
  eq(speedFar(NaN), { far: false, semitones: null },
    'a rate this function cannot read makes NO CLAIM in either direction: the warning is a statement about a known rate, and an unknown one is greyed by speedGate before it reaches here');

  // --- speedGate -----------------------------------------------------------
  /**
   * ENTRY POINT: `paintSpeed()` in embed.js, on `speed.js`'s report as
   * content.js forwards it. Every lockout must carry a REASON — a control that
   * moves and does nothing is the bug this one exists to avoid.
   */
  const G = (o) => speedGate({ state: 'ok', why: null, source: 'live', ...o });
  eq(G({}), { ok: true, why: null, text: '' }, 'a live deck with a healthy player is the only state in which the buttons act');
  eq(G({ state: 'missing', why: 'missing' }).text, 'No video on this page.',
    'no element -> greyed, and the reason is the sentence, not a title nobody hovers');
  eq(G({ state: 'ad', why: 'ad' }).text, 'Ad playing — comes back after it.',
    'an ad plays through the same element and YouTube resets the rate between items, so the control greys and comes back');
  eq(G({ state: 'looking', why: 'looking' }).ok, false, 'inside the find window it is a WAIT, and a wait is still greyed rather than acting into nothing');
  eq(G({ source: 'cache' }), { ok: false, why: 'cache', text: 'Cached play — audio is from disk.' },
    'a CACHED deck refuses even with a perfectly healthy player: the video is a picture and there is no page rate to drive — and it outranks state:ok, or the buttons would act on it');

  eq(G({ state: 'buffering', why: 'buffering' }),
    { ok: false, why: 'buffering', text: 'Speed is unavailable: buffering.' },
    'A STATE THIS BUILD HAS NEVER HEARD OF GREYS AND SAYS THE WORD. The gate is written as "anything that is not ok", so a state speed.js grows later cannot fall through to "fine"');

  eq(speedGate({ source: 'live' }), { ok: false, why: 'unreported', text: 'The page is not reporting its player.' },
    'A MISSING state is the failure, not an excuse from it: we have not been told there is a player, and reading that as "there is one" is the `!x || (check)` shape in its UI form');
  eq(speedGate({}).ok, false, 'no report at all is greyed');
  eq(speedGate(undefined).ok, false, '...and so is no argument at all');
  eq(speedGate({ state: 'ok', why: null }).why, 'nodeck',
    'a deck that has not said whether it is live or cached is greyed too — `source` is ours, and "we have not looked" must not read as "live"');

  eq([{}, undefined, { source: 'live' }, { source: 'cache', state: 'ok' }, { source: 'x' },
    { source: 'live', state: 'missing', why: 'missing' }, { source: 'live', state: 'ad', why: 'ad' },
    { source: 'live', state: 'looking', why: 'looking' }, { source: 'live', state: 'unknown', why: 'ad-unknown' },
    { source: 'live', state: 'wat', why: '' }, { source: 'live', state: '', why: '' }]
    .map(speedGate).filter((g) => !g.ok && !(typeof g.text === 'string' && g.text.length > 0)), [],
    'EVERY refusal this build can reach carries a NON-EMPTY reason — assert the string, or a "reason" can be silently undefined and the control is greyed for nothing anyone can read');

  // --- bpmPlan -------------------------------------------------------------
  /**
   * ENTRY POINT: the LIVE_STATE handler in embed.js, one `bpm` field per
   * message, plus the UI's own `{state:'unsure', why:'respeed'}` while a speed
   * change is in flight. The engine owns the confidence floor and the octave
   * hysteresis; nothing here holds a second opinion about the tempo.
   */
  eq(bpmPlan(null, 1).show, 'none', 'an engine that has said nothing about the tempo gets no readout — absence is not a failure');
  eq(bpmPlan({ state: 'none' }, 1).show, 'none', '...and neither is an explicit "no tempo here"');
  eq(bpmPlan({ state: 'listening', confidence: 0.1 }, 1).show, 'listening',
    'the first window is LISTENING and says so, because an early guess costs the user\'s trust in the whole readout');
  eq(bpmPlan({ state: 'locked', bpm: 128.4, confidence: 0.7, beatFrame: 44100 }, 1),
    { show: 'bpm', why: null, bpm: 128, source: null, confidence: 0.7 },
    'a locked tempo renders as an INTEGER: there is no sync and no beat grid, so the tenth is not actionable and a tenth on a 10 s estimate advertises a precision the detector does not have');
  eq(bpmPlan({ state: 'locked', bpm: 127.6, confidence: 0.7, beatFrame: 0 }, 1).bpm, 128,
    '...and it ROUNDS rather than truncating, which is also what makes the live region legal: a payload jittering 127.6/128.4 rewrites nothing');

  /**
   * ROWS 5-8. Every one renders an em dash and NOT ONE renders a digit. The four
   * reasons are separate because their REMEDIES differ — wait (silent, free,
   * respeed) against do not wait (ambiguous) — and they share one appearance so
   * the box has one look for "I don't know".
   */
  eq(['silent', 'free', 'ambiguous', 'respeed'].map((why) => bpmPlan({ state: 'unsure', why }, 1))
    .map((p) => `${p.show}/${p.why}/${p.bpm}`),
    ['unsure/silent/null', 'unsure/free/null', 'unsure/ambiguous/null', 'unsure/respeed/null'],
    'the four "I don\'t know" states each keep their own reason and each carry NO number');
  eq(bpmPlan({ state: 'unsure', why: 'because' }, 1).show, 'bad',
    'an unsure reason this build does not know is a payload it cannot read, not a fifth microcopy string');

  const NOT_LOCKED = [
    null, { state: 'none' }, { state: 'listening' },
    { state: 'unsure', why: 'silent' }, { state: 'unsure', why: 'free' },
    { state: 'unsure', why: 'ambiguous' }, { state: 'unsure', why: 'respeed' },
    { state: 'locked', bpm: null, beatFrame: 0 }, { state: 'locked', bpm: 128 },
    { state: 'fault', bpm: null, beatFrame: null }, { state: 'settled', bpm: 128, beatFrame: 0 },
  ];
  eq(NOT_LOCKED.map((b) => bpmPlan(b, 2)).filter((p) => /[0-9]/.test(String(p.bpm)) || /[0-9]/.test(String(p.source))), [],
    'NO NON-LOCKED STATE EVER CARRIES A DIGIT, in either slot and at any speed. A grey number is read as a number, and the person reading it is about to play along with it');

  eq(bpmPlan({ state: 'locked', bpm: null, beatFrame: 0 }, 1).show, 'bad',
    'a LOCKED payload with a null bpm is unreadable, not renderable — this is the shape a view that guarded with `bpm && bpm.bpm` would have drawn as an empty healthy box');
  eq([NaN, 0, -120, '128'].map((bpm) => bpmPlan({ state: 'locked', bpm, beatFrame: 0 }, 1).show),
    ['bad', 'bad', 'bad', 'bad'], '...and so is a non-finite, zero, negative or stringly tempo');
  eq(bpmPlan({ state: 'locked', bpm: 128 }, 1).show, 'bad',
    'a locked payload with NO beatFrame is unreadable too — bpmtap never emits one, and rendering the number with the pulse quietly switched off would hide the payload that did');
  eq(bpmPlan({ state: 'fault', bpm: null, confidence: 0, beatFrame: null, fault: 'tick: boom' }, 1),
    { show: 'bad', why: 'fault', bpm: null, source: null, confidence: 0 },
    'the engine\'s FAULT state — a tap that threw and is latched off for the session — takes the `bad` PRESENTATION and keeps its own sub-reason: "the detector stopped" and "looked and heard nothing" are different facts and must not render identically');
  eq(bpmPlan({ state: 'settled', bpm: 128, beatFrame: 0 }, 1), { show: 'bad', why: null, bpm: null, source: null, confidence: 0 },
    'a SIXTH state the engine grows later is `bad` by falling off the end rather than by being listed — the fall-through is the refusal, so an unknown state can never read as "fine"');

  /**
   * THE SOURCE TEMPO. `bpmSourceSafe` is the whole of the decision and it has a
   * negative control, because the constant it produces today is `false` and a
   * bare `eq(BPM_SOURCE_SAFE, false)` would pass just as happily if the
   * predicate had been replaced by the literal.
   */
  eq(BPM_SOURCE_SAFE, false,
    'THE SOURCE TEMPO IS NOT DERIVABLE IN THIS BUILD. bpmtap.js searches 60-200 BPM and does not report an octave fold, so at 2.00x a 128 BPM track reads 256, folds to 128, and `detected / speed` is wrong by a factor of two with nothing on screen to say so');
  eq([bpmSourceSafe(60, 200), bpmSourceSafe(30, 400), bpmSourceSafe(30, 399), bpmSourceSafe(31, 400)],
    [false, true, false, false],
    'CONTROL: the predicate is a real test of the detector\'s range — [30, 400] is what 0.50x-2.00x asks for, and it goes true there and nowhere short of it, so widening the engine turns this readout on without another edit');
  eq(bpmPlan({ state: 'locked', bpm: 256, confidence: 0.8, beatFrame: 0 }, 2).source, null,
    '...so at 2.00x the source line is NOT DRAWN, which is the spec\'s precondition honoured rather than a wrong number rendered confidently');
  eq(bpmPlan({ state: 'locked', bpm: 128, confidence: 0.8, beatFrame: 0 }, 1).source, null,
    'and at home it is not drawn either, for the OTHER reason — it would be the primary number printed twice (the key readout\'s `dup`)');
  eq(bpmPlan({ state: 'locked', bpm: 128, confidence: 0.8, beatFrame: 0 }, NaN),
    { show: 'bpm', why: null, bpm: 128, source: null, confidence: 0.8 },
    'a rate this view cannot read drops the SOURCE line and nothing else — the primary number is measured downstream of the rate, off the stems the user is hearing, so it does not depend on it');

  // --- beatPulse -----------------------------------------------------------
  /**
   * ENTRY POINT: the LIVE_STATE handler in embed.js, once per message, writing
   * `--beat-ms` / `--beat-off` on `#bpm-pulse`. The pulse is ONE CSS animation
   * on the compositor; this decides its period, its phase, and — the half that
   * keeps it off the main thread — whether anything needs writing at all.
   */
  const BP = (o) => beatPulse({ bpm: 120, phase: 0, ageMs: 0, now: 1000, prev: null, ...o });
  eq(BP({}), { run: true, periodMs: 500, halved: false, offsetMs: 0, write: true },
    '120 BPM is a 500 ms period, on the beat, and the first write always happens');
  eq(BP({ phase: 0.5 }).offsetMs, 250, 'the phase is a NEGATIVE animation-delay: half a beat in is half a period of delay');
  eq(BP({ phase: 0.5, ageMs: 100 }).offsetMs, 350,
    'and the SAMPLE\'S AGE is added, because a 10 Hz sample is up to 100 ms old by the time it is painted and the correction is not optional');
  eq(BP({ phase: 0.9, ageMs: 100 }).offsetMs, 50, '...wrapping round the period rather than running past it');

  /** DESIGN §13.8. 180 BPM is 3.0 Hz exactly, and the comparison is exact there. */
  eq([BP({ bpm: 180 }).halved, +BP({ bpm: 180 }).periodMs.toFixed(4)], [false, 333.3333],
    'AT 180 BPM the pulse is 3 Hz exactly and does NOT halve — 60000/180 and 1000/3 are the same double, so the boundary is exact rather than fudged');
  eq([BP({ bpm: 181 }).halved, +BP({ bpm: 181 }).periodMs.toFixed(2)], [true, 662.98],
    '...and one BPM above it halves, which is also how anyone reads a metronome at that tempo');
  eq([BP({ bpm: 400 }).halved, BP({ bpm: 400 }).periodMs], [true, 600],
    'a 400 BPM reading — a 200 BPM track at 2.00x — halves ONCE to 600 ms, and this is the NORMAL branch at the top of the speed range, not cold code');

  eq([BP({ phase: null }), BP({ bpm: null }), BP({ phase: 1 }), BP({ phase: -0.01 }),
    BP({ phase: NaN }), BP({ ageMs: undefined }), beatPulse(undefined)]
    .map((p) => `${p.run}${p.write}`), ['falsefalse', 'falsefalse', 'falsefalse', 'falsefalse', 'falsefalse', 'falsefalse', 'falsefalse'],
    'NO PHASE, NO PULSE, AND NOTHING WRITTEN. A beat indicator out of time with the music is a confidently wrong signal, which is the one thing this readout refuses to be — so a missing field stops it rather than being read as phase zero');

  /** THE RE-PHASE, which is what keeps this at ~0.1 Hz instead of 10 Hz. */
  eq(BP({ prev: { periodMs: 500, offsetMs: 0, atMs: 1000 } }).write, false,
    'a running animation already in phase is LEFT ALONE — at 10 Hz this is the branch every message but one lands on');
  eq(BP({ now: 1010, prev: { periodMs: 500, offsetMs: 0, atMs: 1000 } }).write, false,
    '...and 10 ms of drift is still left alone, under the 40 ms threshold');
  eq(BP({ now: 1100, prev: { periodMs: 500, offsetMs: 0, atMs: 1000 } }).write, true,
    '...and 100 ms of drift is re-phased, which at a ±0.5 BPM estimate is about once per ten seconds');
  eq(BP({ now: 1495, prev: { periodMs: 500, offsetMs: 0, atMs: 1000 } }).write, false,
    'the drift is CIRCULAR: 5 ms before the beat is 5 ms away from it, not 495 — a linear comparison would re-write the animation on every message just before each beat');
  eq(BP({ bpm: 121, prev: { periodMs: 500, offsetMs: 0, atMs: 1000 } }).write, true,
    'a TEMPO change always re-writes, whatever the phase says: the period is what changed and the delay means nothing against the old one');

  // --- the two pins --------------------------------------------------------
  /**
   * TRANSPOSE'S CLAMP IS THE ENGINE'S RANGE. SEMITONE_MIN/MAX are pinned to
   * pitch.js's PITCH_MIN/MAX_SEMITONES by the clampSemitones block above, so a
   * UI that let the user ask for a ratio the shifter does not have is a red
   * rather than a discovery. That link is real and it is unaffected by the
   * key-lock reversal — TRANSPOSE still drives pitch.js and still clamps to it.
   *
   * THE SECOND LINK IS GONE AS A JUSTIFICATION. This block used to read "the
   * fidelity threshold IS the engine's range", chaining speedFar's boundary onto
   * the same constants. Under varispeed that was causal: past the shifter's
   * reach the user could no longer undo the rate's transposition. Under key lock
   * the rate transposes nothing, so speedFar's threshold is a disclosure
   * judgement that merely happens to be spelled with these constants — see the
   * `ponytail:` on speedFar. Do not read the pin below as evidence for it.
   *
   * THE DETECTOR'S SEARCH RANGE IS PINNED THE SAME WAY. Same dynamic import,
   * same reason it cannot be a static one, same rule that a failure to load is
   * reported as a FAILED comparison rather than swallowed.
   */
  let BPMTAP;
  try {
    BPMTAP = await import('../../extension/engine/bpmtap.js');
  } catch (e) {
    BPMTAP = { BPM_MIN: `unreadable: ${e && e.message}`, BPM_MAX: null };
  }
  eq([BPM_SEARCH_MIN, BPM_SEARCH_MAX], [BPMTAP.BPM_MIN, BPMTAP.BPM_MAX],
    'the range this file believes the detector searches IS bpmtap.js\'s BPM_MIN/BPM_MAX — widen the detector and BPM_SOURCE_SAFE has to be re-answered here, which is the point');

  /**
   * ...AND THE LADDER'S ENDS ARE `speed.js`'s CLAMP. Two gates on one
   * number and they must agree about where the range is: the deck's ladder
   * decides what the user can ASK for, speed.js's clamp decides what the element
   * can BE GIVEN, and a disagreement is a button that visibly moves the readout
   * to a rate the page silently refuses.
   *
   * READ AS TEXT, not imported: `speed.js` is a classic content script
   * with top-level `var`s and no exports, so an import gives an empty namespace.
   * A regex over two `var` lines is the only pin available; a failure to find
   * them is reported as a failed comparison, never as an absence.
   */
  let SPEEDJS;
  try {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(new URL('../speed.js', import.meta.url), 'utf8');
    const grab = (name) => {
      const m = new RegExp(`^var ${name} = ([0-9.]+);`, 'm').exec(src);
      return m ? Number(m[1]) : `not found in speed.js: var ${name}`;
    };
    SPEEDJS = [grab('SPEED_MIN'), grab('SPEED_MAX')];
  } catch (e) {
    SPEEDJS = [`unreadable: ${e && e.message}`, null];
  }
  eq([SPEED_MIN, SPEED_MAX], SPEEDJS,
    'the ladder\'s ENDS are speed.js\'s clamp — the grid and the guard rail are two copies of one range, and a ladder that reached past the clamp would move the readout to a rate the page refuses');


  process.exitCode = fails ? 1 : 0;
  console.log(fails ? `\n${fails} FAILED` : '\nembed-state: all checks passed');
}

if (typeof process !== 'undefined' && Array.isArray(process.argv)
    && String(process.argv[1] || '').endsWith('embed-state.js')) demo();
