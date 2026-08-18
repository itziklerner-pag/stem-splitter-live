/**
 * The only thing that runs in the YouTube page: it puts the deck there, and
 * takes it away again. It is not the deck.
 *
 * WHY AN IFRAME AND NOT REAL PAGE DOM. The deck needs `chrome.runtime`,
 * ES modules, and the design tokens — a content script has the first, cannot
 * `import` the second without dynamic-import gymnastics, and would have to fight
 * YouTube's stylesheet for the third. A `web_accessible_resources` iframe is an
 * extension page with full extension privileges, its own CSS scope, and zero
 * chance of colliding with the host page. It is the lazy answer AND the correct
 * one, which is rare enough to write down.
 *
 * L1, PRECISELY. A content script on a video page is exactly where a ripper
 * would live, so the line has to be stated in terms of what this file actually
 * does rather than as a slogan.
 *
 * It reads THREE numbers off the page's `<video>` element — `paused`,
 * `currentTime` and `duration` — and listens for the events that change them.
 * **That is transport state, not media.** It never reads `src`, `currentSrc`,
 * `buffered`, `srcObject` or any URL; never calls `captureStream()`; never
 * touches a byte of audio or video; and never executes in the page's JavaScript
 * world (a content script has its own). Audio still arrives only through
 * `chrome.tabCapture`, in the offscreen document, exactly as before.
 *
 * `paused` buys the whole live feature: press play on YouTube and the deck
 * starts itself. Without it the deck had to be started by hand, and starting it
 * before pressing play fed the engine three seconds of digital silence and
 * raised OUTPUT_DEAD — an error message where an obvious behaviour belonged.
 *
 * ---------------------------------------------------------------------------
 * IT NOW WRITES, TOO, AND ONLY IN CACHED PLAYBACK. This file used to say "never
 * calls play() or pause() — the user's transport stays the user's", and that
 * line is deliberately gone rather than quietly falsified. Under cached playback
 * the deck drives `muted`, `currentTime` and `playbackRate` on this element, per
 * `syncCorrection` in `ui/audio-math.js`.
 *
 * WHY THAT IS SOUND HERE AND WAS NOT BEFORE. In live mode the video is the
 * SOURCE of the audio being captured, so every correction moves both sides of
 * the error — seeking back re-captures the same span, `playbackRate` scales both
 * sides, and pausing to catch up deadlocks. A cached deck is not capturing
 * anything, so the video is a display device and nothing else.
 *
 * ---------------------------------------------------------------------------
 * IT NOW PRESSES TWO OF THE USER'S CONTROLS TOO. This file used to close with
 * "it still never calls `play()` or `pause()` … what it corrects is WHERE the
 * picture is, never WHETHER it is running." That line is deleted rather than
 * quietly falsified, the same way the transport line above it was. What is true
 * now:
 *
 *   - **`pause()` on `ended`, and only on `ended`** — belt and braces under the
 *     autoplay-next suppression at the foot of this file. It cannot shorten a
 *     capture, because by then `ended` has already fired and the stem cache's
 *     commit gate (`shared/stemcache.js` `commitRefusal`: `page.ended`, and the
 *     capture within 6 s of the page's duration) is already satisfied. Pausing
 *     EARLY — at `duration − ε` — would also stop autonav, and would turn every
 *     first-play prime into a discarded one. It is rejected for that reason and
 *     must not come back.
 *   - **`.click()` on YouTube's own autoplay-next toggle**, and on the end
 *     screen's cancel button behind it. Both are YouTube's controls, pressed the
 *     way the user would press them, and both are put back on the way out.
 *
 * `play()` is still never called. Starting is the user's, always.
 *
 * **L1 is untouched by either.** A button press and a pause are transport and
 * preference; neither reads a URL, a buffer, or a sample.
 */

/**
 * Height for the first frame only — the deck measures itself and says so as soon
 * as it has laid out (embed.js `reportHeight`), and every later change comes
 * over the same channel.
 *
 * IT IS A GUESS AND IT GOES STALE EVERY TIME THE DECK GROWS. It read 212 with
 * the comment "so the correction is invisible in the common case" long after the
 * vertical mixer had taken the deck to 309, which is a 97 px jump on every mount
 * described in the source as invisible — and while the first HEIGHT message can
 * be LOST (see the re-report loop in embed.js), it was also 97 px of the deck
 * simply missing, because this frame never scrolls.
 *
 * 425 is measured: `tools/embed-smoke.mjs` asserts the frame and the deck's own
 * `scrollHeight` agree to within a pixel and prints both, so the number above
 * and the number below cannot silently part company again.
 */
const INITIAL_H = 425;
const ID = 'stem-splitter-live-deck';

/** Only the deck's own origin may be posted to. */
const DECK_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;

let frame = null;

/**
 * WHERE THE DECK GOES. Directly under the player and above the title, which is
 * where YouTube's own player-adjacent chrome lives, so the page reflows the way
 * the user already expects rather than covering anything.
 *
 * `#below` is the block holding title, channel row and description; it has been
 * stable across YouTube's layout churn for years, but it is still THEIR markup
 * and it will move eventually.
 *
 * ponytail: ceiling — if that anchor disappears the deck lands at the bottom of
 * the page, which is usable but not what was designed. Upgrade path: pin it to
 * the player element instead (`#movie_player`), which is the one id YouTube
 * genuinely cannot rename, and position it absolutely against that.
 */
function anchor() {
  const below = document.querySelector('#primary-inner > #below, ytd-watch-flexy #below');
  if (below && below.parentNode) return { parent: below.parentNode, before: below };
  const player = document.querySelector('#player');
  if (player && player.parentNode) return { parent: player.parentNode, before: player.nextSibling };
  return { parent: document.body, before: null };
}

