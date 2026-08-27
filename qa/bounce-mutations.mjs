/**
 * THE BOUNCE MUTATION BATTERY - `node qa/bounce-mutations.mjs`
 *
 * It lives here, beside the suite it tests, and not in a scratchpad: two
 * batteries were permanently lost in this build because they lived in /tmp, and
 * a "watched red" nobody can re-run is a claim rather than evidence.
 *
 * ===========================================================================
 * WHAT THIS PRINTS, AND WHY IT IS THREE THINGS AND NOT A PASS COUNT
 * ===========================================================================
 *
 * A pass count collapses three findings that need three different responses.
 * All three have been measured in this build, so all three are reported:
 *
 *   MATCHES   the anchor still finds its text, exactly once. A `no` is a
 *             DECAYED INSTRUMENT (INTEGRATION.md section 18) - re-cut it. One
 *             battery here reported 51/51 at branch time and 44/51 later, with
 *             ten of thirty anchors quietly no longer applying.
 *
 *   REDS      the mutation still fails the suite. A `no` is decay OR A REAL
 *             COVERAGE LOSS (section 24) - investigate before re-cutting.
 *
 *   THE RED SET, PER CASE, IN BOTH DIRECTIONS (section 25). Every anchor
 *             DECLARES which assertions it must turn red, and the case fails if
 *             the observed set differs EITHER WAY: an assertion that stops going
 *             red is a coverage loss, and one that starts going red under an
 *             unexpected mutation is equally a finding. An aggregate cannot see
 *             this, because coverage MIGRATING from one mutation to another
 *             leaves the union unchanged - the aggregate is not wrong, it is
 *             answering a different question than anyone reads it as.
 *
 * ===========================================================================
 * THE THIRD VERDICT: AN EQUIVALENT MUTANT (INTEGRATION.md section 30)
 * ===========================================================================
 *
 * Some mutations produce a deliverable that is byte-for-byte the original. No
 * assertion over the output can catch them, and that is a property of the
 * ARITHMETIC, not a gap in the suite.
 *
 * They get a verdict of their own - `EQUIV` - and they are neither reported
 * green (coverage that does not exist), nor reported as a miss (a gap somebody
 * spends a day on), nor deleted (the next person re-adds the anchor having no
 * record of why it cannot work). An anchor declared `equivalent` must run and
 * the suite must stay GREEN; if it ever goes red the declaration was wrong and
 * this battery says so.
 *
 * The worked example is `bounce-tau-is-the-worklet-default` below.
 *
 * ===========================================================================
 * THREE WAYS A GATE FAILS, AND THIS BATTERY CHECKS ALL THREE
 * ===========================================================================
 *
 *   1. it measures nothing   -> every non-equivalent anchor must RED, and the
 *                               assertions it reds must be the declared ones
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
 * ===========================================================================
 * DECLARED BLIND SPOTS - stated here rather than discovered later
 * ===========================================================================
 *
 * Zeroing the passthrough planes in `offscreen/bounce.js`'s `fill()` cannot be
 * watched red by this suite: the scratch is zero-initialised and nothing else
 * ever writes those two planes, so removing the fill leaves them zero anyway.
 * The line is correct and load bearing for a future producer that reuses the
 * scratch; it is simply not coverable, and an anchor that cannot go red is worse
 * than no anchor at all. It has no entry below for that reason - unlike
 * `bounce-tau-is-the-worklet-default`, which has one because the ARITHMETIC of
 * why it cannot be caught is worth keeping in the tree.
 *
 * `node qa/bounce-mutations.mjs --learn` runs every anchor and prints the red
 * set it OBSERVED, in paste-ready form, for re-cutting the declarations after a
 * deliberate change. It is a tool for editing this file, never evidence: a
 * declaration copied from what the code currently does asserts nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SUITE = path.join(HERE, 'bounce.mjs');
const LEARN = process.argv.includes('--learn');

/**
 * THE REVISION THE ANCHORS WERE CUT AGAINST, in two halves, because a stamp
 * naming a commit a reader cannot resolve the anchor in is worse than none
 * (INTEGRATION.md section 22).
 *
 * `offscreen/playback-processor.js` is untouched by this slice, so its anchor is
 * cut against `b9dc537` - the tip of `main`, in history, resolvable by anyone.
 * The other three files are created or rewritten by this slice and have no
 * earlier revision that contains the lines being patched; their anchors are cut
 * against the slice's own commits, on top of that base.
 *
 * The branch was REBASED onto `b9dc537` after the first stamp was written, which
 * rewrote every commit it named. Re-stamped here for exactly that reason.
 */
