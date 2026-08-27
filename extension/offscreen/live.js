/**
 * ONE DECK of live buffered playback. Owns that deck's causal scheduler, its
 * playback worklet and its backpressure ladder. Everything pure lives in
 * engine/live.js; this file is the plumbing that connects one capture ring, one
 * inference worker and one playback worklet.
 *
 * Mode 1 runs a single instance (deck 'A'). Mode 3 runs two, sharing ONE
 * AudioContext, ONE master bus (offscreen/master.js) and ONE GPU token
 * (engine/scheduler.js), with a separate inference Worker each.
 *
 * Message contract (fixed by the spec; the console UI builds to the same one).
 * Every message in and out carries `deck: 'A' | 'B'`; the deck field is injected
 * by the `send` dependency, so nothing in this file has to remember it.
 *
 *   UI -> here   LIVE_START {deck} · LIVE_STOP {deck} · SET_HOP {seconds}
 *                STEM_GAIN {deck, stem, gainDb} · STEM_MUTE {deck, stem, muted}
 *                STEM_SOLO {deck, stem, soloed} · MASTER_GAIN {deck, gainDb}
 *                XFADER {position} · XF_CURVE {curve} · XF_ASSIGN {deck, stem, target}
 *                PITCH {deck, semitones}  -> setPitch(), integer in [-6, +6]
 *   here -> UI   LIVE_STATE {deck, status, bufferSec, targetSec, rtf, drops, key, bpm, ...} ~10 Hz
 *                METERS {deck, peak:{...}, rms:{...}}                             ~30 Hz
 *                LIVE_ERROR {deck, code, message}
 *
 * `LIVE_STATE.key` is `{state, concertTonic, mode, confidence}` and the engine
 * reports the CONCERT tonic only — it never applies the transpose offset and
 * never learns which instrument the user plays. The UI calls
 * `chroma.js::displayKey(concertTonic, mode, semitones, instrument)`: one
 * mod-12, one function, one call site. See engine/keytap.js::payload().
 *
 * `LIVE_STATE.bpm` is its sibling — `{state, bpm, confidence, beatFrame}` from
 * engine/bpmtap.js, tapped off the `drums` planes of the same ring on the same
 * 10 Hz heartbeat. `beatFrame` is an ABSOLUTE stem-ring frame and the ONE way to
 * turn it into a phase is `bpmtap.js::beatPhaseAt()`; do not add a `phase` field
 * here, for the reason that file's payload() gives.
 *
 * It has a FIFTH state this file adds and the module does not: `'fault'`, with a
 * `fault` string and a `faults` count beside it. The detector runs inside the
 * heartbeat, so it may not throw into it — but "degrade to no estimate" and
 * "silently do nothing" are the same wire value unless the failure is named, and
 * a feature that quietly reports nothing when it breaks is indistinguishable
 * from one that is working and hearing nothing. See bpmPayload().
 *
 * SET_HOP, XFADER and XF_CURVE are GLOBAL — no deck field. The hop especially:
 * two decks on different hops emit audio seconds apart and nothing beat-matches
 * (docs/AUDIO.md §8.1), so the offscreen document applies one hop to both.
 *
 * LIVE_ERROR codes, and which are advisory (the console's ADVISORY_CODES must
 * stay in step; tools/run-ext.mjs asserts the two sets are identical):
 *   HOP_PENDING · HOP_MARGINAL           advisory — the deck is still playing
 *   CHUNK_FAILED · PUMP_FAILED · HALTED  the pipeline is broken
 *   START_FAILED · NOT_CAPTURING         it never started
 *   OUTPUT_STALLED · OUTPUT_SILENT       it is running and you are hearing
 *   OUTPUT_DEAD                          NOTHING. See watchOutput(); the three
 *                                        cover DISJOINT regions of the chain —
 *                                        the render thread stopped, the master
 *                                        bus ate it, and the deck never produced
 *                                        it. All three are FATAL to the console
 *                                        (they are not in ADVISORY_CODES), which
 *                                        is correct: a deck making no sound is
 *                                        stopped as far as the user is concerned.
 *
 * Gain messages take the fast path (UI -> offscreen in one hop) and are applied
 * inside the playback worklet, so a fader move is audible in ~1 render quantum
 * plus the output latency — NOT one hop later. That is the point of the whole
 * design (docs/ARCHITECTURE.md §1.6).
 */

import {
  SR, SEGMENT, STEMS, STEM_RING_FRAMES, LIVE_HOPS, LIVE_HOP_DEFAULT, SEAM_XFADE_MS,
  SEAM_XFADE_LAW, LIVE_CUSHION_SEC, LIVE_LOW_WATER_SEC, LIVE_PANIC_FADE_MS,
  TAU, METER_HZ, HEALTH_HZ, MARGINAL_P95_FRACTION, MARGINAL_DROP_RATE,
  XF_CURVE_DEFAULT, XF_ASSIGN_DEFAULT, XF_POSITION_DEFAULT, XF_CURVES, XF_TARGETS,
  KEY_ACCUM_HZ, KEY_ESTIMATE_HZ,
} from '../shared/config.js';
import { StemRingWriter, stemRingByteLength } from '../shared/stemring.js';
import { ensurePlaybackWorklet } from './worklets.js';
import { makeLivePlan, chunkPlan, LiveEmitter, readWindow, primedPct, skipFrames, STEM_PLANES } from '../engine/live.js';
import { resolveDeckGains, dbToGain } from '../engine/mixer.js';
// Imported, not duplicated. This one number is the transpose's whole latency
// contribution and it appears in three readouts below; a second copy of it is a
// second place to be wrong, and it would be wrong SILENTLY (the video lock's
// threshold is 60 ms and this is 69.7 ms).
import { PITCH_GROUP_DELAY_SAMPLES, PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES } from '../engine/pitch.js';
import { KeyTap } from '../engine/keytap.js';
import { BpmTap } from '../engine/bpmtap.js';

/**
 * Worklet gain slots: `0..STEMS.length-1` stems, then passthrough, then master —
 * so at six stems that is 0..5 stems, 6 passthrough, 7 master
 * (docs/SIX-STEM-CONTRACT.md; offscreen/playback-processor.js sizes its gain
 * arrays as `NSTEMS + 2` from the same layout).
 *
 * DERIVED, NOT WRITTEN DOWN. The literals 4 and 5 were correct for exactly as
 * long as there were four stems, and a stale passthrough slot index is silent:
 * the message lands on a stem's slot instead, so a dropped chunk would duck the
 * wrong channel and nothing would report it.
 */
const G_PASS = STEMS.length, G_MASTER = STEMS.length + 1;

/** consecutive chunk failures before live mode halts instead of limping */
const MAX_CHUNK_FAILS = 3;

/**
 * The tempo tap's cadence: fed at 10 Hz, re-estimates at 2 Hz — the same numbers
 * the key tap runs at, and deliberately NOT the same constants.
 * `KEY_ACCUM_HZ`/`KEY_ESTIMATE_HZ` are sized against a 16384-point FFT window and
 * chroma.js's display policy; these are sized against bpmtap.js's 8 s envelope
 * history and its 800-sample autocorrelation. They agree today because two
 * independent answers came out the same, which is not a dependency — importing
 * one for the other would mean a future change to the key tap silently retunes
 * the tempo detector, and that is the exact shape of defect keytap.js's
 * `tap-point-*` tripwires exist to catch one file over.
 *
 * WHAT THIS PAIR COSTS, AS A COUNT. At `estimateHz` the autocorrelation runs at
 * most once per `tick()` (bpmtap.js asserts it: `maxPerTick` is under two
 * estimate intervals by construction), and one tick consumes at most
 * `BPM_MAX_BLOCKS_PER_TICK` = 4 blocks of 4410 frames however far the producer
 * has jumped ahead. So the work per second of wall clock is BOUNDED — 10 ticks,
 * <= 40 blocks, <= 2 autocorrelations — and it does not grow with the hop, the
 * deck count or a stall. That is the citable claim (AGENTS.md: ratios
 * and counts are citable, absolutes are not). The module prints a millisecond
 * figure beside those counts as evidence; do not re-type it here, it moves with
 * the front end and with whatever machine last ran the suite.
 */
const BPM_ACCUM_HZ = 10, BPM_ESTIMATE_HZ = 2;

/**
 * How long a playing deck may produce digital zero before OUTPUT_DEAD, seconds.
 * A track can legitimately open with a few seconds of nothing; three seconds is
 * longer than any intro and shorter than a user's patience.
 */
export const OUTPUT_DEAD_HOLD_SEC = 3;

/**
 * THE HOLD, AS THE COUNT THE CLAIM IS ACTUALLY MADE IN: frames of audio the
 * listener has been HANDED and heard nothing in. Not ticks, not milliseconds.
 *
 * WHY THIS IS NOT A COSMETIC RE-EXPRESSION. The hold used to be
 * `deadTicks >= OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ` — 30 heartbeats — and a
 * heartbeat is a `setInterval` callback, i.e. a stopwatch wearing a counter's
 * clothes. Its verdict moved with how fast this laptop happened to be running
 * the main thread, and it fired 4/4 at hop 1.0 and 0/2 at hop 1.95 on the SAME
 * BUILD with a 0.2 s margin (the diagnosis of 2026-08-16). AGENTS.md: *a gate
 * whose verdict changes on code that did not change is measuring the machine*,
 * and *if a claim can be carried by a COUNT, do not carry it with a stopwatch.*
 *
 * `StemRingWriter.readFrames()` is the audio device's own clock: it advances at
 * exactly SR frames per second of real audio delivered, whatever the main thread
 * is doing. A blocked main thread misses heartbeats and the frame delta still
 * accounts for every frame the user sat through; a fast one cannot make the
 * counter run early. The alarm therefore says *"you heard three seconds of
 * nothing"* and means it, on any machine, at any hop.
 *
 * IT ALSO SPLITS THE ARMS PROPERLY. If the audio thread stops entirely the read
 * pointer stops with it, this arm goes quiet, and OUTPUT_STALLED — which is the
 * instrument for that failure — is the one that fires. Two codes, two failures,
 * no double report.
 */
export const OUTPUT_DEAD_HOLD_FRAMES = Math.round(OUTPUT_DEAD_HOLD_SEC * SR);

/** Peak below this at the worklet's own meter tap is digital zero, not "quiet". */
export const MIXER_SILENT_PEAK = 1e-6;

/**
 * ONE TICK of the third output watchdog arm — "this deck is playing and it is
 * producing NOTHING", the failure the other two arms are structurally unable to
 * see. Pure, so `node test.js live` can drive it without an audio graph.
 *
 * WHY IT HAD TO BE A THIRD ARM RATHER THAN A LOOSER SECOND ONE. `OUTPUT_SILENT`
 * fires on `meters.peak.master > 1e-3 && busPeak < 1e-6` — it requires the
 * playback worklet to be SUMMING SIGNAL, so it can only ever catch a break
 * BELOW the summing point (a zeroed crossfader or master slot, an unassigned
 * curve, a missing connect). `OUTPUT_STALLED` fires when the worklet stops
 * posting `health`, which it does from inside `process()` — a deck emitting
 * digital zero heartbeats perfectly. So a deck whose audio is zero AT OR ABOVE
 * the stem-gain slots — a silent capture, an all-zero model output, a ring that
 * is written but empty — raises no alarm at all, and that is exactly the report
 * this arm exists for: buffer moving, every meter dead, no sound, no error.
 *
 * The two arms cover disjoint regions and neither is widened: this one only
 * fires when even the PRE-crossfader stem meters are zero, which is the one
 * state `OUTPUT_SILENT` can never be in.
 *
 * IT MUST FAIL WHEN IT CANNOT LOOK (AGENTS.md). A playing deck that has never
 * reported a meter frame is `blind`, and `blind` counts toward the alarm — it is
 * the failure, not an excuse from it.
 *
 * BOTH EXCUSES ARE INDEPENDENT OF THE MEASUREMENT (`AGENTS.md`) — they are read
 * off OUR OWN STATE, so the silence being excused cannot manufacture its own
 * excuse. There are exactly two, and each is a case where digital black is the
 * ratified correct output:
 *
 *   1. every resolved gain is zero — the user killed or muted everything;
 *   2. the speaker is inside a PUBLISHED PASSTHROUGH SPAN and the passthrough
 *      gain is zero. That is QA-15's ratified ducking rule (engine/mixer.js
 *      passthroughGain: "never louder than the quietest thing the user asked to
 *      hear"), so a dropped chunk with a killed stem is SILENT ON PURPOSE. At
 *      hop 1.0 with a stem killed that is 57 s of a 71 s run (STATUS §3a) —
 *      without this branch the watchdog would cry wolf on the ratified
 *      behaviour, which is the failure this project has been burned by twice.
 *      `passthroughNow` comes from `passSpans` and the ring read pointer, not
 *      from the audio.
 *
 * TWO INPUT READINGS, TWO CLOCKS, AND THAT IS THE FIX RATHER THAN AN ACCIDENT.
 * This function used to take one `inputPeak`, read from `ring.peaks()` — the
 * CAPTURE clock, i.e. what the tab is producing *now* — and compare it against
 * `meters`, which is the SPEAKER, `latencySec()` behind. Two different points on
 * one delay line, treated as simultaneous. When a tab woke up mid-count the
 * verdict flipped `dead-input -> dead-mixer` with nothing in the mixer changing,
 * and since the console picks the remedy off the variant, the user was told to
 * restart a working deck instead of to press play in their tab. The two remedies
 * are opposites, so this was not a cosmetic mislabel.
 *
 * The two readings answer two different questions and each gets the only clock
 * that can answer it:
 *
 *   inputPeakPlayed — WHAT WAS OWED. The capture-ring peak over the frames the
 *     output has just played. Output frame n is by construction the audio
 *     captured at live-relative capture frame n (see latencySec()), so this is
 *     the SAME AUDIO at two points in the chain and the comparison is exact.
 *     `null` means we could not sample it, which is never an excuse — see below.
 *
 *   inputPeakNow — WHETHER THE DECK IS ABOUT TO PAY. The capture-ring peak at
 *     the capture clock. It cannot say anything about what the speaker is
 *     carrying; it is the only thing that can say audio is IN FLIGHT.
 *
 * That yields a seventh verdict, `inflight`, and it is the honest answer to the
 * state that produced the false alarm: nothing at the speaker, nothing was owed
 * at those frames (the tab was silent then), and the tab is producing audio now.
 * The deck is not dead — it is `latencySec()` behind, which is its job. It is
 * NOT in DEAD_VERDICTS and it resets the counter.
 *
 * `inflight` cannot excuse a real break: it requires `inputPeakPlayed` to be
 * silent, i.e. the deck owed nothing over the frames in question. A mixer that
 * eats live audio reads `dead-mixer` and fires exactly as before.
 *
 * FAIL WHEN IT CANNOT LOOK. A `null` inputPeakPlayed does not suppress the
 * alarm and does not get to claim the tab was silent: the deck is still dead,
 * and the verdict is `dead-mixer` — the deck-side remedy — because telling a
 * user their video is paused is a claim, and we do not make claims on evidence
 * we could not read. `LivePipeline.inputWindowMisses` counts every such tick so
 * a gate can see the degradation instead of inferring it.
 *
 * NEITHER READING GATES THE ALARM ITSELF: a value read off the system under
 * test must not be able to talk the instrument out of firing.
 *
 * IT LOOKS AT EVERY STEM IN `STEMS`, NOT AT FOUR NAMES. The list used to be
 * spelled `p.drums, p.bass, p.other, p.vocals` — which at six stems would have
 * made a deck emitting nothing but guitar and piano read as digital black and
 * raise OUTPUT_DEAD on a working deck. Driving it off `STEMS` is also what keeps
 * the missing-key check below honest: it can only know a key is missing if it
 * knows which keys it is owed.
 *
 * @param {object} t
 * @param {boolean} t.playing        the playback ring's PLAY flag
 * @param {{peak:Record<string,number>}|null} t.meters
 *        the last METERS frame from the worklet — one entry per `STEMS` name
 *        plus `master` — or null if none has arrived
 * @param {{meter:number[], pass:number}|null} t.gains  resolveDeckGains() output
 * @param {boolean} t.passthrough    is the speaker inside a published drop span?
 * @param {number|null} t.inputPeakPlayed capture-ring peak over the frames the
 *        output just played — the OUTPUT's clock. null = could not sample.
 * @param {number} t.inputPeakNow    capture-ring peak now — the CAPTURE clock.
 * @returns {'idle'|'signal'|'asked'|'inflight'|'blind'|'dead-input'|'dead-mixer'}
 */
