/**
 * SHOULD YOUTUBE AUTOPLAY THE NEXT VIDEO, and what has to happen to its own
 * toggle for the answer to be the one the user asked for?
 *
 * Pure: no DOM, no `chrome.*`, no imports, no timers. Runnable check:
 *
 *     node extension/autonav.js
 *
 * WHY THIS IS A SEPARATE FILE IN A REPO THAT BANS ABSTRACTION. Because the
 * decision has five outcomes, two of which are failures, and the failures are
 * the ones that matter — a control we cannot find and a preference we flipped
 * and cannot put back. Neither is reachable from `tools/embed-smoke.mjs`'s
 * fixture, which has no YouTube player chrome in it at all, and neither is worth
 * a browser to check. `ui/embed-state.js` is the precedent and this is the
 * same shape: the decision is pure and asserted here; the wire is in
 * `content.js` and asserted in the browser.
 *
 * IT IS A CLASSIC SCRIPT, NOT A MODULE, and that is not an oversight. It is
 * listed in `manifest.overlay.json` ahead of `content.js` in the same
 * `content_scripts` entry, so both run in the same isolated world and a
 * top-level `var` here is what `content.js` reads. A content script cannot
 * `import`. Node runs the same file as ESM (`package.json` "type": "module"),
 * where the `var` is module-scoped and the self-check below is its only reader —
 * so the one file is honest in both hosts without a build step.
 */

/**
 * YouTube's own autoplay-next control, in the right-hand player controls. It
 * carries `aria-checked="true"|"false"`, and a synthetic `.click()` from the
 * isolated world reaches YouTube's handler — which is the whole reason this is
 * the mechanism rather than something of ours.
 *
 * THE PREVIOUS SELECTOR WAS `button.ytp-autonav-toggle-button` AND IT MATCHED
 * NOTHING ON A REAL WATCH PAGE. Measured 2026-08-15 against youtube.com, in the
 * `ytp-delhi-modern` control bar every user is now on:
 *
 *     .ytp-right-controls
 *       .ytp-right-controls-left                            <- new wrapper
 *         button.ytp-button.ytp-autonav-toggle              <- the CONTROL
 *           div.ytp-autonav-toggle-button-container
 *             div.ytp-autonav-toggle-button[aria-checked]   <- the STATE
 *
 * The class did not move; the ELEMENT under it did — it is a `<div>` inside the
 * button now, not the button. So both halves of the old selector failed on the
 * tag, the feature reported `missing` on every real video, and the only thing
 * that made that survivable is that `missing` is a reported state with a banner
 * rather than a swallowed no-op. Nobody saw the banner because it was drawn
 * inside the region YouTube's ambient glow was painting over (see `mount()` in
 * content.js) — two defects, one invisible because of the other.
 *
 * SO THIS IS NOW THE UPGRADE PATH THE OLD NOTE NAMED: match on the ARIA
 * contract, `[class*="autonav-toggle"][aria-checked]`, scoped to the player
 * controls. `aria-checked` outlives the markup because a11y tooling depends on
 * it and YouTube's own CSS does not. The element carrying the state is also the
 * element we click — its click bubbles to the button, verified on the real page:
 * `aria-checked` flips true -> false in the same tick.
 *
 * ponytail: ceiling — this is still YouTube's private markup and a rename of
 * `autonav` itself would still take the feature out. That remains survivable for
 * the same reason as before, and `tools/embed-smoke.mjs` now reproduces the
 * markup above rather than the markup we wish they had — the fixture asserting
 * against a control YouTube stopped shipping is what kept this green for a
 * whole release.
 */
var AUTONAV_TOGGLE_SEL = '.ytp-right-controls [class*="autonav-toggle"][aria-checked],'
  + ' [class*="ytp-autonav-toggle"][aria-checked]';

/**
 * The late fallback, and only a fallback: once the end screen is up, this is the
 * button that cancels the countdown YouTube has already started. It exists for
 * exactly the window in which the toggle route has already failed, so reaching
 * for it is not evidence that anything is well.
 */
var AUTONAV_CANCEL_SEL = '.ytp-autonav-endscreen-upnext-cancel-button';

/** `chrome.storage.local` key holding this build's user preferences. */
var PREFS_KEY = 'prefs';