const CUT_AGAINST = 'b9dc537 (main) for offscreen/playback-processor.js; '
  + "this slice's own commits on top of it for the other three";

const F_ENGINE = 'extension/engine/bounce.js';
const F_OFF = 'extension/offscreen/bounce.js';
const F_WORKLET = 'extension/offscreen/playback-processor.js';
const F_ENG = 'extension/offscreen/engine.js';

/**
 * Each anchor is one defect.
 *
 *   `edits`  exact substrings that must occur EXACTLY ONCE. A find that matches
 *            twice is ambiguous and is reported as a decayed anchor rather than
 *            applied to the wrong place.
 *   `reds`   the assertions this mutation MUST turn red, as distinctive
 *            substrings of their names. Checked in BOTH directions: every
 *            pattern must match at least one red line, and every red line must
 *            match exactly one pattern.
 *   `expect: 'hung'`        the suite must not finish at all.
 *   `equivalent: '<why>'`   the mutation is undetectable by construction; the
 *                           suite must stay GREEN and the reason is the payload.
 */
const ANCHORS = [
  // ------------------------------------------------------------ the geometry
  {
    id: 'no-refills',
    why: 'the producer never stops to top the ring up - the naive offline render',
    edits: [{ file: F_OFF, find: 'for (const r of plan.refills) {', to: 'for (const r of []) {' }],
    // THE LAST TWO ARE NOT A SURPRISE, they are the cancel path losing its
    // earliest observation point: section 10(a) cancels at the third producer
    // stop, and with no stops at all the bounce runs to the end and writes.
    reds: [
      "a 14.0 s bounce runs to the end without starving — the count, not a listen",
      "progress ticks ONCE PER PRODUCER STOP, at the frames the plan named, monotonically",
      "the render stopped exactly where the plan said it would",
      "the LAST second of the bounce is as loud as the FIRST, stem by stem",
      "a cancelled bounce SETTLES rather than hanging, says CANCELLED, and names the stop it ACTUALLY stopped at",
      "...and nothing lands: the Host is never asked for a destination and no byte is written",
      "a producer that failed mid-render is a RENDER_FAILED naming the frame and the second — never a finished bounce, and never an unhandled rejection",
    ],
  },
  {
    id: 'half-the-refills',
    why: 'the plan schedules every other stop, so the ring runs dry between them',
    edits: [{ file: F_ENGINE, find: 'f += refillEvery) {', to: 'f += refillEvery * 2) {' }],
    reds: [
      "the producer stops every half-ring, and the stops are whole quanta",
      "progress ticks ONCE PER PRODUCER STOP, at the frames the plan named, monotonically",
    ],
  },
  {
    id: 'no-quantum-rounding',
    why: 'the ring is filled to the render length instead of to whole quanta, so the LAST quantum starves',
    edits: [{ file: F_ENGINE, find: 'const quantaFrames = Math.ceil(renderFrames / quantum) * quantum;', to: 'const quantaFrames = renderFrames;' }],
    reds: [
      "the render is the track plus the transpose group delay, rounded UP to a whole render quantum",
      "the plan leaves a cushion of at least one quantum at every render step, at every length",
      "...and that floor GOES NEGATIVE when the refills are removed, so it is an instrument and not a constant",
      "nothing starved: the ring never made the worklet fade, and the worklet really read it",
      "a 14.0 s bounce runs to the end without starving — the count, not a listen",
    ],
  },
  {
    id: 'no-trim-in-the-plan',
    why: 'the transpose group delay is not trimmed, so every file starts 69.7 ms late',
    edits: [{ file: F_ENGINE, find: 'const trim = o.trim == null ? PITCH_GROUP_DELAY_SAMPLES : o.trim;', to: 'const trim = o.trim == null ? 0 : o.trim;' }],
    reds: [
      "the render is the track plus the transpose group delay, rounded UP to a whole render quantum",
      "the deliverable starts where the track starts — the transpose group delay is trimmed off the head",
      "...and the deliverable ends where the track ends — the silent tail flushes the delay instead of starving it",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "the drums are NOT transposed: at +5 the deliverable is the click train back, sample for sample",
      "the deliverable is at the transposed pitch from its FIRST sample, not after a bank crossfade",
    ],
  },
  {
    id: 'no-trim-in-the-slice',
    why: 'the plan trims and the slice does not - the other half of the same defect',
    edits: [{ file: F_OFF, find: 'left: L.slice(trim, trim + plan.outputFrames),', to: 'left: L.slice(0, plan.outputFrames),' }],
    reds: [
      "the deliverable starts where the track starts — the transpose group delay is trimmed off the head",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "the drums are NOT transposed: at +5 the deliverable is the click train back, sample for sample",
      "the deliverable is at the transposed pitch from its FIRST sample, not after a bank crossfade",
    ],
  },
  {
    id: 'no-silent-tail',
    why: 'the producer stops at the last track frame, so the delay lines are flushed by starvation',
    edits: [{ file: F_OFF, find: 'const n = Math.min(room, SCRATCH_FRAMES, total - writeHead);', to: 'const n = Math.min(room, SCRATCH_FRAMES, track.frames - writeHead);' }],
    reds: [
      "nothing starved: the ring never made the worklet fade, and the worklet really read it",
      "...and the deliverable ends where the track ends — the silent tail flushes the delay instead of starving it",
      "a 14.0 s bounce runs to the end without starving — the count, not a listen",
    ],
  },
  {
    id: 'ring-never-plays',
    why: 'the ring is never put in play, so the worklet holds silence for the whole render',
    edits: [{ file: F_OFF, find: '  out.play(true);', to: '  out.play(false);' }],
    reds: [
      "nothing starved: the ring never made the worklet fade, and the worklet really read it",
      "the deliverable starts where the track starts — the transpose group delay is trimmed off the head",
      "...and the deliverable ends where the track ends — the silent tail flushes the delay instead of starving it",
      "a 14.0 s bounce runs to the end without starving — the count, not a listen",
      "the LAST second of the bounce is as loud as the FIRST, stem by stem",
      "...and both ends are at the level the settings say, so a uniform attenuation cannot pass the ratio",
      "each stem arrives at its OWN gain: fader x crossfader x master, against the analytic weighted sum",
      "an assign of B on deck A is silent at every crossfader position — the hard-assign kill, as a ratio",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "soloing one stem leaves the other five below it by a RATIO, not by a threshold",
      "...and the soloed stem is at its OWN unchanged level, so attenuating everything cannot pass the ratio",
      "a muted stem contributes nothing, as a ratio against an unmuted one",
      "...and the other five are exactly where they were, so a mute that muted the bus cannot pass",
      "the drums are NOT transposed: at +5 the deliverable is the click train back, sample for sample",
      "the estimator can see the untransposed fundamental at all, or the ratio below means nothing",
      "a transposed stem's fundamental moves by exactly 2^(5/12)",
      "the deliverable is at the transposed pitch from its FIRST sample, not after a bank crossfade",
    ],
  },

  // ------------------------------------------------------------- the mix stage
  {
    id: 'no-stem-gains',
    why: 'the per-stem fader / mute / solo stage is never posted, so every stem plays at unity',
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'gain', i, value: g.meter[i], tau: BOUNCE_TAU });", to: 'void g;' }],
    reds: [
      "each stem arrives at its OWN gain: fader x crossfader x master, against the analytic weighted sum",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "soloing one stem leaves the other five below it by a RATIO, not by a threshold",
      "a muted stem contributes nothing, as a ratio against an unmuted one",
    ],
  },
  {
    id: 'no-crossfader',
    why: 'the crossfader factors are never posted',
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'xf', i, value: g.xf[i], tau: BOUNCE_TAU });", to: 'void i;' }],
    reds: [
      "...and both ends are at the level the settings say, so a uniform attenuation cannot pass the ratio",
      "each stem arrives at its OWN gain: fader x crossfader x master, against the analytic weighted sum",
      "an assign of B on deck A is silent at every crossfader position — the hard-assign kill, as a ratio",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "...and the soloed stem is at its OWN unchanged level, so attenuating everything cannot pass the ratio",
      "...and the other five are exactly where they were, so a mute that muted the bus cannot pass",
    ],
  },
  {
    id: 'no-master-gain',
    why: "the deck's master gain is never posted",
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'gain', i: G_MASTER, value: dbToGain(s.masterDb), tau: BOUNCE_TAU });", to: 'void G_MASTER;' }],
    reds: [
      "each stem arrives at its OWN gain: fader x crossfader x master, against the analytic weighted sum",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
    ],
  },
  {
    id: 'crossfader-applied-twice',
    why: 'the POST-crossfader gain is posted into the metered slot as well, so it lands twice',
    edits: [{ file: F_OFF, find: 'value: g.meter[i], tau: BOUNCE_TAU', to: 'value: g.stems[i], tau: BOUNCE_TAU' }],
    reds: [
      "...and both ends are at the level the settings say, so a uniform attenuation cannot pass the ratio",
      "each stem arrives at its OWN gain: fader x crossfader x master, against the analytic weighted sum",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "...and the soloed stem is at its OWN unchanged level, so attenuating everything cannot pass the ratio",
      "...and the other five are exactly where they were, so a mute that muted the bus cannot pass",
    ],
  },
  {
    id: 'bounce-tau-is-TAU.master',
    why: 'the settings are posted with the 20 ms smoothing every other caller uses, so a bounce spends '
      + '120 ms sliding up to its own gains - and only 69.7 ms of that is inside the trim',
    edits: [{ file: F_OFF, find: 'const BOUNCE_TAU = 1e-5;', to: 'const BOUNCE_TAU = 0.020;' }],
    reds: [
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
    ],
  },
  {
    id: 'bounce-tau-is-the-worklet-default',
    why: 'tau omitted entirely, so the worklet falls back to its own 0.003',
    edits: [{ file: F_OFF, find: 'const BOUNCE_TAU = 1e-5;', to: 'const BOUNCE_TAU = 0.003;' }],
    equivalent: '6 x 0.003 = 18 ms of ramp, and the deliverable begins 3072 frames = 69.7 ms into the '
      + 'render, so the whole ramp is inside the trim and the FILE IS UNCHANGED. Measured, worst '
      + 'relative error against the analytic over the first 4410 frames of the file: 5.144e-9 at 1e-5 '
      + 'and 5.144e-9 at 0.003, against 1.959e-2 at 0.020. No assertion over the deliverable can '
      + 'separate 1e-5 from 0.003, and the anchor is kept so nobody re-derives that.',
  },
  {
    id: 'no-pitch-reset',
    why: 'the transpose is set with {t:pitch} alone, so the bank crossfade slides up from concert pitch',
    edits: [{ file: F_OFF, find: "node.port.postMessage({ t: 'reset' });", to: 'void node;' }],
    reds: [
      "the deliverable is at the transposed pitch from its FIRST sample, not after a bank crossfade",
    ],
  },
  {
    id: 'drums-are-transposed',
    why: 'lane 0 joins the shifted lanes - the naive "apply the transpose to all lanes"',
    edits: [{ file: F_WORKLET, find: 'const PITCH_SHIFTED_LANES = Object.freeze([1, 2, 3, 4, 5, 6]);', to: 'const PITCH_SHIFTED_LANES = Object.freeze([0, 1, 2, 3, 4, 5, 6]);' }],
    reds: [
      "the deliverable starts where the track starts — the transpose group delay is trimmed off the head",
      "...and each stem is at that gain from the FIRST SAMPLE of the file — a bounce has no gestures, so it must not spend a smoothing constant sliding up to its own settings",
      "the drums are NOT transposed: at +5 the deliverable is the click train back, sample for sample",
    ],
  },

  // ------------------------------------------------------- the snapshot record
  {
    id: 'settings-shared-by-reference',
    why: 'bounceSettings aliases the live deck, so a fader moved after the bounce was asked for changes the record',
    edits: [{ file: F_ENGINE, find: '    mix: deck.mix.map((m) => ({ gainDb: m.gainDb, muted: !!m.muted, soloed: !!m.soloed })),', to: '    mix: deck.mix,' }],
    reds: [
      "a fader moved after the bounce was asked for does not reach the render: `mix` is COPIED, element by element",
    ],
  },
  {
    id: 'settings-assign-by-reference',
    why: 'the crossfader assign array aliases the live deck',
    edits: [{ file: F_ENGINE, find: 'assign: deck.xf.assign.slice()', to: 'assign: deck.xf.assign' }],
    reds: [
      "...and neither does the crossfader column: `assign` is COPIED",
    ],
  },

  // -------------------------------------------------------- progress and cancel
  {
    id: 'no-progress-callback',
    why: 'progress is never reported, so a render of minutes has nothing to draw',
    edits: [{ file: F_OFF, find: '        if (o.onProgress) o.onProgress({ frame: r.frame, frames: total, pct: r.frame / total });', to: '        void o;' }],
    reds: [
      "progress ticks ONCE PER PRODUCER STOP, at the frames the plan named, monotonically",
      "a producer that failed mid-render is a RENDER_FAILED naming the frame and the second — never a finished bounce, and never an unhandled rejection",
    ],
  },
  {
    id: 'cancel-flag-never-read',
    why: 'the cancel poll at the producer stops is dropped',
    edits: [{ file: F_OFF, find: '        if (o.cancelled && o.cancelled()) { cancelledAt = r.frame; return; }', to: '        void o;' }],
    reds: [
      "a cancelled bounce SETTLES rather than hanging, says CANCELLED, and names the stop it ACTUALLY stopped at",
      "...and nothing lands: the Host is never asked for a destination and no byte is written",
    ],
  },
  {
    id: 'cancel-not-polled-after-the-render',
    why: 'THE D2 REGRESSION: the last poll goes, and BOUNCE_CANCEL is a silent no-op on every track '
      + 'shorter than one refill period - 5.94 s at the shipped ring',
    edits: [{ file: F_OFF, find: '  if (cancelledAt < 0 && o.cancelled && o.cancelled()) cancelledAt = plan.quantaFrames;', to: '  void o;' }],
    reds: [
      "a bounce with no producer stop at all is STILL cancellable — it is not a no-op below 5.94 s",
    ],
  },
  {
    id: 'cancel-names-the-first-stop',
    why: 'THE D3 REGRESSION: the message reports plan.refills[0] whatever stop actually cancelled it',
    edits: [{
      file: F_OFF,
      find: 'throw bounceError(\'CANCELLED\', `at render frame ${cancelledAt} of ${plan.quantaFrames}`',
      to: 'throw bounceError(\'CANCELLED\', `at render frame ${plan.refills[0] ? plan.refills[0].frame : 0} of ${plan.quantaFrames}`',
    }],
    reds: [
      "a cancelled bounce SETTLES rather than hanging, says CANCELLED, and names the stop it ACTUALLY stopped at",
    ],
  },
  {
    id: 'no-cancel-throw',
    why: 'a cancelled bounce resolves as if it had finished, and the file is written',
    edits: [{ file: F_OFF, find: '  if (cancelledAt >= 0) {', to: '  if (false) {' }],
    reds: [
      "a cancelled bounce SETTLES rather than hanging, says CANCELLED, and names the stop it ACTUALLY stopped at",
      "...and nothing lands: the Host is never asked for a destination and no byte is written",
      "a bounce with no producer stop at all is STILL cancellable — it is not a no-op below 5.94 s",
    ],
  },

  // ------------------------------------------------------- the guards and the seam
  {
    id: 'no-track-shape-guard',
    why: 'renderBounce stops checking that every stem is at least as long as the track',
    edits: [{ file: F_OFF, find: '  for (const s of STEMS) {\n    const ch = track.stems && track.stems[s];', to: '  for (const s of []) {\n    const ch = track.stems && track.stems[s];' }],
    reds: [
      "a stem SHORTER than the track is NO_TRACK naming the stem — not a deliverable that is silently not the track",
      "...and a MISSING stem is the same refusal, and a complete track is not refused at all",
    ],
  },
  {
    id: 'no-failure-rethrow',
    why: 'a producer that failed mid-render is presented to the caller as a finished bounce',
    edits: [{ file: F_OFF, find: '  if (failure) throw failure;', to: '  if (false) throw failure;' }],
    reds: [
      "a producer that failed mid-render is a RENDER_FAILED naming the frame and the second — never a finished bounce, and never an unhandled rejection",
    ],
  },
  {
    id: 'producer-throws',
    why: 'LAYER 1 of the guard: a producer that throws mid-render must be a NAMED red naming the frame',
    expectText: 'the producer failed at frame',
    edits: [{ file: F_OFF, find: '        fill();\n        if (o.onProgress)', to: "        fill();\n        if (r.frame) throw new Error('mutation');\n        if (o.onProgress)" }],
    // Section 3 throws before its FIRST assertion, so that section contributes
    // the guard's own named red and nothing else — which is why the count drops
    // to 68 of 72 rather than staying at 72. Section 10(a) reds too: the
    // mutation throws at every stop, so `failure` is set before the third stop
    // cancels and the re-throw reports RENDER_FAILED instead of CANCELLED.
    reds: [
      "3. THE LONG FIXTURE — a bounce longer than the stem ring — THE SECTION THREW and the assertions after the throw never ran",
      "a cancelled bounce SETTLES rather than hanging, says CANCELLED, and names the stop it ACTUALLY stopped at",
      "a producer that failed mid-render is a RENDER_FAILED naming the frame and the second — never a finished bounce, and never an unhandled rejection",
    ],
  },
  {
    id: 'guard-without-its-finally',
    why: 'LAYER 2 of the guard: the cancel path leaves the suspension callback through a bare `return`, '
      + 'so without the finally the render never resumes and the whole suite HANGS',
    expect: 'hung',
    edits: [{ file: F_OFF, find: '      } finally {\n        ctx.resume();\n      }', to: '      }\n      ctx.resume();' }],
  },
  {
    id: 'sink-map-check-dropped',
    why: 'a Host answering a map without the asked-for name yields undefined instead of a refusal',
    edits: [{ file: F_OFF, find: '  const writable = map && map[name];', to: '  const writable = (map && map[name]) || Object.values(map || {})[0];' }],
    reds: [
      "a Host that answers a map without the file it was asked for is a REFUSAL, not five of six files",
    ],
  },
  {
    id: 'filename-separator-scrub-dropped',
    why: 'a title with a path separator survives into the base name, so a Host can be made to write outside its folder',
    edits: [{ file: F_ENGINE, find: ".replace(/[\\\\/:*?\"<>|]/g, '_')", to: '' }],
    reds: [
      "the file name is a BASE name: no separator survives, so a Host cannot be made to write outside its folder",
    ],
  },

  // ------------------------------------------------------------------ the wire
  {
    id: 'engine-invents-a-code',
    why: "the wire emits a code the unit never declared - the ARM_CODES failure, on the emitting side",
    edits: [{ file: F_ENG, find: "if (bouncing[id]) return void bounceFailed(id, 'BUSY');", to: "if (bouncing[id]) return void bounceFailed(id, 'BOUNCE_BUSY');" }],
    reds: [
      "...and every literal one of them is a code engine/bounce.js declares — the ARM_CODES failure, checked on the EMITTING side",
    ],
  },
  {
    id: 'wire-code-swallows-an-invented-code',
    why: 'bounceWireCode stops validating, so an ENOSPC out of writeBounce reaches BOUNCE_ERROR.code',
    edits: [{ file: F_ENGINE, find: '  return isBounceCode(code) ? code : \'RENDER_FAILED\';', to: '  return code || \'RENDER_FAILED\';' }],
    reds: [
      "a code the unit never declared is folded to RENDER_FAILED before it reaches the wire — driven, because that call site carries no literal to scan for",
    ],
  },
  {
    id: 'refusal-conflated',
    why: 'THE D1 REGRESSION: both empty-deck states report one code, so the user is left guessing',
    edits: [{ file: F_ENGINE, find: "  return d && d.live ? 'NOT_CACHED' : 'NO_TRACK';", to: "  return 'NOT_CACHED';" }],
    reds: [
      "a deck with nothing loaded and a deck playing live are DIFFERENT refusals — driven, one state at a time, and the code READ BACK",
      "flipping EITHER fact on its own changes the answer, so neither is decoration — the check the first repair of this defect would have failed",
    ],
  },
  {
    id: 'refusal-ignores-liveness',
    why: 'THE FIRST REPAIR OF D1, REPRODUCED: the refusal is decided from the CachedDeck alone, so an '
      + 'unloaded deck and a live one are the same state and NO_TRACK is reachable only while priming',
    edits: [{ file: F_ENGINE, find: "  if (d && d.cachedTrack) return null;\n  return d && d.live ? 'NOT_CACHED' : 'NO_TRACK';", to: "  if (!d) return 'NOT_CACHED';\n  return d.cachedTrack ? null : 'NO_TRACK';" }],
    reds: [
      "a deck with nothing loaded and a deck playing live are DIFFERENT refusals — driven, one state at a time, and the code READ BACK",
      "flipping EITHER fact on its own changes the answer, so neither is decoration — the check the first repair of this defect would have failed",
    ],
  },
  {
    id: 'engine-derives-liveness-from-the-cache',
    why: 'the engine answers the liveness question from cachedDecks, which cannot see it: stopCached '
      + 'nulls the entry, so an unloaded deck reads exactly like a live one',
    edits: [{ file: F_ENG, find: '          live: deckIsLive(decks[id]),', to: '          live: !cd,' }],
    reds: [
      "...and it hands bounceRefusal the LIVENESS fact, because stopCached drops the CachedDeck on unload and `!cd` cannot tell an unloaded deck from a live one",
    ],
  },
  {
    id: 'engine-copies-the-liveness-predicate',
    why: 'the arm count spells the live predicate out again instead of calling deckIsLive, so the two '
      + 'can disagree about what "live" means',
    edits: [{ file: F_ENG, find: 'const n = liveDecks().filter((d) => d.prepared || deckIsLive(d)).length;', to: "const n = liveDecks().filter((d) => d.prepared || d.status === 'recording' || (d.live.status !== 'idle' && d.live.status !== 'error')).length;" }],
    reds: [
      "...and it hands bounceRefusal the LIVENESS fact, because stopCached drops the CachedDeck on unload and `!cd` cannot tell an unloaded deck from a live one",
    ],
  },
];