function mount() {
  if (frame && frame.isConnected) return frame;
  if (!frame) {
    frame = document.createElement('iframe');
    frame.id = ID;
    /**
     * THE FRAME'S ACCESSIBLE NAME, stated where the platform actually reads it.
     * The whole product lives inside this one element, so it needs a name; with
     * no `title` attribute the name falls back to the embedded document's
     * <title>, and that fallback varies by assistive tech. This is not a second
     * claim on top of embed.html's <title> — it is the same claim, made in the
     * place that does not depend on a fallback. Keep the two in step.
     */
    frame.title = 'Stem Splitter Live stem deck';
    frame.src = chrome.runtime.getURL('ui/embed.html');
    frame.allow = '';
    frame.setAttribute('scrolling', 'no');
    frame.style.cssText = [
      'display:block', 'width:100%', `height:${INITIAL_H}px`, 'border:0',
      'border-radius:12px', 'margin:12px 0', 'background:#0a0b0e',
      'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'color-scheme:dark',
      /**
       * THE DECK MUST BE PAINTED OVER BY NOTHING, and until this line it was.
       *
       * YouTube's ambient mode ("cinematic lighting", dark theme only) draws the
       * blurred glow of the current frame on two <canvas>es inside a
       * `position: relative` div in `#player`, and that div is INFLATED far past
       * the player's own box so the blur has room: measured on a real watch page
       * at 1728x1000, the player was 678 px tall and the glow box was
       * -842..514 x -285..1522 — 339 px BELOW the player and 301 px past each
       * side. The deck sits 12 px below the player, so 327 px of it — the whole
       * header and the whole rack — was underneath that box.
       *
       * A static iframe loses to it on paint order alone: CSS 2.1 Appendix E
       * paints in-flow non-positioned block boxes in step 4 and positioned
       * descendants with `z-index: auto` in step 8. Nothing about the glow is
       * wrong; our box simply had no claim on the pixels.
       *
       * `pointer-events: none` on the glow is why this was invisible to every
       * instrument we had: `document.elementFromPoint()` over the deck answers
       * `iframe#stem-splitter-live-deck` at every sample point WHILE the deck is
       * completely covered, and every assertion inside the frame — geometry,
       * computed style, `boundingBox()` — is measuring a document that is laid
       * out perfectly and simply not on screen. It took a screenshot of the HOST
       * PAGE to see it, which is what tools/embed-smoke.mjs now takes.
       *
       * `z-index: 1`, not more: YouTube's own menus, tooltips and dialogs sit at
       * 2000+ and must keep winning — this has to beat one `z-index: auto`
       * sibling subtree, and beating more than that is how an in-page panel
       * starts covering the page it is a guest on.
       */
      'position:relative', 'z-index:1',
    ].join(';');
  }
  // WE NEVER TOUCH THE PAGE'S <head>: not its favicon, not its <title>. The
  // tab stays YouTube's tab. Anything the user sees change up there — the mute
  // glyph, the capture indicator — is Chrome's own, and it is the direct cost
  // of holding the tabCapture track (ARCHITECTURE R5). Do not add a
  // `link[rel=icon]` here to "fix" it: it would not be a fix, and it would make
  // an audio tool start editing the page's identity.
  const { parent, before } = anchor();
  parent.insertBefore(frame, before);
  watchVideo();
  // The deck is up, so this tab's autoplay-next preference is ours to impose.
  // Nothing before this point touches it: a content script that runs on every
  // YouTube page must not change how the site behaves for a user who never
  // opened the deck.
  setAutonavEngaged(true);
  // Same argument one control over: the deck is up, so it is owed an answer
  // about whether there is an element to drive — including the answer "there is
  // not". A control greyed with a reason beats a control that does nothing.
  openSpeedWindow('poll');
  return frame;
}

// ------------------------------------------------------- follow the player
/**
 * `play` and `pause` are what the deck follows. The others are not padding:
 * `ended` leaves `paused` true but fires nothing else on some paths, `emptied`
 * fires when YouTube swaps the source between videos, and `loadedmetadata` is
 * where a freshly-swapped element settles — without it the deck keeps following
 * an element the page has already thrown away.
 *
 * `timeupdate` IS THE SYNC CLOCK. It fires about every 250 ms while playing,
 * which is the browser volunteering a fresh `currentTime` — a better sample than
 * one we could ask for, because it arrives at the moment it becomes true rather
 * than a round trip later. The cached deck's video lock runs on it and needs no
 * timer of its own. `seeked` is what releases `selfSeeking`.
 *
 * `ratechange` IS HERE (and is deliberately not in `JUMP_EVENTS` — see below).
 * The deck's SPEED readout reports the ELEMENT's rate, never our last request,
 * because `playbackRate` has two writers: us and YouTube's own speed menu.
 * Without this event YouTube's menu moving the rate on a PAUSED video is
 * invisible until the next `play` or `timeupdate` — which is the one case where
 * the user is most likely to be fiddling with it. It is also the hook the
 * user-speed re-assert hangs on (`applySpeed`).
 */
const VIDEO_EVENTS = ['play', 'pause', 'ended', 'emptied', 'loadedmetadata', 'timeupdate', 'seeked', 'ratechange'];

/**
 * The events that mean THE AUDIO ALREADY BUFFERED IS THE WRONG AUDIO.
 *
 * `seeking` fires the moment the user grabs the scrubber, which is ~2.4 s
 * earlier than `seeked` and therefore the right moment to tell the deck: what
 * is in its ring is about to become content the user has left.
 *
 * `ratechange` IS STILL NOT HERE, and the DECISION has now outlived TWO of its
 * reasons. It was first justified by "YouTube time-stretches at 1.5x"; that was
 * replaced when `driveRate()` cleared `preservesPitch` and the build asked for
 * varispeed; and the 2026-08-17 key-lock reversal has put time-stretch back —
 * so the ORIGINAL reason is true again, by a different route. None of that
 * matters, which is the point of writing it down: the decision has always rested
 * on the half that no ruling touches. The element emits 44 100 samples per
 * second AT ANY RATE, whichever way the pitch goes, so the ring
 * keeps filling at exactly the rate it did before and a restart would cost a
 * re-prime for nothing. A rate change moves how far behind we are *in content*,
 * not *in wall time*, and the readout is in wall time.
 */
const JUMP_EVENTS = ['seeking', 'emptied'];

let watched = null;

/**
 * OUR OWN SEEK, in flight. Writing `currentTime` fires `seeking`, which this
 * file reports as a content jump — so a corrective seek would tell the deck the
 * user had scrubbed, and the deck would re-seek in response. That is a feedback
 * loop that converges on nothing and it is the reason this flag exists rather
 * than a style choice.
 *
 * Cleared on the matching `seeked` (and on a timer, because a seek to a position
 * the element is already at fires neither event and would latch the flag on).
 */
let selfSeeking = 0;
const SELF_SEEK_TTL_MS = 2000;
const isSelfSeek = () => selfSeeking !== 0 && Date.now() - selfSeeking < SELF_SEEK_TTL_MS;

/** Transport state, and nothing else. See the L1 note at the top of this file. */
function sendVideoState(extra) {
  if (!frame || !frame.contentWindow) return;
  const playing = !!(watched && !watched.paused && !watched.ended);
  const rate = elementRate();
  frame.contentWindow.postMessage({
    from: 'stem-splitter-live-host', type: 'VIDEO', playing,
    currentTime: watched ? watched.currentTime : 0,
    // NaN before metadata arrives. Sent as 0 so the deck's "do I know the
    // duration" test is a number test rather than a NaN test that passes.
    duration: watched && Number.isFinite(watched.duration) ? watched.duration : 0,
    ended: !!(watched && watched.ended),
    /**
     * THREE MORE NUMBERS OFF THE SAME ELEMENT, ALL TRANSPORT, ALL L1-CLEAN.
     * Still no `src`, no `currentSrc`, no `buffered`, no `srcObject`, no
     * `captureStream()`, no byte of media.
     *
     * `playbackRate` — THE ELEMENT'S, NEVER OUR LAST REQUEST. The deck cannot
     *   derive it: YouTube's own speed menu writes the same property we do, so
     *   a readout painted from our own request lies the moment the user opens
     *   that menu.
     * `hasMedia`  — without it, `playing:false, currentTime:0, duration:0` for
     *   "there is no player on this page" is byte-identical to "paused at
     *   zero", and the deck cannot grey the control with a reason. Reporting
     *   nothing and reporting a healthy zero must not look the same.
     * `adShowing` — `#movie_player.ad-showing`. There is no inference
     *   available; the ad plays through the same element. RESILIENCE, not
     *   removal — see `AD_SHOWING_SEL` in `speed.js` for why the project's
     *   capture rules permit it.
     */
    playbackRate: rate === null ? 1 : rate,
    hasMedia: !!watched,
    adShowing: adShowing(),
    ...extra,
  }, DECK_ORIGIN);
}

