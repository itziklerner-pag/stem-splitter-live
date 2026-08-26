/**
 * The deck's Host, as a Chrome extension. This is the ONE module `embed.js` is
 * allowed to import that knows what `chrome` is; the duties it implements and
 * the rules they have to hold are written down in `../shared/host.js`.
 *
 * It is two functions long on purpose. The seam is not an abstraction layer —
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
};
