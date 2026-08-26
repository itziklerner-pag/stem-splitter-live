/**
 * The embedded deck — ONE deck, drawn inside the user's own YouTube page.
 *
 * It is a VIEW, exactly like the side panel and the DJ console: it holds no
 * audio, owns no truth, and every number on it arrived on a message. The engine
 * is the same offscreen document the other build uses, unchanged. That is the
 * whole design of this build — a different surface, not a different product.
 *
 * WHAT IT DELIBERATELY DOES NOT HAVE, so nobody adds it back by reflex:
 *  - a crossfader, an assign row, a deck B. One deck, and the messages this file
 *    sends all name deck A explicitly rather than letting the field default.
 *  - a hop control. The engine's default is right for one deck, and a select
 *    box that changes the separation schedule does not belong under a video.
 *  - an export / download path. This build is the live gesture; Mode 2 offline
 *    export lives in the side-panel build, which has the `downloads` permission
 *    this one does not request.
 *  - an "arm" button. There cannot be one: only a browser-level invocation mints
 *    a tabCapture grant, so no button on any of our pages can (ARCHITECTURE §7
 *    R4). The toolbar click is the arm gesture and this panel is its result.
 */

import {
  UNITY_U, FLOOR_DB, MIN_DB, MAX_DB, faderDb, dbToFader, linAmp, linToDb,
  dbToMeterFrac, BALLISTICS, onePole, fmtDb, speakDb, MINUS, INF, fmtBytes,
  behindText, bufState, errorSummary, errorAction, ARM_CODES, armErrorFresh,
  normalizeDeck, syncCorrection, audioClockAt,
} from './audio-math.js';
import { ARM_ERROR_KEY, ARM_ERROR_TTL_MS, MODEL, SR } from '../shared/config.js';
import {
  chip, follow, RUNNING, peakTick,
  shortcut, hostKeys, stemKeyHint, keyPlan, clampSemitones, SEMITONE_MIN, SEMITONE_MAX,
  snapSpeed, stepSpeed, speedFar, speedGate, SPEED_HOME, bpmPlan, beatPulse,
  isMac, modLabel,
} from './embed-state.js';
/**
 * THE MUSIC HALF, from the engine's own tree. `displayKey` is the ONE place the
 * transpose and the user's horn are composed onto the detected tonic, and it is
 * imported rather than re-implemented for the reason its header gives: the tap
 * is UPSTREAM of the pitch shifter, so the shift must be ADDED, and the opposite
 * convention looks equally correct in review. `DISPLAY_POLICY` is imported for
 * one number — how long "listening" lasts — so the copy on screen cannot drift
 * from the gate the engine actually runs.
 */
import { displayKey, INSTRUMENTS, DISPLAY_POLICY } from '../engine/chroma.js';
/**
 * THE TEMPO HALF, same argument. `beatPhaseAt` is the ONE call site of the beat
 * modulo — bpmtap.js's `payload()` refuses to put a `phase` field on the wire so
 * that there cannot be a second one — and `BPM_WINDOW_SEC` is imported for the
 * same reason `DISPLAY_POLICY.minListenSec` is: the "listening…" copy on screen
 * and the window the detector actually fills must not be able to drift apart.
 */
import { beatPhaseAt, BPM_WINDOW_SEC } from '../engine/bpmtap.js';

/** This build has one deck and it is A. Never a default — always sent. */
const DECK = 'A';

/**
 * Fixed left-to-right order, same as the console. DESIGN §2.4.
 *
 * SIX since 2026-08-16, and the new two APPEND — `vocals drums bass other` do
 * not move, because the digits `1`-`4` are printed on them and re-ordering
 * would silently re-point every one of those keys on somebody else's page.
 */
const STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
const STEM_LABEL = {
  vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other',
  guitar: 'Guitar', piano: 'Piano',
};
/**
 * The glyph half of stem identity. Colour is never the sole carrier (DESIGN
 * §2.4), and on a strip this narrow the glyph is read before the word is.
 *
 * IT CARRIES MORE HERE FOR THE LAST TWO. Guitar and piano have no number key in
 * this build, so their identity rests on three channels rather than four —
 * glyph, name and fixed position. Neither the glyph nor the name may be dropped
 * from those strips at any width; see `.strip__hd` in embed.css.
 */
const STEM_ICON = {
  vocals: 'i-mic', drums: 'i-drum', bass: 'i-bass', other: 'i-other',
  guitar: 'i-guitar', piano: 'i-piano',
};
const icon = (id) => `<svg class="i"><use href="#${id}"/></svg>`;

/** −Infinity, JSON-safe. 1e-6 amplitude: below the 24-bit LSB. */
const SILENT_DB = -120;

const $ = (id) => document.getElementById(id);
const text = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
const wireDb = (db) => (db === -Infinity ? SILENT_DB : db);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const toOff = (m) => chrome.runtime.sendMessage({ v: 1, to: 'off', from: 'ui', ...m }).catch(() => {});
const toSw = (m) => chrome.runtime.sendMessage({ v: 1, to: 'sw', from: 'ui', ...m }).catch(() => {});

// ------------------------------------------------------------------- state
// The SESSION record carries a title and a url too; this surface reads neither
// (the page behind the frame shows both), so only the tab id is held.
let session = { tabId: null };
let engineInfo = null;
let err = null;            // {code, message, advisory, seq}
const live = {
  status: 'idle',
  phase: null,             // 'model' | 'ring' | null — which wait `priming` is
  latencySec: 0,
  bufferMinSec: 0,
  floorSec: 0,
  primedPct: 0,
  passthroughNow: false,
  drops: 0,
  /** 'live' | 'cache' — which kind of deck the engine gave us. */
  source: 'live',
  /** transport, cached decks only: where the playhead was at `atMs`, in seconds
   *  along the TRACK. Not interchangeable with `playFrames`, which is a ring
   *  counter on the beat's axis — see `beatFrameNow`. */
  positionSec: 0,
  durationSec: 0,
  /**
   * the playhead in ABSOLUTE STEM-RING FRAMES, on `bpm.beatFrame`'s axis, for
   * the beat phase (`beatFrameNow`). BOTH deck kinds publish it and both OMIT it
   * when the deck has no output ring — so the default is NaN, never 0: frame 0
   * is a real position and `beatFrameNow` discriminates on `Number.isFinite`.
   * Declared here rather than left to the LIVE_STATE handler's assignment,
   * because a field whose default lives only in the absence of an initialiser is
   * one refactor away from becoming `0`.
   */
  playFrames: NaN,
  /** when the deck sampled the playhead, on the wall clock. BOTH deck kinds send
   *  it, beside BOTH readouts: `positionSec` for the video lock and `playFrames`
   *  for the beat phase, sampled together in one turn. */
  atMs: 0,
};
const stems = {};
for (const s of STEM_ORDER) {
  stems[s] = {
    db: 0, mute: false, solo: false, el: null, fader: null,
    // The meter's own state. `pk` is peakTick's, and it is the only piece of
    // this surface that carries a value between frames.
    rmsLin: 0, pk: null, wrote: { rms: -1, peak: -1, clip: null, pkText: null },
  };
}
let masterDb = 0;
/**
 * TRANSPOSE, in semitones. NOT persisted, deliberately: a shift that survived a
 * reload would silently pitch a video the user has not heard yet, and the only
 * evidence would be a small number in a control they did not touch.
 */
let semitones = 0;
/**
 * Which horn the written key is spelled for. Persisted (`prefs.instrument`) —
 * unlike the transpose, this is a property of the PLAYER, not of the track, and
 * re-picking it on every video is the kind of small tax that makes a tool feel
 * unfinished. Default concert: it is the untransposed truth — the key the
 * recording is actually in, and the only setting that is not a claim about who
 * is holding the deck. A horn player opts in; everyone else is already right.
 * Three entry points set it and all three must agree: here, `applyPrefs`'s
 * fallback, and the FIRST <option> in embed.html — which is what the picker
 * shows if the `storage.local` read rejects and `applyPrefs` never runs.
 */
let instrument = 'concert';
/** The engine's `key` field, as it arrived. CONCERT TONIC ONLY — see paintKey. */
let keyMsg = null;
/** The autoplay failure being shown, and the one the user has already dismissed. */
let navErr = null;
let navDismissed = null;
/** `chrome.storage.local` `prefs`, as last read. Held so a write to one field
 *  does not drop another surface's. */
let prefs = {};
/** When the last METERS message landed, so the ballistics have a real dt. */
let meterAt = 0;

/**
 * THE FAILURE LATCH. There is no Start button to switch off any more, so this
 * is what stops `follow()` restarting the deck on the next 10 Hz status message
 * after something went wrong. Cleared by Restart, by dismissing the banner, and
 * by the user pausing and playing again — the gesture that means "try again"
 * in a build whose only transport is the page's.
 */
let halted = false;
/**
 * The page's player, per content.js. TRI-STATE: true playing, false paused,
 * **null nobody told us** — see follow() in embed-state.js for why the third
 * value is not the same as `false`.
 */
let videoPlaying = null;
/**
 * Has the user declined the one-time download in this sitting? Asking again on
 * every play/pause would be a nag; asking again after a reload is right, since
 * nothing was remembered and nothing was started.
 */
let modelDeclined = false;
/** Content jumps seen. Read by the harness only — see `__embed` at the foot. */
let jumps = 0;

const anySolo = () => STEM_ORDER.some((s) => stems[s].solo);
/** Silent right now: muted, or ducked by someone else's solo. AUDIO.md §3.2. */
const isSilent = (s) => (anySolo() ? !stems[s].solo : stems[s].mute);

/**
 * THE VERTICAL FADER, copied from console-full.js:642-745 and trimmed to what
 * one deck needs. DESIGN §6.3: 1 px of pointer is 1 px of travel with no
 * acceleration, and the cap's transition is removed for the duration of a drag
 * so it tracks the finger — a laggy fader feels broken.
 *
 * The law itself is NOT copied: `faderDb` / `dbToFader` come from audio-math,
 * which re-exports the engine's own mixer. The two widget rules on top of it
 * are the console's — the value is clamped to [FLOOR_DB, MAX_DB] and anything
 * at or below FLOOR_DB becomes -Infinity, so a fader can never sit at −57 dB
 * pretending to be audible. (`faderDb(OFF_U)` is −55.2, at or below FLOOR_DB,
 * so the position rule DESIGN §6.2 states is subsumed by this one; audio-math's
 * selftest pins that relationship.)
 *
 * ponytail: ceiling — this is the second copy of this widget in the repo, so a
 * geometry or gesture fix has to be made twice. Upgrade path is the one named
 * at the top of embed.css: `extension/ui/fader.js` + `fader.css`, imported by
 * both surfaces, which the overlay build would carry for free. It costs edits
 * to console-full.{html,css,js} and a re-run of the console's e2e suite.
 *
 * @param {HTMLElement} el   the `.fader` element
 * @param {(db:number)=>void} onChange fired only when the value actually moved
 */