function sendJump() {
  if (!frame || !frame.contentWindow) return;
  // Our own correction is not a content jump. Report the new position anyway —
  // it is the freshest transport state there is — but do not claim the user moved.
  if (isSelfSeek()) { sendVideoState({ seeking: false }); return; }
  frame.contentWindow.postMessage({ from: 'stem-splitter-live-host', type: 'JUMP' }, DECK_ORIGIN);
  sendVideoState({ seeking: true });
}

/** The element's own `playbackRate`, or null when there is nothing to read. */
function elementRate() {
  const v = watched;
  return v && Number.isFinite(v.playbackRate) && v.playbackRate > 0 ? v.playbackRate : null;
}

/** Is YouTube playing an ad through the element right now? See `AD_SHOWING_SEL`. */
const adShowing = () => !!document.querySelector(AD_SHOWING_SEL);

/**
 * THE ONLY PLACE THAT DRIVES `playbackRate`. Both callers go through it: the
 * cached deck's sync correction (`driveVideo`) and the user's speed control
 * (`applySpeed`). The only other write in the file is `restoreVideo()`, which is
 * the RELEASE — it hands the element back at 1 with key lock restored, as one
 * undo, and deliberately does not route through here because it is putting
 * `preservesPitch` the other way. Two directions, two named functions; what must
 * never exist is a second DRIVER.
 *
 * WHY ONE FUNCTION AND NOT TWO. `video.playbackRate` has two writers of its own
 * already — us and YouTube's speed menu — and adding a second writer on OUR side
 * is `AGENTS.md`'s entry-point family, which has produced five defects here from
 * a value being right at one call site and wrong at another. Two of the three
 * things below would have been the sixth: the epsilon guard and `preservesPitch`
 * are easy to write on the path you are thinking about and easy to forget on the
 * one you are not.
 *
 * `preservesPitch = SPEED_KEY_LOCK` ON EVERY WRITE.
 *
 * SPEED IS KEY-LOCKED, reversing an earlier varispeed design. This line used to
 * write `false`, which selects varispeed — the pitch follows the speed, the way
 * a turntable does — and it was deliberate, documented and ratified. It was also
 * the defect: the element renders the transposed audio and the capture tap sits
 * DOWNSTREAM of it, so every stem the separator produced was already in the
 * wrong key, and TRANSPOSE was the operator's manual undo. Speed now changes
 * the tempo and nothing else; TRANSPOSE is the only control that moves the key,
 * and the two compose. `qa/speed-pitch.mjs` holds it at ±2 cents.
 *
 * THE CONSTANT LIVES IN `speed.js`, not here, and it is not a setting — see its
 * header for why one flip point and no UI. `SPEED_EPS` on the line above reaches
 * this file by the same route: `speed.js` declares both with `var` at the top
 * level of a classic content script and the manifest loads it BEFORE this file,
 * so they are globals of the isolated world. There is no import in this file and
 * there cannot be one.
 *
 * IT IS SET UNCONDITIONALLY RATHER THAN ONLY ON THE USER PATH. The file used to
 * say `preservesPitch` was "irrelevant on a muted element and is left alone",
 * and that was true while the sole writer was the cached-deck sync lock on an
 * element we had muted. It does not survive a live speed control: on a live deck
 * we do NOT mute the element (`tabCapture` mutes the tab's OUTPUT; the element
 * still renders into the captured stream), so whatever this property says is
 * what the separator hears. One property with one meaning at one writer beats
 * two rules that are each correct on one path.
 *
 * `restoreVideo()` writes `true` — Chrome's default — for the same reason it
 * puts the rate back to 1. Under key lock the two now AGREE rather than being
 * two policies that happened to meet at the release.
 *
 * @param {HTMLMediaElement|null} v
 * @param {number} rate
 * @returns {boolean} did anything get written
 */
function driveRate(v, rate) {
  if (!v || !Number.isFinite(rate) || rate <= 0) return false;
  if (Math.abs(v.playbackRate - rate) <= SPEED_EPS) return false;
  // Before the rate, so the element never renders even one quantum under the
  // wrong policy.
  if (v.preservesPitch !== SPEED_KEY_LOCK) v.preservesPitch = SPEED_KEY_LOCK;
  v.playbackRate = rate;
  return true;
}

/**
 * Drive the element, on the deck's instruction. Three writes, each guarded so a
 * 10 Hz sync loop does not churn the media pipeline with values it already has.
 */
function driveVideo(d) {
  const v = watched;
  if (!v) return;
  if (typeof d.muted === 'boolean' && v.muted !== d.muted) v.muted = d.muted;
  // ENTRY POINT: the cached deck's sync correction. Same writer as the user's
  // speed control — see driveRate.
  if (Number.isFinite(d.playbackRate)) driveRate(v, d.playbackRate);
  if (Number.isFinite(d.seekTo) && Math.abs(v.currentTime - d.seekTo) > 1e-3) {
    selfSeeking = Date.now();
    v.currentTime = d.seekTo;
  }
}

/**
 * YouTube REPLACES the `<video>` element on some navigations rather than
 * re-pointing it, so the listeners have to be re-hung rather than attached
 * once at load. Cheap and idempotent: called on mount, on every navigation, and
 * whenever the deck says it has booted.
 */
const onVideoEvent = (ev) => {
  if (ev.type === 'seeked') selfSeeking = 0;
  if (ev.type === 'ended') stopAtEnd();
  // YouTube re-renders the player chrome around a source swap, which can put a
  // freshly-built autonav toggle in front of us with its own value. These two
  // events are where a new element has settled; `timeupdate` deliberately is
  // not, because a querySelector at 4 Hz for the whole of a track is a cost
  // with no event behind it.
  if (ev.type === 'play' || ev.type === 'loadedmetadata') reassertAutonav();
  /**
   * THE SPEED RE-ASSERT, and which reason each event carries is the whole
   * design — see `speedPlan` in `speed.js`. `loadedmetadata` is a fresh
   * source settling on this element, so it re-asserts; `ratechange` is somebody
   * else writing the property, so it yields. Everything else is a poll, which
   * is where the ad-end edge gets noticed (`applySpeed` promotes it).
   */
  /**
   * ponytail: ceiling — `emptied` is deliberately a 'poll' and therefore YIELDS.
   * It is a source boundary like `loadedmetadata`, so a format or quality switch
   * that resets the rate mid-video drops the user's speed instead of putting it
   * back, and they have to press again. That is the SAFE direction: the readout
   * stays honest because it paints the element, whereas re-asserting on
   * `emptied` would write a stale rate onto whatever loads next — and on an SPA
   * swap that is a video the user has not heard yet, which is the case §2.6
   * rules against. Upgrade path: promote `emptied` to 'remount' once the element
   * identity is compared across the event, so a swap and a re-point are told
   * apart rather than guessed at.
   */
  if (ev.type === 'loadedmetadata') applySpeed('remount');
  else if (ev.type === 'ratechange') applySpeed('ratechange');
  else applySpeed('poll');
  sendVideoState();
};

