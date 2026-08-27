/**
 * Runnable check for the deck's display laws. No browser, no DOM.
 *   node extension/ui/dev/selftest.mjs
 *
 * Every assertion here is about a function `ui/embed.js` actually calls. That is
 * the rule this file was re-grounded on when the two-deck console was cut: the
 * suite it replaced tested a crossfader, an assign matrix and two decks' worth
 * of error arbitration, none of which this build can reach. An assertion about
 * an unreachable state costs the same investigation time as a real defect and
 * teaches everyone to distrust reds.
 */

import { readFileSync } from 'node:fs';
import {
  UNITY_U, FLOOR_DB, MIN_DB, MAX_DB,
  faderDb, dbToFader, dbToGain, dbToMeterFrac, linToDb, linAmp,
  bufState, behindText, fmtDb, speakDb, onePole, fmtBytes,
  errorSummary, errorAction, ARM_CODES, checkArmCode, armErrorFresh, normalizeDeck,
} from '../audio-math.js';
import * as mixer from '../../engine/mixer.js';
import { MODEL } from '../../shared/config.js';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg);
};
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}  (${a} vs ${b})`);

// ------------------- fader law: ONE implementation, engine/mixer.js §3.1
// The UI must not own a copy of the curve. Identity of the function object is
// the only assertion that a copy cannot silently pass.
ok(faderDb === mixer.faderDb, 'the UI uses the engine\'s faderDb, not a copy');
ok(dbToFader === mixer.dbToFader, 'the UI uses the engine\'s dbToFader, not a copy');
ok(dbToGain === mixer.dbToGain, 'the UI uses the engine\'s dbToGain, not a copy');

near(faderDb(UNITY_U), 0, 1e-12, 'unity at u=0.80 is exactly 0 dB');
near(faderDb(1), MAX_DB, 1e-12, 'top of travel is +6 dB');
near(faderDb(0.50), -15, 1e-12, 'u=0.50 is -15 dB');
near(faderDb(0.25), -30, 1e-12, 'u=0.25 is -30 dB');
ok(faderDb(0) === -Infinity, 'u=0 is true zero, not -60');
ok(faderDb(0.5) > faderDb(0.49), 'law is monotonic');
near(dbToFader(MIN_DB), 0, 1e-12, 'aria-valuemin matches the bottom of the law');
near(faderDb(1), MAX_DB, 1e-12, 'aria-valuemax matches the top of the law');

// The display floor must sit inside the law, or a fader could sit below it
// showing a number the law calls silence.
ok(FLOOR_DB > MIN_DB && FLOOR_DB < MAX_DB, `the display floor ${FLOOR_DB} sits inside the law's ${MIN_DB}..${MAX_DB}`);

// Exact reversibility both ways, over the span the widget can actually reach.
let worstU = 0;
for (let u = dbToFader(FLOOR_DB); u <= 1; u += 0.0005) {
  worstU = Math.max(worstU, Math.abs(dbToFader(faderDb(u)) - u));
}
ok(worstU < 1e-12, `u -> dB -> u round-trips (worst ${worstU.toExponential(2)})`);

let worstDb = 0;
for (let db = FLOOR_DB; db <= MAX_DB; db += 0.01) {
  worstDb = Math.max(worstDb, Math.abs(faderDb(dbToFader(db)) - db));
}
ok(worstDb < 1e-10, `dB -> u -> dB round-trips (worst ${worstDb.toExponential(2)})`);

near(dbToGain(0), 1, 1e-12, 'unity gain is exactly 1.0');
ok(dbToGain(-Infinity) === 0, '-inf dB is true zero gain, not 1e-3');
near(dbToGain(6), 1.9952623, 1e-6, '+6 dB is ~2x amplitude');

// The fader must spend most of its travel where a DJ works (-15..+6 dB).
const workingSpan = 1 - dbToFader(-15);
ok(workingSpan >= 0.45, `-15..+6 dB gets ${(workingSpan * 100).toFixed(0)}% of the travel`);

// ------------------------------------------------------------- meter scale
near(dbToMeterFrac(0), 1, 1e-12, 'meter 0 dBFS fills the trough');
near(dbToMeterFrac(-60), 0, 1e-12, 'meter -60 dBFS is empty');
near(dbToMeterFrac(-12), 0.70, 1e-12, 'meter -12 dBFS at 70%');
near(dbToMeterFrac(-6), 0.84, 1e-12, 'meter -6 dBFS at 84%');
ok(dbToMeterFrac(-Infinity) === 0, 'silence reads empty');
ok(dbToMeterFrac(-9) > dbToMeterFrac(-10), 'meter scale is monotonic');
// The colour bands are anchored to the trough, so the -12/-3 boundaries must
// land inside the green/amber/red zones baked into the gradient (62% / 86%).
ok(dbToMeterFrac(-12) > 0.62, '-12 dBFS sits above the green band edge');
ok(dbToMeterFrac(-3) > 0.86, '-3 dBFS sits above the amber band edge');