function makeFader(el, onChange) {
  let db = 0;
  let drag = null;

  const capH = () => parseFloat(getComputedStyle(el).getPropertyValue('--fader-cap-h')) || 22;

  function apply(next) {
    let v = next;
    if (v !== -Infinity) {
      v = Math.round(clamp(v, FLOOR_DB, MAX_DB) * 10) / 10;
      if (v <= FLOOR_DB) v = -Infinity;
    }
    const changed = v !== db;
    db = v;
    paintFader();
    if (changed) onChange(db);
  }

  function paintFader() {
    el.style.setProperty('--pos', dbToFader(db === -Infinity ? -Infinity : db));
    el.setAttribute('aria-valuenow', db === -Infinity ? MIN_DB : Math.round(db * 10) / 10);
    el.setAttribute('aria-valuetext', speakDb(db));
  }

  function posFromY(clientY) {
    const r = el.getBoundingClientRect();
    const ch = capH();
    return clamp((r.bottom - clientY - ch / 2) / (r.height - ch), 0, 1);
  }

  function setPos(pos, fine) {
    let p = clamp(pos, 0, 1);
    if (!fine) {
      const span = el.getBoundingClientRect().height - capH();
      if (Math.abs(p - UNITY_U) * span <= 3) p = UNITY_U;   // ±3 px unity snap
    }
    apply(faderDb(p));
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.altKey || e.detail >= 2) { apply(0); return; }   // reset to unity
    el.setPointerCapture(e.pointerId);
    el.dataset.drag = 'true';
    const r = el.getBoundingClientRect();
    drag = { span: r.height - capH(), y: e.clientY, pos: posFromY(e.clientY), shift: e.shiftKey };
    setPos(drag.pos, e.shiftKey);          // grab-and-go: jump, then drag
    drag.pos = dbToFader(db);
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (e.shiftKey !== drag.shift) { drag.shift = e.shiftKey; drag.y = e.clientY; drag.pos = dbToFader(db); }
    const scale = e.shiftKey ? 0.25 : 1;
    setPos(drag.pos + ((drag.y - e.clientY) * scale) / drag.span, e.shiftKey);
  });

  const end = (e) => {
    if (!drag) return;
    drag = null;
    el.dataset.drag = 'false';
    try { el.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  const step = (dir, size) => apply((db === -Infinity ? FLOOR_DB : db) + dir * size);

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    step(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 0.1 : 0.5);
  }, { passive: false });

  /**
   * THE FADER'S OWN KEYS. ENTRY POINT: this element, and only when it HAS FOCUS
   * inside the deck's iframe — which is why nothing here is in `hostKeys()` and
   * why none of it can collide with YouTube. A key pressed on the watch page
   * never reaches this listener; a key pressed here never reaches the watch
   * page, because the frame is cross-origin and this handler swallows it.
   *
   * ALT IS THE FADER'S MAC-REACHABLE MODIFIER, added because
   * HOME, END, PAGE UP AND PAGE DOWN ARE ALL UNREACHABLE ON A MAC. A MacBook has
   * none of the four as physical keys — they are `fn`+`←`/`→`/`↑`/`↓`, which is
   * not a shortcut anyone reaches for and which the browser often eats first. So
   * BOTH the ARIA landmark convention and the coarse step were, on that
   * hardware, bindings with no keys. One modifier now carries both:
   *
   *   Alt+↑ / Alt+↓          unity / −∞      (Home / End)
   *   Shift+Alt+↑ / +↓       ±6 dB           (PageUp / PageDown)
   *
   * WHY ALT AND NOT SHIFT ALONE: `Shift`+`↑`/`↓` IS ALREADY TAKEN, below — it is
   * the fine ±0.1 dB step. Alt already means "jump to a landmark" on this
   * surface (`Alt`+a digit resets that strip's fader to unity, and so does an
   * Alt-click on the cap), and adding Shift to it reads as the same gesture made
   * bigger, which is what `Shift` does on the speed buttons too.
   *
   * THE SHIFT TEST HAS TO COME FIRST INSIDE THIS BRANCH. Before the coarse step
   * existed, `Shift`+`Alt`+`↑` fell straight through to `apply(0)` — i.e. the
   * chord was already bound, to unity, by accident. That is the one real
   * in-build collision this addition had, and it is resolved by ordering rather
   * than by a second listener.
   *
   * WHY NOT ALT+LEFT / ALT+RIGHT, even though plain `←`/`→` alias `↓`/`↑` here:
   * `⌥`+`←`/`→` is YOUTUBE'S previous/next chapter (`Ctrl`+`←`/`→` on Windows),
   * and `Alt`+`←`/`→` is CHROME'S back/forward. Both are out of reach of this
   * listener today, but aliasing them would put a live binding one `hostKeys()`
   * entry away from stealing either. Up and down only, with or without Shift.
   *
   * ponytail: ceiling — on Windows, `Alt`+`Shift` PRESSED AND RELEASED ALONE is
   * the OS keyboard-layout toggle in multi-layout setups. Pressing an arrow
   * inside the chord suppresses it in every configuration we can reason about,
   * because the toggle fires on a bare modifier release, but it is the OS's
   * behaviour and not ours to guarantee. Upgrade path if it is ever reported:
   * move the coarse step to `Alt`+`PageUp`/`PageDown`… which has the same fn
   * problem, so realistically it becomes `Alt`+`Shift` staying and a note in the
   * overlay. Nothing here is load-bearing enough to design around it unasked.
   *
   * HOME, END, PAGE UP AND PAGE DOWN ARE KEPT as aliases. They cost nothing,
   * Home/End are the ARIA convention, and a full-size keyboard has all four —
   * removing them would help nobody.
   */
  el.addEventListener('keydown', (e) => {
    const fine = e.shiftKey ? 0.1 : 0.5;
    if (e.altKey) {
      // Shift FIRST: see "THE SHIFT TEST HAS TO COME FIRST" above. Without it
      // the coarse chord is silently the landmark chord.
      switch (e.key) {
        case 'ArrowUp': if (e.shiftKey) step(1, 6); else apply(0); break;
        case 'ArrowDown': if (e.shiftKey) step(-1, 6); else apply(-Infinity); break;
        // Everything else with Alt held is the browser's or the page's.
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': step(1, fine); break;
      case 'ArrowDown': case 'ArrowLeft': step(-1, fine); break;
      case 'PageUp': step(1, 6); break;
      case 'PageDown': step(-1, 6); break;
      case 'Home': apply(0); break;
      case 'End': apply(-Infinity); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  });

  paintFader();
  /**
   * `reset()` is the keyboard's, and it is the same `apply()` the Alt-click and
   * `Alt`+`↑` (and `Home`) already go through — so Alt+1, Alt+Up and
   * Alt-clicking the cap cannot end up meaning three different things.
   */
  return { get db() { return db; }, reset() { apply(0); } };
}

// ------------------------------------------------------------------- strips
/**
 * The strip, top to bottom, in the fixed order DESIGN §9.4 gives:
 *   glyph + name + key hint -> M | S -> badge slot -> fader beside meter ->
 *   gain readout / peak readout.
 *
 * THE BADGE SLOT IS ALWAYS 14 px, empty or not, so toggling mute never shifts
 * the fader under a finger that is already on it.
 *
 * THE KEY HINT COMES FROM `stemKeyHint()` AND NOT FROM `i + 1`. All six strips
 * carry a digit since 2026-08-17 — guitar and piano got `5` and `6` when the
 * `Digit5`-`Digit8` carve-out was retired — so the two are the same string
 * today, and that is exactly when a hand-rolled `i + 1` gets written and never
 * noticed. `stemKeyHint()` lives beside the `n > KEYED_STEMS` guard in
 * `shortcut()` and is asserted against it over the whole digit space, so a
 * seventh strip cannot advertise a `7` the handler refuses and YouTube still
 * owns.
 *
 * The slot itself is `margin-left: auto`, which is what right-aligns the hint
 * and keeps the header geometry identical across the rack.
 */
function buildStrips() {
  $('strips').innerHTML = STEM_ORDER.map((s, i) => {
    const c = STEM_LABEL[s];
    return `
    <div class="strip" data-stem="${s}" data-muted="false" data-solo="false" data-ducked="false"
         style="--stem: var(--color-stem-${s})">
      <div class="strip__hd">${icon(STEM_ICON[s])}<span class="name">${c}</span><span
        class="strip__key">${stemKeyHint(i)}</span></div>
      <div class="strip__ms">
        <button class="tog" type="button" data-t="m" aria-pressed="false"
                aria-label="Mute ${c.toLowerCase()}">M</button>
        <button class="tog" type="button" data-t="s" aria-pressed="false"
                aria-label="Solo ${c.toLowerCase()}">S</button>
      </div>
      <div class="strip__badge"></div>
      <div class="strip__ctl">
        <div class="fader" role="slider" tabindex="0" aria-label="${c} level"
             aria-valuemin="${MIN_DB}" aria-valuemax="${MAX_DB}" aria-valuenow="0"
             aria-valuetext="0.0 decibels, unity" style="--pos:${UNITY_U}">
          <div class="fader__track"></div><div class="fader__fill"></div>
          <div class="fader__detent"></div><div class="fader__cap"></div>
        </div>
        <!-- aria-hidden: the peak readout under it is the same number in text,
             which is the alternative DESIGN §7.4 asks for. A second live region
             announcing a moving bar is noise, not access. -->
        <div class="meter" aria-hidden="true" title="Click to clear a latched clip">
          <div class="meter__trough">
            <div class="meter__rms" style="--rms:0"></div>
            <div class="meter__peak" style="--peak:0"></div>
            <div class="meter__clip"></div>
          </div>
        </div>
      </div>
      <div class="strip__ft">
        <span class="strip__gain">0.0 dB</span>
        <span class="strip__pk">PK ${MINUS}${INF}</span>
      </div>
    </div>`;
  }).join('');

  for (const s of STEM_ORDER) {
    const st = stems[s];
    const el = $('strips').querySelector(`[data-stem="${s}"]`);
    st.el = el;
    st.fader = makeFader(el.querySelector('.fader'), (db) => {
      st.db = db;
      // Paint first, send second. The widget must track the finger; a round
      // trip must never be in the path of a fader (DESIGN §6.3).
      paintStrips();
      toOff({ type: 'STEM_GAIN', deck: DECK, stem: s, gainDb: wireDb(db) });
    });
    // THE BUTTON AND THE KEY GO THROUGH ONE FUNCTION. `1` and a click on M are
    // the same gesture to the user and must be the same code, or they drift —
    // that is AGENTS.md's entry-point family, at the smallest scale it occurs.
    el.querySelector('[data-t="m"]').addEventListener('click', () => toggleMute(s));
    el.querySelector('[data-t="s"]').addEventListener('click', () => toggleSolo(s));
    // A latched clip clears on a click, exactly as on the console.
    el.querySelector('.meter').addEventListener('pointerdown', () => {
      if (st.pk) st.pk = { ...st.pk, clipUntil: 0 };
      paintMeter(s, performance.now(), 0);
    });
  }
}

/**
 * THE FOUR STEM ACTIONS. One implementation each, reached from the M/S buttons,
 * from a key pressed inside this frame, and from a key pressed on the YouTube
 * page and forwarded by content.js.
 */
function toggleMute(s) {
  const st = stems[s];
  st.mute = !st.mute;
  toOff({ type: 'STEM_MUTE', deck: DECK, stem: s, muted: st.mute });
  paintStrips();
}
function toggleSolo(s) {
  const st = stems[s];
  st.solo = !st.solo;
  toOff({ type: 'STEM_SOLO', deck: DECK, stem: s, soloed: st.solo });
  paintStrips();
}
/** Alt+digit: that fader back to unity, through the widget so the cap moves. */
function resetFader(s) {
  stems[s].fader.reset();
  paintStrips();
}
function clearSolo() {
  for (const s of STEM_ORDER) {
    if (!stems[s].solo) continue;
    stems[s].solo = false;
    toOff({ type: 'STEM_SOLO', deck: DECK, stem: s, soloed: false });
  }
  paintStrips();
}
/** `0` — the panic key. Unmute everything AND drop every solo. */
function unmuteAll() {
  for (const s of STEM_ORDER) {
    if (!stems[s].mute) continue;
    stems[s].mute = false;
    toOff({ type: 'STEM_MUTE', deck: DECK, stem: s, muted: false });
  }
  clearSolo();
}

function paintStrips() {
  const solo = anySolo();
  for (const s of STEM_ORDER) {
    const st = stems[s];
    // Ducked is somebody ELSE'S solo silencing this stem. It is a different
    // fact from mute and it gets a different treatment, because the remedy is
    // different: one is your own button, the other is a button on another strip.
    const ducked = solo && !st.solo && !st.mute;
    st.el.dataset.muted = String(st.mute);
    st.el.dataset.solo = String(st.solo);
    st.el.dataset.ducked = String(ducked);
    const m = st.el.querySelector('[data-t="m"]');
    const so = st.el.querySelector('[data-t="s"]');
    m.setAttribute('aria-pressed', String(st.mute));
    so.setAttribute('aria-pressed', String(st.solo));
    m.setAttribute('aria-label', `${st.mute ? 'Unmute' : 'Mute'} ${STEM_LABEL[s].toLowerCase()}`);
    // Never colour alone (DESIGN §13.1): the badge says the word as well.
    const badge = st.mute ? 'muted' : st.solo ? 'solo' : ducked ? 'ducked' : '';
    const bEl = st.el.querySelector('.strip__badge');
    if (badge) bEl.dataset.b = badge; else bEl.removeAttribute('data-b');
    text(bEl, badge.toUpperCase());
    text(st.el.querySelector('.strip__gain'), `${fmtDb(st.db)} dB`);
  }
  text($('master-db'), `${fmtDb(masterDb)} dB`);
  // A solo going up or down changes whether Esc is ours — see postDeck().
  postDeck();
}

// ------------------------------------------------------------------- meters
/**
 * DESIGN §7.1 ballistics, run HERE rather than in the engine, so the meter
 * behaves the same however jittery the post rate is: RMS one-pole in linear
 * amplitude (10 ms attack / 300 ms release) and a 1200 ms peak hold that then
 * falls at 20 dB/s. `peakTick` is the pure half and is asserted in
 * embed-state.js; the one-pole is audio-math's `onePole`, so neither law is
 * forked here.
 *
 * IT IS DRIVEN BY MESSAGE ARRIVAL, not by an animation frame. The console runs
 * a rAF loop because it also draws a buffer sparkline and a master pair; this
 * surface has six bars and nothing else moving, and a decay loop that keeps
 * running after the engine stops sending would animate a number nobody
 * measured. When the deck stops, `zeroMeters()` empties them outright.
 *
 * @param {string} s stem
 * @param {number} now performance.now() at the message
 * @param {number} dtMs since the previous message
 */
function paintMeter(s, now, dtMs, peakLin, rmsLin) {
  const st = stems[s];
  const silent = isSilent(s);
  st.pk = peakTick(st.pk, linToDb(peakLin), {
    now, dtMs, silent, floorDb: MIN_DB, ballistics: BALLISTICS,
  });

  const tgt = silent ? 0 : Math.min(1, linAmp(rmsLin));
  st.rmsLin += (tgt - st.rmsLin) * (silent ? 1 : onePole(dtMs, tgt > st.rmsLin
    ? BALLISTICS.rmsAttackMs : BALLISTICS.rmsReleaseMs));
  if (st.rmsLin < 1e-5) st.rmsLin = 0;

  const r = Math.round(dbToMeterFrac(linToDb(st.rmsLin)) * 1000) / 1000;
  const p = Math.round(dbToMeterFrac(st.pk.db) * 1000) / 1000;
  const w = st.wrote;
  const meter = st.el.querySelector('.meter');
  if (r !== w.rms) { meter.querySelector('.meter__rms').style.setProperty('--rms', r); w.rms = r; }
  if (p !== w.peak) { meter.querySelector('.meter__peak').style.setProperty('--peak', p); w.peak = p; }
  const clip = now < st.pk.clipUntil ? 'true' : 'false';
  if (clip !== w.clip) { meter.dataset.clip = clip; w.clip = clip; }
  const pkEl = st.el.querySelector('.strip__pk');
  const pkText = `PK ${fmtDb(st.pk.db, { sign: false })}`;
  if (pkText !== w.pkText) { text(pkEl, pkText); w.pkText = pkText; }
  if (pkEl.dataset.clip !== clip) pkEl.dataset.clip = clip;
}

/**
 * A stopped deck's meters must not be left holding the last frame it sent: a
 * frozen bar on a deck that is not running reads as a deck that IS running.
 */
function zeroMeters() {
  meterAt = 0;
  for (const s of STEM_ORDER) {
    const st = stems[s];
    st.rmsLin = 0;
    st.pk = null;
    st.wrote = { rms: -1, peak: -1, clip: null, pkText: null };
    if (!st.el) continue;
    const meter = st.el.querySelector('.meter');
    meter.querySelector('.meter__rms').style.setProperty('--rms', 0);
    meter.querySelector('.meter__peak').style.setProperty('--peak', 0);
    meter.dataset.clip = 'false';
    const pkEl = st.el.querySelector('.strip__pk');
    text(pkEl, `PK ${MINUS}${INF}`);
    pkEl.dataset.clip = 'false';
  }
}

// ----------------------------------------------------------------- transport
/**
 * Start = capture, then live, and the second must not overtake the first.
 *
 * The service worker mints the stream (only it can), the offscreen document
 * attaches it, and only then can LIVE_START find something to read. Sending both
 * at once loses that race reliably and paints NOT_CAPTURING on a deck that was
 * about to work — the DJ console learned this the same way and this is the same
 * sequence, trimmed to one deck.
 *
 * ponytail: ceiling — if the deck never reports `recording` this gives up after
 * CAPTURE_WAIT_MS and shows the arm refusal the service worker raised, which is
 * the honest message but is not tied to the button that was pressed. Upgrade
 * path: a request id on SW_CAPTURE_START echoed back on ARM_ERROR.
 */
const CAPTURE_WAIT_MS = 8000;
let waiting = false;

const isCapturing = () => {
  const d = engineInfo && engineInfo.decks && engineInfo.decks[DECK];
  return !!(d && d.capture && d.capture.status === 'recording');
};

function startLive() {
  const send = () => toOff({ type: 'LIVE_START', deck: DECK, tabId: session.tabId });
  if (isCapturing()) { send(); return; }
  if (waiting) return;
  waiting = true;
  toSw({ type: 'SW_CAPTURE_START', deck: DECK });
  const t0 = performance.now();
  const tick = () => {
    if (!waiting) return;
    if (isCapturing()) { waiting = false; send(); return; }
    if (performance.now() - t0 > CAPTURE_WAIT_MS) {
      waiting = false;
      // The latch, at one of its raise sites. Otherwise `follow()` sees "armed,
      // video playing, deck idle" on the next 10 Hz status message and starts
      // again — a retry loop wrapped around a banner nobody has read yet.
      halted = true;
      // Do NOT send LIVE_START anyway: it comes back as NOT_CAPTURING and paints
      // over whatever ARM_ERROR actually explained the failure.
      if (!err) {
        err = {
          code: 'NOT_CAPTURING',
          advisory: false,
          message: `Chrome did not hand over this tab's audio within ${CAPTURE_WAIT_MS / 1000} s. `
            + 'Click the Stem Splitter Live toolbar icon on this tab again — that click is the '
            + 'capture grant, and it expires.',
        };
      }
      live.status = 'idle';
      paint();
      return;
    }
    setTimeout(tick, 120);
  };
  setTimeout(tick, 120);
}

function stopLive() {
  waiting = false;
  toOff({ type: 'LIVE_STOP', deck: DECK });
  live.status = 'idle';
  live.phase = null;
  live.latencySec = 0;
  live.bufferMinSec = 0;
  live.passthroughNow = false;
  // A stopped deck sends no more METERS, so whatever the last frame said would
  // stay lit under a deck that is not playing. The key readout is the same
  // problem in words: a stale key on a stopped deck reads as a live one.
  zeroMeters();
  keyMsg = null;
  paintKey();
  // ...and the tempo, for the same reason: a stale BPM on a stopped deck reads
  // as a live one, and this readout's whole thesis is that a confident wrong
  // number is worse than a blank.
  bpmMsg = null;
  paintBpm();
  /**
   * ...and the speed control's fine line, which carries `· heard 3.4 s later`
   * off `live.status`. Nothing else repaints it on this path, so a deck that
   * stopped went on promising a latency it was no longer producing. Measured in
   * the browser.
   */
  paintSpeed();
  // The deck is no longer running, so nothing may still be driving the user's
  // video. Releasing here rather than waiting for the next LIVE_STATE matters:
  // a stopped deck may not send another one.
  syncVideoLock();
}

/**
 * THE FOLLOW LOOP. The deck runs when the user's video runs, and this is the
 * only place that starts or stops it for that reason.
 *
 * The decision itself is `follow()` in embed-state.js, where it is pure and
 * tested; this function is the two lines of effect. Called after every input
 * that can change the answer: a status message, a session change, the page
 * reporting play/pause, and the switch itself.
 */
/** Is this deck inside a page that reports its player? See follow(). */
const HOSTED = window.parent !== window;

function reconcile() {
  const what = follow({
    halted, armed: !!session.tabId, status: live.status, videoPlaying, hosted: HOSTED,
  });
  if (what === 'start') {
    /**
     * THE MODEL GATE LIVES HERE, on a path that starts a pipeline, and not on
     * the play handler alone.
     *
     * Attaching a capture makes the engine fetch the weights immediately
     * (offscreen.js captureStart -> ensureSession), so ANY route to `start`
     * with no model on disk is a 172 MiB download the user did not ask for.
     * Gating the gesture instead of the effect is how the first version leaked
     * one: a stray start during boot never went through the play handler.
     *
     * `restartLive()` IS THE OTHER SUCH ROUTE and carries the same gate — this
     * line used to say "the only path", and it was wrong for as long as
     * `onContentJump()` has existed. The gate belongs on each route INTO
     * `startLive()` rather than inside it, because `startLive()` cannot refuse
     * without also making the optimistic `priming` two lines below a lie.
     */
    if (modelInTheWay()) return;
    err = null;
    startLive();
    // Optimistic, and only as far as `priming`: the engine owns every status
    // above it. Without this the button does not change until the first
    // LIVE_STATE, which is a visible dead beat on a control just pressed.
    live.status = 'priming';
    live.primedPct = 0;
  } else if (what === 'stop') {
    stopLive();
  }
}

/**
 * PRESSING PLAY IS THE GESTURE, so it is also where the deck asks about the
 * one-time download — the user has just asked for audio, and this is the last
 * moment before we would need the model to give it to them.
 *
 * Returns true when the prompt is now in the way, so the caller does not also
 * start a pipeline that would immediately stall on a model it does not have.
 */
function modelInTheWay() {
  const s = modelStatus();
  if (s !== 'absent' && s !== 'error') return false;
  if (!modelDeclined) openModelDialog();
  return true;
}

/**
 * The page's player moved. This is the only transport in this build.
 *
 * Pressing play after a failure is the retry gesture: there is no Restart
 * button in the header any more, and "press play again" is what a user does
 * without being told. So a fresh play clears the latch.
 */
function onVideoState(d) {
  const playing = d.playing === true;
  /**
   * THE PAGE'S TRANSPORT GOES TO THE ENGINE FIRST, and the order is
   * load-bearing rather than tidy. `reconcile()` below can send LIVE_STOP, and
   * the engine decides there whether the prime it has been accumulating becomes
   * a cache entry — a decision that reads exactly this message's `ended` and
   * `duration`. Send it after, and every prime commits against the state of the
   * PREVIOUS tick, which on the last tick of a track is "not ended yet".
   */
  toOff({
    type: 'PAGE_VIDEO', deck: DECK,
    currentTime: d.currentTime, duration: d.duration,
    ended: d.ended === true, seeking: d.seeking === true,
  });
  // FRESH video clock — read microseconds ago, in this very event. This is the
  // only tick allowed to compute a correction; see syncVideoLock.
  lastVideoSec = Number(d.currentTime) || 0;
  syncVideoLock(true);
  /**
   * THE ELEMENT'S OWN RATE. `ratechange` is in content.js's VIDEO_EVENTS, so
   * YouTube's speed menu moving the rate on a PAUSED video arrives here rather
   * than waiting for the next play or timeupdate — which is the one case where
   * the user is most likely to be fiddling with it.
   */
  onElementRate(d.playbackRate);
  paintSpeed();
  /**
   * ...AND THE TEMPO BOX, on the same message. It is not decoration: the
   * `respeed` blank clears on a DEADLINE (`bpmStaleUntil`), and a deadline that
   * is only ever read on LIVE_STATE would leave a deck that is not producing —
   * paused, idle, stopped — stuck on "re-reading after the speed change" for
   * ever. Measured in the browser: it stuck. This is still message-driven and
   * never a timer; `text()` compares before it writes, so the 4 Hz `timeupdate`
   * repaint costs nothing when nothing changed.
   */
  paintBpm();

  if (playing === videoPlaying) return;
  videoPlaying = playing;
  // Pressing play after a failure is the retry: there is no Restart in the
  // header any more, and "press play again" is what a user does unprompted.
  if (playing) halted = false;
  reconcile();
  paint();
}

// -------------------------------------------------------------- video lock
/**
 * LOCK THE PAGE'S VIDEO TO THE CACHED DECK'S AUDIO CLOCK (docs/AUDIO.md §8.2).
 *
 * WHY THIS LOOP LIVES IN A VIEW, which is otherwise against the rules here. The
 * `<video>` element is reachable only from the page, and the page's only
 * extension-privileged neighbour is this iframe. The engine holds the audio
 * clock but cannot see or touch the element; `content.js` can touch it but
 * cannot import the correction law. This surface is adjacent to both, so it is
 * the only place the two numbers can meet — and it holds no truth of its own:
 * `audioSec` arrives on a message and the law is `syncCorrection`, imported.
 *
 * IT RUNS ONLY FOR A CACHED DECK. On a live deck the video is the source of the
 * audio being captured and every correction moves both sides of the error; the
 * lock would fight itself. `live.source` is the engine's word on which kind of
 * deck this is, and it is the only gate.
 *
 * ...AND THAT SAME GATE IS WHAT KEEPS IT DISJOINT FROM THE SPEED CONTROL, which
 * is the other thing on this surface that moves the page's rate. `speedGate()`
 * refuses `source === 'cache'` and this refuses everything else, so the two can
 * never be writing the element at once — which is why they are two posters and
 * not one. They are not the same message and they do not share a lifetime: this
 * one is a CORRECTION with its own `lastRateSent` dedupe against a 4 Hz loop,
 * and `setSpeed`'s is a CLAIM that content.js re-asserts across an ad. One
 * variable behind both would be one dedupe behind two lifetimes.
 */
/** The video clock, from the last `timeupdate` the page volunteered. */
let lastVideoSec = 0;
/** Are we currently driving the element? Drives the release on the way out. */
let videoLocked = false;
/** The last rate we asked for, so a 14 Hz loop does not re-send the same one. */
let lastRateSent = 1;

/**
 * @param {boolean} correct Compute and send a correction, not just acquire or
 * release the lock.
 *
 * ONLY THE CALLER WITH A FRESH VIDEO CLOCK MAY PASS TRUE, and that is
 * `onVideoState` — the `timeupdate` tick, where `currentTime` was read
 * microseconds ago in the same event. `LIVE_STATE` arrives at 10 Hz and
 * `timeupdate` at about 4 Hz, so on most engine ticks the newest video sample is
 * already up to 250 ms old: FOUR TIMES the 60 ms threshold. Correcting on it
 * would be measuring the video clock's own publish interval, which is the same
 * defect `audioClockAt` fixes on the audio side and is larger here. The engine
 * tick therefore only acquires and releases; it never computes.
 */
function syncVideoLock(correct = false) {
  const want = live.source === 'cache' && live.status === 'running';
  if (!want) {
    if (videoLocked) {
      videoLocked = false;
      // Hand the element back: unmuted, rate 1. A muted 1.02x video left behind
      // is a bug the user cannot explain and cannot undo.
      parent.postMessage({ from: 'stem-splitter-live', type: 'VRELEASE' }, '*');
    }
    return;
  }
  if (!videoLocked) {
    videoLocked = true;
    /**
     * MUTE FIRST, and it is not only about hearing the track twice.
     * `syncCorrection`'s soft correction runs the element at 1 ± 0.02, which on
     * audible material is a 34-cent pitch shift — a quarter-tone against the
     * stems the user is mixing. The ratified thresholds assume silence.
     */
    parent.postMessage({ from: 'stem-splitter-live', type: 'VDRIVE', muted: true }, '*');
    lastRateSent = 1;
  }
  if (!correct || !live.atMs) return;

  // Advance the playhead by the sample's age — see audioClockAt, where the
  // reason it is not optional is written down.
  const c = syncCorrection(audioClockAt(live.positionSec, live.atMs, Date.now()), lastVideoSec);
  /**
   * A CORRECTION THAT CLOSED MUST BE CANCELLED. `syncCorrection` returns
   * `playbackRate: 1` with action 'none', and sending it is the half everyone
   * forgets: a soft correction left in place after its error closed runs the
   * video 2 % off forever, drifting in the opposite direction. So the rate is
   * sent on every correcting tick — but only when it CHANGED, because this runs
   * at ~4 Hz and re-posting the same value churns the page for nothing.
   */
  const seek = c.action === 'seek' ? { seekTo: c.seekTo } : null;
  if (!seek && c.playbackRate === lastRateSent) return;
  lastRateSent = c.playbackRate;
  parent.postMessage({
    from: 'stem-splitter-live', type: 'VDRIVE', playbackRate: c.playbackRate, ...(seek || {}),
  }, '*');
}

/**
 * The content changed under a running pipeline — a seek, or YouTube swapping in
 * another video. The ~2.4 s already in the ring is now audio from somewhere
 * else, and playing it would be 2.4 s of the wrong part of the track before the
 * new one starts.
 *
 * Restart, which re-primes. It costs the priming wait again and the chip says
 * so; the alternative is emitting content the user has already left.
 */
function onContentJump() {
  jumps++;
  if (!RUNNING.has(live.status)) return;
  /**
   * A CACHED DECK DOES NOT RE-PRIME ON A SEEK, and this is the difference the
   * whole cache exists for. Its stems are already on disk, so the engine simply
   * moves the playhead (`PAGE_VIDEO` carries the position and `cacheddeck.js`
   * seek()s to it). Restarting here would throw away a track that is sitting in
   * memory and re-separate it in real time — the exact cost the cache removes.
   */
  if (live.source === 'cache') return;
  restartLive();
}

/**
 * Restart — stop then start whatever the UI currently believes.
 * QA-16: a control that says restart must restart, including from a state the
 * next status message was about to clear.
 *
 * THE ONE THING THAT CAN STOP IT IS THE MODEL, and it is `reconcile()`'s gate,
 * verbatim, for `reconcile()`'s reason: `startLive()` below attaches a capture,
 * and attaching a capture makes the engine fetch the weights. This is the
 * SECOND route into `startLive()` and the only one with no gesture behind it —
 * `onContentJump()` gets here from a seek, which is the page's event and not
 * the user's consent — so ungated it spent the one-time download on a deck
 * whose prompt the user had just DECLINED. `tools/embed-smoke.mjs` asserts both
 * halves: that declining downloads nothing, and that a jump does not undo it.
 *
 * QA-16 is not weakened by returning here. With the weights on disk
 * `modelInTheWay()` is false and every latch below still clears; without them
 * there is nothing to restart into but a stall.
 *
 * [entry points: onContentJump(), and the error banner's Restart button]
 */
function restartLive() {
  if (modelInTheWay()) return;
  err = null;
  waiting = false;
  halted = false;      // Restart is also "clear the latch" — the failure set it.
  toOff({ type: 'LIVE_STOP', deck: DECK });
  startLive();
  live.status = 'priming';
  live.primedPct = 0;
  paint();
}

// ------------------------------------------------------------------- model
/**
 * THE ONE-TIME DOWNLOAD, and the reason it is a prompt rather than a side
 * effect.
 *
 * `DECK_PREPARE` builds the ORT session, and building it FETCHES THE WEIGHTS if
 * they are not cached — 172 MiB. This page used to send it unconditionally at
 * boot, so merely opening the deck started the only network request this
 * product ever makes, with no indication and no consent. That is the wrong
 * default for a tool whose entire claim is that nothing leaves the machine: the
 * user cannot believe the claim if the extension is downloading things it never
 * mentioned.
 *
 * So: prepare ONLY when the weights are already on disk, and otherwise ask.
 */
const modelStatus = () => (engineInfo && engineInfo.model && engineInfo.model.status) || 'unknown';
let prepared = false;

function maybePrepare() {
  // 'cached' = on disk, session not built yet. 'ready' = nothing left to do.
  if (prepared || modelStatus() !== 'cached') return;
  prepared = true;
  toSw({ type: 'SW_DECK_PREPARE', deck: DECK });
}

function openModelDialog() {
  const d = $('modeldlg');
  if (!d.open) d.showModal();
  document.body.dataset.modal = '1';
  reportHeight();
  paintModel();
}

function closeModelDialog() {
  const d = $('modeldlg');
  if (d.open) d.close();
  delete document.body.dataset.modal;
  reportHeight();
}

function paintModel() {
  const m = (engineInfo && engineInfo.model) || {};
  const loading = m.status === 'loading';
  text($('mdl-size'), fmtBytes(m.total || MODEL.bytes));
  $('mdl-bar').hidden = !loading;
  $('mdl-go').disabled = loading;
  text($('mdl-go'), loading ? 'Downloading…' : 'Download');
  if (loading) {
    const p = m.total ? m.got / m.total : 0;
    $('mdl-bar').firstElementChild.style.setProperty('--p', String(p));
    // The phases are not decoration: `verify` is a SHA-256 over 172 MiB and
    // `session` is an ~8 s shader compile, and both look like a stalled
    // download if the dialog keeps saying "downloading" through them.
    text($('mdl-note'), {
      download: `${Math.round((m.got / (m.total || 1)) * 100)}% — downloading`,
      cache: 'reading the cache', verify: 'verifying the checksum',
      session: 'preparing the GPU', warmup: 'compiling shaders',
    }[m.phase] || 'working');
  } else {
    text($('mdl-note'), m.status === 'error' ? (m.error || 'The download failed.') : '');
  }
}

// -------------------------------------------------------------------- paint
function paint() {
  const armed = !!session.tabId;
  // The header names no title and no URL — the page behind this frame is
  // already showing both (embed.html). The one thing it cannot say is how to
  // arm a tab, and a browser-level invocation is the only thing that grants
  // capture, so no button here can stand in for the sentence.
  text($('src-sub'), armed ? '' : 'Click the Stem Splitter Live toolbar icon on this tab to arm it.');

  paintStatus();
  paintBanner();
  paintStrips();
}

function paintStatus() {
  const el = $('stat-chip');
  const m = engineInfo && engineInfo.model;
  // The MODEL percentage only while the engine says that is what it is waiting
  // for. `m.status === 'loading'` alone is not enough: the model can be loading
  // for the welcome page while this deck is priming its ring perfectly happily.
  const modelPct = live.phase === 'model' && m && m.total ? (m.got / m.total) * 100 : null;
  const c = chip({
    armed: !!session.tabId,
    halted,
    status: live.status,
    videoPlaying,
    passthrough: live.passthroughNow,
    primedPct: live.primedPct,
    modelPct,
  });
  text(el, c.label);
  el.dataset.k = c.kind;

  // BEHIND VIDEO. One implementation, in audio-math, driven by latencySec and
  // never by ring depth — see the note there. Its two non-numeric answers are
  // dropped here: '—' is "nothing to report" and 'priming' is already the chip
  // above, in more detail.
  /**
   * A CACHED DECK GETS ITS OWN READOUT, and it must not reuse the live one.
   * `behindText` renders 48 ms of output buffer as "−0.0 s", which reads as a
   * rounding error in the live figure rather than as the different regime it
   * is — and the whole point the user needs to see is that this play is free
   * and locked to the picture. Say so in words.
   */
  const cached = live.source === 'cache';
  const parts = cached
    ? ['cached', ...(live.status === 'running' ? ['in sync · 0 % GPU'] : [])]
    : [behindText(live.status, live.latencySec)];
  const buf = bufState(live);
  if (!cached && (buf === 'tight' || buf === 'starve')) parts.push(buf === 'tight' ? 'buffer tight' : 'buffer empty');
  if (live.drops) parts.push(`${live.drops} dropped`);
  text($('stat-num'), parts.filter((p) => p && p !== '—' && p !== 'priming').join(' · '));

  // The one standing warning worth the space: no SharedArrayBuffer means the
  // engine cannot run at all, and it is a property of the Chrome build rather
  // than anything the user did.
  const sab = engineInfo && engineInfo.boot && engineInfo.boot.sab === false;
  text($('note'), sab ? 'SharedArrayBuffer is unavailable in this Chrome build — capture cannot run.' : '');
}

function paintBanner() {
  const sum = errorSummary(err ? [{
    id: DECK, code: err.code, message: err.message, fatal: !err.advisory,
    action: errorAction(err.code, err.advisory),
  }] : []);
  const b = $('banner');
  b.hidden = !sum;
  if (!sum) return;
  b.dataset.sev = sum.sev;
  b.setAttribute('role', sum.sev === 'advisory' ? 'status' : 'alert');
  text($('err-t'), sum.title);
  text($('err-p'), sum.message);
  // Restart only when restarting can actually fix it. The arm family needs a
  // toolbar click on the tab, which no button on this page can be — offering
  // one is the QA-16 footgun.
  $('err-rx').hidden = sum.action !== 'restart';
  // Dismissible only for the arm family: those are statements about a gesture
  // already made. A live failure describes the deck's state NOW and must not be
  // clickable away.
  $('err-x').hidden = !ARM_CODES.has(err.code);
}

// ----------------------------------------------------------------- keyboard
/**
 * DESIGN §11, cut to one deck. `1`-`6` mute, `Shift` solos, `Alt` resets the
 * fader, `0` is unmute-all, `Esc` clears solos, `?` is the list. What each key
 * DOES is `shortcut()` in embed-state.js, pure and asserted there; this half is
 * the two wires into it and the effects.
 *
 * ---------------------------------------------------------------------------
 * THERE ARE TWO ENTRY POINTS AND ONLY ONE OF THEM IS THIS DOCUMENT.
 *
 * This deck is a cross-origin iframe, so a key only arrives here when the FRAME
 * has focus. The gesture the feature exists for is the other one: the user
 * clicks YouTube's play button, so focus is on the YouTube document, and every
 * digit goes to YouTube's seek-to-percentage handler. That path is
 * `content.js`'s capture-phase listener, which forwards the event as a `KEY`
 * message — and which asks THIS file, via `postDeck()`, which codes to
 * intercept, so the host cannot take a key this build does not use.
 */
const keysDlg = () => $('keysdlg');
const keysOpen = () => keysDlg().open;

/**
 * ENTRY POINT: this frame's own document. Deliberately NOT the same rule as
 * `content.js`'s: a checkbox is not typing, and this document's only checkbox
 * is the autoplay setting sitting a Tab away from the faders. On the host page
 * the coarse rule is the right one — when in doubt there, hand the key back.
 */
function isTyping(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'radio';
}

/**
 * @returns {boolean} did we act — i.e. must the caller swallow the key.
 */
function applyShortcut(r) {
  switch (r.act) {
    case 'mute': toggleMute(STEM_ORDER[r.index]); return true;
    case 'solo': toggleSolo(STEM_ORDER[r.index]); return true;
    case 'reset': resetFader(STEM_ORDER[r.index]); return true;
    case 'unmute-all': unmuteAll(); return true;
    case 'clear-solo': clearSolo(); return true;
    case 'help-open': openKeys(); return true;
    case 'help-close': closeKeys(); return true;
    default: return false;
  }
}

document.addEventListener('keydown', (e) => {
  const acted = applyShortcut(shortcut({
    code: e.code, key: e.key, shift: e.shiftKey, alt: e.altKey,
    ctrl: e.ctrlKey, meta: e.metaKey, repeat: e.repeat,
    typing: isTyping(e.target), hasSolo: anySolo(), overlayOpen: keysOpen(),
  }));
  if (acted) e.preventDefault();
});

/**
 * ENTRY POINT: a key pressed on the YOUTUBE page and forwarded by content.js.
 * `typing` is false rather than re-derived — the host checked its own document,
 * which is the only one that had a target, and re-deriving it here against THIS
 * document's focus would be answering a question about the wrong page.
 */
function onHostKey(d) {
  applyShortcut(shortcut({
    code: d.code, key: d.key, shift: d.shift === true, alt: d.alt === true,
    ctrl: false, meta: false, repeat: d.repeat === true,
    typing: false, hasSolo: anySolo(), overlayOpen: keysOpen(),
  }));
}

/**
 * THE KEY CAPS, LETTERED FOR THE KEYBOARD THIS BROWSER IS ON.
 *
 * ENTRY POINT: boot, once, over this whole document — and `__embed.relabel()`,
 * which is the harness's only reason for existing here (embed-smoke drives it
 * with both values so the two renderings can be compared on one machine).
 *
 * IT IS LETTERING AND NOTHING ELSE. Every binding is unchanged: Option is what
 * sets `event.altKey`, so `Alt`+`↑` and `Alt`+`1` already worked on a Mac and
 * only said the wrong thing. See embed-state.js's `modLabel()` header for the
 * cap-versus-prose rule.
 *
 * `role="img"` IS WHAT MAKES THE ACCESSIBLE NAME COUNT. `aria-label` on a bare
 * `<span>` names nothing — the generic role forbids it, and screen readers are
 * entitled to ignore it. With the role, `⌥` is announced as "Option", which is
 * the word Apple prints on the key; without the role a Mac user on a screen
 * reader would hear the glyph's Unicode name or nothing at all, which is the
 * same defect the sighted user had. Off a Mac the chip is a word already, so
 * both attributes come back off — an `aria-label` duplicating the text is one
 * more thing to drift.
 *
 * A `data-mod` this build cannot spell is LEFT ALONE rather than blanked, and
 * embed-state.js's overlay pin is what turns that into a red.
 */
function relabel(mac) {
  for (const el of document.querySelectorAll('[data-mod]')) {
    const l = modLabel(el.dataset.mod, mac);
    if (!l) continue;
    el.textContent = l.text;
    if (l.say === l.text) { el.removeAttribute('role'); el.removeAttribute('aria-label'); }
    else { el.setAttribute('role', 'img'); el.setAttribute('aria-label', l.say); }
  }
}
const MAC = isMac();
relabel(MAC);

function openKeys() {
  const d = keysDlg();
  if (!d.open) d.showModal();
  reportHeight();
  postDeck();
}
function closeKeys() {
  const d = keysDlg();
  if (d.open) d.close();
  reportHeight();
  postDeck();
}

/**
 * WHAT THE HOST PAGE NEEDS TO KNOW, and it is exactly two things: is a deck
 * armed, and which key codes are ours.
 *
 * ARMED IS THE PRODUCT'S GATE. With no deck armed, `1`-`6` must reach YouTube and
 * seek to 10-60 % exactly as they do with the extension uninstalled — we are a
 * guest on their page and a shortcut that only sometimes belongs to us has to
 * name the condition.
 *
 * THE KEY LIST IS SENT RATHER THAN COPIED. `content.js` is a classic script in
 * an isolated world and cannot import `embed-state.js`, so the alternative is a
 * second hand-maintained list of codes in the file that calls `preventDefault()`
 * — i.e. a second place to forget that this build has no deck B. It is posted
 * on every change (a solo going up makes `Esc` ours; the overlay opening does
 * too) and deduped, because `paintStrips()` runs on every fader move.
 */
let lastDeckPost = '';
function postDeck() {
  const msg = {
    from: 'stem-splitter-live', type: 'DECK',
    armed: !!session.tabId,
    keys: hostKeys({ anySolo: anySolo(), overlayOpen: keysOpen() }),
  };
  const j = JSON.stringify(msg);
  if (j === lastDeckPost) return;
  lastDeckPost = j;
  parent.postMessage(msg, '*');
}

// ---------------------------------------------------------------- transpose
/**
 * ±6 semitones, integer steps, and nothing between them: `engine/pitch.js` ships
 * thirteen rational ratios and has no meaning for 2.4.
 *
 * THE WIRE MESSAGE IS `{ type: 'PITCH', deck, semitones }` — the same
 * `chrome.runtime` shape as every other UI -> engine message this file sends, and
 * the one `offscreen.js` switches on. It is NOT the worklet's `{ t: 'pitch' }`:
 * that is a different boundary (main thread -> audio thread, over the node's
 * MessagePort) and it stays as it is. Two wires, two shapes, and unifying them
 * would mean one of the two routers has to guess.
 *
 * `deck` rides along because every message this file sends names deck A
 * explicitly rather than letting the two-deck engine's field default (see the
 * header).
 */
function setSemitones(n) {
  const v = clampSemitones(n);
  if (v === semitones) return;
  semitones = v;
  toOff({ type: 'PITCH', deck: DECK, semitones });
  paintTranspose();
  // The key readout is DERIVED from the concert tonic and this number. It is
  // re-derived, never re-shifted — see paintKey().
  paintKey();
}

function paintTranspose() {
  const el = $('tr-v');
  const sign = semitones > 0 ? '+' : MINUS;
  text(el, semitones === 0 ? '0' : `${sign}${Math.abs(semitones)}`);
  // 0 IS THE HOME POSITION AND LOOKS LIKE IT (`.tr__v[data-home]`): it is the
  // absence of a setting, not a setting. Any other value is filled, so a deck
  // left at +3 cannot be mistaken for one at the recording's own pitch.
  el.dataset.home = String(semitones === 0);
  el.setAttribute('aria-label', semitones === 0
    ? 'Transpose: 0 semitones, the recording\'s own key. Press to reset'
    : `Transpose: ${semitones > 0 ? 'up' : 'down'} ${Math.abs(semitones)} semitone${Math.abs(semitones) === 1 ? '' : 's'}. Press to reset`);
  $('tr-dn').disabled = semitones <= SEMITONE_MIN;
  $('tr-up').disabled = semitones >= SEMITONE_MAX;
}

// -------------------------------------------------------------- key readout
/**
 * WHAT KEY IS THIS, AND WHAT DO I READ IT AS.
 *
 * THE ENGINE SENDS THE CONCERT TONIC AND NOTHING ELSE. The transpose and the
 * horn are composed here, in ONE call to `displayKey`, which is the single
 * mod-12 in the whole feature. Its header is the reason the shift is ADDED: the
 * chroma tap sits on the `other` stem UPSTREAM of the pitch shifter, so the
 * user's ±6 is not in the spectra the detector saw.
 *
 * `keyMsg` HOLDS THE CONCERT TONIC AND IS RE-DERIVED ON EVERY CHANGE. The bug
 * this avoids is storing the SHIFTED tonic and shifting it again: it looks
 * right until someone sweeps the control up and back down, and then the key is
 * wrong by twice the excursion with nothing on screen to say so.
 */
let keyView = { show: 'none' };

function paintKey() {
  const plan = keyPlan(keyMsg);
  const box = $('keybox');
  box.dataset.show = plan.show;
  const st = $('key-state'), written = $('key-written'), concert = $('key-concert'), scale = $('key-scale');

  if (plan.show === 'key') {
    const d = displayKey(plan.tonic, plan.mode, semitones, instrument);
    // With the concert horn the two lines are the same key, so the second one
    // is dropped rather than printed twice. Both remaining lines still carry
    // their label — an unlabelled key name here is a bug, not a shorter string.
    const dup = d.written.tonic === d.concert.tonic;
    text(written, dup ? d.concert.label : d.written.label);
    text(concert, dup ? '' : d.concert.label);
    // The notes as they are FINGERED, which is the written spelling.
    text(scale, (dup ? d.concert : d.written).scale);
    text(st, semitones === 0 ? '' : `shifted ${semitones > 0 ? '+' : MINUS}${Math.abs(semitones)}`);
    box.removeAttribute('title');
    keyView = { show: 'key', written: d.written.label, concert: d.concert.label, scale: (dup ? d.concert : d.written).scale };
  } else if (plan.show === 'listening') {
    // The number comes from the policy the ENGINE runs, so the promise on
    // screen cannot drift from the gate that keeps it.
    text(st, `listening… (about ${DISPLAY_POLICY.minListenSec} s)`);
    text(written, ''); text(concert, ''); text(scale, '');
    box.removeAttribute('title');
    keyView = { show: 'listening' };
  } else if (plan.show === 'bad') {
    /**
     * SAY SO. A view that guarded with `key && key.tonic` and otherwise drew
     * nothing would look healthy on exactly the runs where the engine sent
     * something this build cannot read — the `!x || (check)` shape, one level
     * up in the UI. The payload goes in the title so a bug report carries it.
     */
    text(st, 'key unavailable');
    text(written, ''); text(concert, ''); text(scale, '');
    box.title = `The engine sent a key this deck could not read: ${JSON.stringify(keyMsg)}`;
    keyView = { show: 'bad' };
  } else {
    text(st, ''); text(written, ''); text(concert, ''); text(scale, '');
    box.removeAttribute('title');
    keyView = { show: 'none' };
  }
}

// -------------------------------------------------------------------- speed
/**
 * SPEED — the page's own player, on 29 musical rungs.
 *
 * IT IS KEY-LOCKED, and nothing of ours resamples anything: `content.js` writes
 * `video.playbackRate` on the page's own element with `preservesPitch` left TRUE
 * (`SPEED_KEY_LOCK`), and Chrome's media pipeline does the work — exactly as it
 * does for YouTube's own speed menu. The capture tap is downstream of it, so the
 * model still sees one integer sample clock at 44 100 Hz and AGENTS.md's
 * prohibition is nowhere near this.
 *
 * SPEED IS KEY-LOCKED, reversing an earlier varispeed design. This block used to
 * say the pitch followed the speed. It did, and that was the defect: the element
 * transposed the audio before the tap, so the separator was fed the wrong key.
 * SPEED moves the tempo; TRANSPOSE is the only control that moves the key; the
 * two compose. Nothing on this surface may print an interval for a rate again —
 * a label stating an invariant the code does not hold is the same defect as an
 * assertion doing it, except the user is the one who finds out.
 *
 * THE READOUT REPORTS THE ELEMENT AND NEVER OUR LAST REQUEST. `playbackRate` has
 * two writers — us and YouTube's menu — so a UI painting its own last request
 * lies the moment the user opens that menu. `pageRate` below is the element's,
 * arriving on `VIDEO` and on content.js's `SPEED` report; our buttons are a
 * second way to write one truth, like a second remote for one television.
 *
 * TWO WIRES, AND THEY ARE NOT ONE FUNCTION:
 *   - `{from:'stem-splitter-live', type:'SPEED', rate}` to the HOST, which owns the
 *     range clamp, the ad neutralisation and the re-assert across an ad
 *     (speed.js);
 *   - `{type:'SPEED', deck, rate}` to the ENGINE, which is the only place that
 *     can tell a live deck from a cached one and the only place a refusal can be
 *     said (offscreen.js). It echoes SPEED_STATE on both paths.
 * Neither of them may ever fire on a cached deck, and neither can: `speedGate`
 * refuses `source === 'cache'` before either send, which is also what keeps this
 * mutually exclusive with `syncVideoLock`'s VDRIVE — see the note there.
 */
/** THE ELEMENT'S rate, as the page last reported it. Never our request. */
let pageRate = 1;
/** `speed.js`'s verdict, forwarded by content.js. Drives the greying. */
let speedRep = { state: null, why: null };
/**
 * The one change in flight: `{rate, atMs}`, or null. There is never more than
 * one, because there is only ever one rate.
 */
let spPending = null;
/** Rates are compared with a tolerance; they have been through a message channel. */
const RATE_EPS = 1e-9;

const fmtRate = (r) => `${r.toFixed(2)}×`;
// `fmtSemis` lived here and formatted the speed ladder's rung as a signed
// interval. Deleted with the varispeed reversal (2026-08-17) rather than left
// unused: the rate does not transpose, so nothing on this control has a
// semitone to print. TRANSPOSE formats its own sign inline at paintTranspose.
const spGate = () => speedGate({ state: speedRep.state, why: speedRep.why, source: live.source });

/**
 * HOW LONG UNTIL THE PRESS IS HEARD, in WALL TIME.
 *
 * It does not scale with the rate — 3.4 s at 2.00x is still 3.4 s of your life,
 * and 6.8 s of the track — and it is read from `live.latencySec`, the engine's
 * own measured figure and the same field the header's BEHIND VIDEO uses. Never
 * a literal 3.4; the copy on screen may not drift from the pipeline.
 *
 * ZERO ON A DECK THAT IS NOT RUNNING, which is the whole of the "a stopped
 * deck's countdown stops" rule: the change is not going to be heard, so there is
 * nothing to count down to.
 */
const spRemainMs = () => {
  if (!spPending || !RUNNING.has(live.status)) return 0;
  return Math.max(0, spPending.atMs + live.latencySec * 1000 - Date.now());
};

/**
 * THE ELEMENT MOVED. ONE ENTRY POINT for a fact that arrives on two messages —
 * `VIDEO.playbackRate` and content.js's `SPEED` report's `applied` — because a
 * rate that is right on one of those and wrong on the other is AGENTS.md's
 * entry-point family at its smallest scale.
 *
 * A rate we cannot read is NOT written here. It is `speedGate`'s business: the
 * transport reports `state:'missing'` for the same element and the control greys
 * with the reason, which is strictly better than the readout quietly holding a
 * stale number.
 */
function onElementRate(n) {
  const r = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  if (r === null || Math.abs(r - pageRate) <= RATE_EPS) return;
  pageRate = r;
  /**
   * ...AND THE DISPLAYED TEMPO IS NOW WRONG, whoever moved the rate. The audio
   * the detector locked onto is a different tempo from the audio now arriving,
   * and a dim wrong number is still a wrong number. This is here rather than in
   * `setSpeed()` deliberately: YouTube's own menu invalidates the lock exactly
   * as our button does, and this is the one place that sees both.
   */
  markBpmStale();
}

/**
 * THE PRESS. The only writer of the rate on this surface, reached from the two
 * nudge buttons and from the value (which resets to home) — one function, so a
 * click and a Shift-click cannot end up meaning two different things.
 */
function setSpeed(rate) {
  // A greyed control does nothing, and that is the second half of the rule: it
  // is greyed, it explains itself, and it cannot act. An `aria-disabled` button
  // is still clickable, so this early return is what makes it inert.
  if (!spGate().ok) return;
  /**
   * THE LAST GATE BEFORE THE WIRE, exactly as `clampSemitones` is for TRANSPOSE.
   * Every caller already hands a rung, so this is belt and braces — but it is
   * the belt that guarantees a NaN can never reach `video.playbackRate`, which
   * throws in Blink.
   */
  const r = snapSpeed(rate);
  if (Math.abs(r - pageRate) <= RATE_EPS && !spPending) return;

  // PAINT FIRST, SEND SECOND (DESIGN §6.3) — but OUTLINED, because it is
  // committed and not yet heard. Pressing again restarts the countdown.
  spPending = { rate: r, atMs: Date.now() };
  paintSpeed();
  parent.postMessage({ from: 'stem-splitter-live', type: 'SPEED', rate: r }, '*');
  toOff({ type: 'SPEED', deck: DECK, rate: r });
}

/**
 * speed.js's REPORT, forwarded by content.js. ENTRY POINT: the host
 * `SPEED` message, which arrives on every media event that can move the rate and
 * on the settle poll — and once more, undeduped, when a remounted deck says
 * READY, so a deck that mounted late is not left with no state at all.
 */
function onSpeedReport(d) {
  speedRep = {
    state: typeof d.state === 'string' ? d.state : null,
    why: typeof d.why === 'string' ? d.why : null,
  };
  /**
   * SOMEBODY ELSE MOVED IT. `why: 'yield'` is `speedPlan`'s unambiguous word for
   * "the element's rate changed and it was not us" — and it is the ONLY signal
   * that can tell YouTube's own menu from our own write still being in flight.
   * No inspection of the VALUE can separate those two, which is the whole
   * argument in speedPlan's header. Our pending change is over; the readout
   * reports the element.
   */
  if (d.why === 'yield') spPending = null;
  onElementRate(d.applied);
  paintSpeed();
}

function paintSpeed() {
  const box = $('spbox');
  const dn = $('sp-dn');
  const up = $('sp-up');
  const v = $('sp-v');
  const gate = spGate();

  /**
   * SETTLE FIRST. The pending change is over when the element has confirmed it
   * AND the audio has caught up; on a stopped deck the second half is zero, so
   * it settles on the confirmation alone. It is evaluated HERE — on the arrival
   * of a message or on a press — and never on a timer, the rule `paintMeter`'s
   * header states: a loop that kept counting after the engine stopped sending
   * would animate a number nobody measured.
   */
  if (spPending && Math.abs(pageRate - spPending.rate) <= RATE_EPS && spRemainMs() <= 0) spPending = null;

  const r = spPending ? spPending.rate : pageRate;
  const far = speedFar(r);
  const home = Math.abs(r - SPEED_HOME) <= RATE_EPS;
  const onGrid = far.semitones !== null;
  const remain = spRemainMs();

  box.dataset.state = gate.ok ? 'ok' : gate.why;
  box.dataset.pending = String(remain > 0);
  box.dataset.far = String(far.far);

  const dnTo = stepSpeed(r, -1);
  const upTo = stepSpeed(r, 1);
  const atFloor = dnTo === r;
  const atCeil = upTo === r;

  /**
   * TWO DIFFERENT DISABLED-NESSES, and it is DESIGN §12's distinction applied in
   * the direction that helps. An END STOP uses the real `disabled` attribute:
   * the value on screen IS the explanation, so it needs none and may leave the
   * tab order. A REASONED LOCKOUT uses `aria-disabled`, so it stays reachable
   * and the reason under it can be read.
   */
  for (const b of [dn, v, up]) {
    if (gate.ok) b.removeAttribute('aria-disabled');
    else b.setAttribute('aria-disabled', 'true');
  }
  dn.disabled = gate.ok && atFloor;
  up.disabled = gate.ok && atCeil;

  // The buttons name WHERE THEY WILL LAND, which is what makes a non-uniform
  // step need no explanation — and what replaces the "2 percent" the old labels
  // carried, which no longer describes anything outside the fine band.
  dn.title = atFloor ? SP_END_LOW : `Slower — ${fmtRate(dnTo)} (Shift: ${fmtRate(stepSpeed(r, -1, true))})`;
  up.title = atCeil ? SP_END_HIGH : `Faster — ${fmtRate(upTo)} (Shift: ${fmtRate(stepSpeed(r, 1, true))})`;

  text(v, fmtRate(r));
  v.dataset.home = String(home);
  v.setAttribute('aria-label', `Speed: ${r.toFixed(2)} times, ${speakRate(r, far, home, onGrid)}. Press to reset`);

  /**
   * ONE SLOT, FOUR JOBS, STRICT PRECEDENCE: the lockout reason, the far
   * statement, the in-flight countdown, the standing fact. FAR OUTRANKS PENDING
   * because pending is already drawn twice — the value goes outlined and then
   * fills — and the far statement is drawn nowhere else.
   */
  let fine;
  if (!gate.ok) fine = gate.text;
  // NO SEMITONE PREFIX AND NO "no key lock" (2026-08-17). The rate no longer
  // transposes anything, so an interval here would describe nothing the user
  // will hear; and the key IS locked now, which is what makes the remaining
  // half — the phase vocoder roughening the stems — the whole of the warning.
  else if (far.far) fine = 'rougher stems';
  else if (remain > 0) fine = `heard in ${(remain / 1000).toFixed(1)} s…`;
  else if (!onGrid) fine = 'set from YouTube\'s speed menu';
  // ONE BRANCH FOR EVERY ON-GRID RATE. It used to be three, split on whether the
  // rung was a whole semitone — a distinction that only existed because the
  // number printed was a pitch. Nothing prints a pitch, so nothing branches.
  else fine = `${home ? 'speed · ' : ''}key stays${behind()}`;
  text($('sp-fine'), fine);

  // The long form, on hover, for the two states where the fine line is a
  // summary of something the user may want the whole of.
  const title = !gate.ok ? SP_LOCK_TITLE[gate.why] : far.far ? SP_FAR_TITLE : null;
  if (title) box.title = title; else box.removeAttribute('title');
}

/** `· heard 3.4 s later`, or nothing at all on a deck that is not producing. */
const behind = () => (RUNNING.has(live.status) && live.latencySec > 0
  ? ` · heard ${live.latencySec.toFixed(1)} s later` : '');

/**
 * The spoken half of the value, which is the ONLY channel a screen-reader user
 * has for the destination a sighted user reads off the button `title`.
 *
 * PERCENT EVERYWHERE, 2026-08-17. It used to speak SEMITONES outside the fine
 * band, because under varispeed the rung was an interval the user would hear.
 * It is not one any more, and "seven semitones up" spoken over audio that has
 * not moved a cent is the worst version of this defect: the sighted user can at
 * least see the rate, and this channel is all a screen-reader user gets.
 */
function speakRate(r, far, home, onGrid) {
  if (home) return 'the video\'s own speed';
  if (!onGrid) return 'set from YouTube\'s own menu';
  const pct = `${Math.abs(Math.round((r - 1) * 100))} percent ${r > 1 ? 'faster' : 'slower'}`;
  return far.far ? `${pct}. The key stays, but the stems will be rougher` : `${pct}. The key stays`;
}

/**
 * WHAT THE WIDE RANGE COSTS, in the words the ruling used: surface it, do not
 * block it and do not hide it. There is no modal, no dismiss, no "are you sure"
 * and — the important refusal — NO NUMBER for how much worse the stems are. That
 * effect is unmeasured, and a figure would be invented.
 *
 * A CONSTANT AND NOT A FUNCTION, 2026-08-17. It used to interpolate the rung's
 * semitone count and `SEMITONE_MAX`, both of which described the varispeed
 * transposition and the TRANSPOSE reach that could undo it. Neither exists now:
 * the cost is the phase vocoder, it is the same kind of cost at every rate off
 * 1.00x, and there is nothing left for the sentence to vary on.
 */
const SP_FAR_TITLE = 'Holding the key while the speed changes is a phase vocoder, and it '
  + 'smears the fine structure the separator relies on. It still runs, but the stems come '
  + 'back rougher — smeared cymbals, bass leaking into other — and the further from 1.00× '
  + 'you go the worse it gets. The key itself does not move: TRANSPOSE is the only control '
  + 'that moves it, at any speed. Nothing is blocked; this is what the speed you asked for costs.';

const SP_END_LOW = '0.50× is as slow as this control goes. YouTube\'s own speed menu '
  + 'reaches 0.25×.';
const SP_END_HIGH = '2.00× is the ceiling. Past it YouTube\'s own buffer starves and the '
  + 'video stalls, so this control does not offer it.';
/**
 * The long form of each lockout. A `why` with no entry here still greys and
 * still prints `speedGate`'s own sentence in the fine line — the title is the
 * elaboration, never the only channel.
 */
const SP_LOCK_TITLE = {
  missing: 'This control drives the page\'s own player, and this page does not have one.',
  ad: 'The ad is playing through the same player, and YouTube resets its speed between '
    + 'items. The control comes back when the video does.',
  cache: 'This deck has already separated this track and is playing it from disk. The video '
    + 'is a picture now; changing its speed would not change what you hear.',
};

// ---------------------------------------------------------------------- bpm
/**
 * THE TEMPO, from the isolated drums stem. It reports; it locks nothing to
 * anything. There is no sync, no beat grid, no tap tempo and no ×2/÷2 override —
 * every one of those only makes sense with a grid behind it.
 *
 * A CONFIDENT-LOOKING WRONG BPM IS WORSE THAN A BLANK, which is why `bpmPlan()`
 * owns the decision and is asserted on it: every state but `locked` renders an
 * em dash and not one of them renders a digit.
 */
/** The engine's `bpm` field, as it arrived. Never composed, never stored shifted. */
let bpmMsg = null;
/**
 * Until when the engine's lock is STALE because the element's rate changed. The
 * detector's 8 s envelope history is still full of the old tempo, so the wire
 * carries a number that was true of audio nobody is hearing any more.
 * `BPM_WINDOW_SEC` is the engine's own constant, so this cannot drift from the
 * window it describes — and it is read on MESSAGE ARRIVAL, never on a timer.
 */
let bpmStaleUntil = 0;
/** What was last written to the pulse, and when. See beatPulse's drift half. */
let beatWrote = null;

function markBpmStale() {
  bpmStaleUntil = Date.now() + BPM_WINDOW_SEC * 1000;
  paintBpm();
}

/**
 * THE PLAYHEAD, ADVANCED TO NOW, IN ABSOLUTE STEM-RING FRAMES.
 *
 * `bpmtap.js::beatPhaseAt(payload, frame, sr)` is the one call site of the beat
 * modulo and it needs a frame on the axis `beatFrame` is on. BOTH DECK KINDS put
 * one there, under the same name and on the same axis: `live.js` and
 * `cacheddeck.js` each publish `playFrames` (`this.out.readFrames()`, the audio
 * device's own counter) and the `atMs` it was sampled at, read together on
 * adjacent lines so the pair cannot be a phase error dressed as data. This
 * reader therefore does not branch on `live.source` and must not learn to: a
 * surface that had to know which kind of deck it was reading is the defect the
 * shared field name prevents.
 *
 * IT IS ADVANCED, NOT USED RAW. That message is published at 10 Hz and crosses a
 * `chrome.runtime` hop, so the sample is 50-100 ms old by the time this surface
 * paints it; at 128 BPM one beat is 469 ms, so an uncorrected lag is a fifth of a
 * beat of standing phase error. `Date.now() - at` is that age, and the wall clock
 * is the ONE clock the offscreen document and this page share — their
 * `performance` time origins differ, so a difference between those is
 * meaningless. `SR`, not the page rate: the DAC drains the ring in real time
 * whatever speed the element is running at.
 *
 * NULL, NEVER 0, WHEN IT CANNOT LOOK. BOTH engines OMIT `playFrames` when the
 * deck has no output ring, and frame 0 is a real position the ring takes at the
 * start of every run — so `Number.isFinite` is the discriminator and a missing
 * field must not become a number. `beatPulse()` refuses a null phase and the dot
 * goes static, which is the honest state: we have the tempo and not the beat.
 *
 * NOT `positionSec`, WHICH IS THE OTHER FIELD ON THIS MESSAGE. That one is a
 * TRACK position in seconds (`readBase + readFrames()`, clamped and divided by
 * SR), it belongs to the video lock, and it is not on `beatFrame`'s axis — the
 * two differ by `readBase` after a seek. Two meanings, two names.
 */
function beatFrameNow() {
  const f = Number(live.playFrames);
  const at = Number(live.atMs);
  if (!Number.isFinite(f) || !Number.isFinite(at) || at <= 0) return null;
  return f + ((Date.now() - at) / 1000) * SR;
}

function paintBpm() {
  /**
   * DERIVED AT PAINT TIME, NEVER STORED. The engine sends the DETECTED tempo —
   * which already includes the speed, because the speed change is upstream of
   * the capture tap — and the source is `detected / speed` computed here.
   * `paintKey`'s double-shift trap is identical: store the scaled figure and
   * scale it again and it is wrong by twice the excursion with nothing on screen
   * to say so. (In this build the source line is not drawn at all — see
   * BPM_SOURCE_SAFE — but the derivation stays in the one place it belongs.)
   */
  const stale = Date.now() < bpmStaleUntil;
  const plan = bpmPlan(stale ? { state: 'unsure', why: 'respeed' } : bpmMsg, pageRate);
  const box = $('bpmbox');
  box.dataset.show = plan.show;
  if (plan.why) box.dataset.why = plan.why; else box.removeAttribute('data-why');

  text($('bpm-v'), plan.show === 'bpm' ? String(plan.bpm) : plan.show === 'none' ? '' : EM_DASH);
  text($('bpm-src'), plan.source === null ? '' : `${plan.source} at 1.00×`);
  text($('bpm-state'), BPM_STATE_TEXT[plan.why || plan.show] || '');

  /**
   * TRANSPOSE does NOT invalidate this and SPEED does. `pitch.js` is
   * length-exact at 44 100 (`framesIn === framesOut`, condition (b) of the
   * ratified amendment), so it moves pitch and not tempo. Worth saying, because
   * the reflex is to assume both controls invalidate the beat.
   */
  const pulse = beatPulse({
    // The RAW tempo, not the rounded one on screen: a 0.4 BPM period error
    // accumulates into real drift, and the integer exists for the readout.
    bpm: plan.show === 'bpm' && bpmMsg ? Number(bpmMsg.bpm) : null,
    phase: plan.show === 'bpm' ? beatPhaseAt(bpmMsg, beatFrameNow(), SR) : null,
    ageMs: 0,
    now: Date.now(),
    prev: beatWrote,
  });
  box.dataset.pulse = pulse.run ? 'on' : 'off';
  if (pulse.run && pulse.write) {
    const el = $('bpm-pulse');
    el.style.setProperty('--beat-ms', `${pulse.periodMs}ms`);
    el.style.setProperty('--beat-off', `-${pulse.offsetMs}ms`);
    beatWrote = { periodMs: pulse.periodMs, offsetMs: pulse.offsetMs, atMs: Date.now() };
  }
  if (!pulse.run) beatWrote = null;

  text($('bpm-fine'), plan.show === 'bpm' || plan.show === 'unsure' || plan.show === 'listening'
    ? `from the drums stem${pulse.halved ? ' · pulse at half time' : ''}` : '');

  if (plan.show === 'unsure') {
    box.title = 'A wrong tempo is worse than none, so this stays blank until the detector is sure.';
  } else if (plan.show === 'bad') {
    // The payload goes in the title so a bug report carries it, as paintKey does.
    box.title = `The engine sent a tempo this deck could not read: ${JSON.stringify(bpmMsg)}`;
  } else {
    box.removeAttribute('title');
  }
  bpmView = { show: plan.show, why: plan.why, bpm: plan.bpm, source: plan.source, pulse: pulse.run };
}

let bpmView = { show: 'none' };
/** U+2014. The minus is U+2212 and lives in audio-math as MINUS; this is neither. */
const EM_DASH = '—';
/**
 * The state word. `listening` reads its number from the ENGINE'S own window, so
 * the promise on screen cannot drift from the gate that keeps it — the same
 * argument `DISPLAY_POLICY.minListenSec` already carries one box over.
 *
 * The four unsure reasons are separate strings because their REMEDIES differ and
 * the user can act on the difference: wait (`silent`, `free`, `respeed`) against
 * do not wait (`ambiguous`). They share one appearance, so the box has exactly
 * one look for "I don't know".
 */
const BPM_STATE_TEXT = {
  listening: `listening… (about ${BPM_WINDOW_SEC} s)`,
  silent: 'no drums yet',
  free: 'no steady beat',
  ambiguous: 'beat unclear',
  respeed: 're-reading after the speed change',
  // The detector threw and is off until the next start. Its own words, because
  // a broken detector and one that is listening must not read the same.
  fault: 'tempo detector stopped',
  bad: 'BPM unavailable',
};

// --------------------------------------------------------------- preferences
/**
 * `chrome.storage.local`, key `prefs`. `local` and not `sync` because `sync` is
 * a network write and P1 forbids the network after the model download; not
 * `session` because a preference has to outlive the browser.
 *
 * THE CONTENT SCRIPT READS THIS KEY ITSELF and follows `storage.onChanged`, so
 * nothing here messages it — and that is deliberate rather than lazy: hiding the
 * deck removes the iframe while the pipeline keeps running, and a preference
 * that travelled by postMessage would go stale at exactly that moment.
 */
const PREFS_KEY = 'prefs';

/**
 * ponytail: the suppression rule is `resolveSuppress` in `autonav.js` and
 * this is a second copy of its one line. It cannot be imported: autonav.js is a
 * classic content script with no exports, in another world. Ceiling — the two
 * can disagree about a malformed record. Upgrade path: move the rule into a
 * shared ES module that autonav.js re-declares, once anything else needs it.
 * The half that matters is asserted there: only the literal `true` hands
 * autoplay back to YouTube.
 */
const suppressFrom = (p) => !(p && p.autoplayNext === true);

/**
 * Is this a horn this surface can both SPELL and SHOW? `INSTRUMENTS` carries
 * five and the picker offers three (bari doubles for alto and soprano for
 * tenor, at the same offset), so the picker is the narrower test and it is read
 * off the DOM rather than copied — a list of three strings here would be a
 * second place to edit when a fourth option is added.
 */
const knownInstrument = (v) => Object.prototype.hasOwnProperty.call(INSTRUMENTS, v)
  && [...$('inst').options].some((o) => o.value === v);

function applyPrefs(p) {
  prefs = p && typeof p === 'object' ? p : {};
  $('autonav-cb').checked = suppressFrom(prefs);
  // A stored instrument we do not recognise is not a reason to throw out of
  // displayKey later, nor to leave the picker blank; it is a reason to use the
  // default now.
  instrument = knownInstrument(prefs.instrument) ? prefs.instrument : 'concert';
  $('inst').value = instrument;
  paintKey();
}

function writePrefs(patch) {
  prefs = { ...prefs, ...patch };
  chrome.storage.local.set({ [PREFS_KEY]: prefs }).catch(() => {});
}

// ------------------------------------------------------- autoplay advisory
/**
 * `content.js` reports every outcome of the autoplay suppression by name,
 * including the two it cannot do anything about. Three of them mean the feature
 * is not working and the user's next video may start on its own.
 *
 * IT MUST NOT LATCH `halted`. That flag stops the deck and refuses to restart
 * it, and every existing raise site is a failure of the AUDIO. This is a
 * preference we could not impose on somebody else's player: the deck is fine,
 * the mix is fine, and stopping it would be a far worse outcome than the thing
 * being reported. Advisory, dismissible, and it never touches the error banner.
 */
const NAV_MSG = {
  missing: 'Couldn\'t turn off YouTube\'s autoplay — the next video may still start. '
    + 'YouTube\'s controls have changed.',
  stuck: 'Couldn\'t turn off YouTube\'s autoplay — their control didn\'t respond. '
    + 'The next video may still start.',
  lost: 'YouTube\'s autoplay control disappeared before it could be put back the way '
    + 'you had it. It will be restored on the next video.',
};

function onAutonav(d) {
  const bad = NAV_MSG[d.state] ? d.state : null;
  if (!bad) {
    // Any healthy state clears BOTH the banner and the dismissal: the next
    // failure is a new fact and has to be allowed to say so.
    navErr = null;
    navDismissed = null;
  } else {
    navErr = bad === navDismissed ? null : bad;
  }
  paintNav();
}

function paintNav() {
  const b = $('nav-banner');
  b.hidden = !navErr;
  if (navErr) text($('nav-p'), NAV_MSG[navErr]);
}

// ------------------------------------------------------------------ messages
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.to !== 'ui') return false;
  // The engine is the two-deck one. Nothing addressed to deck B may paint this
  // surface — an absent `deck` means A (normalizeDeck), which is the single-deck
  // engine's own convention.
  const forOther = 'deck' in m && normalizeDeck(m.deck) !== DECK;

  switch (m.type) {
    case 'LIVE_STATE': {
      if (forOther) break;
      live.status = m.status || 'idle';
      live.phase = m.phase === 'model' || m.phase === 'ring' ? m.phase : null;
      live.latencySec = Number(m.latencySec) || 0;
      live.bufferMinSec = Number(m.bufferMinSec) || 0;
      live.floorSec = Number(m.floorSec) || 0;
      live.primedPct = Number(m.primedPct) || 0;
      live.passthroughNow = m.passthroughNow === true;
      live.drops = Number(m.drops) || 0;
      live.source = m.source === 'cache' ? 'cache' : 'live';
      live.positionSec = Number(m.positionSec) || 0;
      live.durationSec = Number(m.durationSec) || 0;
      live.atMs = Number(m.atMs) || 0;
      /**
       * NO `|| 0`, AND THAT IS THE WHOLE POINT OF THIS LINE. BOTH `live.js` and
       * `cacheddeck.js` OMIT `playFrames` when the deck has no output ring
       * — and a cache hit is where this reader spends the second listen to any
       * track, so it is not the rare path. `Number(undefined)` is
       * NaN, which `beatFrameNow()` rejects on `Number.isFinite`. Written like
       * every field above it, a missing playhead would arrive as frame 0 — a real
       * position the ring takes at the start of every run — and the pulse would
       * light against a sample nobody took.
       */
      live.playFrames = Number(m.playFrames);
      // CONCERT TONIC ONLY, held as it arrived. The shift and the horn are
      // applied at one call site in paintKey() and never stored.
      keyMsg = m.key || null;
      // ...and the tempo, held the same way: the DETECTED figure, with the
      // source derived at paint time and never stored (paintBpm).
      bpmMsg = m.bpm || null;
      paintKey();
      paintBpm();
      // The countdown under the speed control is driven by THIS arrival and by
      // nothing else — never a timer, never a rAF loop.
      paintSpeed();
      syncVideoLock();
      reconcile();
      paint();
      break;
    }
    case 'METERS': {
      if (forOther) break;
      const pk = m.peak || {};
      const rm = m.rms || {};
      const now = performance.now();
      // The FIRST message of a run has no previous one to measure against, and
      // the engine posts at ~30 Hz, so 33 ms is the honest stand-in rather than
      // a dt of "however long this deck has been idle".
      const dtMs = meterAt ? Math.min(now - meterAt, 500) : 33;
      meterAt = now;
      for (const s of STEM_ORDER) paintMeter(s, now, dtMs, pk[s], rm[s]);
      break;
    }
    case 'LIVE_ERROR': {
      if (forOther) break;
      // HOP_PENDING / HOP_MARGINAL are the engine's ADVISORY channel and this
      // build has no hop control, so it cannot cause them and treats anything
      // it does not recognise as fatal — the honest default for a surface that
      // cannot classify.
      const advisory = m.code === 'HOP_PENDING' || m.code === 'HOP_MARGINAL';
      if (advisory && err && !err.advisory) break;
      // A fatal switches the deck off. `follow()` refuses to auto-restart an
      // `error` status by itself, but the engine can also stop a deck without
      // moving off `running` — and then the switch, not the status, is what
      // stops the loop.
      if (!advisory) { live.status = 'error'; halted = true; }
      err = { code: m.code || 'unknown', message: m.message, advisory };
      paint();
      break;
    }
    case 'SPEED_STATE': {
      if (forOther) break;
      /**
       * THE ENGINE'S RECEIPT, on both paths — nothing on the 10 Hz heartbeat
       * carries the page rate, so an accepted SPEED with no echo would be a
       * message with no receipt.
       *
       * A REFUSAL DROPS THE PENDING CHANGE. The engine is the only place that
       * can tell a live deck from a cached one, and leaving the value outlined
       * would be the UI waiting for audio that is never going to carry it. The
       * READOUT is not corrected from here: `rate` on this message is what the
       * ENGINE recorded, and the ELEMENT is the truth.
       */
      if (m.accepted !== true) spPending = null;
      paintSpeed();
      break;
    }
    case 'ARM_ERROR': {
      if (forOther) break;
      halted = true;
      err = { code: m.code || 'ARM_FAILED', message: m.message, advisory: false, seq: m.seq };
      paint();
      break;
    }
    case 'ARM_ERROR_CLEARED':
      // Only the arm family: a LIVE_ERROR on this deck is a different failure
      // and this message says nothing about it.
      if (err && ARM_CODES.has(err.code)) { err = null; paint(); }
      break;
    case 'SESSION':
      if (m.session) session = { ...session, ...m.session };
      reconcile();
      paint();
      break;
    case 'STATE': {
      const was = modelStatus();
      engineInfo = m.state;
      maybePrepare();
      if ($('modeldlg').open) {
        paintModel();
        // The prompt closes when there is nothing left to prompt about, and
        // then the deck picks up where the user left it: they pressed Start,
        // this was in the way, and it no longer is.
        if (modelStatus() === 'ready' || modelStatus() === 'cached') {
          closeModelDialog();
          reconcile();
        }
      } else if (was === 'loading' && modelStatus() === 'error') {
        err = { code: 'MODEL_FAILED', message: (m.state.model && m.state.model.error) || 'The model download failed.', advisory: false };
      }
      paint();
      break;
    }
    default:
  }
  return false;
});

