/**
 * One command, one verdict.
 *
 *   node tools/verify.mjs                 # every suite below, browsers included
 *   node tools/verify.mjs --quick         # everything that needs neither a browser
 *                                         #   nor the 114 MB weights
 *   node tools/verify.mjs --unit          # only the suites extension/unit.json declares
 *                                         #   over the vendored unit (ADR 0001 decision 3)
 *   node tools/verify.mjs --audible       # ...plus the DAC loopback probe (BlackHole + ffmpeg)
 *   node tools/verify.mjs --strict        # a KNOWN-FLAKY e2e assertion turns the run red
 *   node tools/verify.mjs --only e2e      # run one step by name
 *   node tools/verify.mjs --self-check    # test the flake classifier itself, no browser
 *   node tools/verify.mjs --live-fixture <wav>   # the six-stem QUALITY fixture
 *   node tools/verify.mjs --soak-fixture <wav>   # the long one, for e2e's live block
 *   node tools/verify.mjs --no-reap       # do NOT kill other Playwright Chromiums first
 *                                         #   (use when a colleague is mid-run; see
 *                                         #    reapOrphanBrowsers())
 *
 * Owned by Release Engineering. It does not contain any product logic; it runs
 * the suites the people who own the product wrote, in a fixed order, and prints
 * one summary at the end. Every child's stdout is streamed AND tee'd to
 * `out/verify/<step>.log`.
 *
 * ---------------------------------------------------------------------------
 * Two things it knows that a bare `&&` chain does not
 * ---------------------------------------------------------------------------
 *
 * 1. `tools/run-ext.mjs` needs a live fixture and its built-in default
 *    (`spike/audio/mix_full.wav`) is NOT in the repo — `spike/audio/` is
 *    .gitignored and the file arrives via `spike/fetch_audio.sh`. On a fresh
 *    clone the flag is mandatory. This script checks the fixture (and the model
 *    seed) exist BEFORE launching a browser, and says exactly which command to
 *    run if they do not, instead of failing eight minutes in.
 *
 * 2. One block of `run-ext.mjs` is genuinely flaky and it is understood why.
 *    `AGENTS.md`: inference time OSCILLATES with a period longer than 180 s
 *    (753 <-> 1002 ms at hop 1.0, no trend). The harness' hop-1.0 backpressure
 *    section runs for 35 s, so it samples ONE phase of that cycle: on the fast
 *    phase the ladder barely fires, on the slow phase it fires constantly and
 *    the timing-derived assertions in that block can miss. Same build, same
 *    machine, ~1 run in 2. Those specific assertions — and only those — are
 *    reported as FLAKY-KNOWN and do not turn the run red. Everything else,
 *    including every other assertion in the same file, is a hard failure.
 *
 * The excuse list is deliberately narrow, is printed in full whenever it fires,
 * and is scoped to the hop-1.0 section by its section header. A new assertion
 * added to that block is a hard failure until someone adds it here on purpose.
 *
 * ---------------------------------------------------------------------------
 * 3. A SUITE THAT NOTHING RUNS IS NOT A SUITE (added 2026-08-15)
 * ---------------------------------------------------------------------------
 *
 * For one batch this file ran four steps while SIX self-checked suites existed
 * in the tree — `extension/engine/pitch.js`, `extension/engine/chroma.js`,
 * `embed/autonav.js`, `embed/ui/embed-state.js`, `tools/build-embed.mjs` and
 * `tools/embed-smoke.mjs`. Every one of them exits non-zero on failure and
 * every one of them was invisible to `node tools/verify.mjs`. `AGENTS.md`
 * called embed-smoke "its gate" while the gate never invoked it.
 *
 * That is the VOID rule at the level of the RUNNER: a suite nobody runs
 * reports green for exactly the same reason an empty stdout does. It is also
 * worse than a red, because a red gets investigated. They are all in `steps`
 * now; the four pure ones and the build are in `--quick` because together they
 * cost about eight seconds, and `embed-smoke` sits with `e2e` because it drives
 * a real Chromium.
 *
 * The cost of admitting them was in the two parsers below, not in the plan:
 * three of the six print neither `N passed, M failed` nor `all checks passed`,
 * so on the first attempt they came out VOID — the runner correctly refusing to
 * call an unrecognised summary a pass. `ASSERTED` and `summarise()` learned
 * their shapes, and `--self-check` now pins each shape so a suite changing its
 * summary line cannot quietly become a VOID again.
 *
 * IT HAPPENED AGAIN THE SAME DAY, which is why this note is a standing rule and
 * not an incident report. The engine integration landed
 * `extension/engine/pitchbank.js` (24 checks) and `extension/engine/keytap.js`
 * (19), both self-checked, both exiting non-zero on failure, both run by
 * nothing. **The gap between a suite being written and a suite being gated is
 * measured in hours here, and nobody notices from the inside** — the author ran
 * theirs by hand and it was green. Add the step in the same commit as the file.
 *
 * Their summary shapes were checked BY RUNNING THEM, not by reading the regex:
 * both print `all N <word> checks passed`, both were recognised first time, and
 * both are now pinned in `--self-check`. The check was still worth doing — the
 * previous three suites all looked fine on inspection too.
 *
 * AND AGAIN, ON THE 6-STEM BRANCH (2026-08-16). `qa/**` was invisible to this
 * file in its ENTIRETY: not one of `qa/test-edge.mjs` (32 checks),
 * `qa/passthrough-gain.mjs` (16) or `qa/live-wire.mjs`'s abort-path self-check
 * (5) had ever been run by the gate, and neither had `tools/model-parity.mjs`
 * (22) — the only thing in the tree that checks the pinned weights really do
 * carry six sources in the order `shared/config.js` claims. 75 assertions,
 * three of the four costing under a second, all of them able to see a 6-stem
 * break, none of them reachable from `node tools/verify.mjs`. They are steps
 * now.
 *
 * WHAT IS STILL NOT GATED, AND WHY — stated here rather than left as an
 * absence, because an unlisted suite is indistinguishable from a suite nobody
 * knew about, which is the whole subject of this note:
 *
 *   qa/mutations-u1-wavstream.mjs
 *       A MUTATION BATTERY, and it is not gated because it EDITS TRACKED SOURCE.
 *       It patches extension/shared/wav.js fifteen times, runs
 *       `node test.js wavstream` after each, and restores the file in a
 *       `finally`. A gate that writes the tree it is gating is a gate that can
 *       leave the tree written — an interrupted step would hand the next agent a
 *       dirty wav.js and no explanation — so it stays a thing a person runs, not
 *       a step. It IS a real instrument: it refuses to score anything unless the
 *       unmutated suite is green first, it compares each mutation's red set
 *       EXACTLY rather than as a subset, and `--self-check` proves it can still
 *       report MUTE by applying an edit that changes only a comment. Its subject
 *       is the eighteen assertions in group('wavstream'), which step `unit`
 *       already runs; what the battery adds is the evidence that those eighteen
 *       can fail, which no count can carry.
 *   qa/run-qa.mjs, qa/soak.mjs, qa/probe.mjs, qa/probe-msg.mjs
 *       REPORT GENERATORS, not gates. They print notes and write JSON; they
 *       contain no PASS/FAIL assertion at all, so this runner would correctly
 *       call every one of them VOID. Making them gateable means giving them
 *       assertions, which is a change to what they ARE.
 *   tools/hop-probe.mjs, tools/mem-probe.mjs
 *       DISTRIBUTION MEASUREMENTS. `AGENTS.md`: never a median from a soak
 *       shorter than ~300 s, and hop-probe's default is 3 x 300 s. They also
 *       need an exclusive machine (see reapOrphanBrowsers() below), which a
 *       gate someone runs while working cannot promise. Shortening them to fit
 *       would produce exactly the one-phase sample the §7 rule exists to ban.
 *   tools/order-probe.mjs, tools/audible-probe.mjs
 *       Need macOS + BlackHole + ffmpeg AND change the system default output
 *       device while they run. `audible` is already here behind `--audible`;
 *       order-probe is the same rig plus a real `chrome.commands` invocation.
 *   docs/snippets/make-testbed.js --check
 *       A REAL GATE AND A REAL GAP, listed rather than added because the person
 *       who found it was registering a different suite. It is hermetic, needs no
 *       browser and no fixture, prints `all checks passed` / `N FAILED` and
 *       exits non-zero — a shape `summarise()` already knows. It only runs its
 *       assertions behind `--check`; bare, it WRITES WAV FILES, so the step is
 *       `['docs/snippets/make-testbed.js', '--check']` and getting that wrong
 *       makes a generator look like a suite. Two steps already depend on this
 *       file being right — `ground-truth` rebuilds `qa/testbed-smoke/` from it
 *       and `estimator-ground` derives its whole ground truth from it — so a
 *       break in it surfaces as a confusing red in one of those instead of a
 *       clear one here. Whoever owns `docs/snippets/` should add it.
 *   docs/snippets/bss-eval.js
 *       Takes `<truthDir> <estDir>` and exits 2 without them: it SCORES a
 *       separation that already exists on disk. Nothing in the repo produces
 *       those directories, so it is a measurement tool, not a gate. Its
 *       reference implementations ARE gated — that is what `snippets` runs.
 *   qa/live-solo.mjs (its re-scoring entry point, added 2026-08-16)
 *       `node qa/live-solo.mjs <qa/out/live-solo.json>` re-scores a RECORDED
 *       run and exits 2 with a usage line when handed no artifact, so it cannot
 *       be a standalone step. NOTE FOR classify()'s comment below, which still
 *       calls live-solo a bare module that "exits 0 and prints nothing": that
 *       stopped being true this session. The claim it stands on — that some
 *       qa/live-*.mjs are silent modules — is still true of live-boot,
 *       live-edge, live-feel and live-soak.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL_URL, MODEL_BYTES, MODEL_SEED_REL, modelSeed,
 } from './host.mjs';
// Labels only — this file still contains no product logic. It is here because a
// step TITLE that names a stale constant is read as fact, and one did.
import { RING_PLANES } from '../extension/shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'verify');
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const flag = (k) => argv.includes('--' + k);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

const QUICK = flag('quick');
const STRICT = flag('strict');
const ONLY = arg('only', null);
const UNIT = flag('unit');

/**
 * `--unit` — the plan that verifies the VENDORED UNIT, read out of the unit's
 * own declaration and not re-typed here.
 *
 * ADR 0001 decision 3 copies the engine and the deck into a second product;
 * decision 4 puts them behind a Host seam. `extension/unit.json` is the
 * declaration of that boundary and `tools/unit-check.mjs` is its gate. What was
 * missing until #11 is the other half: the suites that say the copy WORKS.
 * `unit.json` now names them with their step ids, and this is where that list
 * becomes a plan.
 *
 * READ, NOT RE-TYPED, for the reason the note at `RING_PLANES` above gives about
 * a stale constant in a step title, and the one `tools/host.mjs` gives about the
 * model pin: a second copy of a list is a list that drifts, and this one drifts
 * SILENTLY — a `--unit` run over eight of eleven suites prints exactly the same
 * green as a run over eleven. `--self-check` asserts the plan this builds is the
 * manifest's list, in both directions; `unit-check` asserts the same agreement
 * from the manifest's side, in CI, where `--self-check` does not run.
 *
 * This file still contains no product logic. The manifest is a plan, not a fact
 * about audio.
 */
