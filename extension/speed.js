/**
 * MAY WE SET THE PAGE'S PLAYBACK RATE RIGHT NOW, AND TO WHAT?
 *
 * Pure: no DOM, no `chrome.*`, no imports, no timers. Runnable check:
 *
 *     node speed.js
 *
 * WHY THIS IS A SEPARATE FILE, in the same words `autonav.js` earned its
 * own: the decision has five outcomes, three of which are refusals, and the
 * refusals are the ones that matter — an element that is not there, an ad
 * playing through the same element, and somebody else writing the same property
 * we write. None of them is reachable from `tools/embed-smoke.mjs`'s fixture
 * (no ads, no YouTube speed menu) and none is worth a browser to check. The
 * decision is pure and asserted here; the wire is in `content.js`.
 *
 * IT IS A CLASSIC SCRIPT, NOT A MODULE, for exactly autonav.js's reason: it is
 * listed in `manifest.overlay.json` ahead of `content.js` in the same
 * `content_scripts` entry, so both run in the same isolated world and a
 * top-level `var` here is what `content.js` reads. A content script cannot
 * `import`. Node runs the same file as ESM, where the `var` is module-scoped
 * and the self-check below is its only reader.
 *
 * ---------------------------------------------------------------------------
 * L1. Nothing here touches media. This file decides a NUMBER — the same number
 * YouTube's own speed menu writes — and `content.js` writes it to the same
 * property YouTube writes it to. No `src`, no `currentSrc`, no `buffered`, no
 * `captureStream()`, no byte of audio. The audio still arrives only through
 * `chrome.tabCapture`.
 *
 * ---------------------------------------------------------------------------
 * SPEED IS A MUSICAL CONTROL AND NEVER A HARVESTING ACCELERATOR (product ruling).
 * A rate above 1 must never be used to prime the stem cache faster than real
 * time. That is not a policy invented here — it is already settled on audio
 * grounds in `docs/AUDIO.md` §8.3 and in `extension/shared/stemcache.js`'s
 * header: capture is at 48 kHz whatever the rate, so at 3x everything above
 * 8 kHz is gone, and `preservesPitch` phase-vocodes exactly the fine structure
 * the separator relies on. Priming is one real-time pass. It is written here
 * too because THIS is the file that makes a fast rate reachable, and the next
 * person to have the idea will be reading this one.
 *
 * Both halves of that paragraph survive `SPEED_KEY_LOCK` below, and it is worth
 * one line to say which: the 24/r kHz band loss is the VARISPEED cost and is now
 * gone from the live path; the phase-vocoder cost is the KEY-LOCK one and is now
 * paid at every non-unity rate. Neither makes a fast pass a legitimate way to
 * fill the cache — one throws away the top of the band, the other smears the
 * fine structure, and the ban was always on both.
 */

/**
 * THE RANGE, AND WHO OWNS WHICH HALF OF THE CLAMP. This matters enough to be
 * the first thing in the file after the header.
 *
 *   - The DECK owns the LADDER: which 29 rungs exist, that the step is a third
 *     of a semitone near home and a whole semitone outside it, and that a press
 *     lands on a rung. `ui/embed-state.js` holds it. Nothing here knows
 *     the ladder exists, and nothing here should — a content script that had to
 *     be redeployed to change a step is a content script with the wrong job.
 *   - THIS FILE owns the RANGE, because this is the last gate before a number
 *     reaches `video.playbackRate`. It clamps rather than trusts: the sender is
 *     a different document, shipped in the same build today and not necessarily
 *     tomorrow, and 2.05x is not a taste boundary — above roughly 2x YouTube's
 *     own buffer starves and the video stalls.
 *
 * Two gates on one number is not duplication, it is the difference between a
 * grid and a guard rail. The deck's clamp decides what the user can ASK for;
 * this one decides what the element can BE GIVEN.
 */
var SPEED_MIN = 0.5;
var SPEED_MAX = 2.0;

/**
 * The same 1e-6 `driveVideo()` has always compared rates with. A 10 Hz sync
 * loop must not churn the media pipeline with a value the element already has,
 * and float equality on a value that has been through a message channel is not
 * a comparison anyone should write.
 */
var SPEED_EPS = 1e-6;

