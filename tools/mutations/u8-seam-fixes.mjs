#!/usr/bin/env node
/**
 * U8's MUTATION BATTERY, MADE RUNNABLE — "report a throwing hole, the model's
 * provenance, and an unknown arm code" (upstream #30, #28, #29).
 *
 *     node tools/mutations/u8-seam-fixes.mjs              # the whole battery
 *     node tools/mutations/u8-seam-fixes.mjs M10 M11      # named cases only
 *     node tools/mutations/u8-seam-fixes.mjs --table      # the table; nothing runs
 *
 * WHY THIS IS IN THE REPOSITORY AND NOT IN A SCRATCH DIRECTORY.
 *
 * `INTEGRATION.md` §18: a mutation battery is only valid against the source it
 * was CUT FOR. A later slice that rewrites a line stops every other slice's
 * anchor over that line from matching, and NOTHING ANNOUNCES IT — the battery
 * goes on printing a pass count while ten of its anchors patch nothing. That is
 * how a battery that reported 51/51 at branch time measured 44/51 against final
 * `main`, with the seven gaps being dead anchors rather than weak assertions.
 * So every "watched red" claim expires the moment someone else edits the file,
 * and the only defence is to re-run the battery before a tag.
 *
 * U8's battery could not be re-run at all: it lived in a per-session scratch
 * directory, that directory is shared between agents and was clobbered, and all
 * that survived was a forty-line `watch()` framework with its cases passed in
 * inline. They were recoverable only because PR #46's body tabulated them. A
 * battery that cannot be re-run is a green recorded once and never checkable
 * again, which is the same thing as no evidence at all. Hence: in the tree,
 * beside the gates, cut against a LANDED commit (`INTEGRATION.md` §22).
 *
 * TWENTY-ONE CASES, AND THE ARITHMETIC IS WORTH ONE LINE because PR #46 says
 * "19 mutations" over a table of twenty rows. M1..M19 are the nineteen numbered
 * mutations; M12b is a twentieth row rather than a twentieth number, being M12's
 * shape moved one member over, and it earns its place as M12's own control. M20
 * is the read-position red the PR names in prose UNDER the table rather than in
 * it, and it is here because it is the one case reported by a fourth instrument.
 *
 * ANCHORS CUT AGAINST `5993d32` — `docs(test): say how the two guard layers
 * compose, in the helper that does it`, on `main`. Every case carries that stamp
 * in `cut`, and this file prints the stamp beside the current HEAD on every run
 * so a reader sees the distance without being told.
 *
 * WHAT IT REPORTS, AND WHY IT IS TWO ANSWERS AND NOT ONE (`INTEGRATION.md` §24):
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
 * "absent from the reds". The distinction is the whole hazard of a mutation that
 * truncates its suite: `test.js` is one process, so a hole that throws at import
 * takes ninety-one later assertions out of the run entirely, and an assertion
 * that DID NOT RUN reads exactly like one that passed if you only look at the
 * red lines. Each run's assertion total is printed against the clean baseline
 * for the same reason — the count is what makes the truncation visible.
 *
 * THE THREE SUITES ARE THREE DIFFERENT INSTRUMENTS, and picking the wrong one
 * reports a clean green that means nothing. A sweeper nearly filed U8's #29
 * assertions as toothless after re-running the battery through `node test.js`
 * and getting 766 passed / 0 failed: `checkArmCode`'s ten assertions are in
 * `extension/ui/dev/selftest.mjs`, which `node test.js` does not load. The
 * `suite` field on every case below is that mapping, written down once:
 *
 *   M1–M4    `node test.js host`          — #30's import guard, #28's log line
 *   M5–M9    `node test.js verifyModel`   — #28's provenance across the seam
 *   M10–M19  `node extension/ui/dev/selftest.mjs`  — #29's closed vocabulary
 *            (eleven cases: M12b sits between M12 and M13)
 *   M20      `node tools/unit-check.mjs`  — the read-position declaration
 *
 * The prose tables live with the assertions, which is where someone reading a
 * red will be: `test.js` group('host'), `test.js` group('verifyModel'), and the
 * ARM_ERROR block in `extension/ui/dev/selftest.mjs`. This file is the
 * executable copy of the same rows and the one that can be re-run.
 *
 * NOTHING RUNS THIS AUTOMATICALLY, ON PURPOSE. It edits the working tree, so it
 * cannot ride inside `tools/verify.mjs` beside a gate that is reading the same
 * files, and it is not a step: adding one would move no assertion count while
 * making every gate run twenty-one processes slower. `INTEGRATION.md` §18 puts
 * it where it belongs instead — RE-RUN EVERY MUTATION BATTERY BEFORE ANY TAG,
 * against final `main`, and report the re-established figure rather than the one
 * recorded at branch time.
 *
 * THIS FILE IS ITSELF AN INSTRUMENT, SO IT WAS WATCHED FAILING. Five mutations,
 * applied to a throwaway copy at `5993d32`, each restored:
 *
 *   1. an anchor's `find` altered so it matches NOTHING
 *      -> `M11  ANCHOR DECAYED  extension/ui/audio-math.js: 0 match(es)`, exit 1,
 *         and the case is excluded from the RED denominator rather than counted
 *         as a failure to red. That distinction is the entire point of §24.
 *   2. an anchor's `find` widened to `return null;`, which matches TWICE
 *      -> `ANCHOR DECAYED ... 2 match(es)`, exit 1. An ambiguous anchor patches a
 *         site it was not cut for, which is the same defect wearing the opposite
 *         symptom.
 *   3. an assertion that the mutation does NOT touch added to a case's `red`
 *      -> `!! expected RED, got PASS`, exit 1, `NOT RED: M13`.
 *   4. a control added to M2 that the mutation TRUNCATES away
 *      -> `!! expected PASS, got DID NOT RUN`, exit 1. A control checked as
 *         "absent from the reds" would have passed here, silently, which is why
 *         `green` is checked as a PASS.
 *   5. `checkArmCode` broken BEFORE the battery started, so the `ui` suite is
 *      already red
 *      -> `baseline ... NOT GREEN  115 passed, 9 failed`, exit 2, nothing run.
 *         Against an already-red suite every case below would "go red" while
 *         measuring nothing -- AGENTS.md's second way a gate fails.
 *
 * IT WRITES TO THE WORKING TREE AND PUTS IT BACK. Each case is applied, run and
 * reverted one at a time; the revert also runs on a throw, on SIGINT and on
 * SIGTERM. Run it on a clean tree — `git status --porcelain` before and after —
 * and never concurrently with a gate in the same checkout, because it is
 * deliberately editing the files that gate is reading.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CUT_AGAINST = '5993d32';

/**
 * The suites, and what each one calls a red.
 *
 * `test.js` prints `  \x1b[31mFAIL\x1b[0m <name>` on stdout; `selftest.mjs` and
 * `unit-check.mjs` print `FAIL <name>` on stderr. Both shapes reduce to the same
 * line once the colour is stripped, so there is one classifier and not three.
 */
