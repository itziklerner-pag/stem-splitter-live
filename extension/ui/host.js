/**
 * The deck's Host, as a Chrome extension. This is the ONE module `embed.js` is
 * allowed to import that knows what `chrome` is; the duties it implements and
 * the rules they have to hold are written down in `../shared/host.js`.
 *
 * It is six functions long on purpose. The seam is not an abstraction layer —
 * "no abstraction with one implementation" is a standing rule here — it is the
 * list of things a second application would have to supply, kept short enough
 * that the list itself is the specification.
 *
 * LATE BINDING IS THE WHOLE POINT OF THE `send` BODY. `chrome.runtime.sendMessage`
 * is looked up when the message is sent, not when this module is imported,
 * because `tools/embed-smoke.mjs` replaces that PROPERTY after the deck has
 * booted and that patch is the only window onto the outgoing wire. Write
 * `chrome.runtime.sendMessage.bind(chrome.runtime)` here and the recorder stays
 * empty for the rest of the run, taking the transpose-ceiling and speed/ad-gate
 * assertions green-on-nothing with it. See rule 2 in `../shared/host.js`.
 */

/**
 * This context's address on the bus. The deck's outbound envelope is composed
 * in `embed.js` (`to: 'off'` / `to: 'sw'`, `from: 'ui'`) because the addresses
 * are the unit's protocol; the host reads `to` in exactly one place, here, to
 * answer the one question only the transport can — "is this one mine?"
 */
const ME = 'ui';

/** @type {import('../shared/host.js').DeckHost} */
export const host = {
  /**
   * Fire and forget. No return value, and the rejection is swallowed rather
   * than reported: on this bus there is very often no listener, and an
   * unhandled rejection per message is a console nobody can read.
   */
  send(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  },

  /**
   * `return false` is not a formality. MV3 reads a truthy return from a
   * message listener as "I will call `sendResponse` asynchronously" and keeps
   * the channel open waiting for it — so the deck's handler must not be able
   * to hold one open by accident, and its return value is dropped here.
   */
  onMessage(fn) {
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.to === ME) fn(m);
      return false;
    });
  },

  /**
   * `chrome.storage[area]` and not a pair of branches: the two areas are the
   * same API under two lifetimes, and a `if (area === 'session')` here would be
   * a third place to edit the day a third lifetime is wanted.
   *
   * THE UNWRAP IS THE DUTY. `chrome.storage[area].get(key)` answers with a BAG —
   * `{ [key]: value }`, or `{}` when nothing is stored — and every caller of the
   * raw API therefore writes `got && got[key]`, which is the same expression
   * whether the read succeeded and found nothing or the read succeeded and found
   * a stored `undefined`. Answering with the value collapses that at the seam,
   * once, and `key in got` is what keeps "absent" distinct from "stored as
   * undefined" while doing it.
   *
   * `async`, SO A BAD AREA IS A REJECTION AND NOT A THROW. `chrome.storage.nope`
   * is `undefined` and `.get` on it throws SYNCHRONOUSLY; inside an `async`
   * method that becomes a rejected promise, which is the one thing the deck's
   * two readers are already written to survive. Rule 6: a read that could not
   * happen must not look like a key that was not there.
   */
  async storageGet(area, key) {
    const got = await chrome.storage[area].get(key);
    return got && key in got ? got[key] : null;
  },

  /**
   * Fire and forget, exactly like `send` and for the same reason: the value is
   * already on screen, so there is nothing a rejection could tell the user that
   * the next read would not tell them better. Returns undefined so no call site
   * can start awaiting a write.
   */
  storageSet(area, key, value) {
    chrome.storage[area].set({ [key]: value }).catch(() => {});
  },

  /**
   * The area and key filter is the host's, exactly as the address guard on
   * `onMessage` is: `chrome.storage.onChanged` is one listener for every area
   * and every key in the extension, so unpicking `(changes, area)` down to "the
   * one value you asked about" is transport work and not the deck's.
   *
   * `changes[key]` RATHER THAN `key in changes`: a change record is present only
   * for the keys that moved, and its `newValue` is absent when the key was
   * REMOVED. `fn(undefined)` is then the honest report of a removal, which is
   * what the deck's `applyPrefs` already treats as "no preferences stored".
   */
  onStorageChanged(area, key, fn) {
    chrome.storage.onChanged.addListener((changes, changedArea) => {
      if (changedArea !== area || !changes[key]) return;
      fn(changes[key].newValue);
    });
  },

  /**
   * The arm chord, READ FROM CHROME rather than typed into the markup, because
   * the user can rebind it at chrome://extensions/shortcuts and a surface that
   * states a chord the browser is not bound to is worse than one that omits it.
   *
   * RAW. What comes back is whatever Chrome spells it as — `'Ctrl+Shift+9'` off
   * a Mac, and `'⌃⇧9'` on one, already drawn, NOT the `'MacCtrl+Shift+9'` token
   * the manifest declares. Both forms are `chordLabel()`'s job in the unit, and
   * the raw string is printed by `tools/embed-smoke.mjs`, which is the only
   * place in this repo that records what Chrome actually returns.
   *
   * `'arm-tab'` IS THE MANIFEST'S COMMAND NAME and this is the fourth copy of
   * that literal — `manifest.json`, `sw/service-worker.js` and `ui/welcome.js`
   * carry the others. It cannot come from `shared/config.js`, because the name
   * of a Chrome command is host vocabulary and the unit must not learn it. All
   * four are pinned: `tools/tree-check.mjs` asserts the manifest declares
   * exactly `[arm-tab]`, and `tools/embed-smoke.mjs` presses the chord and reads
   * `getAll()` back through the real extension.
   *
   * `null` AND NOT `''` for a command with no chord bound, so the caller can
   * print a different sentence instead of an empty key cap. A missing
   * `chrome.commands` REJECTS rather than resolving null, for rule 6's reason:
   * "there is no such API here" and "the user has unbound the chord" are two
   * different facts and only one of them is the user's doing.
   */
  async armShortcut() {
    const all = await chrome.commands.getAll();
    const cmd = (all || []).find((c) => c.name === 'arm-tab');
    return (cmd && cmd.shortcut) || null;
  },
};