/**
 * THE PAGE'S PLAYER, via content.js. One bit — playing or not — and it is the
 * input the whole follow-the-video behaviour runs on.
 *
 * `ev.source !== parent` is the guard that matters: this document is embedded
 * in a page that runs YouTube's own JavaScript and any number of other frames,
 * all of which can postMessage at us. Only the frame that put us here is heard.
 */
window.addEventListener('message', (ev) => {
  if (ev.source !== parent) return;
  const d = ev.data;
  if (!d || d.from !== 'stem-splitter-live-host') return;
  if (d.type === 'VIDEO') onVideoState(d);
  // speed.js's verdict on the element, forwarded by content.js. It is the
  // ONLY thing that greys this control, and it is read as "anything that is not
  // ok" rather than as a list of states — see speedGate.
  else if (d.type === 'SPEED') onSpeedReport(d);
  else if (d.type === 'JUMP') onContentJump();
  // A shortcut pressed on the YouTube page, where the deck could never have
  // received it: content.js took it out of YouTube's hands and forwarded it.
  else if (d.type === 'KEY') onHostKey(d);
  else if (d.type === 'AUTONAV') onAutonav(d);
});

// ------------------------------------------------------------------ controls
$('mdl-go').addEventListener('click', () => {
  modelDeclined = false;
  // MODEL_LOAD builds the session too, so this one message is the whole
  // one-time cost: fetch, verify, compile. The dialog reports all three.
  prepared = true;
  toOff({ type: 'MODEL_LOAD' });
  paintModel();
});
$('mdl-no').addEventListener('click', () => {
  // Declining leaves the deck idle. Nothing was started, nothing is remembered
  // beyond this page instance — but it does not re-ask on every play/pause,
  // which would be a nag rather than a question.
  modelDeclined = true;
  closeModelDialog();
  paint();
});
// Esc closes a <dialog> natively; keep our own bookkeeping in step with it.
$('modeldlg').addEventListener('close', () => {
  delete document.body.dataset.modal;
  reportHeight();
});
// ---- transpose, the horn, the one setting, the shortcut list ----
$('tr-dn').addEventListener('click', () => setSemitones(semitones - 1));
$('tr-up').addEventListener('click', () => setSemitones(semitones + 1));
// The readout is also the way home. A ±6 control with no reset makes the user
// count clicks back to the pitch the record is actually in.
$('tr-v').addEventListener('click', () => setSemitones(0));

