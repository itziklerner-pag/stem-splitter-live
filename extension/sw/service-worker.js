/**
 * Service worker = permission broker + router + the only thing allowed to
 * persist. It holds no audio and no module-scope state that matters: it is
 * killed after 30 s idle and every handler rehydrates from chrome.storage.
 *
 * The one thing only this context can do: chrome.tabCapture.getMediaStreamId().
 * And the per-tab kTabCaptureForTab grant it needs is only issued by
 * ActiveTabPermissionGranter on a real browser-level invocation — a toolbar
 * action click, a context-menu item, or a chrome.commands shortcut.
 * A button click inside the page's deck is NOT one of them (ARCHITECTURE §7 R4).
 * That is why arming lives here and not in the UI.
 */

import { ARM_ERROR_KEY } from '../shared/config.js';
import { BUS } from '../shared/host.js';

/**
 * THE BUS ADDRESSES COME FROM THE SEAM'S DECLARATION, not from literals here.
 *
 * This context is the Host's privileged half and it is the ORIGIN of three of
 * the four messages the unit cannot send itself (`CAPTURE_START`,
 * `CAPTURE_STOP`, `DECK_PREPARE`) — so it has to know how the unit is
 * addressed, and until Host interface v1 (S11) it knew by spelling `'off'`,
 * `'ui'` and `'sw'` five times. Change the unit's address and this file goes on
 * shouting into the old one: the arm gesture stops arming, with nothing in any
 * console, because a broadcast nobody is listening for looks exactly like a
 * broadcast that worked.
 *
 * `'tab'` BELOW IS DELIBERATELY NOT ONE OF THEM. It addresses `content.js`, and
 * that is Host talking to Host — the unit never sees the message and has no word
 * for the context. Putting it in `BUS` would put a Host's private address inside
 * the unit's declaration of its own protocol.
 */

const OFFSCREEN_URL = 'offscreen/offscreen.html';

// ---------------------------------------------------------------- persistence
/**
 * ONE armed tab. THE STORED RECORD KEEPS THE SHAPE IT HAS ALWAYS HAD —
 * `{tabId, title, url, armedAt}` — because it is this Host's own bookkeeping:
 * `startCapture()` needs the tab id to mint a capture token, `chrome.tabs`
 * events key off it, and `tools/embed-smoke.mjs` reads
 * `chrome.storage.session`'s copy directly.
 *
 * WHAT GOES ON THE WIRE IS NOT THIS RECORD — see `sessionForDeck()`. S11 froze
 * Host interface v1, and a deck that answered "am I armed?" with `!!tabId` was
 * the last place the unit knew what a tab was.
 */
const KEY = 'session';
const EMPTY = { tabId: null, title: null, url: null, armedAt: null };

/**
 * THE SESSION RECORD AS THE DECK IS ALLOWED TO SEE IT — `{armed, title, url,
 * armedAt}`, and `armed` is a boolean this Host derives rather than a tab id
 * the deck reads the truthiness of.
 *
 * This is one of the three messages a Host must ORIGINATE for the deck
 * (`shared/host.js`, `DeckHost.onMessage`), so its shape is part of Host
 * interface v1 and not of this file's convenience. The translation is HERE, in
 * the Host, because that is the whole of what a seam is for: a second Host with
 * no tabs answers `armed` from whatever it does have, and the deck's four
 * `session.armed` reads do not move.
 *
 * `title` and `url` describe the Source and travel unchanged; the deck reads
 * neither today (the page behind the frame shows both) and they are on the wire
 * because the record has carried them since 0.1.0.
 */
const sessionForDeck = (s) => ({
  armed: !!s.tabId, title: s.title, url: s.url, armedAt: s.armedAt,
});

async function getSession() {
  const got = await chrome.storage.session.get(KEY);
  return got[KEY] || { ...EMPTY };
}
async function setSession(s) {
  await chrome.storage.session.set({ [KEY]: s });
  chrome.runtime.sendMessage({
    v: 1, to: BUS.deck, from: BUS.host, type: 'SESSION', session: sessionForDeck(s),
  }).catch(() => {});
}

function toUi(msg) {
  chrome.runtime.sendMessage({ v: 1, to: BUS.deck, from: BUS.host, ...msg }).catch(() => {});
}

