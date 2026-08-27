/**
 * THE BOUNCE RENDER PATH - the deck's own output, rendered offline, as one file.
 *
 * Read engine/bounce.js first: it carries what a bounce IS, what it bakes, why
 * speed is not one of the things it bakes, and the twelve-seconds-then-silence
 * failure this file exists to avoid. This file is the effect; that one is the
 * arithmetic.
 *
 * ------------------------------------------------------------- THE MECHANISM
 *
 * The SHIPPED playback worklet, byte for byte, on an OfflineAudioContext:
 *
 *   stem ring (SAB) -> `stem-playback` -> ctx.destination
 *
 * and the producer is paced against the render by suspend(t)/resume() rather
 * than by a timer. Four things this needs were measured in this Electron and
 * Chromium before the design was taken:
 *
 *   audioWorklet.addModule() on an OfflineAudioContext             WORKS
 *   a SAB reaching an offline worklet through processorOptions     WORKS
 *   suspend(t)/resume() mid-render with a worklet running          WORKS, 3/3
 *   samples written DURING a suspension appearing in the output    WORKS
 *
 * The last one is the whole design. Suspension timing is EXACT, not
 * approximate: requested equals actual to six decimals at quantum-aligned
 * values, so engine/bounce.js can compute the stops deterministically.
 *
 * THE WORKLET IS NOT MODIFIED, NOT FORKED AND NOT REIMPLEMENTED. It already has
 * no clock in it (engine/bounce.js says where that was checked), so the offline
 * render gets the same transpose, the same per-sample gain ramps, the same
 * pre-crossfader meter tap and the same sum as the speakers do. Anything else
 * would be a second copy of the mixer, which is the drift ADR 0001 exists to
 * prevent.
 *
 * ------------------------------------------------- WHAT IS AND IS NOT IN THE FILE
 *
 * IN: the deck's stem faders, its mute/solo, its crossfader column and position,
 * its master gain, and its transpose - i.e. everything the worklet applies,
 * which is everything a listener heard from THIS deck.
 *
 * OUT: the shared master bus (offscreen/master.js). Deliberately, and it is
 * worth the sentence. That chain is one soft clipper on the SUM of both decks,
 * and its own header says why it is shared: "a soft clipper per deck cannot
 * protect the sum". A per-deck bounce that ran a per-deck clipper would apply a
 * non-linearity that never acted on this deck alone, and would do it to a
 * deliverable. The deck's node output is what "what the deck is playing" means.
 *
 * A bounce may therefore exceed +/-1.0, and that is correct rather than
 * tolerated: it is written 32-bit float, and wav.js's float path does not clamp
 * (shared/wav.js) precisely so a deliverable never inherits an irreversible
 * clip. The same reasoning that forced 32f on the stem tier forces it here.
 *
 * OUT, TOO: the passthrough plane, which is silent for a cached track. It exists
 * to carry the unseparated mix over a span the live ladder skipped, and nothing
 * is ever skipped here - the same statement offscreen/cacheddeck.js's fill()
 * makes, for the same reason.
 *
 * ------------------------------------------------------------ THE TWO SEAMS
 *
 * `audio.offlineContext` and `audio.workletNode` are duck-typed the way
 * shared/wav.js's WavSyncWriter is duck-typed on four members of an OPFS
 * handle: so that OPFS - here, a browser - "is not a precondition for testing".
 * They default to the platform's own constructors, so a caller in the offscreen
 * document passes nothing; qa/bounce.mjs passes a pair that boots the shipped
 * worklet in a vm realm and pumps it at the render quantum. What the suite
 * CANNOT see through them is Chromium's own OfflineAudioContext honouring the
 * suspension schedule, which is the one thing the measurements above cover and
 * this suite does not. Said plainly here so nobody reads a green qa/bounce.mjs
 * as covering it.
 */

import { SR, STEMS, RING_PLANES } from '../shared/config.js';
import { StemRingWriter, stemRingByteLength } from '../shared/stemring.js';
import { ensurePlaybackWorklet } from './worklets.js';
import { resolveDeckGains, dbToGain } from '../engine/mixer.js';
import { WavStreamEncoder } from '../shared/wav.js';
import { bouncePlan, bounceFileName, bounceError } from '../engine/bounce.js';

/** Worklet gain slots, derived exactly as cacheddeck.js and live.js derive them. */
const G_PASS = STEMS.length, G_MASTER = STEMS.length + 1;

