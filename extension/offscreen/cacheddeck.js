/**
 * A CACHED DECK. Plays the already-separated stems — every name in `STEMS`, six
 * of them — out of the stem cache.
 *
 * This is the other half of Mode 3: one live deck doing the GPU work, one cached
 * deck costing nothing. It deliberately shares NOTHING with `LivePipeline`
 * except the two things that must be shared — the AudioContext and the master
 * bus — because almost everything in the live pipeline exists to hide a 7.8 s
 * forward pass, and a cached deck does not have one:
 *
 *   no inference worker   the stems are on disk
 *   no hop                there is no chunk schedule
 *   no causal window      nothing is being estimated
 *   no jitter cushion     nothing can be late
 *   no backpressure ladder, no passthrough plane, no drops, no `starving`
 *   no algorithmic latency at all — except the transpose lanes' 69.7 ms group
 *                         delay, which is constant at every setting INCLUDING 0
 *                         and is in latencySec() below; plus the worklet's own
 *                         output buffer, the same ~48 ms any Web Audio graph has
 *
 * What it DOES share, on purpose, is everything downstream of the summing point:
 * the same `stem-playback` worklet, the same RING_PLANES-plane ring, the same gain
 * slots and per-sample ramps, the same pre-crossfader meter tap, and the same
 * master soft clipper. A cached deck and a live deck must be indistinguishable
 * to the mixer, or the crossfader between them would not be a crossfader.
 *
 * BORROWED, NOT OWNED: `ctx` and `master` belong to the offscreen document and
 * are shared with the live deck. `dispose()` must never disconnect them.
 *
 * AND IT RUNS BOTH ANALYSIS TAPS. `LIVE_STATE.key` (engine/keytap.js) and
 * `LIVE_STATE.bpm` (engine/bpmtap.js) are published from here on the same 10 Hz
 * heartbeat and the same stem ring as the live deck's, for the same reason the
 * gain slots and the meter tap are shared: a surface must not have to know which
 * kind of deck it is reading. A cached deck that omitted `bpm` would not show a
 * blank — `offscreen.js` swaps deck A to this class on a cache hit, so the UI
 * would hold the LIVE deck's last tempo over a different track, and a readout
 * from another song is wrong rather than stale. Both taps are reset by
 * `load()`, `stop()` and — the one that matters here — `seek()`.
 */

import { SR, STEMS, STEM_RING_FRAMES, RING_PLANES, TAU, KEY_ACCUM_HZ, KEY_ESTIMATE_HZ } from '../shared/config.js';
import { StemRingWriter, stemRingByteLength } from '../shared/stemring.js';
import { ensurePlaybackWorklet } from './worklets.js';
import { resolveDeckGains, dbToGain } from '../engine/mixer.js';
// Same worklet, so the same group delay and the same transpose surface. See
// LivePipeline for why this is imported rather than duplicated.
import { PITCH_GROUP_DELAY_SAMPLES, PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES } from '../engine/pitch.js';
import { KeyTap } from '../engine/keytap.js';
import { BpmTap } from '../engine/bpmtap.js';

/**
 * Worklet gain slots, matching offscreen/playback-processor.js: stems occupy
 * `0..STEMS.length-1`, then passthrough, then master — 6 and 7 at six stems.
 * DERIVED for the same reason live.js derives them: a stale literal here lands
 * the passthrough duck on a stem's slot and nothing reports it.
 */
const G_PASS = STEMS.length, G_MASTER = STEMS.length + 1;

/**
 * The worklet's index-keyed meter array -> the stem-keyed METERS contract.
 * The same derivation as offscreen/live.js's `byStem`, deliberately separate
 * (this file shares nothing with LivePipeline that it does not have to) but
 * driven off the same `STEMS`, so the two decks cannot publish different shapes.
 */
function byStem(a) {
  const o = {};
  for (let i = 0; i < STEMS.length; i++) o[STEMS[i]] = a[i];
  o.master = a[STEMS.length];
  return o;
}

/** How far ahead of the playhead to keep the ring, seconds. */
const FILL_AHEAD_SEC = 4;
/** Top-up rate. Nothing can be late, so this only has to beat FILL_AHEAD_SEC. */
const FILL_HZ = 10;

/**
 * The tempo tap's cadence: fed at 10 Hz, re-estimates at 2 Hz. THREE constants
 * in this file now carry the number 10 and all three are deliberately separate.
 *
 *   FILL_HZ         how often the ring is topped up (and therefore how often
 *                   pushState fires). Sized against FILL_AHEAD_SEC.
 *   KEY_ACCUM_HZ    sized against a 16384-point FFT window and chroma.js's
 *                   display policy (shared/config.js).
 *   BPM_ACCUM_HZ    sized against bpmtap.js's 8 s envelope history and its
 *                   800-sample autocorrelation.
 *
 * They agree today because three independent answers came out the same, which is
 * not a dependency. Importing `KEY_ACCUM_HZ` for the tempo tap would mean a
 * future change to the key detector silently retunes this one, and nothing
 * downstream could see it — the same reasoning offscreen/live.js gives for the
 * same pair, and the reason `byStem()` above is duplicated rather than shared.
 *
 * WHAT THE PAIR COSTS, AS A COUNT (AGENTS.md: counts are citable,
 * absolutes are not). At `estimateHz` the autocorrelation runs at most once per
 * `tick()`, and one tick consumes at most `BPM_MAX_BLOCKS_PER_TICK` = 4 blocks of
 * 4410 frames however far the fill loop has run ahead. Ten ticks a second, <= 40
 * blocks, <= 2 autocorrelations, and it does not grow with the look-ahead, the
 * deck count or a seek.
 */
const BPM_ACCUM_HZ = 10, BPM_ESTIMATE_HZ = 2;