function watchVideo() {
  const v = document.querySelector('#movie_player video') || document.querySelector('video');
  if (v === watched) { sendVideoState(); return; }
  if (watched) {
    for (const e of VIDEO_EVENTS) watched.removeEventListener(e, onVideoEvent);
    for (const e of JUMP_EVENTS) watched.removeEventListener(e, sendJump);
    // The element we were driving is being abandoned. Hand it back the way we
    // found it, or a muted 1.02x <video> is what the user is left looking at
    // when the deck moves on.
    restoreVideo(watched);
  }
  watched = v;
  if (watched) {
    for (const e of VIDEO_EVENTS) watched.addEventListener(e, onVideoEvent);
    for (const e of JUMP_EVENTS) watched.addEventListener(e, sendJump);
  }
  sendVideoState();
}

/**
 * Undo everything `driveVideo` can do. Called when the element is swapped, when
 * the deck says cached playback has stopped, and on unmount.
 *
 * `muted` is restored to FALSE rather than to a remembered prior value on
 * purpose: the only path that mutes it is ours, and remembering across a YouTube
 * SPA navigation is a stale-state bug waiting to happen. If the user had muted
 * the player themselves, YouTube's own volume state re-applies on the next
 * interaction — its UI is the authority on that, not us.
 *
 * `preservesPitch` is restored to TRUE for exactly that argument one property
 * over: TRUE is Chrome's default, we are the only writer of it, and a page left
 * with key lock disabled after the deck has gone would silently change what
 * YouTube's own speed menu does for the rest of the session.
 *
 * `userRate = null` IS PART OF THE UNDO AND NOT AN EXTRA. The write set this
 * function owes is closed — `muted`, `playbackRate`, `preservesPitch`,
 * `currentTime` — and the CLAIM behind the rate has to go with the rate, or the
 * next `ratechange` on this element re-asserts a speed for a video the user has
 * not heard yet. That also gives the ruled behaviour for free: an SPA source
 * swap calls this, so SPEED RESETS TO HOME ON A VIDEO CHANGE, and the deck's
 * readout follows because it paints the element.
 */
function restoreVideo(v) {
  if (!v) return;
  if (v.playbackRate !== 1) v.playbackRate = 1;
  if (v.preservesPitch !== true) v.preservesPitch = true;
  if (v.muted) v.muted = false;
  selfSeeking = 0;
  userRate = null;
  clampWhy = null;
  lastRequested = null;
}

// ------------------------------------------------------------------- speed
/**
 * THE USER'S PLAYBACK SPEED — the transport half. The control, its ladder and
 * every string it prints belong to the deck; this is the mechanism that puts a
 * number on the element and reports what happened to it.
 *
 * KEY-LOCKED (product ruling, 2026-08-17, reversing the varispeed one). The tempo
 * moves and the key does not — `driveRate()` writes `SPEED_KEY_LOCK` and the
 * reasoning is there. Nothing here resamples anything of ours: the page's own
 * player does the work, exactly as it does when the user picks a speed from
 * YouTube's own menu, and it is indistinguishable from that at the capture tap.
 *
 * L1 IS UNTOUCHED. This writes the same property YouTube's own menu writes, on
 * the page's own element, at the user's request. It reads no URL, no buffer and
 * no sample. `content.js`'s header already covers the ground: transport and
 * preference, never media.
 *
 * AND IT IS NEVER A HARVESTING ACCELERATOR. A rate above 1 must not be used to
 * prime the stem cache faster than real time; that was settled on audio grounds
 * long before it was a control (`docs/AUDIO.md` §8.3,
 * `extension/shared/stemcache.js`'s header) and it is now scope as well. Nothing
 * in this file starts, shortens or gates a prime, and nothing here should.
 *
 * ---------------------------------------------------------------------------
 * SURFACE THE STATE, INCLUDING — ESPECIALLY — THE ONE WHERE WE COULD NOT LOOK.
 * The same rule the autonav section at the foot of this file is written around:
 * there is no `catch {}` and no silent early return below. An element that is
 * not there, an ad in the way and a rate somebody else set are all REPORTED, so
 * the deck can grey the control WITH A REASON instead of the control quietly
 * doing nothing. A feature that no-ops when its handle disappears reports
 * success for the same reason a vacuous assertion does.
 */

/** The rate the user asked for, for THIS element. `null` = we hold no claim. */
let userRate = null;
/** Whether `resolveSpeed` had to pull the request into range, for the report. */
let clampWhy = null;
/** What the deck last asked for, verbatim, so a refusal can quote it back. */
let lastRequested = null;
/** `#movie_player.ad-showing` as of the last look — the ad-END edge is an input. */
let lastAd = false;

/**
 * The same shape as `AUTONAV_FIND_MS`, and for the same reason: YouTube builds
 * the player asynchronously, so "not there" and "not there YET" are the same DOM
 * read. Inside the window the state is `looking`; when it expires it becomes
 * `missing` and stays there. One of them is a wait and the other is a fact, and
 * the deck greys the control differently for each.
 */
const SPEED_FIND_MS = 6000;
const SPEED_POLL_MS = 400;
let speedDeadline = 0;
let speedTimer = 0;

/**
 * The deck went up, the page navigated, or a request arrived: look again, with a
 * fresh 6 s before "not there yet" is allowed to become "not there". The reason
 * belongs to the CALLER — a window opened by a user press is a 'set' and one
 * opened by a navigation is not, and collapsing them here would be the same
 * mistake `speedPlan` exists to avoid.
 */
function openSpeedWindow(reason) {
  speedDeadline = Date.now() + SPEED_FIND_MS;
  if (!applySpeed(reason)) pollSpeed();
}

function pollSpeed() {
  if (speedTimer) return;
  speedTimer = setInterval(() => {
    // A LATE ELEMENT IS WHY THIS POLL EXISTS. With no `<video>` there are no
    // media events to wake us, so nothing else would ever notice one arriving.
    // `watchVideo()` is idempotent and returns immediately once it has one.
    watchVideo();
    if (applySpeed('poll')) { clearInterval(speedTimer); speedTimer = 0; }
  }, SPEED_POLL_MS);
}

/** Last report, so a remounted deck can be told what it missed. See postSpeed. */
let lastSpeed = null;
let speedReport = '';

function postSpeed(payload) {
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ from: 'stem-splitter-live-host', type: 'SPEED', ...payload }, DECK_ORIGIN);
}

/**
 * Three channels, exactly as `reportAutonav` has: the host DOM attribute (which
 * is what a browser test can read — a content script's globals are in an
 * isolated world Playwright cannot reach), a message to the deck, and the stored
 * copy for a deck that mounts later and has never been told anything.
 *
 * The attribute is written EVERY time, ahead of the de-dup: `frame` is a new
 * element after every remount, and a report deduped against the last one leaves
 * the new frame carrying no state at all.
 */