/**
 * KEY LOCK. Written to `video.preservesPitch` on every rate write, by
 * `content.js::driveRate` — the one driver of `video.playbackRate` — and by
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * SPEED IS KEY-LOCKED, reversing an earlier varispeed design. The build shipped
 * `preservesPitch = false` on every write: the pitch followed the speed the way
 * a turntable does, the ladder stepped in musical intervals so it would, and
 * TRANSPOSE was the operator's manual compensator. That was a faithful piece of
 * DJ engineering and it is the wrong product. **A user who slows a video down to
 * learn a line expects the key to stay put, because that is what every player
 * they have ever used does.** Making them hand-correct with a second control to
 * get back where they started is a defect even when it is on spec.
 *
 * So: SPEED CHANGES THE TEMPO AND NOTHING ELSE. TRANSPOSE IS THE ONLY CONTROL
 * THAT MOVES THE KEY, at any speed, and the two compose — 0.75x + TRANSPOSE +5
 * is a fourth UP from the original, not back at it. `qa/speed-pitch.mjs` asserts
 * both of those as separate assertions at their own entry points.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS THE ELEMENT'S PROPERTY AND NOT A SHIFTER OF OURS, because that is
 * the first thing the next reader will re-propose. `extension/engine/pitch.js`
 * is installed, it is on the deck bus already and it clears §6.6's gates — so
 * "drive the existing shifter off the speed ratio" looks free. It is not
 * reachable, and the numbers are in `qa/speed-pitch.mjs`:
 *
 *   - the compensation is −12·log2(rate) semitones. `pitch.js` produces INTEGER
 *     semitones in [−6, +6]. Of the deck's 29 rungs, 13 are exactly
 *     representable, 4 (the fine band either side of home) miss by a third of a
 *     semitone — 33.33 cents — and 12 are outside the range entirely;
 *   - the ladder's own ends, 0.50x and 2.00x, need ±12 — twice the shifter's
 *     whole range;
 *   - and COMPOSITION overflows before the range does: 0.75x needs +5, so
 *     0.75x with TRANSPOSE +5 needs +10 out of one shifter;
 *   - above 1x it cannot work at all at any range. Varispeed time-compresses
 *     BEFORE the capture tap, so at rate r everything above 24/r kHz is gone
 *     from the recording (`docs/AUDIO.md` §8.3). At 2.00x that is everything
 *     over 12 kHz, and no downstream shifter puts back a band that was never
 *     captured.
 *
 * Chrome's own key lock runs inside the media pipeline, ahead of the tap, is
 * exact at every rate, costs us nothing, and is the same code path YouTube's own
 * speed menu uses — which is the behaviour the ruling asks us to match.
 *
 * WHAT IT COSTS, stated so it is not discovered later: the separator now sees
 * phase-vocoded audio at every non-unity rate (`docs/AUDIO.md` §8.3 names that
 * cost). Stems get rougher off 1.00x. That is the trade the ruling buys, and it
 * is bounded by the rate the user chose.
 *
 * IT IS A CONSTANT AND NOT A SETTING. There is no UI for it and there must not
 * be: two pitch behaviours behind one Speed control is a control whose meaning
 * the user has to remember. It is here rather than in `content.js` for
 * `SPEED_EPS`'s reason exactly — this file is the last gate before
 * `video.playbackRate` and the whole write set that reaches the element is
 * decided here — and it is one flip point if the separation-quality cost above
 * ever outweighs the product argument.
 */
var SPEED_KEY_LOCK = true;

/**
 * YouTube plays its ads through the SAME `<video>` element. There is no
 * inference available from the element itself — `duration` changes, and so does
 * nothing else we are allowed to read — so the player's own class is the only
 * witness.
 *
 * THIS IS AD DETECTION FOR RESILIENCE, AND THE SCOPE RULING PERMITS
 * EXACTLY THAT — "No ad blocking, ad skipping, or ad detection-for-removal.
 * (Ad resilience in V1.1 is about not crashing, not about skipping.)" We
 * neither skip nor block nor shorten anything: a 1.4x ad is a user-visible
 * oddity, YouTube resets the rate between items anyway, and the ad pollutes the
 * stems. The control greys itself and comes back. Say so here, because the next
 * reader will mistake it for L4.
 */