/**
 * WHERE A CACHED DECK MUST SEEK TO before playing, or null to play from where it
 * already is. Pure, because both branches are silent when wrong.
 *
 * 1. A cached deck loads at frame 0. Starting it against a video the user is
 *    1:30 into puts the stems at the top of the song and the picture in the
 *    middle — and the video lock then "corrects" it by dragging the video back
 *    to 0:00, which reads as the deck hijacking the transport. The user's
 *    playhead is the intent; ours follows it.
 * 2. A deck that ran to the end has its write head parked at the end, so
 *    `play()` alone re-ends it on the next fill and the replay is silent. That
 *    is the FIRST gesture anyone makes after a prime completes: the track
 *    finished, press play again.
 *
 * The threshold stops an ordinary pause/resume flushing the ring for a
 * difference nobody can hear. 0.25 s is far above `syncCorrection`'s 60 ms
 * (so the lock, not this, handles ordinary drift) and far below "a different
 * part of the song".
 *
 * @param {number} deckSec       the deck's current transport position
 * @param {string} status        'loaded' | 'playing' | 'paused' | 'ended' | ...
 * @param {number|null} pageSec  the page's playhead, or null if unknown
 */
export function resumeSeek(deckSec, status, pageSec, threshold = 0.25) {
  if (pageSec != null && Number.isFinite(pageSec) && Math.abs(deckSec - pageSec) > threshold) return pageSec;
  // No page to follow (or already in step) — but an ended deck still cannot
  // play from where it is, so rewind it rather than emitting nothing.
  if (status === 'ended') return 0;
  return null;
}

// ---------------------------------------------------------------- the deck
export class CachedDeck {
  /**
   * @param {'A'|'B'} id
   * @param {object} shared
   * @param {() => AudioContext} shared.ctx        BORROWED
   * @param {() => {build:Function, input:Function}} shared.master  BORROWED
   * @param {(msg:object) => void} shared.send
   * @param {(line:string) => void} shared.log
   * @param {(relPath:string) => string} shared.assetUrl  the Host's asset
   *        resolver (../shared/host.js) — the same one the live deck is handed
   */
  constructor(id, shared) {
    // The same refusal, for the same reason, as `offscreen/deck.js`'s — see the
    // note there. This deck is built lazily rather than at engine module scope,
    // so on its own it would report a bundle short the resolver at the first
    // cache hit and not at boot; both refusals exist because `assertHost()`
    // checks the Host and cannot see the hand-off onto `shared`.
    if (!shared || typeof shared.assetUrl !== 'function') {
      throw new TypeError(`CachedDeck ${id}: the shared bundle from offscreen/engine.js is missing `
        + "the Host's assetUrl — ensureGraph() resolves offscreen/playback-processor.js with it "
        + `(got ${shared == null ? String(shared) : typeof shared.assetUrl}).`);
    }
    this.id = id;
    this.s = shared;

    this.node = null;
    this.out = null;
    this.sab = null;

    /** @type {{stems:Record<string,Float32Array[]>, frames:number, meta:object}|null} */
    this.track = null;
    /** absolute frame of the track handed to the ring so far */
    this.writeHead = 0;
    /** frame the ring's read pointer was at when the current segment started */
    this.readBase = 0;
    this.status = 'idle';           // 'idle' | 'loaded' | 'playing' | 'paused' | 'ended'
    this.fillTimer = null;
    this.planes = null;

    this.mix = STEMS.map(() => ({ gainDb: 0, muted: false, soloed: false }));
    this.xf = { position: 0, curve: 'dip', assign: STEMS.map(() => 'XF') };
    /**
     * The same three master fields as `LivePipeline`, and they are here so the
     * engine's `reconcileMaster()` can treat the two kinds of deck identically.
     * A cached deck that lacked them would either crash that function or, worse,
     * be silently skipped — and then loading a cached deck alongside a live one
     * would leave the pair without the -3 dB dual trim that exists precisely so
     * the flagship gesture does not light the clip indicator on first use
     * (shared/config.js DUAL_MASTER_TRIM_DB).
     */
    this.masterDb = 0;
    this.masterAuto = true;
    this.masterUserSet = false;
    /**
     * Transpose and key, identical to the live deck's — and identical on purpose.
     * A cached deck and a live deck must be indistinguishable to the mixer, and
     * the play-along user is MORE likely to be on a cached deck than a live one
     * (it is the deck that can seek, so it is the deck you practise against).
     */
    this.semitones = 0;
    this.keyTap = new KeyTap({ sampleRate: SR, accumHz: KEY_ACCUM_HZ, estimateHz: KEY_ESTIMATE_HZ });
    this.keyAt = 0;
    /**
     * The tempo detector's window onto the `drums` planes — the key tap's
     * sibling, on the same ring, the same thread and the same 10 Hz heartbeat,
     * and upstream of the pitch shifter for the same reason (engine/bpmtap.js).
     *
     * A CACHED DECK NEEDS THIS MORE THAN A LIVE ONE, NOT LESS. `offscreen.js`
     * swaps deck A to a CachedDeck on a cache hit, so the embed reaches this file
     * on the SECOND listen to any track — and a `LIVE_STATE` with no `bpm` field
     * at all leaves the UI holding whatever it last painted, which for the deck
     * that can seek is the previous track's tempo over a different song.
     */
    this.bpmTap = new BpmTap({ sampleRate: SR, accumHz: BPM_ACCUM_HZ, estimateHz: BPM_ESTIMATE_HZ });
    /** performance.now() of the last tempo block, gated exactly like keyAt */
    this.bpmAt = 0;
    /**
     * A LATCHED tempo-detector fault and the count behind it. Null means the tap
     * has never thrown for this track. Both go on the wire — see bpmPayload(); a
     * detector that breaks and reports the same "no estimate" as one that is
     * merely listening is a feature reporting success for the same reason a
     * vacuous assertion does.
     */
    this.bpmFault = null;
    this.bpmFaults = 0;

    /**
     * THE TRANSPORT SURFACE'S STATE — `drive()` and `release()` below, and the
     * report `pushTransport()` puts on the wire.
     *
     * A Host whose Source is a FILE has a player: this deck. It presents a real
     * six-duty `DeckTransport` (`shared/host.js`) backed by these three, rather
     * than declaring `transport: null` — which reads as "nobody will ever tell
     * me whether a player is playing" and makes the deck start a capture and a
     * 109 MB model load on boot (`ui/embed-state.js` follow(), upstream #43).
     *
     * `transportMuted` is the ONE piece of deck state a transport write can
     * move that the user did not ask for, so it is the one `release()` has to
     * undo. It is deliberately NOT `masterDb`: the user's own master gain must
     * survive a lock being taken and given back, and folding the two would make
     * a release either forget the user's setting or fail to unmute.
     */
    this.transportMuted = false;
    /** The last report actually sent, as a key, so a still deck is silent. */
    this.transportAt = null;
  }