/**
 * SPEED. Two nudge buttons and a value that is also the way home, TRANSPOSE's
 * exact idiom three seats along the same row.
 *
 * `Shift` HALVES OR DOUBLES, read off the same `click` — it is not a global
 * binding and it never could be: `NOT_OURS`, `hostKeys()` and every one of their
 * assertions are unchanged, because a modifier on a focused button of ours is a
 * key YouTube never sees. There is no auto-repeat (a fader with a delay), no
 * wheel handler (the user scrolls this page and the wheel is not ours to take)
 * and no fader (a control that must not be swept).
 *
 * THE STEP IS TAKEN FROM WHAT IS ON SCREEN, not from `pageRate`: a second press
 * before the element has confirmed the first must step from where the user just
 * put it, or the control eats every other press.
 */
const shownRate = () => (spPending ? spPending.rate : pageRate);
$('sp-dn').addEventListener('click', (e) => setSpeed(stepSpeed(shownRate(), -1, e.shiftKey)));
$('sp-up').addEventListener('click', (e) => setSpeed(stepSpeed(shownRate(), 1, e.shiftKey)));
// The readout is also the way home, exactly as TRANSPOSE's is: 14 presses back
// to 1.00x is not a reset.
$('sp-v').addEventListener('click', () => setSpeed(SPEED_HOME));

