/**
 * The deck's Host, as a Chrome extension. This is the ONE module `embed.js` is
 * allowed to import that knows what `chrome` is or what a frame is; the duties
 * it implements and the rules they have to hold are written down in
 * `../shared/host.js`.
 *
 * It is six callable duties and two namespaces long on purpose. The seam is
 * not an abstraction layer — "no abstraction with one implementation" is a
 * standing rule here — it is the list of things a second application would
 * have to supply, kept short enough that the list itself is the specification.
 *
 * TWO WIRES LEAVE THROUGH HERE AND THEY ARE NOT THE SAME WIRE.
 *  - `send` / `onMessage` ride `chrome.runtime`, the EXTENSION BUS: a broadcast
 *    between the deck, the engine and the service worker. The envelope on it is
 *    the UNIT's (`{ v, to, from }`) and this file carries it verbatim.
 *  - `page` / `transport` ride `postMessage` across the IFRAME BOUNDARY to
 *    `content.js`, which is the host's own other end. That protocol —
 *    `from: 'stem-splitter-live'` out, `from: 'stem-splitter-live-host'` back —
 *    is entirely the HOST's, so this file is free to name its own fields, and
 *    it does: the seam speaks ADR 0001 decision 4's `currentTime` where the
 *    wire says `seekTo`.
 *
 * The remaining four — `storageGet`, `storageSet`, `onStorageChanged` and
 * `armShortcut` — are not a wire at all. They read and write platform state
 * (`chrome.storage`, `chrome.commands`) that has no other end to talk to.
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

/**
 * THE ONLY TWO AREAS THIS HOST WILL INDEX, and the refusal is a P1 guard rather
 * than type theatre.
 *
 * `chrome.storage[area]` is an index into the whole namespace, and the
 * `'local'|'session'` union next door is a JSDoc comment that runs nowhere. So
 * before this list existed, `storageSet('sync', …)` from the deck WOULD HAVE
 * WORKED — and `chrome.storage.sync` is a network write, which is the one thing
 * CONTRIBUTING.md P1 forbids after the model download and SECURITY.md promotes
 * to a security property. Until the areas became a parameter, `sync` was
 * unreachable from the deck by construction, because every call site read
 * `chrome.storage.local` literally. This keeps that impossibility while keeping
 * the parameter.
 *
 * IT ALSO GIVES A SECOND HOST A DEFINED ANSWER instead of an accident. Without
 * it an unexpected area was undefined behaviour that HAPPENED to reject on
 * `storageGet` (`undefined.get` inside an `async` method) and HAPPENED to throw
 * synchronously on the other two. Both refusals are now deliberate, both are
 * asserted in `test.js`, and rule 5 in `../shared/host.js` says which is which:
 * `storageGet` rejects, because one of its two call sites is a module-scope
 * `.then().catch()` that a synchronous throw jumps straight past; the other two
 * throw at the call site, because a wrong area there is a bug in the deck rather
 * than a failure of the platform, and the cheapest place to be told is the line
 * that wrote it.
 */
const AREAS = ['local', 'session'];

/**
 * @param {string} area
 * @returns {string} `area`, so the check reads inline at the index it guards
 */
function assertArea(area) {
  if (!AREAS.includes(area)) {
    throw new Error(`DeckHost: ${JSON.stringify(area)} is not a storage area this unit uses `
      + `— it names one of ${AREAS.join(', ')}, and a lifetime it did not ask for is not the Host's to pick.`);
  }
  return area;
}

/**
 * THE DECK -> HOST NAMESPACE, and the one place in the unit that spells it.
 *
 * It used to be typed out at each of the eight posting sites in `embed.js`;
 * they are all in this file now, so one constant is the honest shape. Its
 * counterpart is the guard in `content.js`, and `tools/name-check.mjs` pairs
 * the two — a slice that moved the posters and forgot the guard, or the other
 * way round, is a rename that half-landed, which is the failure that gate was
 * written for. Keep it a single-quoted literal on both sides: the gate counts
 * the literal, so a template string is the same as deleting it.
 */
const NS = 'stem-splitter-live';

/**
 * IS THERE A PAGE ABOVE THIS DECK THAT OWNS A PLAYER?
 *
 * For THIS Host that is the same question as "am I in a frame", because the
 * only thing that ever frames this document is `content.js` on a watch page,
 * and it is the thing that owns the `<video>`. It is not the same question for
 * a Host in general — under a desktop Host the deck is the top-level document
 * and there is still a player — which is exactly why the deck no longer asks it
 * and asks `host.transport != null` instead. The frame test is a fact about
 * this Host and it stays inside this Host.
 *
 * `window.parent` rather than a bare `parent`, so this module can be driven
 * from Node with a stubbed `window` — the same discipline `test.js` already
 * applies to `chrome` and `navigator`.
 */
const FRAMED = window.parent !== window;

/**
 * Every deck -> host message leaves through here, and `'*'` is not laziness:
 * the deck is served from an extension origin and cannot know at build time
 * what page it was mounted into. The host's side is pinned — `content.js`
 * accepts these only from this frame's `contentWindow` — which is where the
 * check belongs, because that is the side that knows both origins.
 */
const post = (msg) => { window.parent.postMessage(msg, '*'); };

/**
 * Wire type -> the deck's handler. One handler per type: the deck registers
 * each exactly once as it boots, and a type nobody registered is dropped, which
 * is what happens today for anything arriving before the deck's own listener
 * was up.
 */
const inbound = new Map();

