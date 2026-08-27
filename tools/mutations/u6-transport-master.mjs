#!/usr/bin/env node
/**
 * U6's MUTATION BATTERY, MADE RUNNABLE — "the deck as transport master for a
 * File source, over the engine's playback clock" (upstream #43).
 *
 *     node tools/mutations/u6-transport-master.mjs            # the whole battery
 *     node tools/mutations/u6-transport-master.mjs M1 M6      # named cases only
 *     node tools/mutations/u6-transport-master.mjs --table    # the table; nothing runs
 *
 * WHY THIS IS IN THE REPOSITORY AND NOT IN A SCRATCH DIRECTORY.
 *
 * A mutation battery is only valid against the source it was CUT FOR. A later
 * slice that rewrites a line stops every other slice's anchor over that line
 * from matching, and NOTHING ANNOUNCES IT — the battery goes on printing a pass
 * count while its anchors patch nothing. That is how a battery which reported
 * 51/51 at branch time measured 44/51 against a later `main`, with the seven
 * gaps being dead anchors rather than weak assertions. Two batteries in this
 * phase were lost outright because they lived in a per-session scratch
 * directory that is shared between agents. So: in the tree, beside the suite it
 * tests, named for its slice.
 *
 * ANCHORS CUT AGAINST `d75a6fd` — "feat(deck): make the deck the transport
 * master for a File source, over the engine's playback clock", the commit that
 * introduced every line M1-M17 patch. Every case carries a stamp in `cut`, and
 * this file prints it beside the current HEAD on every run so a reader sees the
 * distance without being told.
 *
 * THAT STAMP HAS ALREADY MOVED ONCE, WHICH IS WHY THE FILE NOW CHECKS IT. It
 * read `619908a` until a rebase replaced that commit with `d75a6fd`, and
 * NOTHING WENT RED: the anchors still matched, because a rebase copies the
 * content, and the SHA that no longer named anything was prose. The check the
 * runner does below is deliberately NOT `git cat-file -e` — that answers YES
 * for an orphaned commit, for as long as any un-force-pushed remote ref still
 * holds it, so it would have given a clean all-clear on exactly this. It asks
 * ANCESTOR-OF-HEAD, which is the claim the stamp actually makes.
 *
 * THE COMMIT IS THIS BRANCH'S, NOT `main`'s, AND THAT IS THE ONE THING TO
 * RE-CHECK AT INTEGRATION. The lines these anchors patch do not exist on `main`
 * — they are this slice — so there is no landed commit to stamp against yet.
 * Re-run this file against final `main` and re-stamp it to the landed SHA; the
 * ANCHOR column is what tells you whether anything actually moved.
 *
 * WHAT IT REPORTS, AND WHY IT IS TWO ANSWERS AND NOT ONE:
 *
 *   ANCHOR  — does the text this case patches still exist, exactly once?
 *             A miss is a DECAYED INSTRUMENT. Re-cut it. It is not a coverage
 *             finding and must never be counted as one.
 *   RED     — with the anchor applied, did the named assertions go red, and did
 *             the named controls stay green?
 *             A match that no longer reds is either a decayed instrument OR A
 *             REAL COVERAGE LOSS, and the two need opposite responses.
 *
 * A battery that reports only a pass count collapses those two into one number.
 * This one prints them in separate columns and exits non-zero on either.
 *
 * EVERY CONTROL IS A `green` AND EVERY `green` IS CHECKED AS A **PASS**, NOT AS
 * "absent from the reds". `test.js` is one process and group('host') is wrapped
 * in a guard that turns a throw into a named red — so a mutation that makes the
 * group throw leaves every later assertion NEITHER passed NOR failed, and an
 * assertion that DID NOT RUN reads exactly like one that passed if you only
 * look at the red lines. Each run's assertion total is printed against the
 * clean baseline for the same reason: the count is what makes truncation
 * visible.
 *
 * ONE SUITE. Every assertion this slice added is in `test.js` group('host') —
 * `node test.js host`, 155 passed / 0 failed with the D1 repair in the tree
 * (149 before it, 132 on `main` at `b9dc537`). The prose table
 * lives with the assertions, under the head
 * "host — THE DECK AS TRANSPORT MASTER"; this file is the executable copy and
 * the one that can be re-run.
 *
 * M16 IS THE MOST IMPORTANT CASE IN THE BATTERY AND IT IS NOT ABOUT THE CODE.
 * It deletes the follower's `start` dispatch, so nothing can ever start. The
 * boot gate — "ZERO capture grants" — goes on passing, because zero is what it
 * asks for and zero is what it gets. Only the CONTROL beside it catches that,
 * by reading 0 where it demands 1. A gate whose failure mode is "the number got
 * BETTER" is the third of AGENTS.md's three ways a gate fails, and it is the
 * one nobody asks about; the control is the answer to it, and M16 is the proof
 * the control works.
 *
 * THIS FILE IS ITSELF AN INSTRUMENT, SO IT WAS WATCHED FAILING. Five
 * mutations, applied to this file — the first three at the commit now known as
 * `d75a6fd`, the last two at the D1 repair — and each restored:
 *
 *   1. M6's `find` altered so it matches NOTHING
 *      -> `M6  ANCHOR DECAYED  extension/offscreen/cacheddeck.js: 0 match(es)`,
 *         exit 1, and the case is excluded from the RED denominator rather than
 *         counted as a failure to red. That distinction is the whole point of
 *         separating the two columns.
 *   2. an assertion the mutation does not touch added to M1's `red`
 *      -> `!! expected RED, got PASS`, exit 1, `NOT RED: M1`.
 *   3. `makeFollower` broken BEFORE the battery started, so group('host') is
 *      already red -> `baseline ... NOT GREEN`, exit 2, nothing run. Against an
 *      already-red suite every case below would "go red" while measuring
 *      nothing.
 *   4. `CUT_AGAINST` set back to `619908a`, the SHA the rebase orphaned
 *      -> `stamp M1-M17  619908a: !! NOT AN ANCESTOR OF HEAD — rebased or
 *         amended away`. The point of watching this one is what the OTHER
 *         question answers on the same input: `git cat-file -e 619908a` exits
 *         0, because the object is still held by an un-force-pushed remote ref.
 *         The wrong check passes on precisely the case the stamp exists for.
 *   5. `CUT_AGAINST` set to `deadbee`, which no repository has
 *      -> `stamp M1-M17  deadbee: !! DOES NOT RESOLVE AT ALL`. A separate line
 *         from case 4 on purpose: "rebased away" and "never existed" are
 *         different repairs, and `CUT_REPAIR` — prose until the repair lands —
 *         must print as neither.
 *
 * IT WRITES TO THE WORKING TREE AND PUTS IT BACK. Each case is applied, run and
 * reverted one at a time; the revert also runs on a throw, on SIGINT and on
 * SIGTERM. Run it on a clean tree — `git status --porcelain` before and after —
 * and never concurrently with a gate in the same checkout, because it is
 * deliberately editing the files that gate is reading.
 *
 * IT DOES NOT REGENERATE `extension/unit.sha256`, and it does not need to:
 * `node test.js host` does not read the sums file. `node tools/unit-check.mjs`
 * does, so do not add a case here that runs it without regenerating first.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CUT_AGAINST = 'd75a6fd';
/**
 * ...AND THE REPAIR'S OWN ANCHORS, which are a different commit. M18-M24 patch
 * the `isDeckClock` declaration and the video-lock gate, and none of those
 * lines existed at `d75a6fd`. `HEAD` until the repair lands: the same problem
 * `CUT_AGAINST` has above, said again rather than hidden, and re-stamped at
 * integration to the landed SHA. It is a STRING AND NOT A SHA on purpose — the
 * reachability check below skips what it cannot resolve rather than reporting a
 * commit missing, because "not yet committed" and "rebased away" are opposite
 * findings and must not print the same line.
 */