// ------------------------------------------------------- the durable refusal
/**
 * `toUi` is fire-and-forget by construction: `sendMessage` with nothing
 * listening rejects into a `.catch(() => {})`. For STATE-ish chatter that is
 * correct — the next tick carries the same truth. **For a refusal it is a
 * defect**: the user performed a gesture, was told no, and the no was discarded
 * because the side panel had not finished booting. That is the same disease as
 * a watchdog whose precondition its own failure cannot satisfy, one altitude
 * down — see the durable-refusal contract above.
 *
 * So a refusal is BOTH sent and persisted. The message is the live path and is
 * unchanged; this is a durable fallback beside it, read by every surface on boot.
 *
 * SERIALISED, and not with a compare-and-swap. `chrome.storage` has no atomic
 * read-modify-write, so a CAS on `seq` would be a CAS in name only. Every raise
 * and every clear goes through this one promise chain instead, which is what
 * makes "a clear cannot race a raise" true rather than likely.
 */
let armChain = Promise.resolve();
const armSerial = (fn) => (armChain = armChain.then(fn, fn));

function raiseArm(code, message) {
  return armSerial(async () => {
    const prev = (await chrome.storage.session.get(ARM_ERROR_KEY))[ARM_ERROR_KEY];
    await chrome.storage.session.set({
      // `at` is EPOCH ms and it is the moment of the RAISE — not of the read and
      // not of the render. performance.now() would be wrong here for a reason
      // that is easy to miss: its origin differs per context, and this record is
      // written in the service worker and read in a page.
      [ARM_ERROR_KEY]: { code, message, at: Date.now(), seq: ((prev && prev.seq) || 0) + 1 },
    });
    toUi({ type: 'ARM_ERROR', code, message });
  });
}

/**
 * `seq` is the record's identity, and the dismissal path needs it: a user
 * dismissing the banner they can SEE must never delete a newer refusal that
 * landed while their finger was moving. `seq == null` means "clear whatever is
 * there" and is only used by the successful-arm path, which is authoritative.
 */
function clearArm(seq = null) {
  return armSerial(async () => {
    if (seq != null) {
      const cur = (await chrome.storage.session.get(ARM_ERROR_KEY))[ARM_ERROR_KEY];
      if (!cur || cur.seq !== seq) return;   // a newer refusal owns the slot
    }
    await chrome.storage.session.remove(ARM_ERROR_KEY);
    toUi({ type: 'ARM_ERROR_CLEARED' });
  });
}

// ------------------------------------------------------------------ offscreen
let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (ctxs.length) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // NEVER add 'AUDIO_PLAYBACK' — but not for the reason this comment used to
    // give, and the difference matters because someone will try to "fix" live
    // mode by adding it.
    //
    //   * AUDIO_PLAYBACK's reaper is a SILENCE reaper. R0's Q6b measured 30-60 s
    //     because R0's document was silent. Re-measured with a continuous
    //     oscillator: the document survived 332 s, i.e. it never fires while
    //     audio is actually playing (tools/audible-probe.mjs --tone
    //     --reasons AUDIO_PLAYBACK --seconds 330).
    //   * It is still wrong for us, because `reasons` are fixed at
    //     createDocument time and ONE document serves both modes. Export runs
    //     long SILENT inference jobs — a 10-minute track is minutes of silence —
    //     and would be reaped mid-job.
    //   * And it buys nothing: an offscreen document with exactly these three
    //     reasons is fully audible. Measured at the DAC through a loopback
    //     device, 997 Hz at amplitude 0.106 (tools/audible-probe.mjs --tone).
    //     Chrome does not gate audio output on the declared reason.
    //
    // These three impose no lifetime limit (R0 held one alive for 420 s).
    reasons: ['USER_MEDIA', 'WORKERS', 'BLOBS'],
    justification:
      'Captures the user\'s own tab audio via getUserMedia, runs on-device stem ' +
      'separation in a worker, and writes the result to origin-private storage. ' +
      'None of this is possible in a service worker.',
  });
  try { await creating; } finally { creating = null; }
}

// -------------------------------------------------------------------- arming
/**
 * The ONE thing that has to happen inside a browser-level invocation:
 * ActiveTabPermissionGranter issues kTabCaptureForTab here and nowhere else.
 * Both entry points below qualify — a toolbar action click and a chrome.commands
 * keyboard shortcut are the same kind of event as far as the granter is
 * concerned. A button inside the page's deck is NOT (ARCHITECTURE §7 R4).
 */

/**
 * Tell the ARMED TAB's own content script.
 *
 * The deck is drawn INSIDE the page, so the tab is the surface this gesture is
 * for and the only one that can be shown by it. `chrome.runtime.sendMessage`
 * does not reach content scripts — that is a `chrome.tabs.sendMessage`, per tab,
 * and it rejects when no content script is listening (any tab that is not
 * YouTube). Hence the catch and hence fire-and-forget.
 *
 * `mode` is the difference between the two calls below and it is not cosmetic.
 * 'toggle' is the show/hide gesture on a tab that just armed. 'show' is a
 * refusal, and a refusal must never be able to hide the surface it needs to be
 * read on.
 */