/**
 * The ramp constant every bounce setting is posted with, in seconds.
 *
 * A BOUNCE HAS NO GESTURES IN IT. Every setting is constant for the whole
 * render, so the smoothing that exists to keep a fader from clicking has
 * nothing to smooth - and the worklet's slots all start at 1, so a bounce that
 * posted TAU.master would spend 6 tau = 120 ms sliding from unity to the deck's
 * real master gain at the head of the file.
 *
 * 1e-5 is the floor the worklet's own message handler clamps to
 * (`Math.max(m.tau || 0.003, 1e-5)`), and it puts the exact snap at
 * ceil(6e-5 * 44100) = 3 samples. Those three samples land inside the transpose
 * group delay, where the output is still the delay lines' initial zeros, so the
 * ramp is not merely short - it multiplies silence. Note that a literal 0 would
 * NOT work: `m.tau || 0.003` reads 0 as absent and hands back the default.
 */
const BOUNCE_TAU = 1e-5;

/** Frames of ring scratch per copy. 65536 x 14 planes = 3.7 MB, allocated once. */
const SCRATCH_FRAMES = 65536;

/**
 * Post the deck's settings into the worklet, once, before the first quantum.
 *
 * THE TRANSPOSE TAKES TWO MESSAGES AND THE SECOND IS LOAD-BEARING.
 * `{t:'pitch'}` alone is `PitchLanes.setSemitones`, which opens a 3072-sample
 * prime and a 50 ms crossfade against a bank still sitting at 0 - correct for a
 * user turning the control mid-track, wrong for a render that starts at the
 * setting. `{t:'reset'}` re-applies `target` to BOTH banks from the first
 * sample, which is exactly what playback-processor.js's own rebuild path does
 * and for the same reason. Without it the first ~50 ms of every transposed
 * bounce slides up from concert pitch, OUTSIDE the 3072-frame trim, and it
 * sounds like a tape start.
 */
function pushSettings(node, s) {
  const g = resolveDeckGains(s.id, s.mix, s.xf.assign, s.xf.position, s.xf.curve);
  for (let i = 0; i < STEMS.length; i++) {
    node.port.postMessage({ t: 'gain', i, value: g.meter[i], tau: BOUNCE_TAU });
    node.port.postMessage({ t: 'xf', i, value: g.xf[i], tau: BOUNCE_TAU });
  }
  node.port.postMessage({ t: 'gain', i: G_PASS, value: g.pass, tau: BOUNCE_TAU });
  node.port.postMessage({ t: 'gain', i: G_MASTER, value: dbToGain(s.masterDb), tau: BOUNCE_TAU });
  node.port.postMessage({ t: 'pitch', semitones: s.semitones });
  node.port.postMessage({ t: 'reset' });
  return g;
}

/**
 * Render a whole cached track through the deck's own settings, offline.
 *
 * @param {object} o
 * @param {{stems:Record<string,Float32Array[]>, frames:number, meta?:object}} o.track
 * @param {ReturnType<import('../engine/bounce.js').bounceSettings>} o.settings
 * @param {(relPath:string) => string} o.assetUrl  the Host's asset resolver
 * @param {{offlineContext?:Function, workletNode?:Function}} [o.audio]  see the header
 * @param {(p:{frame:number, frames:number, pct:number}) => void} [o.onProgress]
 * @param {() => boolean} [o.cancelled]  polled at each producer stop, never mid-quantum
 * @returns {Promise<{left:Float32Array, right:Float32Array, frames:number,
 *                    plan:object, underruns:number, underrunFrames:number, stops:number}>}
 */
