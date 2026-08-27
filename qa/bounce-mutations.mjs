/**
 * THE BOUNCE MUTATION BATTERY - `node qa/bounce-mutations.mjs`
 *
 * It lives here, beside the suite it tests, and not in a scratchpad: two
 * batteries were permanently lost in this build because they lived in /tmp, and
 * a "watched red" nobody can re-run is a claim rather than evidence.
 *
 *   ANCHORS CUT AGAINST LANDED COMMIT 5993d32, PLUS THIS SLICE'S OWN NEW FILES
 *
 * Stated in two halves because a stamp that names a commit a reader cannot
 * resolve the anchor in is worse than none. Two of the four files below —
 * `extension/offscreen/playback-processor.js` and `extension/offscreen/engine.js`
 * — exist at `5993d32` and their anchors were cut against it. The other two,
 * `extension/engine/bounce.js` and `extension/offscreen/bounce.js`, are NEW in
 * this slice and did not exist at that commit; their anchors were cut against
 * the same commit that introduces them, which is the earliest resolvable
 * revision there can be for a file a slice creates.
 *
 * ===========================================================================
 * A BATTERY IS ONLY VALID AGAINST THE SOURCE IT WAS CUT FOR
 * ===========================================================================
 *
 * Anchors patch specific lines. When another slice rewrites those lines the
 * battery decays SILENTLY: it reports anchors quietly not matching, which is
 * exactly the shape of a test that has stopped testing. One battery in this
 * phase reported 51/51 at branch time and 44/51 later, and ten of its thirty
 * anchors had simply stopped applying.
 *
 * So this one reports TWO THINGS PER ANCHOR, because they need opposite
 * responses:
 *
 *   MATCHES   the anchor still finds its text, exactly once. A `no` here is a
 *             DECAYED INSTRUMENT - re-cut it against the current source.
 *   REDS      the mutation still makes the suite fail. A `no` here is either
 *             decay or a REAL COVERAGE LOSS - investigate before re-cutting.
 *
 * A pass count alone collapses those two into one number. This prints both.
 *
 * ===========================================================================
 * THREE WAYS A GATE FAILS, AND THIS BATTERY CHECKS ALL THREE
 * ===========================================================================
 *
 *   1. it measures nothing   -> every anchor below must RED
 *   2. it manufactures reds  -> the UNMUTATED suite must be GREEN, checked
 *                               first, and a battery that cannot get a green
 *                               baseline refuses to report anything else
 *   3. IT REWARDS THE DEFECT -> the suite's own detail lines carry the FIGURE,
 *                               not just the verdict, and this battery prints
 *                               the first red's whole line. Read the number and
 *                               ask whether it got WORSE - a residual that
 *                               IMPROVES when you break the code is the failure
 *                               nobody asks about.
 *
 * KNOWN BLIND SPOT, DECLARED RATHER THAN DISCOVERED. Zeroing the passthrough
 * planes in offscreen/bounce.js's fill() cannot be watched red by this suite:
 * the scratch is zero-initialised and nothing else ever writes those two planes,
 * so removing the fill() leaves them zero anyway. The line is correct and load
 * bearing for a future producer that reuses the scratch for something else; it
 * is simply not covered here, and an anchor that cannot go red is worse than no
 * anchor at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SUITE = path.join(HERE, 'bounce.mjs');
/**
 * The landed base this battery's anchors were cut against. Files this slice
 * CREATES have no earlier revision to name; see the header.
 */
const REVISION = '5993d32 (+ this slice\'s own new files)';

const F_ENGINE = 'extension/engine/bounce.js';
const F_OFF = 'extension/offscreen/bounce.js';
const F_WORKLET = 'extension/offscreen/playback-processor.js';
const F_ENG = 'extension/offscreen/engine.js';

/**
 * Each anchor is one defect. `edits` are exact substrings that must occur
 * EXACTLY ONCE - a find that matches twice is ambiguous and is reported as a
 * decayed anchor rather than applied to the wrong place.
 */