export function outputTick({ playing, meters, gains, passthrough, inputPeakPlayed, inputPeakNow = 0 }) {
  if (!playing) return 'idle';
  if (!meters || !meters.peak) return 'blind';
  if (gains && Math.max(gains.pass, ...gains.meter) <= 0) return 'asked';
  if (gains && passthrough && gains.pass <= 0) return 'asked';
  const p = meters.peak;
  /**
   * A FRAME THAT IS SHORT A STEM IS `blind`, NOT `signal` (AGENTS.md).
   *
   * The old line was `Math.max(p.drums, …, p.master)` with `!(loudest <= FLOOR)`
   * and a comment claiming NaN fell through to dead. It did not: `NaN <= 1e-6`
   * is false, so `!false` returned **'signal'** — the watchdog reporting a
   * healthy deck precisely on the frames it could not read. Harmless while the
   * four names were the whole contract and lethal the moment they were not: a
   * worklet still posting a 4-stem meter array to a 6-stem `byStem()` yields
   * `guitar = <master's value>` and `master = undefined`, i.e. exactly this
   * frame. That build is broken, and OUTPUT_DEAD after the hold is the correct,
   * loud answer for it.
   */
  let loudest = p.master;
  if (!Number.isFinite(loudest)) return 'blind';          // no master reading at all
  for (const s of STEMS) {
    const v = p[s];
    if (!Number.isFinite(v)) return 'blind';              // a stem this frame does not carry
    if (v > loudest) loudest = v;
  }
  if (loudest > MIXER_SILENT_PEAK) return 'signal';
  // Nothing at the speaker. WHAT WAS OWED decides which failure this is, and it
  // is read at the output's own clock; see the header. The floor is the same
  // MIXER_SILENT_PEAK the stems are judged against, so the two sides of the
  // comparison are on one scale — and it changes nothing for `inputPeakNow`,
  // whose smallest non-zero value is 1/32767 = 3.05e-5 (the capture worklet
  // stores its peak as a 16-bit integer).
  if (!Number.isFinite(inputPeakPlayed)) return 'dead-mixer';       // could not look
  if (inputPeakPlayed > MIXER_SILENT_PEAK) return 'dead-mixer';     // audio was owed
  return inputPeakNow > MIXER_SILENT_PEAK ? 'inflight' : 'dead-input';
}

/**
 * Verdicts that mean the listener is hearing nothing they did not ask for.
 *
 * `inflight` is deliberately absent: it is the state where the tab is producing
 * audio the deck has not delivered yet, which is a working deck one latency
 * behind, not a dead one.
 */
const DEAD_VERDICTS = new Set(['blind', 'dead-input', 'dead-mixer']);

/**
 * The worklet's index-keyed meter array -> the stem-keyed METERS contract.
 * `master` is the entry AFTER the last stem, which is how
 * offscreen/playback-processor.js sizes it (`NSTEMS + 1`).
 *
 * GENERATED FROM `STEMS`, and there is an identical (deliberately separate)
 * derivation in offscreen/cacheddeck.js — a cached deck and a live deck must be
 * indistinguishable to the mixer, so they must publish the same shape. Both read
 * the same source of truth, so this is one wire order expressed twice, not two
 * wire orders.
 *
 * A SHORT ARRAY IS NOT PATCHED UP HERE. If the worklet is still posting four
 * stems, `master` comes out `undefined` and `outputTick` returns `blind` on the
 * very next tick — a loud OUTPUT_DEAD on a genuinely broken build, which is the
 * behaviour we want. Filling the gap with zeros would have made that build read
 * as a working deck playing silence.
 */
function byStem(a) {
  const o = {};
  for (let i = 0; i < STEMS.length; i++) o[STEMS[i]] = a[i];
  o.master = a[STEMS.length];
  return o;
}



export class LivePipeline {
  /**
   * @param {object} deps
   * @param {() => AudioContext} deps.ctx        the one 44100 Hz context
   * @param {() => import('../shared/ring.js').RingConsumer} deps.ring  capture ring
   * @param {(mixBuf:ArrayBuffer, outBuf:ArrayBuffer) => Promise<any>} deps.infer
   * @param {() => Promise<void>} deps.ensureModel
   * @param {(msg:object) => void} deps.send     to the UI (injects `deck`)
   * @param {(line:string) => void} deps.log
   * @param {() => import('./master.js').MasterBus} deps.master  the ONE master bus
   * @param {(relPath:string) => string} deps.assetUrl  the Host's asset resolver
   *        (../shared/host.js), handed down by offscreen/deck.js
   * @param {'A'|'B'} [deps.deck]
   */
  constructor(deps) {
    this.d = deps;
    /** 'A' | 'B'. Mode 1 is deck 'A' and nothing else changes. */
    this.deck = deps.deck || 'A';
    this.status = 'idle';
    /**
     * What `priming` is waiting FOR. `status:'priming'` covers two completely
     * different waits — a 172 MiB model download on first run, and filling the
     * causal ring — and a console that cannot tell them apart shows a blank
     * two-minute bar. Non-null only while priming.
     *   'model' — loading/verifying weights and creating the session. Byte-level
     *             progress is on the separate STATE message; this field only
     *             says WHICH progress UI to show.
     *   'ring'  — building the graph and waiting for the first chunk.
     */
    this.phase = null;
    this.node = null;
    this.shaper = null;
    this.pre = null;
    this.post = null;
    /** AnalyserNode on `post` — the last node before ctx.destination. See build() */
    this.probe = null;
    this.probeBuf = null;
    this.sab = null;
    this.out = null;          // StemRingWriter
    this.plan = null;
    this.emitter = null;
    this.hopSeconds = LIVE_HOP_DEFAULT;

    this.k = 0;
    this.baseFrame = 0;       // capture-ring frame at which live mode started
    /** session counter — bumped by start(); see runChunk's staleness check */
    this.gen = 0;
    this.inFlight = false;
    this.stopped = true;
    this.drops = 0;
    this.overruns = 0;
    /**
     * THE DRAIN'S OWN BOOKKEEPING (U7, #44), and `drainAbandoned` is the half
     * that must be TRUE rather than reassuring. A drain that did not happen and
     * was not counted is a recording that is one buffer short with nothing
     * saying so — the defect this whole path exists to remove, wearing a
     * success line. Every early return in `drain()` below either counts here or
     * is a state where there was genuinely nothing to recover.
     */
    this.drainedFrames = 0;
    this.drainAbandoned = 0;
    this.drainWhy = null;
    this.staleReads = 0;
    this.chunkMs = [];
    this.chunkLog = [];
    /** consecutive chunk failures; 3 in a row is a broken pipeline, not a blip */
    this.chunkFails = 0;
    this.marginalWarned = false;
    /** chunk 0's wall time. NO LONGER the whole story — see armPlayback(). */
    this.firstChunkMs = 0;
    /** the T actually used to arm this session, ms. 0 until armed. */
    this.armMs = 0;
    /**
     * Did the arm decision have chunk 0's measured cost available?
     *
     * false when the LADDER armed playback during priming (fill() -> armPlayback
     * with firstChunkMs still 0) and playback had already STARTED by the time
     * chunk 0 landed, so the floor could not be applied retroactively. In that
     * case `armMs` is the shared-GPU estimate and comparing it to chunk 0 is
     * comparing a decision against information it did not have — which is what
     * A4 was doing, and why it went red 2 runs in 4 while the engine was correct.
     */
    this.armedOnChunk0 = false;
    this.lastMeters = null;
    this.health = { cushionFrames: 0, cushionMinFrames: 0, underruns: 0, underrunFrames: 0, playedFrames: 0, faded: false };
    /** rolling per-100 ms cushion minima from the worklet; see bufferMinSec() */
    this.minWindow = [];
    this.minWindowLen = 1;
    /** recent passthrough output spans, so `passthroughNow` is a fact not a guess */
    this.passSpans = [];
    this.startTimer = null;
    this.pushTimer = null;
    /** pending workletReport() calls, keyed by request id */
    this.reportWaiters = new Map();
    this.reportId = 0;
    /**
     * Output watchdog. Three times now this project has shipped a change that
     * was 100 % green and 100 % silent, because every gate reads the SAB or the
     * worklet and both are upstream of the failure. These two counters are the
     * engine noticing on its own; see watchOutput().
     */
    this.lastHealthAt = 0;
    this.silentTicks = 0;
    /** latch: which output alarm has already been raised this session, if any */
    this.outputAlarm = null;
    /** the OUTPUT_DEAD verdict AT THE TRIPPING TICK. Null for every other alarm. */
    this.outputAlarmVariant = null;
    /**
     * The third arm — see outputTick(). `outputVerdict` is the LAST verdict and
     * `outputChecks` counts how many times the arm actually reached one while
     * the deck was playing. Both are on stats() and DIAG for one reason: without
     * them a gate cannot tell "the watchdog looked and saw signal" from "the
     * watchdog never ran", and those two report the same green.
     */
    this.deadTicks = 0;
    /**
     * THE ONE THE ALARM IS DECIDED ON — frames of audio the listener has been
     * handed while every meter read digital zero. `deadTicks` is kept beside it
     * as the diagnostic it always was (DIAG and stats() both print it), but it
     * is a count of heartbeats and a heartbeat is a stopwatch; see
     * OUTPUT_DEAD_HOLD_FRAMES for why the verdict may not rest on one.
     */
    this.deadFrames = 0;
    /** the playback read pointer at the previous watchOutput(), for the delta */
    this.lastPlayedFrame = 0;
    /**
     * Ticks on which the capture window under the played frames could not be
     * read — the span was longer than the probe buffer, or the ring had already
     * lapped it. The alarm still fires on those ticks (it is a dead deck either
     * way); what is withheld is the CLAIM that the tab was silent. On the wire
     * as a count so "we degraded to the deck-side remedy" is visible instead of
     * having to be inferred from a variant.
     */
    this.inputWindowMisses = 0;
    /**
     * The capture peak over every played window of the CURRENT dead span, and
     * whether any window in it could not be read. `-1` means nothing has been
     * sampled into it yet — deliberately not `0`, which is a measurement.
     */
    this.deadOwedPeak = -1;
    this.deadOwedMissed = false;
    this.outputVerdict = null;
    this.outputChecks = 0;

    this.mix = STEMS.map(() => ({ gainDb: 0, muted: false, soloed: false }));
    /**
     * Crossfader state. `position` and `curve` are GLOBAL (both decks are given
     * the same values by offscreen.js); `assign` is per (deck, stem) and is this
     * deck's own column of the master assign matrix. See engine/mixer.js
     * xfFactor() for what the three targets mean.
     */
    // NOTE `position` here is the EFFECTIVE position this deck is applying, not
    // the user's control value — offscreen.js pushes the parked/resolved number.
    // It goes on the wire as `xf.effective` for that reason; do not "fix" the
    // wire name back to match this field, fix this field's name if anything.
    this.xf = { position: XF_POSITION_DEFAULT, curve: XF_CURVE_DEFAULT, assign: STEMS.map(() => XF_ASSIGN_DEFAULT) };
    /** L3: chunks the shared scheduler refused because they could not land in time */
    this.demotions = 0;
    /**
     * Master gain for THIS deck, dB, and who chose it. The engine applies
     * DUAL_MASTER_TRIM_DB when a second deck loads; `masterUserSet` latches the
     * moment the user touches it and the engine stops. Both are on the wire
     * because the engine moves this control WITHOUT the user touching it — the
     * same reason XF_STATE carries `position` AND `effective`.
     */
    this.masterDb = 0;
    this.masterAuto = true;
    this.masterUserSet = false;
    /**
     * Per-stem transpose, semitones, integer in [-6, +6]. Drums are NEVER
     * shifted (engine/pitchbank.js); they take a matched delay of exactly the
     * same length so all STEMS.length planes stay sample-aligned structurally.
     *
     * The value lives here AND in the worklet, and this copy is the one that
     * goes on the wire. It deliberately SURVIVES a stop/start: a transpose is a
     * mixer control like the master trim, and a deck that silently returned to
     * concert pitch on a re-prime would put the user in the wrong key with no
     * gesture to blame.
     */
    this.semitones = 0;
    /**
     * The key detector's window onto the `other` plane. Main thread, ~10 Hz, and
     * UPSTREAM of the pitch shifter by construction — it reads the stem ring,
     * which is what the worklet reads FROM. See engine/keytap.js.
     */
    this.keyTap = new KeyTap({ sampleRate: SR, accumHz: KEY_ACCUM_HZ, estimateHz: KEY_ESTIMATE_HZ });
    /** performance.now() of the last key window, so extra pushState(true) calls do not over-sample */
    this.keyAt = 0;
    /**
     * The tempo detector's window onto the `drums` planes. Same thread, same
     * ring, same 10 Hz heartbeat and the same upstream-of-the-shifter tap point
     * as the key detector — see engine/bpmtap.js, which argues both halves.
     *
     * Run UNCONDITIONALLY on both decks and not behind a flag. The BPM readout is
     * embed-only (single deck) by product ruling, but a flag would be a second thing
     * to be wrong about which surface is up — and the cost is BOUNDED BY A COUNT
     * rather than by a measurement (see BPM_ACCUM_HZ above): 10 ticks a second,
     * at most 4 blocks each, at most 2 autocorrelations, per deck, on a thread
     * whose deadline is a 1.95 s hop. Two decks is twice a bounded number, not an
     * unbounded one. The cheap correct thing is to always know the tempo and let
     * the surface decide whether to paint it.
     */
    this.bpmTap = new BpmTap({ sampleRate: SR, accumHz: BPM_ACCUM_HZ, estimateHz: BPM_ESTIMATE_HZ });
    /** performance.now() of the last tempo block, gated exactly like keyAt */
    this.bpmAt = 0;
    /**
     * A LATCHED tempo-detector fault, and the count behind it. Null means the tap
     * has never thrown this session. Both go on the wire — see bpmPayload(); a
     * detector that breaks and reports the same "no estimate" as a detector that
     * is merely listening is a feature reporting success for the same reason a
     * vacuous assertion does.
     */
    this.bpmFault = null;
    this.bpmFaults = 0;
    /**
     * Prime-then-play cache writer, or null. Owned by shared/stemcache.js; this
     * class only knows two things about it, and they are both invariants rather
     * than features — see runChunk() and skipOne().
     */
    this.cacheWriter = null;

    // scratch, allocated once — the live path must not allocate per chunk.
    // `STEMS.length * 2 channels * SEGMENT frames * 4 bytes per float`: the
    // leading factor is the stem count, the trailing 4 is sizeof(float).
    this.mixBuf = new ArrayBuffer(2 * SEGMENT * 4);
    this.outBuf = new ArrayBuffer(STEMS.length * 2 * SEGMENT * 4);
    this.passL = null;
    this.passR = null;
    /**
     * The watchdog's window onto the capture ring, one second wide, allocated
     * ONCE for the same reason everything else here is: the 10 Hz heartbeat is
     * on the same thread as the pump and must not allocate.
     *
     * ONE SECOND IS TEN TIMES THE SPAN A HEARTBEAT COVERS (4410 frames at
     * HEALTH_HZ), and the excess is the point: the probe must cover the played
     * frames CONTIGUOUSLY or the claim "the tab was digitally silent" is a claim
     * about the gaps as well as the samples. A tick more than 1 s late overruns
     * it, and that is counted as a miss rather than papered over — see
     * inputPeakOver().
     */
    this.probeL = new Float32Array(SR);
    this.probeR = new Float32Array(SR);
  }