export async function renderBounce(o) {
  const track = o.track;
  if (!track || !Number.isInteger(track.frames) || track.frames < 1) {
    throw bounceError('NO_TRACK', `renderBounce got ${track ? `frames ${track.frames}` : String(track)}`);
  }
  for (const s of STEMS) {
    const ch = track.stems && track.stems[s];
    if (!ch || ch.length !== 2 || ch[0].length < track.frames || ch[1].length < track.frames) {
      throw bounceError('NO_TRACK',
        `stem ${s} is missing or shorter than the track's ${track.frames} frames`);
    }
  }
  const makeCtx = (o.audio && o.audio.offlineContext)
    || ((channels, length, sampleRate) => new OfflineAudioContext(channels, length, sampleRate));
  const makeNode = (o.audio && o.audio.workletNode)
    || ((ctx, name, opts) => new AudioWorkletNode(ctx, name, opts));

  const plan = bouncePlan({ frames: track.frames, capacity: o.capacity, refillEvery: o.refillEvery });
  const ctx = makeCtx(2, plan.renderFrames, SR);
  await ensurePlaybackWorklet(ctx, o.assetUrl);

  const sab = new SharedArrayBuffer(stemRingByteLength(plan.capacity));
  const out = new StemRingWriter(sab, plan.capacity);
  const node = makeNode(ctx, 'stem-playback', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    processorOptions: {
      sab, capacity: plan.capacity, sampleRate: SR,
      // The same values a cached deck uses. A bounce must not be able to starve
      // at all, but if it ever does it must starve the way the speakers do -
      // otherwise the counters below would be measuring a different worklet.
      panicFadeMs: 20, lowWaterSec: 0.05, meterHz: 30, healthHz: 10,
    },
  });
  node.connect(ctx.destination);
  pushSettings(node, o.settings);

  const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(SCRATCH_FRAMES));
  const total = plan.quantaFrames;
  let writeHead = 0;

  /**
   * Top the ring up to its brim from the track, then from silence.
   *
   * THE TAIL IS SILENCE AND IT IS NOT OPTIONAL. The transpose lanes hold 3072
   * samples of the track after its last frame goes in, and Web Audio renders
   * ceil(length / quantum) WHOLE quanta. If the producer stopped at
   * `track.frames`, the last quanta would find `avail < n`, the worklet would
   * take its starvation branch, and the end of every bounce would fade out over
   * 20 ms - the tail of the music, faded, with nothing red.
   */
  function fill() {
    for (;;) {
      const room = out.cap - out.cushion();
      const n = Math.min(room, SCRATCH_FRAMES, total - writeHead);
      if (n < 1) break;
      const fromTrack = Math.max(0, Math.min(n, track.frames - writeHead));
      for (let k = 0; k < STEMS.length; k++) {
        const ch = track.stems[STEMS[k]];
        for (let c = 0; c < 2; c++) {
          const d = planes[k * 2 + c];
          if (fromTrack > 0) d.set(ch[c].subarray(writeHead, writeHead + fromTrack), 0);
          if (fromTrack < n) d.fill(0, fromTrack, n);
        }
      }
      // Passthrough L/R are the LAST pair, derived and never written down - the
      // same rule cacheddeck.js's fill() states. Nothing is skipped here, so
      // they stay silent.
      for (let q = STEMS.length * 2; q < RING_PLANES; q++) planes[q].fill(0, 0, n);
      if (!out.write(out.writeFrames(), planes, n)) break;
      writeHead += n;
    }
  }

  out.play(true);
  fill();

  /**
   * THE TWO-LAYER GUARD, and both layers are watched red in qa/bounce.mjs.
   *
   * Layer 1 NAMES THE FAILURE AT THE CALL: every throw inside a suspension
   * callback is caught here and turned into a message carrying the frame and
   * the second it happened at, instead of surfacing as an unhandled rejection
   * from a promise nobody is awaiting.
   *
   * Layer 2 GUARDS THE WHOLE BLOCK: `ctx.resume()` is in a `finally`, so EVERY
   * exit from this callback resumes the render. The exit that proves it is the
   * CANCEL RETURN two lines down - a bare `return` skips anything written after
   * the try/catch, so without the finally a cancelled bounce leaves the context
   * suspended for ever and `startRendering()` never settles. Not slow: HUNG,
   * with the reason sitting in a promise nobody reads. (The same finally also
   * covers the case the catch itself throws, which is rarer and untestable.)
   *
   * THE BOUND, stated rather than implied: the guard converts a crash into a
   * report. It does NOT recover the render. Whatever the producer failed to
   * write is missing, so the audio from that stop onwards is starved and the
   * counters say so; `failure` below is re-thrown after the render settles so
   * the caller never sees a truncated bounce presented as a finished one. In
   * the suite this is measured: the guarded suite reports one named red and
   * TWO assertions that never ran at all.
   */
  let failure = null;
  let stops = 0;
  let cancelled = false;
  for (const r of plan.refills) {
    ctx.suspend(r.seconds).then(() => {
      try {
        stops++;
        if (o.cancelled && o.cancelled()) { cancelled = true; return; }
        fill();
        if (o.onProgress) o.onProgress({ frame: r.frame, frames: total, pct: r.frame / total });
      } catch (e) {
        if (!failure) {
          failure = bounceError('RENDER_FAILED', `the producer failed at frame ${r.frame} of ${total} `
            + `(${(r.frame / SR).toFixed(2)} s): ${String((e && e.message) || e)}`);
        }
      } finally {
        ctx.resume();
      }
    });
  }

  const buf = await ctx.startRendering();
  if (failure) throw failure;
  if (cancelled) throw bounceError('CANCELLED', `at frame ${plan.refills[0] ? plan.refills[0].frame : 0}`);

  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0);
  const trim = plan.trimFrames;
  return {
    left: L.slice(trim, trim + plan.outputFrames),
    right: R.slice(trim, trim + plan.outputFrames),
    frames: plan.outputFrames,
    plan,
    stops,
    // THE STARVATION COUNTERS, read off the ring the worklet wrote them to.
    // A count, not a stopwatch: a bounce that fell behind its own producer
    // reports a positive number here, and a correct one reports 0.
    underruns: out.underruns(),
    underrunFrames: out.underrunFrames(),
  };
}