const ANCHORS = [
  {
    id: 'no-refills',
    why: 'the producer never stops to top the ring up - the naive offline render',
    edits: [{ file: F_OFF, find: 'for (const r of plan.refills) {', to: 'for (const r of []) {' }],
  },
  {
    id: 'half-the-refills',
    why: 'the plan schedules every other stop, so the ring runs dry between them',
    edits: [{ file: F_ENGINE, find: 'f += refillEvery) {', to: 'f += refillEvery * 2) {' }],
  },
  {
    id: 'no-quantum-rounding',
    why: 'the ring is filled to the render length instead of to whole quanta, so the LAST quantum starves',
    edits: [{ file: F_ENGINE, find: 'const quantaFrames = Math.ceil(renderFrames / quantum) * quantum;', to: 'const quantaFrames = renderFrames;' }],
  },
  {
    id: 'no-trim-in-the-plan',
    why: 'the transpose group delay is not trimmed, so every file starts 69.7 ms late',
    edits: [{ file: F_ENGINE, find: 'const trim = o.trim == null ? PITCH_GROUP_DELAY_SAMPLES : o.trim;', to: 'const trim = o.trim == null ? 0 : o.trim;' }],
  },
  {
    id: 'no-trim-in-the-slice',
    why: 'the plan trims and the slice does not - the other half of the same defect',
    edits: [{ file: F_OFF, find: 'left: L.slice(trim, trim + plan.outputFrames),', to: 'left: L.slice(0, plan.outputFrames),' }],
  },
  {
    id: 'no-stem-gains',
    why: 'the per-stem fader / mute / solo stage is never posted, so every stem plays at unity',
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'gain', i, value: g.meter[i], tau: BOUNCE_TAU });", to: 'void g;' }],
  },
  {
    id: 'no-crossfader',
    why: 'the crossfader factors are never posted',
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'xf', i, value: g.xf[i], tau: BOUNCE_TAU });", to: 'void i;' }],
  },
  {
    id: 'no-master-gain',
    why: "the deck's master gain is never posted",
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'gain', i: G_MASTER, value: dbToGain(s.masterDb), tau: BOUNCE_TAU });", to: 'void G_MASTER;' }],
  },
  {
    id: 'crossfader-applied-twice',
    why: 'the POST-crossfader gain is posted into the metered slot as well, so it lands twice',
    edits: [{ file: F_OFF, find: 'value: g.meter[i], tau: BOUNCE_TAU', to: 'value: g.stems[i], tau: BOUNCE_TAU' }],
  },
  {
    id: 'no-pitch-reset',
    why: 'the transpose is set with {t:pitch} alone, so the bank crossfade slides up from concert pitch',
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'reset' });", to: 'void node;' }],
  },
  {
    id: 'no-silent-tail',
    why: 'the producer stops at the last track frame, so the delay lines are flushed by starvation',
    edits: [{ file: F_OFF, find: 'const n = Math.min(room, SCRATCH_FRAMES, total - writeHead);', to: 'const n = Math.min(room, SCRATCH_FRAMES, track.frames - writeHead);' }],
  },
  {
    id: 'ring-never-plays',
    why: 'the ring is never put in play, so the worklet holds silence for the whole render',
    edits: [{ file: F_OFF, find: '  out.play(true);', to: '  out.play(false);' }],
  },
  {
    id: 'drums-are-transposed',
    why: 'lane 0 joins the shifted lanes - the naive "apply the transpose to all lanes"',
    edits: [{ file: F_WORKLET, find: 'const PITCH_SHIFTED_LANES = Object.freeze([1, 2, 3, 4, 5, 6]);', to: 'const PITCH_SHIFTED_LANES = Object.freeze([0, 1, 2, 3, 4, 5, 6]);' }],
  },
  {
    id: 'engine-invents-a-code',
    why: "the wire emits a code the unit never declared - the ARM_CODES failure, on the emitting side",
    edits: [{ file: F_ENG, find: "if (bouncing[id]) return void bounceFailed(id, 'BUSY');", to: "if (bouncing[id]) return void bounceFailed(id, 'BOUNCE_BUSY');" }],
  },
  {
    id: 'engine-conflates-the-two-refusals',
    why: 'a live deck and an empty deck report the same code, so the user is left guessing which they have',
    edits: [{ file: F_ENG, find: "bounceFailed(id, isCached(id) ? 'NO_TRACK' : 'NOT_CACHED')", to: "bounceFailed(id, 'NO_TRACK')" }],
  },
  {
    id: 'producer-throws',
    why: 'LAYER 1 of the guard: a producer that throws mid-render must be a NAMED red naming the frame',
    expectText: 'the producer failed at frame',
    edits: [{ file: F_OFF, find: '        fill();\n        if (o.onProgress)', to: "        fill();\n        if (r.frame) throw new Error('mutation');\n        if (o.onProgress)" }],
  },
  {
    id: 'guard-without-its-finally',
    why: 'LAYER 2 of the guard: the cancel path leaves through a bare `return`, so without the finally the render never resumes and the whole suite HANGS',
    expect: 'hung',
    edits: [
      { file: F_OFF, find: '      } finally {\n        ctx.resume();\n      }', to: '      }\n      ctx.resume();' },
    ],
  },
];

const HUNG_MS = 45000;
const RUN_MS = 120000;

function readAll() {
  const m = new Map();
  for (const f of [F_ENGINE, F_OFF, F_WORKLET, F_ENG]) m.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
  return m;
}
function restore(orig) {
  for (const [f, src] of orig) fs.writeFileSync(path.join(ROOT, f), src);
}
/** @returns {{code:number|null, reds:string[], passed:number, failed:number, timedOut:boolean}} */
function runSuite(timeoutMs) {
  const r = spawnSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
  const reds = out.split('\n').filter((l) => /^\s{2}FAIL /.test(l)).map((l) => l.trim().replace(/^FAIL\s+/, ''));
  const m = out.match(/(\d+) passed, (\d+) failed/);
  return {
    code: r.status,
    timedOut: r.error != null && (r.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(r.error.message))),
    reds,
    passed: m ? +m[1] : 0,
    failed: m ? +m[2] : 0,
    out,
  };
}