let UNIT_DECL = {};
try {
  UNIT_DECL = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'unit.json'), 'utf8'));
} catch (e) {
  // NOT AN EXCUSE — THE OPPOSITE. An unreadable manifest is a real defect and
  // `tools/unit-check.mjs` is the step that diagnoses it, in one line, by name.
  // Parsing it at module scope means an unguarded throw here kills EVERY verify
  // command, including the one that would have said why: `--quick` would die on
  // a JSON trace instead of running the gate. So the runner survives, says so,
  // and hands the question to the gate — while `--unit` exits 2 on an empty
  // plan and `--self-check` goes red on `UNIT_IDS.length > 0`. Nothing here can
  // report green over it.
  // Uncoloured on purpose: `C` is declared below this line, and a palette is
  // not worth an ordering dependency in the one path that reports a broken file.
  console.error(`verify: extension/unit.json is unreadable — ${e.message}`);
  console.error('  --unit cannot build a plan. Run --only unit-check for the diagnosis.');
}
const UNIT_IDS = (UNIT_DECL.suites || []).map((s) => s.step);
/** The one expression that selects the unit's plan. Two callers: the plan filter below, and `--self-check`. */
const unitPlan = (all) => all.filter((s) => UNIT_IDS.includes(s.id));
// The seed path and the pinned byte count both come from shared/config.js via
// tools/host.mjs — see the note at its MODEL_URL. This file carried the 4-stem
// filename in TWO places (the default and the "how to fetch it" hint) and both
// were wrong on the day the model was re-pinned.
const SEED = path.resolve(String(arg('seed', modelSeed(ROOT))));
/**
 * TWO FIXTURES, because the steps below ask two different questions.
 *
 * `--live-fixture` (QUALITY, `clip6_mix.wav`, 30 s) feeds `qa-wire`, `qa-feel`
 * and `qa-solo`, every one of which makes a PER-STEM claim. All six stems are
 * present across the whole clip.
 *
 * `--soak-fixture` (`mix6_full.wav`, 220.9 s) feeds `e2e`, whose live block is a
 * 75 s duration measurement.
 *
 * They were ONE default, `mix_full.wav`, and it was the wrong answer to both:
 * that track has no bass in its first 31 s and leaves `other` and `piano` dead
 * across the whole song through htdemucs_6s, so the per-stem suites were gating
 * three of six stems on passages that contained none.
 */
/**
 * mashup-probe keeps its OWN pair, and deliberately not the six-stem fixture —
 * every assertion in it is a gain vector or a sum null, and deck A contributes
 * vocals and nothing else, so it needs the track with the strongest vocals
 * rather than the one with the most stems. The argument is at that file's
 * FIX_A. Passed explicitly so this runner's preflight can name them.
 */

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * Proof that a suite actually ran assertions. Matches every summary line our
 * suites emit; deliberately does NOT match an empty stdout.
 *
 * EVERY COUNT IN HERE IS `[1-9]\d*`, NOT `\d+`, and that is deliberate.
 * "0 passed, 0 failed" and "0 checks passed" are the VOID case wearing a
 * summary line: a suite that walked its whole file and asserted nothing prints
 * one of those and exits 0. The old `\d+` accepted both. A count of nothing is
 * still nothing. (It only ever matters on exit 0 — see classify().)
 *
 * The shapes, and who prints them (2026-08-15):
 *   N passed, M failed        test.js, extension/engine/pitch.js, run-ext.mjs
 *   all checks passed         extension/ui/dev/selftest.mjs, embed/autonav.js,
 *                             embed/ui/embed-state.js — the last two prefix it
 *                             with their own name, so this stays unanchored
 *   all N <word> checks passed / N checks passed
 *                             extension/engine/chroma.js, tools/build-embed.mjs,
 *                             extension/engine/pitchbank.js, .../keytap.js
 *   N/N passed                tools/embed-smoke.mjs
 *   all audible               tools/audible-probe.mjs
 *   a per-check line          all of the above EXCEPT build-embed, which prints
 *                             only a total — which is why the total shapes had
 *                             to be recognised and not just the per-line one.
 */
// `^\s*(?:[\w-]+:\s*)?(?:all\s+)?` — a summary line, optionally prefixed by the
// suite's own name ("embed-state: ...") and/or the word "all". Anchored so a
// number sitting in the middle of an assertion's PROSE cannot vouch for a run.
const SUM = String.raw`^\s*(?:[\w-]+:\s*)?(?:all\s+)?`;
const ASSERTED = new RegExp([
  SUM + String.raw`[1-9]\d*\s+passed,\s+\d+\s+failed`,
  SUM + String.raw`[1-9]\d*\s*/\s*\d+\s+passed`,
  SUM + String.raw`[1-9]\d*\s+(?:[\w-]+\s+)?checks?\s+passed`,
  String.raw`all checks passed`,
  String.raw`all audible`,
  String.raw`^\s*(?:PASS|ok|✓)\s`,
].join('|'), 'm');

// --------------------------------------------------------------- known flakes
// Scoped by BOTH the section header it lives under and the assertion text.
// Widening either half needs evidence in `AGENTS.md`, not a hunch.
const FLAKY = {
  file: 'tools/run-ext.mjs',
  section: /backpressure ladder, hop 1\.0/i,
  why: 'This block soaks 35 s at hop 1.0 against a 1000 ms deadline, on a COLD deck. '
     + 'Run-to-run variance plus warm-up drift is enough to move these timing-derived '
     + 'assertions across the line; the same build passes and fails. Re-run, or use '
     + 'tools/hop-probe.mjs (300 s) to measure the distribution instead of one sample of it. '
     + 'NOTE (2026-08-09): the ORIGINAL justification here was the ">180 s oscillation, '
     + '45 % of chunks miss at hop 1.0" story, and that is RETRACTED — quiet-machine soaks '
     + 'put hop 1.0 at 0.7-2.3 % over deadline with zero underruns. The '
     + 'assertions are still timing-derived and a 35 s cold sample is still a bad estimator, '
     + 'so the carve-out stands — but it now rests on a weaker argument than it used to. '
     + 'If one of these fails REPEATEDLY, treat it as a real regression, not a flake.',
  // NARROWED 2026-08-09. `latencySec tracks the hop` was in this list and has been
  // REMOVED: it failed on two consecutive runs with near-identical values (3.368 s
  // then 3.345 s against a 2.27 s budget, i.e. ~1.1 s over both times, and within
  // 0.26 s of the hop-1.95 figure it is supposed to be ~1 s below). A coin flip
  // does not land on the same number twice. It is a real, reproducible finding and
  // it is filed. Excusing it would have hidden it, which is
  // exactly the failure this whole carve-out is one bad decision away from.
  assertions: [
    /never emits silence/i,
    /no playback underruns/i,
    /produces AUDIO \(not a silent run\)/i,
    /^no chunk failed$/i,
    /passthrough transitions do not click/i,
  ],
};

// ------------------------------------------------------------ coverage drift
/**
 * N/N IS NOT A COMPARABLE CLAIM UNLESS N IS STABLE.
 *
 * Measured 2026-08-09: three consecutive `run-ext.mjs` runs on one unchanged
 * tree reported 159, 161 and 167 assertions. The 6-assertion gap was a single
 * block ("...and the AUDIO THREAD holds those values") that executed 6 times in
 * one run and ZERO times in the next. Nothing in the output said so — the
 * summary counts what ran, so a run that silently skipped a block reports a
 * smaller, greener number.
 *
 * That is the "silence is not a pass" problem one level up: an ABSENT assertion
 * reads as green. Three changes have been reported as "N/N" and compared to
 * each other as if N meant the same thing.
 *
 * So: remember the assertion names from the last run and say what changed.
 * Names, not just the count — a block that vanishes matters, and two blocks
 * that swap cancel out in a count.
 *
 * THREE WAYS COVERAGE LIES, AND THIS INSTRUMENT CATCHES ONE AND A HALF.
 * Own the limits, because an instrument oversold is the thing this whole
 * thread has been about.
 *
 *   failure mode          count?  names?  count-diff      name-diff
 *   --------------------  ------  ------  --------------  ---------------------
 *   ABSENT (never ran)    moves   moves   detects         detects AND says which
 *   VACUOUS (ran, but     same    same    BLIND           BLIND
 *     checked nothing)
 *   ALTERNATING NAME      same    moves   BLIND           FALSE POSITIVE, forever
 *     (one check, two
 *      names by branch)
 *
 * Only ABSENT is fully caught. VACUOUS is invisible to any denominator — it is
 * caught by reading the assertion, and by the rule in AGENTS.md that an
 * assertion must fail when it cannot look. ALTERNATING is worse than invisible:
 * this instrument would report "stopped running / started running" on every
 * single run, for correct code, until someone stopped believing it.
 *
 * That last row is a false-positive mode THIS FILE INTRODUCED. It was caught by
 * the engine owner before it ever fired, when their two A4 branches initially
 * carried two different assertion names — they collapsed them to one name with
 * the branch in the detail string. The fix belongs on the assertion side: one
 * check, one name, branch in the detail. If you add a branch to an assertion,
 * do not add a name.
 */
const COVERAGE = path.join(OUT, 'coverage.json');

/**
 * WIDENED 2026-08-15 to the `ok`-style suites. It used to require exactly two
 * leading spaces and the literal word PASS/FAIL, which is `test.js`,
 * `pitch.js` and `run-ext.mjs` and nothing else — so `ui`, `chroma`, `autonav`,
 * `embed-state` and `embed-smoke` had NO absent-assertion detection at all.
 *
 * The names it produces for the PASS-style suites are byte-identical to what
 * the old expression produced (checked against the recorded `e2e` and `unit`
 * baselines before shipping) — a change that rewrote them would have reported
 * every assertion in both suites as gone-and-replaced on the next run, which is
 * the false positive this whole instrument is one bad regex away from.
 *
 * KNOWN LIMIT, stated because the block above states the other two: some
 * `embed-smoke` assertion texts carry a MEASURED value ("the frame grows
 * (360 -> 560 px)"). Those names are not stable run to run. The drift report
 * only prints when the COUNT moves, so this is silent in the normal case — but
 * when embed-smoke's count does move, expect noise in its gone/added lists.
 * The fix belongs on the assertion side: the number goes in the detail, after
 * two spaces, not in the name.
 */
function assertionNames(out) {
  return strip(out).split('\n')
    .map((l) => (l.match(/^\s{0,3}(?:PASS|FAIL|ok)\s+(.*)$/) || [])[1])
    .filter(Boolean)
    .map((s) => s.split('  ')[0].trim())
    .filter(Boolean);
}

function coverageDrift(res) {
  const names = assertionNames(res.out);
  if (!names.length) return null;
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(COVERAGE, 'utf8'))[res.id] || null; } catch { /* first run */ }
  let all = {};
  try { all = JSON.parse(fs.readFileSync(COVERAGE, 'utf8')); } catch { /* first run */ }
  all[res.id] = { n: names.length, names, when: new Date().toISOString() };
  try { fs.writeFileSync(COVERAGE, JSON.stringify(all, null, 1)); } catch { /* best effort */ }
  if (!prev || prev.n === names.length) return null;

  const count = (a) => a.reduce((m, k) => (m[k] = (m[k] || 0) + 1, m), {});
  const now = count(names), was = count(prev.names);
  const gone = Object.keys(was).filter((k) => (now[k] || 0) < was[k]);
  const added = Object.keys(now).filter((k) => (was[k] || 0) < now[k]);
  return { from: prev.n, to: names.length, gone, added, when: prev.when };
}