function notifyTab(tabId, mode) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { v: 1, to: 'tab', from: BUS.host, type: 'STEM_SPLITTER_LIVE_EMBED', mode }).catch(() => {});
}

/**
 * ONE DECK, so an arm has nothing to resolve: it points the deck at this tab.
 * Re-arming the SAME tab refreshes the grant — that is the "the grant expired,
 * click again" flow the deck instructs on NOT_CAPTURING — and arming a
 * different tab re-points the deck, which is the only thing a single-deck
 * product can mean by the gesture.
 */
async function armTab(tab) {
  if (!tab.id || (tab.url || '').startsWith('chrome://') || (tab.url || '').startsWith('chrome-extension://')) {
    await raiseArm('TAB_UNSUPPORTED', 'Chrome pages cannot be captured. Switch to the tab that is playing audio and click the toolbar icon there.');
    return;
  }

  await ensureOffscreen();
  // The invocation above granted kTabCaptureForTab on this tab. It survives until
  // the tab closes or navigates cross-origin, so the stream id can be minted
  // later, when the user presses Start.
  await setSession({ tabId: tab.id, title: tab.title || `Tab ${tab.id}`, url: tab.url || '', armedAt: Date.now() });
  // CLEAR SITE 1 of 2: a successful arm answers whatever the last refusal was
  // saying. Unconditional — this path is authoritative and is the reason a stale
  // refusal cannot outlive the problem it described.
  await clearArm();
  // Last, and only on the path that actually armed: show or hide the in-page
  // deck. Ordering matters — the page reads the session on boot, so it must be
  // written before the page is told to exist.
  notifyTab(tab.id, 'toggle');
}

/**
 * `.catch` is not decoration. This listener cannot `await`, so without it any
 * rejection inside armTab — `ensureOffscreen()` losing a createDocument race is
 * the realistic one — becomes an unhandled rejection in a service worker nobody
 * has devtools open on, and the gesture does nothing and says nothing.
 */
chrome.action.onClicked.addListener((tab) => {
  armTab(tab).catch((e) => toUi({
    type: 'ARM_ERROR', code: 'ARM_FAILED',
    message: `Arming failed: ${String((e && e.message) || e)}`,
  }));
});

/**
 * Keyboard equivalent of the toolbar click. It exists for two reasons and both
 * matter: a DJ should not have to reach for the mouse, and it is the ONLY way to
 * exercise tabCapture end to end without a human — macOS refuses synthetic
 * clicks on browser chrome, but a CDP-dispatched key event reaches the command
 * dispatcher and grants the same permission. `tools/embed-smoke.mjs` is the gate
 * that depends on it.
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'arm-tab') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    // No active tab is a real outcome of this gesture, not an impossibility —
    // pressing the chord with only a popup window focused reaches it. Saying
    // nothing here is what "I pressed it and nothing happened" is made of.
    if (!tab) {
      await raiseArm('NO_ACTIVE_TAB',
        'No active tab to arm. Focus the tab that is playing audio and press the shortcut there.');
      return;
    }
    await armTab(tab);
  } catch (e) {
    await raiseArm('ARM_FAILED', `Arming failed: ${String((e && e.message) || e)}`);
  }
});

const ARM_ERRORS = [
  [/has not been invoked/i, 'NEEDS_GESTURE', 'Chrome revoked the capture grant for that tab. Switch to it and click the toolbar icon again.'],
  [/active stream/i, 'TAB_BUSY', 'That tab is already being captured (by us or another extension). Stop the other capture first.'],
  [/Invalid tab|finding tab/i, 'TAB_GONE', 'That tab is gone. Open it again and click the toolbar icon.'],
];

async function startCapture() {
  const s = await getSession();
  if (!s.tabId) {
    await raiseArm('NOT_ARMED', 'No tab armed. Click the toolbar icon on the tab you want to capture.');
    return;
  }
  await ensureOffscreen();
  let sourceToken;
  try {
    sourceToken = await chrome.tabCapture.getMediaStreamId({ targetTabId: s.tabId });
  } catch (e) {
    const msg = String(e.message || e);
    const hit = ARM_ERRORS.find(([re]) => re.test(msg));
    await raiseArm(hit ? hit[1] : 'ARM_FAILED', (hit ? hit[2] : msg) + ` [${msg}]`);
    return;
  }
  /**
   * `sourceToken`, NOT `streamId`, AND THE SOURCE HAS NO TAB ID — Host
   * interface v1, frozen in S11. Both names were Chrome's leaking through a
   * wire the unit is forbidden to know the Host of: the engine carries the
   * token straight back to `host.captureStream()` without looking inside it
   * (`offscreen/engine.js` `captureStart()`), and it never read `source.tabId`
   * at all — the engine's own dev paths wrote `tabId: null` to satisfy a shape
   * nothing consumed. `source` describes the Source, so it is `{title, url}`:
   * the two fields the engine really reads, at `engine.js`'s `videoIdFromUrl`
   * and the cache entry's title.
   */
  chrome.runtime.sendMessage({
    v: 1, to: BUS.engine, from: BUS.host, type: 'CAPTURE_START', sourceToken,
    source: { title: s.title, url: s.url },
  }).catch(() => {});
}