/**
 * THE SETTING, resolved. Absent means SUPPRESS: that is the behaviour the
 * product asks for out of the box, so a fresh profile with no stored preference
 * and a profile that explicitly chose suppression must resolve identically.
 *
 * Only the literal `true` turns suppression off. A truthy-but-not-true value in
 * storage (a half-written migration, a string "false") means the record is not
 * one we wrote, and the safe reading of a record we do not recognise is the
 * default rather than its opposite.
 *
 * @param {{autoplayNext?: boolean}|null|undefined} prefs
 * @returns {boolean} true = suppress YouTube's autoplay-next
 */
function resolveSuppress(prefs) {
  return !(prefs && prefs.autoplayNext === true);
}

/**
 * THE ONE DECISION. Called from exactly one place — `syncAutonav()` in
 * `content.js` — and every assertion below is about that entry point.
 *
 * @param {object} s
 * @param {boolean} s.suppress  resolved setting: true = suppress autoplay-next
 * @param {boolean} s.engaged   is the deck up on a watch page right now
 * @param {boolean} s.found     was the toggle located in the page
 * @param {boolean|null} s.checked  its `aria-checked`, or null if unreadable
 * @param {boolean|null} s.original the value we recorded BEFORE we first
 *                                  touched it, or null if we never have
 * @returns {{act:'idle'|'hold'|'click'|'missing'|'lost',
 *            want:boolean|null, remember:boolean, forget:boolean, state:string}}
 */
function autonavPlan(s) {
  const st = s || {};
  const engaged = st.engaged === true;
  const suppress = st.suppress === true;
  const found = st.found === true;
  const checked = typeof st.checked === 'boolean' ? st.checked : null;
  const original = typeof st.original === 'boolean' ? st.original : null;

  // IMPOSING vs RESTORING, and they are not the same job. Imposing wants one
  // specific value. Restoring wants the value we found, and only exists at all
  // once we have taken one.
  const imposing = engaged && suppress;
  const want = imposing ? false : original;
  const restoring = !imposing && original !== null;

  if (want === null) {
    return { act: 'idle', want: null, remember: false, forget: false, state: 'idle' };
  }

  /**
   * WE HAVE AN OPINION AND CANNOT ACT ON IT. Both branches are failures and
   * both are reported — the shape this deliberately is NOT is
   * `!el || (real check)`, which returns "fine" precisely when there is nothing
   * to look at (AGENTS.md, four logged instances).
   *
   * `found && checked === null` lands here too, on purpose: an element whose
   * state we cannot read is not a control we may click. Clicking a toggle
   * blind is how you set it to the opposite of what was asked.
   */
  if (!found || checked === null) {
    return restoring
      ? { act: 'lost', want, remember: false, forget: false, state: 'lost' }
      : { act: 'missing', want, remember: false, forget: false, state: 'missing' };
  }

  if (checked === want) {
    // Restored, so the remembered value has done its job. Holding it would make
    // the NEXT video's control get a value read off a page two navigations ago.
    return {
      act: 'hold', want, remember: false, forget: restoring,
      state: imposing ? 'off' : 'restored',
    };
  }

  return {
    act: 'click', want,
    // Record what we are about to overwrite, once, before the first click.
    remember: imposing && original === null,
    forget: false, state: 'pending',
  };
}