// -------------------------------------------------------------------- runner
function run(step) {
  return new Promise((resolve) => {
    const started = Date.now();
    const logPath = path.join(OUT, `${step.id}.log`);
    const log = fs.createWriteStream(logPath);
    let buf = '';
    console.log(`\n${C.b}=== ${step.id} ===${C.x} ${C.d}node ${step.args.join(' ')}${C.x}`);
    const child = spawn(process.execPath, step.args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const sink = (chunk) => { const s = chunk.toString(); buf += s; log.write(s); process.stdout.write(s); };
    child.stdout.on('data', sink);
    child.stderr.on('data', sink);
    child.on('error', (e) => {
      buf += `\nspawn error: ${e.message}\n`;
      resolve({ ...step, code: 127, out: buf, ms: Date.now() - started, logPath });
    });
    child.on('close', (code) => {
      log.end();
      resolve({ ...step, code, out: buf, ms: Date.now() - started, logPath });
    });
  });
}

// Pull the FAIL lines out of a run-ext.mjs transcript, tagged with the bold
// section header they appeared under. Reads the console rather than out/e2e.json
// because the section headers only exist in the console.
function failuresWithSections(out) {
  const lines = strip(out).split('\n');
  const raw = out.split('\n');
  let section = '(preamble)';
  const fails = [];
  for (let i = 0; i < lines.length; i++) {
    const plain = lines[i];
    // Section headers are printed bold with no leading whitespace.
    if (/^\x1b\[1m/.test(raw[i]) && !/^\s/.test(plain) && plain.trim()) section = plain.trim();
    const m = plain.match(/^\s*FAIL\s+(.*)$/);
    if (m) {
      // `name  detail` — the harness joins them with two spaces.
      const [name] = m[1].split('  ');
      fails.push({ section, name: name.trim(), line: plain.trim() });
    }
  }
  return fails;
}

function classify(res) {
  // Suites that print SKIPPED and exit 0 are a skip, not a pass.
  if (/\bSKIPPED\b/.test(strip(res.out)) && res.code === 0) {
    const why = (strip(res.out).match(/SKIPPED\s*—\s*([^\n]*)/) || [, ''])[1];
    return { verdict: 'SKIP', detail: why.trim(), flaky: [], hard: [] };
  }
  // A suite that exits 0 having asserted NOTHING is not a pass. qa/live-*.mjs are
  // modules for qa/run-qa.mjs with no top-level execution — `node qa/live-boot.mjs`
  // exits 0 and prints nothing, and `node qa/live-boot.mjs && echo pass` prints
  // "pass". Any runner that reports silence as success will eventually be pointed
  // at one of them. Demand evidence, not the absence of an error.
  //
  // The example was `qa/live-wire.mjs` until 2026-08-15; QA gave that file a
  // browser-free abort-path self-check and it now prints `5 passed, 0 failed`, so
  // the sentence describing it had become false. Re-checked by running all seven:
  // live-boot, live-edge, live-feel, live-soak and live-solo are still bare
  // modules (exit 0, zero bytes); live-qa is the runner and exits 2 with a usage
  // line. None of them is in `steps`, so nothing here breaks either way — but a
  // comment the tree contradicts is the defect this whole file is about.
  if (res.code === 0 && !ASSERTED.test(strip(res.out))) {
    return { verdict: 'NO-OUTPUT', detail: 'exited 0 but asserted nothing — silence is not a pass',
             flaky: [], hard: [{ section: '(runner)', name: 'no assertions produced',
                                 line: lastLines(res.out, 2) || '(no output at all)' }] };
  }
  if (res.code === 0) return { verdict: 'PASS', detail: summarise(res), flaky: [], hard: [] };

  if (res.id !== 'e2e') return { verdict: 'FAIL', detail: summarise(res), flaky: [], hard: failuresWithSections(res.out) };

  const fails = failuresWithSections(res.out);
  const flaky = [], hard = [];
  for (const f of fails) {
    const inSection = FLAKY.section.test(f.section);
    const named = FLAKY.assertions.some((re) => re.test(f.name));
    (inSection && named ? flaky : hard).push(f);
  }
  // A harness crash is never a flake, and it must not hide behind the
  // "N passed, 0 failed" line the harness still prints on its way out.
  const crash = harnessError(res.out);
  if (crash) hard.push({ section: '(harness)', name: 'run-ext.mjs crashed', line: crash });
  else if (!fails.length) hard.push({ section: '(harness)', name: 'exited non-zero with no FAIL line', line: lastLines(res.out, 3) });
  const verdict = hard.length ? 'FAIL' : (STRICT ? 'FAIL' : 'FLAKY-KNOWN');
  return { verdict, detail: summarise(res), flaky, hard };
}

// `harness error` (run-ext.mjs' own catch) or an uncaught node throw. Either way
// the suite did not finish, so its "N passed" line is a floor, not a result.
function harnessError(out) {
  const lines = strip(out).split('\n');
  const i = lines.findIndex((l) => /^harness error/.test(l.trim()));
  if (i >= 0) return lines.slice(i, i + 3).map((l) => l.trim()).filter(Boolean).join(' / ');
  const j = lines.findIndex((l) => /^(\w*Error|Uncaught|node:internal)/.test(l.trim()));
  if (j >= 0) return lines.slice(Math.max(0, j - 1), j + 3).map((l) => l.trim()).filter(Boolean).join(' / ');
  return null;
}

/**
 * The one-line detail next to the verdict. It has to know every summary shape
 * in ASSERTED, because a step whose shape it does not know reports `exit 0` —
 * which is not wrong, but it is the least informative true thing available and
 * it reads like the runner shrugging. `chroma` and `embed-smoke` both did that
 * on the first run after they were added.
 */
function summarise(res) {
  const t = strip(res.out);
  const crash = res.code !== 0 && harnessError(res.out);
  const m = t.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  if (crash) return `CRASHED after ${m ? `${m[1]} checks` : 'start'} — ${crash.slice(0, 140)}`;
  if (m) return `${m[1]} passed, ${m[2]} failed`;
  const slash = t.match(new RegExp(SUM + String.raw`(\d+)\s*/\s*(\d+)\s+passed`, 'm'));      // embed-smoke
  if (slash) return `${slash[1]}/${slash[2]} passed`;
  const counted = t.match(new RegExp(SUM + String.raw`(\d+)\s+(?:[\w-]+\s+)?checks?\s+passed`, 'm')); // chroma, build-embed
  if (counted) return `${counted[1]} checks passed`;
  // `all checks passed` (selftest/autonav/embed-state) and `all tests passed`
  // (docs/snippets/selftest.js) are the same shape under two words. Neither
  // carries a count, so the count comes from the per-check lines.
  if (/all (?:checks|tests) passed/.test(t)) return `${(t.match(/^\s{0,3}ok\s/gm) || []).length} checks passed`;
  if (/all audible/.test(t)) return 'all audible';
  // Failure shapes, in the order the suites print them.
  const f = (t.match(/^\s*\d+\s*\/\s*\d+ FAILED/m)                          // embed-smoke
         || t.match(/^\s*\d+ FAILED/m)                                      // selftest, autonav, embed-state
         || t.match(/^\s*\d+ FAILURE\(S\)(?: of \d+)?/m)                     // chroma; snippets prints it bare
         || [])[0];
  return f ? f.trim() : `exit ${res.code}`;
}

const lastLines = (s, n) => strip(s).trimEnd().split('\n').slice(-n).join(' / ');

// ------------------------------------------------------------------ self-check
// CONTRIBUTING.md: non-trivial logic leaves one runnable check behind. The classifier
// is the only non-trivial thing in this file, and getting it wrong in the
// permissive direction hides a real regression. `node tools/verify.mjs
// --self-check` runs it against a synthetic transcript, no browser, ~0 s.
//
// A FUNCTION RATHER THAN AN `if` BLOCK SINCE #11, AND CALLED FROM ONE PLACE:
// immediately after `steps` is built, ~300 lines below. It has to see `steps` —
// the `--unit` block at the end of it compares the manifest's suite list against
// the plan this runner would actually build from it, and there is no way to make
// that claim without the real array. Everything else about it is unchanged: it
// runs before the plan is filtered, it spawns nothing, and it exits. The one
// thing that DID move is the call, and `reapOrphanBrowsers()` now sits between
// here and it — so that function declines to run under `--self-check`, which is
// what its old position gave it for free. See the guard in it.
function selfCheck(steps) {
  const B = (s) => `\x1b[1m${s}\x1b[0m`;
  const P = (n) => `  \x1b[32mPASS\x1b[0m ${n}  detail`;
  const F = (n) => `  \x1b[31mFAIL\x1b[0m ${n}  detail`;
  const transcript = [
    B('live — Mode 1 causal playback (dev fixture through the real MediaStream path)'),
    P('latencySec is stable while running'),
    // The REAL assertion text, verbatim from run-ext.mjs:1072. It read
    // "Σ 4 live stems null against the captured input" here, which is a string
    // that has never appeared in any transcript — so the self-check was
    // exercising the classifier against a name it would never be handed, and
    // would have gone on passing if the real one had been dropped from the file.
    F('Σ stems nulls against the captured input (AUDIO.md §3.4: worse than -12 dB is a bug)'),
    B('live — backpressure ladder, hop 1.0 s (the rung that actually fires)'),
    F('at hop 1.0 s the ladder never emits silence (a drop becomes passthrough)'),  // flaky
    F('at hop 1.0 s there are still no playback underruns'),                        // flaky
    F('no chunk failed'),                                                           // flaky
    F('the codes this harness swallows are exactly the ones the console treats as advisory'), // hard: static grep, cannot flake
    F('a restart after a mid-inference stop raises no FATAL LIVE_ERROR'),           // hard
    B('live — teardown'),
    F('no uncaught page errors'),                                                   // hard
    '',
    '\x1b[31m6 passed, 6 failed\x1b[0m',
  ].join('\n');

  let bad = 0;
  const check = (name, cond, got) => {
    console.log(`  ${cond ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`} ${name}${got ? `  ${C.d}${got}${C.x}` : ''}`);
    if (!cond) bad++;
  };
  console.log(`\n${C.b}verify --self-check${C.x} ${C.d}the flake classifier, against a synthetic transcript${C.x}\n`);

  const sections = [...new Set(failuresWithSections(transcript).map((f) => f.section))];
  check('section headers are recovered from the bold escape, not guessed', sections.length === 3, sections.join(' | '));

  const r = classify({ id: 'e2e', code: 1, out: transcript });
  const names = (a) => a.map((f) => f.name).sort();
  check('exactly the three timing-derived hop-1.0 assertions are excused',
    r.flaky.length === 3 && r.flaky.every((f) => /hop 1\.0/i.test(f.section)),
    names(r.flaky).join(' · '));
  check('everything else is a hard failure, including two IN the same section',
    r.hard.length === 4, names(r.hard).join(' · '));
  check('a static source-grep assertion in the flaky section is NOT excused',
    r.hard.some((f) => /codes this harness swallows/.test(f.name)));
  check('a same-named assertion in a DIFFERENT section is NOT excused',
    r.hard.some((f) => /^Σ stems nulls against the captured input/.test(f.name)));
  check('the verdict is FAIL while any hard failure remains', r.verdict === 'FAIL', r.verdict);

  const onlyFlaky = classify({ id: 'e2e', code: 1, out: [
    B('live — backpressure ladder, hop 1.0 s (the rung that actually fires)'),
    F('at hop 1.0 s the ladder never emits silence (a drop becomes passthrough)'),
  ].join('\n') });
  check('a run whose ONLY failures are known flakes is FLAKY-KNOWN, not FAIL',
    onlyFlaky.verdict === (STRICT ? 'FAIL' : 'FLAKY-KNOWN'), onlyFlaky.verdict);

  const crash = classify({ id: 'e2e', code: 1, out: 'harness error\nTimeoutError: waiting for selector\n' });
  check('a non-zero exit with no FAIL line is a hard failure, never a flake',
    crash.verdict === 'FAIL' && crash.hard.length === 1 && !crash.flaky.length);

  // The real one, 2026-08-09: run-ext.mjs threw at the live step and STILL
  // printed "34 passed, 0 failed" on the way out. A summary that repeats that
  // number without the word CRASHED reads like a partial green.
  const partial = classify({ id: 'e2e', code: 1, out: [
    B('live — Mode 1 causal playback'),
    P('live fixture exists'),
    '\x1b[31mharness error\x1b[0m page.waitForFunction: Timeout 90000ms exceeded.',
    '    at /repo/tools/run-ext.mjs:379:14',
    '',
    '\x1b[31m34 passed, 0 failed\x1b[0m',
  ].join('\n') });
  check('a crash that still prints "N passed, 0 failed" is reported as CRASHED, not as a pass',
    partial.verdict === 'FAIL' && /CRASHED after 34 checks/.test(partial.detail)
    && partial.hard.some((f) => /crashed/.test(f.name)), partial.detail);

  const nodeThrow = classify({ id: 'unit', code: 1, out: [
    P('a thing'),
    'file:///repo/extension/offscreen/live.js:628',
    '    const g = resolveGains(this.mix);',
    'ReferenceError: resolveGains is not defined',
    '    at LivePipeline.pushGains (file:///repo/extension/offscreen/live.js:628:15)',
  ].join('\n') });
  check('a bare node throw in a non-e2e suite names the error, not just the exit code',
    /ReferenceError: resolveGains/.test(nodeThrow.detail), nodeThrow.detail);

  const skipped = classify({ id: 'audible', code: 0, out: '\n\x1b[33mSKIPPED\x1b[0m — ffmpeg not on PATH\n' });
  check('a suite that prints SKIPPED and exits 0 is SKIP, not PASS',
    skipped.verdict === 'SKIP' && /ffmpeg/.test(skipped.detail), skipped.detail);

  // qa/live-boot.mjs (and live-edge, live-feel, live-soak, live-solo) are modules
  // for qa/run-qa.mjs: no top-level execution, so `node qa/live-boot.mjs` exits 0
  // with an empty stdout. Silence must never read as green. (This named
  // live-wire.mjs until 2026-08-15, when QA gave that one file an abort-path
  // self-check that prints `5 passed, 0 failed`; the other five were re-run to
  // confirm they are still silent before repointing at one.)
  const silent = classify({ id: 'unit', code: 0, out: '' });
  check('a suite that exits 0 having asserted NOTHING is VOID, not PASS',
    silent.verdict === 'NO-OUTPUT' && silent.hard.length === 1, silent.verdict);
  const noisyButEmpty = classify({ id: 'unit', code: 0, out: 'seeding model cache from ...\nlaunching\n' });
  check('...and chatter without a single assertion does not rescue it',
    noisyButEmpty.verdict === 'NO-OUTPUT', noisyButEmpty.verdict);
  check('a real suite summary is still a PASS', classify({ id: 'unit', code: 0, out: '\n12 passed, 0 failed\n' }).verdict === 'PASS');
  check('...and so is the selftest wording', classify({ id: 'ui', code: 0, out: 'ok  a thing\n\nall checks passed\n' }).verdict === 'PASS');

  // ---- the six suites added to `steps` on 2026-08-15 -----------------------
  // Every one of these is the ACTUAL summary line the named file prints. Three
  // of them came out VOID on the first attempt at running them from here. Pin
  // the shapes: a suite that changes its summary line must fail HERE, in 0 s
  // and with no browser, rather than by reporting a green step as VOID.
  const shape = (name, id, out, verdict, detail) => {
    const r = classify({ id, code: 0, out });
    check(name, r.verdict === verdict && r.detail === detail, `${r.verdict} · ${r.detail}`);
  };
  shape('pitch.js "23 passed, 0 failed"', 'pitch',
    '  \x1b[32mPASS\x1b[0m a-name  detail\n\n\x1b[32m23 passed, 0 failed\x1b[0m\n', 'PASS', '23 passed, 0 failed');
  shape('chroma.js "all 37 chroma checks passed" reads as 37, not as "exit 0"', 'chroma',
    ' ok  cost-fold   0.018 ms\n\nall 37 chroma checks passed\n', 'PASS', '37 checks passed');
  // Added 2026-08-15 with the two engine-integration suites. Both print the
  // `all N <word> checks passed` shape, so both were recognised by ASSERTED and
  // summarise() on the FIRST run from here and needed no parser work — which is
  // a fact worth pinning rather than a fact worth assuming, because the last
  // three suites added to `steps` all needed it and were only found by running.
  shape('pitchbank.js "all 24 pitchbank checks passed"', 'pitchbank',
    '  \x1b[32mPASS\x1b[0m routing  detail\n\nall 24 pitchbank checks passed\n', 'PASS', '24 checks passed');
  shape('keytap.js "all 19 keytap checks passed"', 'keytap',
    '  \x1b[32mPASS\x1b[0m the-wire-contract  detail\n\nall 19 keytap checks passed\n', 'PASS', '19 checks passed');
  shape('autonav.js "autonav: all checks passed" counts its ok lines', 'autonav',
    'ok   one\nok   two\n\nautonav: all checks passed\n', 'PASS', '2 checks passed');
  shape('speed.js "speed: all checks passed" counts its ok lines', 'speed',
    'ok   one\nok   two\n\nspeed: all checks passed\n', 'PASS', '2 checks passed');
  shape('embed-state.js, same shape behind a different name', 'embed-state',
    'ok   one\n\nembed-state: all checks passed\n', 'PASS', '1 checks passed');
  shape('build-embed.mjs prints ONLY a total and must still be a PASS', 'embed-build',
    'build-embed: 22 checks passed\nbuild-embed: chrome://extensions -> Load unpacked\n', 'PASS', '22 checks passed');
  shape('embed-smoke.mjs "embed-smoke: 34/34 passed"', 'embed-smoke',
    'ok  the deck appears\n\nembed-smoke: 34/34 passed\n', 'PASS', '34/34 passed');
  // ---- the four steps added on 2026-08-16 ---------------------------------
  // Same rule as above, same reason: every string below is the ACTUAL line the
  // named file printed when it was run from here, not a guess at it.
  shape('model-parity.mjs "model-parity: 22 passed, 0 failed" — a suite-name prefix on the passed/failed shape', 'model-parity',
    '  \x1b[32mPASS\x1b[0m other is at stem index 2  indexOf(other)=2\n\nmodel-parity: 22 passed, 0 failed\n',
    'PASS', '22 passed, 0 failed');
  shape('qa/test-edge.mjs "32 passed, 0 failed"', 'qa-edge',
    '  \x1b[32mPASS\x1b[0m SEGMENT / STRIDE / SR / overlap  343980\n\n\x1b[32m32 passed, 0 failed\x1b[0m\n',
    'PASS', '32 passed, 0 failed');
  shape('qa/passthrough-gain.mjs "16 passed, 0 failed"', 'passthrough',
    '  \x1b[32mPASS\x1b[0m the engine exports a passthrough-gain rule at all\n\n\x1b[32m16 passed, 0 failed\x1b[0m\n',
    'PASS', '16 passed, 0 failed');
  // Added 2026-08-17 with the step, and this transcript is the ACTUAL output of
  // `node qa/speed-pitch.mjs`, pasted from a run — not a guess at it, per the
  // rule two blocks up. Its `ok` lines carry NO leading space and THREE trailing
  // ones, which is a fourth variant of the shape and the reason it is pinned.
  shape('qa/speed-pitch.mjs "10 passed, 0 failed" with unindented ok lines', 'speed-pitch',
    '\x1b[32mok  \x1b[0m THE POLICY — no path in the extension leaves the element key-unlocked  '
    + '[entry point: every .js under extension/]  \x1b[2m33 files scanned, none\x1b[0m\n'
    + '\n\x1b[32m10 passed, 0 failed\x1b[0m\n',
    'PASS', '10 passed, 0 failed');
  // Added 2026-08-25 with the S6 step. The ACTUAL summary line, pasted from a
  // run: `backend-audio: 11 passed, 0 failed`. Same suite-name-prefixed shape
  // `model-parity` prints, pinned here for the same reason.
  shape('backend-audio.mjs "backend-audio: 11 passed, 0 failed"', 'backend-audio',
    '  PASS 12 STEM PLANES CAME BACK  drums 0.0590/0.0582\n\nbackend-audio: 11 passed, 0 failed\n',
    'PASS', '11 passed, 0 failed');
  /**
   * ...AND ITS ASSERTION NAME STOPS AT THE ENTRY POINT, which is the half that
   * matters for `coverageDrift`. Every name in that file carries a
   * `  [entry point: …]` clause — AGENTS.md requires it — and the clause is
   * separated by exactly two spaces so `assertionNames()` reads it as detail. If
   * that ever collapses to one space the whole file's names change at once and
   * every run reports drift, which is the noise the comment above
   * `assertionNames` warns about.
   */
  {
    const line = '\x1b[32mok  \x1b[0m SPEED DOES NOT MOVE THE KEY  [entry point: the deck bus, TRANSPOSE 0]  \x1b[2mworst +0.01 cents\x1b[0m\n';
    check('...and its name stops before the [entry point] clause, so the names are stable run to run',
      JSON.stringify(assertionNames(line)) === JSON.stringify(['SPEED DOES NOT MOVE THE KEY']),
      JSON.stringify(assertionNames(line)));
  }
  // Added 2026-08-16 with the step. It prints the passed/failed shape but with
  // ONE-space `ok` lines rather than two-space `PASS` ones, and its details sit
  // on a CONTINUATION line rather than after two spaces — so this pins both that
  // the summary is recognised and that assertionNames() recovers clean names
  // from it (a detail bleeding into the name makes every run report drift).
  shape('qa/estimator-ground.mjs "18 passed, 0 failed" with ok-style lines', 'estimator-ground',
    ' \x1b[32mok\x1b[0m   the estimator resolves a known-zero delay\n        drums ±0 · bass ±7\n\n\x1b[32m18 passed, 0 failed\x1b[0m\n',
    'PASS', '18 passed, 0 failed');
  check('...and its assertion name stops at the newline, not at the continuation detail',
    JSON.stringify(assertionNames(' \x1b[32mok\x1b[0m   a name\n        drums ±0 · bass ±7\n')) === JSON.stringify(['a name']),
    JSON.stringify(assertionNames(' \x1b[32mok\x1b[0m   a name\n        drums ±0 · bass ±7\n')));
  // live-wire's summary carries a TRAILING PARENTHETICAL on the same line
  // ("(abort-path self-check only — run the suite with qa/live-qa.mjs wire)").
  // `summarise`'s passed/failed match is unanchored, so it survives — pinned
  // because a suite whose summary line grows a suffix is exactly the shape
  // change this block exists to catch.
  shape('docs/snippets/selftest.js "all tests passed" counts its ok lines (it is NOT "all checks passed")', 'snippets',
    ' ok  [testbed] one\n ok  [testbed] two\n ok  [steady] three\n\nall tests passed\n', 'PASS', '3 checks passed');
  check('...and its failure total is a BARE "N FAILURE(S)", with no "of N" — chroma\'s form has one',
    /3 FAILURE\(S\)/.test(classify({ id: 'snippets', code: 1, out: 'FAIL a-name   detail\n\n3 FAILURE(S)\n' }).detail),
    classify({ id: 'snippets', code: 1, out: 'FAIL a-name   detail\n\n3 FAILURE(S)\n' }).detail);
  check('a selftest.js that printed its banner while asserting NOTHING is still VOID',
    classify({ id: 'snippets', code: 0, out: '\nall tests passed\n' }).verdict === 'NO-OUTPUT');
  shape('coverage-gate.mjs "coverage-gate: 14 passed, 0 failed" — suite-name prefix again', 'coverage',
    '  PASS bass clears both coverage floors  rms -17.5 dBFS\n\ncoverage-gate: 14 passed, 0 failed\n',
    'PASS', '14 passed, 0 failed');
  shape('qa/live-wire.mjs "5 passed, 0 failed  (abort-path self-check only …)"', 'wire-abort',
    '  \x1b[32mPASS\x1b[0m ...and it names the error\n\n\x1b[32m5 passed, 0 failed\x1b[0m  (abort-path self-check only — run the suite with qa/live-qa.mjs wire)\n',
    'PASS', '5 passed, 0 failed');
  // Added 2026-08-25 with the `unit-check` step, under the same rule as every
  // block above: these are the ACTUAL lines the file printed when it was run
  // from here, not a guess at them — its first `ok` line, its crawl-floor `ok`
  // line with the detail after the two-space separator, and, verbatim, the note
  // the external loop prints on a tree with no vendor drop (the CI case; with
  // the drop present the same line reads "is present"). Corrected 2026-08-25
  // after review: the two lines this block first shipped were truncated, which
  // is exactly the claim the sentence above makes and has to keep.
  //
  // It puts the suite-name prefix on the passed/failed shape, prints `ok` at
  // THREE spaces, and interleaves un-counted `   -  ` note lines that must not
  // be read as assertions.
  shape('unit-check.mjs "unit-check: 67 passed, 0 failed" — suite-name prefix, and a note line in the middle', 'unit-check',
    'ok   scanner: a bare chrome.* is executable\n'
    + 'ok   the crawl reached the unit, not a corner of it  34 files from 2 entries + 5 roots, floor 25\n'
    + '   -  extension/vendor/ort/ is ABSENT (not in git by design) — run `bash tools/fetch-vendor.sh` before loading unpacked\n'
    + '\nunit-check: 67 passed, 0 failed\n', 'PASS', '67 passed, 0 failed');
  // Added 2026-08-26 with the `seam` step, under the rule two blocks up: this is
  // the ACTUAL first `ok` line and the ACTUAL summary line `node
  // tools/seam-check.mjs` printed when it was run from here, not a guess at them.
  // Same suite-name-prefixed passed/failed shape `unit-check` puts up, with `ok`
  // at three spaces and the detail after the two-space separator.
  shape('seam-check.mjs "seam-check: 17 passed, 0 failed" — suite-name prefix, ok at three spaces', 'seam',
    'ok   THE FAKE PORT REFUSES IN THE SHIPPED WORKER\u2019S OWN WORDS  '
    + '[entry point: extension/workers/inference.worker.js, the INFER case, comments stripped]  verbatim, 75 chars\n'
    + '\nseam-check: 17 passed, 0 failed\n', 'PASS', '17 passed, 0 failed');
  check('...and its un-counted note lines are not mistaken for assertions',
    JSON.stringify(assertionNames('ok   a name  a detail\n   -  a note about the vendor drop\n')) === JSON.stringify(['a name']),
    JSON.stringify(assertionNames('ok   a name  a detail\n   -  a note about the vendor drop\n')));

  // The half of the VOID rule the old `\d+` could not see. Both of these are
  // exit-0 runs that assert nothing while printing a summary that LOOKS like a
  // result — the runner-level version of an assertion that cannot look.
  check('"0 passed, 0 failed" is VOID — a count of nothing is still nothing',
    classify({ id: 'unit', code: 0, out: '\n0 passed, 0 failed\n' }).verdict === 'NO-OUTPUT');
  check('...and so is "0 checks passed"',
    classify({ id: 'embed-build', code: 0, out: 'build-embed: 0 checks passed\n' }).verdict === 'NO-OUTPUT');
  check('...and a count buried MID-LINE does not vouch for a run — the shapes are line-anchored',
    classify({ id: 'unit', code: 0, out: 'seeding model cache; the previous run had 3 checks passed\n' }).verdict === 'NO-OUTPUT');

  // Failure shapes, so a red step's one-line detail says something.
  check('chroma\'s FAILURE(S) wording survives into the summary line',
    /2 FAILURE\(S\) of 37/.test(classify({ id: 'chroma', code: 1, out: 'FAIL a-name   detail\n\n2 FAILURE(S) of 37\n' }).detail));
  check('embed-smoke\'s "3/34 FAILED" does too, and names the failing check',
    (() => { const r = classify({ id: 'embed-smoke', code: 1, out: 'FAIL the deck appears\n\n3/34 FAILED\n' });
             return /3\/34 FAILED/.test(r.detail) && r.hard.some((f) => /the deck appears/.test(f.name)); })());

  // assertionNames() feeds coverage drift. It was widened on 2026-08-15 from
  // "exactly two spaces then PASS" to the ok-style suites; the PASS-style names
  // MUST come out unchanged or the next run reports every assertion in test.js
  // and run-ext.mjs as gone-and-replaced.
  check('assertion names are unchanged for the PASS-style suites',
    JSON.stringify(assertionNames('  \x1b[32mPASS\x1b[0m the name  the detail  more\n')) === JSON.stringify(['the name']));
  check('...and are now recovered from the ok-style suites too, at 0, 1 and 2 spaces',
    JSON.stringify(assertionNames('ok   auto name\n ok  chroma name   0.018 ms\n  PASS pass name  d\nFAIL failed name\n'))
      === JSON.stringify(['auto name', 'chroma name', 'pass name', 'failed name']));
  check('...and a suite\'s prose and section headers are not mistaken for assertions',
    assertionNames('--- 11. cost ---\n      foldChroma 0.018 ms/frame\nokay then\n').length === 0);

  // ---- --unit: the plan IS the manifest's list (#11) -----------------------
  /**
   * THE FAILURE THIS EXISTS FOR IS A GREEN ONE. `unitPlan()` is a filter, and a
   * filter cannot report a miss: a `suites` entry naming a step id that no step
   * has is not an error, it is a suite that silently does not run, and `--unit`
   * goes on printing the same green over a smaller plan. Every id being right
   * TODAY is not the claim — the claim is that the two lists cannot part
   * company without something going red. Rename a step id, or typo one in
   * `extension/unit.json`, and this is what says so.
   *
   * `unitPlan` is called here and at the plan filter below; this call is the
   * one that has the whole `steps` array to hand, and the plan filter's call
   * takes the same argument, so what is asserted here is what runs there.
   *
   * The list is compared as SETS, deliberately. Order is not a promise `--unit`
   * makes: the plan comes out in `steps` order, which is beside-the-module
   * order, and the manifest is free to be read in any order at all.
   */
  const built = unitPlan(steps).map((s) => s.id);
  const ghosts = UNIT_IDS.filter((id) => !built.includes(id));
  check('--unit\'s plan is exactly the suite list extension/unit.json declares  '
    + '[entry point: unitPlan(steps), the same call the plan filter makes]',
    UNIT_IDS.length > 0 && built.length === UNIT_IDS.length && ghosts.length === 0,
    ghosts.length ? `NAMES NO STEP: ${ghosts.join(', ')}` : `${built.length} suites: ${built.join(' -> ')}`);

  /**
   * ...AND THE OTHER DIRECTION, which is the one that rots. The check above
   * catches a manifest entry that lost its step; this catches a STEP THAT WAS
   * NEVER CLASSIFIED — a new plain-node suite added to `steps` by someone who
   * had no reason to think about vendoring, which `--unit` then never runs and
   * nothing anywhere reports. It is the same shape as the standing rule at the
   * top of this file ("a suite that nothing runs is not a suite"), one level in:
   * a suite that `--unit` does not run is not part of the unit's gate, and
   * saying so out loud is the whole job of `otherSteps`.
   *
   * The fix when it fires is one line in `extension/unit.json`: `suites` if the
   * new step's subject is the engine or the deck, `otherSteps` with a reason if
   * it is not.
   */
  const classifiedIds = new Set([...UNIT_IDS, ...(UNIT_DECL.otherSteps || []).map((s) => s.step)]);
  const unclassified = steps.map((s) => s.id).filter((id) => !classifiedIds.has(id));
  check('every step this runner knows is classified by extension/unit.json — the unit\'s, or named in otherSteps',
    unclassified.length === 0,
    unclassified.length
      ? `UNCLASSIFIED: ${unclassified.join(', ')} — add each to "suites" or to "otherSteps"`
      : `${steps.length} steps, ${UNIT_IDS.length} of them the unit's`);

  const strays = [...classifiedIds].filter((id) => !steps.some((s) => s.id === id));
  check('...and every step id the manifest names is a step this runner has',
    strays.length === 0, strays.length ? `NO SUCH STEP: ${strays.join(', ')}` : `${classifiedIds.size} ids`);

  console.log(`\n${bad ? `${C.r}${bad} FAILED${C.x}` : `${C.g}self-check green${C.x}`}\n`);
  process.exit(bad ? 1 : 0);
}

// -------------------------------------------------------------------- preflight
/**
 * KILL ORPHANED PLAYWRIGHT CHROMIUMS BEFORE ANY TIMING RUN.
 *
 * A hung `run-ext.mjs` leaves its browser behind. The next run launches its own
 * and the two contend for the GPU — and nothing in either run's output says so.
 * Measured 2026-08-09: one orphan survived a hung run and silently contended
 * with every subsequent measurement for **41 minutes**, including an 11-failure
 * run that turned out to be nothing at all.
 *
 * That is the THIRD time contention has produced a false result here (two
 * parallel measuring agents; a second Chromium during the dual-deck gate; this)
 * and it is the first one with a one-line preventative. `AGENTS.md`'s rule
 * — performance measurement needs an exclusive machine — has until now been a
 * thing a human had to remember. Now the runner enforces the half it can see.
 *
 * Narrow on purpose: matches the Playwright-bundled binary path only, so a
 * user's own Chrome/Chromium is never touched.
 *
 * IT CANNOT TELL AN ORPHAN FROM A SIBLING, AND ON THIS TREE THAT MATTERS.
 * *(Added 2026-08-16, after it happened twice in one afternoon.)* Several agents
 * work this repo at once. `pkill -f ms-playwright/chromium` kills every
 * Playwright Chromium on the machine, so starting a `verify` while someone else
 * is 90 s into `qa/live-qa.mjs feel` kills THEIR browser — and what they see is
 * `page.waitForFunction: Target page, context or browser has been closed`, with
 * nothing anywhere naming the cause. Both times it cost a re-run and a wrong
 * first hypothesis.
 *
 * NOT REMOVED: the evidence for it is stronger than the evidence against. One
 * orphan silently contended for 41 minutes and produced an 11-failure run that
 * was nothing at all; a reaped sibling costs one obvious re-run. But the message
 * now says what it did in terms of the OTHER person's symptom, and `--no-reap`
 * exists for the case where you know a sibling is running. This is the
 * exclusive-machine rule (`AGENTS.md`) showing up at the process level: the
 * collision is created upstream and executed downstream, and the person holding
 * the keyboard cannot see it.
 */
function reapOrphanBrowsers() {
  // `--self-check` launches nothing, so it has nothing to protect from
  // contention and no business killing a colleague's browser. It used to be
  // spared by position — it exited above this line — and since #11 it is spared
  // on purpose instead, because it now runs below it. Same behaviour, stated.
  if (flag('no-reap') || flag('self-check')) return null;
  const PAT = 'ms-playwright/chromium';
  let before = '';
  try { before = execFileSync('pgrep', ['-f', PAT], { encoding: 'utf8' }).trim(); } catch { /* none */ }
  if (!before) return null;
  const pids = before.split('\n').filter(Boolean);
  try { execFileSync('pkill', ['-f', PAT]); } catch { /* best effort */ }
  return pids.length;
}

const reaped = reapOrphanBrowsers();
if (reaped) {
  console.log(`${C.y}reaped ${reaped} Playwright Chromium process${reaped === 1 ? '' : 'es'} before starting${C.x}`);
  console.log(`${C.d}  An orphan contends for the GPU and nothing in the run says so — see the note at reapOrphanBrowsers().${C.x}`);
  console.log(`${C.d}  If a colleague was mid-run, THIS is why their suite just said "browser has been closed". --no-reap skips it.${C.x}`);
}

// ------------------------------------------------------------------- the plan
/**
 * ORDER IS LOAD-BEARING IN EXACTLY ONE PLACE: `embed-build` writes
 * `out/extension-embed/` and `embed-smoke` drives it. Everything else is
 * ordered cheapest-first so a broken tree goes red in seconds.
 *
 * `slow` means "launches a browser". `heavy` (below) means "needs the 114 MB
 * weights". `--quick` drops both. There is no category for COST, and the
 * paragraph below is the standing decision not to invent one yet.
 *
 * ---------------------------------------------------------------------------
 * THE `--quick` BUDGET — measured 2026-08-16, and the trigger for revisiting it
 * ---------------------------------------------------------------------------
 *
 * 68.1 s wall, 14 steps, 1284 assertions. `pitchbank` is **38.4 s of it, 56 %**.
 * It was 16.8 s on 2026-08-15 with four lanes; six lanes took it to ~31 s, and a
 * Mode-3 steady-state row, a burn-in block and three shipped-worklet mixer
 * checks took it the rest of the way. Everything else combined is 29.7 s, of
 * which `unit` is 10.2 s.
 *
 * IT IS NOT ON A DIET, AND THAT IS A DECISION RATHER THAN AN OMISSION:
 *
 *   1. NONE OF THE COST IS SLACK. The Mode-3 row is the scenario that exposed
 *      the deadline miss. The burn-in block exists because without it
 *      `cost-at-+6-leaves-half-the-quantum` goes red at 3.197 ms WITH THE CODE
 *      UNCHANGED — see the measurement trap at `pitchbank.js:186`, where the
 *      first shifter-heavy workload in a node process reads ~2.2x high (1.70 ms
 *      at 400 quanta of burn-in vs 0.77 ms at 4400) and is FLAT across all 8000
 *      timed quanta either way, so it is invisible as a trend inside a row.
 *      Cutting it buys ~10 s and buys back a flaky assertion. **A fast suite
 *      that flakes is not a faster suite** — it is the `latencySec` family
 *      again, and AGENTS.md prices that at a full investigation each time.
 *   2. THE OBVIOUS DIET IS ENTANGLED WITH (1). The candidate is the `2 decks`
 *      row's 3000 quanta. Shortening it moves the timed window relative to that
 *      same ~400-quantum warm-up ramp, so it is a change that has to be
 *      RE-MEASURED, not reasoned about — and by whoever owns the row, not by
 *      the runner.
 *   3. 68 s IS STILL THE CHEAP OPTION. `--only e2e` is ~7 min and the full run
 *      is longer again. `--quick` remains an order of magnitude cheaper for
 *      1284 assertions.
 *
 * THE TRIGGER, so this is a decision with an expiry and not a shrug: revisit if
 * `--quick` passes ~2 min, or `pitchbank` alone passes 60 s. The right move then
 * is a third category by COST — a flag that drops timing-heavy ROWS — never
 * cutting assertions, and never shortening a row that a burn-in constant is
 * tuned against without re-measuring the ramp first.
 *
 * (The five suites added on 2026-08-16 cost 4.6 s between them — `snippets` 2.8,
 * `ground-truth` 1.2, `wire-abort` 0.3, `qa-edge` 0.2, `passthrough` 0.1 — for
 * 141 assertions. None of them does any wall-clock timing, so the trap above
 * does not reach them; that was checked by grep, not assumed.)
 *
 * SUITES SIT BESIDE THE MODULE THEY COVER, not in cost order, from the moment
 * there were two per subsystem: `pitchbank` after `pitch` (it verbatim-copies
 * `pitch.js` into the worklet and asserts the copy), `keytap` after `chroma`
 * (it is chroma's only caller). A red in one is nearly always read next to the
 * other, and a summary that puts them ten lines apart makes that a scroll.
 */
const steps = [
  { id: 'unit', title: 'node test.js — DSP, WAV, rings, mixer', args: ['test.js'] },
  /**
   * Beside `unit` because it is the other half of `test.js`'s `backend` group,
   * and a red in either is read next to the other: that group drives
   * `serialiseBackend` over a fake BACKEND (does the queue queue?), this drives
   * the same wrapper — over the SHIPPED `WorkerBackend` — at a fake worker PORT
   * that carries `inference.worker.js`'s own `busy` guard (is the guard ever
   * reached?). The second question needs a port with an opinion about being
   * re-entered, which a fake backend does not have.
   *
   * The failure it catches is the one three files exist to prevent and no gate
   * could see: ORT-Web serialises `run()` per wasm instance, and a rejected
   * concurrent call leaves the session permanently unusable — not slow, DEAD,
   * for the life of the worker. It is unreachable today, so nothing observable
   * changes when the queue is deleted.
   *
   * WHICH MUTATIONS ONLY THIS STEP SEES, measured rather than assumed — the
   * first draft of this comment claimed all of them and one reviewer measured
   * otherwise, which is the AGENTS.md failure this file is meant to be immune
   * to. Running each mutation below against `node test.js` as well: mutation 1
   * also reds `unit`, because S6's own `backend` group drives the same wrapper
   * over a fake BACKEND and its two queue claims go with it. Mutations 2, 3, 4,
   * 5, 6, 7, 8, 12 and 13 leave `unit` at 612/0, so those are the ones nothing
   * else in the tree can see. Mutation 2 is the sharpest of them.
   *
   * NOT ONE OF ITS ASSERTIONS READS A CLOCK. The fake port's work is a fixed
   * number of MICROTASK TURNS, so every number it prints is a count and three
   * consecutive runs were byte-identical. ~0.1 s, no browser, no weights.
   *
   * Watched going red. THIRTEEN mutations, each applied ALONE against a green
   * 17 and reverted before the next, and between them every one of the
   * seventeen assertions has been seen to fail:
   *
   *   1. `serialiseBackend`'s queue removed (`const queued = (fn) => fn()`) —
   *      10 of 17. All four wrapped-stack claims and both seam-teardown claims;
   *      the three controls, the two mirror assertions and everything about
   *      backend #1's own teardown stay green, which is the point of having
   *      them. (`unit` 610/2 as well — see above.)
   *   2. the chain advanced with `chain = p` instead of `p.then(noop, noop)` —
   *      16 of 17, red on ONE REJECTED CALL DOES NOT WEDGE THE QUEUE, and the
   *      branch it prints is `7 of the other 15 resolved — the rejection reached
   *      calls it does not belong to`. NOT the "never settle" branch: the calls
   *      do settle, with the WRONG segment's error, and the chain stays rejected
   *      for the life of the backend so every later `separate()` on that deck
   *      fails with a stale error from a chunk it has nothing to do with. (The
   *      first draft of this comment said eight calls hang. Measured false.)
   *   3. `WorkerBackend.dispose()` back to `this.pending.clear()` with no
   *      rejection — 15 of 17: the call on the wire and an open `load()`. Both
   *      of those assertions drive the UNWRAPPED backend on purpose; through the
   *      wrapper the seam would settle the callers and this mutation would pass.
   *   4. `dispose()` rejecting but recording no `deadReason` — 15 of 17: a call
   *      arriving afterwards is told the backend "reported no reason" about a
   *      teardown that had just happened.
   *   5. the FAKE PORT's guard disabled (`if (false)`) — 15 of 17, and both reds
   *      are CONTROLS. A fake that waves a concurrent INFER through makes every
   *      "0 guard trips" below it a statement about nothing, so the suite has to
   *      fail rather than pass quietly, and it does.
   *   6. the FAKE PORT holding `busy` across its warm-up — 16 of 17: the warm-up
   *      control, which exists to show the gap the shipped guard does not cover.
   *   7. `inference.worker.js` rewording its refusal — 16 of 17: the fake's copy
   *      of that sentence has drifted off the original.
   *   8. `inference.worker.js` setting `busy` in `loadModel()` — 16 of 17: the
   *      warm-up gap would be closed, and the control that models it would be
   *      modelling a worker that no longer exists.
   *   9. a queue that SERIALISES PERFECTLY BUT DISPATCHES LIFO — 12 of 17. This
   *      is the mutation that found the defect in the FIFO assertion itself: it
   *      used to read the session's run order off `m.id`, which
   *      `WorkerBackend.separate()` mints at DISPATCH time, so the ids read
   *      1..N for any order and a strictly-backwards queue PASSED. It now reads
   *      the mix byteLength each run was handed — the caller's own stamp — and
   *      prints `23,22,…,8` here. (`unit` 610/2.)
   *  10. a queue that runs the FIRST call and quietly resolves the other 15 —
   *      11 of 17, including AT MOST ONE CALL IS ON THE WIRE, which `maxOnWire`
   *      alone could not see (a maximum is not a count) and `ran.length === N`
   *      now does. (`unit` 609/3.)
   *  11. `serialiseBackend.dispose()` not settling the calls it is holding —
   *      16 of 17: a Host backend that settles nothing leaves four callers
   *      waiting for ever. This is the seam half of the teardown contract, and
   *      it is what makes the obligation structural instead of prose on a
   *      typedef.
   *  12. the chain-front `if (disposed) throw` removed — 16 of 17: the queue
   *      drains a segment into a backend that was already given back.
   *  13. the on-the-spot refusal at the top of `queued()` removed — 16 of 17: a
   *      call made after `dispose()` queues behind an inference that will never
   *      land, which is the hang this whole section is about with a tidier
   *      cause.
   *
   * TWO MORE, WATCHED IN NEIGHBOURING FILES because that is where the assertion
   * lives: `WorkerBackend.dispose()` no longer nulling `this.probe` reds ...AND
   * A DISPOSED ONE ANSWERS WITH THE TEARDOWN (16 of 17), and the fake's
   * `ortPresent` fixture wired to a constant `true` reds its own CONTROL — the
   * control can lose. `serialiseBackend.dispose()` queued behind the chain reds
   * `unit`'s `dispose() IS NOT QUEUED` (611/1) and this step's seam-teardown
   * claim (16 of 17).
   */
  { id: 'seam', title: 'node tools/seam-check.mjs — the seam serialises: one call in flight per backend, no caller can wedge a session, and dispose() settles what it takes away', args: ['tools/seam-check.mjs'] },
  { id: 'ui', title: 'node extension/ui/dev/selftest.mjs — the deck\'s display laws, no browser', args: ['extension/ui/dev/selftest.mjs'] },
  { id: 'snippets', title: 'node docs/snippets/selftest.js — AUDIO.md §6.1 Tier 1: the testbed and bss-eval reference implementations', args: ['docs/snippets/selftest.js'] },
  { id: 'ground-truth', title: 'node qa/compare.mjs smoke — the testbed has one source per STEMS entry and Σ sources rebuilds the mix', args: ['qa/compare.mjs', 'smoke'] },
  { id: 'qa-edge', title: 'node qa/test-edge.mjs — segment-grid edge lengths and the config constants, no browser', args: ['qa/test-edge.mjs'] },
  { id: 'passthrough', title: 'node qa/passthrough-gain.mjs — QA-15: G_PASS = min(stem gains), on the real emitter and mixer', args: ['qa/passthrough-gain.mjs'] },
  { id: 'pitch', title: 'node extension/engine/pitch.js — phase vocoder, ±6 semitones', args: ['extension/engine/pitch.js'] },
  /**
   * Beside `passthrough` and `pitch` because it is the same audio path, driven
   * end to end: the stem ring, the mixer's resolved gains, the transpose lanes
   * and the sum, through the SHIPPED playback worklet — offline, at the render
   * quantum, in a `vm` realm, with no browser and no mutex.
   *
   * It is the FIRST offline-render harness in this tree: before it, neither
   * `OfflineAudioContext` nor `startRendering` appeared anywhere under `tools/`
   * or `qa/`. What it cannot see is Chromium's own OfflineAudioContext honouring
   * a suspension schedule; that was measured separately and `qa/bounce.mjs`'s
   * header says so rather than letting a green here be read as covering it.
   *
   * ~7 s, 47 assertions. Neither `slow` nor `heavy`: no browser, no weights. Its
   * longest fixture is fourteen seconds of audio ON PURPOSE — the stem ring holds
   * 11.89 s, and a bounce gate shorter than the ring cannot see the failure the
   * whole slice exists to prevent.
   */
  { id: 'bounce', title: 'node qa/bounce.mjs — BOUNCE: the deck rendered offline through the shipped playback worklet, with its faders, mute/solo, crossfader and transpose baked in', args: ['qa/bounce.mjs'] },
  // `${RING_PLANES}`, not `14`. This read "10-plane routing" for the whole of
  // the six-stem migration — a step title naming a number the tree contradicts,
  // which is the cheap end of exactly the problem the migration has been
  // chasing: someone reads it as fact. Derived, so the next stem-count change
  // moves it without anyone remembering to.
  { id: 'pitchbank', title: `node extension/engine/pitchbank.js — ${RING_PLANES}-plane routing, the unshifted drums lane, bank switching`, args: ['extension/engine/pitchbank.js'] },
  { id: 'chroma', title: 'node extension/engine/chroma.js — chroma folding and key correlation', args: ['extension/engine/chroma.js'] },
  { id: 'keytap', title: 'node extension/engine/keytap.js — the key tap: windowing, the wire payload, the reset hook', args: ['extension/engine/keytap.js'] },
  // Beside `keytap` for the reason given above: it is the same cursor, the same
  // refusal contract and the same wire-payload shape one plane over, so a red in
  // one is read next to the other.
  { id: 'bpmtap', title: 'node extension/engine/bpmtap.js — the tempo tap: the onset envelope, the octave tie-break, beat phase', args: ['extension/engine/bpmtap.js'] },
  { id: 'autonav', title: 'node extension/autonav.js — autoplay-next suppression decisions', args: ['extension/autonav.js'] },
  /**
   * Beside `autonav` because it is the same file's neighbour and prints a
   * byte-identical summary shape (`ok   …` lines then `speed: all checks
   * passed`) — VERIFIED BY RUNNING IT, not by reading the regex.
   *
   * 38 assertions, ~40 ms: the range clamp that keeps `playbackRate` off 2.05x,
   * the ad gate, and the re-assert entry points.
   */
  { id: 'speed', title: 'node extension/speed.js — the page-speed transport: the range clamp, the ad gate, and the re-assert entry points', args: ['extension/speed.js'] },
  /**
   * Beside `speed` for the reason at the head of this list: it is the AUDIO half
   * of what `speed.js` decides. `speed` asserts which NUMBER reaches
   * `video.playbackRate`; this asserts what that number does to the KEY, which is
   * a different claim and was wrong for the life of the varispeed ruling.
   *
   * It also spans `pitch.js` and `content.js::driveRate`, so it does not sit
   * cleanly beside one module — and `speed` is the one whose red a reader would
   * want it next to, because the two share every entry point.
   *
   * ~1.9 s, 10 assertions. Neither `slow` nor `heavy`: no browser, no weights, no
   * fixture. NOT ONE OF ITS ASSERTIONS READS A CLOCK — every number is a
   * frequency ratio, a cents figure or a count — so the warm-up trap the
   * `--quick` budget note above describes does not reach it. Checked by reading
   * it, not assumed.
   */
  { id: 'speed-pitch', title: 'node qa/speed-pitch.mjs — SPEED must not move the KEY: the key-lock policy, read out of the build, measured through the real shifter', args: ['qa/speed-pitch.mjs'] },
  { id: 'embed-state', title: 'node extension/ui/embed-state.js — pure deck UI state', args: ['extension/ui/embed-state.js'] },
  /**
   * The successor to the deleted `build-embed` step. That one asserted the
   * overlay build's seams; this one asserts the same facts about the one tree
   * that replaced it — manifest paths, transitive imports, and the three
   * single-deck properties (no panel, one chord, no downloads permission).
   *
   * All three mutations were run before it was gated: a renamed manifest path, a
   * broken import, and a re-added `arm-tab-b` each turn it red.
   */
  { id: 'tree', title: 'node tools/tree-check.mjs — extension/ loads as an extension: every named path, every import, one deck', args: ['tools/tree-check.mjs'] },
  /**
   * Beside `tree` because it crawls the same tree with the same four regexes and
   * asks the other half of the question. `tree` asks whether `extension/` loads
   * as an extension; this asks whether the engine and the deck still come OUT of
   * it — ADR 0001 decision 3's vendored unit, behind decision 4's Host seam.
   *
   * The failure it catches is invisible here by construction: a `chrome.` added
   * to a unit file works perfectly in this repository, because this repository
   * IS a Chrome extension. It costs nothing until it costs a day in a second one.
   *
   * Watched going red before it was gated, and RE-MEASURED after the review that
   * found this comment's first three numbers wrong. Each mutation applied alone,
   * against a green 67:
   *
   *   - `chrome.runtime.id` in `engine/mixer.js` — 66 of 67, one red, and the
   *     closure scan names the file and the line.
   *   - a unit file importing `../sw/service-worker.js` — 66 of 67, one red: the
   *     escape, and ONLY the escape. The partition cannot fire with it, because
   *     `crawl()` tests the declared Host paths BEFORE it descends and records
   *     an escape instead, so the file never enters the closure for the
   *     partition to see.
   *   - deleting a declared hole from `unit.json` — 60 of 63. The denominator
   *     moves because a hole carries four assertions of its own; three fire:
   *     `offscreen/host.js` now imports `host-pin.js` out of the unit, it is a
   *     closure file no ADR clause names, and its own `chrome.` is suddenly
   *     inside the unit.
   *   - `fs.readFile(new URL('../sw/service-worker.js', import.meta.url))` in
   *     `engine/mixer.js` — 66 of 67. This is the one an import-only crawl reads
   *     as green; it is why `refsOf` follows `new URL(…, import.meta.url)` too.
   *   - dropping `workers/workerbackend.js` from `roots` — 64 of 67, and the
   *     crawl-floor detail falls from 34 files to 31. Added when S6 (#8) and S9
   *     (#10) landed together: S6 made `offscreen/host.js` the only importer of
   *     `workerbackend.js`, so the crawl now stops one edge short of the entire
   *     inference implementation. Three fire — `engine/demucs.js` and both
   *     worker files leave the closure, so two ADR clauses go unmet and the
   *     partition has three files it cannot classify. This is the assertion
   *     that would have caught the integration silently mis-declaring the unit.
   *
   * S10 (#11) added the other half — the suites that verify the unit, and this
   * runner's agreement with the list. Its four mutations, each applied alone
   * against a green 75:
   *
   *   - deleting a listed suite from the tree (`qa/test-edge.mjs`) — 74 of 75,
   *     and the red names the path. This is the acceptance check for #11.
   *   - pointing a suite at a Host file (`embed-state` -> `extension/speed.js`)
   *     — 74 of 75: `speed.js` is neither in the closure nor declared outside
   *     it, so it is a content script the unit's own plan would have run.
   *   - a step id in `unit.json` that no step has (`qa-edge` -> `qa-edg`) —
   *     73 of 75, and `--self-check` goes red on the same edit. That is the
   *     silent one: `--unit` filters, and a filter cannot report a miss.
   *   - deleting an `otherSteps` entry (`svg`) — 74 of 75: a step the
   *     declaration no longer classifies, which is how a new suite quietly
   *     never joins the unit's gate.
   *
   * #11's review found four more silent greens and they are gated now, at 80.
   * Each measured on the shipped tree BEFORE the fix, then watched red after:
   *
   *   - deleting a real read (`content.js` from `speed-pitch`'s `reads`) — was
   *     75 of 75, exit 0. `reads` was declared-therefore-real only; the
   *     direction that rots was unasserted.
   *   - pointing a suite at the wrong file (`pitch` -> `engine/chroma.js`) —
   *     was 75 of 75: `--unit` runs each step's own argv, so `path` was
   *     decoration, and S11 copies these paths verbatim.
   *   - classifying a step twice (`tree` in `suites` AND `otherSteps`) — was
   *     75 of 75 and `--self-check` green, with `--unit` then running
   *     tree-check over a copy the same file says it cannot run in.
   *   - `test.js`'s `group('host')` — 122 assertions that install a Chrome
   *     platform and grade THIS Host — was undeclared, so the largest step in
   *     `--unit` read as a claim about the unit alone. It is not one.
   *
   * INTEGRATION, #9 and #11 landing in the same wave. S8's `seam` step is the
   * UNIT'S: every file `tools/seam-check.mjs` touches is unit — it drives
   * `shared/host.js`'s wrapper over `workers/workerbackend.js` and reads
   * `workers/inference.worker.js` as text — so it joined `suites`, and the
   * completeness half above confirms it opens nothing across the seam. Watched
   * from both sides on the merged tree, each edit alone:
   *
   *   - the entry missing — 79 of 80, `UNCLASSIFIED: seam`, and `--self-check`
   *     red on the same edit. That is the totality assertion #11 added doing
   *     precisely the job it was added for: a new suite landed and the gate
   *     asked which side it was on, rather than letting `--unit` never run it.
   *   - the entry pointing at the wrong file (`seam` -> `tools/tree-check.mjs`)
   *     — 78 of 80, `NOT WHAT THE STEP RUNS: seam runs tools/seam-check.mjs`.
   *
   * The four round-1 numbers above were measured against a green 75 and read
   * one lower against today's 80: #11's acceptance check, re-run on the merged
   * tree, is 79 of 80 naming `qa/test-edge.mjs`.
   */
  { id: 'unit-check', title: 'node tools/unit-check.mjs — the engine and the deck still come out, and the suites that say so are the ones --unit runs: the closure resolves, reaches for no chrome, and leaves only through a declared hole or a declared read', args: ['tools/unit-check.mjs'] },
  /**
   * Beside `tree` because it is the same kind of claim about the same tree — a
   * property of the whole published surface rather than of one module — and a
   * red in either is read the same way: something about the shape of the repo
   * is wrong, not something about the DSP.
   *
   * It asserts the product rename finished. Two of the three identifiers it
   * covers are matched pairs across a process boundary (`postMessage` between
   * the content script and the deck, `chrome.tabs.sendMessage` between the
   * service worker and the content script); renaming one side and not the other
   * breaks the channel silently, with no throw and no failing unit test. It was
   * watched going red on the pre-rename tree — 5 of 8 — before it was gated.
   */
  { id: 'name', title: 'node tools/name-check.mjs — nothing in the tracked tree names a former product name or an unpublished internal document, and both halves of each renamed IPC pair are present', args: ['tools/name-check.mjs'] },
  /**
   * Third of the three gates that assert a property of the published tree
   * rather than of the DSP, and it is here for the same reason `name` is: the
   * failure it catches is silent everywhere anyone would have looked.
   *
   * `brand/mark.svg` and `brand/wordmark.svg` were not XML — a literal `--`
   * inside an XML comment, which XML forbids. An SVG inlined into a document is
   * read by the lenient HTML parser and renders; the same bytes fetched through
   * `<img src>` are read by the strict XML parser and do not. `render.mjs`
   * inlines, so every shipped PNG kept generating correctly from a broken
   * source; the README loads by src, so the mark was a broken-image glyph.
   *
   * Watched going red on the pre-fix tree — 2 of 6 — before it was gated.
   */
  { id: 'svg', title: 'node tools/svg-check.mjs — every tracked SVG is XML, so the mark renders through <img src> and not only when inlined', args: ['tools/svg-check.mjs'] },
  /**
   * `heavy` means "needs a large prerequisite, not a browser". It launches NO
   * browser — so calling it `slow` would be a lie that `--quick`'s own summary
   * line prints — but it reads the 109 MB pinned weights, which `--quick` must
   * not require. A fresh clone has to be able to run `--quick`; that is the
   * entire point of `--quick`.
   *
   * It is NOT skipped-when-absent: the model file IS its subject, so excusing
   * itself on the file being missing would be an instrument declining to look at
   * the thing it exists to look at (AGENTS.md). Preflight refuses instead, with
   * the fetch line.
   */
  {
    id: 'model-parity', title: 'node tools/model-parity.mjs — the pinned weights really carry six sources, in STEMS order',
    args: ['tools/model-parity.mjs'], heavy: true, needsSeed: true,
  },
  /**
   * Beside `model-parity` because it is the other half of the same question and
   * a red in either is read next to the other: that one asks whether the pinned
   * .onnx still says what `engine/demucs.js` believes about it, reading the
   * protobuf and never running it; this one RUNS it, through the Host seam, and
   * asks whether six stems come back in `STEMS` order that add up to the mix.
   *
   * `slow` AND `heavy`, which is a first: it launches a browser (there is no
   * `onnxruntime-node` in this repo, and ORT Web wants `fetch`, a module
   * `Worker` and wasm from a URL) and it reads the 114 MB weights. `--quick`
   * drops it for both reasons, and CI never sees it — which is the same blind
   * spot `embed-smoke` has and the reason the note at the top of this file says
   * a green badge is necessary rather than sufficient.
   *
   * HEADLESS, unlike `embed-smoke`: no extension, so no MV3 service worker, so
   * no need for a display. ~35 s, of which ~7 s is the session and ~5.5 s is
   * each segment on the wasm EP.
   *
   * WHAT IT IS FOR. `CONTRIBUTING.md:190` asks for a manual listen after a
   * change to the audio path, and S6 moved the inference worker behind an
   * interface — about as central to that path as an edit gets. This is the
   * strongest substitute available to something that cannot listen: the real
   * weights, the real worker, the real runtime, driven through `Deck.infer()`
   * and the real `GpuScheduler`, with the per-stem RMS printed so a human can
   * sanity-check what the numbers say.
   */
  {
    id: 'backend-audio',
    title: 'node tools/backend-audio.mjs — the real weights through the Host seam: six stems in STEMS order that add back up to the mix',
    args: ['tools/backend-audio.mjs'], slow: true, heavy: true, needsSeed: true,
  },
  /**
   * THE ONE END-TO-END GATE. Real Chromium, the real unpacked extension, the
   * deck injected into a real page.
   *
   * It carries more weight than it used to and that is stated rather than
   * discovered: the console-driven live suites (wire/feel/solo/edge/soak) went
   * with the console they drove, so this is now the only check that the engine
   * and the surface meet correctly in a browser.
   */
  {
    id: 'embed-smoke', title: 'node tools/embed-smoke.mjs — real Chromium, the deck inside the page', slow: true,
    args: ['tools/embed-smoke.mjs'],
  },
];

// The self-check needs `steps`, and nothing above it does. See the note at
// `function selfCheck` — it still runs before the plan is built and still exits.
if (flag('self-check')) selfCheck(steps);

/**
 * `--unit` REPLACES the plan, exactly as `--only` does, rather than narrowing
 * whatever `--quick` left. The unit's suites are declared as a list, not as a
 * predicate over cost, so intersecting them with `--quick` would give a plan
 * neither flag asked for — and today every one of them is plain node anyway, so
 * the intersection would be a no-op that reads like a rule.
 *
 * `--only` still wins over both, because it is the "run exactly this one thing"
 * flag and it is what a red step is re-run with.
 */
let plan = steps.filter((s) => !(QUICK && (s.slow || s.heavy)));
if (UNIT) plan = unitPlan(steps);
if (ONLY) plan = steps.filter((s) => s.id === ONLY);
if (!plan.length) {
  // Name the selector that emptied it. `--unit` can empty a plan too — an
  // emptied or mistyped `suites` list in extension/unit.json produces exactly
  // this — and a message about `--only null` would send the reader to the wrong
  // file. Exit 2 either way: a plan of nothing is the runner-level VOID case,
  // and it must not be able to print green.
  console.error(ONLY
    ? `no step matches --only ${ONLY}. Known: ${steps.map((s) => s.id).join(', ')}`
    : UNIT
      ? 'no step matches the "suites" list in extension/unit.json — '
        + `it names ${UNIT_IDS.length ? UNIT_IDS.join(', ') : 'nothing at all'}. `
        + `Known: ${steps.map((s) => s.id).join(', ')}`
      : 'the plan is empty');
  process.exit(2);
}

// ---------------------------------------------------------------- preflight 2
// Same contract as the note at the top of the file: say which command is
// missing BEFORE launching anything, not eight minutes in. Each requirement is
// checked only if a step in THIS plan actually needs it — `--quick` needs
// neither the 172 MB seed nor the fixture, and `--only pitch` needs nothing.
const missing = [];
if (plan.some((s) => s.needsSeed)) {
  if (!fs.existsSync(SEED)) {
    missing.push(`model weights not found: ${SEED}\n`
      + `      -> curl -L -o ${MODEL_SEED_REL} '${MODEL_URL}'\n`
      + `      -> or pass --seed <path to the pinned htdemucs_6s export>\n`
      + `      -> or drop --seed entirely and let the extension download ${(MODEL_BYTES / 1048576).toFixed(0)} MB from Hugging Face`);
  } else if (fs.statSync(SEED).size !== MODEL_BYTES) {
    // A seed of the wrong SIZE is the 4-stem model still sitting in
    // spike/models/. Nothing downstream survives it and none of them says why:
    // the extension reports an unexplained SHA-256 failure ~40 s into a browser
    // run. It is one stat() to say so before anything launches.
    missing.push(`model weights are the WRONG FILE: ${SEED}\n`
      + `      -> ${fs.statSync(SEED).size} bytes, but shared/config.js pins ${MODEL_BYTES}\n`
      + `      -> curl -L -o ${MODEL_SEED_REL} '${MODEL_URL}'`);
  }
}

if (missing.length) {
  console.error(`\n${C.r}${C.b}verify: cannot start${C.x}\n`);
  for (const m of missing) console.error(`  ${C.r}x${C.x} ${m}\n`);
  console.error(`  ${C.d}(or run --quick to skip everything that needs a browser)${C.x}\n`);
  process.exit(2);
}

console.log(`${C.b}verify${C.x} ${C.d}${new Date().toISOString()} · ${plan.map((s) => s.id).join(' -> ')}${C.x}`);
if (plan.some((s) => s.needsSeed)) {
  console.log(`${C.d}  seed    ${SEED}${C.x}`);
}

// ------------------------------------------------------------------ execute
const results = [];
for (const step of plan) {
  const res = await run(step);
  results.push({ ...res, ...classify(res), drift: coverageDrift(res) });
}

// ------------------------------------------------------------------ verdict
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const mark = { PASS: `${C.g}PASS${C.x}`, FAIL: `${C.r}FAIL${C.x}`, SKIP: `${C.y}SKIP${C.x}`, 'FLAKY-KNOWN': `${C.y}FLAKY${C.x}`, 'NO-OUTPUT': `${C.r}VOID${C.x}` };

console.log(`\n${C.b}${'='.repeat(72)}\nverify — summary\n${'='.repeat(72)}${C.x}`);
for (const r of results) {
  console.log(`  ${mark[r.verdict]}  ${pad(r.id, 12)} ${pad(secs(r.ms), 8)} ${r.detail}`);
  console.log(`         ${C.d}${r.title}${C.x}`);
}

const hard = results.flatMap((r) => r.hard.map((f) => ({ ...f, step: r.id })));
const flaky = results.flatMap((r) => r.flaky.map((f) => ({ ...f, step: r.id })));

if (flaky.length) {
  console.log(`\n${C.y}${C.b}KNOWN FLAKE — not counted as a regression${C.x}`);
  for (const f of flaky) console.log(`  ${C.y}~${C.x} [${f.step}] ${f.line}`);
  console.log(`  ${C.d}section: ${flaky[0].section}${C.x}`);
  console.log(`  ${C.d}${FLAKY.why.replace(/(.{92}) /g, '$1\n  ')}${C.x}`);
  if (!STRICT) console.log(`  ${C.d}--strict makes this red instead.${C.x}`);
}

if (hard.length) {
  console.log(`\n${C.r}${C.b}FAILED ASSERTIONS${C.x}`);
  for (const f of hard) console.log(`  ${C.r}x${C.x} [${f.step}] ${f.section} :: ${f.line}`);
}

const drifted = results.filter((r) => r.drift);
if (drifted.length) {
  console.log(`\n${C.y}${C.b}COVERAGE DRIFT — this run did not check the same things as the last one${C.x}`);
  for (const r of drifted) {
    const d = r.drift;
    console.log(`  ${C.y}~${C.x} ${r.id}: ${d.from} -> ${d.to} assertions (previous run ${d.when.slice(0, 19)}Z)`);
    for (const n of d.gone.slice(0, 8)) console.log(`      ${C.r}-${C.x} no longer runs: ${n}`);
    for (const n of d.added.slice(0, 8)) console.log(`      ${C.g}+${C.x} newly runs:     ${n}`);
    if (d.gone.length > 8 || d.added.length > 8) console.log(`      ${C.d}...and more, see ${COVERAGE}${C.x}`);
  }
  console.log(`  ${C.d}An ABSENT assertion reads as green. "N/N" is only comparable between runs when N is.${C.x}`);
  console.log(`  ${C.d}If nothing in the tree changed, a block is silently conditional — that is a harness bug.${C.x}`);
}

const skipped = results.filter((r) => r.verdict === 'SKIP');
if (skipped.length) {
  console.log(`\n${C.y}${C.b}SKIPPED${C.x}`);
  for (const r of skipped) console.log(`  ${C.y}-${C.x} ${r.id}: ${r.detail}`);
}
// Whichever flag actually chose the plan says what it left out, in its own
// words. `--unit` before `--quick` because it REPLACES the plan: under
// `--unit --quick`, --quick's list of what it dropped would be true and
// misleading at once.
//
// `--only` has no branch of its own and needs none: it wins the plan over both,
// and the verdict line below is already a list of exactly the step it ran. What
// it must not do is let `--unit` describe a plan it replaced — `--unit --only
// pitch` would otherwise name the ten other unit suites as the only things that
// did not run, when twenty-one steps did not. Hence `!ONLY` here and on the
// verdict. (`--quick --only X` keeps its inherited shape, unchanged by #11 and
// unchanged here: it is the same imprecision, it predates this flag, and
// widening it is not this slice's edit to make.)
if (UNIT && !ONLY) {
  const notRun = steps.filter((s) => !UNIT_IDS.includes(s.id)).map((s) => s.id).join(', ');
  console.log(`\n${C.y}--unit: ${notRun} did NOT run. This is the vendored unit's own gate, not a green build.${C.x}`);
} else if (QUICK) {
  const skippedIds = steps.filter((s) => (s.slow || s.heavy) && !s.optIn).map((s) => s.id).join(', ');
  console.log(`\n${C.y}--quick: ${skippedIds} did NOT run. This is not a green build.${C.x}`);
}

console.log(`\n${C.d}logs -> ${OUT}${C.x}`);

const red = hard.length > 0 || results.some((r) => r.verdict === 'FAIL' || r.verdict === 'NO-OUTPUT');
if (red) console.log(`\n${C.r}${C.b}RED${C.x} — ${hard.length} failing assertion${hard.length === 1 ? '' : 's'}. Do not commit as green.\n`);
else if (flaky.length) console.log(`\n${C.y}${C.b}AMBER${C.x} — everything passed except ${flaky.length} known-flaky assertion${flaky.length === 1 ? '' : 's'} above. Safe to commit; re-run to confirm.\n`);
else if (UNIT && !ONLY) console.log(`\n${C.g}${C.b}GREEN${C.x} ${C.y}(partial — the vendored unit's suites only; ${results.length} of ${steps.length} steps)${C.x}\n`);
else if (QUICK) console.log(`\n${C.g}${C.b}GREEN${C.x} ${C.y}(partial — no browser ran; ${results.length} of ${steps.length} steps)${C.x}\n`);
else if (skipped.length) console.log(`\n${C.g}${C.b}GREEN${C.x} ${C.y}(partial — see SKIPPED above)${C.x}\n`);
else console.log(`\n${C.g}${C.b}GREEN${C.x} — ${results.map((r) => `${r.id} ${r.detail}`).join(' · ')}\n`);

process.exit(red ? 1 : 0);