const HUNG_MS = 45000;
const RUN_MS = 180000;

function readAll() {
  const m = new Map();
  for (const f of [F_ENGINE, F_OFF, F_WORKLET, F_ENG]) m.set(f, fs.readFileSync(path.join(ROOT, f), 'utf8'));
  return m;
}
function restore(orig) {
  for (const [f, src] of orig) fs.writeFileSync(path.join(ROOT, f), src);
}
function runSuite(timeoutMs) {
  const r = spawnSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26 });
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\x1b\[[0-9;]*m/g, '');
  const reds = out.split('\n').filter((l) => /^\s{2}FAIL /.test(l)).map((l) => l.trim().replace(/^FAIL\s+/, ''));
  const m = out.match(/(\d+) passed, (\d+) failed/);
  return { code: r.status, out, reds, passed: m ? +m[1] : 0, failed: m ? +m[2] : 0,
    timedOut: r.error != null && (r.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(r.error.message))) };
}

/**
 * THE SET COMPARISON, IN BOTH DIRECTIONS.
 *
 * Patterns are substrings of assertion NAMES rather than whole lines, because a
 * detail line carries measured figures that move. A red line must be explained
 * by EXACTLY ONE pattern - two patterns matching one line would let a
 * declaration silently cover less than it appears to.
 */
