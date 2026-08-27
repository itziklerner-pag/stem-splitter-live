/**
 * Display maths for the deck. No DOM, no chrome.*, importable by node.
 * Runnable check: `node extension/ui/dev/selftest.mjs`
 *
 * The FADER law is NOT here. There is exactly one normative implementation of
 * AUDIO.md §3.1 and it is `engine/mixer.js`, pinned by `node test.js mix`. This
 * module re-exports it so the UI has a single import site and so the selftest
 * can assert the UI and the engine hold the *same function object* — a copy
 * that drifted is the failure mode this arrangement exists to make impossible.
 *
 * What genuinely does live here is the METER law: dBFS -> the fraction of the
 * trough to fill. That is a drawing decision about a specific 10 px widget and
 * has no business in the engine.
 */

import { faderDb, dbToFader, dbToGain, gainToDb } from '../engine/mixer.js';

export { faderDb, dbToFader, dbToGain, gainToDb };

/**
 * Unity sits at u = 0.80, per AUDIO.md §3.1 — the law the mixer applies. The
 * detent mark is driven off this constant, because a detent that is not at
 * unity is a lie.
 */
export const UNITY_U = 0.80;

/**
 * The lowest dB the widget will display. Anything the law returns at or below
 * this becomes -Infinity, so it must sit inside the law's range; the selftest
 * pins that by round-tripping from here to MAX_DB.
 */
export const FLOOR_DB = -55;

/** aria-valuemin / aria-valuemax. Must match the ends of the imported law. */
export const MIN_DB = -60;
export const MAX_DB = 6;

// ---------------------------------------------------------------- meter law
//
// DESIGN.md §7.2 — floor -60 dBFS, ceiling 0, non-linear so -18..0 gets most
// of the pixels. Same knee-table + lerp shape as the fader.
const METER_KNEES = [
  [-60, 0.00],
  [-40, 0.22],
  [-24, 0.46],
  [-18, 0.58],
  [-12, 0.70],
  [-6, 0.84],
  [-3, 0.94],
  [0, 1.00],
];

/**
 * Sanitise one linear-amplitude reading off the wire. Negative (a signed
 * sample slipped through), non-finite, null and undefined all mean "no signal".
 */
export function linAmp(x) {
  if (x === null || x === undefined) return 0;
  const a = Math.abs(Number(x));
  return isFinite(a) ? a : 0;
}

/**
 * Linear amplitude -> dBFS. The engine's METERS message carries linear
 * amplitude post-fader, so this is the first thing every meter value meets.
 * Silence (0, null, undefined, NaN) is -Infinity, never 0 dBFS — a serializer
 * that turned -Infinity into null would otherwise peg every meter.
 */
export function linToDb(x) {
  const a = linAmp(x);
  return a > 0 ? 20 * Math.log10(a) : -Infinity;
}