$('inst').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!knownInstrument(v)) return;
  instrument = v;
  writePrefs({ instrument: v });
  paintKey();
});

$('autonav-cb').addEventListener('change', (e) => {
  // CHECKED MEANS SUPPRESS, and the stored key names YouTube's behaviour rather
  // than ours, so it is the inverse. autonav.js's `resolveSuppress` reads it.
  writePrefs({ autoplayNext: !e.target.checked });
});

$('keys-open').addEventListener('click', openKeys);
$('keys-x').addEventListener('click', closeKeys);
// Esc closes a <dialog> natively; this keeps the height report and the host's
// key list in step with a close we did not route through closeKeys().
$('keysdlg').addEventListener('close', () => { reportHeight(); postDeck(); });
$('nav-x').addEventListener('click', () => {
  navDismissed = navErr;
  navErr = null;
  paintNav();
});

$('err-rx').addEventListener('click', restartLive);
/**
 * Explicit dismissal. It names the `seq` this page was SHOWING, and the eject
 * button goes through the same function rather than sending a bare clear — a
 * clear with no `seq` means "drop whatever is there", which the service worker
 * reserves for the successful-arm path because that path is authoritative and a
 * user's finger is not. Dismissing a refusal you can see must never delete a
 * newer one that landed while you were reaching the durable arm refusal.
 */