// ------- METERS arrive as LINEAR AMPLITUDE, post-fader (not dBFS)
near(linToDb(1), 0, 1e-12, 'linear 1.0 is 0 dBFS');
near(linToDb(0.5), -6.0206, 1e-4, 'linear 0.5 is -6.02 dBFS');
near(linToDb(0.001), -60, 1e-9, 'linear 0.001 is -60 dBFS');
ok(linToDb(0) === -Infinity, 'linear 0 is silence, not 0 dBFS');
ok(linToDb(null) === -Infinity, 'a null reading is silence, not full scale');
ok(linToDb(undefined) === -Infinity, 'a missing reading is silence');
ok(linToDb(NaN) === -Infinity, 'NaN is silence');
ok(linToDb(-0.5) === linToDb(0.5), 'a signed sample reads as its magnitude');
ok(linAmp(-0.5) === 0.5 && linAmp(NaN) === 0 && linAmp(null) === 0,
  'linAmp sanitises the wire before anything reads it');
// The bug this catches: reading linear as dBFS would put a quiet -0.3 stem at
// the top of the meter.
ok(dbToMeterFrac(linToDb(0.3)) < 0.75, 'linear 0.3 (-10.5 dBFS) is well below the top of the trough');
// -0.1 dBFS is the clip threshold; in linear that is 0.98855.
ok(linToDb(0.98855) >= -0.1 - 1e-3 && linToDb(0.9) < -0.1, 'the clip threshold lands where the ballistics put it');

// --------- buffer health: `status` is the alarm, the UI owns only `tight`
//
// The engine used to derive `starving` from the instantaneous ring depth, which
// sawtooths once per hop — 52 alarm flips in a 50 s soak. These assertions pin
// the UI to `status` so the strobe cannot come back from this side.
const B = (o) => bufState({ status: 'running', floorSec: 0.4, bufferMinSec: 0.492, ...o });
ok(B({}) === 'stable', 'a trough above the floor is stable');
ok(B({ bufferMinSec: 0.28 }) === 'tight', 'a trough below the floor is the tight advisory');
ok(B({ bufferMinSec: 0.4 }) === 'stable', 'a trough exactly at the floor is still stable');
ok(bufState({ status: 'starving', floorSec: 0.4, bufferMinSec: 2.0 }) === 'starve',
  'the engine owns the alarm — status wins over a healthy-looking trough');
ok(bufState({ status: 'priming', floorSec: 0.4, bufferMinSec: 0 }) === 'prime', 'priming wins over depth');
ok(bufState({ status: 'idle', floorSec: 0.4, bufferMinSec: 0 }) === 'idle', 'idle is idle');
ok(bufState({ status: 'error', floorSec: 0.4, bufferMinSec: 0 }) === 'idle', 'a dead engine is not "starving"');
// The regression: bufferSec swings a full hop. Nothing in the state law may see it.
for (const depth of [0.4, 1.0, 1.7, 2.35]) {
  ok(bufState({ status: 'running', floorSec: 0.4, bufferMinSec: 0.492, bufferSec: depth }) === 'stable',
    `instantaneous depth ${depth}s does not move the state`);
}
// Missing floorSec must not invent a tight band out of nothing.
ok(bufState({ status: 'running', bufferMinSec: 0.1 }) === 'stable', 'no floor reported, no advisory');

// --------------- "behind video": latencySec only, never bufferSec
ok(behindText('running', 3.415) === '−3.4 s', 'a live deck reports its measured offset');
ok(behindText('starving', 2.0) === '−2.0 s', 'a starving deck still reports an offset');
// latencySec is 0 until playback arms; 0.0 s would claim the DJ is in sync.
ok(behindText('priming', 0) === 'priming', 'priming says priming, not "0.0 s"');
ok(behindText('running', 0) === '—', 'armed-but-not-yet-playing reports nothing, not zero');
ok(behindText('idle', 0) === '—', 'idle reports nothing');
ok(behindText('error', 3.4) === '—', 'a dead engine does not claim an offset');
ok(behindText('running', undefined) === '—', 'a missing latency reports nothing');
ok(behindText('running', NaN) === '—', 'NaN reports nothing');
ok(!behindText('running', 3.415).includes('-'), 'the offset uses U+2212, not hyphen-minus');
// The regression this whole helper exists to prevent: ring depth swings ~2 s
// every hop while the true offset is flat, so the two must never be confused.
ok(behindText('running', 3.415) === behindText('running', 3.42),
  'the readout is stable across the jitter a real latency figure carries');