// ------------------------------------------------------------------- routing
chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (!m || m.to !== BUS.host) return;
  (async () => {
    switch (m.type) {
      case 'SW_STATUS':
        await ensureOffscreen();
        toUi({ type: 'SESSION', session: sessionForDeck(await getSession()) });
        break;
      case 'SW_ENSURE_OFFSCREEN':
        await ensureOffscreen();
        break;
      case 'SW_DECK_PREPARE':
        /**
         * Create a deck's ORT session ahead of time, with a DELIVERY GUARANTEE.
         *
         * `DECK_PREPARE` sent straight to the offscreen document is dropped on
         * the floor when that document does not exist yet — `sendMessage`
         * rejects into a catch and nothing happens. The symptom is not a missing
         * ack: it is an 8 s stall two minutes later, on the OTHER deck, when the
         * session gets created at the worst possible moment instead. A message
         * whose failure mode is invisible and delayed must not be fire-and-forget.
         *
         * Only this context can fix it, because only this context can create the
         * offscreen document. `ensureOffscreen()` is awaited first, so by the time
         * the message is posted there is something listening. The caller can then
         * drop its retry.
         */
        await ensureOffscreen();
        chrome.runtime.sendMessage({
          v: 1, to: BUS.engine, from: BUS.host, type: 'DECK_PREPARE',
        }).catch(() => {});
        break;

      case 'SW_CAPTURE_START':
        await startCapture();
        break;
      /**
       * CLEAR SITE 2 of 2 — explicit dismissal, from the deck's banner dismiss
       * control and from the eject button.
       *
       * It carries the `seq` the UI was SHOWING. A dismissal is a statement
       * about a specific refusal the user read, so a clear whose `seq` no longer
       * matches the stored one is dropped rather than applied: the alternative
       * is a user's dismissal silently deleting a newer refusal that landed
       * while their finger was moving.
       */
      case 'SW_ARM_ERROR_CLEAR':
        await clearArm(Number.isFinite(m.seq) ? m.seq : null);
        break;
      case 'SW_DISARM':
        await setSession({ ...EMPTY });
        break;
    }
    sendResponse({ ok: true });
  })().catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;   // async response
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getSession();
  if (s.tabId !== tabId) return;
  await setSession({ ...EMPTY });
  // Stop the capture too, or its MediaStream track sits in the offscreen
  // document holding a dead tab and the deck plays 7.8 s of history forever.
  // The offscreen document cannot see chrome.tabs; only here can.
  chrome.runtime.sendMessage({ v: 1, to: BUS.engine, from: BUS.host, type: 'CAPTURE_STOP' }).catch(() => {});
  await raiseArm('TAB_GONE', 'The captured tab was closed.');
});

/**
 * ASK ABOUT THE MODEL DOWNLOAD AT INSTALL, not at the moment it is needed.
 *
 * The deck already prompts before fetching anything, and that prompt stays —
 * but the first time it fires is the first time the user presses play, which is
 * the worst moment to be handed a several-minute download. Doing it here means
 * the model is usually already on disk by the time it matters, and the user
 * learns the one honest fact about this product's network use (there is exactly
 * one request, and it is this one) while they are reading rather than waiting.
 *
 * A TAB, NOT A DIALOG. An extension cannot put a modal over browser chrome at
 * install time; `chrome.tabs.create` is the platform's onboarding gesture. It is
 * also skippable, which a modal would not be.
 *
 * `reason === 'install'` only. An update or a browser restart must not reopen
 * it — that is the difference between onboarding and a nag.
 */
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/welcome.html') }).catch(() => {});
});