/** dBFS -> 0..1 fraction of trough height. */
export function dbToMeterFrac(db) {
  if (!isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 1;
  for (let i = 1; i < METER_KNEES.length; i++) {
    const [d1, f1] = METER_KNEES[i];
    if (db <= d1) {
      const [d0, f0] = METER_KNEES[i - 1];
      return f0 + ((db - d0) / (d1 - d0)) * (f1 - f0);
    }
  }
  return 1;
}

// ------------------------------------------------------------- ballistics
//
// DESIGN.md §7.1. One-pole in *linear amplitude* (dB-domain smoothing would
// misreport the release rate), converted to dB only at render time.
export const BALLISTICS = {
  rmsAttackMs: 10,
  rmsReleaseMs: 300,
  peakHoldMs: 1200,
  peakFallDbPerS: 20,
  clipDb: -0.1,
  clipLatchMs: 2000,
};

/** One-pole coefficient for a time constant tau over dt (both ms). */
export function onePole(dtMs, tauMs) {
  if (tauMs <= 0) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

// ------------------------------------------------------- buffer health law
//
// DESIGN.md §8.2 put the thresholds in the UI. They have moved engine-side,
// next to the constants that actually govern the ladder, and `status` is the
// answer. The UI must not re-derive the alarm:
//
//   The engine used to compute `starving` from the instantaneous ring depth,
//   which sawtooths once per hop, so the alarm flipped ~52 times in a 50 s
//   soak. Now `status` changes twice in the same soak — once in and once out of
//   a genuine 1980 ms inference spike. Re-deriving starve from any depth number
//   here would put the strobe straight back.
//
// The one band the UI still owns is `tight`, and it is an advisory, not an
// alarm: no banner, no role="alert". It reads `bufferMinSec` — the lowest ring
// depth over the last three hops, sampled in the worklet every render quantum —
// against `floorSec`, the trough the ladder is designed to leave. "Your trough
// has eaten into the floor" needs no invented constant, and bufferMinSec swings
// 0.13x as much as bufferSec, so it cannot strobe either.


/**
 * @param {{status:string, bufferMinSec:number, floorSec:number}} s
 * @returns {'prime'|'stable'|'tight'|'starve'|'idle'}
 */
export function bufState(s) {
  if (s.status === 'idle' || s.status === 'error') return 'idle';
  if (s.status === 'priming') return 'prime';
  if (s.status === 'starving') return 'starve';        // the engine owns the alarm
  const floor = Number(s.floorSec);
  const min = Number(s.bufferMinSec);
  if (isFinite(floor) && floor > 0 && isFinite(min) && min < floor) return 'tight';
  return 'stable';
}


// ----------------------------------------------------------------- format
//
// DESIGN.md §3: U+2212 MINUS SIGN in rendered dB, never hyphen-minus.
export const MINUS = '−';
export const INF = '∞';

/** "+1.5" / "0.0" / "−4.5" / "−∞" */
export function fmtDb(db, { sign = true } = {}) {
  if (db === -Infinity) return MINUS + INF;
  const v = Math.abs(db) < 0.05 ? 0 : db;
  const s = Math.abs(v).toFixed(1);
  if (v > 0) return (sign ? '+' : '') + s;
  if (v < 0) return MINUS + s;
  return '0.0';
}

/** Spoken form for aria-valuetext. */
export function speakDb(db) {
  if (db === -Infinity) return 'minus infinity, off';
  const v = Math.abs(db) < 0.05 ? 0 : db;
  if (v === 0) return '0.0 decibels, unity';
  if (v > 0) return `plus ${v.toFixed(1)} decibels`;
  return `minus ${Math.abs(v).toFixed(1)} decibels`;
}

/**
 * The "behind video" readout — the one number a DJ uses to place themselves
 * against the picture, so it gets one implementation and a test.
 *
 * Two rules it exists to enforce:
 *  1. It is driven by LIVE_STATE.latencySec (capture-to-speaker, measured off
 *     the two frame counters), never by bufferSec. Ring depth oscillates by ~2 s
 *     every hop while the true offset sits flat, so bufferSec would make this
 *     readout breathe on a value that is not moving.
 *  2. latencySec is 0 until playback arms. "0.0 s" is a confident claim that
 *     the DJ is in sync; during priming nothing is playing and there is no
 *     offset to report, so say so instead.
 */
export function behindText(status, latencySec) {
  const playing = status === 'running' || status === 'starving';
  const l = Number(latencySec);
  if (!playing || !isFinite(l) || l <= 0) return status === 'priming' ? 'priming' : '—';
  return MINUS + fmt1(l) + ' s';
}


/** "3.9" — one decimal, tabular. The one caller is `behindText` above. */
function fmt1(n) {
  return (isFinite(n) ? n : 0).toFixed(1);
}

/** "104.2 MB". MiB, labelled MB. */
export function fmtBytes(n) {
  const v = Number(n);
  return `${(isFinite(v) && v > 0 ? v / 1048576 : 0).toFixed(1)} MB`;
}


// -------------------------------------------------------------------- ETA
//
// Two progress bars now need a "how long is left" number: the model download
// (bytes) and the ring prime (primedPct). Both are "fraction 0..1 that only
// goes up, restart the estimate if it goes down", so there is one
// implementation and the selftest drives it with a synthetic clock.
//
// The anchor is the FIRST sample, not a sliding window, on purpose: a download
// ETA taken off the last 500 ms jitters by tens of seconds and is unreadable.
// The cost is that the estimate is slow to react to a genuine slowdown; the
// benefit is a number that does not flicker, which is what a first-run user
// staring at a two-minute bar actually needs.


// ------------------------------------------------------------------- hop
//
// QA-17. `SET_HOP` is deferred to the next Start because the whole emit
// schedule derives from H, so the hop the user last clicked and the hop the
// engine is running are two different facts. LIVE_STATE now carries both
// (`hopSec` active, `pendingHopSec` selected) and the console must not
// conflate them: painting the click as the present tense is a lie about the
// latency, the RTF and the deadline every other readout is measured against.


// ----------------------------------------------------------------- model
//
// LIVE_STATE.phase says WHICH wait `priming` is; the separate STATE message
// (offscreen `state.model`) carries the bytes. Two messages, one screen — but
// only one source for each fact, and neither is inferred from the other.


// ------------------------------------------------- three small state rules
//
// Each of these was a place the console re-derived a fact from the wrong field.
// They are one-liners on purpose; they live here so the selftest can drive them
// without a DOM, because "one-liner" is exactly how the last three contract
// bugs got past review.


// ============================================== DECK_PREPARE (ratified 08-09)
//
// `DECK_PREPARE {deck}` -> `DECK_PREPARED {deck, ok, ms, ep}` builds a deck's
// ORT session while nothing is playing. Creating deck B's session lazily, on
// its first LIVE_START, compiles shaders on the shared GPU for ~8 s and deck A
// produces ZERO chunks for the whole period — measured 7 of 8 arm cycles.
// Eagerly, deck A produced chunks through every one and zero-drop cycles went
// 1/8 -> 7/8.
//
// THE RULE: send it BEFORE deck A goes live. Arriving late is the same 8 s
// stall; the only thing that changed is that the user chose when to take it.
// So the console sends it when the DUAL console opens, which is the one moment
// it knows the user is heading for two decks, and renders the wait honestly.
//
// Two things measured elsewhere that this copy must not contradict:
//   - warm, it is ~2.3 s and first playback is essentially unaffected;
//   - COLD, `ensureSession()` awaits `modelBytes()` first, so the very first
//     prepare on a machine is a 172 MB download. That is not 2.3 s and the UI
//     must not say it is — hence `modelPhase`.


// ====================================================== two decks, one alarm
//
// DESIGN §8.3 announces a starve once, per deck. With two decks that becomes
// two `role="alert"` regions racing each other, and a screen reader reads them
// back to back while the console shows two red banners stacked with the same
// two buttons. The console renders ONE aggregated alarm; these are the rules it
// aggregates by, kept here so they can be driven without a DOM.


/**
 * WHICH REMEDY an error code actually has. Added on first contact with the real
 * engine, 2026-08-09, and it is the sixth instance of contract bug #4:
 * `LIVE_ERROR` still has no severity field, and "is it fatal" turns out not to
 * be the only question. There are three answers, not two:
 *
 *   'none'     an advisory. The deck is playing. Offer nothing.
 *   'restart'  the pipeline broke. Stop-and-start genuinely fixes it.
 *   'arm'      THE DECK HAS NO STREAM. Restarting sends LIVE_START at a deck
 *              that is not capturing, which produces the same error again — a
 *              button labelled "Restart" that is guaranteed to fail. The only
 *              remedy is a browser-level invocation on the tab, which this page
 *              cannot perform (CONTRIBUTING.md "no tab picker, ever"), so the honest
 *              control is no control and a sentence.
 *
 * The 'arm' set is every code the service worker's ARM_ERROR can carry plus the
 * offscreen document's NOT_CAPTURING. Both arrive at the console as an error on
 * a named deck and both mean the same thing to the user.
 *
 * @param {string} code
 * @param {boolean} advisory as classified by the caller's own ADVISORY_CODES
 * @returns {'none'|'restart'|'arm'}
 */
export const ARM_CODES = new Set([
  'NOT_CAPTURING', 'NOT_ARMED', 'NEEDS_GESTURE', 'TAB_GONE', 'TAB_BUSY',
  'TAB_UNSUPPORTED', 'ARM_FAILED',
  // The refusal arming can produce. In ARM_CODES for the reason the whole set
  // exists — Restart must be withheld, because restarting the deck does nothing
  // about which tab is armed (a control that cannot fix the thing the banner
  // describes is a one-click footgun).
  'NO_ACTIVE_TAB',
]);

/**
 * IS THIS A CODE THE DECK KNOWS WHAT TO DO WITH? (#29)
 *
 * `ARM_ERROR { code, message }` is a message a HOST ORIGINATES — `docs/VENDORING.md`
 * says so — and `code` is drawn from a CLOSED VOCABULARY the unit owns: the set
 * above. Nothing said so anywhere until v0.3.0, and nothing checked it. Three
 * separate deck behaviours are gated on membership:
 *
 *   1. whether the banner can be DISMISSED  (`ui/embed.js` paintBanner: the
 *      dismiss control is shown only for this family, because these are
 *      statements about a gesture already made);
 *   2. whether RESTART is offered            (`errorAction()` below sends a
 *      non-member to the `'restart'` family, and restarting a deck that has no
 *      stream produces the same error again);
 *   3. WHICH SENTENCE is printed             (`errorSummary()`).
 *
 * FIVE OF THE EIGHT MEMBERS ARE TAB NOUNS, and a second Host has no tabs. So the
 * natural mistake is to invent a plausible-looking code — `NO_SOURCE`, say — and
 * the result is a banner the user CANNOT DISMISS with a Restart button that
 * cannot work, and nothing goes red: `assertHost` checks duties and cannot check
 * a message nobody sent, the unit gate reads code and not traffic, and
 * `group('host')` drives duties. The failure is silent, user-facing, and on the
 * first screen a tester sees when arming fails.
 *
 * SO IT IS SAID OUT LOUD, ONCE, AT THE MOMENT IT IS WRONG. This function is the
 * only thing in this file with a side effect, and that is deliberate: a pure
 * predicate whose caller has to remember to log is a check a second Host loses
 * the same way it lost the vocabulary. The loudness lives with the rule.
 *
 * IT DOES NOT THROW AND IT DOES NOT CHANGE THE BANNER. The deck is already
 * reporting a failure to arm; replacing it with a second failure would take the
 * user's actual problem off the screen. The Host developer is told; the user
 * sees what they saw before.
 *
 * @param {string} code  the code as the banner will use it, i.e. after any default
 * @param {string} [where] the entry point that received it, quoted in the error
 * @returns {null|string} null when legal, otherwise the sentence that was logged
 */
export function checkArmCode(code, where = 'ARM_ERROR') {
  if (ARM_CODES.has(code)) return null;
  const msg = `${where}: code ${JSON.stringify(code)} is not one of the ${ARM_CODES.size} this deck knows what to do with `
    + `— ${[...ARM_CODES].join(', ')}. An unknown code paints a banner the user CANNOT DISMISS, with a Restart `
    + 'control that cannot fix it. Pick a member of that set, or add one upstream.';
  console.error(msg);
  return msg;
}

/**
 * ...but they must not borrow the arm family's TITLE.
 *
 * "The deck has no source" is the right sentence for TAB_GONE and a flat
 * contradiction for NO_ACTIVE_TAB, which is a refusal to CHANGE a source rather
 * than a report of a missing one.
 *
 * `DECKS_FULL` and `DECK_BUSY` were the other two members and both are gone with
 * deck B: nothing in `sw/service-worker.js` can raise them, so a set that still
 * listed them would be describing a state this build cannot reach.
 */
const ARM_REFUSAL_CODES = new Set(['NO_ACTIVE_TAB']);


/**
 * Is a PERSISTED arm refusal still worth painting? (the durable refusal, `sw/service-worker.js`.)
 *
 * Pure, so the staleness rule is testable without a browser — which matters,
 * because this is the field that decides whether a fix for a silent failure
 * becomes a new false-alarm source.
 *
 * `at` is EPOCH ms and is the moment the SERVICE WORKER raised the refusal.
 * `now` is the caller's `Date.now()`. Both must be wall clock: the record is
 * written in one context and read in another, and `performance.now()` has a
 * different origin in each.
 *
 * A malformed or absent record is NOT fresh. It is also not an excuse: the
 * caller renders nothing, which is the same thing it would do with no refusal,
 * so this cannot report coverage it does not have.
 *
 * @param {null|{at:number}} rec
 * @param {number} now epoch ms
 * @param {number} ttlMs
 */
export function armErrorFresh(rec, now, ttlMs) {
  if (!rec || !Number.isFinite(rec.at) || !Number.isFinite(now)) return false;
  const age = now - rec.at;
  // A record from the FUTURE is a clock that moved, not a fresh refusal.
  return age >= 0 && age <= ttlMs;
}
export function errorAction(code, advisory) {
  if (advisory) return 'none';
  return ARM_CODES.has(code) ? 'arm' : 'restart';
}

/**
 * Same idea for LIVE_ERROR. A fatal on either deck outranks an advisory on the
 * other — an advisory must never paint over a real failure, and with two decks
 * that failure can be on the deck you are not looking at.
 *
 * `fatal` is computed by the caller from its own ADVISORY_CODES set, which
 * `tools/run-ext.mjs` pins against the engine's. Do not classify here.
 *
 * @param {{id:string, code:string, message:string, fatal:boolean}[]} records
 * @returns {null|{sev:'fatal'|'advisory', ids:string[], title:string,
 *                 message:string, codes:string[]}}
 */
export function errorSummary(records) {
  const all = (records || []).filter(Boolean);
  if (!all.length) return null;
  const fatal = all.filter((r) => r.fatal);
  const use = fatal.length ? fatal : all;
  const sev = fatal.length ? 'fatal' : 'advisory';
  const ids = use.map((r) => r.id);
  const codes = use.map((r) => r.code || 'unknown');
  /**
   * NO DECK IS NAMED, because there is only one and the user never chose it.
   *
   * This read `Deck ${ids[0]}` — "Deck A stopped — HALTED" — which is a label
   * from the two-deck console. That surface is gone: `tools/tree-check.mjs`
   * asserts one deck and one arming chord, and the deck id survives only as an
   * internal routing key the user has no way to see. Naming it in an error
   * headline asks the reader to hold a concept the product does not have, at
   * the exact moment they are trying to understand a failure.
   *
   * `ids` is still joined when there is more than one record so the branch
   * cannot silently drop information, but a single-deck build never reaches it.
   */
  const who = ids.length > 1 ? `Decks ${ids.join(' and ')}` : 'Separation';
  // "stopped" is wrong for the arm family: the deck never started. Observed on
  // the real service worker — pressing Start on a stale grant produced
  // "Deck A stopped — TAB_GONE" for a deck that had not played a sample.
  const armOnly = sev === 'fatal' && use.every((r) => r.action === 'arm');
  const refusal = sev === 'fatal' && use.every((r) => ARM_REFUSAL_CODES.has(r.code));
  const title = refusal
    ? `Cannot arm that tab — ${codes.join(' · ')}`
    : armOnly
      ? `${who} has no source — ${codes.join(' · ')}`
      : sev === 'fatal'
        ? `${who} stopped — ${codes.join(' · ')}`
        : `${who} — ${codes.join(' · ')}`;
  const message = ids.length > 1
    ? use.map((r) => `${r.id}: ${r.message || 'No detail was reported.'}`).join('  ')
    : (use[0].message || 'No detail was reported.');
  // Restart is offered only when EVERY deck in the banner can be restarted. One
  // deck needing a toolbar click makes "Restart both decks" a control that is
  // half guaranteed to fail, and a half-working button is worse than a sentence.
  const action = sev === 'advisory' ? 'none'
    : use.every((r) => (r.action || 'restart') === 'restart') ? 'restart' : 'arm';
  return { sev, ids, title, message, codes, action };
}


// ======================================================== the master bus
//
// `MASTER_METERS { peak:{l,r,master}, rms:{...}, clip }` is a SEPARATE message
// from the per-deck `METERS`, and the difference is not cosmetic. From
// offscreen/master-meter-processor.js, verbatim: "peak(A + B) is not
// peak(A) + peak(B) and it is not max(peak(A), peak(B)) either — two decks at
// -6 dBFS can sum to 0 dBFS or to silence."
//
// The console used to compute its one master readout and its soft-clip chip as
// `max` over the two per-deck meters, which is exactly the quantity that
// comment says is wrong: two decks at -3 dB sum to 0 dB, neither deck latches a
// clip, and the chip reports "Soft clip" off while the clipper is working.
//
// UNITS AND REFERENCE POINT, so this cannot drift again: linear amplitude, at
// the meter node — after both decks are summed, BEFORE the soft clipper. `clip`
// is armed at 0.99 on that same pre-clipper signal, so it means "you are into
// the safety net", not "the DAC clipped".
//
// It is only sent while at least one deck is running. Silence on the wire is
// therefore ambiguous between "no signal" and "nothing playing", which is why
// the caller passes staleness in rather than this deciding.


// ------------------------------------------------------ audio/video sync
/**
 * Audio-clock-driven video sync, per docs/AUDIO.md §8.2 and the ruling on it.
 *
 * ONLY VALID FOR A CACHED DECK, and the reason is structural rather than a
 * tuning detail. In LIVE mode the video we would manipulate is the SOURCE of the
 * audio we capture, so every correction moves both sides of the error it is
 * correcting — seeking back by Δ re-captures the same Δ, `playbackRate` scales
 * both sides, and pausing to catch up deadlocks because a paused tab produces no
 * audio (`embed/ui/embed-state.js` states the same thing at more length). A
 * cached deck is not capturing anything, so the loop is cut and the video
 * becomes a display device that can be shoved around freely.
 *
 * The audio clock is the master because it is the one that cannot be nudged: a
 * sample is a sample, whereas `<video>` will happily run 2 % fast for a while.
 *
 * Thresholds, and why each is where it is:
 *   < 60 ms   do nothing. Below the threshold where a viewer can detect
 *             audio/video misalignment on musical material, and constantly
 *             re-rating the video to chase it looks worse than the error.
 *   >= 60 ms  soft-correct with playbackRate 1 ± 0.02. 2 % is inaudible on
 *             video and closes a 100 ms error in 5 s. Do NOT exceed it: beyond
 *             a few percent the pitch shift becomes visible as judder.
 *   >= 500 ms hard seek. At half a second the soft correction would take 25 s,
 *             by which point the user has noticed. Seek and take the stall.
 *
 * **The 2 % rate correction assumes the video is MUTED.** On an audible video a
 * 2 % rate change is a 34-cent pitch shift, which is a quarter-tone against
 * material the user is beat-matching to. Whoever drives this must mute first;
 * `content.js` does, and says so.
 *
 * It lives in this file rather than next to `CachedDeck` because the deck does
 * not call it — the surface adjacent to the `<video>` element does, and in this
 * product that surface is a UI. Pure, so it tests without a browser.
 *
 * @param {number} audioSec  the cached deck's transport position
 * @param {number} videoSec  the <video> element's currentTime
 * @returns {{action:'none'|'rate'|'seek', playbackRate:number, seekTo:number|null, errorSec:number}}
 */
/**
 * WHERE THE AUDIO PLAYHEAD IS NOW, from a sample that is already old.
 *
 * `LIVE_STATE.positionSec` was true at `atMs`, and it reaches a surface 50-100 ms
 * later: it is published at 10 Hz and crosses a `chrome.runtime` hop. Feeding it
 * to `syncCorrection` raw is not a small inaccuracy — the lag is the same size as
 * the 60 ms threshold, so the correction would trip on its own transport delay,
 * hold the video a threshold's worth ahead, and never settle. Compensating turns
 * a systematic bias into a sample age that is subtracted.
 *
 * Clamped at zero: a negative age means the two clocks disagree about `now`
 * (`Date.now()` can step backwards), and rewinding the playhead for it would be
 * inventing an error rather than measuring one.
 */
export function audioClockAt(positionSec, atMs, now) {
  const p = Number(positionSec);
  if (!isFinite(p)) return 0;
  const age = Number(now) - Number(atMs);
  return p + (isFinite(age) && age > 0 ? age / 1000 : 0);
}

export function syncCorrection(audioSec, videoSec, { soft = 0.060, hard = 0.500, rate = 0.02 } = {}) {
  const error = videoSec - audioSec;          // positive: video is AHEAD
  const abs = Math.abs(error);
  if (abs >= hard) return { action: 'seek', playbackRate: 1, seekTo: audioSec, errorSec: error };
  if (abs >= soft) {
    // video ahead -> slow it down; video behind -> speed it up
    return { action: 'rate', playbackRate: error > 0 ? 1 - rate : 1 + rate, seekTo: null, errorSec: error };
  }
  return { action: 'none', playbackRate: 1, seekTo: null, errorSec: error };
}

// ------------------------------------------------------- two-deck plumbing

/** 'A' | 'B'. Anything else — including a message from the single-deck engine
 *  that carries no `deck` at all — is deck A. */
export function normalizeDeck(deck) {
  return deck === 'B' ? 'B' : 'A';
}