function reportSpeed(payload) {
  if (frame) frame.dataset.speed = payload.state;
  lastSpeed = payload;
  const k = JSON.stringify(payload);
  if (k === speedReport) return;
  speedReport = k;
  postSpeed(payload);
}

/**
 * THE ONE CALLER OF `speedPlan`. Every entry point in this file funnels through
 * here with the reason it woke us, because in `speed.js` the reason IS the
 * decision — see its header for why no inspection of the value can replace it.
 *
 * @param {'set'|'ad-end'|'remount'|'ratechange'|'poll'} reason
 * @param {string|null} [refused] a request this file could not read, riding out
 *   on this report. ONE-SHOT BY CONSTRUCTION: it is a parameter and never state,
 *   because a refusal is an event and the state report is about the element,
 *   which a refusal does not change.
 * @returns {boolean} settled — nothing further to do, so the poll may stop.
 */
function applySpeed(reason, refused) {
  /**
   * THE AD-END EDGE, PROMOTED HERE AND NOWHERE ELSE. `ad-showing` is a class,
   * not an event, so the transition true -> false has to be noticed by whoever
   * looks next — which is any of the callers above. Promoting it here rather
   * than at each of them is the same argument as `driveRate`: an edge detected
   * on three paths and missed on the fourth is the entry-point family again.
   *
   * A user press never becomes an ad-end: 'set' during an ad is refused by the
   * plan, and re-labelling it would apply the rate to the advert.
   */
  const ad = adShowing();
  const r = (reason !== 'set' && lastAd === true && ad === false) ? 'ad-end' : reason;
  lastAd = ad;

  const plan = speedPlan({
    want: userRate,
    current: elementRate(),
    hasMedia: !!watched,
    adShowing: ad,
    finding: Date.now() <= speedDeadline,
    reason: r,
  });

  // YIELD: somebody else owns this rate now. Adopt it — the deck paints the
  // element, so agreeing with the element is what keeps the readout honest.
  userRate = plan.want;
  if (plan.act === 'yield') { clampWhy = null; lastRequested = null; }
  if (plan.act === 'write') driveRate(watched, plan.rate);

  const applied = elementRate();
  reportSpeed({
    state: plan.state,
    // `ok` is "the user's speed is on the element RIGHT NOW", and it is false
    // whenever we could not look. It is never derived from what we sent.
    ok: plan.state === 'ok' && applied !== null
      && (userRate === null || Math.abs(applied - userRate) <= SPEED_EPS),
    want: userRate,
    applied,
    requested: lastRequested,
    why: plan.why,
    clamped: clampWhy,
    refused: refused || null,
  });

  // 'ok' and 'ad' are live facts we keep observing through media events, so the
  // poll has nothing left to add. 'looking' is a wait; 'missing' and 'unknown'
  // are facts only once the find window has closed on them.
  return plan.state === 'ok' || plan.state === 'ad' || Date.now() > speedDeadline;
}

/**
 * ENTRY POINT: the deck's `SPEED` message, and the only way `userRate` is ever
 * set. The clamp lives in `resolveSpeed` — see the note there on which half of
 * the range each side owns.
 */
function setUserRate(raw) {
  lastRequested = raw === undefined ? null : raw;
  const res = resolveSpeed(raw);
  if (!res.ok) {
    /**
     * REFUSED, AND SAID OUT LOUD. Not coerced to 1 and not swallowed: a rate
     * this file cannot read means the sender is broken, and substituting a
     * plausible number produces a video playing at a speed nobody asked for
     * with nothing on screen to say the message was rejected. Same posture as
     * the engine's PITCH refusal, which is the closest neighbour this has.
     */
    console.warn('[stem-splitter-live] SPEED refused: '
      + `${JSON.stringify(raw)} is not a playback rate; staying at ${userRate === null ? 'the page\'s own speed' : userRate}.`);
    // Reported on a normal state message rather than as a state of its own: the
    // element is exactly where it was, and inventing a 'refused' state would
    // latch a lie about the element onto the deck until the next media event.
    applySpeed('poll', res.why);
    return;
  }
  userRate = res.rate;
  clampWhy = res.why === 'release' ? null : res.why;
  // A fresh window: this request is the moment the user cares whether there is
  // an element, so "not there yet" gets its 6 s before it becomes "not there".
  openSpeedWindow('set');
}

function unmount() {
  // REMOVED, not hidden. The deck is a live surface — meters at 30 Hz, a 10 Hz
  // status repaint — and leaving it running invisibly behind `display:none` is
  // paying for a UI nobody is looking at, on the same machine that is trying to
  // hit a 1.95 s separation deadline.
  //
  // Removing it does NOT stop the audio: capture and separation live in the
  // offscreen document and never depended on this frame existing. Hiding the
  // deck mid-set is a legitimate thing to want, so it must be free.
  //
  // BEFORE the frame goes, not after: this is the last moment the report
  // channel (`frame.dataset.autonav`, and the deck's own window) still exists,
  // and a restore that fails silently is the whole failure mode this file's
  // autonav section is written around.
  setAutonavEngaged(false);
  if (frame) frame.remove();
  frame = null;
  // The deck is gone, so nothing here may keep taking keys off YouTube. Cleared
  // rather than left standing: `deckArmed` is the deck's word about itself, and
  // a deck that no longer exists has not said anything.
  deckArmed = false;
  deckKeys = new Set();
  // The deck is gone and cannot correct anything any more. Leaving the element
  // muted at 1.02x would be a silent video the user cannot explain — and the
  // same is now true of a 1.50x one, which `restoreVideo` also puts back.
  restoreVideo(watched);
  // Nothing left to look for and nobody left to report to. A poll that outlives
  // its reader is the invisible half of a control that quietly does nothing.
  if (speedTimer) { clearInterval(speedTimer); speedTimer = 0; }
  lastSpeed = null;
  speedReport = '';
}

/**
 * The service worker's word on the arm gesture. `mode`:
 *   'toggle' — the click armed (or re-armed) this tab. Show the deck, or put it
 *              away if it is already up. This is the show/hide gesture.
 *   'show'   — the arm was REFUSED. The refusal has to land somewhere the user
 *              can read it, and this page is the only surface this build has.
 */
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.to !== 'tab') return false;
  if (m.type !== 'STEM_SPLITTER_LIVE_EMBED') return false;
  if (m.mode === 'toggle' && frame && frame.isConnected) unmount();
  else mount();
  return false;
});

/**
 * YouTube is a single-page app: navigating to another video REPLACES the block
 * we inserted next to, and our iframe goes with it. The tab is still armed and
 * still captured — same tab, same grant — so the deck should come straight back.
 * Without this the deck vanishes on the next video and the toolbar icon looks
 * broken.
 */