var AD_SHOWING_SEL = '#movie_player.ad-showing';

/**
 * VALIDATE AND CLAMP ONE REQUESTED RATE. ENTRY POINT: the `SPEED` message from
 * the deck, and nothing else.
 *
 * A value this file cannot read is REFUSED and said out loud — never coerced to
 * 1. Substituting a plausible number for an unreadable one is how a broken
 * sender ships: the video plays, at a speed nobody asked for, with nothing on
 * screen to say the message was rejected. `snapSpeed()` in the deck does coerce
 * to home, and that is right THERE — it is repairing a value for a readout.
 * Here the value is about to be written to the page.
 *
 * `null` is the one non-number that is not an error: it is the deck RELEASING
 * its claim, which is what "back to the video's own speed" means.
 *
 * @param {number|null|undefined} want
 * @returns {{ok:boolean, rate:number|null, why:string|null}}
 *   `why` ∈ null | 'release' | 'unreadable' | 'clamped-low' | 'clamped-high'
 */
function resolveSpeed(want) {
  if (want === null) return { ok: true, rate: null, why: 'release' };
  // `undefined` is NOT a release. An absent field is a message we cannot read,
  // and reading it as "the user wants their speed back" would be this repo's
  // oldest bug in a new place: the permissive branch taken precisely when there
  // was nothing to look at.
  if (typeof want !== 'number' || !Number.isFinite(want)) {
    return { ok: false, rate: null, why: 'unreadable' };
  }
  if (want < SPEED_MIN) return { ok: true, rate: SPEED_MIN, why: 'clamped-low' };
  if (want > SPEED_MAX) return { ok: true, rate: SPEED_MAX, why: 'clamped-high' };
  return { ok: true, rate: want, why: null };
}

/**
 * THE ONE DECISION. Called from exactly one place — `applySpeed()` in
 * `content.js` — and every assertion below is about that entry point.
 *
 * WHO MOVED THE RATE IS DECIDED BY THE ENTRY POINT, NOT BY THE VALUE, and that
 * is the whole design. `video.playbackRate` has two writers: us and YouTube's
 * own speed menu. A re-assert that fires on any disagreement fights the user
 * the moment they open that menu; a re-assert that never fires loses the user's
 * speed the moment YouTube resets it across an ad. Neither is acceptable and no
 * inspection of the VALUE can separate them — 1.0 is both "YouTube reset it"
 * and "the user picked Normal".
 *
 * So `reason` names the event that woke us, and the rule is:
 *
 *   'set'      the user just pressed our button          -> write
 *   'ad-end'   the ad finished and the item changed      -> write (re-assert)
 *   'remount'  a fresh source settled on this element    -> write (re-assert)
 *   'ratechange' / 'poll'   somebody else wrote it       -> YIELD
 *
 * YIELD means: adopt the element's value as our own and do not write. The deck
 * paints the element, so yielding is what makes the readout honest instead of
 * making it fight. It is returned as `want`, not applied here — this function
 * decides, `content.js` acts.
 *
 * @param {object} s
 * @param {number|null} s.want      the rate we hold for this element, null = no claim
 * @param {number|null} s.current   the element's `playbackRate`, null if unreadable
 * @param {boolean} s.hasMedia      is there an element we are watching
 * @param {boolean} s.adShowing     is `#movie_player.ad-showing` set
 * @param {boolean} s.finding       are we still inside the find window
 * @param {string}  s.reason        'set'|'ad-end'|'remount'|'ratechange'|'poll'
 * @returns {{act:'write'|'hold'|'idle'|'yield', rate:number|null,
 *            state:'ok'|'ad'|'looking'|'missing'|'unknown',
 *            want:number|null, why:string|null}}
 */