  // ------------------------------------------------------------------ graph
  async ensureGraph() {
    if (this.node) return;
    const ctx = this.s.ctx();
    // The live deck may already have registered this processor on this very
    // context, or be about to. offscreen/worklets.js owns that decision for both
    // kinds of deck; the node construction below is what proves the processor is
    // really there.
    await ensurePlaybackWorklet(ctx, this.s.assetUrl);
    this.sab = new SharedArrayBuffer(stemRingByteLength(STEM_RING_FRAMES));
    this.out = new StemRingWriter(this.sab, STEM_RING_FRAMES);
    this.node = new AudioWorkletNode(ctx, 'stem-playback', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: {
        sab: this.sab, capacity: STEM_RING_FRAMES, sampleRate: ctx.sampleRate,
        // A cached deck cannot starve, so the panic fade and the low-water mark
        // are vestigial here; they stay at the live values so the two decks
        // behave identically if one ever does.
        panicFadeMs: 20, lowWaterSec: 0.05, meterHz: 30, healthHz: 10,
      },
    });
    this.node.port.onmessage = (e) => this.onWorklet(e.data);
    const master = await this.s.master().build();
    this.node.connect(master.input());
    // Scratch for the ring fill. 64k frames x RING_PLANES planes — 3.7 MB at 14
    // planes, was 2.6 MB at 10 — allocated once: the fill runs on the main
    // thread and must not churn. RING_PLANES, not a literal: `out.write()` is
    // handed this array and indexes every plane it expects, so a short array
    // here is an out-of-range read on the ring writer, not a quieter mix.
    this.planes = Array.from({ length: RING_PLANES }, () => new Float32Array(65536));
  }

  // ---------------------------------------------------------------- loading
  /** @param {{stems:Record<string,Float32Array[]>, frames:number, meta:object}} track */
  async load(track) {
    for (const s of STEMS) {
      const ch = track.stems[s];
      if (!ch || ch.length !== 2 || ch[0].length !== track.frames) {
        throw new Error(`cached deck: stem ${s} is missing or the wrong length`);
      }
    }
    await this.ensureGraph();
    this.stopFill();
    this.track = track;
    this.out.reset();
    this.node.port.postMessage({ t: 'reset' });   // also clears the transpose lanes
    this.keyTap.reset();               // a new track is a new key. See seek() too.
    this.keyAt = 0;
    /**
     * ...and a new track is a new tempo, one label over. `out.reset()` two lines
     * up put the ring's write pointer back to 0, which is BELOW the tap's cursor:
     * `w - cursor` is then negative, the catch-up threshold never fires, every
     * block is refused as `early` and NO `envBreak` is recorded — so a tap that
     * was not reset here would hold the previous track's BPM forever with
     * clean-looking stats. bpmtap.js's reset() also throws the contiguous
     * envelope away, because an autocorrelation across a track seam does not lose
     * a vote the way a chroma histogram does, it INVENTS a periodicity.
     *
     * The latched fault clears here and in stop() and NOWHERE ELSE — those are
     * the two track boundaries. A seek is a discontinuity inside one track and
     * deliberately does not clear it (see seek()).
     *
     * ORDERING: every reset in this method precedes the ONE pushState() at the
     * bottom, so no LIVE_STATE from this call can carry the previous track's
     * readout. That is product ruling 8 and it is a property of this ordering, not of
     * this comment — `cached-load-emits-no-previous-track-bpm` in test.js is the
     * tripwire, and it goes red if these lines move below the push.
     */
    this.bpmTap.reset();
    this.bpmAt = 0;
    this.bpmFault = null;
    this.bpmFaults = 0;
    this.writeHead = 0;
    this.readBase = 0;
    /**
     * A NEW TRACK IS NOT UNDER ANYONE'S LOCK. A `transportMuted` carried across
     * a load would play the next track silently, with every meter and every
     * status field saying it was playing — the stale-but-plausible shape
     * `shared/stemcache.js`'s header calls the worst bug this project can ship,
     * wearing a mixer's clothes. Cleared here and in stop(), which are the two
     * track boundaries; `release()` is what clears it INSIDE a track.
     * It is cleared BEFORE pushMaster() below, so the graph is built unmuted.
     */
    this.transportMuted = false;
    this.transportAt = null;
    this.pushGains(0);
    this.pushMaster();                 // the graph exists now; see setMasterGain
    this.pushPitch();                  // ...and so does the transpose
    this.status = 'loaded';
    this.s.log(`[${this.id}] cached: ${(track.frames / SR).toFixed(1)} s · ${track.meta.title || track.meta.videoId || ''}`);
    this.fill();                       // buffer before the first read, not after
    this.pushState();
  }

  // -------------------------------------------------------------- transport
  play() {
    if (!this.track || this.status === 'playing') return;
    this.out.play(true);
    this.status = 'playing';
    this.startFill();
    this.pushState();
  }

  pause() {
    if (this.status !== 'playing') return;
    this.out.play(false);
    this.status = 'paused';
    this.pushState();
  }

  /**
   * Seek. The ring holds several seconds of already-published audio that is now
   * wrong, so it is thrown away and refilled — which is why a cached deck can
   * seek at all and a live deck cannot (a live deck would have to re-run the
   * model over the new position's causal window first).
   */
  seek(seconds) {
    if (!this.track) return;
    const frame = Math.max(0, Math.min(this.track.frames, Math.round(seconds * SR)));
    const wasPlaying = this.status === 'playing';
    this.out.play(false);
    this.out.reset();
    this.node.port.postMessage({ t: 'reset' });
    /**
     * A seek is a hard discontinuity (docs/ARCHITECTURE.md §3.9) and BOTH halves
     * of this feature have to be told. The worklet's `reset` above drops the
     * 3072 samples of the old position sitting inside the transpose lanes;
     * this drops the chroma accumulated from it. The ring counters also go back
     * to 0 here, so the tap's cursor would otherwise be permanently ahead of the
     * write pointer and never look at anything again.
     */
    this.keyTap.reset();
    this.keyAt = 0;
    /**
     * AND THE TEMPO TAP, WHICH IS THE ONE THIS WHOLE METHOD IS DANGEROUS FOR.
     * `out.reset()` six lines up sets the ring's write pointer back to 0 while
     * the tap's cursor is still wherever the old position left it — typically
     * over a million frames ahead. `tick()` then computes a NEGATIVE `w - cursor`,
     * so the catch-up branch (`> BPM_CATCHUP_FRAMES`) cannot fire, the
     * `cursor + n <= w` loop never runs, and the tap records no block, no refusal
     * and no envelope break. It reports the PRE-SEEK tempo, indefinitely, with
     * stats that look healthy. Reproduced on the live deck as
     * `write 1117935 -> 0, cursor was 1117935`.
     *
     * Seeking is the cached deck's primary gesture, so this line is load-bearing
     * in a way the live deck's equivalent is not, and it has its own assertion
     * (`cached-seek-clears-the-tempo-tap` in test.js) rather than sharing the
     * load() one — AGENTS.md: an assertion about a function with more than one
     * caller must name the entry point it applies to.
     *
     * The latched fault is NOT cleared here: a seek is a discontinuity inside one
     * track, not a new session, and a tick that threw part-way may have left the
     * cursor or the envelope torn. Retrying on torn state risks a confident lock,
     * which is the one output this feature must never produce. load() and stop()
     * clear it.
     */
    this.bpmTap.reset();
    this.bpmAt = 0;
    this.writeHead = frame;
    this.readBase = frame;
    this.fill();
    if (wasPlaying) this.out.play(true);
    this.pushState();
  }

  stop() {
    this.stopFill();
    if (this.out) { this.out.play(false); this.out.reset(); }
    this.keyTap.reset();
    this.keyAt = 0;
    // Same discontinuity, same argument as load(): `out.reset()` one line up
    // rewinds the write pointer under the cursor. The fault clears here because
    // this is a track boundary — the deck is going idle and whatever broke the
    // tap went with the track.
    this.bpmTap.reset();
    this.bpmAt = 0;
    this.bpmFault = null;
    this.bpmFaults = 0;
    this.track = null;
    this.writeHead = 0;
    this.readBase = 0;
    this.status = 'idle';
    // The other track boundary — see load(). A deck going idle is not under a
    // lock any more, and the next load must not inherit one.
    this.transportMuted = false;
    this.pushState();
  }

  /** BORROWED references are never disconnected here — the live deck may be using them. */
  dispose() {
    this.stopFill();
    if (this.node) {
      this.node.port.postMessage({ t: 'stop' });
      this.node.port.onmessage = null;
      this.node.disconnect();          // our node only; NOT master.pre/shaper/post
    }
    this.node = null; this.out = null; this.sab = null; this.planes = null;
    this.track = null;
    this.status = 'idle';
  }

  startFill() {
    if (this.fillTimer) return;
    this.fillTimer = setInterval(() => { this.fill(); this.pushState(); }, 1000 / FILL_HZ);
  }
  stopFill() {
    if (this.fillTimer) { clearInterval(this.fillTimer); this.fillTimer = null; }
  }

  // ------------------------------------------------------------------- fill
  /**
   * Top the ring up from memory. There is no deadline, so there is no drop and
   * no ladder: the only limits are ring space and how much of the track is left.
   * The track is STREAMED into the ring rather than loaded whole — a 4-minute
   * track is 10.6 M frames and the ring is 524 k.
   */
  fill() {
    if (!this.track || !this.out) return;
    const ahead = Math.round(FILL_AHEAD_SEC * SR);
    const planes = this.planes;
    for (;;) {
      const cushion = this.out.cushion();
      const room = Math.min(this.out.cap - cushion - 128, ahead - cushion);
      const left = this.track.frames - this.writeHead;
      const n = Math.min(room, 65536, left);
      if (n < 1) break;
      for (let k = 0; k < STEMS.length; k++) {
        const ch = this.track.stems[STEMS[k]];
        for (let c = 0; c < 2; c++) {
          planes[k * 2 + c].set(ch[c].subarray(this.writeHead, this.writeHead + n), 0);
        }
      }
      // The passthrough plane exists to carry the unseparated mix when the
      // ladder skips a chunk. Nothing is ever skipped here, so it stays silent.
      //
      // ITS INDEX IS DERIVED, NOT WRITTEN DOWN. Passthrough L/R are the LAST two
      // planes — `stemIdx * 2 + ch` for every stem, then the pair — so they moved
      // 8/9 -> 12/13 with the stem count. Hard-coded 8/9 would have zeroed
      // `guitar` instead and left the real passthrough planes carrying whatever
      // the previous fill put there, i.e. a stale loop of guitar under the mix.
      for (let q = STEMS.length * 2; q < RING_PLANES; q++) planes[q].fill(0, 0, n);
      if (!this.out.write(this.out.writeFrames(), planes, n)) break;
      this.writeHead += n;
    }
    if (this.status === 'playing' && this.writeHead >= this.track.frames && this.out.cushion() <= 0) {
      this.status = 'ended';
      this.out.play(false);
      this.stopFill();
      this.s.log(`[${this.id}] cached track ended`);
      this.pushState();
    }
  }

  // ------------------------------------------------------------------ mixer
  /**
   * Identical to the live deck's, deliberately: the same truth table, the same
   * pre-crossfader meter tap, the same ramps. See engine/mixer.js.
   */
  pushGains(tau = TAU.fader) {
    if (!this.node) return;
    const g = resolveDeckGains(this.id, this.mix, this.xf.assign, this.xf.position, this.xf.curve);
    // Every stem — see LivePipeline.pushGains(). A cached deck that wrote only
    // four would leave guitar and piano at the worklet's initial gain of 1,
    // which is the one way the two deck kinds could stop being interchangeable
    // to the mixer.
    for (let i = 0; i < STEMS.length; i++) {
      this.node.port.postMessage({ t: 'gain', i, value: g.meter[i], tau });
      this.node.port.postMessage({ t: 'xf', i, value: g.xf[i], tau });
    }
    this.node.port.postMessage({ t: 'gain', i: G_PASS, value: g.pass, tau });
  }
  setStemGain(stem, db) { const i = STEMS.indexOf(stem); if (i >= 0) { this.mix[i].gainDb = db; this.pushGains(TAU.fader); } }
  setStemMute(stem, on) { const i = STEMS.indexOf(stem); if (i >= 0) { this.mix[i].muted = !!on; this.pushGains(TAU.mute); } }
  setStemSolo(stem, on) { const i = STEMS.indexOf(stem); if (i >= 0) { this.mix[i].soloed = !!on; this.pushGains(TAU.mute); } }
  /**
   * @param {number} gainDb
   * @param {boolean} auto true when the ENGINE chose this (the dual-deck trim),
   *        false when the user did. Same latch as the live deck's.
   *
   * STORED, THEN PUSHED — and the store is the part that matters. The engine
   * applies the dual trim the moment a second deck loads, which for a cached
   * deck can be BEFORE `ensureGraph()` has built the node; the live deck learned
   * this the expensive way (`live.js` pushMaster: "-3 dB in the field, unity in
   * the worklet"). `load()` re-pushes so the graph always ends up agreeing with
   * the field.
   */
  setMasterGain(gainDb, auto = false) {
    const db = Number(gainDb);
    if (!Number.isFinite(db)) return;
    if (!auto) this.masterUserSet = true;
    this.masterDb = db;
    this.masterAuto = auto;
    this.pushMaster();
  }
  /**
   * THE MASTER FIELD, WITH THE TRANSPORT'S MUTE ON TOP OF IT. `masterDb` is the
   * user's (and the dual-deck trim's); `transportMuted` is a Host lock's, taken
   * through `drive({muted})` and given back through `release()`. Two writers,
   * one field, and the order is the point: a mute wins while it is held and the
   * user's dB is still there underneath when it is released.
   */
  pushMaster() {
    if (!this.node) return;
    const value = this.transportMuted ? 0 : dbToGain(this.masterDb);
    this.node.port.postMessage({ t: 'gain', i: G_MASTER, value, tau: TAU.master });
  }
  /**
   * The transpose. Refused rather than clamped, for the same reason the live
   * deck refuses: a clamped value leaves the UI composing a key display against
   * an interval the audio is not applying, and nothing downstream can see it.
   * @returns {boolean} accepted
   */
  setPitch(semitones) {
    const k = semitones;
    if (!Number.isInteger(k) || k < PITCH_MIN_SEMITONES || k > PITCH_MAX_SEMITONES) return false;
    this.semitones = k;
    this.pushPitch();
    return true;
  }
  /**
   * STORED, THEN PUSHED — and `load()` re-pushes, exactly like `pushMaster`.
   * The transpose can be set before `ensureGraph()` has built the node (the UI
   * has one control and does not know which deck kind is behind it), and a
   * message posted to a node that does not exist yet goes nowhere.
   */
  pushPitch() {
    if (this.node) this.node.port.postMessage({ t: 'pitch', semitones: this.semitones });
  }
  /** One key-detection window, rate-gated. See LivePipeline.tickKey(). */
  tickKey() {
    if (!this.out || !this.track) return;
    const now = performance.now();
    if (now - this.keyAt < 1000 / KEY_ACCUM_HZ - 5) return;
    this.keyAt = now;
    this.keyTap.tick(this.out);
  }

  /**
   * One tempo-detector block, at most every 1/BPM_ACCUM_HZ. Deliberately the same
   * shape as tickKey() above — same driver, same guards, same wall-clock gate
   * with the same 5 ms of slop — and a SIBLING rather than two lines inside
   * tickKey(), so each tap has its own entry point and its own timestamp.
   *
   * The 5 ms of slop is because a setInterval(100) fires at 99 ms often enough
   * that a strict `>= 100` gate silently halves the rate. The gate is on the WALL
   * CLOCK rather than on the call because pushState() is not only the FILL_HZ
   * heartbeat — load(), play(), pause(), seek(), stop() and the end-of-track
   * branch all force one, and without the gate a burst of those would weight
   * whatever was playing during the burst.
   *
   * The two differences from tickKey(), and both are the fault contract:
   *
   *   1. It cannot throw into the heartbeat. pushState() is the 10 Hz publisher
   *      AND the thing every transport method uses to report; an exception
   *      escaping here would take the whole readout down over a DISPLAY-ONLY
   *      label.
   *   2. It is not a bare `catch {}`. The throw is counted, the first message is
   *      latched and logged once, and the wire says `state: 'fault'` from then on
   *      (bpmPayload()). A tap that silently stopped would present as one that is
   *      listening and has not decided — the "an assertion must FAIL when it
   *      cannot look" shape moved out of the harness and into shipped code.
   *
   * Once latched the tap is OFF until the next load() or stop(). That is on
   * purpose: a tick that threw part-way may have left the cursor, the envelope
   * ring or `prevM` inconsistent, and carrying on would risk a confident lock
   * derived from torn state. It also bounds a repeating fault at one throw rather
   * than ten a second.
   */
  tickBpm() {
    if (!this.out || !this.track) return;
    if (this.bpmFault) return;
    const now = performance.now();
    if (now - this.bpmAt < 1000 / BPM_ACCUM_HZ - 5) return;
    this.bpmAt = now;
    try { this.bpmTap.tick(this.out); } catch (e) { this.bpmFault_('tick', e); }
  }

  /**
   * Record a tempo-detector fault. COUNTED ALWAYS, LOGGED ONCE — one error line
   * per heartbeat for the life of a track buries the first and only useful one.
   */
  bpmFault_(where, err) {
    this.bpmFaults++;
    if (this.bpmFault) return;
    this.bpmFault = `${where}: ${String((err && err.message) || err)}`;
    this.s.log(`ERROR [${this.id}] cached: tempo tap faulted in ${where} and is off until the next load: ${this.bpmFault}`);
  }

  /**
   * THE WIRE VALUE for this deck's `LIVE_STATE.bpm`, and the only place it is
   * built. Four fields from engine/bpmtap.js when the tap is healthy — `{state,
   * bpm, confidence, beatFrame}` with `state` one of none/listening/locked — and
   * a FIFTH state, `'fault'`, when it is not, carrying the latched message and
   * the count.
   *
   * WHY A FIFTH STATE AND NOT JUST `none`. `none` means "the tap looked and there
   * was nothing to hear" and `listening` means "it is looking"; both are honest
   * reports from a working detector, and a broken one reporting either would be
   * claiming coverage it does not have. The extra fields are ADDITIVE, so a
   * surface that only knows the four states still renders nothing — but the
   * failure is on the wire and in the log instead of nowhere.
   *
   * The same shape LivePipeline publishes, deliberately: a cached deck and a live
   * deck must be indistinguishable to the surface reading them, exactly as they
   * must be to the mixer.
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
  setXfader(p) { this.xf.position = p; this.pushGains(TAU.fader); }
  setXfCurve(c) { this.xf.curve = c; this.pushGains(TAU.fader); }
  setXfAssign(stem, target) { const i = STEMS.indexOf(stem); if (i >= 0) { this.xf.assign[i] = target; this.pushGains(TAU.fader); } }

  // -------------------------------------------------- the transport surface
  /**
   * WHAT A `DeckTransport` REPORTS, OFF THIS DECK'S OWN PLAYBACK CLOCK.
   *
   * A Host with a File source has no `<video>`, and this is what it reports
   * instead. The six fields are exactly the six `shared/host.js`'s
   * `DeckTransport.onState` says the deck READS — `playing`, `currentTime`,
   * `duration`, `ended` and `seeking` — five of the six; the sixth is the rate,
   * and the block below says why this player has none. A Host relays what is
   * here verbatim and invents nothing.
   *
   * WHY THIS IS NOT `LIVE_STATE`, WHICH ALREADY CARRIES A POSITION. `LIVE_STATE`
   * is the READOUT, and its `status` collapses `loaded`, `paused` and `ended`
   * into the single word `'ready'` (see pushState below). Those are three
   * different answers to "is your player playing, and is it finished" and a
   * transport must be able to give them separately: an `ended` deck reported as
   * `paused` is a deck the Host will never rewind. Parsing a readout to
   * reconstruct transport state is the second copy of a decision, in the
   * direction where the copy is the one that is wrong.
   *
   * THERE IS NO RATE FIELD, AND ITS ABSENCE IS THE HONEST ANSWER RATHER THAN AN
   * OMISSION. `DeckTransport.onState` names six values the deck reads and this
   * carries five; the sixth is the player's rate, and this player has none to
   * report. The ring is consumed by the audio device at its own rate, there is
   * no resampler anywhere on this path, and the transpose is not a rate —
   * `engine/pitch.js` is length-exact, so a transposed deck still plays one
   * second per second.
   *
   * IT IS ALSO THE RULE, not merely the fact. `qa/speed-pitch.mjs` asserts that
   * NOTHING under `extension/{engine,offscreen,workers,shared}/` names the page
   * rate in code, less `offscreen/engine.js` which owns the engine's record of
   * it — that gate is how this project knows the engine never shifts on the
   * page's rate, and a report inventing a constant `1` here would be the first
   * engine file to grow a reader of it. The deck side is unharmed:
   * `ui/embed.js::onElementRate` ignores a value that is not a positive finite
   * number, so nothing paints a rate, and `speedGate` greys the speed control
   * on `source === 'cache'` in any case — a cached deck's speed control has
   * been locked, with a sentence, since before this surface existed.
   *
   * `seeking` IS FALSE ON EVERY REPORT, INCLUDING THE ONE seek() PUSHES, and
   * that is a decision rather than an omission. This deck's seek is one
   * synchronous turn — the ring is flushed and refilled before seek() returns —
   * so there is no interval during which it is seeking to report. It also must
   * not be true, and the mechanism is a loop: `ui/embed.js`'s `onVideoState`
   * turns every report into `PAGE_VIDEO { currentTime, seeking }`, and
   * `offscreen/engine.js` seeks a cached deck on `seeking === true`. A deck
   * that reported its own seek would be told to seek to a position ~100 ms
   * stale by the time it arrived, ten times a second, flushing the tempo tap on
   * every heartbeat (see seek(), which resets it) — a deck that never locks a
   * tempo, with nothing red anywhere.
   *
   * @returns {{playing:boolean, currentTime:number, duration:number,
   *            ended:boolean, seeking:boolean, atMs:number}}
   */
  transportReport() {
    return {
      playing: this.status === 'playing',
      currentTime: +this.positionSec().toFixed(3),
      duration: this.track ? +(this.track.frames / SR).toFixed(3) : 0,
      ended: this.status === 'ended',
      seeking: false,
      /**
       * WHEN IT WAS SAMPLED, on the wall clock and for the same reason
       * `LIVE_STATE` carries one: this crosses a bus hop, and a Host that
       * relays it to a deck 50-100 ms later would be reporting a playhead that
       * has moved further than the video lock's own 60 ms threshold.
       * `Date.now()` and not `performance.now()` — two contexts, two origins.
       */
      atMs: Date.now(),
    };
  }

  /**
   * PUT THE REPORT ON THE WIRE, on every event that moves it and on none that
   * does not. Called from pushState(), which is already the one place every
   * transport method and the FILL_HZ heartbeat converge on — so "every event
   * that moves it" is a property of that convergence and not of a list here
   * that could fall out of step with it.
   *
   * DEDUPED ON THE VALUE, so a paused or idle deck falls silent instead of
   * repeating itself ten times a second. `atMs` is deliberately not in the key:
   * it moves on every tick and would defeat the dedupe entirely, which is the
   * one-character version of not having one.
   */
  pushTransport() {
    const r = this.transportReport();
    const key = `${r.playing}|${r.currentTime}|${r.duration}|${r.ended}|${r.seeking}`;
    if (key === this.transportAt) return;
    this.transportAt = key;
    this.s.send({ type: 'TRANSPORT_STATE', deck: this.id, ...r });
  }

  /**
   * WRITE THE PLAYER — `DeckTransport.drive`, landing on this deck's playback
   * instead of on a media element.
   *
   * THE WRITE SET IS CLOSED AND IT IS ADR 0001 DECISION 4'S: mute, rate and
   * position, and nothing else, ever. TWO OF THE THREE LAND HERE and the third
   * is refused in `offscreen/engine.js`, which is not a division of taste:
   * `qa/speed-pitch.mjs` asserts that no engine-side file except that one names
   * the page rate in code, and this player is the very thing that rule
   * describes — it has no rate to be driven to. The refusal is written where the
   * engine's record of the rate already lives, beside the `SPEED` handler's
   * identical refusal for a cached deck ("no page rate to drive").
   *
   * THE CLOSURE IS IMPLEMENTED HERE, by reading named fields off whatever was
   * handed over — so `offscreen/engine.js` passes the raw inbound message,
   * envelope and all, and a field a caller smuggled in lands nowhere rather than
   * being trusted because the Host filtered it first. `ui/host.js` closes it
   * again at the other end, and the two closures are not redundant: one is per
   * Host and one is per player, and a second Host doing the obvious
   * `Object.assign(player, patch)` inherits whatever the unit passed.
   *
   * @param {{muted?:boolean, currentTime?:number}} patch
   * @returns {string[]} the fields that landed, in the order they were applied
   */
  drive(patch) {
    const p = patch || {};
    const applied = [];
    if (typeof p.muted === 'boolean' && p.muted !== this.transportMuted) {
      this.transportMuted = p.muted;
      this.pushMaster();
      applied.push('muted');
    }
    // LAST, because it is the one that flushes the ring: a mute applied before
    // the seek survives it, and pushState() at the foot of seek() then reports
    // the new position outward in the same turn.
    if (Number.isFinite(p.currentTime)) { this.seek(p.currentTime); applied.push('currentTime'); }
    return applied;
  }

  /**
   * HAND THE PLAYER BACK THE WAY IT WAS FOUND — `DeckTransport.release`.
   *
   * Unmuted, rate 1. It is NOT a no-op just because there is no element: a
   * muted deck left behind is a track that plays silently with every meter
   * saying otherwise, and it is the one thing `drive()` can do that the user
   * cannot see and cannot undo. The position is deliberately NOT restored — a
   * player handed back keeps its playhead; that is what "the way it was found"
   * means for a transport, and rewinding on release would undo the user's own
   * scrub.
   */
  release() {
    const was = this.transportMuted;
    this.transportMuted = false;
    if (was) this.pushMaster();
    // Report outward, so a Host that took the lock can see it was given back
    // rather than assume it. pushState() is what carries the transport report.
    this.pushState();
  }

  // ----------------------------------------------------------------- report
  /** Transport position: what the worklet has actually consumed, not written. */
  positionSec() {
    if (!this.track || !this.out) return 0;
    return Math.min(this.track.frames, this.readBase + this.out.readFrames()) / SR;
  }

  /**
   * Latency for a cached deck is the output buffer and nothing else — no hop, no
   * cushion, no inference. That is the entire point of caching, and it is why
   * `syncCorrection` (ui/audio-math.js) can lock the video here when live mode
   * cannot.
   */
  latencySec() {
    const ctx = this.s.ctx();
    const outLat = ctx && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    /**
     * ...plus the transpose lanes' group delay, which the shared worklet applies
     * at EVERY setting including 0 (drums take a matched delay of exactly the
     * same length, which is what keeps all STEMS.length planes aligned). 69.7 ms.
     *
     * This is the readout `ui/audio-math.js::syncCorrection` locks the video to,
     * and its correction threshold is 60 ms — so omitting a constant 69.7 ms
     * offset would not be a rounding error, it would be a permanent one-sided
     * correction that never converges.
     */
    return outLat + PITCH_GROUP_DELAY_SAMPLES / SR;
  }

  onWorklet(m) {
    if (m.t === 'meters') {
      this.s.send({ type: 'METERS', deck: this.id, peak: byStem(m.peak), rms: byStem(m.rms), clip: !!m.clip });
    }
  }

  /**
   * Deliberately the same SHAPE as LIVE_STATE so the console can render a cached
   * deck with the same widgets, with the fields that cannot apply pinned to the
   * values that mean "not applicable": no hop, no drops, nothing starving.
   */
  pushState() {
    this.tickKey();
    this.tickBpm();
    /**
     * THE TRANSPORT REPORT RIDES THE SAME HEARTBEAT AS THE READOUT, and it is
     * pushed FIRST. A Host relays it to the deck as `DeckTransport.onState`,
     * and the deck's handler sends the engine `PAGE_VIDEO` — which is an input
     * to the commit decision `LIVE_STATE` cannot reach. Same ordering argument
     * as `ui/embed.js`'s "the page's transport goes to the engine first".
     */
    this.pushTransport();
    /**
     * THE PLAYHEAD AND ITS TIMESTAMP, SAMPLED TOGETHER AND ON THESE TWO LINES.
     * Identical to `offscreen/live.js::pushState`, deliberately: a cached deck
     * and a live deck must be indistinguishable to the surface reading them, and
     * this pair's only consumer is a beat phase (`bpmtap.js::beatPhaseAt`). A
     * playhead carried on one message with a timestamp taken elsewhere in the
     * same function is a phase error dressed as data.
     */
    const atMs = Date.now();
    const playFrames = this.out ? this.out.readFrames() : null;
    this.s.send({
      type: 'LIVE_STATE', deck: this.id,
      source: 'cache',
      status: this.status === 'playing' ? 'running' : this.status === 'idle' ? 'idle' : 'ready',
      phase: null,
      hopSec: null, pendingHopSec: null,
      latencySec: +this.latencySec().toFixed(3),
      passthroughNow: false,
      bufferMinSec: this.out ? +(this.out.cushion() / SR).toFixed(3) : 0,
      bufferSec: this.out ? +(this.out.cushion() / SR).toFixed(3) : 0,
      floorSec: 0, targetSec: FILL_AHEAD_SEC,
      rtf: 0, drops: 0, underruns: 0, overruns: 0, staleReads: 0,
      primedPct: 1,
      /**
       * THE TRANSPORT POSITION, in SECONDS ALONG THE TRACK — `readBase +
       * readFrames()`, clamped to the track and divided by SR. This is the
       * VIDEO-LOCK quantity (`ui/audio-math.js::audioClockAt` ->
       * `syncCorrection`) and it is NOT the beat's axis: `readBase` is added
       * here and is not added to `playFrames` below, so after a seek the two
       * differ by exactly that. TWO MEANINGS, TWO NAMES — do not "unify" them;
       * AGENTS.md's entry-point family is five defects from a value that was
       * right at one call site and wrong at another.
       *
       * Both are read from the same monotonic ring counter inside this one
       * synchronous turn, which is what lets the single `atMs` below stamp both.
       */
      positionSec: +this.positionSec().toFixed(3),
      durationSec: this.track ? +(this.track.frames / SR).toFixed(3) : 0,
      // Same shape and same rule as the live deck: CONCERT tonic only, composed
      // with the transpose and the instrument by ONE function in the UI.
      key: this.keyTap.payload(),
      /**
       * THE TEMPO — {state:'none'|'listening'|'locked'|'fault', bpm:number|null,
       * confidence:number, beatFrame:number|null} (+ `fault`/`faults` on the
       * fault state only), the same contract offscreen/live.js publishes.
       *
       * PRESENT UNCONDITIONALLY, including before a track is loaded. A missing
       * field is not "no tempo yet" to a UI — it is whatever the surface painted
       * last, which on a cache hit is the live deck's BPM over a completely
       * different song. `none` says the tap looked and heard nothing, and that is
       * a different claim from silence.
       *
       * `beatFrame` is an ABSOLUTE STEM-RING frame, on `this.out`'s counters —
       * NOT a track position. The two differ by `readBase` after a seek, and the
       * one way to use it is `bpmtap.js::beatPhaseAt()`, which is invariant to
       * that offset. Do not add a `phase` field here (bpmtap.js payload()).
       *
       * DISPLAY ONLY, and deliberately not composed with `pitchSemitones`:
       * pitch.js is length-exact, so the transpose does not move tempo and a UI
       * correcting for it would be inventing one.
       */
      bpm: this.bpmPayload(),
      pitchSemitones: this.semitones,
      /**
       * THE PLAYHEAD, in ABSOLUTE STEM-RING FRAMES — `this.out.readFrames()`,
       * the audio device's own counter, and the SAME FIELD, SAME AXIS AND SAME
       * MEANING as `offscreen/live.js`'s. It is the axis `bpm.beatFrame` above
       * is on (both are counters on `this.out`), which is the whole reason it
       * exists: `bpmtap.js::beatPhaseAt(bpm, frame, SR)` is the one call site of
       * the beat modulo and it needs a frame on that axis to measure
       * `beatFrame` against. Without it a cached deck reported a tempo and no
       * beat, and since `offscreen.js` swaps deck A to this class on a cache
       * hit, the pulse was dead on the SECOND listen to any track — which is the
       * listen the play-along user is on (see this file's header).
       *
       * `readFrames()` PLAIN, WITHOUT `readBase`, and that is the load-bearing
       * half. `positionSec` above adds `readBase` because it is a position along
       * the TRACK; `beatFrame` is not, and `seek()` resets the ring counters to
       * 0 and resets the tap in the same breath, so both sides of the phase
       * restart together and a post-seek `playFrames` is never a stale frame.
       * Adding `readBase` here would put the playhead a whole seek ahead of the
       * beat it is measured against, and the pulse would look plausible and be
       * wrong — which is the failure mode a shared field name is supposed to
       * prevent, not create.
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
       * WHEN THE PLAYHEAD WAS SAMPLED, on the wall clock, for BOTH readouts
       * above. Without it the video sync has a systematic bias the same size as
       * its own threshold: this message is published at 10 Hz and crosses a
       * `chrome.runtime` hop, so by the time the surface next to the `<video>`
       * reads it the playhead has moved 50-100 ms — and `syncCorrection` starts
       * correcting at 60. The reader advances it by `Date.now() - atMs` before
       * comparing, which turns a constant lag into a sample age it can subtract.
       * The beat phase does the same with `playFrames`, and at 128 BPM one beat
       * is 469 ms, so an uncorrected 100 ms is a fifth of a beat of standing
       * phase error.
       *
       * `Date.now()`, NOT `performance.now()`: the offscreen document and the
       * page have different `performance` time origins, so the difference
       * between them is meaningless. This is the one clock they share. Same
       * field name, same clock and same reason as `live.js`'s.
       */
      atMs,
    });
  }
}