document.addEventListener('yt-navigate-finish', () => {
  if (frame && !frame.isConnected) { mount(); return; }
  if (!frame) {
    // Not mounted, but we may still owe this user a restore from the page we
    // just left — `setAutonavEngaged(false)` on that page could not find a
    // control YouTube had already torn down ('lost'). This is the retry.
    setAutonavEngaged(false);
    return;
  }
  // YouTube rebuilds the player chrome on navigation, so the toggle in front of
  // us now is a DIFFERENT element with YouTube's value on it. Re-assert with a
  // fresh find window rather than trusting the one we set on the last video.
  setAutonavEngaged(true);
  // Same tab, same grant, DIFFERENT TRACK. Whatever is in the deck's ring is
  // the previous video and must not be played over this one.
  sendJump();
  watchVideo();   // the <video> element itself may have been replaced
  /**
   * A DIFFERENT TRACK IS A DIFFERENT SPEED, and it is home. `watchVideo()` above
   * has already handed the old element back at rate 1 through `restoreVideo()`,
   * which drops the claim with it — a speed that survived a video change would
   * silently play a video the user has not heard yet at somebody else's tempo.
   * This opens a fresh find window for the element YouTube is building now; the
   * old deadline would expire mid-search.
   */
  openSpeedWindow('remount');
});

/**
 * The deck sizes itself. Only ITS window may say so — `postMessage` is reachable
 * from the host page and from any other frame on it, and this sets a style on
 * an element in the user's YouTube tab.
 */
window.addEventListener('message', (ev) => {
  if (!frame || ev.source !== frame.contentWindow) return;
  const d = ev.data;
  if (!d || d.from !== 'stem-splitter-live') return;
  if (d.type === 'HEIGHT') {
    const h = Math.max(120, Math.min(900, Number(d.height) || 0));
    if (h) frame.style.height = `${h}px`;
  } else if (d.type === 'VDRIVE') {
    // Cached playback only — the deck decides that, not this file. See the L1
    // note at the top for why writing here is sound and was not before.
    driveVideo(d);
  } else if (d.type === 'VRELEASE') {
    restoreVideo(watched);
  } else if (d.type === 'SPEED') {
    /**
     * THE USER'S SPEED. `{ from:'stem-splitter-live', type:'SPEED', rate }` where `rate`
     * is a number in [0.5, 2.0] or `null` to release the claim. Anything else is
     * refused and reported — see `setUserRate` and `resolveSpeed`.
     *
     * The deck owns the LADDER and greys the control on a cached deck (there is
     * no page rate to drive when the audio is coming off disk); this file owns
     * the RANGE and every reason the element itself cannot take a rate right
     * now. Two gates, two different questions, both reported.
     */
    setUserRate(d.rate);
  } else if (d.type === 'CLOSE') {
    unmount();
  } else if (d.type === 'READY') {
    // The deck has a listener now. Everything before this went into a page that
    // was still parsing, so the current player state is re-sent rather than
    // assumed — a deck opened on an ALREADY-PLAYING video is the common case,
    // not the edge one.
    watchVideo();
    /**
     * ...and so is the autoplay state, for the same reason and one more:
     * `reportAutonav` fires on CHANGE, so a deck hidden and shown again while
     * the state stayed `missing` would never be told, and its banner would be
     * blank about a failure that is still happening. This is the undeduped
     * re-send; `frame.dataset.autonav` already had it, but only the host DOM
     * can read that.
     */
    if (lastAutonav) postAutonav(lastAutonav.state, lastAutonav.detail);
    /**
     * ...and the speed state, for the third time and the same reason:
     * `reportSpeed` fires on CHANGE, so a deck hidden and shown again while the
     * state stayed `missing` would never be told and would draw an enabled
     * control over a page that has no player. Undeduped, like the autonav
     * re-send above it.
     */
    if (lastSpeed) postSpeed(lastSpeed);
  } else if (d.type === 'DECK') {
    /**
     * THE DECK'S OWN WORD ON THE TWO THINGS THE KEYBOARD NEEDS. See the
     * keyboard section at the foot of this file: `armed` is the product's gate on
     * taking 1-6 at all, and `keys` is the list of codes to intercept — sent by
     * the deck rather than duplicated here, because this file cannot import
     * `ui/embed-state.js` where the list is defined and asserted.
     */
    deckArmed = d.armed === true;
    deckKeys = new Set(Array.isArray(d.keys) ? d.keys : []);
  }
});

// ---------------------------------------------- stop at the end of the video
/**
 * THE VIDEO STOPS AT THE END INSTEAD OF YOUTUBE PLAYING THE NEXT ONE, and there
 * is a setting for it. Default: suppressed.
 *
 * MECHANISM: YOUTUBE'S OWN TOGGLE, PRESSED AND PUT BACK. `.ytp-autonav-toggle-
 * button` in the right-hand player controls carries `aria-checked`, and a
 * synthetic `.click()` from this isolated world reaches YouTube's own handler —
 * so the browser ends up in the state the user would have reached by hand, with
 * YouTube's own end-screen behaviour following from it. Nothing of ours has to
 * understand the end screen.
 *
 * The cost of using their toggle is that it is an ACCOUNT-LEVEL preference, and
 * a silently flipped account preference is exactly the bug `restoreVideo()`
 * exists to prevent one level down: "a muted 1.02x video left behind is a bug
 * the user cannot explain". So the value we overwrite is recorded and put back.
 *
 * TWO ROUTES REJECTED, so nobody spends the afternoon:
 *   - **Pausing at `duration − ε`.** It works, and it silently breaks the stem
 *     cache: `shared/stemcache.js` `commitRefusal` refuses to commit unless the
 *     page reports `ended`, and refuses again if the capture is more than 6 s
 *     short of the page's duration. Every first-play prime would become a
 *     discarded one. Pausing ON `ended` is a companion (`stopAtEnd`), never the
 *     mechanism — YouTube starts its countdown from the end screen, which is up
 *     BEFORE the media element ends.
 *   - **Main-world injection** to call the player API. This code has never run
 *     in the page's JS world (see the top of this file), and this build has
 *     neither `scripting` nor a YouTube host permission. Not worth the line.
 *
 * WHY `chrome.storage.local` AND NOT `sync`. `sync` is a network write, and P1
 * forbids the network after the model download — for a product whose whole claim
 * is that nothing leaves the machine, a preference quietly replicating to Google
 * is not a detail. `session` is what every other storage call in this build uses
 * and it is wrong here: those are machine state, this is a preference and has to
 * outlive the browser.
 *
 * WHY THE SETTING IS READ HERE AND NOT POSTED FROM THE DECK. `unmount()` removes
 * the iframe while the pipeline keeps running, so a preference that arrived by
 * `postMessage` would go stale the moment the user hid the deck. Reading
 * `storage.local` directly and listening to `onChanged` has fewer moving parts
 * and survives the unmount.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT IS NOT WIRED, DELIBERATELY: `VRELEASE`. That message means cached
 * playback stopped driving the element — which includes every pause — and it
 * fires many times in a session. Restoring autonav there would hand autoplay
 * back mid-set, on a pause, with nothing scheduled to take it away again: the
 * user pauses once and the feature is silently off for the rest of the video.
 * Autonav is a preference for as long as the deck is up, not a property of the
 * `<video>` element, so it is scoped to mount/unmount and NOT folded into
 * `restoreVideo()` — which is per-element and runs on every SPA source swap,
 * where a restore would immediately be undone by the re-assert two lines later.
 */