  // -------------------------------------------------------------------- setup
  setHop(seconds) {
    const s = LIVE_HOPS.includes(seconds) ? seconds : LIVE_HOP_DEFAULT;
    if (s === this.hopSeconds) return;
    this.hopSeconds = s;
    this.d.log(`live hop -> ${s} s`);
    // Applied at the next start. Changing it mid-flight would need a re-prime
    // (the whole schedule is derived from H) and the audible result is the same
    // as a restart, so we do not pretend otherwise.
    if (this.status !== 'idle') this.d.send({ type: 'LIVE_ERROR', code: 'HOP_PENDING', message: 'Hop applies on the next Start.' });
  }

  /** Build this deck's playback graph and hang it on the shared master. Idempotent. */
  async build() {
    if (this.node) return;
    const ctx = this.d.ctx();
    // Mode 3 puts BOTH decks on one AudioContext and both play through the same
    // processor, so whether it is already registered is a fact about the CONTEXT
    // rather than about this pipeline. offscreen/worklets.js owns it — including
    // why only a name collision is survivable.
    await ensurePlaybackWorklet(ctx, this.d.assetUrl);

    this.sab = new SharedArrayBuffer(stemRingByteLength(STEM_RING_FRAMES));
    this.out = new StemRingWriter(this.sab, STEM_RING_FRAMES);

    this.node = new AudioWorkletNode(ctx, 'stem-playback', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: {
        sab: this.sab, capacity: STEM_RING_FRAMES, sampleRate: ctx.sampleRate,
        panicFadeMs: LIVE_PANIC_FADE_MS, lowWaterSec: LIVE_LOW_WATER_SEC,
        meterHz: METER_HZ, healthHz: HEALTH_HZ,
      },
    });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);

    // ONE master bus for both decks (offscreen/master.js). Everything from the
    // summing point to ctx.destination — the global meter, the 4x-oversampled
    // soft clipper and its ±headroom gain pair, and the audibility analyser —
    // lives there and is shared, because a per-deck clipper cannot protect the
    // SUM: two decks each peaking at 0.9 hand the DAC 1.8 while both clippers
    // sit idle.
    //
    // These four are BORROWED references, not owned. Every Mode 1 gate that
    // reads `live.shaper.oversample`, `live.post`, `live.probe` off "the deck's
    // graph" keeps working unchanged; dispose() must not disconnect them while
    // the other deck is still playing.
    const master = await this.d.master().build();
    this.pre = master.pre;
    this.shaper = master.shaper;
    this.post = master.post;
    this.probe = master.probe;
    this.probeBuf = master.probeBuf;
    this.node.connect(master.input());
  }

  /**
   * What the last node before `ctx.destination` is actually carrying, plus the
   * facts that decide whether that node has anywhere to carry it TO. Read-only
   * and cheap; safe to call on a running deck.
   *
   * `busPeak` is the honest end-of-chain level. It is NOT the master meter: the
   * per-deck meter is computed inside the playback worklet, PRE-soft-clip, and
   * is therefore blind to everything this probe covers. In Mode 3 the bus is
   * SHARED, so `busPeak` is both decks summed — which is the right answer for
   * "is anything reaching the speaker" and the wrong one for "is this deck
   * audible". `sameContext` is the per-deck half and stays here.
   */
  outputProbe() {
    const ctx = this.d.ctx();
    const master = this.d.master();
    if (!ctx || !this.node || !master || !master.post) return { built: false };
    return {
      ...master.probeState(),
      // is the whole chain on the ONE context that is actually rendering?
      sameContext: this.node.context === ctx && master.pre.context === ctx &&
                   master.shaper.context === ctx && master.post.context === ctx,
      deck: this.deck,
    };
  }

  /**
   * Does the edge `post -> ctx.destination` EXIST, right now, in the live graph?
   * Interrogates the graph rather than trusting our own bookkeeping — see
   * MasterBus.probeTerminal(). Dev/diagnostic only: it mutates the graph for
   * zero render quanta.
   */
  probeTerminal() {
    const master = this.d.master();
    if (!master) return { terminalIsDestination: false, why: 'no graph' };
    return master.probeTerminal();
  }

  // -------------------------------------------------------------------- start
  async start() {
    // Review finding P3-H1: 'error' was a terminal state here. fail() halts with
    // status='error' after MAX_CHUNK_FAILS, and no shipped UI path sends
    // LIVE_STOP while the deck is not running — so the console's Retry button
    // sent LIVE_START straight into this guard and the deck stayed dead for the
    // life of the offscreen document. Same shape as the armPlayback lock-off.
    // A halted deck must be restartable without a document reload.
    if (this.status === 'error') this.status = 'idle';
    if (this.status !== 'idle') return;
    // A halted run leaves no timers (fail() clears them), but a restart must
    // never be able to stack a second 10 Hz pushState interval either way.
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null; }
    /**
     * THE DETECTORS ARE RESET BEFORE THE FIRST PUSH, NOT AFTER IT.
     *
     * They used to be cleared a dozen lines below, next to the rest of the
     * session state — which is after `pushState(true)` has already gone out
     * twice (`phase:'model'`, then `phase:'ring'`) and after an `await` on the
     * model load that is ~3.4 s at hop 1.95 on a cold session. For that whole
     * priming window LIVE_STATE carried the PREVIOUS TRACK'S key and BPM: not a
     * stale readout that catches up, a WRONG one that is indistinguishable from
     * a correct one, sitting under a brand-new track's title. Both detectors
     * argue the same thing about their own reset (a BPM held over from the
     * previous track is a wrong readout, an autocorrelation across a track seam
     * INVENTS a periodicity) and both were then published across the seam
     * anyway, because the reset was in the wrong place rather than missing.
     *
     * The rest of the session state stays where it is: nothing else is on the
     * wire before `build()` returns.
     */
    this.keyTap.reset();
    this.keyAt = 0;
    this.bpmTap.reset();
    this.bpmAt = 0;
    // ...and the latched fault with them. A new session is a new chance, and a
    // fault that outlived the pipeline that caused it would be unclearable
    // without reloading the offscreen document — while `state:'fault'` from the
    // last track sat on the wire through the whole priming window.
    this.bpmFault = null;
    this.bpmFaults = 0;
    this.status = 'priming';
    this.phase = 'model';
    this.pushState(true);

    await this.d.ensureModel();
    this.phase = 'ring';
    this.pushState(true);
    await this.build();

    this.plan = makeLivePlan(this.hopSeconds, SEAM_XFADE_MS);
    this.emitter = new LiveEmitter(this.plan, SEAM_XFADE_LAW);
    this.passL = new Float32Array(this.plan.H);
    this.passR = new Float32Array(this.plan.H);
    this.lowWaterFrames = Math.round(LIVE_LOW_WATER_SEC * SR);
    // Rolling trough window = 3 hops. Two would be enough to guarantee the window
    // always contains a full trough whatever its phase; three costs nothing, is
    // robust to a hop landing late, and gives the alarm a natural ~6 s hold at the
    // default hop so it cannot chatter off the instant one chunk recovers.
    this.minWindowLen = Math.max(3, Math.ceil(3 * this.plan.hopSeconds * HEALTH_HZ));
    this.minWindow = [];
    this.passSpans = [];
    // Reallocated per session on purpose (19.4 MB at six stems, once): a live
    // session must be unable to inherit a detached or half-owned buffer from the
    // previous one.
    this.mixBuf = new ArrayBuffer(2 * SEGMENT * 4);
    this.outBuf = new ArrayBuffer(STEMS.length * 2 * SEGMENT * 4);
    this.gen++;               // anything still in flight belongs to the old session
    this.k = 0;
    this.drops = 0;
    this.chunkFails = 0;
    this.overruns = 0;
    this.staleReads = 0;
    this.demotions = 0;
    this.chunkMs = [];
    this.chunkLog = [];
    this.firstChunkMs = 0;
    this.armMs = 0;
    // A new session must never append into the previous session's prime.
    this.cacheWriter = null;
    this.marginalWarned = false;
    this.inFlight = false;
    this.stopped = false;
    this.drainedFrames = 0;
    this.drainAbandoned = 0;
    this.drainWhy = null;
    this.lastHealthAt = performance.now();
    this.silentTicks = 0;
    this.outputAlarm = null;
    this.outputAlarmVariant = null;
    this.deadTicks = 0;
    this.deadFrames = 0;
    this.lastPlayedFrame = 0;
    this.inputWindowMisses = 0;
    this.deadOwedPeak = -1;
    this.deadOwedMissed = false;
    this.outputVerdict = null;
    this.outputChecks = 0;
    this.lastMeters = null;      // a new session must not inherit the old one's frame
    // A new session is a hard discontinuity (docs/ARCHITECTURE.md §3.9): the ring
    // counters go back to 0 and the audio is a different piece of music, so the
    // key accumulator and the transpose lanes must not carry anything across.
    // The worklet's `reset` below does the lanes.
    this.out.reset();
    /**
     * THE DETECTORS ARE RESET TWICE, AND THE SECOND CALL IS NOT BELT-AND-BRACES.
     *
     * The first (top of this function) is about the WIRE: nothing from the last
     * track may be published during the priming window. This one is about the
     * RING, and it has to be after `out.reset()`: the two priming pushes above
     * each run the 10 Hz heartbeat, which ticks both taps against the stem ring
     * as it stood a moment ago — the PREVIOUS session's audio and, worse, the
     * previous session's write pointer. `bpmtap`/`keytap` anchor their cursor on
     * that pointer, so a tap left anchored there sits permanently ahead of a
     * write pointer that has just restarted at 0, refuses every block as `early`,
     * and holds the old track's tempo forever with clean-looking stats.
     *
     * That is not hypothetical: moving the first reset up produced exactly it,
     * and `test.js live`'s "start() drops the locked tempo with it" went red with
     * `cursor 1117935 -> 1117935`. Two resets, two invariants, one line each.
     */
    this.keyTap.reset();
    this.bpmTap.reset();
    this.node.port.postMessage({ t: 'reset' });
    this.pushGains(0);                      // no ramp on the first push
    this.pushMaster(0);                     // slot G_MASTER — see pushMaster()
    this.pushPitch();                       // ...and the transpose — see pushPitch()
    this.baseFrame = this.d.ring().writeFrames();

    this.d.log(`live start · hop ${this.plan.hopSeconds}s (${this.plan.H} frames) · xfade ${this.plan.X} frames (${SEAM_XFADE_LAW})`);
    this.pushTimer = setInterval(() => this.pushState(), 1000 / HEALTH_HZ);
    this.pump();
  }

  /**
   * End the session. **THIS MAY TAKE ONE INFERENCE, and the promise it returns
   * means "drained or honestly abandoned" rather than "drained"** — a Host
   * author calling this from a user gesture needs both halves of that sentence.
   *
   * THE FLAG GOES UP FIRST AND THE DRAIN RUNS BEHIND IT (ruling 24). `stopped`
   * is what every other path — `pump()`, `runChunk()`'s post-await return,
   * `forceDrop()`, the heartbeat — checks to bail out, so it is set on the
   * first line and nothing races the drain. `drain()` does not consult it; it
   * has its own state and its own buffers.
   *
   * `{ drain: false }` IS FOR TEARDOWN AND ONLY TEARDOWN. A document going away
   * has a budget the browser may cut at any moment, and blocking it on an
   * inference risks losing more than the tail it was trying to save — so
   * `dispose()` passes it and the abandonment is COUNTED rather than quietly
   * skipped. A user's own stop may await one inference; a teardown may not.
   *
   * @param {{drain?: boolean}} [opts]
   */
  async stop({ drain = true } = {}) {
    if (this.status === 'idle') return;
    // FIRST LINE, before anything can await: everything else bails on this.
    this.stopped = true;
    // The drain runs BEFORE `this.plan = null` below, because it needs the
    // geometry, and before `status` stops meaning anything.
    if (drain) await this.drain();
    else if (this.plan && this.out && this.emitter && !this.emitter.finished) {
      this.drainAbandoned++;
      this.drainWhy = 'teardown: a document going away may not wait for an inference';
    }
    this.status = 'idle';
    this.phase = null;
    // Drop the plan so `hopSec` reports null when nothing is running. It used to
    // survive, so LIVE_STATE reported the LAST session's hop forever and the
    // console had to gate on `status` to avoid rendering a stale number — the
    // console compensating for the wire lying, which is how QA-17 happened.
    this.plan = null;
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null; }
    if (this.out) this.out.play(false);
    this.d.log(`live stop · ${this.k} chunks, ${this.drops} drops, ${this.health.underruns} underruns`
      + (this.drainedFrames ? `, drained ${this.drainedFrames} frames` : '')
      + (this.drainAbandoned ? `, DRAIN ABANDONED (${this.drainWhy})` : ''));
    this.pushState(true);
  }

  /**
   * Full teardown. The graph is expensive to rebuild but must not leak.
   *
   * Callers that reach here through a document going away must have stopped
   * with `{ drain: false }` — see `stop()`. This method itself cannot drain: it
   * is synchronous, and the emitter it would need is nulled below.
   */
  dispose() {
    if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null; }
    if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
    if (this.node) {
      this.node.port.postMessage({ t: 'stop' });
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    // pre/shaper/post/probe are BORROWED from the shared MasterBus — the other
    // deck may still be playing through them. Disconnecting them here would
    // silence a deck this call has nothing to do with. Drop the references only;
    // offscreen.js::teardown() owns the bus.
    this.node = this.pre = this.shaper = this.post = this.probe = null;
    this.probeBuf = null;
    this.out = null; this.sab = null; this.emitter = null;
    this.status = 'idle';
    this.stopped = true;
  }

  // ----------------------------------------------------------------- the pump
  /**
   * Called on every capture tick (~92.9 ms) and after every chunk completes.
   * Queue depth is exactly 1: an unbounded queue would let inference fall
   * arbitrarily behind while memory grew, and the audio would still be wrong.
   */
  pump() {
    if (this.stopped || !this.plan) return;
    const p = this.plan;
    const cap = this.d.ring().writeFrames() - this.baseFrame;

    // ---- backpressure L2: skip the late chunk, fill its span with passthrough.
    // The decision itself is `skipFrames` in engine/live.js — pure, and driven
    // against a simulated clock by `node test.js live`. It runs EVEN WITH A
    // CHUNK IN FLIGHT; that chunk is discarded when it lands (runChunk), which
    // is what "skip the late chunk" has to mean if the skip is to arrive in time
    // to be useful. Never emits silence: the span comes out of the input ring's
    // retained history, so a dropout degrades to unseparated audio.
    for (;;) {
      const n = skipFrames({
        cap, commit: this.emitter.commit, plan: p, k: this.k,
        playing: this.out.playing(), cushion: this.out.cushion(), lowWater: this.lowWaterFrames,
      });
      if (n === 0) break;
      this.skipOne(n);
    }

    if (this.inFlight) return;
    const c = chunkPlan(this.k, p);
    if (cap < c.inputEnd) return;             // not enough captured audio yet
    this.inFlight = true;
    this.runChunk(c).catch((e) => this.fail('CHUNK_FAILED', e));
  }

  /**
   * The deadline this chunk is measured against by the shared scheduler (L3):
   * ONE HOP, in milliseconds. That is the schedule's own contract — every chunk
   * gets exactly one hop of wall time, and the jitter cushion exists to absorb
   * the ones that overrun it.
   *
   * IT IS DELIBERATELY *NOT* THE RING DEPTH, and this cost a measurement to
   * learn, so it is written down rather than left as an obvious choice.
   *
   * The first version used the instantaneous cushion — "how much audio is left
   * before the listener hears a hole" — which reads as the honest number and is
   * catastrophically wrong as a scheduling input. The ring depth SAWTOOTHS by a
   * whole hop on every chunk (a chunk lands, depth jumps by 1.95 s, then
   * drains), so at the instant a chunk is submitted the depth is already partway
   * down its ramp — around 1.25 s at hop 1.95. Deck B's queue wait behind deck A
   * is ~0.4 s and one inference is ~1.0 s, so `wait + est` came to ~1.4 s
   * against a ~1.25 s "budget" and L3 demoted deck B on EVERY SINGLE HOP.
   * Measured, over 182 s: deck A 1 drop / 0 demotions, deck B 95 drops / 95
   * demotions — deck B was permanently unseparated on a machine with 15 % GPU
   * headroom that had just run the same pair cleanly for 45 s. The policy was
   * bistable on a coin-flip inequality, which is the worst possible property for
   * something that decides whether a deck makes music.
   *
   * The ring-depth question is real, but it is L2's, not L3's: `skipFrames`
   * already fires on `cushion < lowWater` with a MEASURED trough (see
   * bufferMinSec) rather than a prediction, and it degrades the same span to
   * passthrough. Having L3 predict the same failure from a noisier signal
   * double-counts it and fires first.
   *
   * So L3 answers only the question L2 cannot see, because it is about the OTHER
   * deck: "is the GPU so oversubscribed that this chunk cannot be delivered
   * within its hop even though nothing is wrong with this deck?" On this machine
   * that needs `wait + est > 1950 ms`, i.e. deck A holding the GPU for the best
   * part of a second longer than usual, and it correctly never fires.
   */
  budgetMs() {
    if (!this.plan) return 0;
    const hopMs = this.plan.hopSeconds * 1000;
    // A chunk is worth running if it can make EITHER its schedule slot OR the
    // ring deadline — so the budget is the larger of the two, not the hop alone.
    //
    // Hop alone was too strict and it locked deck B out completely. Measured
    // under mashup routing at hop 1.95: deck A holds the token ~910 ms of every
    // hop, deck B's p95 estimate was ~1100 ms, and `wait + est` crossed 1950 ms
    // by a hair — so deck B was demoted, never completed a chunk, never
    // contributed a timing sample, and the same marginal inequality held
    // forever. 15 demotions in 15 hops with a 1.665 s buffer trough: a deck with
    // ample cushion, refused the GPU on the grounds that it might be late.
    //
    // The floor at one hop is what stops this becoming the OTHER failure. The
    // first version of this used the ring depth alone, and the ring depth
    // sawtooths by a whole hop — at submit time it is partway down its ramp
    // (~1.25 s at hop 1.95), which is BELOW `wait + est`, so that demoted every
    // hop too, bistably. Neither quantity is right on its own; the deck is fine
    // if either one says so.
    if (!this.out || !this.out.playing()) return hopMs;
    const cushionMs = (this.out.cushion() / SR) * 1000 - LIVE_PANIC_FADE_MS;
    return Math.max(hopMs, cushionMs);
  }

  async runChunk(c) {
    const t0 = performance.now();
    // Review finding P3-H3: which SESSION this chunk belongs to. `stopped` alone is
    // not enough — a LIVE_STOP immediately followed by a LIVE_START (that is
    // exactly what the console's re-prime button and the `P` key send, and
    // T_inf/hop ~= 45 % at hop 1.95, so a chunk is usually in flight) clears it
    // again before the old chunk lands. The old result then ran against the NEW
    // session's state: it cleared `inFlight` out from under the new session's
    // chunk, and `this.k = Math.max(this.k, c.k + 1)` dragged k forward by the
    // whole previous run, so the fresh deck produced nothing for k hops and then
    // threw a non-contiguous emitter error. A stale chunk must touch nothing.
    const gen = this.gen;
    const mix = new Float32Array(this.mixBuf);
    const ring = this.d.ring();
    // Zero-padded at startup by construction: inputStart is negative for the
    // first few chunks and readWindow zero-fills, so audio flows after one hop
    // instead of after 7.8 s. Quality ramps over the first segment (primedPct).
    const okL = readWindow(ring, this.baseFrame + c.inputStart, SEGMENT,
      mix.subarray(0, SEGMENT), mix.subarray(SEGMENT, 2 * SEGMENT));
    if (!okL) this.staleReads++;

    // the mix for the same span the chunk publishes — the passthrough source
    readWindow(ring, this.baseFrame + c.emitFrom, c.emitLen,
      this.passL.subarray(0, c.emitLen), this.passR.subarray(0, c.emitLen));

    // `infer` TRANSFERS both buffers, so they are detached from this side the
    // instant it is called. Reclaiming them is not optional and must happen
    // before ANY early return.
    //
    // The bug this replaces: `if (this.stopped) return` sat between the await and
    // the reclaim. A LIVE_STOP that landed while a chunk was in flight — a ~45 %
    // chance at hop 1.95 — left both scratch buffers permanently detached, and
    // every subsequent start() then threw "Cannot perform Construct on a detached
    // ArrayBuffer" on the first line of runChunk, once per capture tick, forever.
    let res;
    try {
      res = await this.d.infer(this.mixBuf, this.outBuf, this.budgetMs(), this.deck);
    } catch (e) {
      // A newer session owns this.mixBuf/this.outBuf now, and this failure is not
      // its failure. Drop the detached pair on the floor and say nothing.
      if (gen !== this.gen) return;
      // The buffers went to the worker and are not coming back (or never left).
      // Either way this side no longer owns anything usable.
      this.mixBuf = new ArrayBuffer(2 * SEGMENT * 4);
      this.outBuf = new ArrayBuffer(STEMS.length * 2 * SEGMENT * 4);
      this.inFlight = false;
      throw e;
    }
    // ---- backpressure L3: the shared GPU scheduler refused this chunk because
    // it could not have landed in time, and burning the GPU on it would have
    // delayed the priority deck's chunk as well. NOTHING WAS TRANSFERRED — the
    // scheduler returns before postMessage — so mixBuf/outBuf are still attached
    // and must NOT be reallocated or reclaimed. Publish the span as passthrough
    // exactly as a local L2 skip would, and say so.
    if (res && res.demoted) {
      if (gen !== this.gen) return;
      this.inFlight = false;
      if (this.stopped) return;
      this.demotions++;
      const cap = this.d.ring().writeFrames() - this.baseFrame;
      if (c.emitTo <= cap && c.emitTo > this.emitter.commit) {
        this.skipOne(c.emitTo - this.emitter.commit);
        if (this.demotions === 1 || this.demotions % 10 === 0) {
          this.d.log(`deck ${this.deck} L3 demoted chunk ${c.k}: ${res.why} (${this.demotions} total)`);
        }
      }
      this.pump();
      return;
    }
    // Stale result from a previous session: `res.mix`/`res.stems` are that
    // session's buffers, not the live ones. Let them be collected. Do NOT clear
    // inFlight (the current session's chunk owns it) and do NOT advance k.
    if (gen !== this.gen) return;
    this.mixBuf = res.mix;
    this.outBuf = res.stems;
    this.inFlight = false;
    if (this.stopped) return;

    const ms = performance.now() - t0;
    if (c.k === 0) this.firstChunkMs = ms;
    this.chunkMs.push(ms);
    if (this.chunkMs.length > 32) this.chunkMs.shift();
    // full series, for "does chunk time ramp through a long run?" — the
    // throttling question behind the hop-1.0 tiebreak. 4096 chunks = 68 min.
    if (this.chunkLog.length < 4096) this.chunkLog.push(Math.round(ms));
    this.k = Math.max(this.k, c.k + 1);
    this.chunkFails = 0;
    this.warnIfMarginal();

    if (c.emitTo <= this.emitter.commit) {
      // The ladder already filled this span from passthrough while the model was
      // still working on it. Throw the result away rather than rewrite frames the
      // playback worklet may already have read.
      this.pump();
      return;
    }

    const flat = new Float32Array(this.outBuf);
    const src = [];
    for (let q = 0; q < STEM_PLANES; q++) src.push(flat.subarray(q * SEGMENT, (q + 1) * SEGMENT));
    const e = this.emitter.chunk(c.k, src, this.passL, this.passR);
    if (!this.out.write(e.from, e.planes, e.len)) this.overruns++;
    // ---- prime-then-play cache: THE ONLY PLACE ANYTHING IS EVER CACHED.
    //
    // This is deliberately structural rather than a rule someone has to
    // remember. `runChunk` is the only path that publishes MODEL OUTPUT; every
    // unseparated span goes through skipOne() -> fill(), which is a different
    // function that aborts the prime instead of appending to it. So "only
    // separated audio is ever cached" is a property of the call graph, and
    // moving this line is the way to break it.
    if (this.cacheWriter) this.cacheWriter.append(e.planes, e.len);

    // A4: chunk 0 has landed. If the ladder already armed playback from fill()
    // during priming, it did so with `firstChunkMs` still 0 — i.e. on the
    // estimate alone, with no floor. Now that the real cost is known, re-anchor.
    // Safe precisely because nothing is playing yet: the timer is still pending,
    // so this moves a future start, not a live playhead. Same fix as A2, applied
    // to the floor instead of the offset.
    if (c.k === 0) this.armPlayback(true);
    this.pump();
  }

  /**
   * Say it out loud when the selected hop cannot be sustained on this machine.
   * Measured here (M2 Max, WebGPU): hop 1.0 s runs at RTF 0.80-0.84 with a worst
   * chunk of 1092 ms against a 1000 ms deadline — it works, but the margin is
   * ~15 % and the ladder has to cover the excursions with passthrough. The user
   * is entitled to know that before they wonder why the separation flickers.
   * Sent once per session; LIVE_ERROR is the only advisory channel in the
   * contract and the code makes the severity clear.
   */
  warnIfMarginal() {
    if (this.marginalWarned || this.chunkMs.length < 12) return;
    const deadlineMs = this.plan.hopSeconds * 1000;
    const p95 = this.p95ChunkMs();
    const dropRate = this.drops / Math.max(1, this.k);
    const tight = p95 > MARGINAL_P95_FRACTION * deadlineMs;
    const dropping = dropRate > MARGINAL_DROP_RATE;
    if (!tight && !dropping) return;
    this.marginalWarned = true;
    this.d.log(`hop ${this.plan.hopSeconds}s marginal: p95 ${p95.toFixed(0)}ms / ${deadlineMs}ms deadline, drops ${(dropRate * 100).toFixed(0)}%`);
    this.d.send({
      type: 'LIVE_ERROR', code: 'HOP_MARGINAL',
      message: `A ${this.plan.hopSeconds}s hop gives each separation pass ${deadlineMs} ms and this machine's slowest ` +
        `1 in 20 takes ${p95.toFixed(0)} ms (${(dropRate * 100).toFixed(0)} % of chunks already unseparated). ` +
        `Expect stretches of unseparated audio. Use a ${LIVE_HOP_DEFAULT}s hop for headroom.`,
    });
  }

  /**
   * p95 of the trailing chunk times. THE viability statistic — not the mean.
   * Measured on an M2 Max: hop 1.0 sustains RTF 0.89, i.e. the mean says it is
   * comfortable, while 45 % of chunks miss because the distribution oscillates
   * 753..1002 ms across a 1000 ms deadline. A mean test stays silent through
   * exactly the failure it is supposed to catch.
   */
  p95ChunkMs() {
    if (!this.chunkMs.length) return 0;
    const v = this.chunkMs.slice().sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(0.95 * v.length))];
  }

  /**
   * Publish one skipped chunk's span as passthrough and advance the schedule.
   * The only place `drops` is incremented — a span the user hears as unseparated
   * (or, if they have killed a stem, as silence) must always be counted.
   */
  skipOne(n) {
    // ---- THE FIRST PASSTHROUGH SPAN ABANDONS THE PRIME. No exceptions, no
    // "just this one", no threshold.
    //
    // A cached track containing unseparated stretches is permanently wrong and
    // UNDIAGNOSABLE: it plays back at full quality, in sync, with no counter and
    // no banner, and it sounds subtly bad forever. Every other degradation in
    // this engine is transient — the listener hears one bad span and the next
    // hop recovers — but a bad cache entry is the only one that outlives the
    // session that caused it. Re-priming costs the user one more listen of a
    // track they are already playing; a poisoned entry costs them trust in the
    // feature. `CacheWriter.abort()` is sticky and makes commit() return null,
    // so a single call here kills the whole prime, which is the intent.
    if (this.cacheWriter) {
      // COUNTED BEFORE IT IS ABORTED, and both, because they answer different
      // questions. `abort()` makes commit() return null — the entry does not
      // exist. `noteDrop()` records WHY, and it is the number a refusal can
      // name: "this recording dropped 3 chunks" instead of "this recording was
      // refused". `stemcache.js` says this is where the call belongs.
      this.cacheWriter.noteDrop();
      this.cacheWriter.abort();
    }
    this.fill(n);
    this.k++;
    this.drops++;
    if (this.drops === 1 || this.drops % 10 === 0) {
      this.d.log(`backpressure: chunk ${this.k - 1} -> passthrough (${this.drops} total)`);
    }
  }

  /**
   * Dev-only (`?dev=1` -> DEV_FORCE_DROP): fire the L2 rung on demand so the
   * harness can regression-test QA-15 deterministically instead of waiting for
   * the GPU to be slow. Takes exactly the same path a real drop takes.
   */
  forceDrop() {
    if (this.stopped || !this.plan || !this.out) return { fired: false, why: 'not running' };
    const cap = this.d.ring().writeFrames() - this.baseFrame;
    const c = chunkPlan(this.k, this.plan);
    const st = { k: this.k, cap, emitTo: c.emitTo, commit: this.emitter.commit, inFlight: this.inFlight };
    // Cannot publish audio that has not been captured yet: the span only becomes
    // fillable once the capture clock passes its end, which is X frames before
    // the chunk itself becomes runnable.
    if (c.emitTo > cap) return { fired: false, why: `span not captured yet (${c.emitTo - cap} frames short)`, ...st };
    if (c.emitTo <= this.emitter.commit) return { fired: false, why: 'span already published', ...st };
    this.skipOne(c.emitTo - this.emitter.commit);
    return { fired: true, why: 'forced', ...st };
  }

  /**
   * THE DRAIN (U7, #44) — one last inference over the audio the chunk grid can
   * never reach, so a recording ends where the capture ended.
   *
   * WHAT IS LEFT AND WHY. `chunk(k)` publishes `[emitFrom, inputEnd - X)`: the
   * last X frames of every model output are held back for the next chunk's
   * crossfade, and chunks only fire once the capture clock passes `(k+1)*H`. So
   * at stop the unpublished span is `F - commit`, under `H + X` — 1.05 s to
   * 3.95 s across the shipping ladder. `shared/stemcache.js` sized
   * `PRIME_TAIL_MAX_SEC` to tolerate that and named this fix in its own words:
   * "drain the pipeline's ring after the capture ends".
   *
   * IT USES ITS OWN BUFFERS, and that is not tidiness. `mixBuf`/`outBuf` are
   * DETACHED whenever a chunk is in flight — `infer` transfers them — and a
   * stop landing mid-chunk is the common case, not the rare one (~45 % at hop
   * 1.95, measured when the reclaim bug was found). Reaching for them here
   * would throw "Cannot perform Construct on a detached ArrayBuffer" on the
   * stop path. These are allocated once per RECORDING, at its end, which is the
   * distinction the retained-buffer count asserts: not per hop.
   *
   * EVERY EXIT EITHER RECOVERS FRAMES OR COUNTS THE ABANDONMENT. A drain that
   * silently did nothing is the original defect wearing a success line.
   */
  async drain() {
    const p = this.plan;
    // Nothing to drain, and nothing to count: these are states where no
    // recording is in progress at all.
    if (!p || !this.out || !this.emitter || this.emitter.finished) return;
    const ring = this.d.ring();
    if (!ring) { this.drainAbandoned++; this.drainWhy = 'the capture ring is already gone'; return; }
    const F = ring.writeFrames() - this.baseFrame;
    const len = F - this.emitter.commit;
    // The chunk grid already covers everything captured. Not an abandonment:
    // there is genuinely nothing left, which is the best case.
    if (len <= 0) return;
    if (len > p.H + p.X) {
      // Chunks were skipped and the ladder never filled the span. `finish()`
      // would refuse this and it would be right to: a span this long is gap()'s
      // work, not a drain's, and separating it with one pass would publish
      // audio the model saw almost no context for.
      this.drainAbandoned++;
      this.drainWhy = `${len} frames outstanding, more than one hop plus the crossfade (${p.H + p.X})`;
      return;
    }
    /**
     * ONE-SHOT BUFFERS. `passL`/`passR` are `H` frames and the drain can publish
     * `H + X`, so those cannot be borrowed either — a `subarray(0, len)` on a
     * short array silently under-reads and would publish the passthrough for
     * part of the span and stale scratch for the rest.
     */
    const mixBuf = new ArrayBuffer(2 * SEGMENT * 4);
    const outBuf = new ArrayBuffer(STEMS.length * 2 * SEGMENT * 4);
    const passL = new Float32Array(len), passR = new Float32Array(len);
    const mix = new Float32Array(mixBuf);
    readWindow(ring, this.baseFrame + F - SEGMENT, SEGMENT,
      mix.subarray(0, SEGMENT), mix.subarray(SEGMENT, 2 * SEGMENT));
    readWindow(ring, this.baseFrame + this.emitter.commit, len, passL, passR);

    let res;
    try {
      res = await this.d.infer(mixBuf, outBuf, this.budgetMs(), this.deck);
    } catch (e) {
      this.drainAbandoned++;
      this.drainWhy = `the final inference failed: ${String((e && e.message) || e)}`;
      return;
    }
    if (!res || res.demoted) {
      // The scheduler refused it. There is no later chunk to recover on, so
      // this is the end of the recording either way.
      this.drainAbandoned++;
      this.drainWhy = `the final inference was demoted: ${(res && res.why) || 'no result'}`;
      return;
    }
    // The emitter may have been torn down while the inference was running.
    if (!this.emitter || this.emitter.finished || !this.out) {
      this.drainAbandoned++;
      this.drainWhy = 'the session was disposed while the final inference was running';
      return;
    }
    const flat = new Float32Array(res.stems);
    const src = [];
    for (let q = 0; q < STEM_PLANES; q++) src.push(flat.subarray(q * SEGMENT, (q + 1) * SEGMENT));
    let e;
    try {
      e = this.emitter.finish(src, passL, passR, F);
    } catch (err) {
      // `finish()` refuses by name; carry the name rather than the fact.
      this.drainAbandoned++;
      this.drainWhy = String((err && err.message) || err);
      return;
    }
    if (!this.out.write(e.from, e.planes, e.len)) this.overruns++;
    // The same structural rule `runChunk` states: this is MODEL OUTPUT, so it
    // may be cached. A drain never publishes passthrough — if it could not
    // separate, it abandoned above rather than appending unseparated audio.
    if (this.cacheWriter) this.cacheWriter.append(e.planes, e.len);
    this.drainedFrames = e.len;
  }

  /** Passthrough fill for a skipped span. `len` may exceed one hop. */
  fill(len) {
    const p = this.plan;
    let left = len;
    while (left > 0) {
      const n = Math.min(left, p.H);
      readWindow(this.d.ring(), this.baseFrame + this.emitter.commit, n,
        this.passL.subarray(0, n), this.passR.subarray(0, n));
      const e = this.emitter.gap(n, this.passL, this.passR);
      if (!this.out.write(e.from, e.planes, e.len)) this.overruns++;
      this.passSpans.push({ from: e.from, to: e.from + e.len });
      if (this.passSpans.length > 64) this.passSpans.shift();
      left -= n;
    }
    if (!this.out.playing() && this.status === 'priming') this.armPlayback();
  }

  /**
   * Arm the playhead. This one number sets the deck's entire latency AND its
   * entire dropout budget, and getting it wrong does not fail loudly — it
   * produces a deck that plays perfectly and separates nothing.
   *
   * Zero-underrun needs a playback start offset S >= H + X + T, where T is the
   * time one chunk takes END TO END. Chunk 0 lands at H + T(0), so we hold for a
   * further X + LIVE_CUSHION_SEC. The cushion just before chunk k lands is then
   *
   *     cushion_trough = LIVE_CUSHION_SEC + T(0) - T(k)
   *
   * — the offset is anchored to ONE sample of a noisy distribution, and if T(0)
   * happens to be smaller than the steady-state T the trough is negative FOREVER.
   *
   * IN MODE 1 THAT WAS A `ponytail:` (shared/config.js LIVE_CUSHION_SEC). IN
   * MODE 3 IT IS FATAL, AND MEASURED. Two decks share one GPU, so the second
   * deck's chunks take roughly N x one inference — its own, plus the wait behind
   * the priority deck. But its CHUNK 0 runs before that steady state exists, so
   * T(0) is systematically the smallest sample the deck will ever see. Measured
   * over 340 s at hop 1.95: deck B armed with a chunk-0 offset, settled at a
   * 1471 ms steady-state chunk time, and spent the whole run with a 33 ms
   * cushion against a 120 ms low-water mark — 175 of 175 chunks published as
   * unseparated passthrough, with zero underruns and a perfectly healthy-looking
   * transport. The giveaway was that deck B reported LESS latency than deck A
   * (3.07 s vs 3.25 s) when it is the deck that waits.
   *
   * THE SAME MISTAKE, TWICE, FROM THE SAME HABIT. LIVE_CUSHION_SEC was first
   * derived from a spread measured over a 75 s window — one phase of an
   * oscillation longer than that — and this arm law was anchored to T_inf(chunk
   * 0), one sample taken at the least representative moment there is. Both were
   * a single observation of a noisy distribution, promoted to a permanent
   * constant. Before you size ANYTHING here off an observation, ask how many
   * samples it is and whether the moment you took it was typical; if the answer
   * is "one" and "no", you are about to write the third one.
   *
   * So the reference is no longer chunk 0's luck. `armRefMs` is supplied by the
   * offscreen document as `p95(observed inference) x (decks running)` — the
   * scheduler's own estimate of what a chunk will cost this deck once the GPU is
   * shared N ways. `max()` with T(0) keeps the Mode 1 guarantee that we never
   * arm with LESS cushion than the one chunk we have actually measured.
   *
   * The cost is honest and worth stating: dual deck arms ~1 s later than single
   * deck (4.4 s vs 3.4 s at hop 1.95), and both decks arm with the SAME offset,
   * so they no longer disagree about how far behind the music they are.
   */
  armPlayback(reanchor = false) {
    if (this.out.playing()) return;
    if (this.startTimer) {
      // Already scheduled. Only chunk 0 landing may revise it, and only because
      // it contributes the one datum the earlier call could not have: its own
      // measured cost.
      if (!reanchor || this.firstChunkMs <= this.armMs) return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.d.log(`re-anchoring the arm: chunk 0 took ${this.firstChunkMs.toFixed(0)} ms, ` +
        `more than the ${this.armMs.toFixed(0)} ms estimate the ladder armed on`);
    }
    // CLAMPED TO ONE HOP, and the clamp is load-bearing in both directions.
    //
    // Upward: the schedule gives every chunk exactly one hop. Arming for MORE
    // than a hop does not fix a deck whose chunks take longer than a hop — the
    // cushion drains by (T - hop) every single hop no matter how deep it starts,
    // so the only thing extra latency buys is a longer wait before the same
    // failure. Measured without the clamp: deck B armed 6.20 s behind (against
    // deck A's 3.44 s) because `estMs` had been poisoned by inferences that ran
    // WHILE the other deck's ORT session was being created — shader compilation
    // makes a concurrent pass take seconds — and one bad p95 sample at arm time
    // is permanent for the session.
    //
    // Downward: never below chunk 0's own measured time, which is the Mode 1
    // guarantee and the only hard datum we have.
    const raw = this.d.armRefMs ? this.d.armRefMs(this.deck) : 0;
    const capped = Math.min(Number.isFinite(raw) ? raw : 0, this.plan.hopSeconds * 1000);
    const t = Math.max(this.firstChunkMs, capped);
    this.armMs = t;
    this.armedOnChunk0 = this.firstChunkMs > 0;
    /**
     * ABSOLUTE, not additive. STATUS §4a A2.
     *
     * The offset S the schedule wants is measured from the FIRST CAPTURED FRAME:
     *   S = H + X + T + CUSHION      (engine/live.js, and derived in the comment above)
     * Playback must begin when the capture clock reaches S — not S after whenever
     * this function happens to be called.
     *
     * Adding a delay on top of "now" is correct only if "now" is the moment
     * chunk 0 lands, which is the entry point this law was written for. The other
     * entry point is fill(), which arms while the deck is still priming and only
     * fires once the ladder has already declared the deck `behind` — meaning
     * >= 2 hops of capture are banked before the timer even starts. The full
     * offset then goes on TOP of that bank and the session carries it forever:
     * measured at hop 1.0, 3.32-3.37 s against a 2.35 s budget when the ladder
     * armed, versus 2.486 s when chunk 0 did. latencySec was honest the whole
     * time — the deck really was a second further behind for no reason.
     *
     * Computing the target as a position on the capture clock makes it
     * self-correcting: arm late and the wait shrinks to nothing; arm on time and
     * this is arithmetically identical to what it replaced.
     */
    const targetFrames = this.plan.H + this.plan.X + (t / 1000) * SR + LIVE_CUSHION_SEC * SR;
    const capturedNow = Math.max(0, this.d.ring().writeFrames() - this.baseFrame);
    const delayMs = Math.max(0, ((targetFrames - capturedNow) / SR) * 1000);
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.stopped) return;
      this.out.play(true);
      this.status = 'running';
      this.phase = null;
      this.d.log(`playback armed · latency ${(this.plan.H / SR + this.plan.X / SR + t / 1000 + LIVE_CUSHION_SEC).toFixed(2)} s ` +
        `(hop ${(this.plan.H / SR).toFixed(2)} + xfade ${(this.plan.X / SR).toFixed(3)} + T ${(t / 1000).toFixed(2)}` +
        `${t > this.firstChunkMs ? ` [shared-GPU reference, chunk 0 was ${(this.firstChunkMs / 1000).toFixed(2)}]` : ''} ` +
        `+ cushion ${LIVE_CUSHION_SEC})`);
      this.pushState(true);
    }, delayMs);
  }

  // ------------------------------------------------------------------- mixing
  /**
   * Resolve the truth table on this thread; the worklet stays a dumb summer.
   *
   * QA-15: the passthrough slot (`G_PASS`) MUST be written here too. It was initialised to
   * 1 in the worklet and never touched, so during a dropped chunk the
   * unseparated mix went out at full level regardless of mute, solo or the
   * faders — a killed vocal came back on its own. It is ducked to the quietest
   * resolved stem gain and ramped with the same tau as the stems, so the
   * boundary into and out of a passthrough span cannot click.
   */
  pushGains(tau = TAU.fader) {
    if (!this.node) return;
    const g = resolveDeckGains(this.deck, this.mix, this.xf.assign, this.xf.position, this.xf.curve);
    // Split across the meter tap: `meter` (fader/mute/solo) goes to the gain
    // slots the worklet meters, `xf` to the post-meter crossfader slots. A stem
    // crossfaded fully out must keep its meter so the DJ can cue it.
    // EVERY stem, not four. `resolveDeckGains` returns one entry per entry of
    // `this.mix`, which is `STEMS`-sized; writing only the first four would
    // leave guitar and piano on the worklet's initial value of 1 — audible,
    // unmutable, and invisible to every meter that reads what we sent.
    for (let i = 0; i < STEMS.length; i++) {
      this.node.port.postMessage({ t: 'gain', i, value: g.meter[i], tau });
      this.node.port.postMessage({ t: 'xf', i, value: g.xf[i], tau });
    }
    this.node.port.postMessage({ t: 'gain', i: G_PASS, value: g.pass, tau });
  }

  /** The STEMS.length + 2 linear gains currently driving the worklet. Diagnostics and tests. */
  effectiveGains() {
    return resolveDeckGains(this.deck, this.mix, this.xf.assign, this.xf.position, this.xf.curve);
  }

  setStemGain(stem, gainDb) {
    const i = STEMS.indexOf(stem);
    if (i < 0) return;
    this.mix[i].gainDb = gainDb;
    this.pushGains(TAU.fader);
  }
  setStemMute(stem, muted) {
    const i = STEMS.indexOf(stem);
    if (i < 0) return;
    this.mix[i].muted = !!muted;
    this.pushGains(TAU.mute);
  }
  setStemSolo(stem, soloed) {
    const i = STEMS.indexOf(stem);
    if (i < 0) return;
    this.mix[i].soloed = !!soloed;
    this.pushGains(TAU.mute);
  }
  /**
   * @param {number} gainDb
   * @param {boolean} auto true when the ENGINE chose this (the dual-deck trim),
   *        false when the user did. Once the user has set it, `masterUserSet`
   *        latches and the engine never overrides it again — this is a default,
   *        not a clamp (shared/config.js DUAL_MASTER_TRIM_DB).
   */
  setMasterGain(gainDb, auto = false) {
    const db = Number(gainDb);
    if (!Number.isFinite(db)) return;
    if (!auto) this.masterUserSet = true;
    this.masterDb = db;
    this.masterAuto = auto;
    this.pushMaster(TAU.master);
  }

  /**
   * Send the stored master gain to the worklet. Separate from setMasterGain
   * because it must ALSO run once the graph exists.
   *
   * The trim is applied by reconcileMaster() the moment a second capture
   * attaches, which is BEFORE LIVE_START builds the playback node — so the
   * postMessage went nowhere, `masterDb` said -3 dB, and the worklet's master
   * slot sat at unity. The probe's own gain-staging line is what caught it:
   * master peak 1.1384 with deck A at 0.586, i.e. exactly the untrimmed value.
   *
   * `pushGains` covers slots `0..G_PASS` on every start; `G_MASTER` was the one
   * nothing re-applied. Same shape as the crossfader echo defect — state set on an
   * object that is not ready yet, with nothing reconciling it afterwards.
   */
  pushMaster(tau = TAU.master) {
    if (!this.node) return;
    this.node.port.postMessage({ t: 'gain', i: G_MASTER, value: dbToGain(this.masterDb), tau });
  }

  // ------------------------------------------------------- transpose and key
  /**
   * THE TRANSPOSE. `{ t: 'pitch', semitones }` straight through to the audio
   * thread, where `PitchLanes` shifts every harmonic stem — bass, other, vocals,
   * guitar, piano — and the passthrough mix, and delay-matches the drums.
   *
   * REFUSED, NOT CLAMPED, and refused HERE as well as in the worklet. Two guards
   * on the same value is not belt-and-braces: this one keeps `this.semitones` —
   * the number that goes on the wire and that the UI composes its key display
   * from — in step with what the audio thread actually accepted. Clamping an
   * out-of-range request would leave the UI showing a key the audio is not in,
   * which is the one failure this whole feature exists to prevent and the one
   * the user cannot diagnose.
   *
   * @param {number} semitones integer in [-6, +6]
   * @returns {boolean} accepted
   */
  setPitch(semitones) {
    const k = semitones;
    if (!Number.isInteger(k) || k < PITCH_MIN_SEMITONES || k > PITCH_MAX_SEMITONES) return false;
    this.semitones = k;
    this.pushPitch();
    this.d.log(`deck ${this.deck} pitch -> ${k >= 0 ? '+' : ''}${k} semitones (drums unshifted)`);
    return true;
  }

  /**
   * Send the stored interval to the worklet. Separate from `setPitch` for
   * exactly the reason `pushMaster` is separate from `setMasterGain`, and it is
   * the same defect if it is not: the UI has ONE transpose control and does not
   * know whether the deck behind it has built its playback node yet, so a
   * request that arrives before `build()` posts into nothing. `masterDb` lost a
   * whole -3 dB that way and the only thing that caught it was a gain-staging
   * probe. A lost transpose would be worse — it is silent, the audio plays
   * perfectly, and it is in the wrong key.
   *
   * Sent even when unchanged: `PitchLanes` treats a no-op as a no-op, so there
   * is no crossfade and no cost, and `start()` can call it unconditionally.
   */
  pushPitch() {
    if (this.node) this.node.port.postMessage({ t: 'pitch', semitones: this.semitones });
  }

  /**
   * One key-detection window, at most every 1/KEY_ACCUM_HZ.
   *
   * Driven from pushState() rather than its own timer because it must stop when
   * the deck stops and there is already a 10 Hz heartbeat there — but pushState
   * is ALSO called with `force` from half a dozen places, so the rate is gated on
   * the wall clock rather than on the call. Without that, a burst of forced
   * pushes would weight whatever was playing during the burst.
   *
   * The 5 ms of slop is because a setInterval(100) fires at 99 ms often enough
   * that a strict `>= 100` gate silently halves the rate.
   */
  tickKey() {
    if (!this.out || this.status === 'idle' || this.status === 'error') return;
    const now = performance.now();
    if (now - this.keyAt < 1000 / KEY_ACCUM_HZ - 5) return;
    this.keyAt = now;
    this.keyTap.tick(this.out);
  }

  /**
   * One tempo-detector block, at most every 1/BPM_ACCUM_HZ. Deliberately the
   * same shape as tickKey() above — same driver, same guards, same wall-clock
   * gate with the same 5 ms of slop — and it is a SIBLING rather than two lines
   * inside tickKey() so each tap has its own entry point and its own timestamp.
   *
   * The two differences from tickKey(), and both are the fault contract:
   *
   *   1. It cannot throw into the heartbeat. `pushState()` is the 10 Hz timer AND
   *      the thing half a dozen call sites use to publish state after an error;
   *      an exception escaping here would take the whole readout down over a
   *      DISPLAY-ONLY label.
   *   2. It is not a bare `catch {}`. The throw is counted, the first message is
   *      latched and logged once, and the wire says `state: 'fault'` from then on
   *      (bpmPayload()). A tap that silently stopped would present as one that is
   *      listening and has not decided — which is the "an assertion must FAIL when
   *      it cannot look" shape moved out of the harness and into shipped code.
   *
   * Once latched the tap is OFF for the session and `start()` is what clears it.
   * That is on purpose: a tick that threw part-way through may have left the
   * cursor, the envelope ring or `prevM` inconsistent, and the failure mode of
   * carrying on would be a confident lock derived from torn state — the one
   * output this feature must never produce. It also bounds the cost of a
   * repeating fault at one throw rather than ten a second.
   */
  tickBpm() {
    if (!this.out || this.status === 'idle' || this.status === 'error') return;
    if (this.bpmFault) return;
    const now = performance.now();
    if (now - this.bpmAt < 1000 / BPM_ACCUM_HZ - 5) return;
    this.bpmAt = now;
    try { this.bpmTap.tick(this.out); } catch (e) { this.bpmFault_('tick', e); }
  }

  /**
   * Record a tempo-detector fault. Counted always, logged once — the same
   * not-spamming rule fail() follows, and for the same reason: one error per
   * heartbeat for the life of a session buries the first and only useful one.
   */
  bpmFault_(where, err) {
    this.bpmFaults++;
    if (this.bpmFault) return;
    this.bpmFault = `${where}: ${String((err && err.message) || err)}`;
    this.d.log(`ERROR [live] deck ${this.deck} tempo tap faulted in ${where} and is off until the next start: ${this.bpmFault}`);
  }

  /**
   * THE WIRE VALUE for `LIVE_STATE.bpm`, and the only place it is built.
   *
   * Four fields from engine/bpmtap.js when the tap is healthy — `{state, bpm,
   * confidence, beatFrame}` with `state` one of none/listening/locked. A fifth
   * state, `'fault'`, when it is not, carrying the latched message and the count.
   *
   * WHY A FIFTH STATE AND NOT JUST `none`. `none` means "the tap looked and there
   * was nothing to hear" and `listening` means "it is looking"; both are honest
   * reports from a working detector, and a broken one reporting either would be
   * claiming coverage it does not have. The extra fields are ADDITIVE, so a
   * surface that only knows the four states still renders nothing — but the
   * failure is on the wire, in stats(), and in the log, instead of nowhere.
   */
  bpmPayload() {
    if (!this.bpmFault) {
      try { return this.bpmTap.payload(); } catch (e) { this.bpmFault_('payload', e); }
    }
    return {
      state: 'fault', bpm: null, confidence: 0, beatFrame: null,
      fault: this.bpmFault, faults: this.bpmFaults,
    };
  }

  // -------------------------------------------------------------- crossfader
  /**
   * The crossfader is GLOBAL — both decks are given the same position and curve
   * by offscreen.js — but it is APPLIED per deck, here, because the assignment
   * matrix makes each deck's response to the same position different.
   *
   * TAU.xfader (3 ms, not the 10 ms fader tau): with the `cut` curve a scratch
   * DJ expects the deck to appear the instant the cap leaves the edge.
   */
  setXfader(position) {
    const p = Math.max(0, Math.min(1, +position));
    if (!Number.isFinite(p) || p === this.xf.position) return;
    this.xf.position = p;
    this.pushGains(TAU.xfader);
  }
  setXfCurve(curve) {
    if (!XF_CURVES.includes(curve) || curve === this.xf.curve) return;
    this.xf.curve = curve;
    this.pushGains(TAU.xfader);
  }
  /**
   * One cell of the master assign matrix. `target` names WHICH DECK OWNS this
   * stem: 'XF' follows the fader on this deck's own side, `target === this.deck`
   * is hard-assigned ON (gain 1, fader ignored), and the other deck's id is
   * hard-assigned OFF (gain 0, so the deck that does own it is not doubled).
   * engine/mixer.js xfFactor() is the whole law.
   */
  setXfAssign(stem, target) {
    const i = STEMS.indexOf(stem);
    if (i < 0 || !XF_TARGETS.includes(target)) return;
    if (this.xf.assign[i] === target) return;
    this.xf.assign[i] = target;
    this.pushGains(TAU.xfader);
  }

  // ------------------------------------------------------------------ reports
  /**
   * The worklet posts index-based arrays because the audio thread should not
   * spend anything on object churn; the CONTRACT is stem-keyed objects. The
   * conversion happens here, on the main thread, once per meter frame.
   *
   *   METERS { peak: {<every STEMS name>, master},
   *            rms:  {<every STEMS name>, master}, clip }
   *
   * i.e. at six stems `{drums,bass,other,vocals,guitar,piano,master}`. The keys
   * are GENERATED from `STEMS`, never spelled out: a hand-written list is a
   * second copy of the wire order, and the failure is silent — the worklet's
   * array is index-keyed, so a converter one name short does not throw, it
   * relabels every stem after the gap and drops `master` off the end.
   *
   * UNITS: LINEAR amplitude, 0..~4, POST-FADER (a muted stem reads 0, which is
   * what a channel meter should show). `master` is the summed bus PRE-soft-clip,
   * so the CLIP flag means "you are into the safety net", not "the DAC clipped".
   * The dB curve is a display decision and belongs to the display — the UI
   * converts. Do not add log10 to the audio thread for this.
   */
  /**
   * Ask the playback worklet what its gain vector actually is. The engine posts
   * gain targets and never reads them back, so the STEMS.length + 2 multipliers that every
   * sample passes through are the one part of the chain no gate can see: the
   * AnalyserNode is downstream of the sum and can only say "zero", never which
   * slot made it zero. Diagnostic path only — see DIAG in offscreen.js.
   * Resolves to null (rather than hanging) if the worklet does not answer.
   */
  workletReport(timeoutMs = 500) {
    if (!this.node) return Promise.resolve(null);
    const id = ++this.reportId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.reportWaiters.delete(id); resolve(null); }, timeoutMs);
      this.reportWaiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.node.port.postMessage({ t: 'report', id });
    });
  }

  onWorklet(m) {
    if (m.t === 'report') {
      const w = this.reportWaiters.get(m.id);
      if (w) { this.reportWaiters.delete(m.id); w(m); }
      return;
    }
    // Review finding P3-M4: the playback node is built once and only `dispose()`
    // stops it, so after LIVE_STOP the worklet keeps metering an all-zero ring
    // and posting at 30 Hz + 10 Hz forever. Forwarding that to the UI is 40
    // chrome.runtime.sendMessage round-trips per second for a deck that is not
    // running. The worklet still pays for the post; this stops the IPC.
    if (this.status === 'idle' || this.status === 'error') return;
    if (m.t === 'meters') {
      this.lastMeters = { peak: byStem(m.peak), rms: byStem(m.rms), clip: !!m.clip };
      this.d.send({ type: 'METERS', ...this.lastMeters });
    } else if (m.t === 'health') {
      this.health = m;
      // The audio render thread's own heartbeat. It is the ONLY evidence on this
      // side that the graph is still being pulled — see watchOutput().
      this.lastHealthAt = performance.now();
      if (this.out && this.out.playing()) {
        this.minWindow.push(m.cushionMinFrames);
        while (this.minWindow.length > this.minWindowLen) this.minWindow.shift();
      }
    }
  }

  rtf() {
    // `plan` is null once stopped; pushState still runs one final time
    if (!this.chunkMs.length || !this.plan) return 0;
    const s = this.chunkMs.reduce((a, b) => a + b, 0) / this.chunkMs.length;
    return s / 1000 / this.plan.hopSeconds;
  }

  /**
   * Capture-to-speaker offset in seconds — how far behind the picture the DJ is.
   * This is the number on the transport, and it is NOT `bufferSec`: the ring
   * depth and the latency are different quantities that merely sit close
   * together (~2.4 s of ring depth against ~3.5 s of latency at hop 1.95).
   *
   * MEASURED, not predicted. Output-stream frame `n` is by construction the
   * audio captured at live-relative capture frame `n` (chunk 0 emits [0, H−X)
   * from capture frames [base, base+H−X)), so
   *
   *     latency = (frames captured) − (frames played)
   *
   * is the exact offset in frames, and both counters are Atomics loads off SABs
   * read here microseconds apart — no messaging skew, no formula to drift out of
   * date. It also self-corrects for free: an underrun stalls the read pointer, so
   * the DJ really is that much further behind afterwards and the readout says so,
   * which a static `hop + xfade + T_inf + cushion` prediction could never do.
   * `AudioContext.outputLatency` is the last hop to the speaker (48 ms here).
   *
   * Zero until playback arms — before that nothing is playing, so there is no
   * offset to report and the UI should be showing `priming` anyway.
   */
  latencySec() {
    const ring = this.d.ring();
    if (!this.out || !this.out.playing() || !ring) return 0;
    const captured = ring.writeFrames() - this.baseFrame;
    const played = this.out.readFrames();
    const ctx = this.d.ctx();
    const outLat = ctx && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    /**
     * THE TRANSPOSE'S GROUP DELAY, ADDED EXPLICITLY. `played` is the ring READ
     * pointer, and `PitchLanes` sits DOWNSTREAM of it inside the worklet: a
     * frame is counted as played the moment it is read out of the ring, and then
     * spends another PITCH_GROUP_DELAY_SAMPLES inside the shifter before it
     * reaches the bus. So the counter difference UNDER-REPORTS by exactly that,
     * at every setting including 0 — the whole point of the constant group delay
     * is that this is one number and not a function of the interval.
     *
     * 3072 / 44100 = 69.7 ms, and it is not cosmetic: `ui/audio-math.js`
     * syncCorrection starts correcting the video at 60 ms, so leaving it out
     * would make the video lock chase a constant offset larger than its own
     * threshold, forever, in one direction.
     */
    return Math.max(0, (captured - played) / SR + PITCH_GROUP_DELAY_SAMPLES / SR + outLat);
  }

  /**
   * The lowest ring depth seen over the last 3 hops, seconds.
   *
   * THIS is the buffer health number, not `bufferSec`. The ring depth sawtooths
   * from `hop + cushion` down to `cushion` on every single hop — a chunk lands,
   * depth jumps by a hop, then drains — so the instantaneous value crosses any
   * fixed threshold ~30 times a minute during a perfectly healthy run. What
   * actually predicts an underrun is how close the trough came to zero, which is
   * exactly this. Fed from per-quantum minima taken in the worklet, so a sharp
   * trough between two 10 Hz samples cannot hide.
   */
  bufferMinSec() {
    if (!this.out || !this.out.playing() || !this.minWindow.length) return 0;
    let m = Infinity;
    for (const v of this.minWindow) if (v < m) m = v;
    return Math.max(0, m / SR);
  }

  /**
   * Is the audio LEAVING THE SPEAKER RIGHT NOW unseparated? `drops` is a
   * counter — it says a drop happened, not that you are hearing one — and during
   * a passthrough span EVERY stem meter reads 0 while master reads signal,
   * which a console would otherwise paint as "the user muted everything".
   */
  passthroughNow() {
    if (!this.out || !this.out.playing()) return false;
    const p = this.out.readFrames();
    for (const s of this.passSpans) if (p >= s.from && p < s.to) return true;
    return false;
  }

  /**
   * Is THIS DECK actually wired into the master bus, right now?
   *
   * In Mode 1 the OUTPUT_SILENT watchdog could catch a missing connect() because
   * the analyser and the deck were one chain. With two decks summing into one
   * shared bus, deck A playing at full level keeps `busPeak` well above zero
   * while deck B's node sits unconnected and inaudible — a silent failure that
   * every existing gate would call green. So ask the graph directly, with the
   * same disconnect/reconnect-in-one-task trick MasterBus.probeTerminal() uses:
   * `disconnect(node)` throws InvalidAccessError when the edge is not there.
   *
   * Dev/diagnostic only: it is a graph mutation, even though no render quantum
   * can observe it.
   */
  probeDeckEdge() {
    const master = this.d.master();
    if (!this.node || !master || !master.input()) return { connected: false, why: 'no graph' };
    try {
      this.node.disconnect(master.input());
    } catch (e) {
      return { connected: false, why: String((e && e.name) || e) };
    }
    this.node.connect(master.input());
    return { connected: true, why: 'edge present' };
  }

  /**
   * Peak at `post`, the last node before ctx.destination. Cheap; 10 Hz is fine.
   * SHARED between decks in Mode 3 — see watchOutput() for why that is still the
   * right signal for OUTPUT_SILENT and why it can no longer fire on deck B alone.
   */
  busPeakNow() {
    const master = this.d.master();
    return master ? master.busPeak() : null;
  }

  /**
   * The CAPTURE ring's peak over the audio that came out of the speaker in the
   * live-relative output frames `[from, from + n)`. Returns null when it could
   * not read that whole span — see below, that is not the same as zero.
   *
   * THE IDENTITY THIS RESTS ON, because everything else here follows from it:
   * output frame `n` is by construction the audio captured at live-relative
   * capture frame `n` (chunk 0 emits [0, H−X) from capture frames [base,
   * base+H−X); latencySec() derives the whole latency readout from the same
   * fact). So the absolute capture frame is `baseFrame + n`, with no clock
   * conversion, no messaging skew and no formula to drift out of date. It is
   * what lets the watchdog compare THE SAME AUDIO at two points in the chain
   * instead of comparing two points on a delay line as though they were
   * simultaneous, which is the defect this replaces.
   *
   * NULL IS "I COULD NOT LOOK", AND IT IS COUNTED. Two ways to get one, and the
   * caller must not read either as silence:
   *   - the span is wider than the one-second probe buffer (a heartbeat more
   *     than a second late), so the read would be a SAMPLE of the span and the
   *     claim being made is about the whole of it;
   *   - `readWindow` reports the history is gone (the ring holds 23.78 s and the
   *     read pointer trails the write pointer by ~2–3.5 s, so this needs a stall
   *     long enough that OUTPUT_STALLED has already fired).
   *
   * @param {number} from live-relative output frame the span starts at
   * @param {number} n frames
   * @returns {number|null} linear peak, or null if the whole span was not read
   */
  inputPeakOver(from, n) {
    const ring = this.d.ring();
    if (!ring || n <= 0) return null;
    if (n > this.probeL.length) { this.inputWindowMisses++; return null; }
    const ok = readWindow(ring, this.baseFrame + from, n,
      this.probeL.subarray(0, n), this.probeR.subarray(0, n));
    if (!ok) { this.inputWindowMisses++; return null; }
    let p = 0;
    for (let i = 0; i < n; i++) {
      const a = this.probeL[i] < 0 ? -this.probeL[i] : this.probeL[i];
      if (a > p) p = a;
      const b = this.probeR[i] < 0 ? -this.probeR[i] : this.probeR[i];
      if (b > p) p = b;
    }
    return p;
  }

  /**
   * THE DECK IS SILENT AND EVERYTHING ELSE LOOKS FINE — say it out loud.
   *
   * This is the failure mode this codebase keeps producing (the QA record
   * calls the last one "the third silent failure"), and it keeps getting as far
   * as a human because every automatic check sits UPSTREAM of the break: the SAB
   * ring is correct, the worklet's meters are correct, `status` is `running`, and
   * nothing between the summing worklet and CoreAudio is observable from the
   * places we look. Two facts are observable, and between them they cover both
   * halves:
   *
   *   OUTPUT_STALLED — the worklet has stopped posting `health`. It posts at
   *     HEALTH_HZ from inside process(), so silence on that channel means the
   *     audio render thread is not being pulled at all: a closed or suspended
   *     context, a destination with no stream behind it, a device that went away.
   *     No heuristic, no threshold on program material — either the heartbeat
   *     arrives or the graph is dead.
   *
   *   OUTPUT_SILENT — the worklet says it is summing signal (its meters are
   *     post-fader, so a mute or a kill reads 0 there too and cannot trip this)
   *     while the AnalyserNode on `post` reads digital zero. Those two can only
   *     disagree if something in pre -> shaper -> post ate the audio: a zeroed
   *     gain, an unassigned curve, a graph built on a second AudioContext, a
   *     missing connect(). Held for a full second so a legitimately quiet
   *     passage cannot trip it.
   *
   * Neither is fatal to the engine — the pipeline keeps running and may recover —
   * but both mean the user is hearing nothing, so they go out on LIVE_ERROR
   * (which the console paints as a stop, correctly: a deck making no sound is
   * stopped as far as the user is concerned). Latched: one per session.
   */
  watchOutput() {
    if (this.outputAlarm || !this.out || !this.out.playing()) return;
    // ---- THIRD ARM: the deck is playing and producing NOTHING. See outputTick().
    // Evaluated FIRST and unconditionally, because the two arms below both return
    // early on their own conditions and this one must not be reachable only when
    // they decline. It is also the only arm that can fire while `busPeak` is a
    // perfectly healthy zero.
    const ring = this.d.ring();
    const pk = ring ? ring.peaks() : null;
    /**
     * THE ONLY CLOCK IN THIS ARM, AND IT IS THE AUDIO DEVICE'S.
     *
     * `played` advances at SR frames per second of audio actually delivered, so
     * `advanced` is "how much audio the listener heard since the last look" —
     * not "how long ago the last look was". Everything below counts in it.
     */
    const played = this.out.readFrames();
    const advanced = Math.max(0, played - this.lastPlayedFrame);
    this.lastPlayedFrame = played;
    const wasDead = DEAD_VERDICTS.has(this.outputVerdict);
    /**
     * WHAT WAS OWED, OVER THE WHOLE DEAD SPAN — not over the tripping tick.
     *
     * The claim the variant makes is about three seconds ("the tab has been
     * digitally silent for 3 s"), so the estimator has to span three seconds.
     * Deciding it on the last 100 ms window would be a percentile of one sample
     * of a bimodal thing, which is the estimator failure AGENTS.md spends a page
     * on. So: the max over every window this span has played, reset the moment
     * the span breaks.
     *
     * AND IT IS POISONED BY A MISS, NOT AVERAGED OVER ONE. If any window in the
     * span could not be read, the span cannot support "the tab was silent
     * throughout" and reports `null` — which outputTick turns into the deck-side
     * remedy rather than into an accusation about the user's tab.
     */
    if (!wasDead) { this.deadOwedPeak = -1; this.deadOwedMissed = false; }
    if (advanced > 0) {
      const raw = this.inputPeakOver(played - advanced, advanced);
      if (raw === null) this.deadOwedMissed = true;
      else if (raw > this.deadOwedPeak) this.deadOwedPeak = raw;
    }
    const owed = this.deadOwedMissed || this.deadOwedPeak < 0 ? null : this.deadOwedPeak;
    const v = outputTick({
      playing: true,
      meters: this.lastMeters,
      gains: this.node ? this.effectiveGains() : null,
      passthrough: this.passthroughNow(),
      inputPeakPlayed: owed,
      inputPeakNow: pk ? Math.max(pk[0], pk[1]) : 0,
    });
    this.outputVerdict = v;
    this.outputChecks++;
    /**
     * COUNTED FROM THE TRANSITION, so the hold is a LOWER BOUND on the audio the
     * listener actually sat through: the frames played during the tick that
     * *became* dead are not claimed, because the arm did not observe them dead.
     * The alarm is therefore never early and is at most one heartbeat late, and
     * it can never cry wolf on frames it did not look at.
     */
    if (DEAD_VERDICTS.has(v)) {
      this.deadTicks++;
      if (wasDead) this.deadFrames += advanced;
    } else {
      this.deadTicks = 0;
      this.deadFrames = 0;
    }
    if (this.deadFrames >= OUTPUT_DEAD_HOLD_FRAMES) {
      const m = this.lastMeters;
      /**
       * THE COPY IS THE FIX. Measured on Itzik's run: 2416 s — forty minutes —
       * of a healthy transport playing nothing, and the only way anyone found
       * out was a DIAG paste read by an engineer. The `dead-input` branch exists
       * so that this branch can NAME THE CAUSE, and it is only worth separating
       * from `dead-mixer` if it does. Cause first, the two things to check
       * second, the action last — and the action matches the button the console
       * puts on a fatal (audio-math errorAction -> 'restart').
       *
       * "paused or ended" leads because that is what it actually was.
       */
      return this.raiseOutput('OUTPUT_DEAD', v === 'dead-input'
        ? 'No audio is coming from the captured tab — it has been digitally silent for ' +
          `${OUTPUT_DEAD_HOLD_SEC} s, so there is nothing to separate and nothing to hear. ` +
          'Check the video is actually playing (not paused or ended) and that the tab is not muted, then Restart live.'
        : v === 'blind'
          ? `The deck says it is playing but the audio thread has not reported a single meter frame in ${OUTPUT_DEAD_HOLD_SEC} s. ` +
            'The mixer is not running — Restart live.'
          : (Number.isFinite(owed)
              ? 'The captured tab has audio but the separator has published digital silence for '
              // The message may not assert what the tick could not read. This is
              // the `inputWindowMisses` path: the deck is dead either way, and
              // the remedy is the same, but "the captured tab has audio" would
              // be a fact we did not check.
              : 'The separator has published digital silence for ') +
            `${OUTPUT_DEAD_HOLD_SEC} s ` +
            /**
             * Every stem, labelled, off STEMS: an unlabelled row of six numbers
             * is unreadable in a paste, and a hand-written four-name list would
             * silently stop printing the two stems most likely to be the ones
             * that went missing.
             *
             * EXPONENTIAL, NOT `toFixed(6)`, AND THAT COST AN INVESTIGATION.
             * The meters in the window this fired on were ~2.45e-08 per stem and
             * 1.47e-07 at master — six stems of a separator faithfully running on
             * a silent input — and six decimal places render every one of them as
             * `0.000000`. The message then reads as "the mixer emitted nothing"
             * when the truth is "the mixer emitted something 120 dB down", which
             * are different defects with different first suspects. A message that
             * misstates its own evidence costs exactly what a wrong assertion
             * costs (AGENTS.md). `missing` is printed for a non-finite peak so
             * the `blind`-shaped frame — a worklet one stem short — is legible
             * here too rather than showing up as `NaN`.
             */
            `(stem peaks ${m ? STEMS.map((s) => {
              const x = Number(m.peak[s]);
              return `${s} ${Number.isFinite(x) ? x.toExponential(2) : 'missing'}`;
            }).join(', ') : 'none'}). ` +
            'Nothing you did caused this — Restart live.',
        /**
         * THE VARIANT, AND ITS REFERENCE POINT IS THE WHOLE SPEC.
         *
         * `v` is the verdict AT THE TICK THAT TRIPPED THE LATCH — the local, not
         * `this.outputVerdict`, which goes on being written by later ticks. The
         * alarm latches once per session and the console renders the banner for
         * the life of that session, so it must render THE STATE THAT CAUSED THE
         * ALARM, not the state now. Reading the live field would let the banner
         * drift off the cause it was raised for and swap the remedy underneath
         * the user's cursor.
         *
         * It exists because the remedies are opposites: `dead-input` means go to
         * the tab and press play, and restarting the deck fixes nothing;
         * `dead-mixer`/`blind` mean restart the deck, and going to the tab fixes
         * nothing. The console cannot tell them apart from the prose and must
         * not try — it showed BOTH buttons until this field existed.
         */
        v);
    }
    const now = performance.now();
    if (this.lastHealthAt && now - this.lastHealthAt > 2000) {
      const ctx = this.d.ctx();
      return this.raiseOutput('OUTPUT_STALLED',
        `The audio thread has not run for ${((now - this.lastHealthAt) / 1000).toFixed(1)} s, so nothing is reaching the speakers. ` +
        `Context state "${ctx ? ctx.state : 'none'}", output latency ${ctx && Number.isFinite(ctx.outputLatency) ? (ctx.outputLatency * 1000).toFixed(0) + ' ms' : 'unknown'}. ` +
        'This is almost always the output device changing underneath the browser — switch output device and restart the deck.');
    }
    // MODE 3 CAVEAT: `busPeakNow` is the SHARED master bus, so this test can no
    // longer distinguish "the master chain is broken" (both decks silent, which
    // it does catch) from "this deck alone is not reaching the bus" (the other
    // deck's signal keeps busPeak above zero, which it does NOT catch). The
    // second case is covered by probeDeckEdge(), which asks the graph whether
    // this deck's edge into the master exists at all. Both are in stats().
    const bus = this.busPeakNow();
    const m = this.lastMeters;
    if (bus == null || !m) return;
    if (m.peak.master > 1e-3 && bus < 1e-6) this.silentTicks++;
    else this.silentTicks = 0;
    if (this.silentTicks >= HEALTH_HZ) {
      const p = this.outputProbe();
      this.raiseOutput('OUTPUT_SILENT',
        `The mixer is producing signal (master peak ${m.peak.master.toFixed(3)}) but the last node before the speaker is at digital zero. ` +
        `pre ${p.preGain}, post ${p.postGain}, curve ${p.curveLength} points, same context ${p.sameContext}, context "${p.ctxState}".`);
    }
  }

  /**
   * @param {string} code
   * @param {string} message
   * @param {'dead-input'|'dead-mixer'|'blind'|null} [variant] ONLY for
   *        OUTPUT_DEAD, and only ever the verdict from the tick that tripped the
   *        latch. The field is ABSENT — not null — on every other code, so a
   *        console reading `'variant' in m` gets a straight answer instead of
   *        having to decide what a null means. Snapshotted into
   *        `outputAlarmVariant` for the same reason it goes on the wire: the
   *        banner outlives the tick, and `outputVerdict` does not stand still.
   */
  raiseOutput(code, message, variant = null) {
    this.outputAlarm = code;
    this.outputAlarmVariant = variant;
    this.d.log(`ERROR [live] ${code}: ${message}${variant ? ` [${variant}]` : ''}`);
    this.d.send(variant
      ? { type: 'LIVE_ERROR', code, message, variant }
      : { type: 'LIVE_ERROR', code, message });
  }

  pushState(force) {
    if (this.status === 'idle' && !force) return;
    this.watchOutput();
    this.tickKey();
    this.tickBpm();
    const bufferSec = this.out ? this.out.cushion() / SR : 0;
    /**
     * THE PLAYHEAD AND ITS TIMESTAMP, SAMPLED TOGETHER AND ON THIS LINE.
     *
     * `readFrames()` and the wall clock it is paired with are read at the same
     * point on purpose: a playhead carried on one message with a timestamp taken
     * somewhere else in the same function is a phase error dressed as data, and
     * this pair's only consumer is a beat phase (`bpmtap.js::beatPhaseAt`).
     * Everything below re-uses these two locals; neither is re-sampled.
     */
    const atMs = Date.now();
    const playFrames = this.out ? this.out.readFrames() : null;
    const bufferMinSec = this.bufferMinSec();
    const targetSec = this.plan ? this.plan.hopSeconds + LIVE_CUSHION_SEC : 0;
    let status = this.status;
    // Driven by the rolling trough, never by the instantaneous depth — the old
    // `bufferSec < LOW_WATER` test made the ENGINE strobe its own state field
    // once per hop, which is what the console was faithfully rendering.
    if (status === 'running' && this.minWindow.length && bufferMinSec < LIVE_LOW_WATER_SEC) status = 'starving';
    const captured = this.d.ring() ? this.d.ring().writeFrames() - this.baseFrame : 0;
    this.d.send({
      type: 'LIVE_STATE', status,
      // L3: chunks the SHARED scheduler refused so the priority deck could make
      // its deadline. Distinct from `drops` (this deck's own L2 ladder) on
      // purpose: one says "this machine is oversubscribed and you are the deck
      // that lost", the other says "this deck was late". `drops` counts both,
      // because every unseparated span the user hears must be in one number.
      demotions: this.demotions,
      // The engine changes this on its own when a second deck loads, so it must
      // be echoed or the UI's master fader silently disagrees with the audio.
      masterDb: this.masterDb,
      masterAuto: this.masterAuto,
      /**
       * `effective`, NOT `position` — this is the position the deck is APPLYING,
       * which is not the user's control value whenever the fader is parked
       * (offscreen.js effectiveXfPosition: a lone deck runs at its own end so it
       * is never attenuated 3 dB by a control nobody touched).
       *
       * It was called `position`, the console reasonably adopted it as the user's
       * intent, and that dragged the fader to the park point and then reported
       * the park point back as intent. Three bugs in this project have come from
       * a field whose name says one thing and whose value is another. The user's
       * control value is `XF_STATE.position`; the applied value is here and in
       * `XF_STATE.effective`, and those two agree by construction.
       */
      xf: { effective: this.xf.position, curve: this.xf.curve, assign: this.xf.assign.slice() },
      // which wait `priming` is; null once running. See this.phase.
      phase: status === 'priming' ? this.phase : null,
      // QA-17: the hop the engine is ACTUALLY running, which is not the one the
      // user last clicked — SET_HOP is deferred to the next start because the
      // whole schedule derives from H. Both are on the wire so the console can
      // render "1.95 running · 2.6 on next start" instead of guessing.
      hopSec: this.plan ? this.plan.hopSeconds : null,
      pendingHopSec: this.hopSeconds,
      // THE transport readout: capture-to-speaker offset. See latencySec().
      latencySec: +this.latencySec().toFixed(3),
      /**
       * THE KEY, and the engine reports CONCERT TONIC ONLY —
       * {state:'listening'|'locked'|'none', concertTonic:0..11|null,
       *  mode:'major'|'minor'|null, confidence:number}.
       *
       * The transpose offset and the user's instrument are composed by ONE
       * function at ONE call site in the UI (chroma.js displayKey). The engine
       * deliberately does not know which instrument the user plays and
       * deliberately does not apply `pitchSemitones` below to this tonic; doing
       * either here would make the UI's composition a double-count, which looks
       * correct in review from both ends (engine/keytap.js payload()).
       */
      key: this.keyTap.payload(),
      /**
       * THE TEMPO — {state:'none'|'listening'|'locked'|'fault', bpm:number|null,
       * confidence:number, beatFrame:number|null} (+ `fault`/`faults` on the
       * fault state only). See bpmPayload() and engine/bpmtap.js.
       *
       * `beatFrame` is an ABSOLUTE stem-ring frame, on the same clock as
       * `this.out`'s counters and therefore the same clock the playhead is on.
       * The phase is `bpmtap.js::beatPhaseAt(bpm, frame, SR)` and that is the one
       * call site of the modulo — for the same reason `key` carries the concert
       * tonic and nothing else.
       *
       * DISPLAY ONLY. Nothing in the engine syncs to it, and it is deliberately
       * not composed with `pitchSemitones`: pitch.js is length-exact
       * (`framesIn === framesOut`), so the transpose does not move tempo, and a
       * UI adding a correction for it would be inventing one.
       */
      bpm: this.bpmPayload(),
      /**
       * The interval the ENGINE has, echoed for the same reason `masterDb` is:
       * this value is validated and can be REFUSED here, so a UI that assumed
       * its own last request had landed would compose the key display against a
       * transpose the audio is not applying.
       */
      pitchSemitones: this.semitones,
      // true while the audio at the speaker is the unseparated mix
      passthroughNow: this.passthroughNow(),
      // Buffer health. Gauge and thresholds use bufferMinSec against floorSec;
      // bufferSec is the instantaneous sawtooth and is for the sparkline only.
      bufferMinSec: +bufferMinSec.toFixed(3),
      bufferSec: +bufferSec.toFixed(3),
      floorSec: LIVE_CUSHION_SEC,
      targetSec: +targetSec.toFixed(3),
      rtf: +this.rtf().toFixed(3),
      drops: this.drops,
      underruns: this.health.underruns,
      overruns: this.overruns,
      staleReads: this.staleReads,
      primedPct: +primedPct(Math.max(0, captured)).toFixed(3),
      /**
       * THE PLAYHEAD, in ABSOLUTE STEM-RING FRAMES — `this.out.readFrames()`,
       * the audio device's own clock. It is on the SAME AXIS as `bpm.beatFrame`
       * above (both are counters on `this.out`), which is the whole reason the
       * field exists: `bpmtap.js::beatPhaseAt(bpm, frame, SR)` is the one call
       * site of the beat modulo and it needs a frame on that axis to measure
       * `beatFrame` against. Without it the live deck reported a tempo and no
       * beat, and the pulse stayed static (embed.js `beatFrameNow`).
       *
       * NOT a track position and NOT seconds. The cached deck publishes
       * `positionSec` for the video lock, which is a different quantity on a
       * different axis (`readBase + readFrames()`, clamped to the track and
       * divided by SR) and is not interchangeable with this one. Two fields,
       * two meanings, two names — AGENTS.md's entry-point family is five defects
       * from exactly the opposite choice.
       *
       * ABSENT, NOT ZEROED, when there is no output ring. `beatFrameNow()`
       * discriminates on `Number.isFinite`, and a 0 would read as "the playhead
       * is at frame 0" — a real position the ring genuinely takes at the start
       * of every run — instead of "there is no playhead". A field that could not
       * be sampled has to be missing, or the reader's guard reports coverage it
       * does not have.
       */
      ...(playFrames === null ? {} : { playFrames }),
      /**
       * WHEN `playFrames` WAS SAMPLED, on the wall clock. This message is
       * published at 10 Hz and crosses a `chrome.runtime` hop, so the playhead
       * has moved 50-100 ms by the time the surface beside the `<video>` reads
       * it; the reader advances it by `Date.now() - atMs` and turns a constant
       * lag into a sample age it can subtract. At 128 BPM one beat is 469 ms, so
       * an uncorrected 100 ms is a fifth of a beat of standing phase error.
       *
       * `Date.now()`, NOT `performance.now()`: the offscreen document and the
       * page have different `performance` time origins, so a difference between
       * them is meaningless. This is the one clock they share. Same field name,
       * same clock and same reason as `cacheddeck.js`'s.
       */
      atMs,
    });
  }

  /**
   * A chunk failure is survivable exactly once or twice: the ladder fills its
   * span from the input ring and the user keeps hearing unseparated audio. Three
   * in a row is a broken pipeline and must be said out loud.
   *
   * Two things this must NOT do, both learned the hard way:
   *   - it must not set status='error' on a recoverable failure. armPlayback()
   *     only fires while priming, so an early error used to lock playback off
   *     permanently: the ladder went on filling the ring with passthrough that
   *     nobody was ever allowed to play, and the run was 100 % silent while
   *     reporting drops rather than an outage.
   *   - it must not spam. One error per capture tick for 18 s buries the first
   *     and only useful message under 200 copies of itself.
   */
  fail(code, err) {
    this.inFlight = false;
    if (this.status === 'error' && this.stopped) return;   // already halted; say nothing more
    const message = String((err && err.message) || err);
    this.chunkFails++;
    if (this.chunkFails <= MAX_CHUNK_FAILS) {
      this.d.log(`ERROR [live] ${code}: ${message} (${this.chunkFails}/${MAX_CHUNK_FAILS})`);
      this.d.send({ type: 'LIVE_ERROR', code, message });
    }
    if (this.chunkFails === MAX_CHUNK_FAILS) {
      this.stopped = true;
      this.status = 'error';
      // Review finding P3-H1: a halt left the 10 Hz pushState interval and any
      // pending armPlayback timeout running for the life of the document. Halting
      // has to release the same resources stop() does, or a later restart stacks
      // a second interval on top of the first.
      if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = null; }
      if (this.pushTimer) { clearInterval(this.pushTimer); this.pushTimer = null; }
      if (this.out) this.out.play(false);
      this.d.log(`ERROR [live] halted after ${this.chunkFails} consecutive chunk failures`);
      this.d.send({ type: 'LIVE_ERROR', code: 'HALTED', message: `Separation failed ${this.chunkFails} times in a row and live mode has stopped: ${message}` });
    }
    this.pushState(true);
  }

  /**
   * Hand this deck a cache writer to prime into, or take it back.
   *
   * The engine deliberately owns NO cache policy — when to prime, what the key
   * is, what to do with the result — only the two invariants above. Everything
   * else is shared/stemcache.js's.
   */
  attachCacheWriter(w) { this.cacheWriter = w || null; }
  detachCacheWriter() { const w = this.cacheWriter; this.cacheWriter = null; return w; }

  /** Live stats for the harness — not part of the UI contract. */
  stats() {
    const s = this.chunkMs.slice().sort((a, b) => a - b);
    return {
      deck: this.deck,
      // A prime that has been abandoned looks exactly like one that is going
      // fine, right up until commit() returns null. Put it on the wire.
      caching: this.cacheWriter ? { active: !this.cacheWriter.aborted, frames: this.cacheWriter.frames } : null,
      hopSeconds: this.plan ? this.plan.hopSeconds : null,
      demotions: this.demotions,
      // The engine changes this on its own when a second deck loads, so it must
      // be echoed or the UI's master fader silently disagrees with the audio.
      masterDb: this.masterDb,
      masterAuto: this.masterAuto,
      /**
       * `effective`, NOT `position` — this is the position the deck is APPLYING,
       * which is not the user's control value whenever the fader is parked
       * (offscreen.js effectiveXfPosition: a lone deck runs at its own end so it
       * is never attenuated 3 dB by a control nobody touched).
       *
       * It was called `position`, the console reasonably adopted it as the user's
       * intent, and that dragged the fader to the park point and then reported
       * the park point back as intent. Three bugs in this project have come from
       * a field whose name says one thing and whose value is another. The user's
       * control value is `XF_STATE.position`; the applied value is here and in
       * `XF_STATE.effective`, and those two agree by construction.
       */
      xf: { effective: this.xf.position, curve: this.xf.curve, assign: this.xf.assign.slice() },
      effectiveGains: this.node ? this.effectiveGains() : null,
      deckEdge: this.probeDeckEdge(),
      p95ChunkMs: +this.p95ChunkMs().toFixed(1),
      xfadeMs: SEAM_XFADE_MS, xfadeLaw: SEAM_XFADE_LAW, jitterCushionSec: LIVE_CUSHION_SEC,
      // Transpose + key. `key` is the wire value; `keyTap` is the diagnostic
      // half, and both are needed for the same reason `outputVerdict` and
      // `outputChecks` are: `state:'listening'` cannot tell "looking, not sure
      // yet" from "has never once managed to read a window".
      pitchSemitones: this.semitones,
      pitchDelaySec: +(PITCH_GROUP_DELAY_SAMPLES / SR).toFixed(4),
      key: this.keyTap.payload(),
      keyTap: this.keyTap.stats(),
      // The tempo half, and it needs BOTH for the same reason: `state:'listening'`
      // cannot tell "8 s of envelope and no periodicity" from "every block
      // refused". `bpmFaults` is separate from `bpm.faults` because the payload
      // only carries it while the fault is latched, and a gate wants the count
      // whatever state the tap is in.
      bpm: this.bpmPayload(),
      bpmTap: this.bpmTap.stats(),
      bpmFaults: this.bpmFaults,
      chunks: this.k, drops: this.drops, overruns: this.overruns, staleReads: this.staleReads,
      inFlight: this.inFlight, chunkFails: this.chunkFails, status: this.status,
      chunkMsAll: this.chunkLog,
      // read off the LIVE graph so run-ext.mjs can check the soft clipper is
      // actually wired with 4x oversampling — `applyCurve` in test.js proves the
      // curve shape but can never see the node's configuration (AUDIO.md §4.3:
      // without 4x the harmonics the clipper generates fold back as aliasing).
      masterBus: this.shaper ? { oversample: this.shaper.oversample, curveLength: this.shaper.curve && this.shaper.curve.length } : null,
      // END OF CHAIN. Everything above this line is measured at or before the
      // playback worklet; this is the only field that says the audio survived
      // pre -> shaper -> post. See outputProbe().
      output: this.outputProbe(),
      outputAlarm: this.outputAlarm, outputAlarmVariant: this.outputAlarmVariant,
      // The third watchdog arm, and BOTH fields are needed: `outputVerdict`
      // alone cannot distinguish "looked and saw signal" from "never ran".
      outputVerdict: this.outputVerdict, outputChecks: this.outputChecks, deadTicks: this.deadTicks,
      /**
       * THE COUNT THE ALARM IS ACTUALLY DECIDED ON, and its threshold beside it
       * so a gate never has to re-derive one from the other. `deadTicks` is
       * heartbeats and `deadFrames` is audio; on a machine that missed
       * heartbeats those two disagree, and the second one is the true statement
       * about what the listener heard.
       */
      deadFrames: this.deadFrames, deadHoldFrames: OUTPUT_DEAD_HOLD_FRAMES,
      // Ticks on which the capture window under the played frames could not be
      // read. Above zero means the variant degraded to the deck-side remedy
      // because the tab-side claim could not be supported — see inputPeakOver().
      inputWindowMisses: this.inputWindowMisses,
      healthAgeMs: this.lastHealthAt ? +(performance.now() - this.lastHealthAt).toFixed(0) : null,
      marginal: !!this.marginalWarned,
      marginalP95Fraction: MARGINAL_P95_FRACTION, marginalDropRate: MARGINAL_DROP_RATE,
      underruns: this.health.underruns, underrunFrames: this.health.underrunFrames,
      medianChunkMs: s.length ? +s[s.length >> 1].toFixed(1) : null,
      maxChunkMs: s.length ? +s[s.length - 1].toFixed(1) : null,
      sustainedRTF: +this.rtf().toFixed(4),
      worstMarginMs: s.length ? +(this.hopSeconds * 1000 - s[s.length - 1]).toFixed(1) : null,
      cushionSec: this.out ? +(this.out.cushion() / SR).toFixed(3) : null,
      bufferMinSec: +this.bufferMinSec().toFixed(3),
      floorSec: LIVE_CUSHION_SEC,
      playedSec: this.health.playedFrames / SR,
      /**
       * The playback read pointer, loaded from the SAB RIGHT NOW.
       *
       * `playedSec` above comes from the worklet's 10 Hz `health` post, so two
       * decks' copies of it can be a whole health period (100 ms = 4410 frames)
       * apart for no reason other than when each message happened to be sent.
       * That is fine for a gauge and useless for a cross-deck comparison: a
       * drift test built on it measures messaging jitter and calls it drift
       * (measured: A 134400 vs B 129920 frames over 3 s, entirely artefact).
       * This is an Atomics load off the ring, so reading both decks in one task
       * puts them microseconds apart — the same argument latencySec() makes.
       */
      playedFramesNow: this.out ? this.out.readFrames() : null,
      /**
       * Every passthrough span this session has published, in ABSOLUTE output
       * frames — the same clock the playback ring's read pointer uses.
       *
       * `drops` says a drop happened; `passthroughNow` says one is at the
       * speaker right now. Neither lets an offline analysis of the recorded
       * output ask the only question that matters when the output contains
       * something it should not: WAS THIS SPAN A DROP? Without it, a silent
       * region in the tap can be attributed to the ladder or to the mixer only
       * by guessing, and guessing is how the open hop-1.0 silence finding stayed
       * open. Capped at 64 by the ring below, same as passthroughNow uses.
       */
      passSpans: this.passSpans.slice(),
      producedSec: this.out ? this.out.writeFrames() / SR : 0,
      primedPct: +primedPct(Math.max(0, this.d.ring() ? this.d.ring().writeFrames() - this.baseFrame : 0)).toFixed(3),
      // The playback offset is set ONCE, by chunk 0: playback arms at
      // (hop + T_inf(chunk 0)) + (xfade + cushion). Later chunks only have to
      // fit inside one hop, which is what worstMarginMs reports. This is the
      // BUDGET; latencySec below is what the counters actually say.
      firstChunkMs: +this.firstChunkMs.toFixed(1),
      // What the deck ACTUALLY armed with. Differs from firstChunkMs whenever
      // the GPU is shared — see armPlayback(). Both decks must report the same
      // value in Mode 3; if they do not, one of them armed on chunk 0's luck.
      armMs: +this.armMs.toFixed(1),
      // Whether `armMs` was allowed to see chunk 0. See the field's declaration:
      // without this, a gate cannot tell "the floor was applied" from "the floor
      // could not be applied", and asserting the first against the second is a
      // permanent false red.
      armedOnChunk0: this.armedOnChunk0,
      // The BUDGET, and it carries the transpose's group delay for the same
      // reason latencySec() does — otherwise a gate comparing the prediction
      // against the measurement finds a permanent 70 ms discrepancy and has to
      // guess which of the two is wrong.
      predictedLatencySec: this.plan && this.armMs
        ? +(this.plan.H / SR + this.plan.X / SR + this.armMs / 1000 + LIVE_CUSHION_SEC
            + PITCH_GROUP_DELAY_SAMPLES / SR).toFixed(2)
        : null,
      latencySec: +this.latencySec().toFixed(3),
      outputLatencySec: (() => { const c = this.d.ctx(); return c && Number.isFinite(c.outputLatency) ? c.outputLatency : null; })(),
    };
  }
}