function dismissArmError() {
  const seq = err && err.seq;
  err = null;
  toSw({ type: 'SW_ARM_ERROR_CLEAR', ...(Number.isFinite(seq) ? { seq } : {}) });
}

$('err-x').addEventListener('click', () => { dismissArmError(); paint(); });

/**
 * Eject = stop AND release the tab. Both halves, because in this build the
 * toolbar click refuses to displace a loaded deck — so this button is the only
 * way to point the deck at a different tab, and a remedy that half-works is
 * worse than none.
 */
$('eject').addEventListener('click', () => {
  halted = true;
  if (RUNNING.has(live.status)) stopLive();
  dismissArmError();
  toSw({ type: 'SW_DISARM', deck: DECK });
  session = { tabId: null };
  paint();
});

$('close').addEventListener('click', () => {
  // The frame goes away; the audio does not. Capture and separation live in the
  // offscreen document and never depended on this page existing.
  parent.postMessage({ from: 'stem-splitter-live', type: 'CLOSE' }, '*');
});

/**
 * MASTER. The same widget as the six stem faders, in the column where a mixer
 * puts it — one law and one set of gestures, rather than a horizontal slider
 * that matched nothing else on the surface.
 *
 * It stays at unity by default in this build: the −3 dB default is ratified for
 * the TWO-deck case, where hard-assigned stems bypass the crossfader and both
 * decks run at unity into the same bus. There is one deck here.
 */