const CUT_REPAIR = 'HEAD (the D1 repair; re-stamp at integration)';

const SUITES = {
  host: { argv: ['test.js', 'host'], label: 'node test.js host' },
};

const ANSI = /\x1b\[[0-9;]*m/g;
const isRed = (l) => /^\s*FAIL\s/.test(l);
const isGreen = (l) => /^\s*(?:PASS|ok)\s/.test(l);

function runSuite(key) {
  const s = SUITES[key];
  const r = spawnSync(process.execPath, s.argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = String((r.stdout || '') + (r.stderr || '')).replace(ANSI, '').split('\n');
  return {
    code: r.status,
    reds: lines.filter(isRed),
    greens: lines.filter(isGreen),
    crashed: r.status !== 0 && !lines.some(isRed),
  };
}

/**
 * ONE MUTATION.
 *
 *   id      the name in the table and on the command line
 *   what    the mutation, in one sentence
 *   why     what defect it reproduces, where that matters
 *   suite   which instrument reports it
 *   cut     the revision these anchors were cut against
 *   edits   [{ file, find, replace }] — `find` must occur EXACTLY ONCE
 *   red     assertion-name substrings that MUST come back FAIL
 *   green   assertion-name substrings that MUST come back PASS — the controls
 */
const MUTATIONS = [
  // ------------------------------------------------ the ratified defect itself
  {
    id: 'M1', suite: 'host', cut: CUT_AGAINST,
    what: 'makeFollower stops deriving `hosted` from the transport — the state `transport: null` puts the deck in',
    why: 'THE defect. Four documents ratified a File source declaring `transport: null`; this is what that '
      + 'declaration does, one layer in. The red must show the PIPELINE STARTING, not a flag differing.',
    edits: [{
      file: 'extension/ui/embed-state.js',
      find: '  const hosted = transport != null;',
      replace: '  const hosted = false;   // U6/M1 mutation: the `transport: null` state, with a transport present',
    }],
    red: [
      'THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE',
      'THE PAGE-HOSTED PATH IS UNCHANGED',
      'THE DECK ASKS THE HOST, NOT THE WINDOW, AND ASKS ONCE',
    ],
    green: [
      'CONTROL — WITH `transport: null` THE SAME BOOT TICK STARTS THE PIPELINE',
      'A FILE SOURCE GETS A FULL SIX-DUTY TRANSPORT',
    ],
  },
  {
    id: 'M2', suite: 'host', cut: CUT_AGAINST,
    what: 'the follower stops registering onState — `videoPlaying` becomes structurally unwritable',
    why: 'The other half of the same defect: with `transport: null` there is no `onState` to register on, so the '
      + 'tri-state is not a value the deck is waiting for, it is one the deck can never leave.',
    edits: [{
      file: 'extension/ui/embed-state.js',
      find: '      transport.onState((d) => {',
      replace: '      if (false) transport.onState((d) => {   // U6/M2 mutation: nothing writes videoPlaying',
    }],
    red: [
      'and the SAME follower starts on the user\'s first gesture',
      'THE PAGE-HOSTED PATH IS UNCHANGED',
    ],
    /**
     * NOT a red here, and the reason is worth the line: the duty-reach scan is
     * TEXTUAL, so an `onState` call wrapped in `if (false)` is still a call it
     * can see. It is the right control for exactly that reason — it says the
     * seam declaration survived while the wiring did not.
     */
    green: [
      'THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE',
      'CONTROL — WITH `transport: null` THE SAME BOOT TICK STARTS THE PIPELINE',
      'EVERY PAGE AND TRANSPORT DUTY THE DECK REACHES FOR IS DECLARED',
    ],
  },
  {
    id: 'M3', suite: 'host', cut: CUT_AGAINST,
    what: 'the shipping ui/host.js declares it has no player at all — FRAMED forced false',
    why: 'The declaration layer, at the one Host that ships. It is here to show the BLAST RADIUS: the deck half '
      + 'of the group calls `deckHost.transport.release()` directly, so this mutation throws inside the group '
      + 'guard and TRUNCATES the report — which is why every control in this battery is checked as a PASS and '
      + 'never as "absent from the reds".',
    edits: [{
      file: 'extension/ui/host.js',
      find: 'const FRAMED = window.parent !== window;',
      replace: 'const FRAMED = false;   // U6/M3 mutation: this Host declares transport: null',
    }],
    red: [
      'HOSTED IS A FACT ABOUT THE HOST, NOT ABOUT FRAMES',
      'group(host) REACHED ITS LAST ASSERTION',
    ],
    green: ['A HOST THAT NEVER MENTIONED `transport` IS REFUSED'],
  },
  // --------------------------------------------- the composition, and its wiring
  {
    id: 'M4', suite: 'host', cut: CUT_AGAINST,
    what: 'the deck hands the follower a start effect that does nothing',
    why: 'The count in the suite is of calls into a recorder the suite wrote. This is the case that says so: if '
      + '`startPipeline` is not what the deck hands over, every count still passes and means something else.',
    edits: [{
      file: 'extension/ui/embed.js',
      find: '  start: startPipeline,',
      replace: '  start: () => {},   // U6/M4 mutation: the count above now stands in for nothing',
    }],
    red: ['THE RECORDER ABOVE IS STANDING IN FOR A REAL CAPTURE GRANT AND A REAL MODEL LOAD'],
    green: ['THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE'],
  },
  {
    id: 'M5', suite: 'host', cut: CUT_AGAINST,
    what: 'the deck builds its follower over a transport of its own instead of the Host’s',
    why: 'A deck that answers the hosted question from anything but `assertHostOption`’s return value has two '
      + 'answers that can disagree, and the misspelled-key case stops being detectable at all.',
    edits: [{
      file: 'extension/ui/embed.js',
      find: 'const follower = makeFollower(transport, {',
      replace: 'const follower = makeFollower({ onState() {}, onJump() {}, onSpeedReport() {} }, {   // U6/M5 mutation',
    }],
    red: [
      'THE DECK ASKS THE HOST, NOT THE WINDOW, AND ASKS ONCE',
      // A knock-on, and a HONEST one: the chain regex is anchored on
      // `makeFollower(transport, {`, which is the text this case rewrites. It
      // is listed as a red rather than hidden as a control, because a case that
      // reds two assertions and claims one is a case nobody can reconcile.
      'THE RECORDER ABOVE IS STANDING IN FOR A REAL CAPTURE GRANT AND A REAL MODEL LOAD',
    ],
    green: ['and the engine really carries both halves of the wire, with the RAW message'],
  },
  {
    id: 'M14', suite: 'host', cut: CUT_AGAINST,
    what: 'makeFollower accepts an effects bag that is missing effects',
    why: 'A follower short `start` decides to run and nothing runs — a failure that has to land at boot, not at '
      + 'the first play.',
    edits: [{
      file: 'extension/ui/embed-state.js',
      find: '  const missing = EFFECTS.filter((k) => typeof (o || {})[k] !== \'function\');',
      replace: '  const missing = [];   // U6/M14 mutation: nothing is required of the effects bag',
    }],
    red: ['and a deck that supplies the follower half its effects is refused at boot'],
    green: ['THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE'],
  },
  {
    id: 'M16', suite: 'host', cut: CUT_AGAINST,
    what: 'the follower decides ‘start’ and dispatches nothing',
    why: 'THE THIRD WAY A GATE FAILS. Nothing can ever start, so the boot gate’s "ZERO capture grants" goes on '
      + 'passing — the number it reads gets BETTER when the code breaks. Only the control beside it, which '
      + 'demands a 1, catches this.',
    edits: [{
      file: 'extension/ui/embed-state.js',
      find: '      if (what === \'start\') o.start();',
      replace: '      if (false) o.start();   // U6/M16 mutation: the decision reaches no effect',
    }],
    red: [
      'CONTROL — WITH `transport: null` THE SAME BOOT TICK STARTS THE PIPELINE',
      'and the SAME follower starts on the user\'s first gesture',
      'THE PAGE-HOSTED PATH IS UNCHANGED',
    ],
    green: ['THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE'],
  },
  {
    id: 'M17', suite: 'host', cut: CUT_AGAINST,
    what: '`videoPlaying` is exposed as a plain property instead of a getter',
    why: 'A fixture that can assign the flag can make the hosted and unhosted cases identical inputs, and a gate '
      + 'whose fixture makes two inputs identical is blind to whatever distinguishes them.',
    edits: [{
      file: 'extension/ui/embed-state.js',
      find: '    get videoPlaying() { return videoPlaying; },',
      replace: '    videoPlaying,   // U6/M17 mutation: a snapshot a caller can overwrite',
    }],
    red: [
      'and nothing outside the transport can write `videoPlaying`',
      'and the SAME follower starts on the user\'s first gesture',
    ],
    green: ['THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE'],
  },
  // ------------------------------------------- the engine’s half: the report
  {
    id: 'M6', suite: 'host', cut: CUT_AGAINST,
    what: 'the deck stops putting its transport report on the wire',
    why: 'The clock reported outward is the thing that did not exist before this slice. Without it a Host has '
      + 'nothing to back `onState` with, and the deck never learns its own player is playing.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '    this.pushTransport();',
      replace: '    // this.pushTransport();   U6/M6 mutation: the clock never leaves the engine',
    }],
    red: [
      'onState REPORTS THE ENGINE\'S OWN PLAYHEAD on every event that moves it',
      'and the SAME follower starts on the user\'s first gesture',
      'and it carries the playing/ended pair the readout cannot',
      'and NO report ever says `seeking`',
    ],
    green: [
      'THE DECK DOES NOT START THE PIPELINE ON BOOT FOR A FILE SOURCE',
      'and a deck that has not moved says NOTHING',
    ],
  },
  {
    id: 'M7', suite: 'host', cut: CUT_AGAINST,
    what: 'the report carries a constant position instead of the deck’s playhead',
    why: 'The report has to BE the engine’s clock. A plausible constant is the shape a Host would relay '
      + 'without noticing, and the video lock would then correct against it for ever.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '      currentTime: +this.positionSec().toFixed(3),',
      replace: '      currentTime: 0,   // U6/M7 mutation: a plausible constant, not the playhead',
    }],
    red: [
      'onState REPORTS THE ENGINE\'S OWN PLAYHEAD on every event that moves it',
      // ...and a knock-on that is itself informative: a constant position
      // collapses the dedupe key, so the later steps' reports never reach the
      // wire at all and the pair assertion has nothing to read.
      'and it carries the playing/ended pair the readout cannot',
    ],
    green: ['drive() WRITES MUTE AND POSITION AND NOTHING ELSE'],
  },
  {
    id: 'M8', suite: 'host', cut: CUT_AGAINST,
    what: 'the report’s dedupe key includes atMs',
    why: 'A timestamp that moves every tick defeats a dedupe entirely — the one-character version of not having '
      + 'one. A paused deck would wake its Host ten times a second for ever.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '    const key = `${r.playing}|${r.currentTime}|${r.duration}|${r.ended}|${r.seeking}`;',
      replace: '    const key = `${r.playing}|${r.currentTime}|${r.duration}|${r.ended}|${r.seeking}|${r.atMs}`;'
        + '   // U6/M8 mutation',
    }],
    red: ['and a deck that has not moved says NOTHING'],
    green: ['and NO report ever says `seeking`'],
  },
  {
    id: 'M9', suite: 'host', cut: CUT_AGAINST,
    what: 'the report says it is seeking',
    why: 'embed.js turns every report into PAGE_VIDEO{seeking} and engine.js seeks a cached deck on it — so this '
      + 'is a deck told to seek to a stale position ten times a second, flushing the tempo tap each time.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '      seeking: false,',
      replace: '      seeking: true,   // U6/M9 mutation: the report routes itself back as a seek',
    }],
    red: ['and NO report ever says `seeking`'],
    green: ['drive() WRITES MUTE AND POSITION AND NOTHING ELSE'],
  },
  // ------------------------------------- the engine’s half: drive and release
  {
    id: 'M10', suite: 'host', cut: CUT_AGAINST,
    what: 'drive() spreads its patch onto the deck instead of naming its fields',
    why: 'The one-character mistake the closure exists to catch: the write set becomes whatever a call site '
      + 'happened to pass, and widening it is then invisible in review. L1 is a security property.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '    const p = patch || {};\n    const applied = [];',
      replace: '    const p = patch || {};\n    Object.assign(this, p);   // U6/M10 mutation: the write set is open\n'
        + '    const applied = [];',
    }],
    red: ['drive() WRITES MUTE AND POSITION AND NOTHING ELSE'],
    green: ['release() HANDS THE PLAYER BACK, READ BACK OFF THE DECK'],
  },
  {
    id: 'M11', suite: 'host', cut: CUT_AGAINST,
    what: 'pushMaster ignores the transport mute',
    why: 'A mute that is a field nobody plays. The deck reports muted and is audible; a Host taking a lock to '
      + 'silence a player would silence nothing and never find out.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '    const value = this.transportMuted ? 0 : dbToGain(this.masterDb);',
      replace: '    const value = dbToGain(this.masterDb);   // U6/M11 mutation: the mute never reaches the graph',
    }],
    red: ['and the mute REACHES THE GRAPH rather than only the field'],
    green: ['drive() WRITES MUTE AND POSITION AND NOTHING ELSE'],
  },
  {
    id: 'M12', suite: 'host', cut: CUT_AGAINST,
    what: 'release() does not unmute',
    why: 'A muted deck left behind is a track that plays silently with every meter saying otherwise — the one '
      + 'thing drive() can do that the user cannot see and cannot undo.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '    const was = this.transportMuted;\n    this.transportMuted = false;',
      replace: '    const was = this.transportMuted;   // U6/M12 mutation: the mute is never given back',
    }],
    red: ['release() HANDS THE PLAYER BACK, READ BACK OFF THE DECK'],
    green: ['and the mute REACHES THE GRAPH rather than only the field'],
  },
  {
    id: 'M13', suite: 'host', cut: CUT_AGAINST,
    what: 'load() lets a transport mute survive the track boundary',
    why: 'The next track plays silently while every status field says it is playing — the stale-but-plausible '
      + 'shape stemcache.js’s header calls the worst bug this project can ship, wearing a mixer’s clothes.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '    this.transportMuted = false;\n    this.transportAt = null;\n    this.pushGains(0);',
      replace: '    this.transportAt = null;   // U6/M13 mutation: the lock survives the load\n    this.pushGains(0);',
    }],
    red: ['and a NEW TRACK does not inherit a lock that was never released'],
    green: ['release() HANDS THE PLAYER BACK, READ BACK OFF THE DECK'],
  },
  {
    id: 'M15', suite: 'host', cut: CUT_AGAINST,
    what: 'the engine filters the drive patch before the deck sees it',
    why: 'It looks like an improvement and it moves the closure out of the deck, where the suite proves it, and '
      + 'into a call site any future Host or handler can forget.',
    edits: [{
      file: 'extension/offscreen/engine.js',
      find: '        cachedDecks[id].drive(m);',
      replace: '        cachedDecks[id].drive({ muted: m.muted, currentTime: m.currentTime });   // U6/M15 mutation',
    }],
    red: ['and the engine really carries both halves of the wire, with the RAW message'],
    green: ['drive() WRITES MUTE AND POSITION AND NOTHING ELSE'],
  },
  // ------------------------------- the declaration, and the lock it stops (D1)
  /**
   * M18-M24 ARE CUT AGAINST A LATER COMMIT THAN M1-M17, and each says so in its
   * own `cut` field rather than sharing the file's constant. They patch the
   * repair for the BLOCKER — the video lock silencing a File source with that
   * source's own transport — and those lines did not exist when M1-M17 were
   * cut. A battery whose anchors come from two commits and pretends to one is
   * a battery whose decay nobody can date.
   */
  {
    id: 'M18', suite: 'host', cut: CUT_REPAIR,
    what: 'videoLockWant drops the `isDeckClock` term — the gate goes back to what it was',
    why: 'THE BLOCKER. `source === "cache" && status === "running"` is exactly what a File source’s cached '
      + 'deck reports, so the lock acquires on the deck it IS and `drive({muted:true})` silences it for the '
      + 'whole track while every meter says it is playing. Silent while playing, audible while stopped.',
    edits: [{
      file: 'extension/ui/embed-state.js',
      find: '  if (s.isDeckClock) return false;',
      replace: '  if (false) return false;   // U6/M18 mutation: the gate cannot tell a deck from a page player',
    }],
    red: ['THE VIDEO LOCK NEVER TAKES A DECK THAT IS ITS OWN CLOCK'],
    // The call site is untouched, so the red above is the ANSWER changing and
    // not the wiring going away. That is the pair M21 completes from the other side.
    green: [
      '...and the DECK\'s lock really asks that gate',
      '...and the gate itself refuses a transport that declared nothing',
    ],
  },
  {
    id: 'M19', suite: 'host', cut: CUT_REPAIR,
    what: 'the SHIPPING page Host declares it IS the deck’s own clock',
    why: 'The declaration answered wrongly by the one Host that ships. The page’s `<video>` really does need '
      + 'the lock — docs/AUDIO.md §8.2 — so this silently retires a shipping feature, and it is why the gate '
      + 'assertion is a PAIR: a gate that answered `false` always would pass the deck-clock half alone.',
    edits: [{
      file: 'extension/ui/host.js',
      find: '    isDeckClock: false,',
      replace: '    isDeckClock: true,   // U6/M19 mutation: the page player claims to be the deck',
    }],
    red: [
      'A FILE SOURCE\'S TRANSPORT DECLARES IT IS THE DECK\'S OWN CLOCK',
      'THE VIDEO LOCK NEVER TAKES A DECK THAT IS ITS OWN CLOCK',
    ],
    green: ['...and a transport that never SAID which it is'],
  },
  {
    id: 'M20', suite: 'host', cut: CUT_REPAIR,
    what: 'assertDeclared stops telling a Host that said NOTHING from one that answered badly',
    why: 'The subtle half, and the reason that assertion reads the two SENTENCES rather than counting throws: '
      + 'an omitted declaration is also not a boolean, so the check still throws naming `isDeckClock`, and a '
      + 'condition that asked only "did it throw" would go on passing over a check that had stopped '
      + 'distinguishing silence from a wrong answer.',
    edits: [{
      file: 'extension/shared/host.js',
      find: '  const silent = names.filter((k) => !(k in ns));',
      replace: '  const silent = [];   // U6/M20 mutation: silence is no longer its own failure',
    }],
    red: ['...and a transport that never SAID which it is'],
    green: ['A FILE SOURCE\'S TRANSPORT DECLARES IT IS THE DECK\'S OWN CLOCK'],
  },
  {
    id: 'M21', suite: 'host', cut: CUT_REPAIR,
    what: 'syncVideoLock stops asking the gate and spells the old condition itself',
    why: 'The other side of M18’s pair. The pure gate still answers correctly and the two assertions that '
      + 'DRIVE it still pass — a fixture in which the thing under test is a no-op — so only the chain link '
      + 'catches it, which is why that link exists and why it names the transport’s own declaration.',
    edits: [{
      file: 'extension/ui/embed.js',
      find: '  const want = videoLockWant({\n'
        + '    source: live.source, status: live.status, isDeckClock: transport.isDeckClock,\n'
        + '  });',
      replace: "  const want = live.source === 'cache' && live.status === 'running';   // U6/M21 mutation",
    }],
    red: ['...and the DECK\'s lock really asks that gate'],
    green: ['THE VIDEO LOCK NEVER TAKES A DECK THAT IS ITS OWN CLOCK'],
  },
  {
    id: 'M22', suite: 'host', cut: CUT_REPAIR,
    what: 'the engine-backed report grows a sixth value',
    why: 'FINDING A, made a red. `DeckTransport.onState` names six values and this player reports five, '
      + 'because it has no rate to report; the next reader will try to close the gap with a constant. The '
      + 'sixth here is deliberately NOT the rate, so this case measures the key set rather than borrowing '
      + 'qa/speed-pitch.mjs’s claim — which is the second red, one file away, if the sixth ever is.',
    edits: [{
      file: 'extension/offscreen/cacheddeck.js',
      find: '      atMs: Date.now(),',
      replace: '      atMs: Date.now(), sixth: 1,   // U6/M22 mutation: a value nothing reads',
    }],
    red: ['THE ENGINE-BACKED REPORT CARRIES FIVE VALUES AND ITS TIMESTAMP'],
    green: ['onState REPORTS THE ENGINE\'S OWN PLAYHEAD'],
  },
  {
    id: 'M23', suite: 'host', cut: CUT_REPAIR,
    what: 'the deck’s boot line drops the declarations table',
    why: '`assertHostOption` takes `declarations` OPTIONALLY — it has to, it is generic — so this is the one '
      + 'character of the repair that can be forgotten without any direct drive noticing: every refusal '
      + 'above still passes, and a Host that never declared `isDeckClock` reaches the lock unchecked.',
    edits: [{
      file: 'extension/ui/embed.js',
      find: 'const transport = assertHostOption(\n'
        + "  host, 'transport', DECK_TRANSPORT_DUTIES, 'DeckHost', DECK_TRANSPORT_DECLARATIONS,\n"
        + ');',
      replace: "const transport = assertHostOption(host, 'transport', DECK_TRANSPORT_DUTIES, 'DeckHost');"
        + '   // U6/M23 mutation',
    }],
    red: [
      'THE DECK ITSELF RUNS ALL THREE BOOT CHECKS',
      '...and each runs BEFORE the deck first reaches for the thing it guards',
    ],
    green: ['...and a transport that never SAID which it is'],
  },
  {
    id: 'M24', suite: 'host', cut: CUT_REPAIR,
    what: 'assertHostOption stops passing the declarations on to assertDeclared',
    why: 'M23’s defect one layer in: the table is named at the call site and the check it names never runs. '
      + 'The direct drives all still pass, because they hand the table in themselves.',
    edits: [{
      file: 'extension/shared/host.js',
      find: '  if (declarations) assertDeclared(got, declarations, `${what}.${key}`);',
      replace: '  if (false) assertDeclared(got, declarations, `${what}.${key}`);   // U6/M24 mutation',
    }],
    red: ['...and a transport that never SAID which it is'],
    green: ['A FILE SOURCE\'S TRANSPORT DECLARES IT IS THE DECK\'S OWN CLOCK'],
  },
];