function compareRedSet(declared, observed) {
  const unexplained = [];
  const hits = new Map(declared.map((d) => [d, 0]));
  const ambiguous = [];
  for (const line of observed) {
    const m = declared.filter((d) => line.includes(d));
    if (m.length === 0) unexplained.push(line);
    else if (m.length > 1) ambiguous.push(`${m.length} patterns match: ${line.slice(0, 90)}`);
    else hits.set(m[0], hits.get(m[0]) + 1);
  }
  const missing = declared.filter((d) => hits.get(d) === 0);
  return { ok: unexplained.length === 0 && missing.length === 0 && ambiguous.length === 0, unexplained, missing, ambiguous };
}

const orig = readAll();
let dirty = false;
const rows = [];
try {
  console.log(`\x1b[1mbounce mutation battery — anchors cut against ${CUT_AGAINST}\x1b[0m\n`);

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
    if (!found.every((n) => n === 1)) {
      rows.push({ id: a.id, matched: false, verdict: null, note: `occurrences ${found.join('/')} (want 1 each)` });
      continue;
    }
    dirty = true;
    for (const e of a.edits) {
      const p = path.join(ROOT, e.file);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(e.find, e.to));
    }
    const r = runSuite(a.expect === 'hung' ? HUNG_MS : RUN_MS);
    restore(orig); dirty = false;

    if (a.expect === 'hung') {
      /**
       * TWO SIGNATURES OF THE SAME HANG, and node gives the cheaper one. A
       * top-level `await` that never settles makes node exit 13
       * (ERR_UNSETTLED_TOP_LEVEL_AWAIT) with NO summary line at all - the hang,
       * detected by the runtime instead of by the clock. A wall-clock timeout is
       * the fallback for a hang node cannot see. Neither is a red: a hung suite
       * reports nothing, which is the whole point of layer 2.
       */
      const unsettled = r.code === 13 && r.passed === 0 && r.failed === 0;
      rows.push({
        id: a.id, matched: true, verdict: (r.timedOut || unsettled) ? 'red' : 'MISS',
        note: r.timedOut ? `HUNG — no result in ${HUNG_MS / 1000} s of wall clock`
          : unsettled ? 'HUNG — node exited 13, ERR_UNSETTLED_TOP_LEVEL_AWAIT, and the suite printed no summary at all'
            : `did NOT hang: ${r.passed} passed, ${r.failed} failed, exit ${r.code}`,
      });
      continue;
    }

    if (a.equivalent) {
      const green = r.code === 0 && r.failed === 0 && r.passed === base.passed;
      rows.push({
        id: a.id, matched: true, verdict: green ? 'equiv' : 'MISS',
        note: green ? `GREEN by construction, ${r.passed} passed — ${a.equivalent}`
          : `DECLARED EQUIVALENT BUT IT WENT RED: ${r.failed} of ${r.passed + r.failed} — the declaration `
            + `is wrong, or the suite grew an assertion that CAN see it: ${r.reds[0] || '(no FAIL line)'}`,
      });
      continue;
    }

    const reds = r.code !== 0 && r.failed > 0;
    const first = r.reds[0] || '(no FAIL line)';
    let note = `${r.failed} red of ${r.passed + r.failed}: ${first.slice(0, 200)}`;
    let verdict = reds ? 'red' : 'MISS';
    if (a.expectText && !r.reds.some((l) => l.includes(a.expectText))) {
      verdict = 'MISS';
      note = `no red mentioned ${JSON.stringify(a.expectText)} — ${note}`;
    }
    const set = compareRedSet(a.reds || [], r.reds);
    if (verdict === 'red' && !set.ok) {
      verdict = 'SET';
      note = `${r.failed} red, but the SET differs`
        + (set.missing.length ? ` — declared and NOT red: ${set.missing.map((x) => JSON.stringify(x)).join(', ')}` : '')
        + (set.unexplained.length ? ` — red and NOT declared: ${set.unexplained.map((x) => JSON.stringify(x.slice(0, 70))).join(', ')}` : '')
        + (set.ambiguous.length ? ` — ambiguous: ${set.ambiguous.join('; ')}` : '');
    }
    rows.push({ id: a.id, matched: true, verdict, note, observed: r.reds });
  }
} finally {
  if (dirty) restore(orig);
  const after = readAll();
  let clean = true;
  for (const [f, src] of orig) if (after.get(f) !== src) { clean = false; console.log(`\x1b[31mNOT RESTORED: ${f}\x1b[0m`); }
  if (!clean) process.exitCode = 3;
}