/** Resolved from storage. Suppressed until storage says otherwise — see `resolveSuppress`. */
let suppressNext = resolveSuppress(null);
/** YouTube's `aria-checked` as we found it, or null if we have never clicked. */
let autonavOriginal = null;
/** Last state we reported, so the channels below fire on CHANGE and not at 4 Hz. */
let autonavState = null;
/** Is the deck up? Set by mount/unmount, not derived, so unmount can report before the frame goes. */
let autonavEngaged = false;

/**
 * YouTube renders the player controls asynchronously and rebuilds them on
 * navigation, so "not there" and "not there YET" are the same DOM read. The
 * find window separates them: inside it the state is `looking`, and when it
 * expires the state becomes `missing` and stays there. Both are reported; the
 * point is that one of them is a fact and the other is a wait.
 *
 * 6 s rather than a round 10: the player controls are in the DOM by
 * `document_idle` in every case anyone has seen, so this is already generous,
 * and the window is pure latency on the one outcome that has to be NOTICED.
 */
const AUTONAV_FIND_MS = 6000;
const AUTONAV_POLL_MS = 400;
/**
 * A toggle whose `aria-checked` never follows our click is a toggle we do not
 * understand, and the honest response is to stop pressing it and say so. Without
 * this the poll would click it ~25 times before the window closed and leave it
 * on whichever value an odd or even count landed on.
 */
const AUTONAV_MAX_CLICKS = 3;
let autonavDeadline = 0;
let autonavClicks = 0;
let autonavTimer = 0;

/**
 * The toggle only exists on a watch page, and the content script runs on every
 * www.youtube.com page there is. Home, search and channel pages must not report
 * a missing control, because on them it is correctly missing.
 *
 * ponytail: ceiling — `/watch` misses the `/live/<id>` permalink form, which
 * redirects to `/watch` in the common case but does not always. Upgrade path:
 * add `#movie_player`'s presence as a second witness. Not done yet because a
 * false "no player here" is a silent no-op and a false "there is a player" is a
 * cried wolf, and only one of those is visible.
 */
const isWatchPage = () => location.pathname === '/watch';

/** The last report, so a freshly mounted deck can be told what it missed. */
let lastAutonav = null;

/** The one post. Deduped by its caller, and NOT deduped by the READY handler. */
function postAutonav(state, detail) {
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage({
    from: 'stem-splitter-live-host', type: 'AUTONAV',
    state, suppress: suppressNext, ...detail,
  }, DECK_ORIGIN);
}

/**
 * SURFACE THE STATE, INCLUDING — ESPECIALLY — THE ONE WHERE WE COULD NOT LOOK.
 * AGENTS.md's rule is about assertions, but a feature that quietly does nothing
 * when its handle disappears reports success for the same reason a vacuous
 * assertion does: nobody can tell the difference from the outside. So there is
 * no `catch {}` and no early `return` on a null element anywhere below — every
 * outcome lands here with a name.
 *
 * Three channels, because they have three different readers:
 *   - `frame.dataset.autonav` — host DOM, which is what a browser test can read
 *     (a content script's globals are in an isolated world Playwright's
 *     `page.evaluate` cannot reach).
 *   - a message to the deck — the user-visible half. The deck owns the banner.
 *   - `console.warn` for the failures — the developer half, and deliberately
 *     `warn` rather than `error`: `tools/embed-smoke.mjs` treats a console error
 *     as a test failure, and on a fixture with no YouTube chrome in it a missing
 *     toggle is the expected result, not a broken build.
 */
function reportAutonav(state, detail) {
  // The attribute is written EVERY time, ahead of the de-dup. `frame` is a new
  // element after every remount, and a report deduped against the last one left
  // the new frame carrying no state at all — measured, and it is the same
  // family as a vacuous assertion: the reader cannot tell "nothing to say" from
  // "nobody wrote it".
  if (frame) frame.dataset.autonav = state;
  // Held for the same reason, one channel over: a REMOUNTED deck has never been
  // told anything, and the de-dup below is about not repeating ourselves to a
  // reader that already heard it. See the READY handler.
  lastAutonav = { state, detail };
  if (state === autonavState) return;
  autonavState = state;
  postAutonav(state, detail);
  if (state === 'missing') {
    console.warn('[stem-splitter-live] YouTube\'s autoplay-next toggle was not found on this page, '
      + 'so the next video may still play automatically. Its markup has probably changed.');
  } else if (state === 'lost') {
    console.warn('[stem-splitter-live] YouTube\'s autoplay-next toggle disappeared before it could be '
      + `put back to ${autonavOriginal ? 'on' : 'off'}; it will be restored on the next watch page.`);
  } else if (state === 'stuck') {
    console.warn('[stem-splitter-live] YouTube\'s autoplay-next toggle did not respond to being clicked.');
  }
}

/** The one DOM read. Returns the element and its `aria-checked`, unforgiving about both. */
function findAutonav() {
  const el = document.querySelector(AUTONAV_TOGGLE_SEL);
  if (!el) return { el: null, checked: null };
  const a = el.getAttribute('aria-checked');
  // Anything other than the two documented values is UNREADABLE, not false. A
  // toggle we cannot read is one we must not click — see `autonavPlan`.
  return { el, checked: a === 'true' ? true : (a === 'false' ? false : null) };
}

/**
 * Reconcile the page with the setting. Idempotent and cheap enough to call from
 * a 400 ms poll, a play event and a storage change.
 *
 * @returns {boolean} settled — nothing further to do, so the poll may stop.
 */
function syncAutonav(afterClick = false) {
  const { el, checked } = findAutonav();
  const plan = autonavPlan({
    suppress: suppressNext,
    engaged: autonavEngaged && isWatchPage(),
    found: !!el,
    checked,
    original: autonavOriginal,
  });

  if (plan.act === 'click') {
    /**
     * ONE CLICK PER PASS. `afterClick` is the re-read below, and it must never
     * press anything: a toggle pressed twice in one pass is a toggle back where
     * it started.
     */
    if (afterClick) { reportAutonav('pending', { checked, want: plan.want }); return false; }
    if (autonavClicks >= AUTONAV_MAX_CLICKS) { reportAutonav('stuck', { checked }); return true; }
    if (plan.remember) autonavOriginal = checked;
    autonavClicks++;
    // YouTube's own handler, reached the way the user reaches it.
    el.click();
    /**
     * RE-READ, never assume. YouTube's handler is synchronous on click, so this
     * settles in the same tick in the common case — which matters because the
     * state is the report, and a 400 ms 'pending' that was already 'off' is a
     * report of a doubt nobody has. It also keeps 'pending' meaning what it
     * says: we clicked, and the control did not follow.
     */
    return syncAutonav(true);
  }

  if (plan.forget) { autonavOriginal = null; autonavClicks = 0; }

  if (plan.act === 'missing' || plan.act === 'lost') {
    // Inside the find window this is a WAIT, not a fact. Outside it, it is a
    // fact and it stops being polite about it.
    reportAutonav(Date.now() <= autonavDeadline ? 'looking' : plan.state, { checked });
    return Date.now() > autonavDeadline;
  }

  reportAutonav(plan.state, { checked });
  return true;
}

function pollAutonav() {
  if (autonavTimer) return;
  autonavTimer = setInterval(() => {
    if (syncAutonav()) { clearInterval(autonavTimer); autonavTimer = 0; }
  }, AUTONAV_POLL_MS);
}