const orig = readAll();
let dirty = false;
const rows = [];
try {
  console.log(`\x1b[1mbounce mutation battery — anchors cut against ${REVISION}\x1b[0m\n`);

  // ---- 2. IT MANUFACTURES REDS. A battery whose baseline is not green is
  //         reporting about a broken tree, not about its own anchors.
  const base = runSuite(RUN_MS);
  console.log(`baseline (no mutation): ${base.passed} passed, ${base.failed} failed, exit ${base.code}`);
  if (base.code !== 0 || base.failed !== 0 || base.passed === 0) {
    console.log('\n\x1b[31mthe unmutated suite is not green — refusing to report anchor results '
      + 'against a tree that is already red\x1b[0m');
    process.exit(2);
  }

  for (const a of ANCHORS) {
    const found = a.edits.map((e) => {
      const src = orig.get(e.file);
      let n = 0, at = 0;
      for (;;) { const i = src.indexOf(e.find, at); if (i < 0) break; n++; at = i + 1; }
      return n;
    });
    const matched = found.every((n) => n === 1);
    if (!matched) {
      rows.push({ id: a.id, matched: false, reds: null, note: `occurrences ${found.join('/')} (want 1 each)` });
      continue;
    }
    dirty = true;
    for (const e of a.edits) {
      const p = path.join(ROOT, e.file);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(e.find, e.to));
    }
    const want = a.expect === 'hung';
    const r = runSuite(want ? HUNG_MS : RUN_MS);
    restore(orig); dirty = false;

    let reds;
    let note;
    if (want) {
      /**
       * TWO SIGNATURES OF THE SAME HANG, and node gives the cheaper one. A
       * top-level `await` that never settles makes node exit 13
       * (ERR_UNSETTLED_TOP_LEVEL_AWAIT) with NO summary line at all - which is
       * the hang, detected by the runtime instead of by the clock. A wall-clock
       * timeout is the fallback for a hang node cannot see. Neither is a red:
       * a hung suite reports nothing, which is the whole point of layer 2.
       */
      const unsettled = r.code === 13 && r.passed === 0 && r.failed === 0;
      reds = r.timedOut || unsettled;
      note = r.timedOut ? `HUNG — no result in ${HUNG_MS / 1000} s of wall clock`
        : unsettled ? 'HUNG — node exited 13, ERR_UNSETTLED_TOP_LEVEL_AWAIT, and the suite printed no summary at all'
          : `did NOT hang: ${r.passed} passed, ${r.failed} failed, exit ${r.code}`;
    } else {
      reds = r.code !== 0 && r.failed > 0;
      const first = r.reds[0] || '(no FAIL line)';
      note = `${r.failed} red of ${r.passed + r.failed}: ${first.slice(0, 260)}`;
      if (a.expectText && !r.reds.some((l) => l.includes(a.expectText))) {
        reds = false;
        note = `no red mentioned ${JSON.stringify(a.expectText)} — ${note}`;
      }
    }
    rows.push({ id: a.id, matched: true, reds, note });
  }
} finally {
  if (dirty) restore(orig);
  const after = readAll();
  let clean = true;
  for (const [f, src] of orig) if (after.get(f) !== src) { clean = false; console.log(`\x1b[31mNOT RESTORED: ${f}\x1b[0m`); }
  if (!clean) process.exitCode = 3;
}

console.log('\n\x1b[1m  anchor                             MATCHES  REDS   what happened\x1b[0m');
let matched = 0, red = 0;
for (const r of rows) {
  if (r.matched) matched++;
  if (r.reds) red++;
  const m = r.matched ? '\x1b[32myes\x1b[0m    ' : '\x1b[31mNO \x1b[0m    ';
  const d = r.reds === null ? '\x1b[33m--- \x1b[0m ' : r.reds ? '\x1b[32myes\x1b[0m  ' : '\x1b[31mNO \x1b[0m  ';
  console.log(`  ${r.id.padEnd(34)} ${m} ${d}  ${r.note}`);
}
console.log(`\n  ${matched}/${rows.length} anchors still MATCH their source  ·  ${red}/${rows.length} still RED the suite`);
if (matched < rows.length) console.log('  \x1b[33mre-cut every anchor that no longer matches: the instrument has decayed, silently\x1b[0m');
if (red < matched) console.log('  \x1b[31man anchor that matches and no longer reds is decay OR A REAL COVERAGE LOSS — investigate\x1b[0m');
if (matched === rows.length && red === rows.length) console.log('  \x1b[32mevery anchor applies and every one is watched red\x1b[0m');
process.exit(matched === rows.length && red === rows.length ? 0 : 1);