// ------------------------------------------------------------ formatting
ok(fmtDb(0) === '0.0', 'zero prints without a sign');
ok(fmtDb(1.5) === '+1.5', 'boost prints a plus');
ok(fmtDb(-4.5) === '−4.5', 'cut uses U+2212 MINUS SIGN, not hyphen-minus');
ok(fmtDb(-Infinity) === '−∞', 'off prints minus infinity');
ok(!fmtDb(-4.5).includes('-'), 'no ASCII hyphen ever reaches a dB readout');
ok(speakDb(0) === '0.0 decibels, unity', 'unity is spoken as unity');
ok(speakDb(-Infinity) === 'minus infinity, off', 'off is spoken');

// ------------------------------------------------------------ ballistics
near(onePole(300, 300), 1 - Math.exp(-1), 1e-12, 'one-pole reaches 63.2% in one tau');
ok(onePole(10, 10) > onePole(10, 300), 'attack is faster than release');

// ============================== model download =============================
/**
 * TWO ASSERTIONS, NOT ONE, and the split is the point.
 *
 * The first pins the FORMATTER against a constant this file owns: `fmtBytes`
 * divides by 1048576 and prints "MB", so a change of unit is a red here and
 * nowhere else.
 *
 * The second pins THE SHIPPED MODEL'S SIZE as a string a human read off the
 * pinned byte count — 114,559,139 / 1048576 = 109.25 -> "109.3 MB". It is
 * deliberately NOT re-derived from `MODEL.bytes` at runtime: an expected value
 * computed the same way as the actual is an assertion that inspects nothing.
 */
ok(fmtBytes(1048576) === '1.0 MB',
  'fmtBytes counts in MiB behind an "MB" label — 1048576 bytes is 1.0, and changing the unit is a red here');
ok(fmtBytes(MODEL.bytes) === '109.3 MB',
  `the pinned model prints as 109.3 MB in the deck's download prompt (got ${fmtBytes(MODEL.bytes)} from MODEL.bytes ${MODEL.bytes})`);
ok(fmtBytes(0) === '0.0 MB', 'zero bytes prints zero, not NaN');
ok(fmtBytes(null) === '0.0 MB' && fmtBytes(undefined) === '0.0 MB', 'a missing byte count is 0');

// ================== LIVE_ERROR: three answers, not two =====================
//
// errorAction() has one call site (paintErrors) and feeds errorSummary. The
// assertions are grouped by the code family each is about.
ok(errorAction('HOP_PENDING', true) === 'none', 'an advisory offers nothing — the deck is playing');
ok(errorAction('HALTED', false) === 'restart', 'a broken pipeline offers Restart, which fixes it');
ok(errorAction('OUTPUT_SILENT', false) === 'restart', 'a silent output offers Restart');
for (const c of ['NOT_CAPTURING', 'NOT_ARMED', 'TAB_GONE', 'NEEDS_GESTURE', 'TAB_BUSY']) {
  ok(errorAction(c, false) === 'arm',
    `${c} offers NO Restart — the deck has no stream and LIVE_START would fail identically`);
}
ok(ARM_CODES.has('NOT_CAPTURING') && ARM_CODES.has('TAB_GONE'),
  'the arm family spans BOTH senders: NOT_CAPTURING from the offscreen document, TAB_GONE from the service worker');
/**
 * THE CODES DECK B TOOK WITH IT must not still be in the set.
 *
 * `DECKS_FULL` and `DECK_BUSY` were raised only by the two-deck resolver in
 * `sw/service-worker.js`, which is gone. A set that still listed them would be
 * describing a state this build cannot reach — and would pass forever, because
 * nothing can produce the input that would test it.
 */
for (const c of ['DECKS_FULL', 'DECK_BUSY', 'TAB_ON_OTHER_DECK']) {
  ok(!ARM_CODES.has(c), `${c} is not in ARM_CODES — no single-deck code path can raise it`);
}