makeFader($('master'), (db) => {
  masterDb = db;
  paintStrips();
  toOff({ type: 'MASTER_GAIN', deck: DECK, gainDb: wireDb(db) });
});

// -------------------------------------------------------------------- height
/**
 * The host page cannot know how tall this is, and a fixed height is a scrollbar
 * on one Chrome zoom level and a gap on another. Report it instead — content.js
 * clamps whatever arrives and only accepts it from this frame.
 */
/**
 * A `<dialog>` is out of flow, so `body.scrollHeight` does not grow for it and
 * a frame sized to the deck alone can clip the modal outright. It also has to
 * be measured rather than guessed: this floor used to be a flat 300 px, which
 * was the deck's height plus a modal's worth of room BACK WHEN THE DECK WAS
 * 210 px. The vertical mixer is 309 px, so the constant silently stopped doing
 * anything — the modal fitted, but with its edges hard against the frame's, and
 * a dialog with no scrim around it reads as a page rather than as a question
 * asked over one.
 *
 * So: the dialog's own box, measured, plus a scrim margin on each side, and
 * never less than the deck behind it.
 */
const MODAL_SCRIM = 72;
/**
 * WHICHEVER dialog is open, not `#modeldlg` by name. There are two now — the
 * download prompt and the shortcut overlay — and a floor that only knows about
 * one of them clips the other in exactly the way the note above describes.
 */