/**
 * Write a rendered bounce to wherever the Host puts a deliverable.
 *
 * ONE FILE, THROUGH THE SAME DUTY SIX WOULD USE. `exportSink` takes a plan with
 * a `files` array and answers a map keyed by the same names; a bounce passes one
 * name and reads one writable back. The duty's own prose says so - see
 * shared/host.js, where the sentence about N being one is there because this
 * call site is the reason it can be.
 *
 * @param {(plan:{title:string, files:string[]}) => Promise<Record<string, WritableStream>>} exportSink
 * @param {{title:string, left:Float32Array, right:Float32Array, frames:number}} r
 */
export async function writeBounce(exportSink, r) {
  const name = bounceFileName(r.title);
  /**
   * LAYER 1 OF THE GUARD, at the one call across the seam. A Host that refuses -
   * the user cancelling the dialog is the ORDINARY case, and the duty says a
   * refusal is a throw - would otherwise reach the wire as RENDER_FAILED, which
   * blames the render for the user's own cancel. The Host's own words are kept:
   * they are the only thing that says WHY, and this side cannot know.
   */
  let map;
  try {
    map = await exportSink({ title: r.title, files: [name] });
  } catch (e) {
    throw bounceError('SINK_REFUSED', String((e && e.message) || e));
  }
  const writable = map && map[name];
  if (!writable) {
    throw bounceError('SINK_REFUSED', `the Host answered a map with `
      + `${map ? Object.keys(map).length : 0} entries and none of them is ${JSON.stringify(name)}`);
  }
  const enc = new WavStreamEncoder(2, { sampleRate: SR, bitDepth: 32, float: true, frames: r.frames });
  const left = r.left, right = r.right;
  async function* source() {
    for (let at = 0; at < r.frames; at += SCRATCH_FRAMES) {
      const n = Math.min(SCRATCH_FRAMES, r.frames - at);
      yield [[left.subarray(at, at + n), right.subarray(at, at + n)], n];
    }
  }
  await enc.pipeTo(writable, source());
  return { files: [name], bytes: enc.byteLength };
}

/**
 * Render and write, which is the whole duty as one call.
 * Kept separate from the two halves above so a caller that wants the samples -
 * a gate, a future preview - does not have to invent a sink to get them.
 *
 * THE RENDER RUNS BEFORE THE HOST IS ASKED, and that ordering is a decision.
 *
 *   FOR: a cancelled bounce then touches nothing at all - no dialog, no file,
 *   no writable to abort - which is the strongest form of "nothing lands", and
 *   it is asserted rather than described (qa/bounce.mjs section 10). Asking
 *   first would mean holding a writable open for the minutes a render takes and
 *   then having to abort a file the user can already see in their folder.
 *
 *   AGAINST: a Host that was always going to refuse costs the user a whole
 *   render first. `separationRefusal` refuses before the decode and before the
 *   model for exactly that reason, and the symmetric move here would be a
 *   cheap pre-flight.
 *
 *   WHY IT IS ACCEPTABLE ANYWAY: the Host this is for opens its dialog from the
 *   main process, where there is no user-gesture deadline to miss, and its
 *   refusal is a cancel rather than a capability - a Host that cannot write
 *   files at all is a Host nobody offers a Bounce button on. The extension's own
 *   `offscreen/host.js` refuses every plan, and it reaches the wire as
 *   SINK_REFUSED carrying that Host's own sentence, not as a render failure.
 */
export async function bounceToSink(o) {
  const r = await renderBounce(o);
  const w = await writeBounce(o.exportSink, {
    title: o.title, left: r.left, right: r.right, frames: r.frames,
  });
  return { ...w, frames: r.frames, underruns: r.underruns, stops: r.stops };
}