if (LEARN) {
  console.log('\n\x1b[1m--learn: the red set each anchor OBSERVED (paste-ready, and not evidence)\x1b[0m');
  for (const r of rows) {
    if (!r.observed) continue;
    console.log(`\n  ${r.id}:`);
    for (const line of r.observed) console.log(`      ${JSON.stringify(line.split('  ')[0])},`);
  }
}

console.log('\n\x1b[1m  anchor                                  MATCHES  VERDICT  what happened\x1b[0m');
let matched = 0, red = 0, equiv = 0, bad = 0;
for (const r of rows) {
  if (r.matched) matched++;
  if (r.verdict === 'red') red++;
  if (r.verdict === 'equiv') equiv++;
  if (!r.matched || r.verdict === 'MISS' || r.verdict === 'SET') bad++;
  const m = r.matched ? '\x1b[32myes\x1b[0m    ' : '\x1b[31mNO \x1b[0m    ';
  const v = r.verdict === 'red' ? '\x1b[32mRED  \x1b[0m'
    : r.verdict === 'equiv' ? '\x1b[36mEQUIV\x1b[0m'
      : r.verdict === 'SET' ? '\x1b[31mSET! \x1b[0m'
        : r.verdict === null ? '\x1b[33m---  \x1b[0m' : '\x1b[31mMISS \x1b[0m';
  console.log(`  ${r.id.padEnd(39)} ${m} ${v}   ${r.note}`);
}
console.log(`\n  ${matched}/${rows.length} anchors still MATCH their source  ·  ${red} RED with the declared set  ·  `
  + `${equiv} EQUIVALENT by construction  ·  ${bad} needing attention`);
if (matched < rows.length) console.log('  \x1b[33mre-cut every anchor that no longer matches: the instrument has decayed, silently\x1b[0m');
if (rows.some((r) => r.verdict === 'MISS')) console.log('  \x1b[31man anchor that matches and no longer reds is decay OR A REAL COVERAGE LOSS — investigate\x1b[0m');
if (rows.some((r) => r.verdict === 'SET')) console.log('  \x1b[31ma red set that differs is coverage that MIGRATED — the total cannot see it, which is why it is declared per case\x1b[0m');
if (bad === 0) console.log('  \x1b[32mevery anchor applies, and every one produced exactly the reds it declared\x1b[0m');
process.exit(bad === 0 ? 0 : 1);