/**
 * ONE LISTENER, REGISTERED AT MODULE SCOPE, and the two guards on it are the
 * host's because both are facts about the transport.
 *
 * `ev.source !== window.parent` is the one that matters: this document is
 * embedded in a page that runs YouTube's own JavaScript and any number of other
 * frames, all of which can postMessage at us. Only the frame that put us here
 * is heard. There is deliberately no `ev.origin` check — the source check
 * carries it, and the host page's origin is not knowable here.
 */
window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent) return;
  const d = ev.data;
  if (!d || d.from !== 'stem-splitter-live-host') return;
  const fn = inbound.get(d.type);
  if (fn) fn(d);
});

/** Build one inbound duty: register the deck's handler for one wire type. */
const on = (type) => (fn) => { inbound.set(type, fn); };

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
   * `async`, SO A BAD AREA IS A REJECTION AND NOT A THROW. `assertArea` refuses
   * anything but the two declared lifetimes, and this is the ONE duty where that
   * refusal must not reach the call site as a throw: the preferences read is a
   * module-scope `.then(…).catch(…)`, and a synchronous throw is not caught by
   * that `.catch` — it takes the rest of the deck's boot with it. (The arm-error
   * read is an `await` inside a `try`, which would survive either shape; the
   * duty answers the same way at both call sites rather than the weaker of the
   * two.)
   * `async` on the method is what turns the refusal into the rejection those two
   * call sites are already written to survive. (Before `assertArea` existed the
   * same rejection happened by accident — `chrome.storage.nope` is `undefined`
   * and `.get` on it throws — which is a defined answer only as long as nobody
   * reorders the line.) Rule 6: a read that could not happen must not look like
   * a key that was not there.
   */
  async storageGet(area, key) {
    const got = await chrome.storage[assertArea(area)].get(key);
    return got && key in got ? got[key] : null;
  },

  /**
   * Fire and forget, exactly like `send` and for the same reason: the value is
   * already on screen, so there is nothing a rejection could tell the user that
   * the next read would not tell them better. Returns undefined so no call site
   * can start awaiting a write.
   *
   * A WRITE THAT FAILED AND AN AREA THAT WAS NEVER ASKED FOR ARE NOT THE SAME
   * THING, which is why one is swallowed and the other throws here: the first is
   * the platform having a bad day, the second is this call site being wrong
   * about a value it wrote itself.
   */
  storageSet(area, key, value) {
    chrome.storage[assertArea(area)].set({ [key]: value }).catch(() => {});
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
    // The filter below compares against `area`, so an area nothing can ever
    // report would register a listener that is guaranteed never to fire — a
    // subscription that silently covers nothing, which is the change-feed
    // spelling of the same green-on-nothing shape rule 6 is about.
    assertArea(area);
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

  /**
   * THE PLAYER, or `null` when this deck was not mounted onto a page that has
   * one. `null` and not "absent": `../shared/host.js`'s `assertHostOption`
   * refuses a Host that simply never mentioned a transport, because the deck
   * reads the answer as a fact about the world and boots differently on it.
   */
  transport: FRAMED ? {
    onState: on('VIDEO'),
    onJump: on('JUMP'),
    onSpeedReport: on('SPEED'),

    /**
     * THE WRITE SET IS CLOSED HERE, at the seam, and that is the point of
     * filtering rather than spreading. ADR 0001 decision 4 sets the transport's
     * write side at `muted`, `currentTime` and `playbackRate`; L1 is what makes
     * that a rule rather than a preference, because the same channel reaches a
     * `<video>` on somebody else's page. Spreading the caller's object would
     * make the write set whatever a call site happened to pass, and widening it
     * would then be invisible in review. Three fields, named, and anything else
     * in the patch is dropped on this side of the wire.
     *
     * `seekTo` is this protocol's name for `currentTime`; `content.js` uses it
     * to tell the deck's own seek from the user's, and it is not renamed there
     * because `content.js` is not this slice's to edit.
     */
    drive(patch) {
      const p = patch || {};
      const msg = { from: NS, type: 'VDRIVE' };
      if (typeof p.muted === 'boolean') msg.muted = p.muted;
      if (Number.isFinite(p.playbackRate)) msg.playbackRate = p.playbackRate;
      if (Number.isFinite(p.currentTime)) msg.seekTo = p.currentTime;
      post(msg);
    },

    release() { post({ from: NS, type: 'VRELEASE' }); },

    /**
     * The value is NOT filtered, unlike `drive`'s. A rate this host cannot
     * apply is refused and reported back through `onSpeedReport` with a reason
     * the deck prints — see `content.js`'s SPEED arm — and a silent drop here
     * would replace an explained lockout with a control that looks fine and
     * does nothing.
     */
    requestSpeed(rate) { post({ from: NS, type: 'SPEED', rate }); },
  } : null,

  /**
   * THE PAGE THE DECK IS DRAWN INTO. Always present, even for a deck opened
   * outside a frame: `window.parent` is then this window, the posts land on a
   * listener that filters them by namespace, and nothing happens — which is
   * exactly what happened before this seam existed. A deck that had to check
   * whether it had a page before every height report would be one forgotten
   * check away from a TypeError at a user gesture, which is the failure
   * `assertHost` exists to move to boot.
   */
  page: {
    onKey: on('KEY'),
    onAutonav: on('AUTONAV'),
    claimKeys(claim) { post({ from: NS, type: 'DECK', armed: claim.armed, keys: claim.keys }); },
    setHeight(px) { post({ from: NS, type: 'HEIGHT', height: px }); },
    ready() { post({ from: NS, type: 'READY' }); },
    close() { post({ from: NS, type: 'CLOSE' }); },
  },
};