// ============ ARM_ERROR.code is a CLOSED VOCABULARY, and it is checked (#29) ==
/**
 * `ARM_ERROR { code, message }` is a message a HOST ORIGINATES, and `code` is
 * drawn from ARM_CODES. A Host that invents a plausible-looking code gets a
 * banner the user cannot dismiss with a Restart control that cannot fix it, and
 * before v0.3.0 NOTHING went red — not `assertHost`, which cannot check a
 * message nobody sent; not the unit gate; not `group('host')`.
 *
 * THE LOUDNESS IS THE FEATURE, so it is what is asserted: `console.error` is
 * captured rather than trusted, because a check that returns a sentence nobody
 * prints is exactly the silent failure this replaces.
 */
{
  /**
   * `console.error` is swapped FOR THE ONE CALL and put back before the `ok()`
   * that reads the result — never around the block. `ok()` reports a failure
   * through `console.error` itself, so a capture that spanned the assertions
   * would eat their own reds: every mutation below would look green and this
   * block would be the silent suite `AGENTS.md` calls a hard failure. Watched:
   * with the capture around the block, seven mutations produced zero red lines.
   */
  const say = (code, where) => {
    const captured = [];
    const realError = console.error;
    console.error = (m) => captured.push(String(m));
    let out;
    try { out = checkArmCode(code, where); } finally { console.error = realError; }
    return { out, captured };
  };

  let cried = 0;
  for (const c of ARM_CODES) {
    const r = say(c);
    cried += r.captured.length;
    ok(r.out === null, `${c} is a member of the vocabulary and passes SILENTLY`);
  }
  ok(cried === 0,
    `a legal code says nothing — a check that cried wolf on every refusal would be turned off (got ${cried} line(s))`);

  // The exact shape a second Host reaches for: five of the eight members are
  // tab nouns, and a desktop Host has no tabs.
  const bad = say('NO_SOURCE', 'ARM_ERROR from the Host');
  ok(typeof bad.out === 'string' && bad.out.length > 0, 'an UNKNOWN code is refused rather than accepted in silence');
  ok(bad.captured.length === 1, `...and it reaches console.error EXACTLY ONCE (got ${bad.captured.length})`);
  const logged = bad.captured[0] || '';
  ok(logged.includes('NO_SOURCE'), 'the error NAMES THE OFFENDING VALUE, so the Host developer does not have to guess which message it was');
  ok(logged.includes('ARM_ERROR from the Host'), '...and names the entry point that received it');
  const missing = [...ARM_CODES].filter((c) => !logged.includes(c));
  ok(missing.length === 0,
    `...and names THE WHOLE LEGAL SET, so the message is a repair instruction${missing.length ? ` — missing ${missing.join(', ')}` : ` (all ${ARM_CODES.size})`}`);
  ok(/dismiss/i.test(logged) && /Restart/i.test(logged),
    '...and says what goes wrong if it is ignored: an undismissable banner and a dead Restart');
}