function speedPlan(s) {
  const st = s || {};
  const reason = typeof st.reason === 'string' ? st.reason : 'poll';
  const want = typeof st.want === 'number' && Number.isFinite(st.want) ? st.want : null;
  const finding = st.finding === true;
  // A rate is a positive finite number. 0 and negatives are not slow playback,
  // they are an element we do not understand.
  const cur = typeof st.current === 'number' && Number.isFinite(st.current) && st.current > 0
    ? st.current : null;

  /**
   * WE CANNOT LOOK, SO WE SAY SO. `hasMedia !== true` catches `false`,
   * `undefined` and every other absent field with one test, and the shape this
   * deliberately is NOT is `!hasMedia || (real check)` — eighteen logged
   * instances in this repo (`AGENTS.md`).
   *
   * Inside the find window "not there" is a WAIT and outside it is a FACT. Both
   * are reported; the point is that the deck can grey the control with the right
   * reason instead of the control quietly doing nothing.
   */
  if (st.hasMedia !== true || cur === null) {
    const state = finding ? 'looking' : 'missing';
    return { act: 'idle', rate: null, state, want, why: state };
  }

  /**
   * ...and the same rule one field over. `adShowing` must be a BOOLEAN read off
   * the page, not a field that happens to be absent: if it is missing we do not
   * know whether an ad is playing, and the permissive reading of that is the one
   * that applies a user's 1.4x to an advert. Unreachable from `content.js`,
   * which always passes a DOM read — this is the guard for the NEXT caller.
   */
  if (typeof st.adShowing !== 'boolean') {
    return { act: 'idle', rate: null, state: 'unknown', want, why: 'ad-unknown' };
  }

  if (st.adShowing) {
    // No claim held: the ad is YouTube's business and so is its speed.
    if (want === null) return { act: 'idle', rate: null, state: 'ad', want: null, why: 'ad' };
    // A claim held: neutralise for the duration, REMEMBERING the rate. `want` is
    // carried through untouched, which is what makes 'ad-end' able to put it
    // back. Writing 1 rather than leaving whatever is there is deliberate — a
    // mid-roll that inherits 1.4x is the user-visible oddity.
    if (Math.abs(cur - 1) > SPEED_EPS) return { act: 'write', rate: 1, state: 'ad', want, why: 'ad' };
    return { act: 'hold', rate: null, state: 'ad', want, why: 'ad' };
  }

  // No claim: YouTube's menu owns the rate and we are a reader of it.
  if (want === null) return { act: 'idle', rate: null, state: 'ok', want: null, why: null };

  // Already there. This is the branch a 4 Hz caller lands on all day.
  if (Math.abs(cur - want) <= SPEED_EPS) return { act: 'hold', rate: null, state: 'ok', want, why: null };

  if (reason === 'set' || reason === 'ad-end' || reason === 'remount') {
    return { act: 'write', rate: want, state: 'ok', want, why: reason };
  }

  // Somebody else moved it. Adopt, do not fight. See the header of this function.
  return { act: 'yield', rate: null, state: 'ok', want: cur, why: 'yield' };
}