// ---------------------------------------------------------------- the runner
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node tools/mutations/u6-transport-master.mjs [--table] [M1 M2 …]');
  process.exit(0);
}
if (argv.includes('--table')) {
  console.log(`U6 mutation battery — anchors cut against ${CUT_AGAINST} (M1-M17) and ${CUT_REPAIR} (M18-M24)\n`);
  for (const m of MUTATIONS) {
    console.log(`${m.id.padEnd(5)} ${SUITES[m.suite].label.padEnd(20)} ${m.what}`);
    console.log(`${''.padEnd(5)} ${'why'.padEnd(20)} ${m.why}`);
    for (const r of m.red) console.log(`${''.padEnd(5)} ${'RED'.padEnd(20)} ${r}`);
    for (const g of m.green) console.log(`${''.padEnd(5)} ${'green (control)'.padEnd(20)} ${g}`);
    console.log('');
  }
  process.exit(0);
}

const wanted = argv.filter((a) => !a.startsWith('-'));
const cases = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS;
if (wanted.length && cases.length !== wanted.length) {
  const known = new Set(MUTATIONS.map((m) => m.id));
  console.error(`no such case: ${wanted.filter((w) => !known.has(w)).join(', ')}`);
  process.exit(2);
}

let head = '(unknown)';
try {
  head = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch { /* a vendored copy has no git; the stamp still prints */ }

/**
 * IS THE STAMP STILL POINTING AT SOMETHING? THREE ANSWERS AND NOT TWO.
 *
 * `git cat-file -e` is the WRONG QUESTION and this file is the reason the rule
 * exists: it answers YES for a commit a rebase orphaned, because the object
 * survives while any un-force-pushed remote ref still names it. Asked that way
 * the check gives a clean all-clear today and starts failing on the first
 * force-push, GC or fresh clone — the one moment nobody is looking. Ask
 * ANCESTOR-OF-HEAD instead: that is the claim the stamp makes.
 *
 * A WARNING AND NOT AN EXIT. The anchors are the evidence and the ANCHOR column
 * measures them directly; an unreachable stamp means "re-stamp this file", not
 * "these cases are wrong". Exiting here would turn a provenance note into a
 * failed battery and teach the next reader to skip it.
 *
 * UNRESOLVABLE IS ITS OWN ANSWER, third and separate. `CUT_REPAIR` is prose
 * until the repair lands, and a vendored copy has no git at all; reporting
 * either as "rebased away" would be a false alarm of exactly the kind the
 * paragraph above is about.
 */
const SHA = /^[0-9a-f]{7,40}$/;
function stampState(stamp) {
  if (head === '(unknown)') return 'unchecked (no git here)';
  if (!SHA.test(stamp)) return 'not a SHA yet — nothing to check';
  try {
    execFileSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', stamp, 'HEAD'], { stdio: 'ignore' });
    return 'reachable from HEAD';
  } catch {
    try {
      execFileSync('git', ['-C', ROOT, 'rev-parse', '--verify', `${stamp}^{commit}`], { stdio: 'ignore' });
      return '!! NOT AN ANCESTOR OF HEAD — rebased or amended away. RE-STAMP (INTEGRATION 22, 35c)';
    } catch {
      return '!! DOES NOT RESOLVE AT ALL — RE-STAMP (INTEGRATION 22, 35c)';
    }
  }
}

console.log(`U6 mutation battery — anchors cut against ${CUT_AGAINST} (M1-M17) and ${CUT_REPAIR} (M18-M24); `
  + `HEAD is ${head}`);
console.log(`  stamp M1-M17  ${CUT_AGAINST}: ${stampState(CUT_AGAINST)}`);
console.log(`  stamp M18-M24 ${CUT_REPAIR}: ${stampState(CUT_REPAIR)}`);
console.log(`${cases.length} case(s), ${new Set(cases.map((c) => c.suite)).size} suite(s)\n`);

/**
 * THE CONTROL FOR THE WHOLE BATTERY. A red is only evidence if the suite was
 * green before the mutation: against an already-red suite every case below
 * would "go red" while measuring nothing, which is AGENTS.md's second way a
 * gate fails. Run once per suite, up front, and refuse to run at all otherwise.
 */
const baseline = {};
for (const key of new Set(cases.map((c) => c.suite))) {
  const r = runSuite(key);
  baseline[key] = r;
  const verdict = r.code === 0 && r.reds.length === 0 ? 'GREEN' : 'NOT GREEN';
  console.log(`  baseline  ${SUITES[key].label.padEnd(20)} ${verdict}  `
    + `${r.greens.length} passed, ${r.reds.length} failed, exit ${r.code}`);
  if (verdict !== 'GREEN') {
    console.error('\nthe baseline is not green, so no red below would be evidence. Fix the tree first.');
    process.exit(2);
  }
}
/**
 * ...AND EVERY NEEDLE IS CHECKED AGAINST THAT BASELINE BEFORE ANYTHING IS
 * MUTATED. A `red` or `green` naming an assertion that no longer exists —
 * renamed, reworded, or simply mistyped — comes back as DID NOT RUN, which is
 * indistinguishable from an assertion the mutation truncated away. That is the
 * decay §24 is about, wearing a different coat, and it is checkable for free
 * here: the baseline is all green, so every live assertion IS a green line.
 *
 * MEASURED, ON THIS BATTERY'S FIRST RUN: two needles spelled an apostrophe as
 * U+2019 where the suite spells U+0027, and four cases reported DID NOT RUN
 * against assertions that were passing perfectly well two lines away.
 */
for (const m of cases) {
  const lines = baseline[m.suite].greens;
  const dead = [...m.red, ...m.green].filter((n) => !lines.some((l) => l.includes(n)));
  if (dead.length) {
    console.error(`${m.id}: ${dead.length} needle(s) match no assertion in the green baseline:`);
    for (const d of dead) console.error(`  ${JSON.stringify(d)}`);
    console.error('\nA needle that matches nothing reports DID NOT RUN, which reads exactly like an assertion '
      + 'the mutation truncated away. Re-cut the needle; it is an instrument, not a finding.');
    process.exit(2);
  }
}

console.log('');

const files = new Map();
const save = (rel) => { if (!files.has(rel)) files.set(rel, readFileSync(path.join(ROOT, rel), 'utf8')); };
const restoreAll = () => { for (const [rel, src] of files) writeFileSync(path.join(ROOT, rel), src); files.clear(); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restoreAll(); process.exit(130); });