const modalFloor = () => {
  const d = document.querySelector('dialog[open]');
  if (!d) return 0;
  return Math.ceil(d.getBoundingClientRect().height) + MODAL_SCRIM * 2;
};
const reportHeight = () => parent.postMessage({
  from: 'stem-splitter-live',
  type: 'HEIGHT',
  height: Math.max(Math.ceil(document.body.scrollHeight), modalFloor()),
}, '*');
/**
 * `body`, not `documentElement`. documentElement.scrollHeight is floored by the
 * viewport — which is the iframe height we set from this very message — so it
 * reports "as tall as you already made me" and the deck can grow but never
 * shrink. Measured: it reported exactly the initial guess back, and the error
 * banner opening and closing would have left the gap behind permanently.
 */
new ResizeObserver(reportHeight).observe(document.body);
/**
 * THE FIRST REPORT CAN BE LOST, and on a deck nobody touches there is never a
 * second one — the ResizeObserver only fires when the body's box CHANGES.
 *
 * The frame is inserted by content.js at a fixed INITIAL_H guess and then
 * corrected by this message; if the very first one lands before the host is
 * listening, the deck sits at that guess for the rest of its life. That was
 * invisible while the deck was ~210 px tall and the guess was 212. The vertical
 * mixer is ~309 px, and `overflow: hidden` means the missing 97 px are not
 * scrolled to — they are the master fader, cut off.
 *
 * Caught by tools/embed-smoke.mjs, which measured the frame at 212 px on one
 * run and 309 px on the next with no change in between. A few idempotent
 * re-reports over the first second cost nothing and remove the race.
 */
for (const ms of [0, 80, 200, 500, 1000]) setTimeout(reportHeight, ms);

// ---------------------------------------------------------------------- boot
/**
 * The unity detent's position, from the ONE constant that defines it. The mark
 * is drawn by CSS off `--unity`; hard-coding DESIGN §6.2's 0.833 here would put
 * the detent 3 % above the value the mixer actually applies, which is a fader
 * that lies about where unity is.
 */
document.documentElement.style.setProperty('--unity', String(UNITY_U));
buildStrips();
paintTranspose();
paintKey();
paintSpeed();
paintBpm();
paint();
postDeck();

/**
 * The preference, read once and then followed. `onChanged` matters because
 * `content.js` is the other reader of this key and a second deck in a second
 * tab is the other writer — a checkbox that disagreed with the behaviour would
 * be worse than no checkbox.
 */
chrome.storage.local.get(PREFS_KEY).then((got) => applyPrefs(got && got[PREFS_KEY])).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[PREFS_KEY]) return;
  applyPrefs(changes[PREFS_KEY].newValue);
});

toSw({ type: 'SW_STATUS' });
toOff({ type: 'STATUS' });
// `maybePrepare()` fires from the first STATE, and ONLY if the weights are
// already on disk. Preparing a cold cache is a 172 MiB download, which is the
// user's decision — see the model section above.

// Tell the host page we are listening, so it can send the CURRENT play state.
// A deck opened on an already-playing video is the common case, and it would
// otherwise wait for the next play/pause event that may never come.
parent.postMessage({ from: 'stem-splitter-live', type: 'READY' }, '*');

// The offscreen document may not exist yet, and a message to it before it does
// is delivered nowhere. Retry until one answers with STATE.
let tries = 0;
const bootPoll = setInterval(() => {
  if (engineInfo || ++tries > 20) return clearInterval(bootPoll);
  toSw({ type: 'SW_ENSURE_OFFSCREEN' });
  toOff({ type: 'STATUS' });
}, 400);

/**
 * THE DURABLE ARM REFUSAL — the read side the durable arm refusal.
 *
 * This page is created BY the arm gesture, so on a refusal it is still loading
 * while the service worker sends ARM_ERROR to nobody. Reading the persisted
 * record is the only reason a refused arm says anything at all here.
 */
(async () => {
  let rec = null;
  try { rec = (await chrome.storage.session.get(ARM_ERROR_KEY))[ARM_ERROR_KEY] || null; } catch (e) { return; }
  if (!armErrorFresh(rec, Date.now(), ARM_ERROR_TTL_MS)) return;
  if (err) return;   // a live message already beat us here; it is fresher
  if (normalizeDeck(rec.deck) !== DECK) return;
  err = { code: rec.code || 'ARM_FAILED', message: rec.message, advisory: false, seq: rec.seq };
  paint();
})();

// Exposed for the automated harness only (tools/embed-smoke.mjs), same as the
// DJ console's `__console`. Nothing in the UI reads it.
globalThis.__embed = {
  get videoPlaying() { return videoPlaying; },
  get transpose() { return semitones; },
  get instrument() { return instrument; },
  /** What the key block is showing, already composed. See paintKey(). */
  get key() { return keyView; },
  /** The autoplay advisory currently up: 'missing' | 'lost' | 'stuck' | null. */
  get navErr() { return navErr; },
  get suppressNext() { return $('autonav-cb').checked; },
  get keysOpen() { return keysOpen(); },
  get halted() { return halted; },
  get jumps() { return jumps; },
  get log() { return (engineInfo && engineInfo.log) || []; },
  get status() { return live.status; },
  get modelStatus() { return modelStatus(); },
  get source() { return live.source; },
  get videoLocked() { return videoLocked; },
  /** The ELEMENT'S rate as this deck last heard it, and what is on the button. */
  get speed() { return pageRate; },
  get speedShown() { return shownRate(); },
  /** `{ok, why, text}` — why the control is greyed, if it is. */
  get speedGate() { return spGate(); },
  /** What the BPM box is showing, already resolved. See paintBpm(). */
  get bpm() { return bpmView; },
  /** Did boot decide this is an Apple keyboard — i.e. which lettering is up. */
  get mac() { return MAC; },
  /**
   * Re-letter the key caps. The ONE writable entry on this object, and it is
   * here because the alternative is a browser assertion that computes its own
   * expectation from `isMac()` — the function under test — and therefore
   * reports the same answer on every machine whether the DOM followed it or
   * not. The harness drives both values and restores `mac` when it is done.
   */
  relabel,
};