const SUITES = {
  host:        { argv: ['test.js', 'host'],                        label: 'node test.js host' },
  verifyModel: { argv: ['test.js', 'verifyModel'],                 label: 'node test.js verifyModel' },
  ui:          { argv: ['extension/ui/dev/selftest.mjs'],          label: 'node extension/ui/dev/selftest.mjs' },
  unitCheck:   { argv: ['tools/unit-check.mjs'],                   label: 'node tools/unit-check.mjs' },
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
 *   what    the mutation, in the words PR #46 used for it
 *   suite   which of the four instruments above reports it — see the header
 *   cut     the revision these anchors were cut against
 *   edits   [{ file, find, replace }] — `find` must occur EXACTLY ONCE
 *   red     assertion-name substrings that MUST come back FAIL
 *   green   assertion-name substrings that MUST come back PASS — the controls.
 *           Checked as a pass and never as "not red", because a mutation that
 *           truncates the suite leaves its later assertions neither.
 */
const MUTATIONS = [
  // ---------------------------------------------------------------- #30, the guard
  {
    id: 'M1', suite: 'host', cut: CUT_AGAINST,
    what: 'ui/host.js reads a platform bridge at module scope (a hole that throws at import)',
    edits: [{
      file: 'extension/ui/host.js',
      find: 'const ME = BUS.deck;',
      replace: 'const ME = BUS.deck;\nconst BRIDGE = globalThis.stemworkbench.transport;  // U8/M1 mutation',
    }],
    red: [
      'THE HOLE AT extension/ui/host.js IMPORTS INERTLY',
      'group(host) REACHED ITS LAST ASSERTION',
    ],
    green: ['THE HOLE AT extension/offscreen/host.js IMPORTS INERTLY'],
  },
  {
    id: 'M2', suite: 'host', cut: CUT_AGAINST,
    what: 'offscreen/host.js reads a platform bridge at module scope',
    edits: [{
      file: 'extension/offscreen/host.js',
      find: 'const ME = BUS.engine;',
      replace: 'const ME = BUS.engine;\nconst BRIDGE = globalThis.stemworkbench.ipc;  // U8/M2 mutation',
    }],
    red: [
      'THE HOLE AT extension/offscreen/host.js IMPORTS INERTLY',
      'group(host) REACHED ITS LAST ASSERTION',
      'THE SHIPPING EngineHost SATISFIES EVERY DECLARED DUTY',
    ],
    /**
     * M2's control CANNOT be the deck half's hole assertion the way M1's is the
     * engine half's: the engine hole throws before the deck half is reached, so
     * that assertion does not run at all and "not red" would say nothing about
     * it. The control is an assertion BEFORE the throw that still passes, which
     * is the whole claim of #30's guard — the report survived and named its
     * cause instead of ending in a stack trace. Measured: 17 passed, 3 failed,
     * 112 of this group's 132 assertions did not run.
     */
    green: ['A HOST THAT CANNOT OPEN A CAPTURE IS REFUSED'],
  },
  {
    id: 'M3', suite: 'host', cut: CUT_AGAINST,
    what: 'ui/host.js imports fine and send() throws on the first duty call — the case only the group guard catches',
    edits: [{
      file: 'extension/ui/host.js',
      find: '  send(msg) {\n    chrome.runtime.sendMessage(msg).catch(() => {});',
      replace: '  send(msg) {\n    throw new Error(\'U8/M3 mutation: this Host touches its platform on the first duty call\');',
    }],
    red: ['group(host) REACHED ITS LAST ASSERTION'],
    green: [
      'THE HOLE AT extension/ui/host.js IMPORTS INERTLY',
      'THE HOLE AT extension/offscreen/host.js IMPORTS INERTLY',
    ],
  },
  // ------------------------------------------------------- #28, the provenance
  {
    id: 'M4', suite: 'host', cut: CUT_AGAINST,
    what: "engine.js words the log line `fromCache ? 'from cache' : 'downloaded'` again — the #28 defect restored",
    edits: [{
      file: 'extension/offscreen/engine.js',
      find: 'log(`weights ${modelSourceWord(source)} + hash verified in ${ms.toFixed(0)}ms`);',
      replace: "log(`weights ${fromCache ? 'from cache' : 'downloaded'} + hash verified in ${ms.toFixed(0)}ms`);",
    }],
    red: ['LOG LINE IS WORDED FROM THE ANNOUNCED SOURCE'],
    green: ['group(host) REACHED ITS LAST ASSERTION'],
  },
  {
    id: 'M5', suite: 'verifyModel', cut: CUT_AGAINST,
    what: 'loadModel stops recording the phase the Host announced',
    edits: [{
      file: 'extension/shared/modelcache.js',
      find: '      if (Object.prototype.hasOwnProperty.call(MODEL_SOURCES, phase)) source = phase;',
      replace: '      if (Object.prototype.hasOwnProperty.call(MODEL_SOURCES, phase)) { /* U8/M5 mutation */ }',
    }],
    red: [
      'ALL THREE PROVENANCE VALUES CROSS THE SEAM',
      'SHIPPED-WITH-THE-HOST case reports',
      'HEAL reports the attempt that SERVED',
    ],
    green: ['A HOST THAT ANNOUNCES NO PHASE IS QUOTED AS NAMING NO SOURCE'],
  },
  {
    id: 'M6', suite: 'verifyModel', cut: CUT_AGAINST,
    what: "MODEL_SOURCES.bundled is worded 'downloaded'",
    edits: [{
      file: 'extension/shared/host.js',
      find: "  bundled: 'already here \u2014 shipped with this Host',",
      replace: "  bundled: 'downloaded',",
    }],
    red: [
      'SHIPPED-WITH-THE-HOST case reports',
      'the three READ differently',
    ],
    green: ['ALL THREE PROVENANCE VALUES CROSS THE SEAM'],
  },
  {
    id: 'M7', suite: 'verifyModel', cut: CUT_AGAINST,
    what: "modelSourceWord falls back to 'downloaded' for an unannounced source — the old guess",
    edits: [{
      file: 'extension/shared/host.js',
      find: '    : `from a source this Host did not name (${JSON.stringify(source)})`;',
      replace: "    : 'downloaded';",
    }],
    red: ['A HOST THAT ANNOUNCES NO PHASE IS QUOTED AS NAMING NO SOURCE'],
    green: ['ALL THREE PROVENANCE VALUES CROSS THE SEAM'],
  },
  {
    id: 'M8', suite: 'verifyModel', cut: CUT_AGAINST,
    what: 'loadModel keeps `source` across attempts — no per-attempt reset',
    edits: [{
      file: 'extension/shared/modelcache.js',
      find: '  for (let attempt = 1; ; attempt++) {\n    source = null;\n',
      replace: '  for (let attempt = 1; ; attempt++) {\n',
    }],
    red: ['it never INHERITS the dropped attempt'],
    green: ['HEAL reports the attempt that SERVED'],
  },
  {
    id: 'M9', suite: 'verifyModel', cut: CUT_AGAINST,
    what: 'two MODEL_SOURCES members carry the same sentence',
    edits: [{
      file: 'extension/shared/host.js',
      find: "  cache: 'from this Host\\u2019s store',",
      replace: "  cache: 'downloaded',",
    }],
    red: ['the three READ differently'],
    green: ['SHIPPED-WITH-THE-HOST case reports'],
  },
  // -------------------------------------------------- #29, the closed vocabulary
  {
    id: 'M10', suite: 'ui', cut: CUT_AGAINST,
    what: 'checkArmCode accepts every code — the state #29 reported',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: "export function checkArmCode(code, where = 'ARM_ERROR') {\n  if (ARM_CODES.has(code)) return null;",
      replace: "export function checkArmCode(code, where = 'ARM_ERROR') {\n  return null;   // U8/M10 mutation\n  // eslint-disable-next-line no-unreachable\n  if (ARM_CODES.has(code)) return null;",
    }],
    red: [
      'an UNKNOWN code is refused rather than accepted in silence',
      'it reaches console.error EXACTLY ONCE',
      'the error NAMES THE OFFENDING VALUE',
      'names the entry point that received it',
      'names THE WHOLE LEGAL SET',
      'says what goes wrong if it is ignored',
    ],
    green: ['a legal code says nothing'],
  },
  {
    id: 'M11', suite: 'ui', cut: CUT_AGAINST,
    what: 'checkArmCode returns the sentence but does not print it',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: '  console.error(msg);\n  return msg;',
      replace: '  return msg;   // U8/M11 mutation: the sentence is returned and never printed',
    }],
    red: [
      'it reaches console.error EXACTLY ONCE',
      'the error NAMES THE OFFENDING VALUE',
      'names the entry point that received it',
      'names THE WHOLE LEGAL SET',
      'says what goes wrong if it is ignored',
    ],
    green: ['an UNKNOWN code is refused rather than accepted in silence'],
  },
  {
    id: 'M12', suite: 'ui', cut: CUT_AGAINST,
    what: 'checkArmCode refuses a legal member (TAB_BUSY)',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: '  if (ARM_CODES.has(code)) return null;',
      replace: "  if (ARM_CODES.has(code) && code !== 'TAB_BUSY') return null;   // U8/M12 mutation",
    }],
    red: [
      'TAB_BUSY is a member of the vocabulary and passes SILENTLY',
      'a legal code says nothing',
    ],
    green: ['NO_ACTIVE_TAB is a member of the vocabulary and passes SILENTLY'],
  },
  {
    id: 'M12b', suite: 'ui', cut: CUT_AGAINST,
    what: 'checkArmCode refuses a legal member (NO_ACTIVE_TAB) — the same shape one member over',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: '  if (ARM_CODES.has(code)) return null;',
      replace: "  if (ARM_CODES.has(code) && code !== 'NO_ACTIVE_TAB') return null;   // U8/M12b mutation",
    }],
    red: [
      'NO_ACTIVE_TAB is a member of the vocabulary and passes SILENTLY',
      'a legal code says nothing',
    ],
    green: ['TAB_BUSY is a member of the vocabulary and passes SILENTLY'],
  },
  {
    id: 'M13', suite: 'ui', cut: CUT_AGAINST,
    what: 'the error names the offender but not the legal set',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: "${[...ARM_CODES].join(', ')}",
      replace: 'the set this deck knows',
    }],
    red: ['names THE WHOLE LEGAL SET'],
    green: [
      'the error NAMES THE OFFENDING VALUE',
      'names the entry point that received it',
      'says what goes wrong if it is ignored',
    ],
  },
  {
    id: 'M14', suite: 'ui', cut: CUT_AGAINST,
    what: 'the error names the legal set but not the offender',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: '${where}: code ${JSON.stringify(code)} is not one of the',
      replace: '${where}: that code is not one of the',
    }],
    red: ['the error NAMES THE OFFENDING VALUE'],
    green: [
      'names THE WHOLE LEGAL SET',
      'names the entry point that received it',
    ],
  },
  {
    id: 'M15', suite: 'ui', cut: CUT_AGAINST,
    what: 'the error does not name the entry point that received the code',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: '  const msg = `${where}: code ${JSON.stringify(code)}',
      replace: '  const msg = `an arm refusal: code ${JSON.stringify(code)}',
    }],
    red: ['names the entry point that received it'],
    green: [
      'the error NAMES THE OFFENDING VALUE',
      'names THE WHOLE LEGAL SET',
    ],
  },
  {
    id: 'M16', suite: 'ui', cut: CUT_AGAINST,
    what: 'the error no longer says what an unknown code costs',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: 'An unknown code paints a banner the user CANNOT DISMISS, with a Restart `\n'
        + "    + 'control that cannot fix it. Pick a member of that set, or add one upstream.';",
      replace: 'Pick a member of that set, or add one upstream.`;',
    }],
    red: ['says what goes wrong if it is ignored'],
    green: [
      'the error NAMES THE OFFENDING VALUE',
      'names THE WHOLE LEGAL SET',
    ],
  },
  {
    id: 'M17', suite: 'ui', cut: CUT_AGAINST,
    what: 'embed.js drops the check on the live ARM_ERROR — one entry point of two',
    edits: [{
      file: 'extension/ui/embed.js',
      find: "      checkArmCode(err.code, 'ARM_ERROR from the Host');",
      replace: '      // U8/M17 mutation: the live ARM_ERROR entry point no longer checks the code',
    }],
    red: ['calls checkArmCode() on BOTH entry points'],
    green: ["takes it from the unit's own audio-math.js"],
  },
  {
    id: 'M18', suite: 'ui', cut: CUT_AGAINST,
    what: "embed.js keeps its own checkArmCode instead of importing the unit's",
    edits: [
      {
        file: 'extension/ui/embed.js',
        find: '  behindText, bufState, errorSummary, errorAction, ARM_CODES, checkArmCode, armErrorFresh,',
        replace: '  behindText, bufState, errorSummary, errorAction, ARM_CODES, armErrorFresh,',
      },
      {
        file: 'extension/ui/embed.js',
        find: "import { ARM_ERROR_KEY, ARM_ERROR_TTL_MS, MODEL, PREFS_KEY, SR } from '../shared/config.js';",
        replace: "import { ARM_ERROR_KEY, ARM_ERROR_TTL_MS, MODEL, PREFS_KEY, SR } from '../shared/config.js';\n"
          + '// U8/M18 mutation: a second copy of the vocabulary, kept here instead of taken from the unit.\n'
          + '// Written as an arrow so the two call sites below are still the only `checkArmCode(` matches.\n'
          + 'const checkArmCode = (code, where) => null;',
      },
    ],
    red: ["takes it from the unit's own audio-math.js"],
    green: ['calls checkArmCode() on BOTH entry points'],
  },
  {
    id: 'M19', suite: 'ui', cut: CUT_AGAINST,
    what: 'checkArmCode refuses every member',
    edits: [{
      file: 'extension/ui/audio-math.js',
      find: '  if (ARM_CODES.has(code)) return null;',
      replace: '  if (false) return null;   // U8/M19 mutation: every member is refused',
    }],
    red: [
      'NOT_CAPTURING is a member of the vocabulary and passes SILENTLY',
      'NOT_ARMED is a member of the vocabulary and passes SILENTLY',
      'NEEDS_GESTURE is a member of the vocabulary and passes SILENTLY',
      'TAB_GONE is a member of the vocabulary and passes SILENTLY',
      'TAB_BUSY is a member of the vocabulary and passes SILENTLY',
      'TAB_UNSUPPORTED is a member of the vocabulary and passes SILENTLY',
      'ARM_FAILED is a member of the vocabulary and passes SILENTLY',
      'NO_ACTIVE_TAB is a member of the vocabulary and passes SILENTLY',
      'a legal code says nothing',
    ],
    green: ['an UNKNOWN code is refused rather than accepted in silence'],
  },
  // ------------------------------------------- the read-position red, PR #46 prose
  {
    id: 'M20', suite: 'unitCheck', cut: CUT_AGAINST,
    what: "the hole's import() literal becomes a variable — the read leaves read position",
    edits: [{
      file: 'test.js',
      find: "  const engineHost = await importHole('extension/offscreen/host.js',\n"
        + "    () => import('./extension/offscreen/host.js'));",
      replace: '  const enginePath = [\'.\', \'extension\', \'offscreen\', \'host.js\'].join(\'/\');  // U8/M20 mutation\n'
        + "  const engineHost = await importHole('extension/offscreen/host.js',\n"
        + '    () => import(enginePath));',
    }],
    red: ['every one of them is really read by the suite that declares it'],
    green: ['no suite reads across the seam without declaring it'],
  },
];