const results = [];
try {
  for (const m of cases) {
    /**
     * ANCHOR FIRST, AND SEPARATELY. `find` must occur exactly once. Zero is a
     * decayed anchor — the line it patched has been rewritten. More than one is
     * an ambiguous anchor, which is the same defect wearing the opposite
     * symptom: the case would patch a site it was not cut for.
     */
    const anchors = m.edits.map((e) => {
      const abs = path.join(ROOT, e.file);
      if (!existsSync(abs)) return { ...e, n: -1 };
      return { ...e, n: readFileSync(abs, 'utf8').split(e.find).length - 1 };
    });
    const bad = anchors.filter((a) => a.n !== 1);
    if (bad.length) {
      const why = bad.map((a) => `${a.file}: ${a.n < 0 ? 'FILE ABSENT' : `${a.n} match(es)`}`).join('; ');
      results.push({ id: m.id, anchor: 'DECAYED', red: 'not run', detail: why });
      console.log(`${m.id.padEnd(5)} ANCHOR DECAYED  ${why}`);
      console.log(`${''.padEnd(5)}   ${m.what}\n`);
      continue;
    }

    for (const e of m.edits) {
      const abs = path.join(ROOT, e.file);
      save(e.file);
      // A replacer FUNCTION, not a replacement string: `$&`, `$'` and friends
      // are substitution syntax and several replacements are template literals.
      writeFileSync(abs, readFileSync(abs, 'utf8').replace(e.find, () => e.replace));
    }
    const r = runSuite(m.suite);
    restoreAll();

    const outcome = (needle) => {
      if (r.reds.some((l) => l.includes(needle))) return 'FAIL';
      if (r.greens.some((l) => l.includes(needle))) return 'PASS';
      return 'DID NOT RUN';
    };
    const misses = [];
    for (const n of m.red) { const o = outcome(n); if (o !== 'FAIL') misses.push(`expected RED, got ${o}: ${n}`); }
    for (const n of m.green) { const o = outcome(n); if (o !== 'PASS') misses.push(`expected PASS, got ${o}: ${n}`); }
    const base = baseline[m.suite];
    const ran = r.greens.length + r.reds.length;
    const baseRan = base.greens.length + base.reds.length;
    const truncated = baseRan - ran;
    const detail = `${r.greens.length} passed, ${r.reds.length} failed, exit ${r.code}`
      + (truncated > 0 ? `, ${truncated} of ${baseRan} DID NOT RUN` : '');

    results.push({ id: m.id, anchor: 'ok', red: misses.length ? 'MISS' : 'ok', detail, misses });
    console.log(`${m.id.padEnd(5)} ANCHOR ok  RED ${misses.length ? 'MISS' : 'ok  '}  ${SUITES[m.suite].label}`);
    console.log(`${''.padEnd(5)}   ${m.what}`);
    console.log(`${''.padEnd(5)}   ${detail}`);
    for (const x of misses) console.log(`${''.padEnd(5)}   !! ${x}`);
    if (r.crashed) console.log(`${''.padEnd(5)}   !! the suite CRASHED without a red line — exit ${r.code}`);
    console.log('');
  }
} finally {
  restoreAll();
}

const decayed = results.filter((x) => x.anchor !== 'ok');
const missed = results.filter((x) => x.anchor === 'ok' && x.red !== 'ok');
console.log('---');
console.log(`anchors   : ${results.length - decayed.length} of ${results.length} still match the source they were cut against`);
console.log(`mutations : ${results.length - decayed.length - missed.length} of ${results.length - decayed.length} matching anchors still RED as specified`);
if (decayed.length) console.log(`DECAYED   : ${decayed.map((x) => x.id).join(', ')} — re-cut these; they are instruments, not findings`);
if (missed.length) console.log(`NOT RED   : ${missed.map((x) => x.id).join(', ')} — decayed instrument OR a real coverage loss; investigate before re-cutting`);
process.exit(decayed.length || missed.length ? 1 : 0);