// ------------------------------------------------------------------- check
function demo() {
  let fails = 0;
  const eq = (got, want, what) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${what}\n  got  ${g}\n  want ${w}`); fails++; }
    else console.log(`ok   ${what}`);
  };

  // --- resolveSpeed: ENTRY POINT, the SPEED message from the deck -----------
  eq(resolveSpeed(1), { ok: true, rate: 1, why: null }, 'resolveSpeed: home passes through untouched');
  eq(resolveSpeed(1.4983), { ok: true, rate: 1.4983, why: null },
    'resolveSpeed: an off-round ladder rung is NOT rounded — this file does not know the ladder and must not snap to one');
  eq(resolveSpeed(0.5), { ok: true, rate: 0.5, why: null }, 'resolveSpeed: the floor itself is inside the range, not clamped at it');
  eq(resolveSpeed(2), { ok: true, rate: 2, why: null }, 'resolveSpeed: and so is the ceiling');
  eq(resolveSpeed(2.05), { ok: true, rate: 2, why: 'clamped-high' },
    'resolveSpeed: 2.05x STALLS YouTube\'s buffer and is clamped to the ceiling, and the clamp is REPORTED so the deck can correct its button');
  eq(resolveSpeed(3), { ok: true, rate: 2, why: 'clamped-high' }, 'resolveSpeed: ...and so is anything above it');
  eq(resolveSpeed(0.25), { ok: true, rate: 0.5, why: 'clamped-low' },
    'resolveSpeed: 0.25x is reachable from YouTube\'s own menu and is clamped up to our floor');
  eq(resolveSpeed(0), { ok: true, rate: 0.5, why: 'clamped-low' }, 'resolveSpeed: zero is not a pause, it is below the floor');
  eq(resolveSpeed(-1), { ok: true, rate: 0.5, why: 'clamped-low' }, 'resolveSpeed: and a negative rate is not reverse');

  eq(resolveSpeed(null), { ok: true, rate: null, why: 'release' },
    'resolveSpeed: null is the deck RELEASING its claim — the one non-number that is not an error');
  eq(resolveSpeed(undefined), { ok: false, rate: null, why: 'unreadable' },
    'resolveSpeed: a MISSING rate field is refused, NOT read as a release — the absent-field branch must never be the permissive one');
  eq(resolveSpeed(NaN), { ok: false, rate: null, why: 'unreadable' },
    'resolveSpeed: NaN is refused. Writing it to playbackRate throws in Blink, and coercing it to 1 would hide the sender that produced it');
  eq(resolveSpeed(Infinity), { ok: false, rate: null, why: 'unreadable' }, 'resolveSpeed: ...and so is Infinity, which would otherwise clamp to 2.0 and look fine');
  eq(resolveSpeed('1.5'), { ok: false, rate: null, why: 'unreadable' },
    'resolveSpeed: a STRING is refused rather than coerced — "1.5" arriving means the sender is broken, and 1.5x would hide it');
  eq(resolveSpeed(true), { ok: false, rate: null, why: 'unreadable' }, 'resolveSpeed: and a boolean is not 1');

  // --- speedPlan -----------------------------------------------------------
  // Healthy default: an element, no ad, inside the find window, woken by a poll.
  const P = (o) => speedPlan({
    want: null, current: 1, hasMedia: true, adShowing: false, finding: false, reason: 'poll', ...o,
  });

  eq(P({ want: 1.5, reason: 'set' }),
    { act: 'write', rate: 1.5, state: 'ok', want: 1.5, why: 'set' },
    'ENTRY POINT set: the user pressed our button -> write it');
  eq(P({ want: 1.5, current: 1.5, reason: 'set' }),
    { act: 'hold', rate: null, state: 'ok', want: 1.5, why: null },
    '...and pressing for a rate the element already has writes NOTHING — this is the branch a 4 Hz caller lands on all day');
  eq(P({ want: null, current: 1.75 }),
    { act: 'idle', rate: null, state: 'ok', want: null, why: null },
    'no claim held -> YouTube\'s menu owns the rate and we are only a reader of it, even at 1.75x');

  /**
   * THE RE-ASSERT, AND ITS NEGATIVE CONTROL. These four are one claim: the
   * SAME want and the SAME current produce a write or a yield depending only on
   * which event woke us. If the two halves ever agree, the entry-point rule has
   * collapsed and the control either fights YouTube's menu or loses the user's
   * speed across every ad — and no assertion on a single reason can see that.
   */
  eq(P({ want: 1.5, current: 1, reason: 'ad-end' }),
    { act: 'write', rate: 1.5, state: 'ok', want: 1.5, why: 'ad-end' },
    'ENTRY POINT ad-end: YouTube reset the rate across the item boundary -> RE-ASSERT the user\'s speed');
  eq(P({ want: 1.5, current: 1, reason: 'remount' }),
    { act: 'write', rate: 1.5, state: 'ok', want: 1.5, why: 'remount' },
    'ENTRY POINT remount: a fresh source settled on this element -> re-assert, same as ad-end');
  eq(P({ want: 1.5, current: 1, reason: 'ratechange' }),
    { act: 'yield', rate: null, state: 'ok', want: 1, why: 'yield' },
    'ENTRY POINT ratechange, SAME want and SAME current: the user picked Normal in YouTube\'s own menu -> YIELD to 1, never write 1.5 back');
  eq(P({ want: 1.5, current: 1.75, reason: 'ratechange' }),
    { act: 'yield', rate: null, state: 'ok', want: 1.75, why: 'yield' },
    '...and YouTube\'s slider reaching an off-ladder 1.75x is adopted verbatim, not snapped and not overwritten');
  eq(P({ want: 1.5, current: 1.75, reason: 'poll' }).act, 'yield',
    'a poll is not evidence that WE moved it either — only set / ad-end / remount write');

  /**
   * THE AD. `want` survives every branch of it, which is the half that makes
   * 'ad-end' able to put the rate back.
   */
  eq(P({ want: 1.5, current: 1.5, adShowing: true }),
    { act: 'write', rate: 1, state: 'ad', want: 1.5, why: 'ad' },
    'an ad inheriting our 1.4x is a user-visible oddity -> neutralise to 1 for the duration');
  eq(P({ want: 1.5, current: 1, adShowing: true }),
    { act: 'hold', rate: null, state: 'ad', want: 1.5, why: 'ad' },
    '...once, not on every tick — an ad already at 1 is left alone');
  eq(P({ want: 1.5, current: 1, adShowing: true }).want, 1.5,
    'and the user\'s rate is REMEMBERED through the ad, or ad-end would have nothing to re-assert');
  eq(P({ want: null, current: 1, adShowing: true }),
    { act: 'idle', rate: null, state: 'ad', want: null, why: 'ad' },
    'no claim held during an ad -> nothing of ours happens at all');
  eq(P({ want: 1.5, current: 1.5, adShowing: true, reason: 'set' }).rate, 1,
    'pressing the button DURING an ad cannot apply the rate — the ad branch outranks the entry point, and the deck greys the control anyway');

  /**
   * THE HANDLE IS GONE. Every one of these must produce a NAMED state the deck
   * can grey the control with. A feature that quietly does nothing when its
   * handle disappears reports success for the same reason a vacuous assertion
   * does (this file's header, and content.js's).
   */
  eq(P({ want: 1.5, hasMedia: false, finding: true }),
    { act: 'idle', rate: null, state: 'looking', want: 1.5, why: 'looking' },
    'NO ELEMENT, inside the find window -> looking. A wait, and the claim is kept');
  eq(P({ want: 1.5, hasMedia: false, finding: false }),
    { act: 'idle', rate: null, state: 'missing', want: 1.5, why: 'missing' },
    '...and once the window expires the same DOM read becomes MISSING — a reported fact, not a silent early return');
  eq(P({ want: 1.5, hasMedia: undefined, finding: false }).state, 'missing',
    'hasMedia UNDEFINED is not "there is one". An absent field means we could not look, and the assertion has to fail when it cannot look');
  eq(P({ want: 1.5, hasMedia: true, current: null }).state, 'missing',
    'an element whose playbackRate we cannot READ is as good as absent — a rate compared against null is a comparison that always disagrees');
  eq(P({ want: 1.5, hasMedia: true, current: 0 }).state, 'missing',
    '...and 0 is not slow playback, it is an element we do not understand');
  eq(P({ want: 1.5, hasMedia: true, current: -1 }).state, 'missing', '...nor is a negative rate reverse');
  eq(P({ want: 1.5, adShowing: undefined }),
    { act: 'idle', rate: null, state: 'unknown', want: 1.5, why: 'ad-unknown' },
    'adShowing UNDEFINED means we do not know whether an ad is playing, and the permissive reading of that applies 1.4x to an advert');
  eq(P({ want: 1.5, adShowing: 'false' }).state, 'unknown',
    '...and a STRING "false" is not a DOM read either — it is truthy, so a bare if() would have called it an ad');

  eq(speedPlan(undefined),
    { act: 'idle', rate: null, state: 'missing', want: null, why: 'missing' },
    'no state at all writes nothing and reports missing — never "ok"');

  /**
   * THE RANGE GUARD IS NOT IN speedPlan, AND THAT IS THE POINT. `resolveSpeed`
   * is the only clamp; `speedPlan` writes whatever claim it is handed. Asserted
   * so that a future "tidy-up" that moves the clamp in here is a red: two
   * clamps on one number is how a value ends up right at one call site and
   * wrong at another — `AGENTS.md`'s entry-point rule, five defects.
   */
  eq(P({ want: 9, reason: 'set' }).rate, 9,
    'speedPlan does NOT clamp — resolveSpeed is the one gate, and a second one here would be the entry-point family again');

  process.exitCode = fails ? 1 : 0;
  console.log(fails ? `\n${fails} FAILED` : '\nspeed: all checks passed');
}

if (typeof process !== 'undefined' && Array.isArray(process.argv)
    && String(process.argv[1] || '').endsWith('speed.js')) demo();