/**
 * ...AND THE DECK REALLY CALLS IT, ON BOTH WAYS IN.
 *
 * `checkArmCode` working proves nothing about `ui/embed.js` ever calling it —
 * the same gap `test.js` records for `assertHost`, where review deleted the
 * module-scope call and watched the whole tree stay green. There are exactly two
 * entry points a Host's code can reach the banner through: the live `ARM_ERROR`
 * message, and the refusal persisted at `ARM_ERROR_KEY` and read at boot. A
 * check wired to one of them is a check a Host escapes by using the other.
 *
 * Comments are stripped first: a claim a doc comment can satisfy is not a claim.
 */
{
  const embedSrc = readFileSync(new URL('../embed.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const calls = (embedSrc.match(/\bcheckArmCode\s*\(/g) || []).length;
  ok(embedSrc.includes("case 'ARM_ERROR':") && calls === 2,
    `ui/embed.js calls checkArmCode() on BOTH entry points — the live ARM_ERROR and the persisted refusal `
    + `(found ${calls}, wanted 2)`);
  ok(/import\s*\{[^}]*\bcheckArmCode\b[^}]*\}\s*from\s*'\.\/audio-math\.js'/.test(embedSrc),
    '...and takes it from the unit\'s own audio-math.js rather than keeping a second copy of the vocabulary');
}
{
  const s1 = errorSummary([{ id: 'A', code: 'HALTED', message: 'x', fatal: true, action: 'restart' }]);
  ok(s1.action === 'restart' && /stopped/.test(s1.title), 'a fatal pipeline error is "stopped" and offers Restart');
  /**
   * NO USER-FACING STRING NAMES A DECK. Checked across all three title families,
   * not just the one that was reported: "Deck A stopped — HALTED" reached a real
   * user, and it is a label from the deleted two-deck console. A single-deck
   * build has no deck for the reader to distinguish it from.
   *
   * The control is the second half — `who` still has to say SOMETHING, or
   * deleting the whole clause would pass a "does not say Deck A" check while
   * producing " stopped — HALTED".
   */
  for (const [label, s] of [
    ['fatal', errorSummary([{ id: 'A', code: 'HALTED', message: 'x', fatal: true, action: 'restart' }])],
    ['arm', errorSummary([{ id: 'A', code: 'TAB_GONE', message: 'x', fatal: true, action: 'arm' }])],
    ['advisory', errorSummary([{ id: 'A', code: 'SLOW', message: 'x', fatal: false, action: null }])],
  ]) {
    ok(!/\bdecks?\b/i.test(s.title), `the ${label} title names no deck — got "${s.title}"`);
    ok(/^\S/.test(s.title) && s.title.length > 12, `...and is not left with an empty subject — got "${s.title}"`);
  }

  const s2 = errorSummary([{ id: 'A', code: 'TAB_GONE', message: 'x', fatal: true, action: 'arm' }]);
  ok(s2.action === 'arm', 'an arm error offers no Restart');
  ok(/has no source/.test(s2.title) && !/stopped/.test(s2.title),
    'and is NOT called "stopped" — observed on the real service worker: a deck that never played a sample');

  /**
   * THE ARM REFUSAL is a third family, and it needed a third title.
   *
   * It is in ARM_CODES so Restart is withheld (restarting the deck says nothing
   * about which tab is armed). But borrowing the arm family's headline puts
   * "has no source" above a message about which tab is focused. Two assertions,
   * because the action and the title are two claims.
   */
  ok(errorAction('NO_ACTIVE_TAB', false) === 'arm',
    'NO_ACTIVE_TAB offers NO Restart — restarting the deck does not change which tab is armed');
  const sNone = errorSummary([{ id: 'A', code: 'NO_ACTIVE_TAB', message: 'focus a tab', fatal: true, action: 'arm' }]);
  ok(/^Cannot arm that tab/.test(sNone.title) && !/has no source/.test(sNone.title) && !/stopped/.test(sNone.title),
    'NO_ACTIVE_TAB is titled as a refusal, NOT "has no source" — which would contradict its own message');
  ok(sNone.action === 'arm' && sNone.message === 'focus a tab',
    '...while still withholding Restart and carrying the service worker\'s remedy verbatim');
  // The companion that keeps the branch honest: a real missing-source code in
  // the SAME family must still get the source wording, or the test above is
  // just asserting a constant.
  const sGone = errorSummary([{ id: 'A', code: 'TAB_GONE', message: 'y', fatal: true, action: 'arm' }]);
  ok(/has no source/.test(sGone.title) && !/Cannot arm/.test(sGone.title),
    '...and TAB_GONE, same family and same action, still reads "has no source" — the split is on the code, not on the action');
}

/**
 * armErrorFresh() — the staleness rule for the PERSISTED refusal.
 *
 * The absent-record case is asserted EXPLICITLY: "no refusal was ever raised"
 * must return false for a reason the test states, not because the function
 * happened not to throw.
 */
{
  const TTL = 60000, NOW = 1_700_000_000_000;
  ok(armErrorFresh({ at: NOW - 1 }, NOW, TTL) === true, 'a refusal raised one millisecond ago is painted');
  ok(armErrorFresh({ at: NOW - TTL }, NOW, TTL) === true, 'a refusal exactly at the TTL is still painted — the bound is inclusive');
  ok(armErrorFresh({ at: NOW - TTL - 1 }, NOW, TTL) === false,
    'one millisecond past the TTL it is not — a refusal from a previous sitting must never paint as current');
  ok(armErrorFresh(null, NOW, TTL) === false, 'NO RECORD is not fresh — the case where no refusal was ever raised');
  ok(armErrorFresh({}, NOW, TTL) === false, 'a record with no `at` is not fresh — it cannot be aged, so it cannot be trusted');
  ok(armErrorFresh({ at: 'soon' }, NOW, TTL) === false, '...and a non-numeric `at` is the same answer');
  ok(armErrorFresh({ at: NOW + 5000 }, NOW, TTL) === false,
    'a refusal from the FUTURE is a clock that moved, not a fresh refusal');
}

/**
 * normalizeDeck() is the one piece of deck plumbing the UI kept, and it is kept
 * for a reason the single-deck build makes easy to get wrong: the offscreen
 * document still stamps `deck` on the messages it broadcasts, so the page must
 * be able to say "this one is mine". An ABSENT field means A — the deck this
 * build has — and anything else is another deck's traffic to ignore.
 */
ok(normalizeDeck(undefined) === 'A', 'an absent deck field is this build\'s deck, not "whichever"');
ok(normalizeDeck('A') === 'A', 'A is A');
ok(normalizeDeck('B') === 'B', 'B still normalises to B, so a stray message is IGNORED rather than adopted');

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