// ------------------------------------------------------------------- check
function demo() {
  let fails = 0;
  const eq = (got, want, what) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) { console.error(`FAIL ${what}\n  got  ${g}\n  want ${w}`); fails++; }
    else console.log(`ok   ${what}`);
  };

  // --- resolveSuppress ----------------------------------------------------
  eq(resolveSuppress(undefined), true,
    'NO STORED PREFERENCE SUPPRESSES. A fresh profile gets the ruled default, not YouTube\'s');
  eq(resolveSuppress({}), true, '...and so does a prefs record that predates this key');
  eq(resolveSuppress({ autoplayNext: false }), true, 'an explicit "do not autoplay" suppresses');
  eq(resolveSuppress({ autoplayNext: true }), false,
    'and the ONLY thing that hands autoplay back to YouTube is the literal true');
  eq(resolveSuppress({ autoplayNext: 'true' }), true,
    '...not a string that looks like it — an unrecognised record reads as the default, never as its opposite');
  eq(resolveSuppress(null), true, 'a null record is not a preference');

  // --- autonavPlan --------------------------------------------------------
  const P = (o) => autonavPlan({
    suppress: true, engaged: true, found: true, checked: true, original: null, ...o,
  });

  // The main line: deck up, setting on, YouTube's toggle is on -> turn it off.
  eq(P({}), { act: 'click', want: false, remember: true, forget: false, state: 'pending' },
    'deck up + suppression on + autonav ON -> click it off, remembering what we overwrote');
  eq(P({ checked: false }),
    { act: 'hold', want: false, remember: false, forget: false, state: 'off' },
    '...and an autonav that is ALREADY off is left alone — and never remembered, so we never restore a value we did not take');
  eq(P({ checked: false, original: true }),
    { act: 'hold', want: false, remember: false, forget: false, state: 'off' },
    '...nor re-clicked once we have taken it, which is what makes this safe to call at 4 Hz');
  eq(P({ checked: true, original: true }).remember, false,
    'the original is recorded ONCE. A second record after YouTube re-rendered the control would save OUR value as theirs');

  // Restoring.
  eq(P({ engaged: false, original: true, checked: false }),
    { act: 'click', want: true, remember: false, forget: false, state: 'pending' },
    'the deck came down and the control still reads the false WE set -> click it back to the true we took');
  eq(P({ engaged: false, original: false, checked: false }),
    { act: 'hold', want: false, remember: false, forget: true, state: 'restored' },
    '...and a user who had autonav off already gets no click at all, just the record dropped');
  eq(P({ engaged: false, original: true, checked: true }),
    { act: 'hold', want: true, remember: false, forget: true, state: 'restored' },
    'once the control reads what we took, the restore is DONE and the memory is dropped');
  eq(P({ engaged: false, original: null }),
    { act: 'idle', want: null, remember: false, forget: false, state: 'idle' },
    'a deck that never touched anything has nothing to put back');

  // The setting turned off while the deck is still up.
  eq(P({ suppress: false, original: true, checked: false }),
    { act: 'click', want: true, remember: false, forget: false, state: 'pending' },
    'turning the SETTING off mid-video restores immediately — the deck does not have to come down first');
  eq(P({ suppress: false, original: true, checked: true }).forget, true,
    '...and drops the record when it lands, so the toggle is YouTube\'s again');
  eq(P({ suppress: false, original: null }),
    { act: 'idle', want: null, remember: false, forget: false, state: 'idle' },
    'suppression off and nothing taken -> we are not in this control\'s business at all');

  /**
   * THE FAILURE BRANCH, which is the reason this file exists. Every one of
   * these must produce a NAMED state that `content.js` reports. The shape
   * being avoided is `!el || (check)` — "fine" returned precisely when there is
   * nothing to look at.
   */
  eq(P({ found: false, checked: null }),
    { act: 'missing', want: false, remember: false, forget: false, state: 'missing' },
    'THE CONTROL IS NOT THERE and we wanted to suppress -> missing. Not idle, not hold, not silence');
  eq(P({ found: true, checked: null }),
    { act: 'missing', want: false, remember: false, forget: false, state: 'missing' },
    '...and an element whose aria-checked we cannot READ counts as missing — a toggle clicked blind lands on the wrong value half the time');
  eq(P({ found: false, checked: null, engaged: false, original: true }),
    { act: 'lost', want: true, remember: false, forget: false, state: 'lost' },
    'the control vanished while we still owed a restore -> LOST, reported separately: their preference is still flipped');
  eq(P({ found: false, checked: null, engaged: false, original: true }).forget, false,
    '...and the record is KEPT, so landing on the next watch page can still put it back');
  eq(P({ found: false, checked: null, engaged: false, original: null }),
    { act: 'idle', want: null, remember: false, forget: false, state: 'idle' },
    'but no control on a page we have no opinion about is not a failure — the home page must not cry wolf');
  eq(P({ found: false, checked: null, suppress: false, original: null }).act, 'idle',
    '...and neither is a missing control when the user asked us to leave autoplay alone');

  eq(autonavPlan(undefined),
    { act: 'idle', want: null, remember: false, forget: false, state: 'idle' },
    'no state at all does nothing');

  process.exitCode = fails ? 1 : 0;
  console.log(fails ? `\n${fails} FAILED` : '\nautonav: all checks passed');
}

if (typeof process !== 'undefined' && Array.isArray(process.argv)
    && String(process.argv[1] || '').endsWith('autonav.js')) demo();