/**
 * HOW EVERY CALLER WITH A FUTURE ASKS FOR A RECONCILE. A bare `syncAutonav()`
 * throws away the one bit that matters — whether it is finished — so a call site
 * that ignores it leaves an unsettled state with nothing scheduled to look
 * again. That was real: the play-event re-assert reported `looking` and then
 * never re-checked, so a control removed mid-session stayed `looking` for ever
 * and the `missing` report it owed never arrived.
 *
 * The `pagehide` handler is the one deliberate exception, and it is exactly the
 * caller with no future: there is no later tick to schedule into.
 */
function reassertAutonav() {
  if (!syncAutonav()) pollAutonav();
}

/**
 * The deck went up or came down. Opens a fresh find window either way: the
 * control we are looking for now is not the element we were looking at before,
 * and a deadline inherited from the last video would expire mid-search.
 */
function setAutonavEngaged(on) {
  autonavEngaged = on;
  autonavClicks = 0;
  autonavDeadline = Date.now() + AUTONAV_FIND_MS;
  reassertAutonav();
}

/**
 * BELT AND BRACES, on `ended` and nowhere earlier. See the header: pausing
 * before the element ends is the route that quietly discards the cache prime.
 *
 * The end-screen cancel button is a LATE fallback — it only exists in the window
 * where the toggle route has already failed, so its absence is the healthy case
 * and is not reported. Tried three times because the end screen animates in.
 */
function stopAtEnd() {
  if (!autonavEngaged || !suppressNext) return;
  const v = watched;
  if (v && !v.paused) v.pause();
  for (const ms of [0, 300, 900]) {
    setTimeout(() => {
      if (!autonavEngaged || !suppressNext) return;
      const c = document.querySelector(AUTONAV_CANCEL_SEL);
      if (c) c.click();
    }, ms);
  }
}

/**
 * THE SETTING. `chrome.storage.local`, key `prefs`, shape `{ autoplayNext: boolean }`.
 * Absent means suppressed — `resolveSuppress` owns that and is asserted in
 * `autonav.js`. The UI that writes it does not exist yet; this reads
 * whatever is there and follows it live, so it works the moment it does.
 */
chrome.storage.local.get(PREFS_KEY, (got) => {
  // No `lastError` swallow: if the read failed we still have a resolved default,
  // and saying so is cheaper than a preference that is silently the wrong one.
  if (chrome.runtime.lastError) {
    console.warn('[stem-splitter-live] could not read the autoplay preference '
      + `(${chrome.runtime.lastError.message}); using the default (suppress).`);
  }
  suppressNext = resolveSuppress(got && got[PREFS_KEY]);
  if (autonavEngaged) setAutonavEngaged(true);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PREFS_KEY]) return;
  const next = resolveSuppress(changes[PREFS_KEY].newValue);
  if (next === suppressNext) return;
  suppressNext = next;
  // Applies NOW, not on the next video. Turning suppression off mid-track puts
  // YouTube's toggle back immediately; `autonavPlan` covers both directions.
  autonavClicks = 0;
  autonavDeadline = Date.now() + AUTONAV_FIND_MS;
  reassertAutonav();
});

/**
 * LAST CHANCE TO PUT IT BACK. A tab closed or navigated off YouTube entirely
 * never reaches `unmount()`, and the value we overwrote is an account preference
 * that outlives the page.
 *
 * ponytail: ceiling — `pagehide` gives us a synchronous click and no guarantee
 * that YouTube's handler finishes persisting it before the document goes. A tab
 * killed by the task manager gets nothing at all. Upgrade path: record the taken
 * value in `storage.local` and restore it on the next watch page — a repair pass
 * rather than a best-effort exit. Not built yet: it needs a second key and a
 * staleness rule, and the exit path covers everything except a hard kill.
 */
addEventListener('pagehide', () => {
  if (!autonavEngaged) return;
  autonavEngaged = false;
  syncAutonav();
}, { capture: true });


// ------------------------------------------------------------------ keyboard
/**
 * THE SHORTCUTS REACH THE DECK FROM THE PAGE, which is the only reason this
 * section exists.
 *
 * The deck is a cross-origin `chrome-extension://` iframe. A key event never
 * crosses that boundary, so `1` reaches the deck only when the DECK has focus —
 * and in the gesture the feature is for (click YouTube's play, then reach for a
 * digit) focus is on the YouTube document, where YouTube reads 1-9 as
 * seek-to-percentage. A listener inside the deck alone is a feature that works
 * only after you have clicked the deck, which is not a feature.
 *
 * So: capture phase on `window`, `preventDefault()` + `stopPropagation()` for
 * the keys we take, and the event forwarded to the deck as a message.
 *
 * ---------------------------------------------------------------------------
 * IT ONLY TAKES THEM WHILE A DECK IS ARMED (product ruling). With no deck, `1`-`6`
 * must seek to 10-60 % exactly as they do with this extension uninstalled — we
 * are a guest on somebody else's page, and a page whose shortcuts stop working
 * because of an extension that is doing nothing is a page the user thinks is
 * broken. `deckArmed` and the code list both arrive from the deck (`DECK`
 * above); this file holds no opinion about either.
 *
 * WHY THE LIST IS NOT WRITTEN HERE. It is defined and asserted in
 * `ui/embed-state.js` (`hostKeys`), which this file cannot import — a content
 * script is a classic script in an isolated world. A second hand-maintained
 * copy of "which codes are ours" is exactly how a build with no deck B ends up
 * eating `5`.
 *
 * ponytail: ceiling — `stopPropagation()` does not stop a listener YouTube
 * registered on the SAME target in the SAME phase before us. Nothing observed
 * needs it; upgrade path is `stopImmediatePropagation()`, which is one word and
 * is deliberately not used yet because it would also silence any other
 * extension the user has chosen to install.
 */
let deckArmed = false;
let deckKeys = new Set();

/**
 * ENTRY POINT: the YouTube document. Coarser than the deck's own rule on
 * purpose — every `<input>` here counts as typing, including ones we cannot
 * classify, because the cost of being wrong on this page is a digit stolen out
 * of a half-written comment.
 */
function isTypingTarget(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
    || t.tagName === 'SELECT' || t.isContentEditable);
}

addEventListener('keydown', (e) => {
  if (!deckArmed) return;
  if (!frame || !frame.isConnected || !frame.contentWindow) return;
  if (e.metaKey || e.ctrlKey) return;
  if (isTypingTarget(e.target)) return;
  // `event.code`, not `event.key`: Shift+1 is "!" on a US layout and something
  // else again elsewhere, so the position is the stable handle. `?` is the one
  // exception and it is the opposite case — it is a CHARACTER, and which key
  // produces it differs by layout.
  if (!deckKeys.has(e.code) && e.key !== '?') return;
  e.preventDefault();
  e.stopPropagation();
  frame.contentWindow.postMessage({
    from: 'stem-splitter-live-host', type: 'KEY',
    code: e.code, key: e.key, shift: e.shiftKey, alt: e.altKey, repeat: e.repeat,
  }, DECK_ORIGIN);
}, { capture: true });