// ---------------------------------------------------------------- the runner
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node tools/mutations/u8-seam-fixes.mjs [--table] [M1 M2 …]');
  process.exit(0);
}
if (argv.includes('--table')) {
  console.log(`U8 mutation battery — anchors cut against ${CUT_AGAINST}\n`);
  for (const m of MUTATIONS) {
    console.log(`${m.id.padEnd(5)} ${SUITES[m.suite].label.padEnd(38)} ${m.what}`);
    for (const r of m.red) console.log(`${''.padEnd(5)} ${'RED'.padEnd(38)} ${r}`);
    for (const g of m.green) console.log(`${''.padEnd(5)} ${'green (control)'.padEnd(38)} ${g}`);
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

console.log(`U8 mutation battery — anchors cut against ${CUT_AGAINST}; HEAD is ${head}`);
console.log(`${cases.length} case(s), ${new Set(cases.map((c) => c.suite)).size} suite(s)\n`);

/**
 * THE CONTROL FOR THE WHOLE BATTERY. A red is only evidence if the suite was
 * green before the mutation: against an already-red suite every case below
 * would "go red" while measuring nothing. Run once per suite, up front, and
 * refuse to run the battery at all if any of them is not green — a battery
 * whose baseline is red manufactures reds, which is the second of AGENTS.md's
 * three ways a gate fails.
 */
const baseline = {};
for (const key of new Set(cases.map((c) => c.suite))) {
  const r = runSuite(key);
  baseline[key] = r;
  const verdict = r.code === 0 && r.reds.length === 0 ? 'GREEN' : 'NOT GREEN';
  console.log(`  baseline  ${SUITES[key].label.padEnd(38)} ${verdict}  `
    + `${r.greens.length} passed, ${r.reds.length} failed, exit ${r.code}`);
  if (verdict !== 'GREEN') {
    console.error('\nthe baseline is not green, so no red below would be evidence. Fix the tree first.');
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
     * decayed anchor — the line it patched has been rewritten by a later slice.
     * More than one is an ambiguous anchor, which is the same defect wearing the
     * opposite symptom: the case would patch a site it was not cut for.
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
      // A replacer FUNCTION, not a replacement string: `$&`, `$'` and friends are
      // substitution syntax, and several of these replacements are template literals.
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
console.log(`anchors   : ${results.length - decayed.length} of ${results.length} still match ${CUT_AGAINST}'s source`);
console.log(`mutations : ${results.length - decayed.length - missed.length} of ${results.length - decayed.length} matching anchors still RED as specified`);
if (decayed.length) console.log(`DECAYED   : ${decayed.map((x) => x.id).join(', ')} — re-cut these; they are instruments, not findings`);
if (missed.length) console.log(`NOT RED   : ${missed.map((x) => x.id).join(', ')} — decayed instrument OR a real coverage loss; investigate before re-cutting`);
process.exit(decayed.length || missed.length ? 1 : 0);
