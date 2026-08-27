/**
 * Runnable checks for the non-trivial DSP. No browser, no framework, no deps.
 *
 *   node test.js            # everything
 *   node test.js fft ring   # just those groups
 *
 * What is covered and why (CONTRIBUTING.md: "non-trivial logic leaves one runnable
 * check behind"):
 *
 * THE GROUP NAMES BELOW ARE THE ONES `group()` ACTUALLY TESTS. Three names that
 * were listed here for months — `ola`, `sum`, `wav` — belonged to no group at
 * all, so `node test.js ola wav` printed `0 passed, 0 failed` and exited 0:
 * `tools/verify.mjs`'s VOID rule calls that a hard failure for a suite, and a
 * header that lies about its filters is how a run ends up asserting nothing
 * while reporting success. Keep this list and `if (group('…'))` in step.
 *
 *   window   the export window is upstream Demucs' triangular transition weight,
 *            AND THE WAV BYTE MAP: encodeWav/decodeWav round-trip at 32f, 24-bit
 *            and 16-bit, the header field offsets, and the sample-conversion loop
 *            that every writer in shared/wav.js shares — which is what makes this
 *            group the coverage the wavstream group's mutation note defers to
 *   wavstream  U1's streaming WAV writers: the chunked and the unknown-length
 *            OPFS writer emit exactly the bytes encodeWav emits, the header is
 *            final before any audio is written, and a wrong frame count throws
 *   fft      rfft agrees with a naive DFT; STFT/iSTFT round-trips
 *   ring     the SAB capture ring is lossless across wrap
 *   live     Mode 1: the causal chunk plan emits every sample exactly once, the
 *            crossfade reconstructs an identity model exactly, all twelve stem
 *            planes are sample-aligned, the stem ring accounts for under- and
 *            overruns under a simulated slow producer, and neither a stop
 *            mid-inference nor an L3 demotion leaves a scratch buffer detached
 *   cache    the prime-then-play stem cache: keys, eviction, refusals, resume
 *   export   U11's E1: the six untouched model outputs out of the 32f tier into
 *            a Host's exportSink — base names that cannot leave the chosen
 *            folder, 32f/44.1k/stereo in the emitted header, samples bit-identical
 *            to what the cache holds, a cancelled run that leaves no partial
 *            file, a windowed read whose peak does not grow with the track, and
 *            the closed EXPORT_ERROR vocabulary
 *   mix      fader law round trip, mute/solo truth table, per-sample gain
 *            smoothing settle time, soft clipper transfer function
 *   xf       the crossfader: curves, targets, and the per-stem assignment
 *   sched    Mode 3's L3 policy: who gives up the GPU, and who never does
 *   dual     two decks on one GPU, end to end against a simulated clock
 *   backend  the inference seam (S6): the serialising wrapper lets one
 *            load()/separate() reach a backend at a time, in call order, and
 *            the deck builds its own backend through it
 *   verifyModel  the model pin the UNIT keeps (S7): a mismatching buffer is
 *            refused naming both hashes, a truncated one naming both byte
 *            counts, the load policy re-fetches a corrupt stored copy exactly
 *            once and never twice, and nothing under extension/ names the
 *            model's upstream host except the extension host's own pin
 *   host     the Host seam, both halves. The boot check names a missing duty
 *            and refuses a Host that is short one, the engine really runs it
 *            before it builds anything, R5's track-stop survives every failing
 *            path, and each shipped Host — offscreen/host.js, ui/host.js — is
 *            driven through the duties the typedef spells MUST: the envelope,
 *            late binding, the address filter, the MV3 response channel, the
 *            capture token, and the swallowed delivery failure
 *
 * ---------------------------------------------------------------------------
 * RENDERING vs REACHABILITY — read this before trusting an assertion here.
 *
 * A test that CONSTRUCTS the state it is testing cannot prove the production
 * path ever reaches that state. We nearly shipped `phase` with pushState()
 * rendering it perfectly and nothing assigning it: the unit test set `lp.phase`
 * by hand, so the field was null for the entire priming window and only the
 * browser caught it.
 *
 * Five groups below are rendering-only. Each is marked `RENDERING ONLY` at the
 * head, says what it cannot see, and names what covers reachability:
 *
 *   1. gain smoothing (`mix`)     reimplements the worklet's one-pole loop.
 *        reached by: run-ext.mjs measures 18.0 ms mute-to-silence in the
 *        rendered samples.
 *   2. QA-15 summing (`mix`)      reimplements the worklet's summing line.
 *        reached by: run-ext.mjs "output is EXACTLY zero for the whole kill".
 *   3. soft clip (`mix`)          `applyCurve` reimplements WaveShaper.
 *        reached by: run-ext.mjs reads `oversample` and the curve length off
 *        the live graph (4x is mandatory, AUDIO.md §4.3).
 *   4. ladder simulation (`live`) reimplements pump()'s loop, though the
 *        DECISION it drives is the real `skipFrames`.
 *        reached by: run-ext.mjs DEV_FORCE_DROP and the hop-1.0 soak.
 *   5. SAB ring producer (`ring`, `live`) mirrors capture-processor.js, which
 *        cannot be imported outside an AudioWorklet.
 *        reached by: run-ext.mjs "SAB ring filled from the AudioWorklet".
 *
 * Everything else drives production code directly and is reachable by
 * construction. When you add a test, say which kind it is.
 *
 * ---------------------------------------------------------------------------
 * TWO GUARDS THAT PRODUCE THE SAME OBSERVATION ARE ONE GUARD, and only one of
 * them is being tested.
 *
 * AGENTS.md's rule is that a fixture which makes two INPUTS identical is blind
 * to whatever distinguishes them. This is that rule ONE LEVEL UP — not two
 * identical inputs, two identical OBSERVATIONS — and it is in this header
 * rather than beside the assertion it was found on because it generalises to
 * every group here.
 *
 * MEASURED, in `export`: "a 16-bit entry is not a deliverable" stayed GREEN with
 * the MANIFEST ROW's depth check deleted, because the FILE HEADER check caught
 * the same fixture, threw the same `WRONG_TIER`, and put "16-bit" in its
 * message too. Two guards, one observation. The assertion could not say which
 * had fired, so one of the two was untested while it sat green — and a mutation
 * battery aimed at that assertion reported a watched red it had not watched.
 *
 * THE FIX IS A SECOND OBSERVATION THE TWO GUARDS DISAGREE ABOUT, never a more
 * specific string to match. There it is A COUNT OF THE STEM FILES OPENED: the
 * row check refuses before a single file is opened, and the header check has to
 * open all six to look at one, so `opens.length === 0` is a number the
 * surviving guard cannot produce.
 *
 * So when two paths can raise the same failure, ask what they do DIFFERENTLY —
 * how far the run got, what it touched, how many times — and assert THAT. Same
 * code and same words is not evidence about which line ran.
 *
 * ---------------------------------------------------------------------------
 * AN ASSERTION NOTHING ELSE CAN MAKE IS LOAD-BEARING. Say so where it stands,
 * so the next reader does not trim it as a restatement of its neighbour.
 *
 * `export`'s "the six files advance TOGETHER, never one finished at a time"
 * reads like a weaker copy of the "NO PARTIAL FILE IS LEFT" assertion two lines
 * above it. It is the only assertion in this file that can see a SEQUENTIAL
 * write. MEASURED: swapping the run's two loops so each stem is written whole
 * before the next one starts — the defect that leaves five complete WAVs on a
 * user's disk after they press Stop — leaves "no partial file" GREEN, because
 * at the cancel point the first stem is not finished either way. The SPREAD
 * between the longest and shortest destination is the only figure that moves.
 * Delete it and the interleaved write loop has no coverage at all.
 */

import { encodeWav, decodeWav, WavStreamEncoder, WavSyncWriter, WavWindowReader } from './extension/shared/wav.js';
import { pipelineVersion, cacheKey, bytesForSeconds, CacheWriter, planEviction,
  videoIdFromUrl, primeRefusal, commitRefusal, StemCache, CACHE_DIR,
  CACHE_DIR_32F, separationRefusal,
  fileIdFromBytes, fileIdentity, fileRefusal, fileCommitRefusal } from './extension/shared/stemcache.js';
import { CachedDeck, resumeSeek } from './extension/offscreen/cacheddeck.js';
import {
  ExportRun, ExportError, EXPORT_CODES, checkExportCode, safeTitle, exportFileNames,
} from './extension/engine/export.js';
// The transpose lanes' group delay, IMPORTED and never re-typed. It is a term in
// the latency assertion below, and a second copy of 3072 in this file is a second
// place for the assertion to disagree with the code it is checking.
import { PITCH_GROUP_DELAY_SAMPLES } from './extension/engine/pitch.js';
import { syncCorrection, audioClockAt } from './extension/ui/audio-math.js';
import { SEGMENT, STRIDE, SR, STEMS, RING_FRAMES } from './extension/shared/config.js';
import { RingConsumer, ringByteLength } from './extension/shared/ring.js';
import { rfft, stft, istft, hann } from './extension/engine/fft.js';
import {
  makeLivePlan, chunkPlan, makeFades, LiveEmitter, readWindow, primedPct, skipFrames, STEM_PLANES,
  PASS_PLANE_L, PASS_PLANE_R,
} from './extension/engine/live.js';
import { StemRingWriter, stemRingByteLength, PLANES, H_READ, H_PLAY } from './extension/shared/stemring.js';
import { outputTick, OUTPUT_DEAD_HOLD_SEC, OUTPUT_DEAD_HOLD_FRAMES, MIXER_SILENT_PEAK } from './extension/offscreen/live.js';
import {
  faderDb, dbToFader, dbToGain, resolveGains, passthroughGain, effectiveXfPosition, softClip, softClipCurve,
  applyCurve, smoothCoef, SILENT_DB,
  xfaderGains, xfFactor, xfStemGain, resolveDeckGains, masterTrimDb,
} from './extension/engine/mixer.js';
import { GpuScheduler, demotionDecision } from './extension/engine/scheduler.js';
import {
  LIVE_HOPS, SEAM_XFADE_LAW, STEM_RING_HEADER_BYTES, RING_PLANES, TAU,
  LIVE_CUSHION_SEC, LIVE_LOW_WATER_SEC, MARGINAL_P95_FRACTION, MARGINAL_DROP_RATE, LIVE_HOP_DEFAULT,
  HEALTH_HZ, XF_CURVES, XF_CURVE_DEFAULT, XF_CUT_EDGE, XF_TARGETS, XF_ASSIGN_DEFAULT,
  XF_POSITION_DEFAULT, DECKS, MODEL, STEM_CACHE_MAX_BYTES, STEM_CACHE_32F_MAX_BYTES,
} from './extension/shared/config.js';

let pass = 0, fail = 0;
const only = process.argv.slice(2);
/**
 * EVERY NAME `group()` IS ASKED ABOUT, whether or not it ran. It is what makes
 * the two checks at the foot of this file possible: a filter that matches no
 * group, and a header list that has drifted from the groups it describes. Both
 * are the mechanism that let `ola`, `sum` and `wav` sit in that list for months
 * while `node test.js ola wav` printed `0 passed, 0 failed` and exited 0 —
 * verify.mjs's VOID rule wearing a summary line. Every `if (group('…'))` at top
 * level is evaluated on every run, filter or no filter, so this set is complete
 * by the time the checks read it.
 */
const known = new Set();
const group = (n) => { known.add(n); return !only.length || only.includes(n); };

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
}
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/**
 * A THROW INSIDE A BLOCK IS A DEAD FILE, AND A DEAD FILE IS WORSE THAN A RED.
 *
 * This file is ONE process: a block that throws ends the run, so every later
 * block's verdict is lost and the summary line never prints. That is the exact
 * shape of upstream #30 — a suite whose ability to REPORT a defect was itself
 * destroyed by the defect — and it has now appeared three times in the cache
 * group alone: `CacheWriter.stems()` throwing on a frames/audio disagreement,
 * a block reaching for a file a broken `put()` never wrote, and this suite's
 * own apparatus doing the same.
 *
 * `stemcache.js` already does LAYER 1: it NAMES the failure instead of letting
 * a `RangeError` escape from inside `Float32Array.set`. This is LAYER 2, and it
 * belongs at the CALLER, because only the caller knows which block died.
 *
 * LAYER 1 SAYS WHAT WENT WRONG; LAYER 2 SAYS WHAT IT COST. Neither is the other's
 * substitute. A named throw with no guard is a good message on a dead file; a
 * guard with no naming is a live file reporting that something unspecified
 * happened. Read together they give the whole account in one red line — the
 * thrown sentence, the block it killed, and the assertions that never ran.
 *
 * ITS BOUND, MEASURED AND STATED: it converts a crash into a report. It does
 * NOT recover the assertions after the throw — those did not run, are not
 * counted, and the red says so in those words. A block that throws is still a
 * failure; it is now a failure you can read the rest of the file around.
 */
function blockThrew(what, e) {
  ok(`${what} — the block ran to its end without throwing`, false,
    `THREW: ${(e && e.message) || e}  ...the assertions after that point DID NOT RUN and are not `
    + 'counted. This names the death; it does not undo it.');
}

/** 20*log10(||a-b|| / ||b||) */
function residualDb(a, b) {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; num += d * d; den += b[i] * b[i]; }
  if (den === 0) return num === 0 ? -Infinity : Infinity;
  return 10 * Math.log10(num / den);
}

function noise(n, seed = 1) {
  // deterministic LCG so failures are reproducible
  let s = seed >>> 0;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = (s / 4294967296) * 2 - 1; }
  return x;
}

/**
 * A MINIMAL IN-MEMORY OPFS, AND THE ONLY ONE IN THIS FILE. Seeded by U0 (#33)
 * for the two-instance isolation gate and extended by U10 (#34) for the rest of
 * `StemCache`. One implementation, because two would be two chances to be
 * wrong about the same platform.
 *
 * Only the calls `shared/stemcache.js` actually makes are implemented, and the
 * TWO REJECTIONS ARE LOAD-BEARING: `getFileHandle` on a missing file and
 * `removeEntry` on a missing entry must THROW, because those are exactly what
 * `readJson()`, `get()`, `clear()` and `delete()` catch. A shim that resolved
 * them would let a whole block pass against a cache that never stored anything
 * — the VOID failure one level down.
 *
 * `navigator` IS A CONFIGURABLE GETTER WITH NO SETTER in Node 22, so a plain
 * `globalThis.navigator = {...}` silently does nothing and leaves
 * `navigator.storage` undefined. Measured, not assumed. `defineProperty` is the
 * only thing that takes, and `restore()` puts the original descriptor back.
 *
 * WHY THIS IS A SHIM AT `navigator.storage` AND NOT A `dir()` SEAM — read this
 * before "simplifying" it into one, because a seam is smaller and worse:
 *
 *  1. IT RUNS THE SHIPPED PATH. `dir()`, `readJson()`, `writeFile()`,
 *     `loadManifest()` and the order `put()` writes in are all production code
 *     under every assertion above. A `dir()` seam lets the tests agree with the
 *     seam while the real `dir()` drifts — which is the exact failure these
 *     suites exist to catch, so building the instrument out of it would be
 *     circular.
 *  2. THE SEAM WOULD SIT ON MOVING LINES. `dir()` had just become
 *     instance-scoped for the 32f tier (U0, #33) — a seam threaded through it
 *     would have had to be re-cut by that change, and an instrument that is
 *     re-cut every time its anchor moves is one that will eventually be cut
 *     wrong and go on passing.
 *
 * The apparatus beyond a plain filesystem is deliberate and named:
 *   `written`  every file name in the order its bytes LANDED, which is how the
 *              "manifest is written last" claim is checked rather than believed.
 *   `failOn`   file names whose next close() throws, to interrupt a put mid-way
 *              and see what a crash leaves behind.
 *   `reads`    every READ, with its byte range, which is how U11's "peak
 *              resident does not scale with track length" is MEASURED rather
 *              than argued from the shape of the code. A `WavWindowReader` that
 *              quietly slurped each file would satisfy every sample assertion in
 *              group('export'); it cannot satisfy this one.
 *
 * `getFile()` HANDS BACK A REAL `Blob`, wrapped only so the ranges can be
 * recorded. The wrapper does not implement `slice` — it delegates to the
 * platform's — because a hand-rolled `slice` that ignored its arguments and
 * returned the whole file would make the windowed reader look like it worked
 * while reading everything, which is exactly the failure `reads` exists to
 * catch. The instrument must not be able to fake the thing it measures.
 */
function installOpfs() {
  const written = [];
  const reads = [];
  const failOn = new Set();
  const toBytes = (d) => {
    if (d instanceof Uint8Array) return new Uint8Array(d);
    if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    return new Uint8Array(Buffer.from(String(d), 'utf8'));
  };
  const mkDir = (name) => {
    const files = new Map();
    return {
      name, files,
      async getFileHandle(n, opts) {
        if (!files.has(n)) {
          if (!(opts && opts.create)) throw new Error(`NotFoundError: ${n}`);
          files.set(n, new Uint8Array(0));
        }
        return {
          async getFile() {
            const b = files.get(n);
            if (!b) throw new Error(`NotFoundError: ${n}`);
            const blob = new Blob([b]);
            return {
              size: blob.size,
              async text() { return blob.text(); },
              async arrayBuffer() { reads.push({ name: n, at: 0, bytes: blob.size }); return blob.arrayBuffer(); },
              slice(start, end) { reads.push({ name: n, at: start, bytes: end - start }); return blob.slice(start, end); },
            };
          },
          async createWritable() {
            const parts = [];
            return {
              async write(data) { parts.push(toBytes(data)); },
              async close() {
                if (failOn.has(n)) { failOn.delete(n); throw new Error(`simulated write failure: ${n}`); }
                let t = 0; for (const q of parts) t += q.byteLength;
                const all = new Uint8Array(t);
                let o = 0; for (const q of parts) { all.set(q, o); o += q.byteLength; }
                files.set(n, all);
                written.push(n);
              },
            };
          },
        };
      },
      async removeEntry(n) { if (!files.delete(n)) throw new Error(`NotFoundError: ${n}`); },
    };
  };
  const dirs = new Map();
  const root = {
    async getDirectoryHandle(n, opts) {
      if (!dirs.has(n)) {
        if (!(opts && opts.create)) throw new Error(`NotFoundError: ${n}`);
        dirs.set(n, mkDir(n));
      }
      return dirs.get(n);
    },
    async removeEntry(n) { if (!dirs.delete(n)) throw new Error(`NotFoundError: ${n}`); },
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => root } }, configurable: true, writable: true,
  });
  return {
    root, dirs, written, failOn, reads,
    cacheDir: () => root.getDirectoryHandle(CACHE_DIR, { create: true }),
    /** What is actually on disk in one directory, sorted. */
    names: (d = CACHE_DIR) => (dirs.has(d) ? [...dirs.get(d).files.keys()].sort() : []),
    restore: () => { if (saved) Object.defineProperty(globalThis, 'navigator', saved); else delete globalThis.navigator; },
  };
}

/**
 * The worklet gain-slot map, DERIVED from STEMS rather than spelled. Slots
 * `0..STEMS.length-1` are the stems in wire order, then passthrough, then
 * master — the same expressions `offscreen/live.js` and
 * `offscreen/cacheddeck.js` compute (`G_PASS = STEMS.length`). Written once here
 * because the 4-stem suite had `4` and `5` typed into nine separate assertions,
 * and every one of them would have gone green on a build that wrote the
 * passthrough onto the guitar slot.
 */
const G_PASS = STEMS.length, G_MASTER = STEMS.length + 1;
/** Plane index of stem `k`'s L/R, the layout `(stemIdx * 2 + ch)`. */
const planeL = (k) => k * 2, planeR = (k) => k * 2 + 1;
/** One open (unmuted, unsoloed, 0 dB) channel strip per stem in `STEMS`. */
const openStrips = (db = 0) => STEMS.map(() => ({ gainDb: db, muted: false, soloed: false }));
/** Every stem assigned to the crossfader — the default matrix row. */
const XF_ALL = STEMS.map(() => 'XF');
/** Index of a stem by name, so an assertion names the stem and not a literal. */
const S_IDX = Object.fromEntries(STEMS.map((s, i) => [s, i]));

// ===========================================================================
if (group('window')) {
  head('wav — round trip + byte map (AUDIO.md §5.4)');
  const n = 5000;
  const l = noise(n, 3), r = noise(n, 4);
  // deliberately out of range: 32f export must not clip (AUDIO.md §5.3)
  l[10] = 1.7; r[11] = -1.42;

  {
    const buf = encodeWav([l, r], { sampleRate: SR, bitDepth: 32, float: true });
    const dv = new DataView(buf);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    ok('RIFF/WAVE/fmt  tags', tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ');
    ok('fmt chunk is 18 bytes (non-PCM needs cbSize)', dv.getUint32(16, true) === 18);
    ok('audioFormat = 3 (IEEE float)', dv.getUint16(20, true) === 3);
    ok('numChannels = 2', dv.getUint16(22, true) === 2);
    ok('sampleRate = 44100', dv.getUint32(24, true) === 44100);
    ok('byteRate = 352800', dv.getUint32(28, true) === 352800);
    ok('blockAlign = 8, bits = 32', dv.getUint16(32, true) === 8 && dv.getUint16(34, true) === 32);
    ok('cbSize = 0 at offset 36', dv.getUint16(36, true) === 0);
    ok('fact chunk at 38 with numFrames', tag(38) === 'fact' && dv.getUint32(46, true) === n);
    ok('data chunk at 50, size = frames*8', tag(50) === 'data' && dv.getUint32(54, true) === n * 8);
    ok('RIFF size field = fileSize - 8', dv.getUint32(4, true) === buf.byteLength - 8);

    const back = decodeWav(buf);
    ok('32f round trip is bit exact',
      back.channels[0].every((v, i) => v === l[i]) && back.channels[1].every((v, i) => v === r[i]));
    ok('32f preserves out-of-range samples (no clip, no rescale)',
      back.channels[0][10] === Math.fround(1.7) && back.channels[1][11] === Math.fround(-1.42));
    ok('decoded rate/depth/float flag', back.sampleRate === SR && back.bitDepth === 32 && back.float === true);
  }

  for (const bits of [24, 16]) {
    const clamped = [Float32Array.from(l, (v) => Math.max(-1, Math.min(0.999, v))),
                     Float32Array.from(r, (v) => Math.max(-1, Math.min(0.999, v)))];
    const buf = encodeWav(clamped, { sampleRate: SR, bitDepth: bits, float: false, dither: false });
    const dv = new DataView(buf);
    ok(`${bits}-bit: fmt 16 bytes, format 1, no fact`,
      dv.getUint32(16, true) === 16 && dv.getUint16(20, true) === 1 &&
      String.fromCharCode(dv.getUint8(36), dv.getUint8(37), dv.getUint8(38), dv.getUint8(39)) === 'data');
    const back = decodeWav(buf);
    const lsb = 1 / (1 << (bits - 1));
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(back.channels[0][i] - clamped[0][i]));
    ok(`${bits}-bit round trip within 1 LSB`, worst <= lsb, `worst ${(worst / lsb).toFixed(2)} LSB`);
  }

  {
    // the exported length must equal the source length exactly (AUDIO.md §5.3)
    const buf = encodeWav([new Float32Array(7), new Float32Array(7)], { sampleRate: SR });
    ok('numFrames survives an odd short buffer', decodeWav(buf).channels[0].length === 7);
  }
}

// ===========================================================================
/**
 * WATCHED RED BY MUTATION — all eighteen. Each mutation below was applied to a
 * green tree, `node test.js wavstream` was run, the red was read, and the file
 * was restored. AGENTS.md:118: "an assertion never observed failing is one whose
 * ability to fail is an assumption."
 *
 * THE BATTERY IS `qa/mutations-u1-wavstream.mjs`, AND THIS TABLE IS ITS OUTPUT.
 * Re-run it rather than believing this comment. A mutation anchors on a span of
 * source, and a later slice that rewrites that span decays the anchor SILENTLY —
 * a search that matches nothing reads exactly like one that matched and passed.
 * Two other Phase 4 batteries decayed that way with neither author knowing; this
 * one had no file at all until it was re-run and checked in, so its only record
 * was this table, and a table cannot re-measure itself.
 *
 *     node qa/mutations-u1-wavstream.mjs               the fifteen, with a control
 *     node qa/mutations-u1-wavstream.mjs --list        do the anchors still match?
 *     node qa/mutations-u1-wavstream.mjs --self-check  can the battery say MUTE?
 *
 * PROVENANCE, because a mutation is only evidence about the source it was cut
 * for. M1-M12 were cut against 1040de1 and M13-M15 against 0fb693a — both landed
 * commits, so both stamps stay resolvable. RE-ESTABLISHED against main 5993d32:
 * 15 of 15 anchors still matching, 15 of 15 reddening EXACTLY the assertions
 * named here and nothing else, and all 18 assertions covered by at least one
 * mutation. Nothing needed re-cutting because wav.js is untouched between
 * 0fb693a and 5993d32. The `wav.js:NNN` coordinates below are as of 5993d32 and
 * are the first thing that will go stale; the anchor TEXT in the battery is what
 * is authoritative, and `--list` prints the current line for each.
 *
 * THE MUTATIONS TARGET THE COMPOSITION, NOT THE SAMPLE LOOP, and that is not an
 * oversight. `writeFrames` is shared by all three writers, so breaking it moves
 * both sides of a byte-identity assertion equally and the assertion stays green
 * — which is the honest cost of the streaming path being the SAME encoder rather
 * than a second one. What these assertions can see is everything built around
 * that loop: the header, the chunk boundaries, the pad byte, the frame
 * accounting and the two refusals. The existing group('window') covers the loop
 * itself against the byte map, and M15 below is where that transitive coverage
 * is observed rather than assumed.
 *
 *   M1  wav.js:279  chunk() interleaves the channels in reverse order
 *                   -> 4 red: 32f identity, the streamed out-of-range read-back,
 *                   16-bit identity, pipeTo identity
 *                   (sizing the chunk buffer by bytesPerSample instead of
 *                   blockAlign is also red, but as a DataView overflow that
 *                   takes the whole suite down before the assertion reports —
 *                   re-measured at 5993d32, it still ends the run in a stack
 *                   trace with nothing named, which is why it is not the anchor)
 *   M2  wav.js:260  header() declares `written` instead of `frames`
 *                   -> 7 red: all three identities, the streamed out-of-range
 *                   read-back, header-is-final, pipeTo identity, and the
 *                   no-options default header
 *   M3  wav.js:291  end() stops refusing a short write
 *                   -> 2 red: the short-write refusal, and pipeTo's abort
 *   M4  wav.js:268  chunk() stops refusing a long write
 *                   -> 1 red: the long-write refusal
 *   M5  wav.js:295  end() never emits the RIFF pad byte
 *                   -> 1 red: 24-bit mono odd frame count
 *   M6  wav.js:255  the constructor computes the length without riffSizeFor
 *                   -> 1 red: the 4 GiB refusal at construction
 *   M7  wav.js:383  WavSyncWriter.close does not patch the data-chunk size
 *                   -> 3 red: the 32f sync identity, the 16-bit sync identity,
 *                   and the odd-payload pad
 *   M8  wav.js:355  WavSyncWriter.append checks the ceiling after it writes
 *                   -> 1 red: the sync writer refuses before writing
 *   M9  wav.js:58   the 16-bit dither default is dropped
 *                   -> 1 red: the dither default
 *   M10 wav.js:240  the constructor stops refusing planes as a channel count
 *                   -> 1 red: the named refusal
 *   M11 wav.js:255  byteLength forgets the header bytes
 *                   -> 1 red: the length known before any audio is written
 *   M12 wav.js:312  pipeTo closes the sink on a refusal instead of aborting it
 *                   -> 1 red: pipeTo aborts rather than closes
 *
 * M13-M15 CLOSE A COVERAGE HOLE AN ADVERSARIAL REVIEW FOUND, and M13 is the
 * review's own mutation, reproduced here because it is the one this suite used
 * to pass. WavSyncWriter was asserted only at 32f — but it exists for the cache
 * write, and the cache writes 16-bit (stemcache.js put()). `fact` is present only
 * for float, so every patch offset past the fmt chunk differs between the two
 * formats, and 32f stereo blockAlign 8 is always even so close()'s pad byte was
 * unreachable as well.
 *
 *   M13 wav.js:78   dataSizeAt is wrong for PCM ONLY, float left untouched:
 *                   `fmt.headerSize - 4 + (fmt.factSize ? 0 : 2)`
 *                   -> 2 red: the 16-bit sync round trip, the odd-payload pad.
 *                   BEFORE these two assertions existed this mutation left the
 *                   whole group green while every 16-bit and 24-bit cache file
 *                   carried a data-chunk size of zero.
 *   M14 wav.js:379  close() never writes the pad byte for an odd payload
 *                   -> 1 red: the odd-payload pad
 *   M15 wav.js:134  the float path clamps to ±1.0 like the fixed-point paths
 *                   -> 1 red here (the streamed out-of-range read-back), and 2
 *                   more in group('window') — `32f round trip is bit exact` and
 *                   `32f preserves out-of-range samples`, both re-measured at
 *                   5993d32 with `node test.js window`. That is the transitive
 *                   coverage the note above describes, observed rather than
 *                   assumed, and it is the assertion that would go missing if a
 *                   future writer were given its own conversion loop.
 */
if (group('wavstream')) {
  head('wavstream — the streaming writers emit exactly the bytes encodeWav emits (U1)');

  /** Drive WavStreamEncoder by hand and concatenate everything it emits. */
  const streamBytes = (chs, opts, chunkLen) => {
    const n = chs[0].length;
    const enc = new WavStreamEncoder(chs.length, { ...opts, frames: n });
    const parts = [enc.header()];
    for (let o = 0; o < n; o += chunkLen) {
      const len = Math.min(chunkLen, n - o);
      parts.push(enc.chunk(chs.map((c) => c.subarray(o, o + len)), len));
    }
    parts.push(enc.end());
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
  };
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const firstDiff = (a, b) => {
    if (a.length !== b.length) return `lengths differ: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `first difference at byte ${i}`;
    return 'identical';
  };
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };

  /** An OPFS FileSystemSyncAccessHandle, duck-typed on the four members WavSyncWriter uses. */
  class FakeSyncHandle {
    constructor() { this.bytes = new Uint8Array(0); this.writes = 0; this.flushed = 0; this.closes = 0; }
    write(buf, { at }) {
      this.writes++;
      if (at + buf.length > this.bytes.length) {
        const grown = new Uint8Array(at + buf.length);
        grown.set(this.bytes); this.bytes = grown;
      }
      this.bytes.set(buf, at);
      return buf.length;
    }
    truncate(n) { this.bytes = this.bytes.slice(0, n); }
    flush() { this.flushed++; }
    close() { this.closes++; }
  }

  // 5000 frames chunked at 997 so no chunk boundary lands on a power of two and
  // the last chunk is short — the arithmetic a whole-buffer encoder never does.
  const N = 5000, CHUNK = 997;
  const l = noise(N, 3), r = noise(N, 4);
  // Out of range on purpose, and ASSERTED below rather than merely commented:
  // 32f must not clip (AUDIO.md §5.3). Byte identity alone cannot carry that
  // claim — both sides of the comparison get identical treatment — so the
  // streamed bytes are decoded and the two samples are read back.
  l[10] = 1.7; r[11] = -1.42;

  // -- byte identity, the assertion the slice rests on -----------------------
  {
    const opts = { sampleRate: SR, bitDepth: 32, float: true };
    const whole = new Uint8Array(encodeWav([l, r], opts));
    const streamed = streamBytes([l, r], opts, CHUNK);
    ok('32f: the streamed file is byte-identical to encodeWav  '
      + '[entry point: WavStreamEncoder.header/chunk/end over 6 chunks]',
      same(whole, streamed), `${whole.length} bytes, ${firstDiff(whole, streamed)}`);

    // The float path writes setFloat32 RAW while every fixed-point path clamps
    // (wav.js writeFrames). htdemucs outputs are not bounded to ±1.0 and 32f
    // export is defined as the untouched model output, so a clamp appearing on
    // the streaming path is a silent quality regression in the deliverable.
    const back = decodeWav(streamed.buffer);
    ok('32f: the STREAMED bytes preserve out-of-range samples — no clip, no rescale  '
      + '[entry point: decodeWav over WavStreamEncoder output, not over encodeWav output]',
      back.channels[0][10] === Math.fround(1.7) && back.channels[1][11] === Math.fround(-1.42)
      && back.bitDepth === 32 && back.float === true,
      `read back ${back.channels[0][10]} and ${back.channels[1][11]}`);
  }

  {
    // dither:false BECAUSE encodeWav's dither is seeded from Math.random()
    // (wav.js writeFrames): with it on, two runs of the SAME encoder differ, so
    // byte-identity is undefined rather than false. The cache write already
    // passes dither:false (stemcache.js put()), which is the path that matters.
    const opts = { sampleRate: SR, bitDepth: 16, float: false, dither: false };
    const src = [Float32Array.from(l, (v) => Math.max(-1, Math.min(0.999, v))),
                 Float32Array.from(r, (v) => Math.max(-1, Math.min(0.999, v)))];
    const whole = new Uint8Array(encodeWav(src, opts));
    const streamed = streamBytes(src, opts, CHUNK);
    ok('16-bit PCM: the streamed file is byte-identical to encodeWav  '
      + '[entry point: WavStreamEncoder.chunk, dither off — see the comment]',
      same(whole, streamed), `${whole.length} bytes, ${firstDiff(whole, streamed)}`);
  }

  {
    // Mono 24-bit, 7 frames: blockAlign 3 makes dataSize ODD, which is the only
    // shape in this codebase that produces a RIFF pad byte at all.
    const opts = { sampleRate: SR, bitDepth: 24, float: false, dither: false };
    const m = Float32Array.from(noise(7, 9), (v) => Math.max(-1, Math.min(0.999, v)));
    const whole = new Uint8Array(encodeWav([m], opts));
    const streamed = streamBytes([m], opts, 3);
    ok('24-bit mono, odd frame count: byte-identical INCLUDING the RIFF pad byte  '
      + '[entry point: WavStreamEncoder.end]',
      same(whole, streamed) && whole.length % 2 === 0 && (7 * 3) % 2 === 1,
      `${whole.length} bytes for a ${7 * 3}-byte odd payload, ${firstDiff(whole, streamed)}`);
  }

  // -- the header is final before any audio is written ------------------------
  {
    const opts = { sampleRate: SR, bitDepth: 32, float: true };
    const enc = new WavStreamEncoder(2, { ...opts, frames: N });
    const head0 = enc.header();                       // BEFORE a single chunk
    const whole = new Uint8Array(encodeWav([l, r], opts));
    const dv = new DataView(head0.buffer, head0.byteOffset, head0.byteLength);
    ok('the header is complete and FINAL on the first chunk — no seek, no patch  '
      + '[entry point: WavStreamEncoder.header() before any chunk() call]',
      same(head0, whole.subarray(0, head0.length))
      && dv.getUint32(4, true) === whole.byteLength - 8
      && dv.getUint32(46, true) === N
      && dv.getUint32(54, true) === N * 8,
      `${head0.length}-byte header, riff=${dv.getUint32(4, true)} fact=${dv.getUint32(46, true)} data=${dv.getUint32(54, true)}`);
    ok('the finished byte length is known before any audio is written  '
      + '[entry point: WavStreamEncoder.byteLength, for a progress meter that cannot count what it has not encoded]',
      enc.byteLength === whole.byteLength, `${enc.byteLength} bytes`);
  }

  // -- a wrong frame count throws, in both directions -------------------------
  {
    const enc = new WavStreamEncoder(2, { sampleRate: SR, bitDepth: 32, float: true, frames: 100 });
    enc.header();
    enc.chunk([l.subarray(0, 60), r.subarray(0, 60)], 60);
    const msg = threw(() => enc.chunk([l.subarray(0, 60), r.subarray(0, 60)], 60));
    ok('a LONG write is refused, naming both counts, and takes no frames with it  '
      + '[entry point: WavStreamEncoder.chunk]',
      msg !== null && /120/.test(msg) && /100/.test(msg) && enc.written === 60,
      msg === null ? 'ACCEPTED 120 frames into a 100-frame file' : `${enc.written} frames still written; ${msg}`);
  }

  {
    const enc = new WavStreamEncoder(2, { sampleRate: SR, bitDepth: 32, float: true, frames: 100 });
    enc.header();
    enc.chunk([l.subarray(0, 60), r.subarray(0, 60)], 60);
    const msg = threw(() => enc.end());
    ok('a SHORT write is refused at end(), naming both counts  '
      + '[entry point: WavStreamEncoder.end]',
      msg !== null && /60/.test(msg) && /100/.test(msg),
      msg === null ? 'ACCEPTED a file whose header promises 100 frames and whose data stops at 60' : msg);
  }

  // -- the 4 GiB ceiling wav.js has always guarded ----------------------------
  {
    // 600e6 frames x 8 bytes = 4.8 GB of payload, refused without allocating any
    // of it — the point of checking at construction rather than at the last chunk.
    const msg = threw(() => new WavStreamEncoder(2, { sampleRate: SR, bitDepth: 32, float: true, frames: 600e6 }));
    ok('the 4 GiB RIFF ceiling is refused at construction, before anything is streamed  '
      + '[entry point: new WavStreamEncoder]',
      msg !== null && /4 GiB/.test(msg),
      msg === null ? 'ACCEPTED a 4.8 GB payload into a uint32 size field' : msg);
  }

  // -- into a real WritableStream --------------------------------------------
  {
    const sink = { chunks: [], closed: 0, aborted: null };
    const ws = new WritableStream({
      write(c) { sink.chunks.push(c); },
      close() { sink.closed++; },
      abort(reason) { sink.aborted = reason; },
    });
    const opts = { sampleRate: SR, bitDepth: 32, float: true };
    const enc = new WavStreamEncoder(2, { ...opts, frames: N });
    const source = (function* () {
      for (let o = 0; o < N; o += CHUNK) {
        const len = Math.min(CHUNK, N - o);
        yield [[l.subarray(o, o + len), r.subarray(o, o + len)], len];
      }
    })();
    await enc.pipeTo(ws, source);
    const got = new Uint8Array(sink.chunks.reduce((a, c) => a + c.length, 0));
    let p = 0;
    for (const c of sink.chunks) { got.set(c, p); p += c.length; }
    const whole = new Uint8Array(encodeWav([l, r], opts));
    ok('pipeTo drives a real WritableStream to the same bytes, and closes it once  '
      + '[entry point: WavStreamEncoder.pipeTo]',
      same(whole, got) && sink.closed === 1 && sink.aborted === null,
      `${sink.chunks.length} writes, ${got.length} bytes, ${firstDiff(whole, got)}`);
  }

  {
    // A source that stops early must ABORT the sink, not close it: a Host that
    // turns the writable into a file has to be told the file is not a file.
    const sink = { closed: 0, aborted: null };
    const ws = new WritableStream({ write() {}, close() { sink.closed++; }, abort(r) { sink.aborted = r; } });
    const enc = new WavStreamEncoder(2, { sampleRate: SR, bitDepth: 32, float: true, frames: N });
    const short = (function* () { yield [[l.subarray(0, 10), r.subarray(0, 10)], 10]; })();
    let rejected = null;
    try { await enc.pipeTo(ws, short); } catch (e) { rejected = e.message; }
    ok('pipeTo ABORTS the sink on a short source rather than closing it  '
      + '[entry point: WavStreamEncoder.pipeTo]',
      rejected !== null && sink.closed === 0 && sink.aborted instanceof Error,
      rejected === null ? 'RESOLVED on a truncated file' : `sink closed ${sink.closed} times, aborted with: ${rejected}`);
  }

  // -- the unknown-length OPFS variant ----------------------------------------
  {
    const opts = { sampleRate: SR, bitDepth: 32, float: true };
    const h = new FakeSyncHandle();
    const w = new WavSyncWriter(h, 2, opts);
    for (let o = 0; o < N; o += CHUNK) {
      const len = Math.min(CHUNK, N - o);
      w.append([l.subarray(o, o + len), r.subarray(o, o + len)], len);
    }
    const res = w.close();
    const whole = new Uint8Array(encodeWav([l, r], opts));
    ok('WavSyncWriter patches the three lengths at close and lands encodeWav’s exact bytes  '
      + '[entry point: WavSyncWriter.append/close over a FileSystemSyncAccessHandle]',
      same(whole, h.bytes) && res.frames === N && h.flushed === 1 && h.closes === 1,
      `${h.bytes.length} bytes, ${res.frames} frames, ${firstDiff(whole, h.bytes)}`);
  }

  {
    // 16-BIT IS THE SHIPPED CACHE FORMAT (stemcache.js put()), and the 32f case
    // above structurally cannot see a PCM-only header bug: `fact` is present only
    // for float, so every patch offset past the fmt chunk differs between the two.
    // A dataSizeAt() that is wrong for PCM alone leaves the data-chunk size at
    // zero in every cache file and passes a float-only suite.
    const opts = { sampleRate: SR, bitDepth: 16, float: false, dither: false };
    const src = [Float32Array.from(l, (v) => Math.max(-1, Math.min(0.999, v))),
                 Float32Array.from(r, (v) => Math.max(-1, Math.min(0.999, v)))];
    const h = new FakeSyncHandle();
    const w = new WavSyncWriter(h, 2, opts);
    for (let o = 0; o < N; o += CHUNK) {
      const len = Math.min(CHUNK, N - o);
      w.append([src[0].subarray(o, o + len), src[1].subarray(o, o + len)], len);
    }
    const res = w.close();
    const whole = new Uint8Array(encodeWav(src, opts));
    ok('WavSyncWriter at 16-bit — THE FORMAT THE CACHE ACTUALLY WRITES — lands encodeWav’s exact bytes  '
      + '[entry point: WavSyncWriter.close patching a PCM header, where there is no fact chunk]',
      same(whole, h.bytes) && res.frames === N,
      `${h.bytes.length} bytes, ${res.frames} frames, ${firstDiff(whole, h.bytes)}`);
  }

  {
    // 24-bit mono, 7 frames: dataSize 21 is ODD. 32f stereo blockAlign is 8 and
    // 16-bit stereo is 4, so neither case above can reach close()'s pad byte at all.
    const opts = { sampleRate: SR, bitDepth: 24, float: false, dither: false };
    const m = Float32Array.from(noise(7, 9), (v) => Math.max(-1, Math.min(0.999, v)));
    const h = new FakeSyncHandle();
    const w = new WavSyncWriter(h, 1, opts);
    w.append([m.subarray(0, 3)], 3);
    w.append([m.subarray(3, 7)], 4);
    const res = w.close();
    const whole = new Uint8Array(encodeWav([m], opts));
    ok('WavSyncWriter pads an ODD payload at close and reports the padded length  '
      + '[entry point: WavSyncWriter.close, the pad path no even blockAlign can reach]',
      same(whole, h.bytes) && (7 * 3) % 2 === 1 && h.bytes.length % 2 === 0
      && res.byteLength === whole.length && res.frames === 7,
      `${h.bytes.length} bytes for a ${7 * 3}-byte odd payload, ${firstDiff(whole, h.bytes)}`);
  }

  {
    // The ceiling is checked BEFORE the bytes are built, because a file that has
    // already crossed 4 GiB cannot be repaired at close: the size field wraps and
    // what is left on disk is a short file that parses.
    const h = new FakeSyncHandle();
    const w = new WavSyncWriter(h, 2, { sampleRate: SR, bitDepth: 32, float: true });
    const writesAfterHeader = h.writes;
    const msg = threw(() => w.append([new Float32Array(1), new Float32Array(1)], 600e6));
    ok('WavSyncWriter refuses the 4 GiB ceiling BEFORE it writes a byte  '
      + '[entry point: WavSyncWriter.append]',
      msg !== null && /4 GiB/.test(msg) && h.writes === writesAfterHeader,
      msg === null ? 'ACCEPTED a payload past the uint32 size field'
        : `${h.writes - writesAfterHeader} writes past the header; ${msg}`);
  }

  // -- the defaults are the same defaults -------------------------------------
  {
    const enc = new WavStreamEncoder(2, { frames: N });
    const whole = new Uint8Array(encodeWav([l, r]));
    ok('with NO options both writers resolve the same format: 44.1 k, 32f, stereo  '
      + '[entry point: wavFormat, via encodeWav and new WavStreamEncoder]',
      same(enc.header(), whole.subarray(0, enc.headerSize)),
      `${enc.headerSize}-byte header, ${firstDiff(enc.header(), whole.subarray(0, enc.headerSize))}`);
    ok('the 16-bit dither default is resolved the same way and is still switchable  '
      + '[entry point: the resolved format on WavStreamEncoder, the one option the header cannot show]',
      new WavStreamEncoder(2, { bitDepth: 16, float: false, frames: 4 }).fmt.dither === true
      && new WavStreamEncoder(2, { bitDepth: 16, float: false, dither: false, frames: 4 }).fmt.dither === false
      && new WavStreamEncoder(2, { frames: 4 }).fmt.dither === false);
  }

  {
    const msg = threw(() => new WavStreamEncoder([l, r], { frames: N }));
    ok('passing the planes where the channel COUNT goes is a named refusal  '
      + '[entry point: new WavStreamEncoder]',
      msg !== null && /count/i.test(msg) && /2 planes/.test(msg),
      msg === null ? 'ACCEPTED an array of planes as a channel count' : msg);
  }
}

// ===========================================================================
/**
 * U11 — E1, THE DELIVERABLE. The six untouched model outputs read out of the
 * 32-bit-float tier and written into the writables a Host's `exportSink` hands
 * back: names, header, bytes, cancellation, and the closed error vocabulary.
 *
 * WHAT THIS GROUP IS FOR. Export is the product's defining capability and the
 * one deliverable that leaves the machine, so the claims here are about BYTES
 * ON SOMEONE'S DISK rather than about a shape in memory. Three of them are the
 * whole point:
 *
 *   1. THE HEADER IS PARSED OUT OF WHAT WAS EMITTED, never read back off the
 *      options that were passed in. An assertion that checks its own input has
 *      measured the test and not the encoder.
 *   2. THE SAMPLES ARE BIT-IDENTICAL to what the cache holds — `===` on every
 *      float, not "close to". Any gain, dither or normalisation on this path is
 *      a defect, and "approximately equal" is exactly the tolerance a −0.1 dB
 *      trim would hide in.
 *   3. A CANCELLED EXPORT LEAVES NO PARTIAL FILE, asserted on all six sinks
 *      rather than on the one that happened to be open, with an INDEPENDENCE
 *      CHECK that bytes really had reached them first — a cancel that fired
 *      before anything was written would satisfy every "no partial file"
 *      assertion here having observed nothing at all.
 *
 * WHY `WavWindowReader`'S OWN ASSERTIONS ARE HERE rather than in
 * `group('window')`: it exists for this path and its claim is this path's claim.
 * Streaming the WRITE while materialising the READ moves E1's memory ceiling
 * instead of removing it, so "peak resident does not scale with track length" is
 * a statement about the pair and is asserted where the pair runs. It is MEASURED
 * on the shim's recorded `slice()` ranges, not asserted from the code's shape:
 * a reader that quietly slurped the whole file would satisfy every sample
 * assertion in this group.
 *
 * RENDERING vs REACHABILITY (the rule at the head of this file): NOT
 * rendering-only. The production `StemCache.put()` writes the entry, the
 * production `StemCache.stemFile()` opens it, the production `WavWindowReader`
 * reads it, the production `WavStreamEncoder` encodes it and a real
 * `WritableStream` receives it. The two things this cannot reach are the Chrome
 * offscreen document's own boot and a real folder on a real disk; the first is
 * covered by reading `offscreen/engine.js` as text below, and the second is the
 * Host's half of the seam by design.
 *
 * ---- EVERY ASSERTION ADDED HERE, WATCHED RED --------------------------------
 * AGENTS.md: "An assertion never observed failing is one whose ability to fail
 * is an assumption." All 57 assertions in this group were watched red, by the
 * 38 mutations below. THE BATTERY IS IN THE REPOSITORY —
 * `qa/u11-export-mutations.mjs` — because a measurement whose instrument was
 * thrown away cannot be repeated or disputed, and because a battery decays
 * SILENTLY when a later slice rewrites the lines its anchors patch. Run it:
 *
 *     node qa/u11-export-mutations.mjs
 *
 * It reports TWO things per anchor and never one number: does the anchor still
 * MATCH (if not, the instrument decayed — re-cut it) and does the mutation still
 * RED (if not, that is decay OR real coverage loss, and they need opposite
 * responses). It carries one SHA-256 per anchored file, so drift is named before
 * anything else is read. `file:line` below is where the mutation was MADE.
 *
 *   M1  export.js:244  exportFileNames returns the caller's order, not STEMS order
 *                      -> 2 red: the reversed-request and the subset order
 *   M2  export.js:171  safeTitle stops substituting `/`, `\`, `:` and the control range
 *                      -> 4 red: the escape assertion, the folder name in the plan,
 *                      the reduces-to-nothing name, and the end-to-end block
 *   M3  export.js:223  safeTitle returns the constant 'export'
 *                      -> 11 red: every naming assertion INCLUDING the independence
 *                      control, which is the point of that control existing
 *   M4  export.js:211  safeTitle stops stripping leading and trailing dots, so `..` survives
 *                      -> 2 red: the escape assertion (`..` resolves OUT of the folder)
 *   M5  export.js:173  the Windows device-name guard never matches
 *                      -> 1 red: a device name is escaped
 *   M6  export.js:180  the 200-byte title cap is removed
 *                      -> 1 red: a long title fits a 255-byte name
 *   M7  export.js:396  a cancelled run CLOSES the destinations instead of aborting them
 *                      — literally "cancel stops writing without discarding"
 *                      -> 2 red: aborts every destination and closes none; and the
 *                      mid-write refusal, which shares the same abort path
 *   M8  export.js:405  the cancel flag is never checked
 *                      -> 4 red: all four cancellation assertions
 *   M9  export.js:402  the six files are written ONE AFTER ANOTHER, not in lockstep
 *                      -> 1 red: the six advance together. NOTE the shape of this one:
 *                      "no partial file" alone stayed GREEN, because the cancel landed
 *                      before the first stem finished. The spread assertion is what
 *                      sees it, and it exists for that reason.
 *   M10 export.js:386  the encoder is built at 16-bit PCM
 *                      -> 4 red: the header, and all three identity assertions
 *   M11 export.js:410  A GAIN OF 0.999 IS APPLIED to every window before it is encoded
 *                      — the defect this whole slice exists to make impossible
 *                      -> 3 red: sample identity, the out-of-range control, data-chunk
 *                      identity. A "close to" tolerance would have passed all three.
 *   M12 export.js:351  the opened file's own header is no longer checked
 *                      -> 1 red: a row saying 32 over bytes that are 16
 *   M13 export.js:357  the manifest frame count is no longer checked against the file
 *                      -> 1 red: an entry that disagrees with itself
 *   M14 export.js:371  a refused exportSink is swallowed and the run carries on
 *                      -> 2 red: the refusal, and "every declared code is reachable"
 *   M15 export.js:373  a short sink map is accepted
 *                      -> 2 red: the SINK_SHORT refusal and the abort of what did open
 *   M16 export.js:322  the requested format is silently ignored
 *                      -> 1 red: a non-32f format is refused by name
 *   M17 export.js:308  the manifest row's depth is no longer consulted
 *                      -> 1 red: a 16-bit entry is not a deliverable. THIS ONE WAS
 *                      GREEN AT FIRST: the file-header check (M12) caught the same
 *                      case with the same code, so the assertion could not tell which
 *                      guard fired. It now counts the stem files OPENED — the row
 *                      check refuses before any — and M17 reds.
 *   M18 export.js:295  a run can be started twice
 *                      -> 1 red: a run cannot be started twice
 *   M19 export.js:123  checkExportCode accepts every code
 *                      -> 2 red: an unknown code is refused; the message names the set
 *   M20 wav.js:346     the reader answers a DEFAULT format when open() has not run
 *                      -> 1 red: a reader that has read no header reports nothing
 *   M21 wav.js:376     the windowed reader SLURPS the whole file and slices in memory
 *                      -> 3 red: all three memory assertions — and NOT ONE sample
 *                      assertion, which is exactly why the memory claim needs its own
 *                      instrument rather than riding on the identity ones
 *   M22 wav.js:375     the window is read one byte late
 *                      -> 16 red: most of the group, sample identity first
 *   M23 wav.js:365     a read past the end comes back short instead of being refused
 *                      -> 1 red: the read-past-the-end refusal
 *   M24 stemcache.js:654  stemFile ignores which stem it was asked for — the
 *                      six-identical-stems fan-out, at its source
 *                      -> 1 red: sample identity, per stem against its OWN source
 *   M25 engine.js:225  the engine stops checking the code it sends
 *                      -> 1 red: one checkExportCode() per EXPORT_ERROR
 *   M26 export.js:48   the deliverable path imports engine/mixer.js
 *                      -> 1 red: the import list — there is nowhere for a fader
 *   M27 export.js:369  the Host is asked TWICE for the same deliverable
 *                      -> 6 red: asked once, for all six together, first
 *   M28 export.js:414  progress reports a 0-based file index into a 1..files range
 *                      -> 1 red: every tick names a file within the set it declares
 *   M29 export.js:328  a stem the six-stem contract has no name for is accepted
 *                      -> 1 red: the BAD_STEM refusal
 *   M30 export.js:300  a key that names nothing is no longer refused up front
 *                      -> 1 red: refused before a single file or destination is opened
 *   M31 export.js:345  a stem file that will not open is swallowed
 *                      -> 1 red: the READ_FAILED refusal
 *   M32 stemcache.js:676  StemCache.get() stops reading whole files
 *                      -> 1 red: the CONTRAST the memory numbers are measured against.
 *                      Without it "one window" is a number with no scale beside it.
 *   M33 export.js:123  checkExportCode cries wolf on every LEGAL code — the OTHER
 *                      direction of M19, and the question a "can it fail?" review
 *                      never asks: CAN IT PASS?
 *                      -> 1 red: every member passes silently
 *   M34 export.js:295  the runner throws a code that is not in the declared set
 *                      -> 2 red: the declared-member scan, and the BUSY refusal
 *   M35 engine.js:1371 the engine stops wiring EXPORT_CANCEL
 *                      -> 1 red: the engine really wires both cases to the runner
 *   M36 wav.js:333     the reader reports a sample rate it did not read out of the file
 *                      -> 17 red: the reader's format assertion, then the whole run
 *   M37 wav.js:368     a wrong number of planes is accepted
 *                      -> 1 red: the plane-count refusal
 *   M38 test.js:33     this file's own header list loses `export`
 *                      -> 1 red: the header list is the groups this file has, so
 *                      `node test.js export` cannot become a run that asserts nothing
 *
 * THE THIRD WAY A GATE FAILS — "if I break this, does the number get WORSE?" —
 * is what the four CONTROLS in this group are for, and each control is itself
 * watched red above. `finished.length === 0` ("no partial file") is satisfied by
 * a run that writes NOTHING, so it is paired with an independence check that
 * bytes really reached all six sinks (M8 reds it). `escapes.length === 0` is
 * satisfied by a `safeTitle` that returns a constant, so it is paired with an
 * ordinary title surviving untouched (M3 reds it). "all six aborted" is
 * satisfied by aborting always, so it is paired with a clean run closing each
 * one exactly once (M22 reds it). And "the biggest read is one window" is
 * satisfied by reading nothing, so it is paired with the exact audio byte total
 * and with `get()`'s whole-file reads beside it (M21 and M32 red them).
 */
if (group('export')) {
  head('export — E1: the six untouched model outputs, 32f / 44 100 Hz / stereo (U11)');
  const { readFileSync } = await import('node:fs');
  const nodePath = await import('node:path');
  const path = nodePath.default || nodePath;

  const F32_TIER = { depth: 32, geometry: 'offline' };
  const CAP = 200 * 1024 * 1024;
  /** Small enough that a short track spans many windows, so a cancel has somewhere to land. */
  const CHUNK = 100;

  /**
   * Deterministic, DIFFERENT PER STEM, and deliberately outside ±1.0 in two
   * places. The out-of-range samples are load-bearing: `wav.js`'s float path
   * does not clamp because htdemucs outputs are not bounded, and a clamp
   * introduced anywhere on this path is invisible to a fixture that stays inside
   * the range.
   */
  const stemPlanes = (frames, seed) => {
    const l = noise(frames, seed), r = noise(frames, seed + 1);
    l[0] = 1.7; r[1] = -1.42;
    return [l, r];
  };
  const sixStems = (frames) => {
    const out = {};
    STEMS.forEach((s, i) => { out[s] = stemPlanes(frames, 400 + i * 2); });
    return out;
  };

  /**
   * A REAL `WritableStream` with a recording underlying sink — not a hand-rolled
   * fake. `getWriter()`, the writer lock, `close()` and `abort()` are then the
   * platform's semantics rather than this file's opinion of them, which matters
   * because "aborted, not closed" is a claim about exactly those semantics.
   */
  const makeSink = () => {
    const rec = { parts: [], closed: 0, aborted: 0, reason: null, failAt: -1, writes: 0 };
    rec.stream = new WritableStream({
      write(chunk) {
        rec.writes++;
        if (rec.writes === rec.failAt) throw new Error('simulated destination failure');
        rec.parts.push(new Uint8Array(chunk));
      },
      close() { rec.closed++; },
      abort(r) { rec.aborted++; rec.reason = r; },
    });
    rec.bytes = () => {
      const total = rec.parts.reduce((a, p) => a + p.length, 0);
      const out = new Uint8Array(total);
      let p = 0;
      for (const q of rec.parts) { out.set(q, p); p += q.length; }
      return out;
    };
    return rec;
  };

  /** The RIFF fields, read out of the emitted bytes and nothing else. */
  const readHeader = (u8) => {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    const h = { riff: tag(0), riffSize: dv.getUint32(4, true), wave: tag(8), fact: null, data: null, fmt: null };
    let p = 12;
    while (p + 8 <= u8.length) {
      const id = tag(p), size = dv.getUint32(p + 4, true), body = p + 8;
      if (id === 'fmt ') {
        h.fmt = {
          size,
          format: dv.getUint16(body, true),
          channels: dv.getUint16(body + 2, true),
          sampleRate: dv.getUint32(body + 4, true),
          byteRate: dv.getUint32(body + 8, true),
          blockAlign: dv.getUint16(body + 12, true),
          bitDepth: dv.getUint16(body + 14, true),
        };
      } else if (id === 'fact') h.fact = dv.getUint32(body, true);
      else if (id === 'data') h.data = { offset: body, size };
      p = body + size + (size & 1);
    }
    return h;
  };

  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  /**
   * Drive one whole export over a cache the caller has already filled.
   * Everything the run needs from outside is here so a block can replace exactly
   * one piece — the sink map, one reader, the format — and leave the rest real.
   */
  const drive = async (cache, key, opts = {}) => {
    const entry = opts.entry !== undefined ? opts.entry : await cache.entry(key);
    const recs = {};
    const plans = [];
    const progress = [];
    /** How many stem files the run actually opened — a COUNT, so "refused before
     *  it opened anything" is a measurement and not a reading of the code. */
    const opens = [];
    const open = opts.openStem || (async (stem) => new WavWindowReader(await cache.stemFile(key, stem)).open());
    let run;
    run = new ExportRun({
      entry,
      stems: opts.stems,
      format: opts.format,
      chunkFrames: opts.chunkFrames || CHUNK,
      // `onOpen` fires BETWEEN the reader opening and the next one, which is the
      // only place a test can stand to reach the window after the readers are
      // open and before the folder dialog. `run` is assigned before `run()` is
      // ever called, so the closure is live by the time this fires.
      openStem: (stem) => { opens.push(stem); if (opts.onOpen) opts.onOpen(stem, run); return open(stem); },
      exportSink: opts.exportSink || (async (plan) => {
        plans.push(plan);
        const map = {};
        for (const n of plan.files) { recs[n] = makeSink(); if (opts.sinkFailAt) recs[n].failAt = opts.sinkFailAt; map[n] = recs[n].stream; }
        if (opts.dropFile) delete map[opts.dropFile];
        return map;
      }),
      onProgress: (p) => { progress.push(p); if (opts.onTick) opts.onTick(p, run, recs); },
    });
    let result = null, err = null;
    try { result = await run.run(); } catch (e) { err = e; }
    return { run, result, err, recs, plans, progress, opens };
  };

  // ---------------------------------------------------------------- names
  {
    const names = exportFileNames('My Track');
    ok('SIX FILES, ONE PER STEM, IN `STEMS` ORDER  '
      + "[entry point: exportFileNames(title) — the base names handed to the Host's exportSink]",
      names.length === STEMS.length && names.every((n, i) => n === `My Track - ${STEMS[i]}.wav`),
      names.join(' | '));

    const reversed = exportFileNames('My Track', STEMS.slice().reverse());
    ok("...and the CALLER'S order is ignored: a reversed request comes back in `STEMS` order, "
      + 'because every other list of stems in this product is indexed that way',
      same(reversed, names), reversed.join(' | '));

    const two = exportFileNames('My Track', ['vocals', 'drums']);
    ok('...and a SUBSET is still in `STEMS` order, so index 0 is the earlier stem and not the first one asked for',
      two.length === 2 && two[0] === 'My Track - drums.wav' && two[1] === 'My Track - vocals.wav', two.join(' | '));
  }

  // ------------------------------------------------- the escape (issue #6)
  /**
   * A TITLE MUST NOT BE ABLE TO LEAVE THE FOLDER THE USER PICKED.
   *
   * WHO OWNS THIS, said here because the assertion is only half the answer: the
   * UNIT chooses the base names and guarantees each one is a SINGLE PATH
   * COMPONENT; the HOST owns the directory and joins them. Both halves are
   * needed and neither is sufficient — the unit cannot know the Host's
   * filesystem, and the Host cannot know what the unit meant by a title.
   *
   * THE INSTRUMENT IS `node:path`, NOT A RE-READING OF `safeTitle`'s RULES. A
   * check that re-applied the same regular expression would agree with the code
   * by construction and could not disagree with it. `resolve` is what a Host
   * actually does, and it is run in BOTH flavours because the escapes differ:
   * `a\b` is one component on posix and two on win32, and `C:x` is a
   * drive-relative path on win32 only.
   */
  {
    const HOSTILE = ['a/b', 'a\\b', 'C:foo', 'x.', '..', '.', '../../etc/passwd', '..\\..\\windows',
      'con', 'NUL', 'a:b:c', 'x ', '', null, 'tail...', '/leading', 'a\u0000b'];
    const DIR = { posix: '/home/u/Music/set', win32: 'C:\\Users\\u\\Music\\set' };
    const escapes = [];
    const unchanged = [];
    for (const t of HOSTILE) {
      const title = safeTitle(t);
      for (const n of [...exportFileNames(t), title]) {
        const p = path.posix.resolve(DIR.posix, n);
        const w = path.win32.resolve(DIR.win32, n);
        if (!p.startsWith(`${DIR.posix}/`) || p.slice(DIR.posix.length + 1).includes('/')
          || !w.toLowerCase().startsWith(`${DIR.win32.toLowerCase()}\\`) || w.slice(DIR.win32.length + 1).includes('\\')) {
          escapes.push(`${JSON.stringify(t)} -> ${JSON.stringify(n)} -> ${p} | ${w}`);
        }
      }
    }
    ok('A TITLE CANNOT ESCAPE THE CHOSEN FOLDER — every base name AND the folder name resolve to one component inside it  '
      + `[entry point: safeTitle/exportFileNames, resolved with node:path posix AND win32, over ${HOSTILE.length} hostile titles]`,
      escapes.length === 0 && HOSTILE.length > 10,
      escapes.length ? escapes.slice(0, 4).join('  //  ') : `${HOSTILE.length} titles, ${HOSTILE.length * (STEMS.length + 1)} names, none escaped`);

    /**
     * INDEPENDENCE. Every assertion above is satisfied by a `safeTitle` that
     * returns the constant `'export'`, which would silently rename every file
     * the user ever exported. This is the control: an ordinary title survives
     * untouched, and that is what makes the escapes above a claim about escapes.
     */
    for (const t of ['Track 01', 'Björk — Jóga (Live)', 'a.b.c', '日本語のタイトル', "Don't Stop"]) {
      if (safeTitle(t) !== t) unchanged.push(`${JSON.stringify(t)} -> ${JSON.stringify(safeTitle(t))}`);
    }
    ok('...and an ORDINARY title is untouched, so the rule above is about escapes and not about renaming everything  '
      + '[the control: a safeTitle() that returned a constant would pass every assertion above]',
      unchanged.length === 0, unchanged.join('  //  ') || 'dots, dashes, apostrophes, accents and CJK all survive');

    ok('...a title that reduces to nothing still yields a name, rather than an empty path component',
      safeTitle('///') === '___' && safeTitle('') === 'export' && safeTitle('..') === 'export',
      `${JSON.stringify(safeTitle('///'))} ${JSON.stringify(safeTitle(''))} ${JSON.stringify(safeTitle('..'))}`);

    ok('...a Windows DEVICE name is escaped — `NUL` accepts every byte and keeps none',
      safeTitle('NUL') === '_NUL' && safeTitle('com1') === '_com1' && safeTitle('conch') === 'conch',
      `${safeTitle('NUL')} ${safeTitle('com1')} ${safeTitle('conch')}`);

    /**
     * `<device>.<anything>` IS STILL THE DEVICE, and this assertion is here
     * because the guard above it did not use to say so — the anchored `$` caught
     * a title that WAS the device and nothing else.
     *
     * WHAT IT COST, MEASURED: `NUL.wav`, `Con.Fusion`, `nul.02`, `con.brio`,
     * `com1.set`, `aux.1`, `lpt1.x` and `prn.mix` all came back unescaped. Win32
     * resolves a reserved BASE followed by any extension to the device itself —
     * MSDN: "NUL.txt and NUL.tar.gz are all equivalent to NUL" — so on Windows
     * every byte of such an export went to the null device, which accepts
     * everything and keeps nothing, and the run still emitted EXPORT_DONE naming
     * six files. SILENT DATA LOSS REPORTED AS SUCCESS. Every fixture below was
     * observed going through unescaped before the guard was widened.
     */
    const DEVICED = ['NUL.wav', 'Con.Fusion', 'nul.02', 'con.brio', 'com1.set', 'aux.1', 'lpt1.x', 'prn.mix', 'NUL.tar.gz'];
    const wentThrough = DEVICED.filter((t) => !safeTitle(t).startsWith('_'));
    ok('...AND SO IS `<device>.<anything>`: NUL.wav, NUL.txt and NUL.tar.gz all resolve to NUL on Windows  '
      + `[entry point: safeTitle over ${DEVICED.length} <device>.<ext> titles — an unescaped one is every byte written to the null device, reported as EXPORT_DONE]`,
      wentThrough.length === 0 && DEVICED.length > 5,
      wentThrough.length ? `unescaped: ${wentThrough.join(', ')}` : `${DEVICED.length} escaped: ${DEVICED.map((t) => safeTitle(t)).join(', ')}`);

    /**
     * THE CONTROL, and without it the assertion above is satisfied by escaping
     * every title that contains a dot — which is most of them. A base that only
     * LOOKS like a device is not one: `conch` and `nulla` merely start with the
     * letters, `comic` merely starts with `com`, and `a.con` has the device name
     * AFTER the dot, where Windows does not look.
     *
     * `com0` AND `lpt0` ARE DELIBERATELY NOT HERE, and their absence is a
     * declaration rather than an oversight: the guard's set is `com1-9`/`lpt1-9`
     * and current MSDN also lists COM0 and LPT0. This repair widened the ANCHOR
     * (`<device>.<anything>`) and did not touch the SET, which cannot be settled
     * from Linux. Asserting either way here would be this suite claiming
     * something it did not measure. See `safeTitle`'s RESERVED comment.
     */
    const LOOKALIKE = ['conch', 'nulla', 'comic', 'printer', 'concerto', 'a.con', 'auxiliary.wav', 'prnt.mix'];
    const overEscaped = LOOKALIKE.filter((t) => safeTitle(t) !== t);
    ok('...while a base that only LOOKS like a device is untouched, so the rule above is about devices and not about dots  '
      + `[the control: a guard that escaped every dotted title would pass the assertion above; ${LOOKALIKE.length} lookalikes]`,
      overEscaped.length === 0 && LOOKALIKE.length > 5,
      overEscaped.length ? `over-escaped: ${overEscaped.map((t) => `${t} -> ${safeTitle(t)}`).join(', ')}` : `${LOOKALIKE.length} lookalikes survive unchanged`);

    const long = exportFileNames('é'.repeat(400))[0];
    ok('...and a very long title is cut to fit a 255-BYTE name, on a code-point boundary  '
      + '[entry point: safeTitle, measured in UTF-8 bytes — 400 two-byte characters]',
      new TextEncoder().encode(long).length <= 255 && !/\uFFFD/.test(long) && long.endsWith(` - ${STEMS[0]}.wav`),
      `${new TextEncoder().encode(long).length} bytes`);
  }

  // ------------------------------------------- the whole path, end to end
  {
    const o = installOpfs();
    try {
      const frames = 1000;
      const cache = new StemCache(CAP, CACHE_DIR_32F, F32_TIER);
      const src = sixStems(frames);
      await cache.put('k32', { title: 'Some/Track:', seconds: frames / SR }, src);

      const { result, err, recs, plans, progress } = await drive(cache, 'k32');
      ok('THE RUN COMPLETES over a real StemCache in the 32f tier  '
        + '[entry point: ExportRun.run() -> StemCache.stemFile -> WavWindowReader -> WavStreamEncoder -> WritableStream]',
        err === null && result !== null && result.files.length === STEMS.length,
        err ? `${err.code}: ${err.message}` : `${result.files.length} files, ${result.bytes} bytes`);

      ok('...the Host was asked ONCE, for all six destinations together  '
        + '[entry point: the exportSink duty — one user gesture over N files]',
        plans.length === 1 && plans[0].files.length === STEMS.length,
        `${plans.length} call(s), ${plans.length ? plans[0].files.length : 0} file(s) in the plan`);

      ok('...and the sanitised title travels WITH the plan, because the Host makes a FOLDER out of it',
        plans.length === 1 && plans[0].title === 'Some_Track_', plans.length ? JSON.stringify(plans[0].title) : 'no plan');

      ok('...EXPORT_DONE reports exactly the names the Host was given, in the same order',
        result !== null && same(result.files, plans[0].files), result ? result.files.join(' | ') : 'no result');

      /**
       * `bytes` IS A WIRE FIELD — `EXPORT_DONE { files, bytes }` — and it is
       * checked against what the DESTINATIONS RECORDED RECEIVING, never against
       * the run's own arithmetic. Nothing used to read it at all: dropping the
       * header bytes from the total, and replacing the whole accumulation with a
       * constant 0, were both measured GREEN across the entire group.
       */
      const delivered = STEMS.reduce((a, st) => a + recs[`Some_Track_ - ${st}.wav`].bytes().length, 0);
      ok('...and EXPORT_DONE.bytes IS the number of bytes that reached the destinations, header and tail included  '
        + '[entry point: ExportRun.run()\u2019s resolved `bytes` vs the recording sinks\u2019 own byte totals]',
        result !== null && delivered > 0 && result.bytes === delivered
        && delivered === STEMS.length * (58 + frames * 8),
        result ? `${result.bytes} reported, ${delivered} delivered over ${STEMS.length} destinations `
          + `(wanted ${STEMS.length} * (58 + ${frames} * 8) = ${STEMS.length * (58 + frames * 8)})` : 'no result');

      // ---- the header, parsed out of the bytes that were emitted ----------
      const bad = [];
      for (const [i, s] of STEMS.entries()) {
        const name = `Some_Track_ - ${s}.wav`;
        const u8 = recs[name] ? recs[name].bytes() : new Uint8Array(0);
        const h = readHeader(u8);
        const want = {
          riff: 'RIFF', wave: 'WAVE', format: 3, channels: 2, sampleRate: 44100,
          bitDepth: 32, blockAlign: 8, byteRate: 44100 * 8,
        };
        const wrong = [];
        if (h.riff !== want.riff || h.wave !== want.wave) wrong.push(`tags ${h.riff}/${h.wave}`);
        if (!h.fmt) wrong.push('no fmt chunk');
        else {
          if (h.fmt.format !== want.format) wrong.push(`fmt tag ${h.fmt.format} (want 3, IEEE float)`);
          if (h.fmt.bitDepth !== want.bitDepth) wrong.push(`bits ${h.fmt.bitDepth}`);
          if (h.fmt.sampleRate !== want.sampleRate) wrong.push(`rate ${h.fmt.sampleRate}`);
          if (h.fmt.channels !== want.channels) wrong.push(`channels ${h.fmt.channels}`);
          if (h.fmt.blockAlign !== want.blockAlign) wrong.push(`blockAlign ${h.fmt.blockAlign}`);
          if (h.fmt.byteRate !== want.byteRate) wrong.push(`byteRate ${h.fmt.byteRate}`);
        }
        if (h.fact !== frames) wrong.push(`fact ${h.fact} (want ${frames})`);
        if (!h.data || h.data.size !== frames * 8) wrong.push(`data ${h.data ? h.data.size : 'absent'} (want ${frames * 8})`);
        if (h.riffSize !== u8.length - 8) wrong.push(`riffSize ${h.riffSize} vs fileSize-8 ${u8.length - 8}`);
        if (wrong.length) bad.push(`${s}[${i}]: ${wrong.join(', ')}`);
      }
      ok('EVERY FILE SAYS 32-BIT FLOAT, 44 100 Hz, STEREO IN ITS OWN HEADER, with a `fact` chunk and data = frames * 8  '
        + '[entry point: the emitted bytes, parsed — NOT the options that were passed in]',
        bad.length === 0 && Object.keys(recs).length === STEMS.length,
        bad.length ? bad.join('  //  ') : `${STEMS.length} files, fact ${frames}, data ${frames * 8} B, riff = fileSize-8`);

      // ---- bit identity against what the cache holds ----------------------
      const drift = [];
      for (const s of STEMS) {
        const name = `Some_Track_ - ${s}.wav`;
        const out = decodeWav(recs[name].bytes().buffer.slice(0));
        for (let c = 0; c < 2; c++) {
          for (let i = 0; i < frames; i++) {
            if (out.channels[c][i] !== src[s][c][i]) {
              drift.push(`${s} ch${c} frame ${i}: ${out.channels[c][i]} != ${src[s][c][i]}`);
              break;
            }
          }
        }
      }
      ok('THE STEMS ARE THE MODEL\u2019S, UNMODIFIED: every sample of every file is `===` to what went into the cache  '
        + '[entry point: decodeWav over the exported bytes vs the Float32Arrays put(); NOT "approximately equal"]',
        drift.length === 0 && frames > 0,
        drift.length ? drift.slice(0, 3).join('  //  ') : `${STEMS.length * 2 * frames} samples, exact`);

      ok('...INCLUDING the out-of-range samples — no clamp, no rescale, no normalisation on the deliverable path  '
        + '[the control: a fixture inside \u00b11.0 cannot tell a clamping export from an honest one]',
        (() => {
          const out = decodeWav(recs[`Some_Track_ - ${STEMS[0]}.wav`].bytes().buffer.slice(0));
          return out.channels[0][0] === Math.fround(1.7) && out.channels[1][1] === Math.fround(-1.42);
        })(),
        `read back ${decodeWav(recs[`Some_Track_ - ${STEMS[0]}.wav`].bytes().buffer.slice(0)).channels[0][0]}`);

      const bitwise = [];
      for (const s of STEMS) {
        const name = `Some_Track_ - ${s}.wav`;
        const cached = new Uint8Array(await (await cache.stemFile('k32', s)).arrayBuffer());
        const written = recs[name].bytes();
        const ch = readHeader(cached).data, wh = readHeader(written).data;
        const a = cached.subarray(ch.offset, ch.offset + ch.size);
        const b = written.subarray(wh.offset, wh.offset + wh.size);
        if (!same(a, b)) bitwise.push(`${s}: data chunks differ`);
      }
      ok('...and the DATA CHUNK is byte-identical to the cache file it came from, so the copy is a copy  '
        + '[entry point: the exported data bytes vs the 32f cache entry\u2019s own data bytes]',
        bitwise.length === 0, bitwise.join('  //  ') || `${STEMS.length} data chunks, byte-identical`);

      // ---- determinism: no dither anywhere on the float path ---------------
      const again = await drive(cache, 'k32');
      const nondet = STEMS.filter((s) => {
        const n = `Some_Track_ - ${s}.wav`;
        return !same(recs[n].bytes(), again.recs[n].bytes());
      });
      ok('...two exports of the same entry are byte-identical — the float path is NOT dithered  '
        + '[entry point: two ExportRun.run() over one cache entry; wav.js dithers only at 16-bit]',
        again.err === null && nondet.length === 0, nondet.length ? nondet.join(', ') : `${STEMS.length} files, identical twice`);

      // ---- every sink was CLOSED exactly once on a clean run ---------------
      const notClosed = STEMS.filter((s) => recs[`Some_Track_ - ${s}.wav`].closed !== 1);
      const anyAborted = STEMS.filter((s) => recs[`Some_Track_ - ${s}.wav`].aborted !== 0);
      ok('...and a SUCCESSFUL export closes every destination exactly once and aborts none  '
        + '[the control for the cancellation assertions below: without it, "all six aborted" is satisfied by aborting always]',
        notClosed.length === 0 && anyAborted.length === 0,
        `${STEMS.length - notClosed.length} closed once, ${anyAborted.length} aborted`);

      // ---- progress ---------------------------------------------------------
      const windows = Math.ceil(frames / CHUNK);
      const writes = progress.filter((p) => p.stage === 'write');
      const reads = progress.filter((p) => p.stage === 'read');
      ok('PROGRESS IS ONE MESSAGE PER STEM PER WINDOW, plus one for the read  '
        + '[entry point: ExportRun onProgress — a COUNT, not a clock]',
        reads.length === 1 && writes.length === windows * STEMS.length,
        `${reads.length} read + ${writes.length} write, wanted 1 + ${windows} * ${STEMS.length} = ${windows * STEMS.length}`);
      ok('...pct never goes backwards and ends at exactly 1',
        writes.length > 0 && writes.every((p, i) => i === 0 || p.pct >= writes[i - 1].pct)
        && writes[writes.length - 1].pct === 1,
        writes.length ? `${writes[0].pct.toFixed(4)} .. ${writes[writes.length - 1].pct}` : 'no ticks');
      ok('...and every tick names a file within the set it declares',
        writes.every((p) => p.files === STEMS.length && p.file >= 1 && p.file <= STEMS.length),
        `files=${writes.length ? writes[0].files : 0}`);

      /**
       * `etaMs` IS `null` WHILE THERE IS NOTHING TO DIVIDE BY, NEVER 0. A zero
       * renders as "finished" on any surface that formats a duration, so the
       * read tick — emitted before a single window is written — would announce a
       * completed export at the moment the folder dialog opens. Reporting 0 for
       * every tick was measured GREEN across the whole group.
       *
       * BOTH DIRECTIONS ARE HERE ON PURPOSE: null when it cannot be computed,
       * and a real number once it can. An `etaMs` that were always null would
       * satisfy the first half and carry no estimate at all.
       */
      ok('...and etaMs is `null` until something is done and a NUMBER afterwards \u2014 a zero would render as "finished"  '
        + '[entry point: ExportRun #tick \u2014 the read tick is emitted at pct 0, before the folder dialog]',
        reads.length === 1 && reads[0].etaMs === null
        && writes.length > 0 && writes.every((p) => typeof p.etaMs === 'number' && Number.isFinite(p.etaMs) && p.etaMs >= 0),
        `read tick etaMs ${JSON.stringify(reads[0] ? reads[0].etaMs : 'no read tick')}, `
        + `${writes.filter((p) => typeof p.etaMs === 'number').length} of ${writes.length} write ticks numeric`);
    } catch (e) {
      blockThrew('export — the whole path, end to end', e);
    } finally { o.restore(); }
  }

  // --------------------------------------------------- a cancelled export
  {
    const o = installOpfs();
    try {
      const frames = 1000;
      const cache = new StemCache(CAP, CACHE_DIR_32F, F32_TIER);
      await cache.put('kc', { title: 'Cancelled' }, sixStems(frames));
      const complete = 58 + frames * 8;

      let ticks = 0;
      const { result, err, recs } = await drive(cache, 'kc', {
        onTick: (p, run) => { if (p.stage === 'write' && ++ticks === 7) run.cancel(); },
      });

      const names = STEMS.map((s) => `Cancelled - ${s}.wav`);
      const closed = names.filter((n) => recs[n].closed !== 0);
      const aborted = names.filter((n) => recs[n].aborted === 1);
      /**
       * INDEPENDENCE, and this is the assertion that makes the two below mean
       * anything: bytes really had reached the destinations before the cancel.
       * A cancel that fired before the first write would satisfy "nothing
       * partial was left behind" having left nothing at all.
       */
      const withBytes = names.filter((n) => recs[n].bytes().length > 0);
      const finished = names.filter((n) => recs[n].bytes().length >= complete);

      ok('A CANCELLED EXPORT ABORTS EVERY DESTINATION AND CLOSES NONE  '
        + '[entry point: EXPORT_CANCEL -> ExportRun.cancel(), checked between windows]',
        closed.length === 0 && aborted.length === STEMS.length,
        `${closed.length} closed, ${aborted.length} of ${STEMS.length} aborted`);

      ok('...and the run really was under way when it was cancelled, so the assertion above measured something  '
        + '[the independence check: bytes on the sinks before the cancel]',
        withBytes.length === STEMS.length && ticks === 7,
        `${withBytes.length} of ${STEMS.length} destinations had bytes; ${ticks} windows written`);

      ok('...NO PARTIAL FILE IS LEFT: not one destination holds a whole file\u2019s worth of bytes  '
        + `[a complete file here is 58 + ${frames} * 8 = ${complete} bytes]`,
        finished.length === 0,
        `largest destination held ${Math.max(...names.map((n) => recs[n].bytes().length))} of ${complete} bytes`);

      ok('...and it fails by NAME, on the declared vocabulary, rather than resolving as if it had finished',
        err instanceof ExportError && err.code === 'CANCELLED' && result === null,
        err ? `${err.code}: ${err.message}` : 'the run RESOLVED');

      /**
       * ALL SIX ARE WRITTEN IN LOCKSTEP, and THIS ASSERTION IS LOAD-BEARING —
       * do not trim it as a restatement of "NO PARTIAL FILE IS LEFT" above.
       *
       * MEASURED: rewrite the run's two loops so each stem is written whole
       * before the next one starts — the defect that leaves five complete WAVs
       * on a user's disk after the user presses Stop — and every other
       * assertion in this block stays GREEN. "No partial file" cannot see it,
       * because at the cancel point the FIRST stem is not finished either way,
       * and "every destination aborted" is true of a sequential run too.
       *
       * The SPREAD between the longest and shortest destination is the only
       * figure that moves: at most one window while the six advance together,
       * five whole files once they do not. It is the entire coverage of the
       * interleaved write loop.
       */
      const lens = names.map((n) => recs[n].bytes().length);
      ok('...because the six files advance TOGETHER, never one finished at a time  '
        + '[entry point: the interleaved write loop — at most one window of spread across the six]',
        Math.max(...lens) - Math.min(...lens) <= CHUNK * 8,
        `spread ${Math.max(...lens) - Math.min(...lens)} B over a ${CHUNK * 8} B window`);
    } catch (e) {
      blockThrew('export — a cancelled export', e);
    } finally { o.restore(); }
  }

  // ------------------------------------------------------- every refusal
  {
    const o = installOpfs();
    try {
      const frames = 400;
      const cache = new StemCache(CAP, CACHE_DIR_32F, F32_TIER);
      await cache.put('kr', { title: 'Refusals' }, sixStems(frames));

      const sinkRefused = await drive(cache, 'kr', {
        exportSink: async () => { throw new Error('the user cancelled the folder dialog'); },
      });
      ok('A REFUSED `exportSink` IS AN ERROR, NOT A SILENT NO-OP  '
        + '[entry point: the exportSink duty rejecting \u2014 the ordinary case is the user cancelling the dialog]',
        sinkRefused.err instanceof ExportError && sinkRefused.err.code === 'SINK_REFUSED'
        && /cancelled the folder dialog/.test(sinkRefused.err.message),
        sinkRefused.err ? `${sinkRefused.err.code}: ${sinkRefused.err.message}` : 'the run RESOLVED');

      const short = await drive(cache, 'kr', { dropFile: `Refusals - ${STEMS[3]}.wav` });
      const openedAndAborted = STEMS.filter((s) => {
        const r = short.recs[`Refusals - ${s}.wav`];
        return r && r.aborted === 1;
      });
      ok('A SINK MAP THAT IS SHORT ONE STEM IS REFUSED \u2014 five of six files is a broken export, not a smaller one  '
        + '[entry point: ExportRun.run(), the map returned by exportSink]',
        short.err instanceof ExportError && short.err.code === 'SINK_SHORT'
        && short.err.message.includes(STEMS[3]),
        short.err ? `${short.err.code}: ${short.err.message}` : 'the run RESOLVED');
      ok('...and the destinations the Host DID open are aborted, so it is not left holding files no export will finish',
        openedAndAborted.length === STEMS.length - 1,
        `${openedAndAborted.length} of ${STEMS.length - 1} aborted`);

      const badStem = await drive(cache, 'kr', { stems: ['vocals', 'trumpet'] });
      ok('A STEM THE SIX-STEM CONTRACT HAS NO NAME FOR IS REFUSED, naming it and the legal set',
        badStem.err instanceof ExportError && badStem.err.code === 'BAD_STEM'
        && /trumpet/.test(badStem.err.message) && /guitar/.test(badStem.err.message),
        badStem.err ? `${badStem.err.code}: ${badStem.err.message}` : 'the run RESOLVED');

      const badFmt = await drive(cache, 'kr', { format: { bitDepth: 16, float: false } });
      ok('A FORMAT OTHER THAN 32-BIT FLOAT IS REFUSED BY NAME rather than silently ignored  '
        + '[entry point: EXPORT_START { format } \u2014 E1 is DEFINED as the untouched output, so 16-bit is a different deliverable]',
        badFmt.err instanceof ExportError && badFmt.err.code === 'BAD_FORMAT' && /16/.test(badFmt.err.message),
        badFmt.err ? `${badFmt.err.code}: ${badFmt.err.message}` : 'the run RESOLVED');
      const goodFmt = await drive(cache, 'kr', { format: { bitDepth: 32, float: true } });
      ok('...while the format it DOES write is accepted, so the refusal is about the depth and not about the field',
        goodFmt.err === null, goodFmt.err ? `${goodFmt.err.code}: ${goodFmt.err.message}` : 'accepted');

      /**
       * A 16-bit entry, in the LIVE tier, asked for as a deliverable.
       *
       * `opens.length === 0` IS THE WHOLE ASSERTION, not decoration. TWO guards
       * refuse this fixture — this manifest-row check and the file-header check
       * below — and both throw `WRONG_TIER` with "16-bit" in the message, so a
       * match on the code or on the words cannot tell which one fired. Measured:
       * with the row check deleted this assertion stayed GREEN, and the battery
       * anchor aimed at it reported a watched red it had not watched. The COUNT
       * of stem files opened is the observation the two guards disagree about —
       * the row refuses before anything opens, the header has to open all six.
       * See this file's header: two guards with one observation are one guard.
       */
      const live = new StemCache(CAP);
      await live.put('k16', { title: 'Live copy' }, sixStems(frames));
      const wrongTier = await drive(live, 'k16');
      ok('A 16-BIT ENTRY IS NOT A DELIVERABLE \u2014 exporting one would present a re-quantisation as the model\u2019s own samples  '
        + '[entry point: the manifest row\u2019s `depth`, BEFORE a single stem file is opened]',
        wrongTier.err instanceof ExportError && wrongTier.err.code === 'WRONG_TIER'
        && /16-bit/.test(wrongTier.err.message) && wrongTier.opens.length === 0,
        wrongTier.err
          ? `${wrongTier.err.code} after opening ${wrongTier.opens.length} stem file(s): ${wrongTier.err.message}`
          : 'the run RESOLVED');

      /**
       * THE FILE'S OWN HEADER OUTRANKS THE MANIFEST ROW. A row saying 32 over
       * bytes that are 16 is exactly the "stale but plausible" entry
       * `shared/stemcache.js`'s header calls the worst bug this project can
       * ship, and the manifest is the half that cannot notice.
       */
      const liar = await drive(cache, 'kr', {
        entry: { ...(await cache.entry('kr')), depth: 32 },
        openStem: async (stem) => new WavWindowReader(await live.stemFile('k16', stem)).open(),
      });
      ok('...and a row that says 32 over bytes that are 16 is caught by READING THE FILE\u2019S HEADER, not the row  '
        + '[entry point: ExportRun.run() checking each opened reader against EXPORT_FORMAT]',
        liar.err instanceof ExportError && liar.err.code === 'WRONG_TIER' && /own header/.test(liar.err.message),
        liar.err ? `${liar.err.code}: ${liar.err.message}` : 'the run RESOLVED');

      const shortFile = await drive(cache, 'kr', { entry: { ...(await cache.entry('kr')), frames: frames + 1 } });
      ok('AN ENTRY THAT DISAGREES WITH ITSELF IS REFUSED \u2014 neither frame count can go into a header  '
        + '[entry point: the manifest\u2019s `frames` against the stem file\u2019s own]',
        shortFile.err instanceof ExportError && shortFile.err.code === 'READ_FAILED'
        && shortFile.err.message.includes(String(frames)),
        shortFile.err ? `${shortFile.err.code}: ${shortFile.err.message}` : 'the run RESOLVED');

      const noEntry = await drive(cache, 'kr', { entry: null });
      ok('A KEY THAT NAMES NOTHING IS REFUSED before a single file or destination is opened',
        noEntry.err instanceof ExportError && noEntry.err.code === 'NO_ENTRY'
        && noEntry.plans.length === 0 && noEntry.opens.length === 0,
        noEntry.err
          ? `${noEntry.err.code} after ${noEntry.opens.length} open(s) and ${noEntry.plans.length} sink call(s)`
          : 'the run RESOLVED');

      const gone = await drive(cache, 'kr', {
        openStem: async (stem) => { if (stem === STEMS[2]) throw new Error('NotFoundError'); return new WavWindowReader(await cache.stemFile('kr', stem)).open(); },
      });
      ok('A STEM FILE THAT WILL NOT OPEN IS A NAMED REFUSAL, and no destination is opened for the other five  '
        + '[entry point: openStem rejecting \u2014 the readers are all opened BEFORE the dialog]',
        gone.err instanceof ExportError && gone.err.code === 'READ_FAILED'
        && gone.err.message.includes(STEMS[2]) && gone.plans.length === 0,
        gone.err ? `${gone.err.code} after ${gone.plans.length} sink call(s)` : 'the run RESOLVED');

      const wrote = await drive(cache, 'kr', { sinkFailAt: 3 });
      const closedAfterFail = STEMS.filter((s) => wrote.recs[`Refusals - ${s}.wav`].closed !== 0);
      ok('A DESTINATION THAT REJECTS MID-WRITE IS A NAMED REFUSAL and closes nothing  '
        + '[entry point: the WritableStream rejecting \u2014 a full disk, a folder deleted under the run]',
        wrote.err instanceof ExportError && wrote.err.code === 'WRITE_FAILED' && closedAfterFail.length === 0,
        wrote.err ? `${wrote.err.code}, ${closedAfterFail.length} closed` : 'the run RESOLVED');

      /**
       * THE ONE WINDOW WHERE EVERY DESTINATION IS OPEN AND NOT ONE BYTE HAS BEEN
       * WRITTEN — between the Host handing back the map and the first header
       * going out. Two things throw in it, and both used to throw PAST the run's
       * abort because they sat above the guard rather than inside it:
       * `getWriter()` refuses a stream something already holds the lock on, and
       * `WavStreamEncoder`'s constructor refuses a track over the 4 GiB RIFF
       * ceiling. MEASURED before the fix: a raw TypeError / RangeError — not a
       * member of the closed vocabulary — and every writable the Host had just
       * opened left neither closed NOR aborted.
       *
       * WHY IT IS ASSERTED ON THE ABORT COUNTS AND NOT ON THE CODE. "The error
       * has the right name" is satisfied by wrapping the throw and changing
       * nothing else; what reaches a user is six files nobody will ever finish,
       * and only the sinks' own `abort`/`close` counters can see that.
       */
      const dupRecs = [];
      const shared = makeSink();
      const duplicate = await drive(cache, 'kr', {
        exportSink: async (plan) => {
          const map = {};
          // The same writable under two names — a Host collision policy that
          // resolved two titles to one file would hand back exactly this.
          plan.files.forEach((n, i) => { const rec = i < 2 ? shared : makeSink(); dupRecs.push(rec); map[n] = rec.stream; });
          return map;
        },
      });
      const dupOpened = [...new Set(dupRecs)];
      const dupLeftOpen = dupOpened.filter((r) => r.aborted === 0);
      const dupClosed = dupOpened.filter((r) => r.closed !== 0);
      ok('A HOST THAT RETURNS ONE WRITABLE UNDER TWO NAMES IS A NAMED REFUSAL, and every destination it opened is ABORTED  '
        + '[entry point: getWriter() on an already-locked stream, inside the run\u2019s guard \u2014 counts off the sinks, not the code]',
        duplicate.err instanceof ExportError && duplicate.err.code === 'WRITE_FAILED'
        && dupOpened.length === STEMS.length - 1 && dupLeftOpen.length === 0 && dupClosed.length === 0,
        duplicate.err
          ? `${duplicate.err.name}/${duplicate.err.code}: ${dupOpened.length - dupLeftOpen.length} of ${dupOpened.length} aborted, ${dupClosed.length} closed`
          : 'the run RESOLVED');

      /**
       * THE FIXTURE IS BOUNDED ON PURPOSE, and this is a rule about fixtures and
       * not about this case: the frame count that clears the 4 GiB ceiling is
       * half a billion, so a mutation that removes the refusal would otherwise
       * put this suite into a six-million-window loop that never reports. A
       * suite that can run away cannot go red. `read()` THROWS instead, so the
       * mutant path dies at the first window and reds on the message.
       */
      const hugeEntry = { ...(await cache.entry('kr')), frames: 600e6 };
      const huge = await drive(cache, 'kr', {
        entry: hugeEntry,
        openStem: async () => ({
          frames: hugeEntry.frames, sampleRate: SR, bitDepth: 32, float: true, channels: 2,
          async read() { throw new Error('this fixture must never reach a read: the 4 GiB refusal is what it measures'); },
        }),
      });
      const hugeRecs = STEMS.map((st) => huge.recs[`Refusals - ${st}.wav`]).filter(Boolean);
      ok('...and a track past the 4 GiB RIFF ceiling is refused BY NAME after the sinks open, all six aborted and none closed  '
        + '[entry point: WavStreamEncoder\u2019s constructor \u2014 it refuses here rather than after three GiB have been streamed]',
        huge.err instanceof ExportError && huge.err.code === 'WRITE_FAILED' && /4 GiB/.test(huge.err.message)
        && hugeRecs.length === STEMS.length && hugeRecs.every((r) => r.aborted === 1 && r.closed === 0),
        huge.err
          ? `${huge.err.name}/${huge.err.code}: ${hugeRecs.filter((r) => r.aborted === 1).length} of ${STEMS.length} aborted, `
            + `${hugeRecs.filter((r) => r.closed !== 0).length} closed`
          : 'the run RESOLVED');

      const noStems = await drive(cache, 'kr', { stems: [] });
      ok('AN EXPORT OF NO STEMS IS REFUSED \u2014 an empty list is not a smaller export  '
        + '[entry point: EXPORT_START { stems: [] }; a COUNT of opens and sink calls says it refused before touching anything]',
        noStems.err instanceof ExportError && noStems.err.code === 'BAD_STEM'
        && noStems.opens.length === 0 && noStems.plans.length === 0,
        noStems.err
          ? `${noStems.err.code} after ${noStems.opens.length} open(s) and ${noStems.plans.length} sink call(s): ${noStems.err.message}`
          : 'the run RESOLVED');

      const zeroFrames = await drive(cache, 'kr', { entry: { ...(await cache.entry('kr')), frames: 0 } });
      const fracFrames = await drive(cache, 'kr', { entry: { ...(await cache.entry('kr')), frames: frames + 0.5 } });
      ok('A LENGTH THAT IS NOT A POSITIVE INTEGER IS REFUSED \u2014 neither 0 nor a fraction can go into a RIFF header  '
        + '[entry point: the manifest row\u2019s `frames`, checked before the tier, the readers and the dialog]',
        zeroFrames.err instanceof ExportError && zeroFrames.err.code === 'READ_FAILED' && /0 frames/.test(zeroFrames.err.message)
        && fracFrames.err instanceof ExportError && fracFrames.err.code === 'READ_FAILED'
        && zeroFrames.opens.length === 0 && zeroFrames.plans.length === 0
        && fracFrames.opens.length === 0 && fracFrames.plans.length === 0,
        `0 -> ${zeroFrames.err ? zeroFrames.err.code : 'RESOLVED'}, ${frames + 0.5} -> ${fracFrames.err ? fracFrames.err.code : 'RESOLVED'}; `
        + `${zeroFrames.opens.length + fracFrames.opens.length} open(s), ${zeroFrames.plans.length + fracFrames.plans.length} sink call(s)`);

      /**
       * THE READERS ARE OPEN AND THE DIALOG HAS NOT BEEN SHOWN. A cancel landing
       * here must not open a folder dialog the user will never see the result
       * of, and the check that stops it is the one BEFORE `exportSink` \u2014 the
       * later between-windows check cannot reach it. `plans.length === 0` is a
       * count of the Host being asked, which is the only way to tell the two
       * cancel checks apart.
       */
      const earlyCancel = await drive(cache, 'kr', {
        onOpen: (stem, run) => { if (stem === STEMS[STEMS.length - 1]) run.cancel(); },
      });
      ok('A CANCEL THAT LANDS BEFORE THE FOLDER DIALOG STOPS THE RUN AND NEVER ASKS THE HOST  '
        + '[entry point: ExportRun.cancel() between the last reader opening and exportSink \u2014 a COUNT of sink calls]',
        earlyCancel.err instanceof ExportError && earlyCancel.err.code === 'CANCELLED'
        && earlyCancel.opens.length === STEMS.length && earlyCancel.plans.length === 0,
        earlyCancel.err
          ? `${earlyCancel.err.code} after ${earlyCancel.opens.length} open(s) and ${earlyCancel.plans.length} sink call(s)`
          : 'the run RESOLVED');

      /**
       * THE PLAN HANDED TO THE HOST IS A COPY, and the reason is a Host that
       * means well: a collision policy sorts or de-duplicates the array it was
       * given, and if that array were the run's own `names` it would be
       * renaming `EXPORT_DONE.files` from under it — the user told about names
       * the bytes never went to. Measured GREEN across the whole group before
       * this assertion existed, because nothing in the suite mistreated the plan.
       */
      const hostile = await drive(cache, 'kr', {
        exportSink: async (plan) => {
          const map = {};
          for (const n of plan.files) map[n] = makeSink().stream;
          plan.files.length = 0;
          plan.files.push('hijacked.wav');
          return map;
        },
      });
      ok('THE PLAN THE HOST RECEIVES IS A COPY \u2014 a Host that rewrites `files` cannot rename the deliverable  '
        + '[entry point: exportSink({ title, files }); the Host empties the array and pushes its own name into it]',
        hostile.err === null && hostile.result !== null
        && hostile.result.files.length === STEMS.length
        && hostile.result.files.every((n, i) => n === `Refusals - ${STEMS[i]}.wav`),
        hostile.err ? `${hostile.err.code}: ${hostile.err.message}` : hostile.result.files.join(' | '));

      const twice = await drive(cache, 'kr');
      const again = await twice.run.run().then(() => null, (e) => e);
      ok('A RUN CANNOT BE STARTED TWICE \u2014 two runs would write windows into each other\u2019s destinations',
        twice.err === null && again instanceof ExportError && again.code === 'BUSY',
        again ? `${again.code}: ${again.message}` : 'the second run RESOLVED');
    } catch (e) {
      blockThrew('export — every refusal', e);
    } finally { o.restore(); }
  }

  // -------------------------------------- the memory claim, MEASURED
  /**
   * PEAK RESIDENT DOES NOT SCALE WITH TRACK LENGTH. This is U1's whole reason
   * and `WavWindowReader`'s, and it is measured on the reads the shim RECORDS
   * rather than argued from the shape of the code — a reader that quietly
   * slurped each file would satisfy every sample assertion above.
   *
   * THE ESTIMATOR IS TAKEN TWICE, AT TWO TRACK LENGTHS. The claim is "does not
   * scale", so one measurement cannot carry it: it would be a constant the test
   * chose for itself. 500 frames and 2000 frames, same window, same numbers.
   */
  {
    const o = installOpfs();
    try {
      /** Where the audio starts in a 32f stereo file, DERIVED rather than typed. */
      const DATA_AT = readHeader(new Uint8Array(encodeWav(
        [new Float32Array(1), new Float32Array(1)], { sampleRate: SR, bitDepth: 32, float: true },
      ))).data.offset;
      const WINDOW = 128;
      const readsFor = async (frames) => {
        const cache = new StemCache(CAP, CACHE_DIR_32F, F32_TIER);
        await cache.put(`km${frames}`, { title: `M${frames}` }, sixStems(frames));
        const before = o.reads.length;
        const r = await drive(cache, `km${frames}`, { chunkFrames: WINDOW });
        const mine = o.reads.slice(before).filter((x) => x.name.startsWith(`km${frames}.`));
        const audio = mine.filter((x) => x.at >= DATA_AT);
        return {
          err: r.err,
          biggest: Math.max(...mine.map((x) => x.bytes)),
          audioBytes: audio.reduce((a, x) => a + x.bytes, 0),
          audioReads: audio.length,
        };
      };
      const a = await readsFor(500);
      const b = await readsFor(2000);
      ok('THE BIGGEST SINGLE READ IS ONE WINDOW, AND IT DOES NOT GROW WITH THE TRACK  '
        + `[entry point: WavWindowReader.read over the OPFS shim with its byte ranges recorded; ${500} frames vs ${2000}]`,
        a.err === null && b.err === null && a.biggest === b.biggest && b.biggest === WINDOW * 8,
        `biggest read ${a.biggest} B at 500 frames, ${b.biggest} B at 2000 — one ${WINDOW}-frame stereo 32f window is ${WINDOW * 8} B`);

      ok('...and the audio is read EXACTLY ONCE end to end, so that number is not small because something was re-read  '
        + '[the control: a reader that halved its window and re-read the overlap would pass the assertion above]',
        b.audioBytes === STEMS.length * 2000 * 8 && a.audioBytes === STEMS.length * 500 * 8,
        `${b.audioBytes} B read for ${STEMS.length} x 2000 frames x 8 B = ${STEMS.length * 2000 * 8} B, `
        + `over ${b.audioReads} reads`);

      ok('...and the read COUNT scales while the read SIZE does not, which is what "windowed" means  '
        + '[500 frames vs 2000 at a 128-frame window: 4 windows per stem vs 16]',
        b.audioReads === Math.ceil(2000 / WINDOW) * STEMS.length && a.audioReads === Math.ceil(500 / WINDOW) * STEMS.length,
        `${a.audioReads} reads at 500 frames, ${b.audioReads} at 2000`);

      ok('...while `StemCache.get()` takes each stem WHOLE, which is why the export does not call it  '
        + '[the contrast that gives the numbers above a scale: get() decodes all six stems whole, ~508 MB at four minutes]',
        await (async () => {
          const cache = new StemCache(CAP, CACHE_DIR_32F, F32_TIER);
          await cache.put('kg', { title: 'G' }, sixStems(500));
          const before = o.reads.length;
          await cache.get('kg');
          const mine = o.reads.slice(before).filter((x) => x.name.startsWith('kg.'));
          return mine.length === STEMS.length && mine.every((x) => x.bytes >= DATA_AT + 500 * 8);
        })(),
        `get() reads ${STEMS.length} whole files; the export reads ${b.audioReads / STEMS.length} windows per stem`);
    } catch (e) {
      blockThrew('export — the memory claim', e);
    } finally { o.restore(); }
  }

  // ---------------------------------------- the closed error vocabulary (#29)
  /**
   * `console.error` IS SWAPPED FOR THE ONE CALL and put back before the `ok()`
   * that reads the result \u2014 never around the block. `ok()` reports a failure
   * through `console.log`, but a capture that spanned the assertions would still
   * swallow anything else this file wants to say, and the shape is the one
   * `ui/dev/selftest.mjs` established for `checkArmCode` after a capture around
   * the block turned seven mutations green.
   */
  {
    const say = (code, where) => {
      const captured = [];
      const real = console.error;
      console.error = (m) => captured.push(String(m));
      let out;
      try { out = checkExportCode(code, where); } finally { console.error = real; }
      return { out, captured };
    };

    let cried = 0;
    for (const c of EXPORT_CODES) { const r = say(c); cried += r.captured.length; }
    ok('EVERY MEMBER OF THE EXPORT VOCABULARY PASSES SILENTLY  '
      + `[entry point: checkExportCode over all ${EXPORT_CODES.size} members]`,
      cried === 0, `${cried} line(s) from ${EXPORT_CODES.size} legal codes`);

    const bad = say('EXPORT_FAILED', 'EXPORT_ERROR from the Host');
    ok('AN UNKNOWN CODE IS REFUSED rather than accepted in silence \u2014 #29\u2019s lesson, applied before it can be repeated',
      typeof bad.out === 'string' && bad.captured.length === 1,
      `${bad.captured.length} line(s), returned ${typeof bad.out}`);
    const logged = bad.captured[0] || '';
    const absent = [...EXPORT_CODES].filter((c) => !logged.includes(c));
    ok('...and the message names the offending value, the entry point, and THE WHOLE LEGAL SET, so it is a repair instruction',
      logged.includes('EXPORT_FAILED') && logged.includes('EXPORT_ERROR from the Host') && absent.length === 0,
      absent.length ? `missing ${absent.join(', ')}` : `all ${EXPORT_CODES.size} named`);

    const exportSrc = strip(readFileSync(new URL('./extension/engine/export.js', import.meta.url), 'utf8'));
    const thrown = [...exportSrc.matchAll(/new ExportError\('(\w+)'/g)].map((m) => m[1]);
    const undeclared = [...new Set(thrown)].filter((c) => !EXPORT_CODES.has(c));
    ok('EVERY CODE THE RUNNER CAN THROW IS A DECLARED MEMBER  '
      + '[entry point: extension/engine/export.js read as text, comments stripped \u2014 a typo\u2019d code no test happened to reach]',
      thrown.length > 5 && undeclared.length === 0,
      thrown.length === 0 ? 'this scan found no throws at all, so it inspected nothing' : undeclared.length
        ? `undeclared: ${undeclared.join(', ')}` : `${new Set(thrown).size} distinct codes thrown, all declared`);

    const engineSrc = strip(readFileSync(new URL('./extension/offscreen/engine.js', import.meta.url), 'utf8'));
    const emitted = [...engineSrc.matchAll(/exportFailed\([^,]+,\s*'(\w+)'/g)].map((m) => m[1]);
    const dead = [...EXPORT_CODES].filter((c) => !thrown.includes(c) && !emitted.includes(c));
    ok('...and every declared member is REACHABLE, so the vocabulary cannot grow a code nothing can send',
      emitted.length > 0 && dead.length === 0,
      dead.length ? `declared but unreachable: ${dead.join(', ')}` : `${EXPORT_CODES.size} members, all reachable`);

    /**
     * ...AND THE ENGINE REALLY CALLS THE CHECK. `checkExportCode` working proves
     * nothing about anything calling it \u2014 the same gap this file records for
     * `assertHost`, where review deleted the module-scope call and watched the
     * whole tree stay green.
     */
    const calls = (engineSrc.match(/\bcheckExportCode\s*\(/g) || []).length;
    const sends = (engineSrc.match(/type: 'EXPORT_ERROR'/g) || []).length;
    ok('...AND `offscreen/engine.js` CHECKS EVERY CODE IT SENDS: one checkExportCode() per EXPORT_ERROR, in the same function  '
      + '[entry point: extension/offscreen/engine.js read as text, comments stripped]',
      calls === 1 && sends === 1 && /import \{[^}]*checkExportCode[^}]*\} from '\.\.\/engine\/export\.js'/.test(engineSrc),
      `${calls} check(s), ${sends} EXPORT_ERROR send(s)`);

    ok('...and the engine really wires `EXPORT_START` and `EXPORT_CANCEL` to the runner  '
      + '[entry point: the case labels and the ExportRun construction in offscreen/engine.js]',
      engineSrc.includes("case 'EXPORT_START'") && engineSrc.includes("case 'EXPORT_CANCEL'")
      && /new ExportRun\(/.test(engineSrc) && /host\.exportSink\(/.test(engineSrc)
      && /\.cancel\(\)/.test(engineSrc),
      'EXPORT_START, EXPORT_CANCEL, new ExportRun, host.exportSink, cancel()');

    /**
     * NOTHING THE DECK DID IS APPLIED, asserted STRUCTURALLY because there is no
     * fader to move in a Node suite. The import list is the whole surface: a
     * gain, a mute or a crossfader position could only reach this path through
     * one of these two modules, and neither has one.
     */
    const imports = [...exportSrc.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    ok('THE DELIVERABLE PATH IMPORTS NO MIXER, NO DECK AND NO WORKLET \u2014 there is nowhere for a fader to be applied  '
      + '[entry point: extension/engine/export.js\u2019s own import list; a Bounce is a different deliverable, upstream #17]',
      imports.length === 2 && imports[0] === '../shared/config.js' && imports[1] === '../shared/wav.js',
      imports.join(', ') || 'this scan read no imports at all');
  }

  // ------------------------------------------- the reader, on its own terms
  {
    const frames = 777;
    const l = noise(frames, 91), r = noise(frames, 93);
    l[5] = 2.5;
    const buf = encodeWav([l, r], { sampleRate: SR, bitDepth: 32, float: true });
    const rd = new WavWindowReader(new Blob([buf]));
    const opened = await rd.open();
    ok('THE WINDOWED READER REPORTS THE FILE\u2019S OWN FORMAT  '
      + '[entry point: WavWindowReader.open() over a Blob \u2014 the read half of the memory claim]',
      opened === rd && rd.frames === frames && rd.sampleRate === SR && rd.bitDepth === 32
      && rd.float === true && rd.channels === 2,
      `${rd.frames} frames, ${rd.bitDepth}-bit ${rd.float ? 'float' : 'fixed'}, ${rd.sampleRate} Hz, ${rd.channels} ch`);

    const L = new Float32Array(64), R = new Float32Array(64);
    await rd.read(100, 64, [L, R]);
    let off = 0;
    for (let i = 0; i < 64; i++) if (L[i] !== l[100 + i] || R[i] !== r[100 + i]) { off++; }
    ok('...and a window in the MIDDLE of the file is the same samples `decodeWav` reads there  '
      + '[entry point: WavWindowReader.read(from, count) vs decodeWav over the whole file]',
      off === 0, `${off} of 64 frames differ at offset 100`);

    const noOpen = new WavWindowReader(new Blob([buf]));
    let threwUnopened = null;
    try { noOpen.frames; noOpen.sampleRate; } catch (e) { threwUnopened = e.message; }
    ok('...a reader that has read no header REPORTS NOTHING rather than a default  '
      + '[fail when you cannot look: a defaulted format is agreement that was never checked]',
      threwUnopened !== null && /open\(\)/.test(threwUnopened), threwUnopened || 'it answered anyway');

    let past = null;
    try { await rd.read(frames - 10, 64, [L, R]); } catch (e) { past = e.message; }
    ok('...and a read past the end is REFUSED, naming both counts, rather than coming back short  '
      + '[entry point: WavWindowReader.read \u2014 a short read taken for a complete one writes a file whose header over-promises]',
      past !== null && past.includes(String(frames)), past || 'it returned a short read');

    let planes = null;
    try { await rd.read(0, 64, [L]); } catch (e) { planes = e.message; }
    ok('...and a wrong number of planes is refused rather than filling half a window',
      planes !== null && /1 planes/.test(planes), planes || 'it accepted one plane for a stereo file');
  }
}

// ===========================================================================
if (group('fft')) {
  head('fft — rfft vs naive DFT, and STFT/iSTFT round trip');
  {
    const N = 256;
    const x = noise(N, 5);
    const re = new Float32Array(N / 2 + 1), im = new Float32Array(N / 2 + 1);
    rfft(x, 0, N, re, im, 0, 1);
    let worst = 0, mag = 0;
    for (let k = 0; k <= N / 2; k++) {
      let sr = 0, si = 0;
      for (let t = 0; t < N; t++) { const a = -2 * Math.PI * k * t / N; sr += x[t] * Math.cos(a); si += x[t] * Math.sin(a); }
      worst = Math.max(worst, Math.hypot(re[k] - sr, im[k] - si));
      mag = Math.max(mag, Math.hypot(sr, si));
    }
    ok('rfft matches a naive DFT', worst / mag < 1e-6, `max rel err ${(worst / mag).toExponential(2)}`);
  }
  {
    // the pipeline's actual configuration
    const nfft = 4096, hop = 1024, frames = 40;
    const n = (frames - 1) * hop + nfft;
    const x = noise(n, 6);
    const S = stft(x, nfft, hop);
    const y = istft(S.real, S.imag, S.numFrames, S.numBins, nfft, hop, n);
    // window-sum normalisation only reconstructs the fully-overlapped interior
    const a = nfft, b = n - nfft;
    const db = residualDb(y.subarray(a, b), x.subarray(a, b));
    ok(`STFT->iSTFT interior residual ${db.toFixed(1)} dB (gate < -100)`, db < -100);
    ok('periodic Hann (w[0] === 0, no duplicate endpoint)',
      hann(8)[0] === 0 && Math.abs(hann(8)[4] - 1) < 1e-12);
  }
}

// ===========================================================================
if (group('ring')) {
  head('ring — SAB capture ring is lossless across wrap');
  // RENDERING ONLY on the producer side: capture-processor.js cannot be imported
  // outside an AudioWorklet, so the writer here mirrors it.
  // Reached by: run-ext.mjs "SAB ring filled from the AudioWorklet, no drops".
  if (typeof SharedArrayBuffer !== 'function') {
    ok('SharedArrayBuffer available', false, 'not in this node build');
  } else {
    const CAP = 1 << 12;
    const sab = new SharedArrayBuffer(ringByteLength(CAP));
    const ring = new RingConsumer(sab, CAP);
    // Mirrors the write loop in offscreen/capture-processor.js (which cannot be
    // imported here: it needs AudioWorkletGlobalScope).
    const hdr = new Int32Array(sab, 0, 16);
    const pl = new Float32Array(sab, 64, CAP);
    const pr = new Float32Array(sab, 64 + CAP * 4, CAP);
    const produce = (block) => {
      const w = Atomics.load(hdr, 0);
      for (let i = 0; i < block.length; i++) {
        const idx = (w + i) & (CAP - 1);
        pl[idx] = block[i]; pr[idx] = -block[i];
      }
      Atomics.store(hdr, 0, w + block.length);
    };

    const total = CAP * 5 + 377;      // several wraps, not a multiple of capacity
    const src = noise(total, 9);
    const got = [];
    let produced = 0;
    while (produced < total) {
      const n = Math.min(128, total - produced);
      produce(src.subarray(produced, produced + n));
      produced += n;
      if (produced % 1024 === 0) { const d = ring.drain(); if (d) got.push(d); }
    }
    const d = ring.drain(); if (d) got.push(d);

    const outL = new Float32Array(total); let o = 0, dropped = 0;
    for (const g of got) { outL.set(g.l, o); o += g.l.length; dropped += g.dropped; }
    ok('every produced frame came back, in order', o === total && dropped === 0 &&
      outL.every((v, i) => v === src[i]), `${o}/${total} frames, ${dropped} dropped`);

    ok('R (mono up-mix path) is independent of L',
      got[0].r[0] === -src[0]);

    // overflow must be reported, not silently swallowed
    const sab2 = new SharedArrayBuffer(ringByteLength(CAP));
    const ring2 = new RingConsumer(sab2, CAP);
    const hdr2 = new Int32Array(sab2, 0, 16);
    Atomics.store(hdr2, 0, CAP * 2 + 5);           // producer lapped us twice
    const d2 = ring2.drain();
    ok('an overrun is reported as `dropped`', d2 && d2.dropped === CAP + 5 && d2.l.length === CAP,
      `dropped ${d2 && d2.dropped}`);

    ok('default ring holds 23.7 s at 44.1 kHz', Math.abs(RING_FRAMES / SR - 23.78) < 0.05,
      `${(RING_FRAMES / SR).toFixed(2)} s`);
  }
}

// ===========================================================================
if (group('live')) {
  head('live — causal chunk plan (spike/FINDINGS.md §5)');

  for (const hop of LIVE_HOPS) {
    const p = makeLivePlan(hop);
    // every published frame, exactly once, no gaps, no double-emit
    const nChunks = 40;
    const seen = new Int32Array(chunkPlan(nChunks - 1, p).emitTo);
    let bad = '';
    let cursor = 0;
    for (let k = 0; k < nChunks; k++) {
      const c = chunkPlan(k, p);
      if (c.emitFrom !== cursor) { bad = `chunk ${k} starts at ${c.emitFrom}, expected ${cursor}`; break; }
      for (let i = c.emitFrom; i < c.emitTo; i++) seen[i]++;
      cursor = c.emitTo;
      if (c.emitLen !== (k === 0 ? p.H - p.X : p.H)) { bad = `chunk ${k} emits ${c.emitLen}`; break; }
      if (c.srcOffset < 0 || c.srcOffset + c.emitLen > p.L) { bad = `chunk ${k} reads outside the model output`; break; }
      if (c.inputEnd - c.inputStart !== p.L) { bad = `chunk ${k} window is not ${p.L}`; break; }
      // CAUSAL: the window must never need a sample later than its own end.
      if (c.emitTo > c.inputEnd) { bad = `chunk ${k} emits past its input (lookahead!)`; break; }
    }
    const once = !bad && seen.every((v) => v === 1);
    ok(`hop ${hop}s: ${nChunks} chunks, every output sample emitted exactly once, no lookahead`,
      once, bad || `H=${p.H} X=${p.X} srcOffset=${p.srcOffset}`);
  }

  {
    const p = makeLivePlan(1.95);
    ok('the model window is always the full 343980 samples (a short one costs the same — AUDIO.md §2.1)',
      chunkPlan(0, p).inputEnd - chunkPlan(0, p).inputStart === SEGMENT &&
      chunkPlan(99, p).inputEnd - chunkPlan(99, p).inputStart === SEGMENT);
    ok('startup zero-pads: chunk 0 looks back before frame 0',
      chunkPlan(0, p).inputStart < 0, `${(chunkPlan(0, p).inputStart / SR).toFixed(2)} s of silence as left context`);
    const firstReal = Math.ceil(SEGMENT / p.H) - 1;
    ok(`the window is fully real audio from chunk ${firstReal} on (${(SEGMENT / SR).toFixed(2)} s)`,
      chunkPlan(firstReal, p).inputStart >= 0 && chunkPlan(firstReal - 1, p).inputStart < 0);
    ok('primedPct ramps 0 -> 1 over one segment',
      primedPct(0) === 0 && Math.abs(primedPct(SEGMENT / 2) - 0.5) < 1e-9 && primedPct(SEGMENT * 2) === 1);
    ok('latency is hop + xfade + T_inf, no lookahead term',
      p.L - p.srcOffset - p.H === p.X, `hop ${(p.H / SR).toFixed(2)}s + xfade ${(p.X / SR).toFixed(3)}s`);
  }

  head('live — crossfade laws');
  {
    const n = makeLivePlan(1.95).X;
    const ep = makeFades(n, 'equalPower');
    let worstP = 0;
    for (let i = 0; i < n; i++) worstP = Math.max(worstP, Math.abs(ep.fi[i] * ep.fi[i] + ep.fo[i] * ep.fo[i] - 1));
    ok('equal-power crossfade sums to unity POWER across the join', worstP < 1e-6,
      `max |fi²+fo²-1| = ${worstP.toExponential(2)}`);

    const li = makeFades(n, 'linear');
    let worstA = 0, coherentEP = 0;
    for (let i = 0; i < n; i++) {
      worstA = Math.max(worstA, Math.abs(li.fi[i] + li.fo[i] - 1));
      coherentEP = Math.max(coherentEP, ep.fi[i] + ep.fo[i]);
    }
    ok('linear crossfade sums to unity AMPLITUDE across the join', worstA < 1e-6,
      `max |fi+fo-1| = ${worstA.toExponential(2)}`);
    // The two chunks at a join are two estimates of the SAME audio (corr ~0.99,
    // FINDINGS §5) — coherent, so they add in amplitude, not in power.
    ok('equal-power on coherent material puts a level bump in every join',
      Math.abs(20 * Math.log10(coherentEP) - 3.01) < 0.05,
      `+${(20 * Math.log10(coherentEP)).toFixed(2)} dB at the midpoint — this is why the default law is 'linear'`);
    ok('the shipped default is the coherent-correct law', SEAM_XFADE_LAW === 'linear', SEAM_XFADE_LAW);
    ok('fades are half-sample centred (no step at either end)',
      li.fo[n - 1] < 1 / n && li.fi[0] < 1 / n && li.fi[0] > 0);
  }

  head('live — identity model reconstructs the input exactly through the joins');
  // AUDIO.md §2.6: "the strongest test available" — replace the model with the
  // identity and require the pipeline to return its input. Isolates the DSP from
  // the model completely, and is exactly the test that fails on a butt splice.
  for (const law of ['linear', 'equalPower']) {
    for (const hop of [1.0, 1.95, 3.9]) {
      const p = makeLivePlan(hop);
      const em = new LiveEmitter(p, law);
      const nChunks = 8;
      const total = chunkPlan(nChunks - 1, p).emitTo;
      const x = noise(total + SEGMENT, 21);
      const out = new Float32Array(total);
      const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT));
      const zero = new Float32Array(p.H);
      for (let k = 0; k < nChunks; k++) {
        const c = chunkPlan(k, p);
        // the "model" is the identity: hand back exactly the window it was given
        for (let q = 0; q < STEM_PLANES; q++) {
          for (let i = 0; i < SEGMENT; i++) {
            const t = c.inputStart + i;
            src[q][i] = t < 0 ? 0 : x[t];
          }
        }
        const e = em.chunk(k, src, zero, zero);
        out.set(e.planes[0].subarray(0, e.len), e.from);
      }
      const db = residualDb(out, x.subarray(0, total));
      if (law === 'linear') {
        ok(`linear, hop ${hop}s: identity residual ${db === -Infinity ? '-inf' : db.toFixed(1)} dB (gate < -120)`, db < -120);
      } else {
        ok(`equalPower, hop ${hop}s: identity residual ${db.toFixed(1)} dB — the join bump, measured`, db > -60,
          'recorded so the choice of law is a number, not an opinion');
      }
    }
  }

  head('live — all twelve stem planes are sample-aligned (Δ must be 0, AUDIO.md §8.1)');
  {
    const p = makeLivePlan(1.95);
    const em = new LiveEmitter(p, 'linear');
    const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT));
    const zero = new Float32Array(p.H);
    const hitAt = [];
    for (let k = 0; k < 4; k++) {
      const c = chunkPlan(k, p);
      // one impulse per plane, at the SAME absolute frame, with a per-plane
      // amplitude so a swapped plane is also caught
      const impulseAbs = c.emitFrom + (k === 0 ? 1000 : p.X + 1000);
      for (let q = 0; q < STEM_PLANES; q++) {
        src[q].fill(0);
        src[q][impulseAbs - c.inputStart] = q + 1;
      }
      const e = em.chunk(k, src, zero, zero);
      const at = [];
      for (let q = 0; q < STEM_PLANES; q++) {
        let idx = -1, amp = 0;
        for (let i = 0; i < e.len; i++) if (Math.abs(e.planes[q][i]) > 1e-6) { idx = i; amp = e.planes[q][i]; break; }
        at.push({ idx: idx + e.from, amp });
      }
      hitAt.push(at);
      const aligned = at.every((v) => v.idx === at[0].idx && v.idx === impulseAbs);
      const ordered = at.every((v, q) => Math.abs(v.amp - (q + 1)) < 1e-6);
      ok(`chunk ${k}: Δ = ${Math.max(...at.map((v) => v.idx)) - Math.min(...at.map((v) => v.idx))} across all ${STEM_PLANES} planes, no plane swap`,
        aligned && ordered, `at absolute ${at[0].idx}`);
    }
    ok('a 4-sample skew would comb at 5.5 kHz — this is why it is asserted, not eyeballed',
      hitAt.length === 4);
    // FAIL WHEN IT CANNOT LOOK: the loop above is `for q < STEM_PLANES`, so an
    // emitter that published only the old eight planes would have passed every
    // row of it by never being asked about guitar or piano. Pin the width.
    ok('...and the alignment was checked across TWELVE planes, not the old eight',
      STEM_PLANES === STEMS.length * 2 && STEM_PLANES === 12 &&
      hitAt.every((at) => at.length === STEM_PLANES),
      `${STEM_PLANES} planes x ${hitAt.length} chunks`);
  }

  head('live — backpressure: a skipped chunk becomes passthrough, never silence');
  {
    const p = makeLivePlan(1.95);
    const em = new LiveEmitter(p, 'linear');
    const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT).fill(0.5));
    const mix = new Float32Array(p.H).fill(0.25);
    em.chunk(0, src, mix, mix);
    const g = em.gap(p.H, mix, mix);
    // Every L plane the listener could be hearing: the six stem Ls plus the
    // passthrough L. Spelled from STEMS so it cannot go on summing four.
    const audibleL = [...STEMS.map((_, k) => planeL(k)), PASS_PLANE_L];
    let silent = 0;
    for (let i = 0; i < g.len; i++) {
      let sum = 0;
      for (const q of audibleL) sum += g.planes[q][i];
      if (Math.abs(sum) < 1e-9) silent++;
    }
    ok('a skipped span carries the original mix on the passthrough plane, not silence',
      silent === 0 && Math.abs(g.planes[PASS_PLANE_L][g.len - 1] - 0.25) < 1e-6,
      `${silent} silent frames of ${g.len}, summed over ${audibleL.length} L planes`);
    ok('the stems fade out and the passthrough fades in over exactly one crossfade',
      Math.abs(g.planes[PASS_PLANE_L][0] - 0.25 * (0.5 / p.X)) < 1e-4 && g.planes[0][p.X] === 0,
      'linear (the mix and Σstems are the same signal, so they add coherently)');
    /**
     * THE ASSERTION THAT CATCHES THE PASSTHROUGH STAYING AT 8/9, and it is the
     * reason this one is worth its own line rather than being folded into the
     * span sum above. Planes 8-11 are guitar.L/R and piano.L/R now; they were
     * `pass.L/pass.R` at four stems. An emitter that still writes the
     * unseparated mix at 8/9 publishes a span that sums correctly, plays at the
     * right level, and quietly routes the whole mix through the GUITAR fader —
     * so the user's guitar kill deletes the passthrough and their guitar
     * control rides the whole track. Every other assertion in this block passes
     * on that build. (Folded in from TRACK A's isolation suite, which had no
     * permanent home.)
     */
    const steady = g.len - 1;                  // past the entry crossfade
    const newStemPlanes = [planeL(S_IDX.guitar), planeR(S_IDX.guitar),
                           planeL(S_IDX.piano), planeR(S_IDX.piano)];
    ok('gap(): guitar and piano (planes 8-11) are SILENT — the mix went to 12/13, not onto a stem',
      newStemPlanes.every((q) => g.planes[q][steady] === 0),
      `[${newStemPlanes.join(',')}] = ${newStemPlanes.map((q) => g.planes[q][steady]).join(' ')}`);
    ok('gap(): every one of the twelve stem planes is silent in the steady part of the span',
      Array.from({ length: STEM_PLANES }, (_, q) => g.planes[q][steady]).every((v) => v === 0));
    ok('gap(): the unseparated mix is on 12/13, and those are the planes shared/stemring.js calls pass.L/pass.R',
      Math.abs(g.planes[PASS_PLANE_L][steady] - 0.25) < 1e-6 &&
      Math.abs(g.planes[PASS_PLANE_R][steady] - 0.25) < 1e-6 &&
      PASS_PLANE_L === PLANES.indexOf('pass.L') && PASS_PLANE_R === PLANES.indexOf('pass.R') &&
      PASS_PLANE_L === 12,
      `${PASS_PLANE_L}/${PASS_PLANE_R} vs stemring ${PLANES.indexOf('pass.L')}/${PLANES.indexOf('pass.R')}`);
    const back = em.chunk(2, src, mix, mix);
    ok('the next real chunk fades the stems back in and the passthrough out',
      Math.abs(back.planes[0][0]) < 0.5 && Math.abs(back.planes[0][p.X] - 0.5) < 1e-6 &&
      back.planes[PASS_PLANE_L][p.X] === 0 && back.planes[PASS_PLANE_L][0] > 0);
    ok('no gap and no overlap across the skip',
      em.commit === chunkPlan(2, p).emitTo, `commit ${em.commit}`);
  }

  head('live — stem ring accounting under a slow producer');
  if (typeof SharedArrayBuffer !== 'function') {
    ok('SharedArrayBuffer available', false, 'not in this node build');
  } else {
    const CAP = 1 << 13;
    const w = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(CAP)), CAP);
    ok('fourteen planes, one write pointer — alignment is structural',
      PLANES.length === RING_PLANES && RING_PLANES === STEMS.length * 2 + 2 && RING_PLANES === 14,
      `${PLANES.length} named, ${RING_PLANES} derived`);
    ok('header is 128 bytes / 32 Int32 slots, matching playback-processor.js',
      STEM_RING_HEADER_BYTES === 128);

    const blk = Array.from({ length: RING_PLANES }, (_, q) => new Float32Array(1000).fill(q + 1));
    // consumer is the playback worklet: it only ever advances H_READ
    const consume = (n) => { Atomics.store(w.hdr, H_READ, w.readFrames() + n); };
    let written = 0, refused = 0;
    for (let i = 0; i < 40; i++) {
      if (w.write(written, blk, 1000)) written += 1000; else refused++;
      if (i % 2 === 0) consume(1000);        // consumer drains at half the rate
    }
    ok('an overrun is refused and counted, never a torn write',
      refused > 0 && w.overruns === refused && w.cushion() <= CAP,
      `${refused} refused, cushion ${w.cushion()}/${CAP}`);
    ok('write() rejects a non-contiguous span (the alignment guard)',
      (() => { try { w.write(written + 1, blk, 10); return false; } catch { return true; } })());
    /**
     * ...and it rejects a SHORT PLANE ARRAY, which is the six-stem widening
     * arriving half-done. A ten-plane write from a caller that was not updated
     * leaves guitar.L/R and piano.L/R holding whatever the previous lap wrote —
     * stale audio, correct pointers, nothing to say so. Refusal is the only
     * behaviour that surfaces it. (Folded in from TRACK A's isolation suite.)
     */
    let shortWrite = '';
    try { w.write(w.writeFrames(), blk.slice(0, 10), 10); } catch (e) { shortWrite = e.message; }
    ok('write() REFUSES a 10-plane write rather than leaving guitar/piano stale',
      new RegExp(`expected ${RING_PLANES} planes, got 10`).test(shortWrite),
      shortWrite || '(did not throw)');
    ok('the ring never reports a negative cushion', w.cushion() >= 0);
    ok('play flag defaults to hold-silence until the cushion is primed',
      (() => { const w2 = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(1024)), 1024);
               const before = w2.playing(); w2.play(true); return before === false && w2.playing() === true; })());
    ok('reset() re-zeroes both pointers and the play flag',
      (() => { w.reset(); return w.writeFrames() === 0 && w.readFrames() === 0 &&
               Atomics.load(w.hdr, H_PLAY) === 0; })());
  }

  head('live — the backpressure ladder against a simulated clock');
  // RENDERING ONLY for the loop; the DECISION is the real skipFrames.
  // Reached by: run-ext.mjs DEV_FORCE_DROP and the hop-1.0 soak.
  /**
   * Drives the real decision function (engine/live.js::skipFrames) and the real
   * schedule arithmetic through a virtual sample clock, with inference times
   * drawn from a reproducible distribution. This is the check the browser soak
   * cannot give us: the browser only exercises whatever T_inf the GPU happened
   * to produce on the day, and the interesting cases are the ones where it is
   * slow.
   *
   * The invariant, from docs/ARCHITECTURE.md §3.8: the playback worklet never
   * runs dry, and a chunk we cannot deliver becomes unseparated audio — never
   * silence, never an ever-growing latency.
   */
  function simulate({ hop, inferMs, jitterMs, seconds, seed = 5 }) {
    const p = makeLivePlan(hop);
    const Q = 128, TICK = 4096;
    const lowWater = Math.round(LIVE_LOW_WATER_SEC * SR);
    let rnd = seed >>> 0;
    const tinf = () => {
      rnd = (rnd * 1664525 + 1013904223) >>> 0;
      return Math.round(((inferMs + (rnd / 4294967296 * 2 - 1) * jitterMs) / 1000) * SR);
    };
    let k = 0, commit = 0, write = 0, read = 0, drops = 0, underruns = 0, playing = false;
    let armAt = -1, inFlight = null, minCushion = Infinity, maxLatency = 0, discarded = 0;
    const emitted = new Map();                 // span start -> length, for the coverage check

    const publish = (from, len) => {
      if (from !== commit) throw new Error(`non-contiguous publish at ${from}, expected ${commit}`);
      if (from < write) throw new Error('rewrote frames the consumer may have read');
      emitted.set(from, len);
      commit += len; write += len;
    };
    const pump = (t) => {
      for (;;) {
        const n = skipFrames({ cap: t, commit, plan: p, k, playing, cushion: write - read, lowWater });
        if (n === 0) break;
        publish(commit, n); k++; drops++;
        // mirrors LivePipeline.fill(): a passthrough span can arm playback too,
        // otherwise a pipeline that is overloaded from the first chunk never starts
        if (armAt < 0) armAt = t + p.X + Math.round(LIVE_CUSHION_SEC * SR);
      }
      if (inFlight) return;
      const c = chunkPlan(k, p);
      if (t < c.inputEnd) return;
      inFlight = { c, doneAt: t + tinf() };
    };

    for (let t = 0; t < seconds * SR; t += Q) {
      if (inFlight && t >= inFlight.doneAt) {
        const c = inFlight.c;
        inFlight = null;
        k = Math.max(k, c.k + 1);
        if (c.emitTo <= commit) discarded++;                 // the ladder beat it to the span
        else { publish(c.emitFrom, c.emitLen); if (c.k === 0) armAt = t + p.X + Math.round(LIVE_CUSHION_SEC * SR); }
        pump(t);
      }
      if (!playing && armAt >= 0 && t >= armAt) playing = true;
      if (playing) {
        if (write - read < Q) { underruns++; }
        else { read += Q; minCushion = Math.min(minCushion, write - read); maxLatency = Math.max(maxLatency, t - read); }
      }
      if (t % TICK === 0) pump(t);
    }
    // coverage: every published frame exactly once, no gaps
    let cursor = 0, gaps = 0;
    for (const from of [...emitted.keys()].sort((a, b) => a - b)) {
      if (from !== cursor) gaps++;
      cursor = from + emitted.get(from);
    }
    return { p, drops, discarded, underruns, gaps, commit, cursor,
             minCushionSec: minCushion / SR, maxLatencySec: maxLatency / SR,
             rtf: inferMs / 1000 / hop };
  }

  for (const c of [
    { hop: 1.95, inferMs: 875, jitterMs: 120, label: 'hop 1.95 s, T_inf 875±120 ms (the measured M2 Max case)' },
    { hop: 1.00, inferMs: 810, jitterMs: 280, label: 'hop 1.00 s, T_inf 810±280 ms — marginal, RTF 0.81' },
    { hop: 3.90, inferMs: 900, jitterMs: 200, label: 'hop 3.90 s, T_inf 900±200 ms — lots of margin' },
  ]) {
    const r = simulate({ ...c, seconds: 180 });
    ok(`${c.label}: 0 underruns, output contiguous`,
      r.underruns === 0 && r.gaps === 0 && r.cursor === r.commit,
      `drops ${r.drops} · min cushion ${r.minCushionSec.toFixed(3)} s · latency ${r.maxLatencySec.toFixed(2)} s`);
  }
  {
    // Overload: inference cannot keep up at all. The ladder must convert that
    // into passthrough, hold the latency flat, and STILL never starve.
    const r = simulate({ hop: 1.0, inferMs: 1500, jitterMs: 100, seconds: 180 });
    ok('overload (RTF 1.5): drops happen, latency stays bounded, still 0 underruns and no gaps',
      r.drops > 0 && r.underruns === 0 && r.gaps === 0 && r.maxLatencySec < 3,
      `${r.drops} chunks -> passthrough, ${r.discarded} discarded in flight, latency ${r.maxLatencySec.toFixed(2)} s, min cushion ${r.minCushionSec.toFixed(3)} s`);
    const r2 = simulate({ hop: 1.0, inferMs: 4000, jitterMs: 100, seconds: 180 });
    ok('catastrophic overload (RTF 4.0): degrades to mostly-passthrough, never to silence',
      r2.underruns === 0 && r2.gaps === 0 && r2.drops > 100 && r2.maxLatencySec < 3,
      `${r2.drops} of ~180 chunks -> passthrough, latency ${r2.maxLatencySec.toFixed(2)} s`);
  }
  {
    // The `starving` trigger specifically: with only the `behind` trigger the
    // measured hop-1.0 case underran on real hardware (22 ms of silence in 35 s).
    const withStarve = simulate({ hop: 1.0, inferMs: 950, jitterMs: 90, seconds: 180 });
    ok('the cushion trigger is what saves the marginal case (RTF 0.95)',
      withStarve.underruns === 0 && withStarve.drops > 0,
      `${withStarve.drops} passthrough spans, min cushion ${withStarve.minCushionSec.toFixed(3)} s`);
  }

  head('live — a stop during inference must not poison the pipeline');
  if (typeof SharedArrayBuffer !== 'function' || typeof structuredClone !== 'function') {
    ok('SharedArrayBuffer + structuredClone available', false, 'not in this node build');
  } else {
    /**
     * The model buffers are TRANSFERRED to the inference worker, so they are
     * detached on this side the moment `infer` is called. A `LIVE_STOP` that
     * landed between the await and the reclaim used to leave them detached for
     * the life of the pipeline: every later session threw "Cannot perform
     * Construct on a detached ArrayBuffer" on the first line of runChunk, once
     * per capture tick, forever. The run was 100 % silent and reported drops
     * rather than an outage. This drives the real LivePipeline against a fake
     * worker that detaches exactly the way postMessage does.
     */
    const { LivePipeline } = await import('./extension/offscreen/live.js');
    const { StemRingWriter, stemRingByteLength } = await import('./extension/shared/stemring.js');
    const { STEM_RING_FRAMES } = await import('./extension/shared/config.js');

    const CAP = 1 << 17;
    const capSab = new SharedArrayBuffer(ringByteLength(CAP));
    const capRing = new RingConsumer(capSab, CAP);
    const sent = [];
    let detachOnly = false;
    let demoteNext = false;

    const mount = () => {
      let lp;
      lp = new LivePipeline({
        ctx: () => null, ring: () => capRing,
        infer: async (mixBuf, outBuf) => {
          /**
           * THE DEMOTION PATH RETURNS BEFORE ANY TRANSFER, and that ordering is
           * the whole of the invariant `Deck.infer` states. `gpu.run()` decides
           * before it ever calls `fn`, and `fn` is what holds the postMessage.
           * A fake that transferred here and then returned `{demoted:true}`
           * would be modelling a backend that broke the contract — which is
           * exactly the mutation the assertions below are watched red with.
           */
          if (demoteNext) return { demoted: true, why: 'L3 said this chunk cannot land in time' };
          // exactly postMessage-with-transferables: the originals detach here
          const mix = structuredClone(mixBuf, { transfer: [mixBuf] });
          const stems = structuredClone(outBuf, { transfer: [outBuf] });
          await Promise.resolve();
          if (detachOnly) throw new Error('worker died holding the buffers');
          return { mix, stems, prepMs: 0, inferMs: 0, postMs: 0 };
        },
        ensureModel: async () => {}, send: (m) => sent.push(m), log: () => {},
        // See the CachedDeck stub in the `cache` group below: the deps bundle
        // `offscreen/deck.js` hands a LivePipeline now carries the Host's asset
        // resolver too.
        assetUrl: (relPath) => `stub://unit/${relPath}`,
        // Mode 3: the master bus is SHARED, so the deck borrows it. The stub
        // returns whatever `lp.probeBuf`/`lp.probe` were mocked with, which is
        // what the watchdog tests drive.
        master: () => ({
          busPeak: () => {
            if (!lp || !lp.probe) return null;
            lp.probe.getFloatTimeDomainData(lp.probeBuf);
            let p = 0;
            for (let i = 0; i < lp.probeBuf.length; i++) { const a = Math.abs(lp.probeBuf[i]); if (a > p) p = a; }
            return p;
          },
          probeState: () => ({ built: true }),
          probeTerminal: () => ({ terminalIsDestination: true, why: 'edge present' }),
          input: () => null,
          pre: null, shaper: null, post: null, probe: null,
        }),
      });
      lp.plan = makeLivePlan(1.95);
      lp.emitter = new LiveEmitter(lp.plan, 'linear');
      lp.passL = new Float32Array(lp.plan.H);
      lp.passR = new Float32Array(lp.plan.H);
      lp.lowWaterFrames = Math.round(LIVE_LOW_WATER_SEC * SR);
      lp.out = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(STEM_RING_FRAMES)), STEM_RING_FRAMES);
      lp.baseFrame = 0; lp.stopped = false; lp.status = 'running';
      return lp;
    };
    const quiesce = (lp) => { clearTimeout(lp.startTimer); clearInterval(lp.pushTimer); };

    {
      const lp = mount();
      // stop lands while the chunk is in flight — the exact poisoning sequence
      const realInfer = lp.d.infer;
      lp.d.infer = async (a, b) => { const r = await realInfer(a, b); lp.stopped = true; return r; };
      /**
       * `inFlight` IS SET THE WAY `pump()` SETS IT, and the two assertions below
       * that read it are why. `runChunk` never raises the flag — `pump()` does,
       * one line before it calls in (`live.js:863`) — so a suite that calls
       * `runChunk` directly and then asserts `inFlight === false` is reading a
       * field that was never true: it would pass on a build that had stopped
       * clearing it at all, which is AGENTS.md's "passes because a value was
       * never recorded". Raised here, the claim has something to observe.
       */
      lp.inFlight = true;
      await lp.runChunk(chunkPlan(0, lp.plan));
      quiesce(lp);
      // The model output buffer is STEMS.length x 2ch x SEGMENT floats: 16 511 040 B
      // at six stems, was 11 007 360 B at four. Derived, so a pipeline that
      // reallocated at the old width is a red here rather than a truncated stem.
      ok('a stop mid-inference reclaims both transferred buffers',
        lp.mixBuf.byteLength === 2 * SEGMENT * 4 && lp.outBuf.byteLength === STEMS.length * 2 * SEGMENT * 4,
        `mixBuf ${lp.mixBuf.byteLength} B, outBuf ${lp.outBuf.byteLength} B of ${STEMS.length * 2 * SEGMENT * 4} (0 = detached)`);
      ok('and clears inFlight, so a restart is not wedged', lp.inFlight === false);
      // the restart is what actually broke: prove it runs
      lp.stopped = false;
      let threw = null;
      try { await lp.runChunk(chunkPlan(1, lp.plan)); } catch (e) { threw = e; }
      quiesce(lp);
      ok('the next chunk after a mid-inference stop runs (this is the reported bug)',
        threw === null, threw ? String(threw.message) : 'ok');
    }

    {
      // a worker that dies holding the buffers must also leave us usable
      const lp = mount();
      detachOnly = true;
      let threw = null;
      try { await lp.runChunk(chunkPlan(0, lp.plan)); } catch (e) { threw = e; }
      detachOnly = false;
      quiesce(lp);
      ok('a rejected inference reallocates rather than leaving detached buffers',
        threw !== null && lp.mixBuf.byteLength === 2 * SEGMENT * 4 &&
        lp.outBuf.byteLength === STEMS.length * 2 * SEGMENT * 4,
        `threw "${threw && threw.message}", mixBuf ${lp.mixBuf.byteLength} B, outBuf ${lp.outBuf.byteLength} B`);
      let threw2 = null;
      try { await lp.runChunk(chunkPlan(0, lp.plan)); } catch (e) { threw2 = e; }
      quiesce(lp);
      ok('and the pipeline recovers on the next chunk', threw2 === null, threw2 ? String(threw2.message) : 'ok');
    }

    {
      /**
       * A DEMOTED CHUNK TRANSFERS NOTHING — the other half of the zero-copy
       * contract, and until S6 it had no direct assertion anywhere.
       *
       * `deck.js`: "When demoted, mixBuf/outBuf are NEVER transferred, so the
       * caller still owns them. That invariant is load-bearing — see
       * LivePipeline.runChunk."  `live.js`, at the other end of the same fact:
       * "NOTHING WAS TRANSFERRED — the scheduler returns before postMessage — so
       * mixBuf/outBuf are still attached and must NOT be reallocated or
       * reclaimed."
       *
       * WHAT USED TO COVER IT AND WHY THAT WAS NOT ENOUGH. The `sched` group
       * asserts `ran === false` on the SCHEDULER, which is the mechanism — that
       * a demoted call never reaches `fn`. Nothing drove `runChunk` through a
       * demotion and then looked at the buffers, so the consequence — a deck
       * that goes permanently silent, once per capture tick, for ever — rested
       * on reading two comments and believing them. S6 moved the transfer into
       * `workers/workerbackend.js`, which is precisely the edit that could have
       * broken it silently.
       *
       * The assertions are byteLengths and a count. A detached ArrayBuffer reads
       * 0, so this cannot be satisfied by a pipeline that reallocated: the
       * REALLOCATED pair reads the same lengths, which is why the third
       * assertion (the next chunk runs) is here as well — a reallocation is only
       * distinguishable from a survival by what happens next.
       */
      const lp = mount();
      demoteNext = true;
      const mixBefore = lp.mixBuf;
      const outBefore = lp.outBuf;
      // Raised the way `pump()` raises it — see the note in the first block.
      // Without this the `inFlight` half of the third assertion below inspects a
      // field that was never set, and passes on a demotion that wedges the deck.
      lp.inFlight = true;
      let threw = null;
      try { await lp.runChunk(chunkPlan(0, lp.plan)); } catch (e) { threw = e; }
      demoteNext = false;
      quiesce(lp);
      ok('a DEMOTED chunk leaves both scratch buffers attached — nothing was transferred, so nothing may be reclaimed',
        threw === null && lp.mixBuf.byteLength === 2 * SEGMENT * 4
        && lp.outBuf.byteLength === STEMS.length * 2 * SEGMENT * 4,
        threw
          ? `runChunk threw on a demotion: ${threw.message} — a demotion is not an error and must not reach the CHUNK_FAILED ladder`
          : `mixBuf ${lp.mixBuf.byteLength} B, outBuf ${lp.outBuf.byteLength} B of ${STEMS.length * 2 * SEGMENT * 4} (0 = detached)`);
      ok('...and they are THE SAME buffers, not a fresh pair — the once-per-session allocation is what a demotion must not cost',
        lp.mixBuf === mixBefore && lp.outBuf === outBefore,
        lp.mixBuf === mixBefore && lp.outBuf === outBefore
          ? '19.4 MB kept, 0 B allocated'
          : 'the pipeline reallocated on a path where nothing was transferred — 19.4 MB of garbage per demoted hop');
      /**
       * `inFlight` IS IN THE CONDITION, not only in the detail. `pump()` returns
       * early on `if (this.inFlight) return;`, and a demotion throws nothing —
       * so a demotion that left the flag set stops the deck for the rest of the
       * session with no CHUNK_FAILED, no ladder and no log: the same silent
       * stall this block exists to cover, one line above the counter. It was
       * printed here and not asserted, and deleting `this.inFlight = false` from
       * live.js's demotion branch left `node test.js live` at 186 passed.
       */
      ok('...and the demotion is counted rather than thrown, and clears inFlight, so the ladder never sees it and pump() is not wedged',
        lp.demotions === 1 && lp.inFlight === false,
        `${lp.demotions} demotion(s), inFlight ${lp.inFlight}`);
      // A demotion does not advance `k` — the chunk was never separated — so the
      // realistic next call is the SAME chunk, which is also the one that reads
      // `new Float32Array(this.mixBuf)` on its first line.
      let threw2 = null;
      try { await lp.runChunk(chunkPlan(0, lp.plan)); } catch (e) { threw2 = e; }
      quiesce(lp);
      ok('...and the NEXT chunk still runs — this is what a transfer on the demotion path costs, once per capture tick for ever',
        threw2 === null, threw2 ? String(threw2.message) : 'ok');
    }

    head('live — a silenced passthrough span is still COUNTED (QA-15 requirement 2)');
    {
      const lp = mount();
      // fill the capture ring so the ladder has history to publish
      const hdr = new Int32Array(capSab, 0, 16);
      const pl = new Float32Array(capSab, 64, CAP), pr = new Float32Array(capSab, 64 + CAP * 4, CAP);
      for (let i = 0; i < CAP; i++) { pl[i] = 0.5; pr[i] = -0.5; }
      Atomics.store(hdr, 0, CAP);
      const sentGains = [];
      lp.node = { port: { postMessage: (m) => sentGains.push(m) } };
      lp.mix = STEMS.map(() => ({ gainDb: 0, muted: true, soloed: false }));
      lp.pushGains(0.003);
      const passMsg = sentGains.find((m) => m.i === G_PASS);
      // The slot map moved 4/5 -> 6/7 with the two new stems. A build that still
      // wrote the passthrough at slot 4 would be writing it onto GUITAR.
      ok(`pushGains writes every stem slot 0..${STEMS.length - 1} AND the passthrough slot ${G_PASS}`,
        STEMS.every((_, k) => sentGains.some((m) => m.i === k)) && !!passMsg,
        sentGains.map((m) => m.i).join(','));
      ok('and sends 0 for it when everything is killed', passMsg && passMsg.value === 0, `${passMsg && passMsg.value}`);
      ok(`slot ${G_PASS} is ramped like the rest — no click at the passthrough boundary`,
        passMsg && passMsg.tau === 0.003, `tau ${passMsg && passMsg.tau}`);
      const before = lp.drops;
      const fired = lp.forceDrop();
      quiesce(lp);
      ok('a passthrough span the user will hear as SILENCE still increments drops',
        fired && lp.drops === before + 1,
        `drops ${before} -> ${lp.drops}; silence the user did not ask for must never be invisible`);
      // QA-17 class: values the console would otherwise have to infer
      ok('the span is recorded so `passthroughNow` is a fact, not a guess',
        lp.passSpans.length === 1 && lp.passSpans[0].to > lp.passSpans[0].from,
        JSON.stringify(lp.passSpans[0]));
      lp.out.play(true);
      Atomics.store(lp.out.hdr, 1, lp.passSpans[0].from + 10);
      ok('passthroughNow is true while the playhead is inside a skipped span', lp.passthroughNow());
      Atomics.store(lp.out.hdr, 1, lp.passSpans[0].to + 10);
      ok('and false once past it', !lp.passthroughNow());
      lp.out.play(false);
    }

    head('live — the output watchdog: "green and silent" has to be self-reporting');
    {
      /**
       * Three times this project has shipped a build that was 100 % green and
       * 100 % silent, because every gate reads the SAB ring or the playback
       * worklet and both sit UPSTREAM of the break. watchOutput() is the engine
       * noticing on its own. It is also the exact kind of detector that quietly
       * stops working, so it is pinned in both directions: it must fire on the
       * two failures it is for, and it must stay silent on a healthy deck, on a
       * deliberately killed one, and on a deck that is not playing at all.
       */
      const alarms = (lp) => sent.filter((m) => m.type === 'LIVE_ERROR' &&
        (m.code === 'OUTPUT_STALLED' || m.code === 'OUTPUT_SILENT'));
      /**
       * `stemPeak` was NOT a parameter here at four stems: the frame spelled the
       * four names with every stem at 0 and only `master` varying. That is now
       * two separate problems. `outputTick` reads a frame that is short a stem as
       * `blind`, so a four-name frame makes the THIRD arm fire on cases named
       * "a healthy deck raises nothing" — and because `alarms()` filters to
       * STALLED/SILENT, it would fire invisibly. And an all-zero stem row is not
       * what "healthy" means anyway. So the frame is built from STEMS and the
       * stem row is set explicitly per case.
       */
      const mountWatch = ({ busPeak, masterPeak, stemPeak = 0, healthAgeMs, playing = true }) => {
        sent.length = 0;
        const lp = mount();
        lp.out.play(playing);
        lp.probe = { getFloatTimeDomainData: (a) => { a.fill(0); a[3] = busPeak; } };
        lp.probeBuf = new Float32Array(2048);
        const peak = { master: masterPeak };
        for (const s of STEMS) peak[s] = stemPeak;
        lp.lastMeters = { peak, rms: {}, clip: false };
        lp.lastHealthAt = performance.now() - healthAgeMs;
        return lp;
      };
      /** every LIVE_ERROR, so a third-arm alarm cannot hide behind the filter above */
      const anyAlarm = () => sent.filter((m) => m.type === 'LIVE_ERROR').map((m) => m.code);

      {
        // the audio render thread stopped being pulled at all
        const lp = mountWatch({ busPeak: 0.4, masterPeak: 0.4, healthAgeMs: 3000 });
        lp.watchOutput();
        quiesce(lp);
        const a = alarms(lp);
        ok('no `health` from the worklet for 2 s raises OUTPUT_STALLED',
          a.length === 1 && a[0].code === 'OUTPUT_STALLED', a.map((x) => x.code).join(',') || 'nothing');
        ok('and it names the context state, so the paste is actionable',
          a.length === 1 && /Context state/.test(a[0].message), a[0] && a[0].message.slice(0, 60));
        const n = sent.length;
        lp.watchOutput(); lp.watchOutput();
        quiesce(lp);
        ok('the alarm is latched — one message, not one per health tick', sent.length === n);
      }
      {
        // the mixer is summing signal but nothing survives to the last node
        const lp = mountWatch({ busPeak: 0, masterPeak: 0.5, stemPeak: 0.3, healthAgeMs: 0 });
        for (let i = 0; i < HEALTH_HZ - 1; i++) lp.watchOutput();
        quiesce(lp);
        ok('one second of disagreement is required before crying wolf', alarms(lp).length === 0,
          `${lp.silentTicks} ticks so far`);
        lp.watchOutput();
        quiesce(lp);
        const a = alarms(lp);
        ok('a bus at digital zero while the meters show signal raises OUTPUT_SILENT',
          a.length === 1 && a[0].code === 'OUTPUT_SILENT', a.map((x) => x.code).join(',') || 'nothing');
      }
      {
        // A killed deck is silent ON PURPOSE. The meters are post-fader, so they
        // read 0 too — which is precisely why the test is meters-vs-bus and not
        // bus-vs-zero. Firing here would put a red banner on every panic button.
        const lp = mountWatch({ busPeak: 0, masterPeak: 0, healthAgeMs: 0 });
        for (let i = 0; i < 3 * HEALTH_HZ; i++) lp.watchOutput();
        quiesce(lp);
        ok('a deliberately killed deck does NOT raise OUTPUT_SILENT', alarms(lp).length === 0,
          alarms(lp).map((x) => x.code).join(','));
      }
      {
        // A healthy deck has signal ON ITS STEMS, not just on master. Asserted
        // against EVERY LIVE_ERROR rather than the two filtered codes: the third
        // arm (OUTPUT_DEAD) reads a short or all-zero stem row as blind/dead, so
        // the filter would have hidden exactly the regression this row is for.
        const lp = mountWatch({ busPeak: 0.4, masterPeak: 0.4, stemPeak: 0.3, healthAgeMs: 0 });
        for (let i = 0; i < 3 * HEALTH_HZ; i++) lp.watchOutput();
        quiesce(lp);
        ok('a healthy deck raises nothing at all — not STALLED, not SILENT, not DEAD',
          anyAlarm().length === 0, anyAlarm().join(',') || 'nothing');
      }
      {
        // Before playback arms there is no output to be missing, and the worklet
        // has not started posting health either. Both detectors must hold off.
        const lp = mountWatch({ busPeak: 0, masterPeak: 0.5, healthAgeMs: 9000, playing: false });
        for (let i = 0; i < 3 * HEALTH_HZ; i++) lp.watchOutput();
        quiesce(lp);
        ok('a deck that has not armed yet raises nothing', alarms(lp).length === 0,
          alarms(lp).map((x) => x.code).join(','));
      }
    }

    head('live — the wire payloads are constructible (cheap guard, expensive to find in a browser)');
    {
      /**
       * Both of these are built from ~20 fields each and go out over
       * chrome.runtime, which is JSON-serialised. A stale identifier in either
       * throws inside the handler, the message never arrives, and the symptom is
       * a Playwright timeout six minutes into an e2e run with no stack. Ask for
       * them here instead, in 3 ms. (This exists because `rtfMarginal:
       * RTF_MARGINAL` outlived the constant it referenced.)
       */
      const lp = mount();
      lp.plan = makeLivePlan(1.95);
      lp.chunkMs = [800, 810, 820];
      let st = null, threw = null;
      try { st = lp.stats(); } catch (e) { threw = e; }
      ok('stats() is constructible', threw === null, threw ? String(threw.message) : '');
      ok('and JSON round-trips (it crosses chrome.runtime)',
        st !== null && JSON.parse(JSON.stringify(st)).hopSeconds === 1.95);

      sent.length = 0;
      let threw2 = null;
      try { lp.pushState(true); } catch (e) { threw2 = e; }
      quiesce(lp);
      ok('pushState() is constructible', threw2 === null, threw2 ? String(threw2.message) : '');
      const msg = sent.find((m) => m.type === 'LIVE_STATE');
      const CONTRACT = ['status', 'phase', 'hopSec', 'pendingHopSec', 'latencySec', 'passthroughNow',
        'bufferMinSec', 'bufferSec', 'floorSec', 'targetSec', 'rtf', 'drops',
        'underruns', 'overruns', 'staleReads', 'primedPct'];
      ok('LIVE_STATE carries every field the console contract promises',
        msg && CONTRACT.every((k) => k in msg),
        msg ? `missing: ${CONTRACT.filter((k) => !(k in msg)).join(',') || 'none'}` : 'no LIVE_STATE sent');
      ok('every LIVE_STATE value is JSON-safe (no undefined, no NaN)',
        msg && CONTRACT.every((k) => msg[k] === null || (typeof msg[k] !== 'undefined' && !Number.isNaN(msg[k]))),
        msg ? JSON.stringify(Object.fromEntries(CONTRACT.map((k) => [k, msg[k]]))) : '');
      ok('hopSec reports the RUNNING hop and pendingHopSec the requested one (QA-17)',
        msg && msg.hopSec === 1.95 && msg.pendingHopSec === LIVE_HOP_DEFAULT,
        msg ? `running ${msg.hopSec}, pending ${msg.pendingHopSec}` : '');
      // `priming` covers two completely different waits; the console must not
      // have to correlate two message streams to know which bar to draw.
      ok('phase is null unless priming', msg && msg.phase === null, `status ${msg && msg.status}`);
      // An idle deck must not report the LAST session's hop. REACHABLE: drives
      // the real stop().
      lp.status = 'running'; sent.length = 0;
      await lp.stop(); quiesce(lp);
      const idle = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
      ok('hopSec is null once the deck is idle (not the last session\'s hop)',
        idle && idle.hopSec === null && idle.status === 'idle',
        idle ? `hopSec ${idle.hopSec}, status ${idle.status}` : 'no LIVE_STATE on stop');
      ok('pendingHopSec survives a stop, so the next start is predictable',
        idle && idle.pendingHopSec === LIVE_HOP_DEFAULT, `${idle && idle.pendingHopSec}`);
      ok('and pushState after stop does not throw on the null plan',
        (() => { try { lp.pushState(true); return true; } catch { return false; } })());
      lp.plan = makeLivePlan(1.95); lp.status = 'running';   // restore for later checks
      lp.status = 'priming'; lp.phase = 'model'; sent.length = 0; lp.pushState(true); quiesce(lp);
      ok("phase is 'model' while the weights are loading",
        sent.find((m) => m.type === 'LIVE_STATE').phase === 'model');
      lp.phase = 'ring'; sent.length = 0; lp.pushState(true); quiesce(lp);
      ok("phase is 'ring' once the model is up and the causal window is filling",
        sent.find((m) => m.type === 'LIVE_STATE').phase === 'ring');

      // ...and that start() actually SETS it. Rendering the field correctly is
      // worth nothing if nothing assigns it: the first cut of this shipped with
      // pushState() perfect and the two assignments missing, so `phase` was null
      // for the entire priming window and only the browser run caught it.
      const lp2 = mount();
      // stand in for build(), which needs an AudioWorklet
      lp2.build = async () => {};
      lp2.node = { port: { postMessage: () => {} } };
      const seen = [];
      lp2.d.ensureModel = async () => { seen.push(lp2.phase); };
      lp2.status = 'idle';
      sent.length = 0;
      await lp2.start();
      quiesce(lp2);
      ok("start() sets phase 'model' before it waits on the weights", seen[0] === 'model', `${seen[0]}`);
      ok("start() sets phase 'ring' before building the graph", lp2.phase === 'ring', `${lp2.phase}`);
      const primingMsgs = sent.filter((m) => m.type === 'LIVE_STATE' && m.status === 'priming');
      ok('and both priming phases actually reach the wire',
        primingMsgs.map((m) => m.phase).join(',') === 'model,ring',
        primingMsgs.map((m) => m.phase).join(',') || 'none');
    }

    /**
     * REACHABLE, and that is the whole reason this block exists rather than more
     * assertions inside `extension/engine/bpmtap.js`. That file proves the
     * DETECTOR — it builds its own StemRingWriter and drives the tap by hand.
     * Nothing in it can see whether `offscreen/live.js` ever calls `tick()`, hands
     * it THIS deck's ring, puts the payload on the wire, or resets it when the
     * track changes. Every assertion below drives the real `LivePipeline` through
     * `pushState()` and `start()` and reads what actually went out on `send`.
     *
     * The tempo tap has no browser-only dependency (it is main-thread arithmetic
     * over a SharedArrayBuffer), so this tier can carry the whole integration.
     */
    head('live — the tempo tap: driven by the heartbeat, on the wire, reset by the lifecycle');
    {
      const { BPM_TAP_PLANE_L, BPM_TAP_PLANE_R, BPM_MAX_BLOCKS_PER_TICK, beatPhaseAt } =
        await import('./extension/engine/bpmtap.js');
      const { KEY_ACCUM_HZ } = await import('./extension/shared/config.js');
      const BPM_ACCUM_HZ = 10;   // live.js's own constant; the assertions below bracket it

      // ---- a drum kit, not a tone. Same synthesis as bpmtap.js's suite.
      const kick = (buf, at, amp) => {
        const n = Math.round(0.12 * SR);
        for (let i = 0; i < n; i++) {
          const t = i / SR, j = at + i;
          if (j >= 0 && j < buf.length) buf[j] += amp * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.045);
        }
      };
      const clickTrain = (bpm, sec) => {
        const buf = new Float32Array(Math.round(sec * SR));
        const beat = 60 / bpm * SR;
        for (let b = 0; b * beat < buf.length; b++) kick(buf, Math.round(b * beat), 1.0);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / peak;
        return buf;
      };

      const HOP = Math.round(1.95 * SR);
      /**
       * Feed a real deck exactly as the pump does — one hop published into the
       * deck's OWN stem ring, then the heartbeat run across the 1.95 s it spends
       * on the next one — and return the last LIVE_STATE that actually went out.
       *
       * Rolling `bpmAt` back ONE PERIOD before each push is deliberate and is NOT
       * the thing under test: it opens the wall-clock gate so a synchronous burst
       * delivers the 20 blocks a real 1.95 s of wall time would. The gate itself
       * is bracketed separately below, by count, at its own entry point.
       *
       * IT IS `now - period`, NOT `0`, AND THAT COST A RED. `performance.now()`
       * in node is milliseconds since PROCESS START, so `bpmAt = 0` asks "is the
       * process older than 95 ms?" — and `node test.js live` reaches this block at
       * about 30 ms. Some pushes were refused, the estimate schedule shifted, and
       * the lock assertion went red on unmodified code; adding one `console.log`
       * above it made it pass. A harness that reads an absolute clock is measuring
       * the machine exactly as hard as a gate that does (AGENTS.md, "if a claim
       * can be carried by a COUNT, do not carry it with a stopwatch"). Relative to
       * `now`, the gate opens on every push whatever the uptime.
       *
       * `keyTap.tick` is stubbed out for cost only — 260 heartbeats x up to four
       * 16384-point FFTs is a second of CPU for a detector that has its own suite
       * and nothing to do with this claim.
       */
      const driveDeck = (pcm, planeL, planeR) => {
        const lp = mount();
        lp.keyTap.tick = () => 0;
        const planes = Array.from({ length: PLANES.length }, () => new Float32Array(HOP));
        sent.length = 0;
        for (let p = 0; p + HOP <= pcm.length; p += HOP) {
          // a plausible playhead, so write() never refuses as an overrun
          Atomics.store(lp.out.hdr, H_READ, Math.max(0, p - 4 * SR));
          for (let q = 0; q < PLANES.length; q++) planes[q].fill(0, 0, HOP);
          for (let i = 0; i < HOP; i++) { const v = pcm[p + i]; planes[planeL][i] = v; planes[planeR][i] = v; }
          lp.out.write(p, planes, HOP);
          for (let t = 0; t < 20; t++) { lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ; lp.pushState(true); }
        }
        quiesce(lp);
        return { lp, last: sent.filter((m) => m.type === 'LIVE_STATE').at(-1) };
      };

      // ================================================ the cadence, as a COUNT
      /**
       * THE ENTRY POINT IS `pushState()`, which is both the 10 Hz timer and the
       * half-dozen forced pushes. Carried by counts of `tick()` calls, never by a
       * stopwatch: AGENTS.md, "a gate whose verdict changes on code that did not
       * change is measuring the machine".
       *
       * The two rows BRACKET the rate rather than restate it. Roll the clock back
       * one whole period and the tap must be fed; roll it back HALF a period and
       * it must not. A tap given its own 20 Hz driver passes the first and fails
       * the second; a tap at 5 Hz fails the first. Both are run against the key
       * tap in the same loop, so "the same heartbeat as tickKey" is the compared
       * quantity and not an assumption.
       */
      {
        const lp = mount();
        let bpmTicks = 0, keyTicks = 0;
        lp.bpmTap.tick = () => { bpmTicks++; return 0; };
        lp.keyTap.tick = () => { keyTicks++; return 0; };
        const N = 20;

        // (a) a burst of forced pushes inside ONE gate window feeds each tap once.
        // `now - period`, never 0 — see driveDeck's note: `performance.now()` is
        // uptime here, so `0` asks a question about the process, not the gate.
        sent.length = 0;
        lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        lp.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
        const t0 = performance.now();
        for (let i = 0; i < N; i++) lp.pushState(true);
        const burstMs = performance.now() - t0;
        quiesce(lp);
        ok(`${N} forced pushState() calls inside one gate window feed the tempo tap ONCE — exactly like the key tap`,
          bpmTicks === 1 && keyTicks === 1,
          `bpm ${bpmTicks}, key ${keyTicks}; burst took ${burstMs.toFixed(2)} ms against a ` +
          `${(1000 / BPM_ACCUM_HZ - 5).toFixed(0)} ms gate (${(( 1000 / BPM_ACCUM_HZ - 5) / Math.max(burstMs, 1e-6)).toFixed(0)}x margin)`);

        // (b) one whole period later, each push feeds each tap again: N pushes, N blocks
        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
          lp.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
          lp.pushState(true);
        }
        quiesce(lp);
        ok('a full period after the last block the tap is fed again — 20 heartbeats, 20 blocks, on both taps',
          bpmTicks === N && keyTicks === N, `bpm ${bpmTicks}/${N}, key ${keyTicks}/${N}`);

        // (c) HALF a period is refused. This is the row a faster gate breaks.
        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ / 2;
          lp.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ / 2;
          lp.pushState(true);
        }
        quiesce(lp);
        ok('half a period after the last block it is refused — the tap is on the 10 Hz heartbeat and not on a driver of its own',
          bpmTicks === 0 && keyTicks === 0,
          `bpm ${bpmTicks}, key ${keyTicks} over ${N} pushes at ${(1000 / BPM_ACCUM_HZ / 2).toFixed(0)} ms spacing ` +
          `(a 20 Hz gate would let ${N} through here and still pass the row above)`);

        // ...and it stops with the deck, because pushState(true) does not.
        bpmTicks = 0;
        lp.status = 'idle';
        lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        lp.pushState(true);
        quiesce(lp);
        ok('an idle deck is not fed at all (pushState still runs — the tap must decline, not the heartbeat)',
          bpmTicks === 0, `${bpmTicks} blocks while idle`);
      }

      // ============================================ the payload, on a real ring
      const CONTRACT = ['state', 'bpm', 'confidence', 'beatFrame'];
      const TOL = 1.5;   // bpmtap.js's own tolerance: one 0.25 lag step at the fast end
      const a128 = driveDeck(clickTrain(128, 26), BPM_TAP_PLANE_L, BPM_TAP_PLANE_R);
      const b92 = driveDeck(clickTrain(92, 26), BPM_TAP_PLANE_L, BPM_TAP_PLANE_R);

      ok('LIVE_STATE carries `bpm`, and it is the four-field contract with a state the UI can switch on',
        !!a128.last && !!a128.last.bpm && CONTRACT.every((k) => k in a128.last.bpm) &&
        ['none', 'listening', 'locked', 'fault'].includes(a128.last.bpm.state),
        a128.last ? JSON.stringify(a128.last.bpm) : `no LIVE_STATE in ${sent.length} messages`);
      {
        // LIVE_STATE crosses chrome.runtime, which is JSON. `undefined` and NaN
        // both survive the assertion above and neither survives the wire.
        const round = a128.last ? JSON.parse(JSON.stringify(a128.last)) : null;
        ok('...and it JSON round-trips unchanged (no undefined, no NaN, no bigint)',
          !!round && JSON.stringify(round.bpm) === JSON.stringify(a128.last.bpm) &&
          CONTRACT.every((k) => round.bpm[k] === null || !Number.isNaN(round.bpm[k])),
          round ? JSON.stringify(round.bpm) : 'nothing to round-trip');
      }

      // THE HYPOTHESIS: the wire number comes from THIS deck's drums planes.
      ok('a 128 BPM drum stem locks, and the number reaches the wire',
        !!a128.last && a128.last.bpm.state === 'locked' &&
        Math.abs(a128.last.bpm.bpm - 128) <= TOL,
        a128.last ? `read ${a128.last.bpm.bpm} against 128.00, tol ±${TOL}, conf ${a128.last.bpm.confidence}` : 'no LIVE_STATE');
      /**
       * THE CONTROL, AND IT CAN LOSE. A `bpm` field wired to a constant, to a
       * stale echo, or to some other deck's tap passes the row above and fails
       * this one — the two decks are driven through identical code and differ
       * only in the audio published into their own rings.
       */
      ok('a second deck at 92 BPM reports 92, so the wire value tracks the deck\'s own ring and not the harness',
        !!b92.last && b92.last.bpm.state === 'locked' &&
        Math.abs(b92.last.bpm.bpm - 92) <= TOL &&
        Math.abs((a128.last.bpm.bpm - b92.last.bpm.bpm) - 36) <= 2 * TOL,
        b92.last ? `128 - 92 = 36.00 true, ${a128.last.bpm.bpm} - ${b92.last.bpm.bpm} = ${(a128.last.bpm.bpm - b92.last.bpm.bpm).toFixed(2)} read` : 'no LIVE_STATE');
      /**
       * THE TAP POINT, and this control can lose too. The identical stimulus on
       * `other` (planes 4/5, the KEY tap's planes) must produce no tempo at all.
       * A wiring that handed BpmTap the wrong ring, the passthrough planes, or a
       * mono mix would pass one of these two rows and fail the other; there is no
       * wiring that passes both except the right one.
       */
      {
        const wrong = driveDeck(clickTrain(128, 26), 4, 5);
        ok('the same drums published on the `other` planes produce NO tempo — the tap is on drums, on this deck\'s stem ring',
          !!wrong.last && wrong.last.bpm.state === 'none' && wrong.last.bpm.bpm === null &&
          wrong.lp.bpmTap.stats().audibleBlocks === 0 && wrong.lp.bpmTap.stats().blocks > 100,
          wrong.last ? `${JSON.stringify(wrong.last.bpm)} after ${wrong.lp.bpmTap.stats().blocks} blocks read, ${wrong.lp.bpmTap.stats().audibleBlocks} audible`
            : 'no LIVE_STATE');
      }
      // The consumer's only entry point into `beatFrame`, driven off the wire
      // value rather than off the tap, because the wire is what the UI gets.
      ok('beatPhaseAt() reads the wire payload straight: 0 on the beat, 0.5 half a beat later',
        (() => {
          const p = a128.last && a128.last.bpm;
          if (!p || p.beatFrame === null) return false;
          const period = 60 / p.bpm * SR;
          return beatPhaseAt(p, p.beatFrame, SR) === 0 &&
            Math.abs(beatPhaseAt(p, p.beatFrame + period / 2, SR) - 0.5) < 0.01;
        })(),
        a128.last ? `beatFrame ${a128.last.bpm.beatFrame}` : 'no payload');

      /**
       * THE PLAYHEAD THE PHASE IS MEASURED AGAINST. ENTRY POINT: `pushState()`,
       * the same publisher every row above reads — `a128.last` is the last
       * LIVE_STATE the 128 BPM run actually put on the wire.
       *
       * IT IS THE OUTPUT RING'S *READ* COUNTER: what the audio device has
       * consumed, on the axis `bpm.beatFrame` is on. Not the write head, not a
       * track position.
       *
       * THE CONTROL CAN LOSE. `driveDeck` parks the read head four seconds behind
       * the producer and then writes one more hop, so the two counters are seconds
       * apart on this run — a `playFrames` wired to `writeFrames()` passes every
       * "the field is present and finite" test and fails this one. The separation
       * is reported so a run where the two heads converged would be visible rather
       * than silently trivial.
       */
      ok('LIVE_STATE.playFrames is the deck output ring\'s READ counter, not its write head',
        !!a128.last && a128.last.playFrames === a128.lp.out.readFrames()
          && a128.last.playFrames !== a128.lp.out.writeFrames(),
        a128.last
          ? `wire ${a128.last.playFrames}, readFrames() ${a128.lp.out.readFrames()}, ` +
            `writeFrames() ${a128.lp.out.writeFrames()}, heads ` +
            `${((a128.lp.out.writeFrames() - a128.lp.out.readFrames()) / SR).toFixed(2)} s apart`
          : 'no LIVE_STATE');

      /**
       * ...AND THE PAIR COMPOSES INTO A PHASE. ENTRY POINT: `beatPhaseAt(payload,
       * frame, sr)` fed the way `embed.js::beatFrameNow()` feeds it — the wire
       * playhead advanced by the age of its own timestamp. Asserting the two
       * fields are merely PRESENT is not asserting the pulse can run, so this row
       * runs the composition and reads a phase back.
       *
       * `atMs` IS A `Date.now()`-SCALE WALL CLOCK, and that is the claim. The
       * offscreen document and the page have different `performance` time origins,
       * so their `performance.now()` values cannot be differenced; the epoch is the
       * one clock they share. The bound is deliberately loose — a
       * `performance.now()`-scale value is process uptime and misses an epoch bound
       * by decades, while any real publish lag clears it. A tight bound here would
       * be a stopwatch claim wearing this row's name, and AGENTS.md says a
       * stopwatch measures the machine.
       */
      {
        const AGE_BOUND_SEC = 60;
        const m = a128.last;
        const ageSec = m ? (Date.now() - Number(m.atMs)) / 1000 : NaN;
        const frame = m ? Number(m.playFrames) + ageSec * SR : NaN;
        const phase = m ? beatPhaseAt(m.bpm, frame, SR) : null;
        ok('the (playFrames, atMs) pair composes into a real beat phase — one wall clock, one frame axis',
          !!m && Number.isFinite(ageSec) && ageSec >= 0 && ageSec < AGE_BOUND_SEC
            && Number.isFinite(frame) && typeof phase === 'number' && phase >= 0 && phase < 1,
          m ? `atMs age ${ageSec.toFixed(3)} s against a ${AGE_BOUND_SEC} s clock-scale bound, ` +
              `frame ${m.playFrames} advanced to ${frame.toFixed(0)}, phase ${phase}`
            : 'no LIVE_STATE');
      }

      /**
       * AND IT MUST FAIL WHEN IT CANNOT LOOK. ENTRY POINT: `pushState(true)` on a
       * deck with no output ring — the state every deck is in before it arms.
       *
       * ABSENT, NEVER ZEROED. Frame 0 is a real position the ring takes at the
       * start of every run, and `embed.js::beatFrameNow()` discriminates on
       * `Number.isFinite`, so a zeroed field would light the pulse against a
       * playhead nobody sampled. `atMs` is asserted finite in the same row because
       * "the message went out at all" is what makes the missing field evidence of
       * a decision rather than of a dropped publish.
       */
      {
        const lp = mount();
        lp.out = null;
        lp.status = 'ready';
        sent.length = 0;
        lp.pushState(true);
        quiesce(lp);
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a deck with no output ring OMITS playFrames — absent, never zeroed — and still timestamps the message',
          !!m && !('playFrames' in m) && Number.isFinite(m.atMs)
            && !Number.isFinite(Number(m.playFrames)),
          m ? `playhead keys on the wire ${JSON.stringify(Object.keys(m).filter((k) => /play/i.test(k)))}, ` +
              `Number(m.playFrames) ${String(Number(m.playFrames))}, atMs ${m.atMs}`
            : `no LIVE_STATE in ${sent.length} messages`);
      }

      // The bound that keeps this off the hop's deadline is a COUNT, and it is the
      // one the "run it unconditionally, on every deck, with no flag" decision
      // rests on. Read off the real run, not a fresh tap.
      ok('the whole run never consumed more than the per-tick block cap, however far the producer jumped ahead',
        a128.lp.bpmTap.stats().blocks > 100 && a128.lp.bpmTap.lastTickBlocks <= BPM_MAX_BLOCKS_PER_TICK,
        `${a128.lp.bpmTap.stats().blocks} blocks over ${a128.lp.bpmTap.stats().estimates} estimates, ` +
        `last tick ${a128.lp.bpmTap.lastTickBlocks} against a cap of ${BPM_MAX_BLOCKS_PER_TICK}`);

      // ==================================================== the lifecycle reset
      /**
       * A BPM HELD OVER FROM THE PREVIOUS TRACK IS A WRONG READOUT, NOT A STALE
       * ONE — and the mechanism is nastier than "we forgot to call reset". A new
       * session puts the ring's write pointer back to 0, which is BELOW the tap's
       * cursor; `w - cursor` is then negative, the catch-up threshold never
       * fires, every block is refused as `early`, and no `envBreak` is recorded.
       * The tap goes on reporting the old tempo forever with clean-looking stats.
       *
       * REACHABLE: this drives the real `start()`, not `bpmTap.reset()`. An
       * implementation with the reset line deleted passes every row above.
       */
      {
        const lp = a128.lp;
        const before = lp.bpmPayload();
        const cursorBefore = lp.bpmTap.cursor;
        const writeBefore = lp.out.writeFrames();
        lp.build = async () => {};                       // needs an AudioWorklet
        lp.node = { port: { postMessage: () => {} } };
        lp.d.ensureModel = async () => {};
        lp.status = 'idle';
        sent.length = 0;
        await lp.start();
        /**
         * THE HEARTBEAT AFTER start() RETURNS, not the last message start() sent.
         * `start()` pushes twice from inside the priming ramp (`phase:'model'`,
         * then `phase:'ring'`) and BOTH of those are emitted before the detector
         * resets a dozen lines later, so the wire legitimately still carries the
         * old session's tempo while the weights load. The claim here is about the
         * new session, so it is read from the new session's first heartbeat.
         * (That priming-window carry-over is shared with `key`, whose reset sits
         * on the same line, and it is reported rather than asserted here.)
         */
        lp.pushState(true);
        quiesce(lp);
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        ok('start() puts the write pointer BEHIND the tap\'s cursor — the state the silent-hold failure needs',
          writeBefore > 0 && cursorBefore > 0 && lp.out.writeFrames() < cursorBefore,
          `write ${writeBefore} -> ${lp.out.writeFrames()}, cursor was ${cursorBefore}`);
        /**
         * `cursor` is NOT asserted null: the heartbeat above re-anchors it on the
         * new ring, and that RE-ANCHORING is the property that matters. Left at
         * the old session's 1.1 M it would sit permanently ahead of a write
         * pointer that restarts at 0, every block would be refused as `early`,
         * and the tap would hold the old tempo forever with clean-looking stats.
         * So the assertion is that it came back BELOW where it was, not that it
         * is unset — an implementation that resets the envelope and leaks the
         * cursor passes `filled === 0` and fails here.
         */
        ok('...and start() drops the locked tempo with it: a new session reports `none`, not the last track\'s BPM',
          before.state === 'locked' && !!after && after.bpm.state === 'none' &&
          after.bpm.bpm === null && after.bpm.beatFrame === null &&
          lp.bpmTap.stats().filled === 0 && lp.bpmTap.stats().cursor < cursorBefore,
          `${before.state} ${before.bpm} -> ${after ? after.bpm.state + ' ' + after.bpm.bpm : 'NO LIVE_STATE'}, ` +
          `${lp.bpmTap.stats().filled} envelope samples, cursor ${cursorBefore} -> ${lp.bpmTap.stats().cursor}`);
      }

      // ============================================== a fault is REPORTED state
      /**
       * The detector runs inside the 10 Hz heartbeat, so it may not throw into
       * it — and "degrades to no estimate" and "silently does nothing" are the
       * same wire value unless the failure is NAMED. That is the whole content of
       * these rows: not that the throw was caught, but that catching it is
       * visible from outside.
       *
       * TWO ENTRY POINTS, TWO ASSERTIONS. `tick()` is caught in `tickBpm()` and
       * `payload()` is caught in `bpmPayload()`; a guard on one is not a guard on
       * the other, and AGENTS.md's entry-point rule exists because this repo has
       * had five defects from exactly that.
       */
      {
        const lp = mount();
        const logs = [];
        lp.d.log = (s) => logs.push(s);
        const healthy = lp.bpmPayload();
        lp.bpmTap.tick = () => { throw new Error('synthetic tick fault'); };
        sent.length = 0;
        lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        let threw = null;
        try { lp.pushState(true); } catch (e) { threw = e; }
        quiesce(lp);
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a tap that throws in tick() does not take pushState() down',
          threw === null, threw ? String(threw.message) : 'pushState returned normally');
        ok('...and the fault is on the wire as its own state, carrying the message and the count',
          !!m && m.bpm.state === 'fault' && m.bpm.bpm === null &&
          /synthetic tick fault/.test(String(m.bpm.fault)) && m.bpm.faults === 1,
          m ? JSON.stringify(m.bpm) : 'no LIVE_STATE sent');
        /**
         * THE POINT OF THE FIFTH STATE, and the row that would go red if someone
         * "simplified" the fault branch to return `none`. A broken detector and a
         * detector that has heard nothing must not be the same wire value — that
         * is a feature reporting success for the same reason a vacuous assertion
         * does.
         */
        ok('...and a FAULTED tap is distinguishable on the wire from one that has simply heard nothing',
          healthy.state === 'none' && !!m && m.bpm.state !== healthy.state && !('fault' in healthy),
          `healthy ${JSON.stringify(healthy)} vs faulted ${m ? JSON.stringify(m.bpm) : 'n/a'}`);
        // Latched: off for the session, one log line, and the counter does not
        // run away at 10 Hz for the life of the deck.
        sent.length = 0;
        for (let i = 0; i < 10; i++) { lp.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ; lp.pushState(true); }
        quiesce(lp);
        const m2 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('the fault latches the tap off — 10 more heartbeats, still one throw, still one log line, still reported',
          !!m2 && m2.bpm.state === 'fault' && m2.bpm.faults === 1 && lp.bpmFaults === 1 &&
          logs.filter((s) => /tempo tap faulted/.test(s)).length === 1,
          `faults ${lp.bpmFaults}, ${logs.filter((s) => /tempo tap faulted/.test(s)).length} log line(s)`);
        // ...and the next session clears it, or a transient fault would be
        // unclearable without reloading the offscreen document.
        lp.bpmTap.tick = () => 0;
        lp.build = async () => {};
        lp.node = { port: { postMessage: () => {} } };
        lp.d.ensureModel = async () => {};
        lp.status = 'idle';
        sent.length = 0;
        await lp.start();
        lp.pushState(true);            // the new session's first heartbeat — see above
        quiesce(lp);
        const m3 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('and start() clears it, so a transient fault does not need a document reload',
          !!m3 && m3.bpm.state === 'none' && lp.bpmFault === null && lp.bpmFaults === 0,
          m3 ? `${JSON.stringify(m3.bpm)}, fault ${lp.bpmFault}` : 'no LIVE_STATE');
      }
      {
        // The OTHER entry point. Same claim, different guard.
        const lp = mount();
        lp.d.log = () => {};
        lp.bpmTap.payload = () => { throw new Error('synthetic payload fault'); };
        sent.length = 0;
        let threw = null;
        try { lp.pushState(true); } catch (e) { threw = e; }
        quiesce(lp);
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a tap that throws in payload() does not take pushState() down either, and reports the same way',
          threw === null && !!m && m.bpm.state === 'fault' &&
          /synthetic payload fault/.test(String(m.bpm.fault)),
          threw ? String(threw.message) : m ? JSON.stringify(m.bpm) : 'no LIVE_STATE');
        // stats() is the harness surface and is built from the same helper, so it
        // must survive the same fault — a DIAG paste that throws is a DIAG paste
        // nobody gets.
        let threw2 = null, st = null;
        try { st = lp.stats(); } catch (e) { threw2 = e; }
        ok('...and stats() still builds, with the fault visible in it',
          threw2 === null && !!st && st.bpm.state === 'fault' && st.bpmFaults >= 1,
          threw2 ? String(threw2.message) : st ? `bpmFaults ${st.bpmFaults}` : 'no stats');
      }
    }

    head('live — hop viability is about the SPREAD of T_inf, not its mean');
    {
      /**
       * The case that killed the mean test, measured on an M2 Max over a cold
       * 300 s soak: hop 1.0 runs at RTF 0.8906 — comfortably under 1.0 — and
       * still misses 138 of 305 deadlines, because median chunk time oscillates
       * 753..1002 ms across a 1000 ms deadline with no trend. An RTF>0.85 gate
       * sits silent through exactly the failure it exists to catch.
       */
      const feed = (lp, series) => { lp.chunkMs = series.slice(-32); lp.k = series.length; };
      // The measured M2 Max distribution sits at RTF 0.8906, which the old
      // RTF>0.85 gate caught — but only just, and by luck of where the mean
      // landed. A machine 6 % faster has the SAME 45 % miss rate and slips under
      // the gate entirely. That is the case being fixed, so that is the case to
      // test: 55 % of chunks at 700 ms, 45 % at 1010 ms against a 1000 ms
      // deadline. Mean 840 ms => RTF 0.84, silent under the old rule.
      const nearMiss = [];
      for (let i = 0; i < 32; i++) nearMiss.push(i < 18 ? 700 : 1010);   // 14/32 = 44 % over the deadline
      const meanRtf = nearMiss.reduce((a, b) => a + b, 0) / nearMiss.length / 1000;
      const missRate = nearMiss.filter((v) => v > 1000).length / nearMiss.length;
      const lp1 = mount();
      lp1.plan = makeLivePlan(1.0);
      feed(lp1, nearMiss);
      lp1.drops = 0;
      ok('a machine 6 % faster than ours passes the OLD mean gate while missing 45 % of deadlines',
        meanRtf < 0.85 && missRate > 0.4,
        `RTF ${meanRtf.toFixed(3)} (old gate 0.85 — silent) with ${(missRate * 100).toFixed(0)} % of chunks over the deadline`);
      sent.length = 0;
      lp1.warnIfMarginal();
      quiesce(lp1);
      ok('the p95 test fires on that same data',
        sent.some((m) => m.code === 'HOP_MARGINAL'),
        `p95 ${lp1.p95ChunkMs()} ms vs a 1000 ms deadline`);
      // and on the real measured distribution too
      const lpQA = mount();
      lpQA.plan = makeLivePlan(1.0);
      feed(lpQA, Array.from({ length: 32 }, (_, i) => (i % 2 ? 1002 : 753)));
      lpQA.drops = 0;
      sent.length = 0;
      lpQA.warnIfMarginal();
      quiesce(lpQA);
      ok('and on the distribution actually measured (753<->1002 ms, RTF 0.89)',
        sent.some((m) => m.code === 'HOP_MARGINAL'), `p95 ${lpQA.p95ChunkMs()} ms`);

      // hop 1.95 on the same machine must stay quiet
      const lp2 = mount();
      lp2.plan = makeLivePlan(1.95);
      feed(lp2, Array.from({ length: 32 }, (_, i) => 746 + (i % 5) * 17));   // 746..814, measured
      lp2.drops = 6; lp2.k = 156;
      sent.length = 0;
      lp2.warnIfMarginal();
      quiesce(lp2);
      ok('and stays quiet at the shipping hop (p95 814 ms against a 1950 ms deadline)',
        !sent.some((m) => m.code === 'HOP_MARGINAL') && !lp2.marginalWarned,
        `p95 ${lp2.p95ChunkMs()} ms, drops ${(100 * 6 / 156).toFixed(1)} %`);

      // the drop-rate trigger catches it even when p95 lands on the fast phase
      const lp3 = mount();
      lp3.plan = makeLivePlan(1.0);
      feed(lp3, Array.from({ length: 32 }, () => 760));
      lp3.drops = 45; lp3.k = 151;
      sent.length = 0;
      lp3.warnIfMarginal();
      quiesce(lp3);
      ok('a fast-phase window still trips on the observed drop rate',
        sent.some((m) => m.code === 'HOP_MARGINAL'),
        `p95 ${lp3.p95ChunkMs()} ms looks fine; ${(100 * 45 / 151).toFixed(0)} % of chunks already unseparated`);
      ok('thresholds are named constants, not literals',
        MARGINAL_P95_FRACTION === 0.85 && MARGINAL_DROP_RATE === 0.05);
    }

    head('live — a chunk failure degrades, then halts loudly; it never limps in silence');
    {
      const lp = mount();
      sent.length = 0;
      lp.fail('CHUNK_FAILED', new Error('boom'));
      ok('one failure does NOT set status=error (that would lock armPlayback off forever, ' +
         'so the ladder fills the ring with passthrough nobody is allowed to play)',
        lp.status === 'running' && lp.stopped === false, `status ${lp.status}`);
      lp.fail('CHUNK_FAILED', new Error('boom'));
      lp.fail('CHUNK_FAILED', new Error('boom'));
      quiesce(lp);
      ok('three consecutive failures halt the pipeline and say so',
        lp.status === 'error' && lp.stopped === true && lp.out.playing() === false, `status ${lp.status}`);
      const errs = sent.filter((m) => m.type === 'LIVE_ERROR');
      ok('the error is reported at most 4 times, not once per capture tick',
        errs.length === 4 && errs.at(-1).code === 'HALTED',
        `${errs.length} LIVE_ERROR: ${errs.map((e) => e.code).join(',')}`);
      for (let i = 0; i < 50; i++) lp.fail('CHUNK_FAILED', new Error('boom'));
      quiesce(lp);
      ok('and stays quiet afterwards (200 copies of one message buries the useful one)',
        sent.filter((m) => m.type === 'LIVE_ERROR').length === 4);
    }
  }

  head('live — readWindow zero-pads the past and reports lost history');
  if (typeof SharedArrayBuffer === 'function') {
    const CAP = 1 << 12;
    const sab = new SharedArrayBuffer(ringByteLength(CAP));
    const ring = new RingConsumer(sab, CAP);
    const hdr = new Int32Array(sab, 0, 16);
    const pl = new Float32Array(sab, 64, CAP), pr = new Float32Array(sab, 64 + CAP * 4, CAP);
    const put = (n) => { const wf = Atomics.load(hdr, 0);
      for (let i = 0; i < n; i++) { pl[(wf + i) & (CAP - 1)] = wf + i + 1; pr[(wf + i) & (CAP - 1)] = -(wf + i + 1); }
      Atomics.store(hdr, 0, wf + n); };
    put(500);
    // window = absolute frames [-300, 600): 300 of pre-history, 500 written, 100 unwritten
    const a = new Float32Array(900), b = new Float32Array(900);
    ok('a window reaching before frame 0 is zero-padded, not an error',
      readWindow(ring, -300, 900, a, b) === true && a[0] === 0 && a[299] === 0 && a[300] === 1);
    ok('reading past the write head yields zeros, not stale audio',
      a[799] === 500 && a[800] === 0 && a[899] === 0 && b[300] === -1);
    put(CAP);   // lap the ring
    const c2 = new Float32Array(200), d2 = new Float32Array(200);
    ok('a window the producer has already lapped is reported as lost',
      readWindow(ring, 0, 200, c2, d2) === false);
  }

  head('live — OUTPUT_DEAD: a playing deck that produces NOTHING must say so');
  /**
   * REACHABLE: drives the real decision, `offscreen/live.js::outputTick`, which
   * `LivePipeline.watchOutput()` calls at HEALTH_HZ. The browser half is in
   * tools/run-ext.mjs ("the dead-output watchdog"), which proves the arm is
   * wired and actually evaluating on a real deck; this proves the decision.
   *
   * WHY THIS EXISTS. Reported 2026-08-09 from a real end-to-end run: the buffer
   * gauge moving, every stem meter and the master meter at rest, no sound, and
   * NOT ONE ERROR anywhere. Both existing arms are structurally unable to fire
   * on that state — `OUTPUT_SILENT` requires `meters.peak.master > 1e-3` before
   * it will count a tick, and `OUTPUT_STALLED` requires the worklet to stop
   * heartbeating, which a deck emitting digital zero does not do. The engine had
   * a watchdog named for exactly this failure and a blind spot exactly the shape
   * of it.
   *
   * Every assertion below names the entry point, because `outputTick` has one
   * caller today and will acquire more (`AGENTS.md`, the entry-point rule).
   */
  {
    /**
     * A meter frame keyed by STEMS + `master`, built from the list rather than
     * from four spelled names. `outputTick` returns `blind` for any frame that
     * is short a stem (offscreen/live.js: "a frame that is short a stem is
     * blind, not signal"), so a four-name builder here would have made every row
     * below report `blind` instead of testing the verdict it names — the
     * assertion would still have been red, but for the wrong reason and at the
     * wrong file.
     * @param {...number} p one peak per stem in STEMS order, then master
     */
    const M = (...p) => {
      if (p.length !== STEMS.length + 1) throw new Error(`M() needs ${STEMS.length + 1} peaks, got ${p.length}`);
      const peak = { master: p[STEMS.length] };
      STEMS.forEach((s, k) => { peak[s] = p[k]; });
      return { peak };
    };
    const ZEROS = STEMS.map(() => 0);
    const LIVE = { meter: STEMS.map(() => 1), pass: 1 };
    const KILLED = { meter: [...ZEROS], pass: 0 };
    /**
     * TWO INPUT READINGS, AND THE DEFAULT IS "THE TAB IS LIVE AT BOTH ENDS".
     *
     * `outputTick` takes the capture peak over the frames the output just played
     * (`inputPeakPlayed`, the OUTPUT's clock — what was owed) AND the capture
     * peak now (`inputPeakNow`, the CAPTURE clock — whether audio is on the way).
     * It used to take one `inputPeak` read at the capture clock and compare it
     * against meters read at the speaker, which is two points on a delay line
     * treated as one instant; the rows below all default to a tab that is live
     * at both ends, so every verdict they name is the verdict under test rather
     * than a side effect of the split.
     */
    const tick = (o) => outputTick({
      playing: true, meters: M(...ZEROS, 0), gains: LIVE,
      inputPeakPlayed: 0.5, inputPeakNow: 0.5, ...o,
    });
    /** one stem up, the rest dead — `at('guitar', 1)` is the partial-kill vector */
    const only = (name, v) => STEMS.map((s) => (s === name ? v : 0));

    ok('watchOutput: a deck with signal at the stem tap is `signal`',
      tick({ meters: M(0.4, 0.1, 0.2, 0.3, 0.15, 0.05, 0.7) }) === 'signal');
    /**
     * THE NEW STEMS, ON THEIR OWN. `outputTick` used to read four spelled names,
     * so a deck playing nothing but guitar and piano metered as digital black
     * and would have raised OUTPUT_DEAD on a working deck. That is a wolf-cry on
     * ratified behaviour — exactly the failure `AGENTS.md` names — and it is
     * reachable with two clicks (solo guitar). Asserted per new stem, because
     * one name being wired up says nothing about the other.
     */
    for (const s of ['guitar', 'piano']) {
      ok(`watchOutput: a deck playing ONLY ${s} reads \`signal\`, not a dead deck`,
        tick({ meters: M(...only(s, 0.4), 0.4) }) === 'signal');
    }
    /**
     * ...and the converse, which is the half that can go vacuous: a frame that
     * omits a stem must be `blind`, not `signal`. A worklet still posting a
     * 4-stem meter array through a 6-stem byStem() yields `piano = undefined`,
     * and the old `Math.max(...)` form returned 'signal' on it.
     */
    for (const s of STEMS) {
      const short = M(...STEMS.map(() => 0.4), 0.4);
      delete short.peak[s];
      ok(`watchOutput: a meter frame missing \`${s}\` is \`blind\`, never \`signal\``,
        outputTick({ playing: true, meters: short, gains: LIVE, inputPeakPlayed: 0.5, inputPeakNow: 0.5 }) === 'blind');
    }
    ok('watchOutput: silent stems with a LIVE capture is `dead-mixer` — the separator published nothing',
      tick({ inputPeakPlayed: 0.5 }) === 'dead-mixer');
    ok('watchOutput: silent stems with a SILENT capture is `dead-input` — there was nothing to separate',
      tick({ inputPeakPlayed: 0, inputPeakNow: 0 }) === 'dead-input');
    ok('watchOutput: a deck that is not playing is `idle` and can never raise the alarm',
      outputTick({ playing: false, meters: null, gains: LIVE, inputPeakPlayed: 0, inputPeakNow: 0 }) === 'idle');

    // THE EXCUSE, and it is the only one. It is read off the RESOLVED GAIN
    // VECTOR — our own state — so it is independent of the silence it excuses
    // `AGENTS.md`. A user who kills all six stems has ASKED for digital black.
    ok('watchOutput: all six stems killed is `asked` — the user chose the silence',
      tick({ gains: KILLED }) === 'asked' && KILLED.meter.length === STEMS.length);
    // ...and it must take ALL of them. Asserted once per stem: a six-wide `asked`
    // that only inspects the first four would excuse a deck on the strength of
    // drums..vocals while guitar was still open, which is the partial kill this
    // row exists to refuse.
    for (const s of STEMS) {
      ok(`watchOutput: ...${s} still up is NOT excused, so a partial kill cannot hide a dead deck`,
        tick({ gains: { meter: only(s, 1), pass: 0 } }) === 'dead-mixer');
    }
    // QA-15's ratified ducking rule: with a stem killed, a DROPPED span is
    // silent on purpose (passthroughGain = min of the resolved gains = 0). At
    // hop 1.0 that is 57 s of a 71 s run — an alarm here would be crying wolf on
    // ratified behaviour, which is the failure `AGENTS.md` names twice.
    const ONE_KILLED = { meter: STEMS.map((s) => (s === 'vocals' ? 0 : 1)), pass: 0 };
    ok('watchOutput: a passthrough span ducked to zero by a killed stem is `asked`, not an alarm',
      tick({ gains: ONE_KILLED, passthrough: true }) === 'asked');
    ok('watchOutput: ...but the SAME gains OUTSIDE a passthrough span are a dead deck, because separated audio was owed',
      tick({ gains: ONE_KILLED, passthrough: false }) === 'dead-mixer');

    // AGENTS.md, "an assertion must FAIL when it cannot look" — applied to the
    // instrument itself. A playing deck whose audio thread has never reported a
    // meter frame is the failure; reading it as an excuse is how a watchdog
    // reports coverage it does not have.
    ok('watchOutput: a playing deck with NO meter frame is `blind`, which counts toward the alarm',
      outputTick({ playing: true, meters: null, gains: LIVE, inputPeakPlayed: 0.5, inputPeakNow: 0.5 }) === 'blind');
    ok('watchOutput: ...and `blind` is not silently rescued by the kill excuse either',
      outputTick({ playing: true, meters: null, gains: KILLED, inputPeakPlayed: 0, inputPeakNow: 0 }) === 'blind');

    // The two arms must cover DISJOINT regions. If this one could fire while the
    // master meter is up, it would double-report every OUTPUT_SILENT and the two
    // codes would stop meaning different things.
    ok('watchOutput: a deck crossfaded fully out still meters its stems, so it reads `signal`, not dead',
      tick({ meters: M(0.4, 0.1, 0.2, 0.3, 0.15, 0.05, 0) }) === 'signal');

    // Reintroducing the defect means widening the floor until real silence reads
    // as signal; pin the boundary so that shows up here rather than in a user's
    // ears. 1e-6 is ~-120 dBFS: below anything a 32-bit float mix produces.
    ok('watchOutput: the digital-zero floor is exact — 1e-6 is dead, 2e-6 is signal',
      tick({ meters: M(...ZEROS, MIXER_SILENT_PEAK) }) === 'dead-mixer' &&
      tick({ meters: M(...ZEROS, 2e-6) }) === 'signal');
    // ...and the floor is applied to EVERY stem, not just to master. Pinned per
    // new stem: at four names, `guitar` above the floor was invisible to it.
    for (const s of ['guitar', 'piano'])
      ok(`watchOutput: ...and the floor applies to ${s} too — ${s} at 2e-6 alone is signal`,
        tick({ meters: M(...only(s, 2e-6), 0) }) === 'signal' &&
        tick({ meters: M(...only(s, MIXER_SILENT_PEAK), 0) }) === 'dead-mixer');
    /**
     * THE HOLD IS A COUNT OF FRAMES, NOT OF HEARTBEATS. It used to be
     * `Math.round(OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ)` = 30 ticks, and this
     * assertion pinned that — a count of `setInterval` callbacks, which is a
     * stopwatch with a counter's name on it. `OUTPUT_DEAD_HOLD_FRAMES` is
     * seconds of audio the listener was actually handed, on the device's own
     * clock. The two agree only on a machine that never misses a heartbeat,
     * which is the machine nobody has.
     */
    ok('watchOutput: the hold is 3 s of PLAYED AUDIO, 132300 frames, long enough for a silent intro',
      OUTPUT_DEAD_HOLD_SEC === 3 && OUTPUT_DEAD_HOLD_FRAMES === 3 * SR && OUTPUT_DEAD_HOLD_FRAMES === 132300,
      `${OUTPUT_DEAD_HOLD_FRAMES} frames at ${SR} Hz`);

    /**
     * THE ACCEPTANCE CASE, AND IT IS A MEASUREMENT, NOT A CONSTRUCTION.
     *
     * PROVENANCE: Itzik's own run, 2026-08-09 — unpacked extension, real
     * YouTube tab, real toolbar arm, real DJ console, forty minutes. Every
     * number below is transcribed from that DIAG paste, not invented:
     *
     *   capture.seconds 2416.55 · capture.peak [0, 0] · dropped 0
     *   live.playing true · worklet.play true · worklet.running true · fade 1
     *   worklet.gain [1,1,1,1,1,1] · worklet.xf [1,1,1,1] · rampLeft all 0
     *   lastMeters present, every peak and rms 0 (912 METERS in 5 s, all zero)
     *   k 676 · drops 0 · underruns 0 · cushionSec 1.956 · healthAgeMs 33
     *   output.busPeak 0 · terminalIsDestination true · ctx.state "running"
     *   outputAlarm NULL  <- the engine said nothing for 2416 seconds
     *
     * The tab was PAUSED. The pipeline was correct end to end and was faithfully
     * separating silence into silence. `OUTPUT_SILENT` could not fire because it
     * demands `meters.peak.master > 1e-3` BEFORE it will count a silent tick,
     * and `OUTPUT_STALLED` could not fire because the worklet was heartbeating
     * 33 ms ago. The one instrument named for this failure was structurally
     * incapable of seeing it.
     *
     * This is why the deleted end-to-end block is not needed: it rested on an
     * unverified premise about what the model emits for an all-zero input, and
     * this rests on what the product actually did on a user's machine.
     *
     * ---- THE PASTE IS FOUR-STEM. READ THIS BEFORE TRUSTING THE REPLAY.
     *
     * That run predates guitar and piano — `worklet.gain [1,1,1,1,1,1]` is four
     * stems plus passthrough plus master, i.e. the OLD six-slot map, not the
     * eight-slot one this branch ships. The transcription above is left exactly
     * as it was pasted; what is widened is the REPLAY, and only on the clause
     * that the run's own premise settles: THE TAB WAS PAUSED, so the capture
     * ring was digital zero and the separator was faithfully turning silence
     * into silence. That is a property of the INPUT, so it holds for every stem
     * the model emits, at any stem count — `guitar: 0` and `piano: 0` are
     * entailed by `capture.peak [0, 0]`, not invented to make six keys.
     *
     * What is NOT claimed: nothing here is evidence about how guitar and piano
     * behave on a run with audio in it. That needs a new measurement, and
     * SIX-STEM-CONTRACT §4 records that we do not have one yet.
     */
    {
      const zeroPeaks = () => Object.fromEntries([...STEMS, 'master'].map((s) => [s, 0]));
      const REAL = {
        playing: true,
        meters: { peak: zeroPeaks(), rms: zeroPeaks() },
        gains: { meter: STEMS.map(() => 1), pass: 1, stems: STEMS.map(() => 1), xf: STEMS.map(() => 1) },
        passthrough: false,        // 0 drops in 676 chunks -> passSpans is empty
        // capture.peak [0, 0] AT BOTH ENDS: the tab was paused, so the frames
        // the speaker was replaying were silent and so is the tab right now.
        // With only the second of those it would read `inflight` — a working
        // deck one latency behind — which is exactly the state this run was NOT
        // in and exactly the state the old single reading could not tell it from.
        inputPeakPlayed: 0,
        inputPeakNow: 0,
      };
      ok("watchOutput: Itzik's 2416 s silent run reads `dead-input` — the branch that names the tab",
        outputTick(REAL) === 'dead-input');
      // Each of the three states the engine WAS in must be shown not to excuse
      // it, or this assertion proves only that some field happened to be zero.
      ok('...and none of the three excuses applies to it: gains were unity, no span was passthrough, meters were present',
        Math.max(REAL.gains.pass, ...REAL.gains.meter) === 1 &&
        REAL.passthrough === false && REAL.meters.peak !== undefined);
      // 132300 frames = 3.0 s of audio HANDED TO THE LISTENER. He got 2416.55 s
      // of it. Expressed in frames rather than in ticks because the claim is
      // about what he heard, not about how often our timer ran.
      ok('...and it would have fired after 3.0 s of silent audio, not 2416.6 s of it',
        OUTPUT_DEAD_HOLD_FRAMES / SR === 3 && 2416.55 / (OUTPUT_DEAD_HOLD_FRAMES / SR) > 800,
        `${OUTPUT_DEAD_HOLD_FRAMES} frames = 3.0 s; the real run went ${(2416.55 / 3).toFixed(0)}x that long in silence`);

      /**
       * ---- THE EMITTED MESSAGE, and its `variant` field.
       *
       * `LIVE_ERROR.variant` is present ONLY on
       * `OUTPUT_DEAD`, is one of the three members of DEAD_VERDICTS, and its
       * REFERENCE POINT IS THE TICK THAT TRIPPED THE LATCH — not the current
       * verdict. The console picks the remedy from it, and the two remedies are
       * opposites: `dead-input` sends the user to the tab (restarting the deck
       * fixes nothing), `dead-mixer`/`blind` restart the deck (going to the tab
       * fixes nothing). Before the field existed the console had to show both.
       *
       * This drives the real `watchOutput()` on a real LivePipeline, with the
       * same literal values from Itzik's snapshot, and reads what actually went
       * out on `send`. Nothing here is a re-implementation of the decision.
       */
      const { LivePipeline: LP } = await import('./extension/offscreen/live.js');
      /**
       * A DECK WHOSE PLAYHEAD ACTUALLY MOVES, because the alarm now counts the
       * audio that came out of it. `readFrames: () => 0` — what this stub used
       * to be — is a deck that has been handed nothing, and a deck that has been
       * handed nothing has nothing to be dead about.
       *
       * The capture ring is the paused tab: digital zero everywhere, and
       * readable, so `inputPeakOver()` gets a real (silent) answer rather than a
       * miss. `writeFrames` runs ahead of the playhead because capture always
       * does; `cap` is the real ring's 2^20 frames so nothing is ever reported
       * as lapped history.
       */
      const FPT = Math.round(SR / HEALTH_HZ);             // 4410 frames per heartbeat
      const wired = (meters) => {
        const out = [];
        const st = { played: 0 };
        const lp = new LP({
          deck: 'A',
          ctx: () => null,
          ring: () => ({                                  // capture.peak [0, 0]
            cap: 1 << 20,
            writeFrames: () => st.played + 3 * SR,
            peaks: () => [0, 0],
            readAt: (from, n, dL, dR, off = 0) => { dL.fill(0, off, off + n); dR.fill(0, off, off + n); },
          }),
          master: () => ({ busPeak: () => 0 }),           // output.busPeak 0
          infer: async () => ({}), ensureModel: async () => {},
          send: (m) => out.push(m), log: () => {},
        });
        lp.node = { port: { postMessage: () => {} } };    // gains resolve; nothing is sent
        lp.xf.position = 0;                               // lone deck A parks hard left (unity)
        lp.out = { playing: () => true, readFrames: () => st.played };
        lp.lastMeters = meters;
        lp.lastHealthAt = performance.now();              // healthAgeMs 33 -> STALLED cannot fire
        /** one heartbeat: the deck hands the listener FPT more frames, then we look */
        st.tick = () => { st.played += FPT; lp.lastHealthAt = performance.now(); lp.watchOutput(); };
        return { lp, out, st };
      };
      const ZERO = { peak: zeroPeaks(), rms: zeroPeaks() };

      const { lp, out, st } = wired(ZERO);
      // Drive until it fires, with a hard stop at four times the hold so a
      // watchdog that never fires ends this loop rather than hanging it.
      let ticksRun = 0;
      while (!lp.outputAlarm && ticksRun < 4 * OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ) { st.tick(); ticksRun++; }
      const fired = out.find((m) => m.type === 'LIVE_ERROR' && m.code === 'OUTPUT_DEAD');
      // FAIL WHEN IT CANNOT LOOK: if nothing was emitted, every field read below
      // is `undefined` and the assertions after it would be reporting on a
      // message that does not exist.
      ok('OUTPUT_DEAD is emitted after exactly the hold, and carries a `variant`',
        !!fired && out.filter((m) => m.type === 'LIVE_ERROR').length === 1 && 'variant' in fired,
        fired ? `after ${ticksRun} ticks / ${st.played} played frames: ${JSON.stringify({ code: fired.code, variant: fired.variant })}`
              : `no LIVE_ERROR in ${out.length} messages`);
      // THE HOLD IS A LOWER BOUND, AND IT IS TIGHT: the arm does not claim the
      // frames played during the tick that became dead (it did not observe them
      // dead), so it fires between the hold and the hold plus one heartbeat.
      ok('...and it fired on the FRAME COUNT: at least the hold, at most one heartbeat past it',
        !!fired && lp.deadFrames >= OUTPUT_DEAD_HOLD_FRAMES &&
        lp.deadFrames < OUTPUT_DEAD_HOLD_FRAMES + FPT,
        `${lp.deadFrames} dead frames against a ${OUTPUT_DEAD_HOLD_FRAMES}-frame hold (+${lp.deadFrames - OUTPUT_DEAD_HOLD_FRAMES})`);
      ok("...and for Itzik's values the variant is `dead-input` — the source-tab remedy, not Restart",
        fired && fired.variant === 'dead-input', fired && String(fired.variant));
      ok('...and the variant is in the ratified domain (the three DEAD_VERDICTS, nothing else)',
        fired && ['dead-input', 'dead-mixer', 'blind'].includes(fired.variant), fired && String(fired.variant));

      /**
       * THE REFERENCE POINT, and this is the assertion that actually tests it.
       *
       * The alarm latches once per session; `outputVerdict` does not stand still.
       * Move it and the LATCHED record must not follow. An implementation that
       * reports "the current verdict" instead of "the verdict that tripped it"
       * passes every assertion above and fails this one — which is the whole
       * reason the spec specified a reference point rather than a field name.
       */
      lp.outputVerdict = 'dead-mixer';                    // a later tick saw something else
      lp.watchOutput();                                   // latched: must be a no-op
      ok('the latched variant does NOT track a later `outputVerdict` — it is the tripping tick, not the current one',
        lp.outputAlarmVariant === 'dead-input' && lp.outputVerdict === 'dead-mixer' &&
        out.filter((m) => m.type === 'LIVE_ERROR').length === 1,
        `latched ${lp.outputAlarmVariant}, current ${lp.outputVerdict}, ` +
        `${out.filter((m) => m.type === 'LIVE_ERROR').length} LIVE_ERROR emitted`);
      ok('...and the message already on the wire still says what caused it',
        fired && fired.variant === 'dead-input' && fired.variant !== lp.outputVerdict,
        `wire ${fired && fired.variant} vs current ${lp.outputVerdict}`);

      // PRESENT ONLY ON OUTPUT_DEAD. A stalled audio thread with live meters
      // takes the OTHER arm, and a console keying off `'variant' in m` must not
      // find one there.
      {
        const byStem = (v, master) => Object.fromEntries([...STEMS.map((s) => [s, v]), ['master', master]]);
        const w2 = wired({ peak: byStem(0.3, 0.7), rms: byStem(0.1, 0.2) });
        w2.lp.lastHealthAt = performance.now() - 5000;    // heartbeat 5 s old
        w2.lp.watchOutput();
        const st = w2.out.find((m) => m.type === 'LIVE_ERROR');
        ok('OUTPUT_STALLED carries NO variant field at all — absent, not null',
          !!st && st.code === 'OUTPUT_STALLED' && !('variant' in st),
          st ? `${st.code}, keys ${Object.keys(st).join(',')}` : 'no LIVE_ERROR emitted');
      }
    }
  }

  head('live — OUTPUT_DEAD: the hold is a COUNT of played frames, and it is read on the right clock');
  /**
   * REACHABLE: every row drives the real `LivePipeline.watchOutput()` against a
   * deck whose playhead moves, whose capture ring can be read, and whose mixer
   * can be broken on purpose. Nothing here re-implements the decision.
   *
   * WHY THIS BLOCK EXISTS — two defects, one event (diagnosis, 2026-08-16). At a
   * hop-1.0 restart the e2e tier raised a FATAL `OUTPUT_DEAD [dead-mixer]` on a
   * deck that was working perfectly: 0 chunk failures, 33346/35607 audible
   * ms-blocks, 0 drops. Fired 4/4 at hop 1.0 and 0/2 at hop 1.95 with a **0.2 s
   * margin**, on a build nobody had changed.
   *
   *   D1 — THE HOLD WAS A STOPWATCH. `deadTicks >= 3 s * HEALTH_HZ` counts
   *        `setInterval` callbacks and starts at `play()`, so it spent its whole
   *        budget on the deck's own start-up: the deck was faithfully replaying
   *        the silence the tab produced before the user pressed play.
   *   D2 — IT COMPARED TWO CLOCKS. `inputPeak` came from `ring.peaks()` (the
   *        CAPTURE clock, "now") and `meters` is the speaker, `latencySec`
   *        behind. When the tab woke mid-count the verdict flipped
   *        `dead-input -> dead-mixer` with nothing in the mixer changing — and
   *        the console picks the REMEDY off that variant, so the user was told to
   *        restart a working deck instead of to press play in their own tab.
   *
   * The fix is a count and a clock, not a bigger constant: raising the hold would
   * have made this red go away while leaving the gate measuring the machine, and
   * it would have lengthened the forty-minute defect the arm exists to catch.
   */
  {
    const { LivePipeline: LP } = await import('./extension/offscreen/live.js');
    /** one meter frame at level `v`, every stem plus master — built off STEMS */
    const S = (v) => Object.fromEntries([...STEMS.map((s) => [s, v]), ['master', v]]);
    const verdictCount = (a, v) => a.filter((x) => x === v).length;
    /**
     * `Infinity` for a verdict that never happened, so an ordering assertion on
     * a sequence that is missing one of its members goes RED instead of passing
     * on a `-1` that happens to sort first.
     */
    const firstIndex = (a, v) => { const i = a.indexOf(v); return i < 0 ? Infinity : i; };

    /**
     * A DECK ON A TIMELINE, driven one heartbeat at a time.
     *
     * The model is the pipeline's own geometry and nothing more: output frame
     * `n` is the audio captured at live-relative capture frame `n` (the identity
     * `latencySec()` is derived from), the capture clock runs `latencySec` ahead
     * of the playhead, and the worklet meters what just came out. A mixer that
     * eats the audio is one multiplier — `mixerGain` — so "the tab went quiet"
     * and "the separator published nothing" are DIFFERENT knobs and a row can
     * turn exactly one of them.
     *
     * `hz` is how often the main thread gets to look. It is a property of the
     * MACHINE, never of the audio, and two rows below run the identical timeline
     * at 10 Hz and 2 Hz for exactly that reason.
     */
    const rig = ({ hz = HEALTH_HZ, latencySec = 2.0, tabLive = () => true, mixerGain = () => 1 }) => {
      const out = [], verdicts = [];
      const fpt = Math.round(SR / hz);
      const latFrames = Math.round(latencySec * SR);
      const st = { played: 0, ticks: 0, maxDeadFrames: 0, silentRun: 0, maxSilentRun: 0,
                   firedAtPlayed: null, firedAtTicks: null, firedAtDeadFrames: null, firedAtDeadTicks: null };
      const inputAt = (f) => (f >= 0 && tabLive(f) ? 0.6 : 0);
      const lp = new LP({
        deck: 'A',
        ctx: () => null,
        ring: () => ({
          cap: 1 << 20,
          // capture runs ahead of the playhead by the deck's latency
          writeFrames: () => st.played + latFrames,
          // THE CAPTURE CLOCK: the tab's peak over the last capture quanta, which
          // is what `capture-processor.js` publishes in the ring header.
          peaks: () => { const v = inputAt(st.played + latFrames - 1); return [v, v]; },
          readAt: (from, n, dL, dR, off = 0) => {
            for (let i = 0; i < n; i++) { const v = inputAt(from + i); dL[off + i] = v; dR[off + i] = v; }
          },
        }),
        master: () => ({ busPeak: () => 0.5 }),      // the bus is fine; this arm is about the deck
        infer: async () => ({}), ensureModel: async () => {},
        send: (m) => out.push(m), log: () => {},
      });
      lp.node = { port: { postMessage: () => {} } };
      lp.xf.position = 0;                            // lone deck A parks hard left (unity)
      lp.baseFrame = 0;
      lp.out = { playing: () => true, readFrames: () => st.played };
      st.tick = () => {
        const from = st.played;
        st.played += fpt; st.ticks++;
        let sig = 0;
        for (let f = from; f < st.played; f++) { const v = inputAt(f); if (v > sig) sig = v; }
        const heard = sig * mixerGain(st.played);
        lp.lastMeters = { peak: S(heard), rms: S(heard) };
        /**
         * `performance.now()`, NEVER 0, AND THIS HAS NOW COST TWO AGENTS A RED IN
         * THIS FILE. In node `performance.now()` is milliseconds since PROCESS
         * START, so pinning a time gate to 0 does not open it — it asks "is the
         * process older than N ms?", and the suite reaches these blocks at about
         * 30 ms. Ground every time gate on `now` or on `now - period`.
         */
        lp.lastHealthAt = performance.now();
        lp.watchOutput();
        verdicts.push(lp.outputVerdict);
        if (lp.deadFrames > st.maxDeadFrames) st.maxDeadFrames = lp.deadFrames;
        // What the OLD instrument counted: consecutive heartbeats on which the
        // deck produced nothing. Tracked so a row can show that the old rule
        // would have fired on a timeline the new one correctly passes.
        st.silentRun = heard > MIXER_SILENT_PEAK ? 0 : st.silentRun + 1;
        if (st.silentRun > st.maxSilentRun) st.maxSilentRun = st.silentRun;
        if (lp.outputAlarm && st.firedAtPlayed === null) {
          st.firedAtPlayed = st.played; st.firedAtTicks = st.ticks;
          st.firedAtDeadFrames = lp.deadFrames; st.firedAtDeadTicks = lp.deadTicks;
        }
      };
      st.run = (sec) => { const n = Math.round(sec * hz); for (let i = 0; i < n; i++) st.tick(); };
      return { lp, out, st, verdicts, fpt };
    };
    const deadMsg = (out) => out.find((m) => m.type === 'LIVE_ERROR' && m.code === 'OUTPUT_DEAD') || null;
    const OLD_HOLD_TICKS = Math.round(OUTPUT_DEAD_HOLD_SEC * HEALTH_HZ);   // the instrument this replaces

    // ================================================ 1. THE SLOW START (D1+D2)
    /**
     * The reported false alarm, as a timeline: the user armed the deck and the
     * tab did not produce its first sample until 3.6 s of capture later. The deck
     * armed 2.0 s in, so for the first 1.6 s of playback it is replaying silence
     * that the tab really did produce, and after that it is replaying silence
     * while the tab is ALREADY PLAYING — the audio is in the pipe, one latency
     * from the speaker.
     */
    {
      const TAB_STARTS = Math.round(3.6 * SR);
      const r = rig({ tabLive: (f) => f >= TAB_STARTS, latencySec: 2.0 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('slow start: a deck replaying the lead-in silence the TAB produced raises no alarm',
        m === null && r.lp.outputAlarm === null,
        m ? `fired ${m.variant}: ${m.message.slice(0, 60)}` : `no LIVE_ERROR in ${r.out.length} messages`);
      /**
       * ...AND THE GREEN IS NOT "THE ARM NEVER RAN". Three separate facts, each
       * asserted rather than assumed: the arm evaluated on every heartbeat, it
       * DID see the deck producing nothing (so it was looking at the failure it
       * is named for), and the counter really did move.
       */
      ok('...and it looked every heartbeat, saw the silence, and counted it — this green is not a watchdog that never ran',
        r.lp.outputChecks === r.st.ticks && verdictCount(r.verdicts, 'dead-input') > 0 && r.st.maxDeadFrames > 0,
        `${r.lp.outputChecks} evaluations of ${r.st.ticks} ticks, ${verdictCount(r.verdicts, 'dead-input')} dead-input, ` +
        `peak ${r.st.maxDeadFrames} dead frames of a ${OUTPUT_DEAD_HOLD_FRAMES}-frame hold`);
      /**
       * THE OLD INSTRUMENT WOULD HAVE FIRED ON THIS EXACT TIMELINE. `maxSilentRun`
       * is what `deadTicks` counted — consecutive heartbeats with nothing at the
       * speaker — and it clears the old 30-tick hold comfortably. Without this
       * row the assertion above is "a timeline on which nothing fires", which
       * proves nothing about the fix.
       */
      ok('...and the OLD tick-counting hold WOULD have fired here, which is what makes this row a fix and not a coincidence',
        r.st.maxSilentRun >= OLD_HOLD_TICKS && r.st.maxDeadFrames < OUTPUT_DEAD_HOLD_FRAMES,
        `${r.st.maxSilentRun} consecutive silent heartbeats against the old ${OLD_HOLD_TICKS}-tick hold; ` +
        `new counter peaked at ${r.st.maxDeadFrames}/${OUTPUT_DEAD_HOLD_FRAMES} frames`);
      /**
       * D2, DIRECTLY. The tab wakes at 3.6 s of capture, i.e. 1.6 s into
       * playback, while the speaker is still 2.0 s behind. Under the old single
       * capture-clock reading every heartbeat from then on read `dead-mixer` and
       * the console would have offered "Restart live" for a deck whose only
       * problem was that the user had just pressed play.
       */
      ok('D2: a tab waking mid-count does NOT flip the verdict to `dead-mixer` — nothing in the mixer changed',
        verdictCount(r.verdicts, 'dead-mixer') === 0 && verdictCount(r.verdicts, 'inflight') > 0,
        `${verdictCount(r.verdicts, 'dead-mixer')} dead-mixer, ${verdictCount(r.verdicts, 'inflight')} inflight, ` +
        `${verdictCount(r.verdicts, 'signal')} signal`);
      // ...and the sequence is the physical one, in order: the tab was silent,
      // then it was playing and we had not caught up, then we had.
      ok('...and the verdict sequence is the pipeline geometry: dead-input -> inflight -> signal, once each way',
        firstIndex(r.verdicts, 'dead-input') < firstIndex(r.verdicts, 'inflight') &&
        firstIndex(r.verdicts, 'inflight') < firstIndex(r.verdicts, 'signal'),
        `dead-input@${firstIndex(r.verdicts, 'dead-input')} inflight@${firstIndex(r.verdicts, 'inflight')} ` +
        `signal@${firstIndex(r.verdicts, 'signal')}`);
    }

    // =========================================== 2. BREAK IT: the tab NEVER starts
    /**
     * THE CONTROL, AND IT CAN LOSE. Same rig, same lead-in, one difference: the
     * tab never produces a sample. If row 1's green came from a rig that cannot
     * fire, this row is green too and the whole block is worthless.
     */
    {
      const r = rig({ tabLive: () => false, latencySec: 2.0 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('BROKEN ON PURPOSE — a tab that never plays: the alarm fires, and names the TAB',
        !!m && m.variant === 'dead-input' && r.lp.outputAlarmVariant === 'dead-input',
        m ? `${m.variant} after ${r.st.firedAtPlayed} played frames` : `nothing fired in ${r.st.ticks} ticks`);
      ok('...on the frame count, not the tick count: at least the hold of played audio',
        !!m && r.st.firedAtDeadFrames >= OUTPUT_DEAD_HOLD_FRAMES,
        `${r.st.firedAtDeadFrames} dead frames, ${r.st.firedAtDeadTicks} dead ticks`);
      ok('...and it says so exactly once — the alarm latches per session',
        r.out.filter((x) => x.type === 'LIVE_ERROR').length === 1,
        `${r.out.filter((x) => x.type === 'LIVE_ERROR').length} LIVE_ERROR`);
    }

    // ============================================ 3. BREAK IT: kill the mixer
    /**
     * The other half of the discrimination, and the one the console's remedy
     * turns on. The tab plays throughout; the separator publishes digital zero.
     * `dead-input` here would send the user to a tab that is working.
     */
    {
      const r = rig({ tabLive: () => true, mixerGain: () => 0 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('BROKEN ON PURPOSE — a dead mixer under a LIVE tab: the alarm fires, and names the DECK',
        !!m && m.variant === 'dead-mixer',
        m ? `${m.variant} after ${r.st.firedAtPlayed} played frames` : `nothing fired in ${r.st.ticks} ticks`);
      ok('...and the two breaks are told apart by the audio, not by luck: row 2 said `dead-input`, this one says `dead-mixer`',
        !!m && m.variant === 'dead-mixer' && verdictCount(r.verdicts, 'dead-input') === 0,
        `${verdictCount(r.verdicts, 'dead-mixer')} dead-mixer, ${verdictCount(r.verdicts, 'dead-input')} dead-input`);
    }

    // ================================== 4. THE MESSAGE MAY NOT MISSTATE ITS EVIDENCE
    /**
     * The separator running on a silent input publishes something around 2.4e-08
     * per stem, not zero — and `toFixed(6)` renders every one of those as
     * `0.000000`, which reads as "the mixer emitted nothing" and is a different
     * defect with a different first suspect. The message is the only artefact a
     * user ever pastes, so a message that misstates its own evidence costs an
     * investigation exactly as a wrong assertion does.
     */
    {
      const r = rig({ tabLive: () => true, mixerGain: () => 4.1e-8 });
      r.st.run(12);
      const m = deadMsg(r.out);
      ok('the OUTPUT_DEAD message prints a 2.4e-08 stem peak as 2.4e-08, not as `0.000000`',
        !!m && /e-8/.test(m.message) && !/0\.000000/.test(m.message),
        m ? m.message.slice(m.message.indexOf('(stem peaks')) : 'nothing fired');
      // ...and it is still a dead deck: 2.46e-08 is 152 dB below full scale, well
      // under the 1e-6 floor. The formatting fix must not have widened the floor.
      ok('...and 2.46e-08 is still DEAD, not signal — printing it honestly did not widen the floor',
        !!m && m.variant === 'dead-mixer' && 0.6 * 4.1e-8 < MIXER_SILENT_PEAK,
        `stem peak ${(0.6 * 4.1e-8).toExponential(2)} against a ${MIXER_SILENT_PEAK} floor`);
    }

    // ================================= 5. THE PAUSE MID-RUN (DEVTEST L5a, and Itzik's run)
    /**
     * The failure the arm was built for, and it must still work. The tab plays
     * for 10 s and is then paused. The deck goes on playing what it has buffered,
     * so the alarm must NOT fire while the user can still hear music — and must
     * fire a hold after the silence reaches the speaker, naming the tab.
     */
    {
      const PAUSE_AT = 10 * SR;
      const r = rig({ tabLive: (f) => f < PAUSE_AT, latencySec: 2.0 });
      r.st.run(25);
      const m = deadMsg(r.out);
      ok('a tab paused mid-run still raises OUTPUT_DEAD, and still names the tab',
        !!m && m.variant === 'dead-input',
        m ? `${m.variant} at played frame ${r.st.firedAtPlayed}` : `nothing fired in ${r.st.ticks} ticks`);
      /**
       * AND NOT ONE FRAME BEFORE THE USER COULD HEAR IT. The capture goes silent
       * 2.0 s (one latency) before the speaker does; an alarm decided on the
       * capture clock would fire that much early, while the deck was still
       * playing music. This is the same clock error as D2 seen from the other
       * end, so it gets its own row.
       */
      ok('...and never while music is still coming out: it fires a full hold AFTER the silence reaches the speaker',
        !!m && r.st.firedAtPlayed >= PAUSE_AT + OUTPUT_DEAD_HOLD_FRAMES,
        `fired at played frame ${r.st.firedAtPlayed}, silence reached the speaker at ${PAUSE_AT}, ` +
        `hold ${OUTPUT_DEAD_HOLD_FRAMES}`);
    }

    // ====================================== 6. THE SAME AUDIO, TWO SPEEDS OF MACHINE
    /**
     * THE CLAIM THE WHOLE RE-GROUNDING RESTS ON: the verdict is a property of the
     * audio, not of how often this laptop got round to looking. Identical
     * timeline — tab live, mixer dead — sampled at 10 Hz and at 2 Hz.
     *
     * A gate whose verdict changes on code that did not change is measuring the
     * machine (AGENTS.md). The old rule needed 30 heartbeats, which at 2 Hz is
     * FIFTEEN seconds of audio and at 10 Hz is three: the same defect, reported
     * five times later, on the same build. The frame count is the same both times
     * to within one heartbeat, which is the resolution of the instrument.
     */
    {
      const fast = rig({ hz: 10, tabLive: () => true, mixerGain: () => 0 });
      const slow = rig({ hz: 2, tabLive: () => true, mixerGain: () => 0 });
      fast.st.run(12); slow.st.run(12);
      ok('COUNT NOT STOPWATCH: at 10 Hz and at 2 Hz the alarm fires after the SAME amount of audio',
        fast.st.firedAtPlayed !== null && slow.st.firedAtPlayed !== null &&
        Math.abs(fast.st.firedAtPlayed - slow.st.firedAtPlayed) <= slow.fpt,
        `10 Hz fired at ${fast.st.firedAtPlayed} frames, 2 Hz at ${slow.st.firedAtPlayed} ` +
        `(one 2 Hz heartbeat is ${slow.fpt} frames)`);
      ok('...while the HEARTBEAT count differs by the sampling rate, which is the thing that must not decide it',
        fast.st.firedAtTicks >= 4 * slow.st.firedAtTicks,
        `${fast.st.firedAtTicks} ticks at 10 Hz vs ${slow.st.firedAtTicks} at 2 Hz`);
      /**
       * ...AND THE OLD RULE IS SHOWN FAILING ON THE SLOW MACHINE. `deadTicks` is
       * still published for diagnosis, so its value at the tripping instant is
       * exactly what the old gate would have been looking at: under 30, i.e. the
       * old instrument had not fired yet and would not for another 8 s of audio.
       */
      ok('...and the old 30-tick hold had NOT fired at that point on the 2 Hz machine — it needed 15 s of audio, not 3',
        slow.st.firedAtDeadTicks < OLD_HOLD_TICKS && slow.st.firedAtDeadFrames >= OUTPUT_DEAD_HOLD_FRAMES,
        `${slow.st.firedAtDeadTicks} dead ticks (old hold ${OLD_HOLD_TICKS}) but ` +
        `${slow.st.firedAtDeadFrames} dead frames (new hold ${OUTPUT_DEAD_HOLD_FRAMES})`);
    }

    // ============================ 7. WHEN IT CANNOT LOOK, IT MAY NOT ACCUSE THE TAB
    /**
     * A heartbeat later than the one-second probe window cannot read the whole
     * span the deck played, so it cannot support "the tab was digitally silent
     * throughout". AGENTS.md's rule is that the missing evidence is the failure,
     * not an excuse from it — so the alarm still fires (the deck is dead either
     * way) and the CLAIM degrades to the deck-side remedy, counted on
     * `inputWindowMisses` rather than inferred.
     */
    {
      const r = rig({ hz: 0.5, tabLive: () => false });      // 88200 frames a look
      r.st.run(16);
      const m = deadMsg(r.out);
      ok('an unreadable input window still fires the alarm — "we could not look" is not an excuse from it',
        !!m && r.lp.inputWindowMisses > 0,
        m ? `${m.variant} after ${r.lp.inputWindowMisses} unreadable windows` : 'nothing fired');
      ok('...but it may NOT say the tab was silent: the variant degrades to the deck-side remedy',
        !!m && m.variant === 'dead-mixer' && verdictCount(r.verdicts, 'dead-input') === 0,
        `${m && m.variant}, ${verdictCount(r.verdicts, 'dead-input')} dead-input verdicts`);
      ok('...and the message does not claim evidence it never read',
        !!m && !/captured tab has audio/.test(m.message),
        m ? m.message.slice(0, 72) : 'nothing fired');
    }
  }

  head('live — Ruling 8: a new session may not publish the LAST track\'s key or tempo');
  /**
   * REACHABLE: drives the real `start()` and reads the LIVE_STATE messages that
   * actually went out during the priming window. This is a SEQUENCING claim about
   * `offscreen/live.js`, not a claim about either detector — `keytap.js` and
   * `bpmtap.js` each prove their own `reset()` clears them, and neither can see
   * WHEN the deck calls it.
   *
   * THE DEFECT. `start()` pushes state twice before the ring exists —
   * `phase:'model'` (weights, up to a 172 MiB download) and `phase:'ring'` — and
   * both resets used to sit a dozen lines below them. So for the entire priming
   * window, ~3.4 s at hop 1.95 and far longer on a cold model, LIVE_STATE carried
   * the PREVIOUS track's key and BPM under the new track's title. That is not a
   * stale readout that catches up; it is a wrong one that is correct-looking,
   * which is the exact property both detectors' own headers say is the worst
   * thing either feature can do.
   *
   * The taps are stubbed to a single fact — "has reset() been called yet" —
   * because that is the only thing this block claims. The control below shows the
   * wire faithfully carries whatever the tap holds, so `none` in the priming push
   * can only mean the reset ran first.
   */
  {
    const { LivePipeline: LP } = await import('./extension/offscreen/live.js');
    const lastTrack = (locked) => ({
      wasReset: false,
      reset() { this.wasReset = true; },
      tick() {},
      stats: () => ({}),
      payload() {
        return this.wasReset
          ? { state: 'none', bpm: null, confidence: 0, beatFrame: null, concertTonic: null, mode: null }
          : locked;
      },
    });
    const KEY_LAST = { state: 'locked', concertTonic: 9, mode: 'minor', confidence: 0.71 };
    const BPM_LAST = { state: 'locked', bpm: 128.4, confidence: 0.63, beatFrame: 1117935 };

    const sends = [];
    const lp = new LP({
      deck: 'A',
      ctx: () => null,
      ring: () => ({ cap: 1 << 20, writeFrames: () => 0, peaks: () => [0, 0], readAt: () => {} }),
      master: () => ({ busPeak: () => 0 }),
      infer: async () => ({}), ensureModel: async () => {},
      send: (m) => sends.push(m), log: () => {},
    });
    lp.keyTap = lastTrack(KEY_LAST);
    lp.bpmTap = lastTrack(BPM_LAST);
    // A previous session's LATCHED tempo fault, which is the same class of
    // carry-over: `state:'fault'` from a track that is no longer loaded.
    lp.bpmFault = 'tick: the last track';
    lp.bpmFaults = 4;

    /**
     * THE CONTROL, AND IT CAN LOSE. A heartbeat BEFORE start() must publish the
     * previous track's values — otherwise "the priming push says none" would be
     * satisfied by a wire that never carries a key at all, and every row below
     * would be green against a broken payload.
     */
    lp.status = 'running';
    lp.pushState(true);
    const pre = sends.filter((m) => m.type === 'LIVE_STATE').at(-1);
    ok('control: before start(), the wire really does carry the previous track\'s key and tempo',
      !!pre && pre.key.state === 'locked' && pre.key.concertTonic === 9 &&
      pre.bpm.state === 'fault' && pre.bpm.faults === 4,
      pre ? `key ${pre.key.state}/${pre.key.concertTonic}, bpm ${pre.bpm.state}` : 'no LIVE_STATE');

    // ---- now the real start(), with only the browser-only half stubbed out.
    const posted = [];
    lp.status = 'idle';
    lp.build = async () => {                          // needs an AudioWorklet
      lp.node = { port: { postMessage: (m) => posted.push(m) } };
      lp.out = {
        _play: false, _w: 0,
        reset() { this._w = 0; }, play(v) { this._play = v; }, playing() { return this._play; },
        readFrames: () => 0, writeFrames() { return this._w; }, cushion: () => 0,
      };
    };
    sends.length = 0;
    await lp.start();
    const priming = sends.filter((m) => m.type === 'LIVE_STATE');
    // FAIL WHEN IT CANNOT LOOK: if start() emitted no priming state at all, every
    // field below is `undefined` and the rows would be reporting on messages that
    // do not exist.
    ok('start() emits the two priming pushes this claim is about (`model`, then `ring`)',
      priming.length >= 2 && priming[0].phase === 'model' && priming[1].phase === 'ring',
      `${priming.length} LIVE_STATE, phases ${priming.map((m) => m.phase).join(',') || 'none'}`);
    ok('...and the FIRST of them already reports `none` for the key — the reset is ahead of the push',
      priming.length >= 2 && priming[0].key.state === 'none' && priming[0].key.concertTonic === null,
      priming.length ? `${priming[0].key.state}/${priming[0].key.concertTonic}` : 'no push');
    ok('...and `none` for the tempo, with the previous session\'s latched fault cleared with it',
      priming.length >= 2 && priming[0].bpm.state === 'none' && priming[0].bpm.bpm === null &&
      lp.bpmFault === null && lp.bpmFaults === 0,
      priming.length ? `${priming[0].bpm.state}/${priming[0].bpm.bpm}, fault ${lp.bpmFault}, faults ${lp.bpmFaults}` : 'no push');
    // Both pushes, not just the first: the model load sits BETWEEN them, so a
    // reset that ran after the first one would still leave the second wrong for
    // however long the weights take.
    ok('...and so does every other push start() makes, across the whole priming window',
      priming.every((m) => m.key.state === 'none' && m.bpm.state === 'none'),
      priming.map((m) => `${m.phase}:${m.key.state}/${m.bpm.state}`).join(' '));
    ok('...and both taps were actually asked to reset, by start(), on the start path',
      lp.keyTap.wasReset === true && lp.bpmTap.wasReset === true,
      `key ${lp.keyTap.wasReset}, bpm ${lp.bpmTap.wasReset}`);
    await lp.stop();                                  // release the 10 Hz interval
  }
}

// ===========================================================================
if (group('cache')) {
  head('cache — the key must invalidate on anything that changes the samples');
  // REACHABLE: drives the real pipelineVersion()/cacheKey(). Silently-stale
  // stems are the worst bug this project could ship — they sound plausible, they
  // are wrong, and nothing in the UI can tell you.
  {
    const a = cacheKey('dQw4w9WgXcQ', 1.95);
    ok('the key contains the video id and a version', /^dQw4w9WgXcQ--/.test(a), a);
    ok('a different HOP is a different key (causal stems are hop-dependent: ' +
       'corr 0.9909 at 1.95 s vs 0.9938 at 3.9 s against offline)',
      cacheKey('x', 1.95) !== cacheKey('x', 3.9),
      `${pipelineVersion(1.95)} vs ${pipelineVersion(3.9)}`);
    ok('the version pins the model hash', pipelineVersion(1.95).includes(MODEL.sha256.slice(0, 12)));
    ok('the version pins the segment geometry and the seam law',
      pipelineVersion(1.95).includes(`seg${SEGMENT}`) && /-x50[LP]$/.test(pipelineVersion(1.95)),
      pipelineVersion(1.95));
    ok('the same inputs give the same key (a hit is reproducible)',
      cacheKey('abc', 1.95) === cacheKey('abc', 1.95));
    ok('ids are sanitised, so a hostile id cannot escape the directory',
      !cacheKey('../../etc/passwd', 1.95).includes('/') &&
      !cacheKey('a b/c', 1.95).includes(' '), cacheKey('../../etc/passwd', 1.95));
  }

  head('cache — storage arithmetic (AUDIO.md §8.3)');
  {
    /**
     * RE-DERIVED AT SIX STEMS, not renumbered. The quantity is physical: one
     * 16-bit stereo PCM file per stem, so 4 bytes per frame per stem, plus one
     * 44-byte RIFF header per file.
     *
     *   240 s x 44 100 = 10 584 000 frames
     *   10 584 000 x 4 B x 6 stems     = 254 016 000 B
     *   + 6 x 44 B of RIFF header      =         264 B
     *                                  = 254 016 264 B = 254.0 MB
     *
     * It was 169.3 MB at four stems (10 584 000 x 4 x 4 + 176). The +50 % is the
     * two new stems and nothing else — SIX-STEM-CONTRACT §3 predicted "169 ->
     * ~254 MB/track" and this is the arithmetic behind it.
     *
     * The left-hand side is computed here from SR and STEMS.length rather than
     * read back out of `bytesForSeconds`, so this is a check of the function
     * against the physics and not of the function against itself.
     */
    const fourMin = bytesForSeconds(240);
    const derived = Math.round(240 * SR) * 4 * STEMS.length + STEMS.length * 44;
    ok(`a 4-minute track is 254.0 MB at 16-bit stereo x ${STEMS.length} stems (was 169.3 at four)`,
      fourMin === derived && Math.abs(fourMin / 1e6 - 254.0) < 0.5,
      `${(fourMin / 1e6).toFixed(3)} MB = ${Math.round(240 * SR)} frames x 4 B x ${STEMS.length} + ${STEMS.length} x 44 B`);
    /**
     * 4 GiB / 254 016 264 B = 16.91 -> 16 tracks. It was 25 at four stems.
     * AUDIO.md §8.3's table computes against 4 DECIMAL GB and is still written
     * for four stems (169 MB / 24 tracks); at six stems the decimal figure is
     * 4e9 / 254 016 264 = 15.75 -> 15. Both units are pinned so nobody
     * "corrects" one to match the other, and so the doc pass has the number.
     */
    ok('the 4 GiB cap therefore holds 16 tracks, not the 25 it held at four stems',
      Math.floor(STEM_CACHE_MAX_BYTES / fourMin) === 16 &&
      Math.floor(4e9 / fourMin) === 15,
      `${Math.floor(STEM_CACHE_MAX_BYTES / fourMin)} tracks in ${(STEM_CACHE_MAX_BYTES / 2 ** 30).toFixed(0)} GiB, ` +
      `${Math.floor(4e9 / fourMin)} in 4 decimal GB`);
    // 8 = 16/2 exactly, which is the whole argument for 16-bit and is the one
    // part of this block that stem count cannot move.
    ok('32-bit float would have held half as many, 8 not 16 (why the cache is 16-bit)',
      Math.floor(STEM_CACHE_MAX_BYTES / (fourMin * 2)) === 8 &&
      Math.floor(STEM_CACHE_MAX_BYTES / (fourMin * 2)) * 2 === Math.floor(STEM_CACHE_MAX_BYTES / fourMin),
      `${Math.floor(STEM_CACHE_MAX_BYTES / (fourMin * 2))} tracks at 32f`);
  }

  head('cache — the writer accumulates hops and refuses to commit a broken prime');
  {
    try {
      const w = new CacheWriter('k', { videoId: 'v' });
      // TWELVE planes, one per stem channel. Each carries its own value so a
      // plane-to-stem mapping error is a wrong number rather than a wrong length.
      const planes = Array.from({ length: STEMS.length * 2 }, (_, q) => new Float32Array(100).fill((q + 1) / 10));
      w.append(planes, 100);
      w.append(planes, 60);                       // a short final hop
      ok('frames accumulate across hops', w.frames === 160, `${w.frames}`);
      const st = w.stems();
      ok(`all ${STEMS.length} stems come back with both channels at the right length`,
        Object.keys(st).length === STEMS.length &&
        STEMS.every((s) => st[s].length === 2 && st[s][0].length === 160),
        Object.keys(st).join(','));
      /**
       * WIDENED, NOT SPOT-CHECKED. The four-stem form asserted drums (planes 0/1)
       * and vocals (6/7) and inferred the rest. At six stems the two planes that
       * can be wrong without either of those noticing are precisely the new ones —
       * guitar at 8/9 and piano at 10/11 — so the mapping is now asserted for
       * EVERY stem, `planes[2k]` -> L and `planes[2k+1]` -> R.
       * (Folded in from TRACK A's isolation suite.)
       */
      const wrong = STEMS.filter((s, k) =>
        Math.abs(st[s][0][0] - (planeL(k) + 1) / 10) > 1e-6 ||
        Math.abs(st[s][1][0] - (planeR(k) + 1) / 10) > 1e-6);
      ok('every stem reads back plane pair 2k / 2k+1, L then R — guitar is 8/9, piano 10/11, no off-by-two',
        wrong.length === 0,
        STEMS.map((s, k) => `${s}=${st[s][0][0].toFixed(1)}/${st[s][1][0].toFixed(1)}`).join(' '));
      ok('a short final hop is not padded out', st.bass[0][159] !== 0 && st.bass[0].length === 160);
      /**
       * THE REFUSAL, and it is the one that keeps the widening from arriving
       * half-done. An 8-plane caller would cache four stems, COMMIT, and read back
       * later as a track that is silently missing its guitar and piano — the
       * silently-stale entry this whole file exists to prevent, with nothing in
       * the UI able to tell you. (Folded in from TRACK A's isolation suite.)
       */
      let shortAppend = '';
      try { new CacheWriter('k', {}).append(planes.slice(0, 8), 100); } catch (e) { shortAppend = e.message; }
      ok('append() REFUSES an 8-plane call rather than caching four stems and committing',
        new RegExp(`needs ${STEMS.length * 2} planes for ${STEMS.length} stems, got 8`).test(shortAppend),
        shortAppend || '(did not throw)');
      w.abort();
      ok('an aborted prime holds nothing and cannot commit', w.frames === 0);
    } catch (e) {
      blockThrew('cache — the writer accumulates hops and refuses to commit a broken prime', e);
    }
  }

  head('cache — eviction is strict LRU, predictable, and never touches the playing track');
  {
    // The 169 MB below is a SYNTHETIC FIXTURE SIZE, not the per-track figure —
    // planEviction is pure LRU and knows nothing about stems, so the caps here
    // are chosen to make the ordering unambiguous and deliberately do NOT track
    // the 254 MB derived above.
    const MB = 1e6;
    const E = (key, usedAt, mb) => ({ key, usedAt, bytes: mb * MB, title: key });
    const four = [E('oldest', 100, 169), E('old', 200, 169), E('recent', 300, 169), E('newest', 400, 169)];
    ok('nothing is removed while under the cap',
      planEviction(four, 1000 * MB).removed.length === 0);
    ok('over the cap, the OLDEST-USED goes first',
      planEviction(four, 520 * MB).removed.map((e) => e.key).join(',') === 'oldest',
      `cap 520 MB of 676 MB used -> removes ${planEviction(four, 520 * MB).removed.map((e) => e.key).join(',')}`);
    ok('and it removes only as many as it needs to',
      planEviction(four, 350 * MB).removed.map((e) => e.key).join(',') === 'oldest,old');
    ok('the PINNED (playing) track is never a candidate, even if it is oldest',
      planEviction(four, 350 * MB, 'oldest').removed.map((e) => e.key).join(',') === 'old,recent',
      planEviction(four, 350 * MB, 'oldest').removed.map((e) => e.key).join(','));
    ok('it reports what it removed, so the UI can say so rather than silently drop a prepared set',
      planEviction(four, 350 * MB).removed.every((e) => e.key && e.bytes > 0 && e.title));
    ok('a cap smaller than the pinned track is reported, not silently violated',
      planEviction(four, 10 * MB, 'newest').wouldExceed === true &&
      planEviction(four, 10 * MB, 'newest').bytes === 169 * MB);
    // determinism matters: a prime that finishes and is played lands in the same ms
    const tie = [E('b', 100, 169), E('a', 100, 169), E('c', 500, 169)];
    ok('ties are broken deterministically by key, not by array order',
      planEviction(tie, 200 * MB).removed.map((e) => e.key).join(',') ===
      planEviction(tie.slice().reverse(), 200 * MB).removed.map((e) => e.key).join(','),
      planEviction(tie, 200 * MB).removed.map((e) => e.key).join(','));
  }

  head('cache — a cached deck streams from memory and has none of the live machinery');
  if (typeof SharedArrayBuffer !== 'function') {
    ok('SharedArrayBuffer available', false, 'not in this node build');
  } else {
    /**
     * REACHABLE for fill/transport: this drives the real CachedDeck against a
     * real StemRingWriter. `ensureGraph()` is stubbed because it needs an
     * AudioWorkletNode; what that hides is only the wiring, and the browser
     * check covers it once measurement is cleared.
     */
    const { StemRingWriter, stemRingByteLength } = await import('./extension/shared/stemring.js');
    const { STEM_RING_FRAMES } = await import('./extension/shared/config.js');
    const sent = [];
    const mkDeck = () => {
      const d = new CachedDeck('A', {
        ctx: () => ({ outputLatency: 0.048 }),
        master: () => ({ build: async () => ({ input: () => ({}) }) }),
        send: (m) => sent.push(m), log: () => {},
        // The Host's asset resolver, which `ensureGraph()` uses to find the
        // playback worklet. Stubbed rather than omitted: `ensureGraph` is
        // replaced below, so leaving it out would let this stub drift out of
        // step with the bundle `offscreen/engine.js` really hands over and
        // nothing here would notice. The graph builder's real use of it is
        // driven in the `host` group.
        assetUrl: (relPath) => `stub://unit/${relPath}`,
      });
      d.ensureGraph = async () => {
        d.out = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(STEM_RING_FRAMES)), STEM_RING_FRAMES);
        d.node = { port: { postMessage: () => {} } };
        d.planes = Array.from({ length: RING_PLANES }, () => new Float32Array(65536));
      };
      return d;
    };
    const track = (frames) => {
      const stems = {};
      STEMS.forEach((s2, k) => {
        stems[s2] = [0, 1].map((c) => {
          const a = new Float32Array(frames);
          for (let i = 0; i < frames; i++) a[i] = ((k * 2 + c + 1) / 10) * Math.sin(i / 50);
          return a;
        });
      });
      return { stems, frames, meta: { videoId: 'v', title: 't' } };
    };

    const FR = 44100 * 60;               // a minute: far bigger than the ring
    const d = mkDeck();
    await d.load(track(FR));
    ok('loading buffers ahead WITHOUT loading the track whole',
      d.out.writeFrames() > 44100 && d.out.writeFrames() < FR && d.writeHead === d.out.writeFrames(),
      `${d.out.writeFrames()} of ${FR} frames buffered, ring cap ${d.out.cap}`);
    ok('it buffers about the configured look-ahead, not the whole ring',
      Math.abs(d.out.writeFrames() / SR - 4) < 0.2, `${(d.out.writeFrames() / SR).toFixed(2)} s`);
    ok('nothing is playing until play() — load does not start audio',
      d.status === 'loaded' && d.out.playing() === false);

    /**
     * WIDENED PER STEM. The four-stem form checked plane 0 (drums.L) and plane 7
     * (vocals.R) and inferred the six planes between them. `vocals` is still at
     * index 3 so plane 7 is still vocals.R — which means that assertion stayed
     * GREEN at six stems while saying nothing at all about guitar (8/9) or piano
     * (10/11). Every stem is now named.
     */
    const ref = track(200).stems;
    const misplaced = STEMS.filter((s) =>
      Math.abs(d.out.planes[planeL(S_IDX[s])][100] - ref[s][0][100]) > 1e-4 ||
      Math.abs(d.out.planes[planeR(S_IDX[s])][100] - ref[s][1][100]) > 1e-4);
    ok('every stem lands on its own plane pair, model order, L then R',
      misplaced.length === 0, misplaced.length ? `wrong: ${misplaced.join(',')}` : `${STEMS.length}/${STEMS.length}`);
    ok('the passthrough planes (12/13, not 8/9) stay silent — nothing was skipped, ' +
       'so there is nothing to substitute (a cached deck has no ladder)',
      d.out.planes[PASS_PLANE_L][1000] === 0 && d.out.planes[PASS_PLANE_R][1000] === 0 &&
      PASS_PLANE_L === 12);

    d.play();
    ok('play() starts the worklet consuming', d.status === 'playing' && d.out.playing());
    // drain the way the worklet does, then let the timer's work happen
    Atomics.store(d.out.hdr, 1, d.out.readFrames() + 44100 * 2);
    const beforeHead = d.writeHead;
    d.fill();
    ok('it tops up as the worklet consumes, and stays near the look-ahead',
      d.writeHead > beforeHead && Math.abs(d.out.cushion() / SR - 4) < 0.3,
      `head ${beforeHead} -> ${d.writeHead}, cushion ${(d.out.cushion() / SR).toFixed(2)} s`);
    ok('the transport position follows the READ pointer, not the write head',
      Math.abs(d.positionSec() - 2) < 0.01, `${d.positionSec().toFixed(3)} s`);

    d.seek(30);
    ok('seek repositions and refills (a live deck cannot do this — it would have ' +
       'to re-run the model over the new causal window first)',
      d.writeHead > 30 * SR && Math.abs(d.positionSec() - 30) < 0.01,
      `position ${d.positionSec().toFixed(2)} s, head ${(d.writeHead / SR).toFixed(2)} s`);
    ok('and it is still playing after the seek', d.out.playing());

    /**
     * AMENDED 2026-08-15. The old form asserted `latencySec() === 0.048` under the
     * name "the output buffer and NOTHING else", and it went red the day the
     * shared `stem-playback` worklet grew transpose lanes. THE CODE WAS RIGHT: a
     * cached deck now genuinely carries PITCH_GROUP_DELAY_SAMPLES / SR = 69.7 ms
     * of group delay at EVERY setting including 0 (the drums take a matched
     * delay, which is what keeps the four planes aligned), and cacheddeck.js
     * reports it because ui/audio-math.js::syncCorrection locks the video to this
     * number against a 60 ms threshold — omitting a constant 69.7 ms would not be
     * a rounding error, it would be a permanent one-sided correction.
     *
     * So the PREMISE was stale, not the check, and the replacement keeps every
     * tooth the original had. It is still an EQUALITY to 1e-9, so it admits
     * exactly two terms and nothing else: any leak makes it red by four to six
     * orders of magnitude past the tolerance. What it rejects, in the units it
     * would be wrong by —
     *   a hop         (1.95 s at the default) -> off by 1.95, 2e9 x tolerance
     *   a cushion     (LIVE_CUSHION_SEC 0.4)  -> off by 0.40, 4e8 x tolerance
     *   an inference  (~0.74 s of T_inf)      -> off by 0.74, 7e8 x tolerance
     *   a SECOND group delay (double-counted) -> off by 0.0697, 7e7 x tolerance
     *   the group delay dropped altogether    -> off by 0.0697, same
     * and the last two are the ones the old form could not see at all: it would
     * have gone green on a build that silently stopped applying the transpose
     * delay, which is the build the video lock breaks on.
     *
     * ENTRY POINT: CachedDeck.latencySec(). LivePipeline has a same-named method
     * with a different contract (it adds the capture-to-playhead counter
     * difference) and this says nothing about it.
     */
    ok('a cached deck\'s latency is the output buffer plus the transpose group ' +
       'delay and nothing else — no hop, no cushion, no inference',
      Math.abs(d.latencySec() - (0.048 + PITCH_GROUP_DELAY_SAMPLES / SR)) < 1e-9,
      `${(d.latencySec() * 1000).toFixed(1)} ms = 48.0 out + ${(PITCH_GROUP_DELAY_SAMPLES / SR * 1000).toFixed(1)} transpose`);
    const st = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
    ok('its LIVE_STATE has the same shape as a live deck, with the inapplicable ' +
       'fields pinned to "not applicable"',
      st && st.source === 'cache' && st.hopSec === null && st.drops === 0 &&
      st.passthroughNow === false && st.primedPct === 1 && st.durationSec === 60,
      st ? JSON.stringify({ source: st.source, hopSec: st.hopSec, drops: st.drops, dur: st.durationSec }) : 'none');
    /**
     * `atMs` is what makes `positionSec` usable by the video lock — without it
     * the reader cannot tell a 5 ms-old sample from a 95 ms-old one, and the
     * difference is larger than syncCorrection's whole threshold. Asserted as a
     * PRESENT, PLAUSIBLE timestamp: `st.atMs != null` alone would pass on a
     * hard-coded 0, which is precisely the sample age it would then claim.
     */
    ok('every LIVE_STATE stamps WHEN the playhead was sampled, on the wall clock ' +
       'the page also has (Date.now, not performance.now)',
      st && Number.isFinite(st.atMs) && Math.abs(st.atMs - Date.now()) < 60_000,
      st ? `atMs ${st.atMs} vs now ${Date.now()}` : 'none');

    /**
     * ENTRY POINT: offscreen/engine.js reconcileMaster(), which applies the dual-deck
     * trim the moment a second deck loads — and for a cached deck that can be
     * BEFORE ensureGraph() has built the node. The live pipeline learned this
     * the expensive way: -3 dB in the field, unity in the worklet.
     */
    const d4 = mkDeck();
    d4.setMasterGain(-3, true);
    ok('a master gain set BEFORE the graph exists is stored, not dropped',
      d4.masterDb === -3 && d4.masterAuto === true && d4.masterUserSet === false);
    const posted = [];
    await d4.load(track(20000));
    d4.node.port.postMessage = (x) => posted.push(x);
    d4.pushMaster();
    // Slot G_MASTER = STEMS.length + 1 = 7. It was 5 at four stems — and 5 is
    // now the PIANO stem, so the literal would have latched -3 dB onto a stem
    // fader and reported the master as pushed.
    ok(`...and load() pushes it on slot ${G_MASTER}, so the worklet ends up agreeing with the field`,
      posted.some((x) => x.t === 'gain' && x.i === G_MASTER && Math.abs(x.value - Math.pow(10, -3 / 20)) < 1e-9),
      JSON.stringify(posted));
    d4.setMasterGain(-6, false);
    ok('a USER master gain latches masterUserSet, so the engine default stops ' +
       'moving it — the same latch as the live deck',
      d4.masterUserSet === true && d4.masterAuto === false && d4.masterDb === -6);

    // end of track
    const d2 = mkDeck();
    await d2.load(track(20000));
    d2.play();
    Atomics.store(d2.out.hdr, 1, 20000);
    d2.fill();
    ok('a track that runs out ends cleanly rather than starving',
      d2.status === 'ended' && d2.out.playing() === false, d2.status);

    const d3 = mkDeck();
    let threw = null;
    try { await d3.load({ stems: { drums: [new Float32Array(10)] }, frames: 10, meta: {} }); } catch (e) { threw = e; }
    ok('a malformed entry is refused at load, not discovered mid-playback',
      threw !== null && /stem/.test(threw.message), threw ? threw.message : 'accepted');

    /**
     * REACHABLE, and that is the whole reason this block exists rather than more
     * assertions inside `extension/engine/bpmtap.js`. That file proves the
     * DETECTOR against a ring it builds itself; the `live` group above proves
     * `offscreen/live.js` wires it. NEITHER of them can see whether a CachedDeck
     * calls `tick()`, hands it THIS deck's ring, puts the payload on the wire, or
     * clears it on the lifecycle — and the cached deck is the one the play-along
     * user is on, because `offscreen/engine.js` swaps deck A to it on a cache hit, i.e.
     * on the SECOND listen to any track.
     *
     * Every assertion below drives the real `CachedDeck` through `load()`,
     * `seek()`, `stop()` and `pushState()` and reads what actually went out on
     * `send`. The deck streams the fixture into its own stem ring through the
     * real `fill()`, so the audio the tap sees got there the way the product puts
     * it there.
     */
    head('cache — the tempo tap: on the wire, on the drums planes, cleared by seek');
    {
      const { BPM_MAX_BLOCKS_PER_TICK, beatPhaseAt } = await import('./extension/engine/bpmtap.js');
      const { KEY_ACCUM_HZ } = await import('./extension/shared/config.js');
      /**
       * cacheddeck.js's own constant, re-typed here on purpose: it is module-
       * private (deliberately — see that file's note on why it is not
       * KEY_ACCUM_HZ). The cadence rows below BRACKET it rather than restate it,
       * so this copy going stale is a red and not a silent agreement.
       */
      const BPM_ACCUM_HZ = 10;

      // ---- a drum kit, not a tone. Same synthesis as bpmtap.js's suite.
      const kick = (buf, at, amp) => {
        const n = Math.round(0.12 * SR);
        for (let i = 0; i < n; i++) {
          const t = i / SR, j = at + i;
          if (j >= 0 && j < buf.length) buf[j] += amp * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t / 0.045);
        }
      };
      const clickTrain = (bpm, sec) => {
        const buf = new Float32Array(Math.round(sec * SR));
        const beat = 60 / bpm * SR;
        for (let b = 0; b * beat < buf.length; b++) kick(buf, Math.round(b * beat), 1.0);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        if (peak > 0) for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / peak;
        return buf;
      };
      /** A cache entry carrying `pcm` on ONE named stem and digital silence on the other five. */
      const stemTrack = (pcm, name) => {
        const frames = pcm.length;
        const quiet = new Float32Array(frames);      // read-only in fill(), so one copy is enough
        const stems = {};
        for (const s of STEMS) stems[s] = [0, 1].map(() => (s === name ? pcm : quiet));
        return { stems, frames, meta: { videoId: 'v', title: name } };
      };

      /**
       * 0.4 s — four 4410-frame blocks, which is `BPM_MAX_BLOCKS_PER_TICK`. The
       * worklet's consumption and the tap's intake advance at the same rate, so
       * the tap is never behind and never asked for audio the fill has not
       * written. That is the real steady state of a cached deck.
       */
      const STEP = 4410 * BPM_MAX_BLOCKS_PER_TICK;
      /**
       * Drive a real CachedDeck the way the product does: load, play, and then
       * drain-and-top-up on the heartbeat. `fill()` is the real one, so the
       * fixture reaches the ring through the same code path a cached track does.
       *
       * Rolling `bpmAt` back ONE PERIOD before each push is deliberate and is NOT
       * the thing under test: it opens the wall-clock gate so a synchronous burst
       * delivers the blocks that a real 0.1 s of wall time would. The gate itself
       * is bracketed separately below, by count, at its own entry point.
       *
       * IT IS `now - period`, NOT `0` — `performance.now()` in node is uptime, so
       * `bpmAt = 0` asks "is the process older than 95 ms?", which is a question
       * about the machine (the `live` group above paid a red for exactly that).
       *
       * `keyTap.tick` is stubbed for cost only: hundreds of 16384-point FFTs for
       * a detector that has its own suite and nothing to do with this claim.
       */
      const driveCached = async (trk) => {
        const d = mkDeck();
        d.keyTap.tick = () => 0;
        sent.length = 0;
        await d.load(trk);
        /**
         * ANCHOR THE CURSOR DETERMINISTICALLY, and this line is here for the same
         * reason `bpmAt` is rolled back to `now - period` rather than set to 0.
         * `load()` sets `bpmAt = 0` and then pushes once; in node
         * `performance.now()` is UPTIME, so whether that push feeds the tap
         * depends on whether the process happens to be older than the 95 ms gate
         * — which differs between `node test.js` and `node test.js cache`. Fed,
         * the cursor anchors at the 4 s `load()` buffered; refused, it anchors one
         * block later on the first loop iteration, and the whole estimate schedule
         * shifts. Neither is wrong and the difference is invisible in a browser
         * (a real document is seconds old before a deck loads), but it would make
         * this block's printed evidence a function of the machine. One forced,
         * gate-open push pins it.
         */
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.pushState();
        d.play();
        let pushes = 0;
        while (d.writeHead + STEP < trk.frames) {
          Atomics.store(d.out.hdr, H_READ, d.out.readFrames() + STEP);
          d.fill();
          d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
          d.pushState();
          pushes++;
        }
        return { d, pushes, last: sent.filter((m) => m.type === 'LIVE_STATE').at(-1) };
      };

      const CONTRACT = ['state', 'bpm', 'confidence', 'beatFrame'];
      const TOL = 1.5;   // bpmtap.js's own tolerance: one 0.25 lag step at the fast end
      /**
       * The `bpm` payload of a LIVE_STATE, or null. Every row below is written
       * `!!bpmOf(m) && <check>` and NEVER `!bpmOf(m) || <check>`: a message that
       * does not carry the field is the failure this block exists to prevent, not
       * an excuse from checking (AGENTS.md, "an assertion must FAIL when it cannot
       * look"). It is a helper rather than an inline guard so that a build with
       * the field deleted goes RED on every row that reads it, instead of going
       * red on two and then throwing a TypeError that takes the remaining
       * assertions — and the rest of the `cache` group — with it. A crash is loud
       * but it is not a verdict, and it denies one to everything after it.
       */
      const bpmOf = (m) => (m && m.bpm) || null;
      const a128 = await driveCached(stemTrack(clickTrain(128, 26), 'drums'));
      const b92 = await driveCached(stemTrack(clickTrain(92, 26), 'drums'));

      ok('a CachedDeck\'s LIVE_STATE carries `bpm`, and it is the four-field contract with a state the UI can switch on',
        !!bpmOf(a128.last) && CONTRACT.every((k) => k in a128.last.bpm) &&
        ['none', 'listening', 'locked', 'fault'].includes(a128.last.bpm.state),
        bpmOf(a128.last) ? JSON.stringify(a128.last.bpm) : `NO bpm FIELD in the last of ${sent.length} messages`);
      {
        // LIVE_STATE crosses chrome.runtime, which is JSON. `undefined` and NaN
        // both survive the assertion above and neither survives the wire.
        const round = a128.last ? JSON.parse(JSON.stringify(a128.last)) : null;
        ok('...and it JSON round-trips unchanged (no undefined, no NaN, no bigint)',
          !!bpmOf(round) && !!bpmOf(a128.last) && JSON.stringify(round.bpm) === JSON.stringify(a128.last.bpm) &&
          CONTRACT.every((k) => round.bpm[k] === null || !Number.isNaN(round.bpm[k])),
          bpmOf(round) ? JSON.stringify(round.bpm) : 'nothing to round-trip');
      }
      // THE HYPOTHESIS: the wire number comes from THIS deck's drums planes.
      ok('a 128 BPM cached track locks, and the number reaches the wire',
        !!bpmOf(a128.last) && a128.last.bpm.state === 'locked' && Math.abs(a128.last.bpm.bpm - 128) <= TOL,
        bpmOf(a128.last) ? `read ${a128.last.bpm.bpm} against 128.00, tol ±${TOL}, conf ${a128.last.bpm.confidence}, over ${a128.pushes} heartbeats` : 'no bpm on the wire');
      /**
       * THE CONTROL, AND IT CAN LOSE. A `bpm` field wired to a constant, echoed
       * from the live deck, or read off some other ring passes the row above and
       * fails this one — the two decks run identical code and differ only in the
       * audio their own `fill()` published.
       */
      ok('a second cached track at 92 BPM reports 92, so the wire value tracks THIS deck\'s ring and not the harness',
        !!bpmOf(b92.last) && !!bpmOf(a128.last) && b92.last.bpm.state === 'locked' &&
        a128.last.bpm.bpm !== null && Math.abs(b92.last.bpm.bpm - 92) <= TOL &&
        Math.abs((a128.last.bpm.bpm - b92.last.bpm.bpm) - 36) <= 2 * TOL,
        bpmOf(b92.last) && bpmOf(a128.last) ? `128 - 92 = 36.00 true, ${a128.last.bpm.bpm} - ${b92.last.bpm.bpm} = ${(a128.last.bpm.bpm - b92.last.bpm.bpm).toFixed(2)} read` : 'no bpm on the wire');
      /**
       * THE TAP POINT, and this control can lose too. The identical stimulus on
       * `other` (planes 4/5, the KEY tap's planes) must produce no tempo at all.
       * A wiring that handed BpmTap the wrong planes, the passthrough pair or a
       * mono mix passes one of these two rows and fails the other; there is no
       * wiring that passes both except the right one.
       */
      {
        const wrong = await driveCached(stemTrack(clickTrain(128, 26), 'other'));
        ok('the same drums published on the `other` stem produce NO tempo — the tap is on drums, on this deck\'s stem ring',
          !!bpmOf(wrong.last) && wrong.last.bpm.state === 'none' && wrong.last.bpm.bpm === null &&
          wrong.d.bpmTap.stats().audibleBlocks === 0 && wrong.d.bpmTap.stats().blocks > 100,
          bpmOf(wrong.last) ? `${JSON.stringify(wrong.last.bpm)} after ${wrong.d.bpmTap.stats().blocks} blocks read, ${wrong.d.bpmTap.stats().audibleBlocks} audible` : 'no bpm on the wire');
      }
      // The consumer's only entry point into `beatFrame`, driven off the wire
      // value rather than off the tap, because the wire is what the UI gets.
      // NOTE the frame is on the RING clock, not the track clock — the two differ
      // by `readBase` after a seek, and beatPhaseAt is invariant to that.
      ok('beatPhaseAt() reads the cached deck\'s wire payload straight: 0 on the beat, 0.5 half a beat later',
        (() => {
          const p = bpmOf(a128.last);
          if (!p || p.beatFrame === null || p.bpm === null) return false;
          const period = 60 / p.bpm * SR;
          return beatPhaseAt(p, p.beatFrame, SR) === 0 &&
            Math.abs(beatPhaseAt(p, p.beatFrame + period / 2, SR) - 0.5) < 0.01;
        })(),
        bpmOf(a128.last) ? `beatFrame ${a128.last.bpm.beatFrame}` : 'no bpm on the wire');

      /**
       * ============================ THE PLAYHEAD THE PHASE IS MEASURED AGAINST
       *
       * ENTRY POINT: `CachedDeck.pushState()`, the same publisher every row above
       * reads — `a128.last` is the last LIVE_STATE the 128 BPM cached run actually
       * put on the wire. The live deck's identical claim lives in the `live` group
       * at its own entry point (`LivePipeline.pushState`); this one is here
       * because `offscreen/engine.js` swaps deck A to a CachedDeck on a cache hit, so the
       * embed reaches THIS file on the second listen to any track, and a pulse
       * that works on first play and is dead on replay is the failure this row
       * exists to prevent.
       *
       * IT IS THE OUTPUT RING'S *READ* COUNTER, on the axis `bpm.beatFrame` is on.
       * Not the write head, and not the track position in frames.
       *
       * THE CONTROL CAN LOSE — against the write head, here. `driveCached` drains
       * and tops up, so the ring carries seconds of cushion and the two counters
       * are far apart: a `playFrames` wired to `writeFrames()` passes every "the
       * field is present and finite" test and fails this one. The THIRD competing
       * quantity, `positionSec * SR`, coincides with the read counter on this run
       * because `readBase` is 0 until something seeks — so it is REPORTED here
       * rather than asserted, and the discrimination that can lose against it is
       * the post-seek row below. A row that cannot separate two quantities must
       * say so instead of scoring the coincidence as evidence.
       */
      ok('a CachedDeck\'s LIVE_STATE.playFrames is the deck output ring\'s READ counter, not its write head',
        !!a128.last && a128.last.playFrames === a128.d.out.readFrames()
          && a128.last.playFrames !== a128.d.out.writeFrames(),
        a128.last
          ? `wire ${a128.last.playFrames}, readFrames() ${a128.d.out.readFrames()}, ` +
            `writeFrames() ${a128.d.out.writeFrames()}, heads ` +
            `${((a128.d.out.writeFrames() - a128.d.out.readFrames()) / SR).toFixed(2)} s apart; ` +
            `positionSec*SR ${Math.round(a128.last.positionSec * SR)} COINCIDES here ` +
            `(readBase ${a128.d.readBase}) — separated after a seek, below`
          : 'no LIVE_STATE');

      /**
       * ...AND THE PAIR COMPOSES INTO A PHASE. ENTRY POINT: `beatPhaseAt(payload,
       * frame, sr)` fed the way `embed.js::beatFrameNow()` feeds it — the wire
       * playhead advanced by the age of its own timestamp. Asserting the two
       * fields are merely PRESENT is not asserting the pulse can run, so this row
       * runs the composition and reads a phase back.
       *
       * `atMs` IS A `Date.now()`-SCALE WALL CLOCK, and that is the claim. The
       * offscreen document and the page have different `performance` time origins,
       * so their `performance.now()` values cannot be differenced; the epoch is
       * the one clock they share. The bound is deliberately loose and epoch-scale
       * — a `performance.now()`-scale value is process uptime and misses an epoch
       * bound by decades, while any real publish lag clears it. A tight bound here
       * would be a stopwatch claim wearing this row's name, and AGENTS.md says a
       * stopwatch measures the machine. On the live side the wrong clock still
       * produced a plausible-looking phase; only the epoch check rejected it.
       */
      {
        const AGE_BOUND_SEC = 60;
        const m = a128.last;
        const ageSec = m ? (Date.now() - Number(m.atMs)) / 1000 : NaN;
        const frame = m ? Number(m.playFrames) + ageSec * SR : NaN;
        const phase = m ? beatPhaseAt(m.bpm, frame, SR) : null;
        ok('a cached deck\'s (playFrames, atMs) pair composes into a real beat phase — one wall clock, one frame axis',
          !!m && Number.isFinite(ageSec) && ageSec >= 0 && ageSec < AGE_BOUND_SEC
            && Number.isFinite(frame) && typeof phase === 'number' && phase >= 0 && phase < 1,
          m ? `atMs age ${ageSec.toFixed(3)} s against a ${AGE_BOUND_SEC} s clock-scale bound, ` +
              `frame ${m.playFrames} advanced to ${frame.toFixed(0)}, phase ${phase}`
            : 'no LIVE_STATE');
      }

      /**
       * AND IT MUST FAIL WHEN IT CANNOT LOOK. ENTRY POINT: `pushState()` on a
       * cached deck that has not loaded — no `ensureGraph()`, so no output ring.
       * That is the state deck A is in for every push between the swap and the
       * first `load()`.
       *
       * ABSENT, NEVER ZEROED. Frame 0 is a real position the ring takes at the
       * start of every run (and immediately after every seek — see below), and
       * `embed.js::beatFrameNow()` discriminates on `Number.isFinite`, so a zeroed
       * field would light the pulse against a playhead nobody sampled. `atMs` is
       * asserted finite in the same row because "the message went out at all" is
       * what makes the missing field evidence of a decision rather than of a
       * dropped publish.
       */
      {
        const d = mkDeck();          // never loaded: out === null
        sent.length = 0;
        d.pushState();
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a cached deck with no output ring OMITS playFrames — absent, never zeroed — and still timestamps the message',
          !!m && !('playFrames' in m) && Number.isFinite(m.atMs)
            && !Number.isFinite(Number(m.playFrames)),
          m ? `playhead keys on the wire ${JSON.stringify(Object.keys(m).filter((k) => /play/i.test(k)))}, ` +
              `Number(m.playFrames) ${String(Number(m.playFrames))}, atMs ${m.atMs}`
            : `no LIVE_STATE in ${sent.length} messages`);
      }

      /**
       * A SEEK MUST NOT LEAVE A STALE PLAYHEAD, and this is the row where the
       * three candidate quantities are finally SEPARATED. ENTRY POINT:
       * `CachedDeck.seek()`, which is the cached deck's primary gesture.
       *
       * `seek()` calls `out.reset()` — both ring counters go back to 0 — and moves
       * `readBase` to the new position. So after seeking to 5 s of a track played
       * to ~20 s, the three quantities that could be published under this name are
       * hundreds of thousands of frames apart:
       *
       *   readFrames()            0        the ring axis, which `beatFrame` is on
       *   the pre-seek playhead   ~20 s    what a stale field would still say
       *   positionSec * SR        ~5 s     the TRACK axis, `readBase + read`
       *
       * and the tempo tap is reset in the same breath, so both sides of the phase
       * restart together. A publisher wired to `readBase + readFrames()` or to
       * `positionSec * SR` is red here and green everywhere else in this group.
       *
       * The `0` is also why the omission above is written `=== null` and not a
       * falsy test: frame 0 is a REAL sample here and must reach the wire.
       */
      {
        const d = mkDeck();
        d.keyTap.tick = () => 0;
        await d.load(stemTrack(clickTrain(128, 40), 'drums'));
        d.play();
        // consume 20 s the way the worklet does, topping the ring up each second
        for (let i = 0; i < 20; i++) {
          Atomics.store(d.out.hdr, H_READ, d.out.readFrames() + SR);
          d.fill();
        }
        sent.length = 0;
        d.pushState();
        const before = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        d.seek(5);
        const after = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        const trackFrames = Math.round(after ? after.positionSec * SR : NaN);
        ok('a seek republishes the playhead on the RING axis — 0, present, and neither the pre-seek frame nor the track position',
          !!before && !!after && before.playFrames > 10 * SR &&
          'playFrames' in after && after.playFrames === d.out.readFrames() &&
          after.playFrames === 0 && Math.abs(trackFrames - 5 * SR) < SR &&
          d.readBase === 5 * SR,
          before && after
            ? `playFrames ${before.playFrames} -> ${after.playFrames} (readFrames() ${d.out.readFrames()}), ` +
              `while positionSec*SR is ${trackFrames} and readBase is ${d.readBase} — ` +
              `ring axis and track axis ${((trackFrames - after.playFrames) / SR).toFixed(2)} s apart`
            : 'no LIVE_STATE');
      }

      /**
       * THE COST, AS A COUNT AND NEVER AS A CLOCK (AGENTS.md: a gate whose verdict
       * changes on code that did not change is measuring the machine). The bound
       * that keeps this off the fill timer is "a tick does a fixed, small amount
       * of work however far the fill loop ran ahead", and that is countable
       * exactly. Read off the real run, not a fresh tap.
       */
      ok('the whole cached run never consumed more than the per-tick block cap, however far fill() jumped ahead',
        a128.d.bpmTap.stats().blocks > 100 && a128.d.bpmTap.lastTickBlocks <= BPM_MAX_BLOCKS_PER_TICK &&
        a128.d.bpmTap.stats().staleBlocks === 0,
        `${a128.d.bpmTap.stats().blocks} blocks over ${a128.d.bpmTap.stats().estimates} estimates, ` +
        `last tick ${a128.d.bpmTap.lastTickBlocks} against a cap of ${BPM_MAX_BLOCKS_PER_TICK}, ${a128.d.bpmTap.stats().staleBlocks} stale`);

      // ======================================================= THE SEEK CASE
      /**
       * THE REASON THIS WHOLE BLOCK EXISTS. Seeking is the cached deck's primary
       * gesture — it is the deck that CAN seek, which is why the play-along user
       * is on it — and `seek()` calls `out.reset()`, which puts the ring's write
       * pointer back to 0 while the tap's cursor is still a million frames ahead.
       * `w - cursor` is then NEGATIVE: the catch-up threshold cannot fire, the
       * `cursor + n <= w` loop never runs, no block is read, no refusal is
       * counted and no `envBreak` is recorded. A tap that was not reset here goes
       * on reporting the PRE-SEEK tempo forever with clean-looking stats.
       *
       * REACHABLE: this drives the real `seek()`, not `bpmTap.reset()`. An
       * implementation with the reset line deleted passes every row above.
       */
      {
        const d = a128.d;
        const before = d.bpmPayload();
        const cursorBefore = d.bpmTap.cursor;
        const writeBefore = d.out.writeFrames();
        const filledBefore = d.bpmTap.stats().filled;
        sent.length = 0;
        d.seek(5);
        const duringSeek = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        // the next heartbeat, which is where the cursor re-anchors on the new ring
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.pushState();
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);

        ok('seek() puts the write pointer BEHIND the tap\'s cursor — the state the silent-hold failure needs',
          writeBefore > 0 && cursorBefore > 0 && filledBefore > 0 && d.out.writeFrames() < cursorBefore,
          `write ${writeBefore} -> ${d.out.writeFrames()}, cursor was ${cursorBefore}, ${filledBefore} envelope samples held`);
        /**
         * `cursor` is NOT asserted null: the heartbeat above re-anchors it on the
         * new ring, and that RE-ANCHORING is the property that matters. Left at
         * the old position's value it would sit permanently ahead of a write
         * pointer that restarted at 0. So the claim is that it came back BELOW
         * where it was — an implementation that drops the envelope and leaks the
         * cursor passes `filled === 0` and fails here.
         */
        ok('cached-seek-clears-the-tempo-tap: a seek drops the locked tempo, the envelope AND the cursor',
          before.state === 'locked' && !!bpmOf(after) && after.bpm.state === 'none' &&
          after.bpm.bpm === null && after.bpm.beatFrame === null &&
          d.bpmTap.stats().filled === 0 && d.bpmTap.stats().audibleBlocks === 0 &&
          d.bpmTap.stats().cursor !== null && d.bpmTap.stats().cursor < cursorBefore,
          `${before.state} ${before.bpm} -> ${bpmOf(after) ? after.bpm.state + ' ' + after.bpm.bpm : 'NO bpm ON THE WIRE'}, ` +
          `${filledBefore} -> ${d.bpmTap.stats().filled} envelope samples, cursor ${cursorBefore} -> ${d.bpmTap.stats().cursor}`);
        /**
         * product ruling 8, at the `seek()` entry point. The message `seek()` itself
         * publishes must ALREADY be clear: the reset lines sit above the
         * `pushState()` at the bottom of that method, so there is no window in
         * which the wire carries the pre-seek tempo against a post-seek playhead.
         * Move the reset below the push and this row goes red on its own.
         */
        ok('...and the LIVE_STATE seek() itself emits is already clear — no window where the wire pairs the old tempo with the new playhead',
          !!bpmOf(duringSeek) && duringSeek.bpm.state === 'none' && duringSeek.bpm.bpm === null,
          bpmOf(duringSeek) ? `${JSON.stringify(duringSeek.bpm)} at position ${duringSeek.positionSec} s` : 'no bpm on the LIVE_STATE seek() emitted');
      }

      // ================================================= the track change
      /**
       * Same mechanism, different entry point (AGENTS.md: an assertion about a
       * function with more than one caller must name the entry point). `load()`
       * also calls `out.reset()`, and a BPM held over from the previous track is
       * a WRONG readout rather than a stale one — and a correct-looking one.
       */
      {
        const d = b92.d;
        const before = d.bpmPayload();
        const cursorBefore = d.bpmTap.cursor;
        sent.length = 0;
        await d.load(stemTrack(clickTrain(128, 6), 'drums'));
        const duringLoad = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.pushState();
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        ok('cached-load-clears-the-tempo-tap: a new track reports `none`, not the previous track\'s BPM',
          before.state === 'locked' && !!bpmOf(after) && after.bpm.state === 'none' && after.bpm.bpm === null &&
          d.bpmTap.stats().filled === 0 && d.bpmTap.stats().cursor !== null &&
          d.bpmTap.stats().cursor < cursorBefore,
          `${before.state} ${before.bpm} -> ${bpmOf(after) ? after.bpm.state + ' ' + after.bpm.bpm : 'NO bpm ON THE WIRE'}, cursor ${cursorBefore} -> ${d.bpmTap.stats().cursor}`);
        /**
         * product ruling 8 at the `load()` entry point, and this is the row that
         * would have caught the live deck's priming-window carry-over. `load()`
         * emits exactly one LIVE_STATE and every reset precedes it, so the
         * previous track's tempo can never appear beside the new track's title.
         */
        ok('cached-load-emits-no-previous-track-bpm: the LIVE_STATE load() emits is already the new track\'s',
          !!bpmOf(duringLoad) && duringLoad.bpm.state === 'none' && duringLoad.bpm.bpm === null &&
          duringLoad.durationSec === 6,
          bpmOf(duringLoad) ? `${JSON.stringify(duringLoad.bpm)} on a ${duringLoad.durationSec} s track` : 'no bpm on the LIVE_STATE load() emitted');
      }
      {
        // stop() is the third lifecycle site, and the one that leaves the deck
        // idle with the field still on the wire.
        const { d } = await driveCached(stemTrack(clickTrain(128, 26), 'drums'));
        const before = d.bpmPayload();
        sent.length = 0;
        d.stop();
        const after = sent.filter((m) => m.type === 'LIVE_STATE').at(-1);
        ok('stop() clears it too, and an idle deck still PUBLISHES the field — a missing `bpm` is not "no tempo" to a UI, it is whatever it painted last',
          before.state === 'locked' && !!bpmOf(after) && after.bpm.state === 'none' &&
          after.bpm.bpm === null && d.bpmTap.stats().filled === 0,
          bpmOf(after) ? `${before.state} ${before.bpm} -> ${JSON.stringify(after.bpm)}` : 'no bpm on the LIVE_STATE stop() emitted');
      }

      // ================================================= the cadence, as a COUNT
      /**
       * THE ENTRY POINT IS `pushState()`, which on a cached deck is the FILL_HZ
       * timer AND a forced push from load/play/pause/seek/stop/end-of-track.
       * Carried by counts of `tick()` calls, never by a stopwatch.
       *
       * The rows BRACKET the rate rather than restate it: roll the clock back one
       * whole period and the tap must be fed, roll it back HALF a period and it
       * must not. A tap given its own 20 Hz driver passes the first and fails the
       * second; a tap at 5 Hz fails the first. Both taps are counted in the same
       * loop, so "the same heartbeat as tickKey" is a compared quantity.
       */
      {
        const d = mkDeck();
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        let bpmTicks = 0, keyTicks = 0;
        d.bpmTap.tick = () => { bpmTicks++; return 0; };
        d.keyTap.tick = () => { keyTicks++; return 0; };
        const N = 20;

        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
        d.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
        for (let i = 0; i < N; i++) d.pushState();
        ok(`${N} forced pushState() calls inside one gate window feed the cached deck's tempo tap ONCE — exactly like the key tap`,
          bpmTicks === 1 && keyTicks === 1, `bpm ${bpmTicks}, key ${keyTicks}`);

        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;
          d.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ;
          d.pushState();
        }
        ok('a full period after the last block the tap is fed again — 20 heartbeats, 20 blocks, on both taps',
          bpmTicks === N && keyTicks === N, `bpm ${bpmTicks}/${N}, key ${keyTicks}/${N}`);

        bpmTicks = 0; keyTicks = 0;
        for (let i = 0; i < N; i++) {
          d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ / 2;
          d.keyAt = performance.now() - 1000 / KEY_ACCUM_HZ / 2;
          d.pushState();
        }
        ok('half a period after the last block it is refused — the tap is on the 10 Hz heartbeat and not on a driver of its own',
          bpmTicks === 0 && keyTicks === 0,
          `bpm ${bpmTicks}, key ${keyTicks} over ${N} pushes at ${(1000 / BPM_ACCUM_HZ / 2).toFixed(0)} ms spacing ` +
          `(a 20 Hz gate would let ${N} through here and still pass the row above)`);

        // ...and it stops with the track, because pushState() does not.
        bpmTicks = 0;
        d.stop();
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        d.pushState();
        ok('a deck with no track is not fed at all (pushState still runs — the tap must decline, not the heartbeat)',
          bpmTicks === 0, `${bpmTicks} blocks with track === null`);
      }

      // ============================================== a fault is REPORTED state
      /**
       * The detector runs inside the heartbeat, so it may not throw into it — and
       * "degrades to no estimate" and "silently does nothing" are the same wire
       * value unless the failure is NAMED. That is the content of these rows: not
       * that the throw was caught, but that catching it is visible from outside.
       *
       * TWO ENTRY POINTS, TWO ASSERTIONS. `tick()` is caught in `tickBpm()` and
       * `payload()` in `bpmPayload()`; a guard on one is not a guard on the other.
       */
      {
        const d = mkDeck();
        const logs = [];
        d.s.log = (s) => logs.push(s);
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        const healthy = mkDeck().bpmPayload();
        d.bpmTap.tick = () => { throw new Error('synthetic tick fault'); };
        sent.length = 0;
        d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ;   // gate wide open
        let caught = null;
        try { d.pushState(); } catch (e) { caught = e; }
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a cached deck\'s tap that throws in tick() does not take pushState() down',
          caught === null, caught ? String(caught.message) : 'pushState returned normally');
        ok('...and the fault is on the wire as its own state, carrying the message and the count',
          !!bpmOf(m) && m.bpm.state === 'fault' && m.bpm.bpm === null && m.bpm.beatFrame === null &&
          /synthetic tick fault/.test(String(m.bpm.fault)) && m.bpm.faults === 1,
          bpmOf(m) ? JSON.stringify(m.bpm) : 'no bpm on the wire');
        /**
         * THE POINT OF THE FIFTH STATE, and the row that goes red if someone
         * "simplifies" the fault branch to return `none`. A broken detector and a
         * detector that has heard nothing must not be the same wire value — that
         * is a feature reporting success for the same reason a vacuous assertion
         * does.
         */
        ok('...and a FAULTED tap is distinguishable on the wire from one that has simply heard nothing',
          healthy.state === 'none' && !!bpmOf(m) && m.bpm.state !== healthy.state && !('fault' in healthy) &&
          'fault' in m.bpm && 'faults' in m.bpm,
          `healthy ${JSON.stringify(healthy)} vs faulted ${bpmOf(m) ? JSON.stringify(m.bpm) : 'NO bpm ON THE WIRE'}`);
        /**
         * Latched: off until the next load, one log line, and the counter does
         * not run away at 10 Hz for the life of the deck.
         *
         * REACHABILITY, checked rather than assumed (AGENTS.md: name the value
         * that would make this go red and ask whether it is reachable). The
         * `faults === 1` clause goes red on its own the moment `tickBpm()` stops
         * latching. The ONE LOG LINE clause does not: with the tick latch in
         * place `bpmFault_` cannot be entered twice, so deleting its own
         * `if (this.bpmFault) return;` changes nothing — that line is
         * defence-in-depth, and the clause only goes red when BOTH latches are
         * removed. Verified by breaking both on purpose. It is kept because it is
         * the clause that names the log-spam failure, and because the second
         * latch is what makes it true if a future caller reaches bpmFault_ from
         * somewhere other than a latched tick.
         */
        sent.length = 0;
        for (let i = 0; i < 10; i++) { d.bpmAt = performance.now() - 1000 / BPM_ACCUM_HZ; d.pushState(); }
        const m2 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('the fault latches the tap off — 10 more heartbeats, still one throw, still one log line, still reported',
          !!bpmOf(m2) && m2.bpm.state === 'fault' && m2.bpm.faults === 1 && d.bpmFaults === 1 &&
          logs.filter((s) => /tempo tap faulted/.test(s)).length === 1,
          `faults ${d.bpmFaults}, ${logs.filter((s) => /tempo tap faulted/.test(s)).length} log line(s)`);
        /**
         * A SEEK DOES NOT CLEAR IT, and that is deliberate rather than an
         * oversight: a tick that threw part-way may have left the cursor or the
         * envelope torn, and retrying on torn state risks a confident lock — the
         * one output this feature must never produce. A seek is a discontinuity
         * inside one track; the track boundaries are what clear it.
         */
        sent.length = 0;
        d.seek(2);
        const m3 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a seek RESETS the tap but does not clear the latch — the fault belongs to the track, not to the playhead',
          !!bpmOf(m3) && m3.bpm.state === 'fault' && d.bpmFault !== null && d.bpmTap.stats().filled === 0,
          bpmOf(m3) ? `${JSON.stringify(m3.bpm)}, ${d.bpmTap.stats().filled} envelope samples` : 'no bpm on the wire');
        // ...and the next track clears it, or a transient fault would be
        // unclearable without reloading the offscreen document.
        d.bpmTap.tick = () => 0;
        sent.length = 0;
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        const m4 = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('and load() clears it, so a transient fault does not need a document reload',
          !!bpmOf(m4) && m4.bpm.state === 'none' && d.bpmFault === null && d.bpmFaults === 0,
          bpmOf(m4) ? `${JSON.stringify(m4.bpm)}, fault ${d.bpmFault}` : 'no bpm on the wire');
      }
      {
        // The OTHER entry point. Same claim, different guard.
        const d = mkDeck();
        d.s.log = () => {};
        await d.load(stemTrack(clickTrain(120, 6), 'drums'));
        d.bpmTap.payload = () => { throw new Error('synthetic payload fault'); };
        sent.length = 0;
        let caught = null;
        try { d.pushState(); } catch (e) { caught = e; }
        const m = sent.filter((x) => x.type === 'LIVE_STATE').at(-1);
        ok('a cached deck\'s tap that throws in payload() does not take pushState() down either, and reports the same way',
          caught === null && !!bpmOf(m) && m.bpm.state === 'fault' && m.bpm.faults >= 1 &&
          /synthetic payload fault/.test(String(m.bpm.fault)),
          caught ? String(caught.message) : bpmOf(m) ? JSON.stringify(m.bpm) : 'no bpm on the wire');
      }
    }
  }

  head('cache — audio-clock-driven video sync (AUDIO.md §8.2)');
  // REACHABLE: this IS the function CachedDeck calls. Pure, so it needs no
  // browser. What it cannot see is the <video> element actually obeying it —
  // that is the browser check, once measurement is cleared.
  {
    const at = (a, v) => syncCorrection(a, v);
    ok('within 60 ms: leave it alone (chasing sub-JND error looks worse than the error)',
      at(10, 10.03).action === 'none' && at(10, 9.95).action === 'none',
      `+30 ms -> ${at(10, 10.03).action}, -50 ms -> ${at(10, 9.95).action}`);
    ok('the 60 ms boundary is inclusive and starts a soft correction',
      at(10, 10.06).action === 'rate' && at(10, 10.0599).action === 'none');
    const ahead = at(10, 10.2), behind = at(10, 9.8);
    ok('video AHEAD is slowed to 0.98, video BEHIND is sped to 1.02',
      ahead.action === 'rate' && Math.abs(ahead.playbackRate - 0.98) < 1e-12 &&
      behind.action === 'rate' && Math.abs(behind.playbackRate - 1.02) < 1e-12,
      `+200 ms -> ${ahead.playbackRate}, -200 ms -> ${behind.playbackRate}`);
    ok('the soft correction never exceeds 2 % (beyond a few percent it judders)',
      [0.06, 0.1, 0.3, 0.499].every((e) => Math.abs(at(10, 10 + e).playbackRate - 1) <= 0.02 + 1e-12));
    ok('>= 500 ms is a hard seek to the AUDIO clock, not a rate nudge',
      at(10, 10.5).action === 'seek' && at(10, 10.5).seekTo === 10 &&
      at(10, 9.4).action === 'seek' && at(10, 9.4).seekTo === 10);
    ok('a 2 % correction closes a 100 ms error in ~5 s (the reason 2 % is enough)',
      Math.abs(0.100 / 0.02 - 5) < 1e-12);
    ok('...and would take 25 s at 500 ms, which is why that one seeks instead',
      0.500 / 0.02 === 25);
    ok('the error sign is video-minus-audio, so the caller can display it',
      Math.abs(at(10, 10.2).errorSec - 0.2) < 1e-12 && Math.abs(at(10, 9.8).errorSec + 0.2) < 1e-12);
  }

  head('cache — the sync loop reads a STALE playhead, and compensates for it');
  /**
   * ENTRY POINT: `embed/ui/embed.js` syncVideoLock(), the only caller. It reads
   * `LIVE_STATE.positionSec`, which was true at `atMs` and arrives 50-100 ms
   * later (10 Hz publish + a chrome.runtime hop).
   *
   * This exists because the lag is the SAME SIZE as syncCorrection's 60 ms
   * threshold. The first assertion is the one that matters: it shows the
   * uncompensated read tripping a correction that is not real, so deleting
   * `audioClockAt` cannot pass.
   */
  {
    const T0 = 1_700_000_000_000;
    // A perfectly locked pair: the audio playhead and the video are both at
    // 30.000 s. The engine sampled the playhead 90 ms ago.
    const pos = 30.0, atMs = T0 - 90, videoSec = 30.09;

    ok('UNCOMPENSATED, a perfectly locked video reads as 90 ms of error and is ' +
       'corrected — the bug this function exists to prevent',
      syncCorrection(pos, videoSec).action === 'rate',
      `${syncCorrection(pos, videoSec).action}, err ${(syncCorrection(pos, videoSec).errorSec * 1000).toFixed(0)} ms`);
    ok('COMPENSATED, the same pair reads as locked and nothing is touched',
      syncCorrection(audioClockAt(pos, atMs, T0), videoSec).action === 'none',
      `err ${(syncCorrection(audioClockAt(pos, atMs, T0), videoSec).errorSec * 1000).toFixed(0)} ms`);
    ok('it advances the playhead by exactly the sample age',
      Math.abs(audioClockAt(30, T0 - 250, T0) - 30.25) < 1e-9,
      `${audioClockAt(30, T0 - 250, T0)}`);
    ok('a REAL error still survives compensation — it corrects the clock, not the ' +
       'measurement (a 300 ms lead is still a 300 ms lead)',
      syncCorrection(audioClockAt(pos, atMs, T0), 30.39).action === 'rate' &&
      Math.abs(syncCorrection(audioClockAt(pos, atMs, T0), 30.39).errorSec - 0.3) < 1e-9);
    ok('a backwards wall clock does not rewind the playhead — Date.now() can step, ' +
       'and inventing a negative age would be inventing an error',
      audioClockAt(30, T0 + 500, T0) === 30);
    ok('an absent position is 0, not NaN — a NaN playhead makes every comparison ' +
       'false and syncCorrection would silently return "none" forever',
      audioClockAt(undefined, T0, T0) === 0 && audioClockAt(30, undefined, T0) === 30);
  }

  head('cache — a cached deck starts where the USER is, not at the top');
  /**
   * ENTRY POINT: offscreen/engine.js playCachedAtPage(), on both routes into cached
   * audio — the first LIVE_START after a cache hit, and every resume after it.
   * Both defects it prevents are SILENT: one plays the wrong part of the song,
   * the other plays nothing at all.
   */
  {
    ok('a cache hit on a video the user is 90 s into starts at 90 s, not at 0 — ' +
       'otherwise the video lock drags the picture back to 0:00 and it reads as ' +
       'the deck hijacking the transport',
      resumeSeek(0, 'loaded', 90) === 90);
    ok('an ordinary pause/resume does NOT flush the ring for drift the video ' +
       'lock already handles',
      resumeSeek(90.0, 'paused', 90.05) === null);
    ok('...but a scrub does, because that is a different part of the song',
      resumeSeek(90, 'paused', 130) === 130);
    /**
     * THE REPLAY. This is the first gesture anyone makes after a prime finishes:
     * the track ended, press play again. Without the rewind the deck's write
     * head is parked at the end and play() re-ends it on the next fill — silent
     * audio, no error, nothing in any log.
     */
    ok('a deck that ran to the end REWINDS on play, even with no page to follow',
      resumeSeek(240, 'ended', null) === 0);
    ok('...and follows the page when there is one (YouTube seeks to 0 to replay)',
      resumeSeek(240, 'ended', 0) === 0);
    ok('a loaded deck with no page transport plays from where it is',
      resumeSeek(0, 'loaded', null) === null);
    ok('a non-numeric page position is ignored rather than seeking to NaN — ' +
       'a NaN seek clamps to frame 0 and silently restarts the track',
      resumeSeek(90, 'playing', NaN) === null && resumeSeek(90, 'playing', undefined) === null);
  }

  head('cache — the track identity, and it is a NAME not an acquisition path (L1)');
  {
    const ID = 'dQw4w9WgXcQ';
    ok('the watch page, which is the shipping case',
      videoIdFromUrl(`https://www.youtube.com/watch?v=${ID}`) === ID);
    ok('...with the query params YouTube actually attaches',
      videoIdFromUrl(`https://www.youtube.com/watch?v=${ID}&list=PLx&index=2&t=41s`) === ID);
    ok('the short domain, the embed, the shorts and the live paths',
      videoIdFromUrl(`https://youtu.be/${ID}?t=41`) === ID &&
      videoIdFromUrl(`https://www.youtube.com/embed/${ID}`) === ID &&
      videoIdFromUrl(`https://www.youtube.com/shorts/${ID}`) === ID &&
      videoIdFromUrl(`https://www.youtube.com/live/${ID}`) === ID);
    ok('music.youtube.com and m.youtube.com are the same tracks',
      videoIdFromUrl(`https://music.youtube.com/watch?v=${ID}`) === ID &&
      videoIdFromUrl(`https://m.youtube.com/watch?v=${ID}`) === ID);
    /**
     * The refusals matter more than the acceptances. A key that is invented for
     * a page we do not recognise collides across two different tracks, and the
     * failure is stems from the wrong song playing back as if they were right.
     */
    ok('a non-video YouTube page has NO id — not a guess, not the pathname',
      videoIdFromUrl('https://www.youtube.com/') === null &&
      videoIdFromUrl('https://www.youtube.com/feed/subscriptions') === null &&
      videoIdFromUrl('https://www.youtube.com/@someChannel') === null);
    ok('another host is not a YouTube video however it is shaped',
      videoIdFromUrl(`https://notyoutube.com/watch?v=${ID}`) === null &&
      videoIdFromUrl(`https://youtube.com.evil.test/watch?v=${ID}`) === null);
    ok('a malformed id is refused rather than truncated into a plausible key',
      videoIdFromUrl('https://www.youtube.com/watch?v=short') === null &&
      videoIdFromUrl('https://www.youtube.com/watch?v=' + 'x'.repeat(40)) === null);
    ok('junk in is null out, never a throw — this runs on every LIVE_START',
      videoIdFromUrl(null) === null && videoIdFromUrl('') === null &&
      videoIdFromUrl('not a url') === null && videoIdFromUrl(undefined) === null);
    ok('the SAME video at a different hop is a DIFFERENT cache key — the causal ' +
       'window is hop-dependent, so the stems genuinely differ',
      cacheKey(ID, 1.95) !== cacheKey(ID, 3.9));
  }

  head('cache — a prime is all-or-nothing, and "we cannot see" is a refusal');
  /**
   * ENTRY POINTS: `primeRefusal` is called from offscreen/engine.js beginPrime() on
   * LIVE_START; `commitRefusal` from endPrime() on stop. They are separate
   * assertions because they run at different moments on different evidence.
   */
  {
    const ID = 'dQw4w9WgXcQ';
    const page = (o) => ({ currentTime: 0, duration: 240, ended: false, ...o });

    ok('a fresh watch page at the top of the track primes',
      primeRefusal(ID, page()) === null);
    ok('...and 1.0 s in still counts as the top (a play never lands on 0.000)',
      primeRefusal(ID, page({ currentTime: 0.9 })) === null);
    /**
     * THE ONE THAT MUST NOT REGRESS. `null` here means the side-panel build,
     * which has no content script and therefore no idea where the playhead is.
     * Treating that as "assume 0" writes an entry covering 1:47-to-the-end and
     * reports it as the whole song — the same disease as an assertion that
     * passes because it could not look (AGENTS.md).
     */
    ok('NO page transport is a REFUSAL, not an assumption that it started at 0',
      primeRefusal(ID, null) === 'no page transport (this build has no content script)');
    ok('a video already part-way through does not prime',
      /already 107.0 s in/.test(primeRefusal(ID, page({ currentTime: 107 })) || ''),
      primeRefusal(ID, page({ currentTime: 107 })));
    ok('no duration yet (metadata has not landed) does not prime',
      primeRefusal(ID, page({ duration: 0 })) !== null);
    ok('a page with no recognisable video is not cacheable at all',
      primeRefusal(null, page()) === 'not a recognisable video page');

    const W = (frames, aborted = false) => ({ frames, aborted });
    const FULL = 240 * SR;
    ok('a complete listen commits',
      commitRefusal(W(FULL), page({ ended: true })) === null);
    ok('...and so does one short by the causal tail the pipeline can never separate',
      commitRefusal(W(FULL - 4 * SR), page({ ended: true })) === null);
    ok('but not one short by more than that — a track that ends 40 s early is ' +
       'a wrong entry, not a slightly short one',
      /40.0 s short/.test(commitRefusal(W(FULL - 40 * SR), page({ ended: true })) || ''),
      commitRefusal(W(FULL - 40 * SR), page({ ended: true })));
    ok('a track the user paused near the end commits NOTHING — "nearly all of it" ' +
       'is exactly the ambiguity this policy removes',
      /did not play to the end/.test(commitRefusal(W(FULL - SR), page({ ended: false })) || ''));
    ok('an interrupted prime (a seek aborted the writer) never commits',
      commitRefusal(W(FULL, true), page({ ended: true })) === 'the prime was interrupted');
    ok('an empty writer never commits',
      commitRefusal(W(0), page({ ended: true })) === 'nothing was captured');
    ok('and with no page transport to check against, it refuses rather than ' +
       'committing on the frame count alone',
      commitRefusal(W(FULL), null) !== null);
  }

  // ======================================== U3: the File source's identity
  /**
   * cache — A FILE SOURCE IS KEYED BY WHAT IT IS, NOT BY WHAT IT IS CALLED.
   *
   * REACHABLE: drives the real `fileIdFromBytes`, `fileIdentity`, `fileRefusal`
   * and `fileCommitRefusal` in `shared/stemcache.js`. Pure functions over a
   * platform digest — no OPFS, no clock, no model, no fixture longer than it
   * needs to be.
   *
   * WHY IT EXISTS. `videoIdFromUrl` returns null for anything that is not a
   * YouTube page, and `cacheKey(null, hop)` is the literal key
   * `'null--<pipelineVersion>'` — ONE key shared by every file the user ever
   * opens. The CONTROL assertion below produces that collision rather than
   * describing it, so what the assertions around it protect is on the record.
   *
   * TODAY'S TREE DOES NOT REACH THAT KEY: `trackKey()` (`offscreen/engine.js:
   * 547-551`) has `if (!videoId) return null` and caches nothing. That guard is
   * right for a YouTube tab off a video page and wrong for a file, where the
   * videoId is ALWAYS absent — reusing it means the ahead-of-time tier never
   * fills. Collide-everything and cache-nothing are the two answers a shared
   * identity gives a File source, and neither is a cache; hence a separate one.
   *
   * MUTATION LOG — every assertion in both blocks watched red, each mutation
   * applied ALONE to a green tree, `node test.js cache` run and read before the
   * file was restored. Line numbers are `extension/shared/stemcache.js` at this
   * commit; `reds` counts FAIL lines. Every assertion this slice adds is covered
   * by at least one row.
   *
   *   #    mutation                                                    where   reds
   *   M1   fileIdentity: keys from videoIdFromUrl, as trackKey does   :401     5   <- shows the null-- collision
   *   M2   fileIdFromBytes: hash only the first 4096 bytes             :372     2   <- the prefix-hash this slice ruled out
   *   M3   fileIdFromBytes: digest SHA-1 rather than SHA-256           :372     3
   *   M4   fileIdFromBytes: drop padStart(2, '0') from the hex         :374     3
   *   M5   fileIdFromBytes: return null rather than throw on no bytes  :364     1
   *   M6   fileRefusal: the isFileId branch removed                    :431     6
   *   M7   fileRefusal: the "no bytes" branch removed                  :435     2
   *   M8   fileRefusal: the empty-file branch removed                  :445     2
   *   M9   fileRefusal: empty checked by length only, not the digest   :445     1
   *   M10  fileCommitRefusal: equality relaxed to PRIME_TAIL_MAX_SEC   :482     3
   *   M11  fileCommitRefusal: no decoded source returns null           :481     2
   *   M12  fileCommitRefusal: the aborted branch removed               :473     1
   *   M13  fileCommitRefusal: the empty-writer branch removed          :474     1
   *   M14  fileCommitRefusal: short/past wording swapped               :485     3
   *   M15  fileIdFromBytes: a random digest per call                   :372     3   <- the "same file" claim
   *   M16  fileIdentity: the tier dropped from cacheKey                :402     2
   *   M17  videoIdFromUrl: a non-YouTube host returns its pathname     :137     2   <- the CONTROL can fail
   *   M18  fileRefusal: refuses unconditionally                        :446     3
   *   M19  fileCommitRefusal: refuses unconditionally                  :487     2
   *   M20  fileCommitRefusal: the no-writer branch returns null        :472     1
   *   M21  primeRefusal: the !videoId branch returns null              :261     2
   *   M22  commitRefusal: the !page branch returns null                :283     2
   */
  head('cache — a File source is identified by its CONTENT, and videoIdFromUrl is not on that path');
  {
    /** Deterministic file bytes; the same LCG `noise()` uses, one byte at a time. */
    const fileBytes = (n, seed) => {
      let s = seed >>> 0;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = (s >>> 24) & 0xff; }
      return b;
    };
    const ascii = (s) => new TextEncoder().encode(s);
    const F32 = { depth: 32, geometry: 'offline' };

    /**
     * THE PAIR THAT PRICES THE RULED-OUT ALTERNATIVE. A first-N-MB-plus-length
     * hash was rejected for this slice; these two files are exactly what it
     * gets wrong — 64 KiB, the same 65 535-byte prefix, differing only in the
     * LAST byte. That is a re-tagged duplicate, a second render out of one
     * session, or a copy a file manager finished writing differently, and every
     * one of those is a pair somebody really has on disk.
     */
    const A = fileBytes(1 << 16, 7);
    const B = new Uint8Array(A); B[B.length - 1] ^= 0xff;

    const a = await fileIdentity(A, 1.95, F32);
    const b = await fileIdentity(B, 1.95, F32);

    ok('two files that differ ONLY in their last byte never share a key  '
      + '[entry point: fileIdentity(bytes, hop, tier)]',
      a.key !== b.key && a.id !== b.id, `${String(a.id).slice(0, 16)}… vs ${String(b.id).slice(0, 16)}…`);

    /**
     * RE-IDENTIFICATION, over a buffer built from scratch rather than the same
     * object handed back — "the same file" means the same BYTES on a later
     * visit, from a different read, possibly in a different process.
     */
    const again = await fileIdentity(fileBytes(1 << 16, 7), 1.95, F32);
    ok('...and the same bytes re-identify to the same key on a separate call, from a separate buffer',
      again.key === a.key && again.id === a.id, String(again.id).slice(0, 16) + '…');

    ok('the identity is the file’s real SHA-256 — the published vectors, so the key is one '
      + '`shasum -a 256` reproduces  [entry point: fileIdFromBytes(bytes)]',
      (await fileIdFromBytes(ascii('abc')))
        === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
      && (await fileIdFromBytes(new Uint8Array(0)))
        === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      await fileIdFromBytes(ascii('abc')));

    ok('how the Host hands the bytes over cannot change the key: a view, an offset view and the '
      + 'whole buffer identify the same 64 KiB the same way',
      (await fileIdFromBytes(A.buffer)) === a.id
      && (await fileIdFromBytes(new Uint8Array(A.buffer, 0, A.length))) === a.id
      && (await fileIdFromBytes(A.subarray(1))) !== a.id);

    /**
     * THE 64-CHARACTER FIT IS ASSERTED, NOT ASSUMED. `cacheKey` slices a
     * caller-supplied name at 64 to bound it, and a digest is exactly 64, so
     * nothing is cut today. A later prefix on the id would be — silently, into a
     * key nobody could reproduce with a checksum tool. This is where that goes
     * red.
     */
    ok('the WHOLE digest reaches the key — cacheKey’s 64-character cap does not truncate it',
      String(a.id).length === 64 && a.key === `${a.id}--${pipelineVersion(1.95, F32)}`
      && a.key.startsWith(`${a.id}--`), `${a.key.length} chars`);

    ok('the tier reaches a File key too, so a 32f offline entry cannot be read back as a live one',
      /-d32f-go$/.test(a.key) && a.key !== (await fileIdentity(A, 1.95)).key,
      a.key.slice(-24));

    /**
     * WHY THE TWO IDENTITY SPACES CANNOT COLLIDE, structurally rather than by
     * luck: a videoId is 11 characters of the URL alphabet and a file identity
     * is 64 of hex. No string is both, so a File entry and a YouTube entry never
     * name each other however the two tiers are mixed.
     */
    ok('a file identity can never be mistaken for a videoId — 64 hex against 11 URL characters',
      /^[0-9a-f]{64}$/.test(a.id) && !/^[A-Za-z0-9_-]{11}$/.test(a.id));

    ok('no bytes is a THROW, not a null that would flow into cacheKey and become the key below  '
      + '[entry point: fileIdFromBytes(null)]',
      await (async () => {
        for (const bad of [null, undefined, 'a file', 42, { byteLength: 8 }]) {
          try { await fileIdFromBytes(bad); return false; } catch { /* named error, wanted */ }
        }
        return true;
      })());

    /**
     * THE CONTROL, and it asserts that the BUG is real. Route the File path back
     * through `videoIdFromUrl` — which is what `offscreen/engine.js:548` does
     * today for a Source with no YouTube URL — and the two files above do not
     * merely get different-looking keys, they get the SAME key. A `null--…`
     * shared by every file is the stale-but-plausible entry `stemcache.js`'s own
     * header calls the worst failure it has.
     */
    const viaUrlA = cacheKey(videoIdFromUrl('file:///music/one.flac'), 1.95, F32);
    const viaUrlB = cacheKey(videoIdFromUrl('file:///music/two.flac'), 1.95, F32);
    ok('CONTROL — deriving a File key from a URL collides EVERY file onto one key',
      viaUrlA === viaUrlB && viaUrlA.startsWith('null--'), viaUrlA);
    ok('...and neither real file key is that key, nor each other’s',
      a.key !== viaUrlA && b.key !== viaUrlA && a.key !== b.key,
      `${a.key.slice(0, 12)}… ${b.key.slice(0, 12)}… vs ${viaUrlA.slice(0, 12)}…`);
  }

  head('cache — the File refusal pair: neither prime-policy function can be used here');
  /**
   * ENTRY POINTS: `fileRefusal` answers when the Host's `sourceBytes` has
   * returned and before the model runs; `fileCommitRefusal` answers when the
   * runner has finished, before `CacheWriter.commit()`. Both are pure and both
   * are driven here over a table — no OPFS, no clock, and the only numbers are
   * frame counts.
   *
   * They exist because NEITHER live function can be used for a File source, and
   * the two assertions that close this block say so by calling them:
   * `primeRefusal` refuses on `!videoId`, and `commitRefusal` requires
   * `page.ended` from a page transport a file does not have.
   */
  {
    const ID_A = 'a'.repeat(64);
    const EMPTY_ID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const some = new Uint8Array(1024);

    /** [what, fileId, bytes, expected — null for go-ahead, else a pattern] */
    const REFUSALS = [
      ['a real identity and real bytes goes ahead', ID_A, some, null],
      ['...however the bytes arrived — an ArrayBuffer is the same answer', ID_A, some.buffer, null],
      ['a NULL identity is refused — the value videoIdFromUrl hands back for any file',
        null, some, /no content identity/],
      ['the STRING "null" is refused too, which is what reaches cacheKey unguarded',
        'null', some, /no content identity/],
      ['a videoId is not a file identity, however valid it is as a videoId',
        'dQw4w9WgXcQ', some, /no content identity/],
      ['63 hex characters is not a digest', 'a'.repeat(63), some, /no content identity/],
      ['65 hex characters is not a digest either', 'a'.repeat(65), some, /no content identity/],
      ['64 characters that are not hex is not a digest', 'z'.repeat(64), some, /no content identity/],
      ['no bytes at all is a refusal, not an assumption about the file',
        ID_A, null, /no bytes came back/],
      ['something that is not a buffer is a refusal — a length is not evidence of bytes',
        ID_A, { byteLength: 1024 }, /no bytes came back/],
      ['a zero-length file is a refusal — it decodes to a track that is silently not the track',
        ID_A, new Uint8Array(0), /the file is empty/],
      ['...and so is the identity every empty file shares, even with bytes in hand',
        EMPTY_ID, some, /the file is empty/],
    ];
    for (const [what, id, bytes, want] of REFUSALS) {
      const got = fileRefusal(id, bytes);
      ok(`fileRefusal: ${what}`,
        want === null ? got === null : typeof got === 'string' && want.test(got),
        got === null ? 'go ahead' : String(got));
    }

    /**
     * THE COMPLETENESS TEST IS EQUALITY, and the fixture is deliberately a frame
     * count rather than a duration: the runner knows how many frames the decode
     * produced before it starts, so anything but that exact number is a bug in
     * the runner and not a track that ended early.
     */
    const N = 240 * SR;
    const W = (frames, aborted = false) => ({ frames, aborted });
    const SRC = (frames = N) => ({ frames });

    const COMMITS = [
      ['a run that produced exactly the decoded length commits', W(N), SRC(), null],
      ['nothing running commits nothing', null, SRC(), /nothing was being separated/],
      ['a cancelled run never commits', W(N, true), SRC(), /cancelled/],
      ['an empty writer never commits', W(0), SRC(), /nothing was separated/],
      ['no decoded source to check against is a REFUSAL, not a commit on the writer’s own count',
        W(N), null, /no decoded source/],
      ['...and a source that reports no length is the same refusal',
        W(N), SRC(0), /no decoded source/],
      ['ONE frame short is refused — there is no causal tail to forgive offline',
        W(N - 1), SRC(), /^1 frame short of/],
      ['one frame PAST is refused too, and says which way it went',
        W(N + 1), SRC(), /^1 frame past/],
      ['the live tail tolerance does not apply: 4 s short is a refusal here',
        W(N - 4 * SR), SRC(), /^176400 frames short of/],
    ];
    for (const [what, w, src, want] of COMMITS) {
      const got = fileCommitRefusal(w, src);
      ok(`fileCommitRefusal: ${what}`,
        want === null ? got === null : typeof got === 'string' && want.test(got),
        got === null ? 'commit' : String(got));
    }

    /**
     * AND THE TWO REASONS THE PAIR HAD TO BE WRITTEN AT ALL, called rather than
     * asserted about in prose. If either of these ever returns null for a File
     * source, this slice is dead code and the collision is back.
     */
    ok('primeRefusal CANNOT stand in: it refuses a File source on the videoId it correctly lacks',
      primeRefusal(null, { currentTime: 0, duration: 240, ended: false })
        === 'not a recognisable video page');
    ok('commitRefusal CANNOT stand in either: it demands a page transport a file does not have',
      commitRefusal(W(N), null) === 'no page transport to check completeness against'
      && /did not play to the end/.test(commitRefusal(W(N), { duration: 240, ended: false }) || ''));
    ok('...while the File pair answers both of those on the evidence a file actually has',
      fileRefusal(ID_A, some) === null && fileCommitRefusal(W(N), SRC()) === null);
  }

  head('cache — 16-bit round trip is good enough for playback, and is NOT dithered');
  {
    // Four dithered stems summed would stack four independent TPDF noise floors
    // on a signal that is about to be re-mixed. Export re-derives at 32f, so
    // nothing lossy reaches a deliverable.
    const n = 4096;
    const x = noise(n, 31);
    const wav = encodeWav([x, x], { sampleRate: SR, bitDepth: 16, float: false, dither: false });
    const back = decodeWav(wav).channels[0];
    const db = residualDb(back, x);
    ok(`16-bit quantisation floor is ${db.toFixed(1)} dB (gate < -85)`, db < -85);
    const again = decodeWav(encodeWav([back, back], { sampleRate: SR, bitDepth: 16, float: false, dither: false })).channels[0];
    ok('and a second round trip is BIT IDENTICAL — undithered means idempotent, ' +
       'so re-caching cannot accumulate noise',
      again.every((v, i) => v === back[i]));
  }

  head('cache — one cache owns one directory (a second tier cannot reach the first)');
  /**
   * REACHABLE: drives the real `StemCache` over a real OPFS surface, not a
   * reimplementation of it. Every method below is the shipped one.
   *
   * WHY THIS EXISTS. The directory used to be a module constant that every
   * instance shared — `dir()` read `CACHE_DIR` and ignored `this` — so a second
   * cache constructed for a second tier silently operated on the FIRST tier's
   * directory. `clear()` is the worst of it, because it removes the directory
   * whole and its `.catch(() => {})` swallows the evidence: a 32f clear would
   * delete the live 16-bit cache and report success. `list()`, `put()`,
   * `delete()` and `evict()` had the same blindness one step less loudly.
   *
   * The two mutations that were watched red are named in the assertions.
   */
  {
    /**
     * A minimal in-memory OPFS. Only the six calls `shared/stemcache.js` makes
     * are implemented, and the two that must REJECT do reject — `getFileHandle`
     * on a missing file is what `readJson()` and `get()` catch, and
     * `removeEntry` on a missing entry is what `clear()` and `delete()` catch.
     * A shim that resolved those instead would make this whole block pass
     * against a cache that never stored anything.
     *
     * `navigator` IS A CONFIGURABLE GETTER WITH NO SETTER in Node 22, so a plain
     * `globalThis.navigator = {...}` silently does nothing and leaves
     * `navigator.storage` undefined. Measured, not assumed. defineProperty is
     * the only thing that takes.
     */
    const o0 = installOpfs();
    const dirs = o0.dirs;

    try {
      // Eight frames per plane: this block is about WHICH DIRECTORY the bytes
      // land in, and a longer fixture would only make it slower to be wrong.
      const stems = {};
      for (const s2 of STEMS) stems[s2] = [0, 1].map(() => new Float32Array(8).fill(0.25));

      const live = new StemCache(1 << 30);                       // the shipping default
      const f32 = new StemCache(1 << 30, 'stemcache-f32');       // the desktop tier

      ok('a cache constructed with no directory still owns the shipping one  '
         + '[entry point: new StemCache(maxBytes)]',
        live.dirName === CACHE_DIR, `${live.dirName} vs ${CACHE_DIR}`);

      await live.put('k-live', { title: 'live' }, stems);
      await f32.put('k-32f', { title: 'f32' }, stems);

      // MUTATION 1 (watched red): revert `dir(name)` to `getDirectoryHandle(CACHE_DIR)`.
      // Both caches then write into 'stemcache', and each list() returns 2.
      const liveKeys = (await live.list()).map((e) => e.key);
      const f32Keys = (await f32.list()).map((e) => e.key);
      ok('each cache lists ONLY its own entries  '
         + '[entry point: StemCache.list() over two instances on different directories]',
        liveKeys.length === 1 && liveKeys[0] === 'k-live'
        && f32Keys.length === 1 && f32Keys[0] === 'k-32f',
        `live=[${liveKeys}] f32=[${f32Keys}]`);

      ok('...and the bytes really are in two directories on disk, not one manifest '
         + 'filtered two ways',
        dirs.has(CACHE_DIR) && dirs.has('stemcache-f32')
        && [...dirs.get(CACHE_DIR).files.keys()].some((f) => f.startsWith('k-live.'))
        && [...dirs.get('stemcache-f32').files.keys()].some((f) => f.startsWith('k-32f.')),
        `${[...dirs.keys()]}`);

      // MUTATION 2 (watched red): revert `clear()` to
      // `root.removeEntry(CACHE_DIR, ...)`. The 32f clear then deletes the LIVE
      // directory, live.list() returns 0, and this goes red — which is the
      // failure in its real shape, a destroyed live tier, not a name mismatch.
      await f32.clear();
      const survived = (await live.list()).map((e) => e.key);
      ok('clearing the 32f tier LEAVES THE LIVE TIER INTACT  '
         + '[entry point: StemCache.clear() on the non-default directory]',
        survived.length === 1 && survived[0] === 'k-live',
        survived.length ? `live still holds [${survived}]` : 'THE LIVE CACHE WAS DESTROYED BY A 32f CLEAR');

      ok('...and the tier that was cleared really is empty, so the clear was not a no-op '
         + '(which would pass the assertion above for the wrong reason)',
        (await f32.list()).length === 0);
    } catch (e) {
      blockThrew('cache — one cache owns one directory (a second tier cannot reach the first)', e);
    } finally {
      o0.restore();
    }
  }
}

// ===========================================================================
/**
 * cache — THE OPFS HALF: every `StemCache` method that touches storage, and
 * `CacheWriter.commit()`. Before this block they had no coverage at all: the
 * imports above reached only the pure functions, so `get`/`put`/`delete`/
 * `evict`/`report`/`commit` could be changed freely and nothing went red.
 *
 * REACHABLE: drives the real `StemCache` and `CacheWriter`. Everything below
 * `dir()` — `readJson`, `writeFile`, `loadManifest`, the manifest write
 * ordering — is the shipped code, unmodified.
 *
 * The OPFS underneath is `installOpfs()`, at the top of this file — ONE shim,
 * shared with U0's isolation block. Why it is a shim at `navigator.storage`
 * rather than a `dir()` seam is argued there, next to the code it justifies.
 */
if (group('cache')) {
  /** Six stems of deterministic noise, [L,R] each. */
  const makeStems = (frames, seed = 1) => {
    const out = {};
    STEMS.forEach((s, k) => { out[s] = [noise(frames, seed + k * 2), noise(frames, seed + k * 2 + 1)]; });
    return out;
  };
  /** STEMS.length*2 planes, stem-major [L,R], as the live pipeline emits them. */
  const makePlanes = (frames, seed = 1) => {
    const p = [];
    for (let k = 0; k < STEMS.length; k++) { p.push(noise(frames, seed + k * 2), noise(frames, seed + k * 2 + 1)); }
    return p;
  };

  head('cache — put/get round trip through OPFS');
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);
      const key = cacheKey('vid1', 1.95);
      const stems = makeStems(512, 7);
      await c.put(key, { videoId: 'vid1', title: 'T', hopSeconds: 1.95 }, stems);

      ok('put then has() finds the key', await c.has(key));
      const got = await c.get(key);
      ok('get() returns an entry rather than null', got !== null);
      ok(`get() returns all ${STEMS.length} stems`,
        got !== null && STEMS.every((s) => Array.isArray(got.stems[s]) && got.stems[s].length === 2),
        got ? Object.keys(got.stems).join(',') : 'null');
      ok('every stem comes back at the frame count that went in',
        got !== null && STEMS.every((s) => got.stems[s][0].length === 512 && got.stems[s][1].length === 512));
      // 16-bit undithered: the floor is quantisation, and `cache` already pins it at < -85 dB.
      const db = got === null ? Infinity
        : Math.max(...STEMS.map((s) => Math.max(residualDb(got.stems[s][0], stems[s][0]),
                                                residualDb(got.stems[s][1], stems[s][1]))));
      ok(`samples survive the round trip at the 16-bit floor (worst ${db.toFixed(1)} dB, gate < -85)`, db < -85);
      ok('L and R are not swapped or shared on the way back',
        got !== null && residualDb(got.stems[STEMS[0]][1], stems[STEMS[0]][0]) > -85,
        'R must NOT match the L that went in');
      ok('the meta the caller passed comes back on the entry',
        got !== null && got.meta.videoId === 'vid1' && got.meta.title === 'T');
      ok('frames is recorded on the entry, derived not passed', got !== null && got.meta.frames === 512);
      ok('size() is the sum of the manifest bytes and is non-zero',
        (await c.size()) === (await c.list()).reduce((a, e) => a + e.bytes, 0) && (await c.size()) > 0,
        String(await c.size()));

      const rep = await c.report();
      ok('report() carries cap, use and track count', rep.tracks === 1 && rep.maxBytes === 50 * 1024 * 1024 && rep.bytes > 0);
      ok('report() pct is bytes over cap', rep.pct === +(rep.bytes / rep.maxBytes).toFixed(4), String(rep.pct));

      await c.delete(key);
      ok('delete() drops the manifest entry', !(await c.has(key)));
      const left = o.names().filter((n) => n.startsWith(key));
      ok('delete() removes the stem files too, not just the entry', left.length === 0, left.join(',') || 'none');
    } catch (e) {
      blockThrew('cache — put/get round trip through OPFS', e);
    } finally { o.restore(); }
  }

  head('cache — the manifest is written LAST, so a crash leaves an INVISIBLE entry, not a half-readable one');
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);
      const key = cacheKey('vid2', 1.95);
      await c.put(key, { videoId: 'vid2' }, makeStems(256, 3));
      const order = o.written;
      const mi = order.indexOf('manifest.json');
      ok('the manifest is the LAST thing a put writes', mi === order.length - 1, order.join(' -> '));
      ok(`all ${STEMS.length} stem files land BEFORE the manifest`,
        STEMS.every((s) => { const i = order.indexOf(`${key}.${s}.wav`); return i >= 0 && i < mi; }),
        `${mi} writes before the manifest`);
    } catch (e) {
      blockThrew('cache — the manifest is written LAST, so a crash leaves an INVISIBLE entry, not a half-readable one', e);
    } finally { o.restore(); }
  }
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);
      const key = cacheKey('vid3', 1.95);
      // Crash the write of the FOURTH stem: past the first file, short of the manifest.
      o.failOn.add(`${key}.${STEMS[3]}.wav`);
      let threw = false;
      try { await c.put(key, { videoId: 'vid3' }, makeStems(256, 5)); } catch { threw = true; }
      ok('a stem write that fails makes put() throw rather than return quietly', threw);
      // The instrument must be looking at a real half-write, or the rest is vacuous.
      const cd = await o.cacheDir();
      const partial = o.names().filter((n) => n.startsWith(key)).length;
      const complete = o.names().filter((n) => n.startsWith(key) && cd.files.get(n).byteLength > 0).length;
      // SOME BUT NOT ALL, rather than a pinned count: `getFileHandle(create)`
      // makes the file before anything is written to it — real OPFS does that
      // too — so the interrupted stem leaves an EMPTY file behind, and the
      // number of those is the shim's business, not stemcache.js's. What this
      // has to establish is only that a genuine half-written state exists for
      // the assertions below to be about.
      ok('the crash really did leave stem files behind — the precondition this asserts on',
        partial > 0 && partial < STEMS.length && complete > 0 && complete < partial,
        `${partial} of ${STEMS.length} stem files on disk, ${complete} of them with bytes in them`);
      ok('...and the manifest never got the entry, so the track is INVISIBLE',
        !(await c.has(key)));
      ok('...so get() reports a miss rather than a track with holes in it',
        (await c.get(key)) === null);
    } catch (e) {
      blockThrew('cache — the manifest is written LAST, so a crash leaves an INVISIBLE entry, not a half-readable one', e);
    } finally { o.restore(); }
  }

  head('cache — get() self-heals an entry that lies about its files');
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);
      const key = cacheKey('vid4', 1.95);
      await c.put(key, { videoId: 'vid4' }, makeStems(256, 11));
      ok('the entry is readable before the file is taken away', (await c.get(key)) !== null);
      // Take ONE stem file out from under it: the shape of an interrupted evict
      // or a storage eviction by the browser. The precondition is asserted and
      // the removal is tolerant, so a put() that never wrote the file reports a
      // RED here rather than throwing and taking this file's verdict with it.
      const d0 = await o.cacheDir();
      const victim = `${key}.${STEMS[2]}.wav`;
      ok('the stem file about to be removed is really there — the precondition',
        o.names().includes(victim), victim);
      await d0.removeEntry(victim).catch(() => {});
      ok('get() returns null rather than a track missing one stem', (await c.get(key)) === null);
      ok('...and the lying entry is dropped from the manifest, not left to fail again',
        !(await c.has(key)));
      const left = o.names().filter((n) => n.startsWith(key));
      ok('...and the surviving stem files are swept with it', left.length === 0, left.join(',') || 'none');
    } catch (e) {
      blockThrew('cache — get() self-heals an entry that lies about its files', e);
    } finally { o.restore(); }
  }

  head('cache — evict() is LRU and the pin is never a candidate');
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);           // room for all three first
      const keys = ['a1', 'b2', 'c3'].map((v) => cacheKey(v, 1.95));
      for (let i = 0; i < keys.length; i++) await c.put(keys[i], { videoId: keys[i] }, makeStems(256, 20 + i * 20));
      ok('three entries are in the cache before any eviction', (await c.list()).length === 3);

      // Explicit usedAt, so the order under test is stated rather than raced:
      // keys[0] is the OLDEST and is also the one we pin.
      const d = await o.cacheDir();
      const m = JSON.parse(await (await (await d.getFileHandle('manifest.json')).getFile()).text());
      m.entries.forEach((e) => { e.usedAt = 1000 + keys.indexOf(e.key); });
      const w = await (await d.getFileHandle('manifest.json', { create: true })).createWritable();
      await w.write(new TextEncoder().encode(JSON.stringify(m))); await w.close();

      // Read the size off the manifest rather than assuming one — and say so, so
      // a StemCache that records nothing produces a RED here instead of a
      // TypeError that takes this whole file's verdict down with it.
      const rows = await c.list();
      ok('the entries carry the byte counts eviction works from',
        rows.length === 3 && rows.every((e) => e.bytes > 0), rows.map((e) => e.bytes).join(',') || 'no rows');
      const one = rows.length ? rows[0].bytes : 1;
      c.maxBytes = one;                       // room for exactly one entry
      const plan = await c.evict(keys[0]);    // pin the OLDEST — LRU would take it first

      ok('evict() removed something, so the pin below is not vacuous', plan.removed.length > 0, `${plan.removed.length} removed`);
      ok('the PINNED entry survives even though it is the oldest',
        (await c.has(keys[0])), 'pin = the LRU victim');
      ok('the two unpinned entries are the ones that went',
        !(await c.has(keys[1])) && !(await c.has(keys[2])),
        plan.removed.map((e) => e.key).join(','));
      const names = o.names();
      ok('eviction deletes the stem FILES, not just the manifest rows',
        STEMS.every((s) => !names.includes(`${keys[1]}.${s}.wav`) && !names.includes(`${keys[2]}.${s}.wav`)));
      ok('...and leaves the pinned track\'s files alone',
        STEMS.every((s) => names.includes(`${keys[0]}.${s}.wav`)));
      ok('the report says what it removed, so a UI can tell the user',
        plan.removed.length === 2 && plan.removed.every((e) => typeof e.bytes === 'number'));
      ok('wouldExceed is true when the pin alone is over the cap — the cache says so rather than deleting it',
        (await (async () => { c.maxBytes = 1; return (await c.evict(keys[0])).wouldExceed; })()) === true);
    } catch (e) {
      blockThrew('cache — evict() is LRU and the pin is never a candidate', e);
    } finally { o.restore(); }
  }

  head('cache — CacheWriter.commit(): an interrupted prime never becomes an entry');
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);
      // The positive control FIRST: commit() must be able to return an entry,
      // or the null below proves nothing.
      const good = new CacheWriter(cacheKey('ok1', 1.95), { videoId: 'ok1' });
      good.append(makePlanes(128, 2), 128);
      good.append(makePlanes(128, 40), 128);
      const r = await good.commit(c);
      ok('a writer that ran to the end commits an entry', r !== null && r.frames === 256, r ? String(r.frames) : 'null');
      const back = await c.get(good.key);
      ok('...and that entry is readable back', back !== null);
      ok('...and commit() reports the seconds it derived from the frames',
        back !== null && back.meta.seconds === +(256 / SR).toFixed(2),
        back ? String(back.meta.seconds) : 'no entry');

      const w = new CacheWriter(cacheKey('bad1', 1.95), { videoId: 'bad1' });
      w.append(makePlanes(128, 60), 128);
      ok('the aborted writer really had frames to lose — the precondition', w.frames === 128);
      w.abort();
      ok('abort() drops the frames it was holding', w.frames === 0);
      ok('commit() after abort() returns null', (await w.commit(c)) === null);
      ok('...and writes NOTHING to the cache', !(await c.has(w.key)));

      const empty = new CacheWriter(cacheKey('bad2', 1.95), { videoId: 'bad2' });
      ok('commit() with nothing appended also returns null', (await empty.commit(c)) === null);
      ok('...and leaves no entry behind', !(await c.has(empty.key)));

      const late = new CacheWriter(cacheKey('bad3', 1.95), { videoId: 'bad3' });
      late.abort();
      late.append(makePlanes(128, 80), 128);
      ok('append() after abort() is ignored, so a late hop cannot revive a dead prime', late.frames === 0);
      ok('...and it still commits to null', (await late.commit(c)) === null);
    } catch (e) {
      blockThrew('cache — CacheWriter.commit(): an interrupted prime never becomes an entry', e);
    } finally { o.restore(); }
  }

  head('cache — the tier boundary holds through get, put, delete and evict too');
  /**
   * U0 (#33) proved the boundary for `list()` and `clear()`. It was never only
   * those two: `dir()` was module-level and ignored `this`, so ALL SIX methods
   * read and wrote the first tier's directory — a second cache would have
   * RETURNED another tier's tracks and WRITTEN its stems where that tier would
   * find them, not merely cleared it. These are the other four, so the fix is
   * pinned everywhere it was broken rather than everywhere it was loudest.
   *
   * Watched red by U0's mutation 1: revert `dir(name)` to
   * `getDirectoryHandle(CACHE_DIR)` and every assertion here goes red.
   */
  {
    const o = installOpfs();
    try {
      const live = new StemCache(1 << 30);
      const f32 = new StemCache(1 << 30, 'stemcache-f32');
      const stems = makeStems(64, 5);
      await live.put('k-live', { title: 'live' }, stems);
      await f32.put('k-32f', { title: 'f32' }, stems);

      const inLive = (p) => o.names(CACHE_DIR).some((n) => n.startsWith(p));
      const in32 = (p) => o.names('stemcache-f32').some((n) => n.startsWith(p));
      ok('put() writes into the caller\'s own directory and only there',
        inLive('k-live.') && !inLive('k-32f.') && in32('k-32f.') && !in32('k-live.'),
        `${CACHE_DIR}=[${o.names(CACHE_DIR).length} files] stemcache-f32=[${o.names('stemcache-f32').length} files]`);

      ok('get() cannot reach across the boundary — each tier misses the other\'s key',
        (await f32.get('k-live')) === null && (await live.get('k-32f')) === null);
      ok('...and this is not a cache that simply reads nothing: each tier still gets its own back',
        (await live.get('k-live')) !== null && (await f32.get('k-32f')) !== null);

      // EVICT BEFORE DELETE, AND THE ORDER IS LOAD-BEARING. When the delete ran
      // first, a shared-directory regression had already removed `k-live`
      // through f32 by the time evict was reached, so `evict()` saw one entry
      // and the assertion below passed for the wrong reason — it was masked by
      // an earlier statement in its own block. Evicting first leaves both
      // entries present, so the shared-directory case really is what this
      // measures. Do not reorder these two.
      f32.maxBytes = 1;                    // force it to evict everything it owns
      const plan = await f32.evict();
      ok('evict() only ever considers its own tier\'s entries',
        plan.removed.length === 1 && plan.removed[0].key === 'k-32f',
        plan.removed.map((e) => e.key).join(',') || 'nothing removed');
      ok('...so a cap of 1 byte on one tier does not empty the other',
        (await live.has('k-live')) && STEMS.every((s2) => o.names(CACHE_DIR).includes(`k-live.${s2}.wav`)));

      await f32.delete('k-live');          // a key that is not f32's to delete
      ok('delete() on one tier cannot remove the other tier\'s entry', await live.has('k-live'));
      ok('...nor the other tier\'s files', STEMS.every((s2) => o.names(CACHE_DIR).includes(`k-live.${s2}.wav`)));
    } catch (e) {
      blockThrew('cache — the tier boundary holds through get, put, delete and evict too', e);
    } finally { o.restore(); }
  }
  // ======================================================== U2: the 32f tier
  head('cache — the 32f tier keys apart from the live one, and the LIVE KEY DOES NOT MOVE');
  {
    /**
     * THE FIRST ASSERTION IS THE ONE THAT PROTECTS EVERY EXISTING USER, and it is
     * written as a SHAPE rather than as a comparison against a stored string,
     * because there is nothing to compare against: the old function is gone. A
     * shape anchored at both ends goes red the moment anything is appended,
     * which is the only way the tier component could have moved a legacy key.
     */
    const legacy = pipelineVersion(1.95);
    ok('a legacy call carries NO tier component — the live cache\u2019s keys are byte-identical  '
      + '[entry point: pipelineVersion(hop) with no tier, the call offscreen/engine.js makes]',
      /^f1-[0-9a-f]{12}-sr44100-seg343980-hop1950-x50[LP]$/.test(legacy), legacy);
    ok('...and spelling the legacy tier out loud is the same string, so the default is not a second format  '
      + '[entry point: pipelineVersion(hop, {depth:16, geometry:\u2019causal\u2019})]',
      pipelineVersion(1.95, { depth: 16, geometry: 'causal' }) === legacy, legacy);

    const f32 = pipelineVersion(1.95, { depth: 32 });
    ok('a 32f entry keys DIFFERENTLY from a 16-bit one for the same track and hop',
      f32 !== legacy && /-d32f-gc$/.test(f32), f32);
    const off = pipelineVersion(1.95, { depth: 32, geometry: 'offline' });
    ok('...and a symmetric-window entry keys differently again — geometry changes the samples',
      off !== f32 && /-d32f-go$/.test(off), off);
    ok('the tier reaches the KEY, not just the version  '
      + '[entry point: cacheKey(id, hop, tier)]',
      cacheKey('abc', 1.95, { depth: 32 }) !== cacheKey('abc', 1.95)
      && cacheKey('abc', 1.95, { depth: 32 }).startsWith('abc--'),
      cacheKey('abc', 1.95, { depth: 32 }));
  }

  head('cache — storage arithmetic at both depths');
  {
    // 240 s x 44 100 = 10 584 000 frames. 16-bit stereo is 4 B/frame/stem,
    // 32f is 8; six stems either way, plus one 44-byte header per stem file.
    ok('bytesForSeconds is UNCHANGED at the live depth — 254.0 MB for four minutes',
      bytesForSeconds(240) === 254016264 && bytesForSeconds(240, 16) === 254016264,
      String(bytesForSeconds(240)));
    ok('...and exactly doubles at 32f — 508.0 MB, the number the cap is sized from',
      bytesForSeconds(240, 32) === 508032264
      && bytesForSeconds(240, 32) - STEMS.length * 44 === 2 * (bytesForSeconds(240) - STEMS.length * 44),
      String(bytesForSeconds(240, 32)));
    ok('the 32f cap clears the pinned floor its own comment claims: two 10-minute entries',
      STEM_CACHE_32F_MAX_BYTES > 2 * bytesForSeconds(600, 32),
      `${(STEM_CACHE_32F_MAX_BYTES / 1024 ** 3).toFixed(2)} GiB cap vs `
      + `${(2 * bytesForSeconds(600, 32) / 1024 ** 3).toFixed(2)} GiB pinned floor`);
  }

  head('cache — a 32f tier writes 32-bit float, into its own directory, and leaves the live tier alone');
  {
    const o = installOpfs();
    try {
      const live = new StemCache(50 * 1024 * 1024);
      const f32 = new StemCache(50 * 1024 * 1024, CACHE_DIR_32F, { depth: 32, geometry: 'offline' });
      const stems = makeStems(256, 5);
      // Out of range on purpose: 32f is the export source and must not clip.
      stems[STEMS[0]][0][7] = 1.7;

      await live.put(live.keyFor('t', 1.95), { videoId: 't' }, makeStems(256, 9));
      const k32 = f32.keyFor('t', 1.95);
      await f32.put(k32, { videoId: 't' }, stems);

      ok('keyFor() stamps the instance\u2019s own tier, so a key cannot disagree with its bytes  '
        + '[entry point: StemCache.keyFor()]',
        k32 === cacheKey('t', 1.95, { depth: 32, geometry: 'offline' }) && /-d32f-go$/.test(k32), k32);

      const back = await f32.get(k32);
      ok('the 32f entry records what it IS, not just what it is called',
        back !== null && back.meta.depth === 32 && back.meta.geometry === 'offline',
        back ? `depth ${back.meta.depth}, geometry ${back.meta.geometry}` : 'no entry');
      ok('...and the file on disk really is IEEE float, not 32-bit fixed point',
        (await (async () => {
          const d = await o.root.getDirectoryHandle(CACHE_DIR_32F, { create: true });
          const f = await (await d.getFileHandle(`${k32}.${STEMS[0]}.wav`)).getFile();
          const w = decodeWav(await f.arrayBuffer());
          return w.float === true && w.bitDepth === 32;
        })()));
      ok('...and it did not clip the out-of-range sample the export depends on',
        back !== null && back.stems[STEMS[0]][0][7] === Math.fround(1.7),
        back ? String(back.stems[STEMS[0]][0][7]) : 'no entry');
      ok('a 32f entry is bigger than a 16-bit one of the same length, which is what the cap pays for',
        back !== null && (await live.size()) > 0 && (await f32.size()) > (await live.size()),
        `${await f32.size()} vs ${await live.size()}`);

      ok('the live tier still holds exactly its own one track  '
        + '[entry point: two StemCache instances, different directories]',
        (await live.list()).length === 1 && (await f32.list()).length === 1);
      const names32 = o.names(CACHE_DIR_32F);
      const namesLive = o.names(CACHE_DIR);
      ok('...and the stem files are in two directories on disk',
        names32.some((n) => n.startsWith(k32)) && !namesLive.some((n) => n.startsWith(k32)),
        `${CACHE_DIR_32F}: ${names32.length} files, ${CACHE_DIR}: ${namesLive.length}`);
    } catch (e) {
      blockThrew('cache — a 32f tier writes 32-bit float, into its own directory, and leaves the live tier alone', e);
    } finally { o.restore(); }
  }

  head('cache — eviction takes a SET of pins, and refuses before the model rather than after');
  {
    const e = (key, bytes, usedAt) => ({ key, bytes, usedAt });
    /**
     * MULTI-CHARACTER KEYS ON PURPOSE. `new Set('a')` and `new Set(['a'])` are the
     * same set, so single-character keys would make the string branch of the pin
     * normaliser indistinguishable from the iterable one — the single-pin
     * assertion below would pass whether or not that branch existed.
     */
    const entries = [e('aa', 100, 1), e('bb', 100, 2), e('cc', 100, 3)];
    // 300 B held against a 150 B cap: two entries have to go, and the pinned one
    // is never a candidate however old it is.
    const one = planEviction(entries, 150, 'aa');
    ok('a single pin still works, so the live path\u2019s one call site is unchanged  '
      + '[entry point: planEviction(entries, cap, "a")]',
      one.removed.map((x) => x.key).join() === 'bb,cc' && one.bytes === 100 && one.wouldExceed === false,
      one.removed.map((x) => x.key).join());
    const many = planEviction(entries, 150, ['aa', 'bb']);
    ok('...and a SET of pins keeps every one of them — two decks and an export can be open at once',
      many.removed.map((x) => x.key).join() === 'cc',
      many.removed.map((x) => x.key).join() || 'nothing removed');
    const all = planEviction(entries, 150, ['aa', 'bb', 'cc']);
    ok('with everything pinned it removes NOTHING and says wouldExceed rather than deleting a track in use',
      all.removed.length === 0 && all.wouldExceed === true && all.bytes === 300,
      `${all.removed.length} removed, wouldExceed ${all.wouldExceed}`);

    /**
     * `separationRefusal` is the thing that makes the cap honest. Pure, and it
     * takes the manifest rather than the cache, so it can answer before the
     * decode and before the model — the same shape `primeRefusal` has.
     */
    const big = [e('open', bytesForSeconds(600, 32), 1)];
    ok('a separation that fits is allowed, so the refusals below are not vacuous  '
      + '[entry point: separationRefusal(seconds, entries, cap, pins)]',
      separationRefusal(240, [], STEM_CACHE_32F_MAX_BYTES, null, 32) === null);
    const tooBig = separationRefusal(60 * 60 * 4, [], STEM_CACHE_32F_MAX_BYTES, null, 32);
    ok('a track too big for the WHOLE cache is refused naming both sizes',
      typeof tooBig === 'string' && /GiB/.test(tooBig), tooBig || 'ALLOWED');
    const pinnedOut = separationRefusal(600, big, bytesForSeconds(600, 32) + 1000, ['open'], 32);
    ok('...and so is one that cannot fit BESIDE the tracks that are open — the slow leak, refused early',
      typeof pinnedOut === 'string' && /pinned/.test(pinnedOut), pinnedOut || 'ALLOWED');
    ok('...while the same track fits once that pin is released, so the refusal is about the pin and not the size',
      separationRefusal(600, big, bytesForSeconds(600, 32) + 1000, null, 32) === null);
    ok('a source that decoded to nothing is refused rather than cached as an empty track',
      typeof separationRefusal(0, [], STEM_CACHE_32F_MAX_BYTES, null, 32) === 'string');
  }

  head('cache — a cached entry records the chunks that went out UNSEPARATED');
  {
    const o = installOpfs();
    try {
      const c = new StemCache(50 * 1024 * 1024);
      const w = new CacheWriter(cacheKey('dr', 1.95), { videoId: 'dr' });
      w.append(makePlanes(128, 11), 128);
      w.noteDrop();
      w.append(makePlanes(128, 13), 128);
      w.noteDrop(2);
      await w.commit(c);
      const back = await c.get(w.key);
      ok('drops survive the commit, so a surface can warn that part of a track is not separated  '
        + '[entry point: CacheWriter.noteDrop() -> commit() -> the manifest]',
        back !== null && back.meta.drops === 3, back ? String(back.meta.drops) : 'no entry');

      const clean = new StemCache(50 * 1024 * 1024);
      await clean.put('k-clean', { videoId: 'x' }, makeStems(64, 3));
      const cb = await clean.get('k-clean');
      ok('...and an entry nobody dropped a chunk into records 0 by construction, not by absence',
        cb !== null && cb.meta.drops === 0, cb ? String(cb.meta.drops) : 'no entry');

      const ab = new CacheWriter(cacheKey('dr2', 1.95), { videoId: 'dr2' });
      ab.append(makePlanes(64, 15), 64);
      ab.noteDrop();
      ab.abort();
      ok('abort() drops the drop count with the audio — a dead prime carries nothing forward',
        ab.drops === 0);
    } catch (e) {
      blockThrew('cache — a cached entry records the chunks that went out UNSEPARATED', e);
    } finally { o.restore(); }
  }

  head('cache — the writer REPORTS a length it cannot honour instead of crashing three layers away');
  {
    const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
    const w = new CacheWriter('k', {});
    const short = threw(() => w.append(makePlanes(64, 21), 128));
    ok('a length longer than the planes is refused, naming both counts  '
      + '[entry point: CacheWriter.append()] — slice() would shorten it silently while '
      + 'frames took the full length, and the entry would commit with silence in the tail',
      short !== null && /128/.test(short) && /64/.test(short), short || 'ACCEPTED 128 frames from a 64-frame plane');
    ok('...and it took no frames with it, so a refused append cannot half-land', w.frames === 0);
    const bad = threw(() => w.append(makePlanes(64, 23), undefined));
    ok('a non-integer length is refused too — `frames += undefined` is NaN, and a NaN-sized '
      + 'Float32Array is what turned the next stems() into a RangeError from inside set()',
      bad !== null && /integer/.test(bad), bad || 'ACCEPTED undefined as a frame count');

    /**
     * The SECOND line of defence, reached by corrupting the counter directly.
     * `append()` above now refuses every input that produces this state, so the
     * only way to it is by hand — which is the point: `stems()` is what the
     * entry's correctness rests on, and it used to answer a disagreement with
     * `RangeError: offset is out of bounds` thrown from inside `Float32Array.set`,
     * a stack trace with no caller in it that takes a whole suite down with it.
     */
    const w2 = new CacheWriter('k2', {});
    w2.append(makePlanes(64, 25), 64);
    w2.frames = 999;                       // the disagreement, forced
    const msg = threw(() => w2.stems());
    ok('a frame counter that disagrees with the audio is NAMED, not thrown from inside Float32Array.set  '
      + '[entry point: CacheWriter.stems()]',
      msg !== null && /999/.test(msg) && /64/.test(msg) && !/offset is out of bounds/.test(msg),
      msg || 'RETURNED A SILENTLY PADDED TRACK');
    ok('...and it says which way the entry would have been wrong',
      msg !== null && /padded with silence/.test(msg), msg);
  }
}

// ===========================================================================
if (group('mix')) {
  head('mix — fader law (AUDIO.md §3.1)');
  ok('unity at u = 0.80', Math.abs(faderDb(0.8)) < 1e-12);
  ok('+6 dB at the top and hard zero at exactly u = 0',
    faderDb(1) === 6 && faderDb(0) === -Infinity && dbToGain(faderDb(0)) === 0);
  ok('-60 dB at the bottom of travel', Math.abs(faderDb(1e-9) + 60) < 1e-6);
  {
    let worst = 0;
    for (let i = 1; i <= 1000; i++) { const u = i / 1000; worst = Math.max(worst, Math.abs(dbToFader(faderDb(u)) - u)); }
    ok('dbToFader is the exact inverse (presets round-trip)', worst < 1e-12, `worst ${worst.toExponential(2)}`);
  }
  ok('the law is linear in dB, not in amplitude (a cube law gives -5.8 dB at u=0.8)',
    Math.abs(faderDb(0.8) - 0) < 1e-12 && Math.abs(20 * Math.log10(0.8 ** 3) + 5.8) < 0.05);

  head('mix — the wire contract with the console UI');
  // faderDb / dbToFader / dbToGain now have a second consumer (ui/audio-math.js
  // imports them, so there is one implementation of the normative law). These
  // checks are the interface, not internals.
  ok('SILENT_DB is -120 and maps to TRUE zero, not 1e-6',
    SILENT_DB === -120 && dbToGain(-120) === 0 && dbToGain(-121) === 0 && dbToGain(-1e9) === 0);
  ok('-Infinity also maps to true zero (it does not survive structured clone, hence the sentinel)',
    dbToGain(-Infinity) === 0);
  ok('the sentinel is far below the bottom of the fader\'s own travel',
    faderDb(1e-9) > SILENT_DB + 50, `fader bottoms out at ${faderDb(1e-9).toFixed(0)} dB`);
  ok('just above the sentinel is still a real (tiny) gain, not silently snapped',
    dbToGain(-119) > 0 && dbToGain(-119) < 1e-5, `${dbToGain(-119).toExponential(2)}`);
  ok('0 dB is unity and +6 dB is 2x', dbToGain(0) === 1 && Math.abs(dbToGain(6) - 1.9953) < 1e-3);
  {
    // Asserted at EVERY stem index, not just index 0: resolveGains maps over the
    // array, so index 0 passing says nothing about whether the array it was
    // handed was six long. A four-wide caller would have been invisible here.
    const sentinelBad = STEMS.filter((_, k) => {
      const strips = openStrips();
      strips[k].gainDb = SILENT_DB;
      const g = resolveGains(strips);
      return g.length !== STEMS.length || g[k] !== 0 || g.filter((v) => v === 1).length !== STEMS.length - 1;
    });
    ok('a stem at the sentinel resolves to exactly 0 through the solo/mute table, at any of the six positions',
      sentinelBad.length === 0, sentinelBad.length ? `wrong at ${sentinelBad.join(',')}` : `${STEMS.length}/${STEMS.length}`);
  }
  ok('primedPct is 0..1, never 0..100', primedPct(0) === 0 && primedPct(SEGMENT) === 1 && primedPct(SEGMENT * 99) === 1);

  head('mix — mute/solo truth table (AUDIO.md §3.2)');
  {
    const S = (mute, solo) => ({ gainDb: 0, muted: mute, soloed: solo });
    /**
     * SIX COLUMNS, and three of the rows are new rather than the old seven
     * padded out. Padding would have widened the table without widening its
     * COVERAGE: every original row leaves guitar and piano open and unsoloed, so
     * a resolver that stopped at four would produce the correct answer for the
     * columns those rows actually interrogate. The three added rows put the
     * decisive stem at index 4 and index 5, which is the only place a truncated
     * loop shows up.
     */
    const cases = [
      // [drums, bass, other, vocals, guitar, piano] as [mute, solo] -> audible
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 1, 1, 1, 1, 1], why: 'nothing muted, nothing soloed' },
      { st: [[1, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [0, 1, 1, 1, 1, 1], why: 'a mute silences that stem' },
      { st: [[0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 0, 0, 0, 0, 0], why: 'any solo silences everything else' },
      { st: [[0, 1], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 1, 0, 0, 0, 0], why: 'multiple solos are a UNION' },
      { st: [[1, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 0, 0, 0, 0, 0], why: 'solo overrides the soloed stem’s own mute' },
      { st: [[1, 1], [1, 0], [0, 0], [0, 0], [0, 0], [0, 0]], want: [1, 0, 0, 0, 0, 0], why: 'a muted non-soloed stem stays silent' },
      { st: [[0, 0], [1, 1], [1, 0], [0, 0], [0, 0], [0, 0]], want: [0, 1, 0, 0, 0, 0], why: 'mute+solo on one, mute on another' },
      // --- the three that only exist at six stems
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1]], want: [0, 0, 0, 0, 0, 1], why: 'the LAST stem soloed — piano alone, the row a four-wide loop cannot get right' },
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [0, 0]], want: [1, 1, 1, 1, 0, 1], why: 'a mute on guitar silences guitar and nothing else' },
      { st: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 1]], want: [0, 0, 0, 0, 1, 1], why: 'the solo UNION lands entirely on the two new stems' },
    ];
    let bad = '';
    for (const c of cases) {
      if (c.st.length !== STEMS.length || c.want.length !== STEMS.length) { bad += `[${c.why}: row is not ${STEMS.length} wide] `; continue; }
      const g = resolveGains(c.st.map(([m, so]) => S(!!m, !!so)));
      if (g.length !== STEMS.length) { bad += `[${c.why}: resolveGains returned ${g.length}] `; continue; }
      const got = g.map((v) => (v > 0 ? 1 : 0));
      if (got.join('') !== c.want.join('')) bad += `[${c.why}: got ${got.join('')} want ${c.want.join('')}] `;
    }
    ok(`${cases.length} rows of the truth table, ${STEMS.length} columns each`, !bad, bad);
    // solo-in-place: the soloed stem does not get make-up gain. Checked on the
    // LAST stem as well as the first — make-up gain applied by index would be
    // invisible at index 0.
    const g0 = resolveGains(openStrips().map((s, k) => (k === 0 ? S(false, true) : s)));
    const g5 = resolveGains(openStrips().map((s, k) => (k === STEMS.length - 1 ? S(false, true) : s)));
    ok('solo is solo-in-place (no make-up gain on the soloed stem), first stem and last',
      Math.abs(g0[0] - 1) < 1e-12 && Math.abs(g5[STEMS.length - 1] - 1) < 1e-12,
      `${STEMS[0]} ${g0[0]}, ${STEMS[STEMS.length - 1]} ${g5[STEMS.length - 1]}`);
    // un-soloing restores the previous mutes
    const st = openStrips(); st[0] = S(true, true);
    const soloed = resolveGains(st).map((v) => (v > 0 ? 1 : 0)).join('');
    st[0].soloed = false;
    ok('un-soloing restores mute (they are independent booleans, never a tri-state)',
      soloed === '1' + '0'.repeat(STEMS.length - 1) &&
      resolveGains(st).map((v) => (v > 0 ? 1 : 0)).join('') === '0' + '1'.repeat(STEMS.length - 1),
      `soloed ${soloed}`);
  }

  head('mix — a LONE deck is never attenuated by an untouched crossfader');
  {
    // The control defaults to centre = -3.01 dB per deck on `dip`. Correct with
    // two decks, wrong with one — and it shipped as a -10.63 dB "separation"
    // regression in the Sigma-stems gate that was really the mixer.
    ok('one deck loaded parks the crossfader on it (unity, not -3.01 dB)',
      effectiveXfPosition(0.5, { A: true, B: false }) === 0 &&
      effectiveXfPosition(0.5, { A: false, B: true }) === 1);
    ok('both decks loaded honour the control',
      effectiveXfPosition(0.5, { A: true, B: true }) === 0.5 &&
      effectiveXfPosition(0.2, { A: true, B: true }) === 0.2);
    ok('nothing loaded changes nothing', effectiveXfPosition(0.5, { A: false, B: false }) === 0.5);
    const lone = resolveDeckGains('A', openStrips(), XF_ALL,
      effectiveXfPosition(0.5, { A: true, B: false }), 'dip');
    ok('so a lone deck A plays at UNITY through the whole chain, on all six stems',
      lone.stems.length === STEMS.length && lone.stems.every((v) => Math.abs(v - 1) < 1e-12),
      JSON.stringify(lone.stems.map((v) => +v.toFixed(4))));
    const pair = resolveDeckGains('A', openStrips(), XF_ALL,
      effectiveXfPosition(0.5, { A: true, B: true }), 'dip');
    ok('and only drops to -3.01 dB once deck B is actually loaded, on all six stems',
      pair.stems.length === STEMS.length && pair.stems.every((v) => Math.abs(v - Math.SQRT1_2) < 1e-12),
      `[${pair.stems.map((v) => v.toFixed(4)).join(' ')}]`);
  }

  head('mix — METERS are post-fader, PRE-crossfader (a cued deck must still meter)');
  {
    // RENDERING ONLY for the summing line; REACHABLE for the gain split, which
    // drives the real resolveDeckGains(). Reachability for the tap point itself:
    // run-ext.mjs asserts a crossfaded-out deck keeps its meters.
    const open6 = openStrips();
    const XFALL = XF_ALL;
    // deck A crossfaded FULLY out (position 1 = full B)
    const a = resolveDeckGains('A', open6, XFALL, 1, 'dip');
    ok('a deck faded fully out is silent in the audio path, on all six stems',
      a.stems.length === STEMS.length && a.stems.every((v) => v === 0), JSON.stringify(a.stems));
    ok('...but its METER gain stays at unity on all six, so the DJ can cue it',
      a.meter.length === STEMS.length && a.meter.every((v) => v === 1) && a.xf.every((v) => v === 0),
      `meter ${JSON.stringify(a.meter)} xf ${JSON.stringify(a.xf)}`);
    ok('audio gain is exactly meter x xf — the split cannot drift from the sum',
      a.stems.every((v, i) => Math.abs(v - a.meter[i] * a.xf[i]) < 1e-12));
    // Mute and solo are on the METERED side, so they still zero the meter. Driven
    // on GUITAR rather than drums: the four-stem form only ever moved index 0,
    // which a resolver truncated at four still handles correctly.
    const muted = openStrips(); muted[S_IDX.guitar].muted = true;
    const m = resolveDeckGains('A', muted, XFALL, 0, 'dip');
    ok('a MUTED guitar reads zero on the meter (mute is pre-tap, unlike the crossfader)',
      m.meter[S_IDX.guitar] === 0 && m.stems[S_IDX.guitar] === 0 &&
      STEMS.every((s, k) => k === S_IDX.guitar || m.meter[k] === 1),
      `meter ${JSON.stringify(m.meter)}`);
    const soloed = openStrips(); soloed[S_IDX.piano].soloed = true;
    const so = resolveDeckGains('A', soloed, XFALL, 0, 'dip');
    ok('a soloed PIANO zeroes the other five stems on the meter too',
      so.meter[S_IDX.piano] === 1 && STEMS.every((s, k) => k === S_IDX.piano || so.meter[k] === 0),
      `meter ${JSON.stringify(so.meter)}`);
    // at the centre of a dip crossfader the audio is -3.01 dB but the meter is not
    const c = resolveDeckGains('A', open6, XFALL, 0.5, 'dip');
    ok('at centre the audio is -3.01 dB and the meter is still 0 dB',
      Math.abs(c.stems[0] - Math.SQRT1_2) < 1e-12 && c.meter[0] === 1,
      `audio ${c.stems[0].toFixed(4)} meter ${c.meter[0]}`);
  }

  head('mix — the two crossfades must never be unified (they need OPPOSITE laws)');
  {
    /**
     * There are two crossfades in this product and the same word names both:
     *   SEAM_XFADE_LAW  joins two chunks of the SAME audio inside one deck.
     *                   Correlated => amplitudes add => LINEAR.
     *   XF_CURVE_DEFAULT crossfades two DIFFERENT records between decks.
     *                   Uncorrelated => powers add => CONSTANT POWER.
     * The deciding variable is correlation, not anything about faders. This
     * block fails if anyone ever makes them agree, which is exactly what a
     * well-meaning "unify the crossfade laws" refactor would do.
     */
    const n = 512;
    const seam = makeFades(n, SEAM_XFADE_LAW);
    let worstAmp = 0;
    for (let i = 0; i < n; i++) worstAmp = Math.max(worstAmp, Math.abs(seam.fi[i] + seam.fo[i] - 1));
    ok('SEAM: complementary AMPLITUDE across the join (fi + fo = 1)',
      worstAmp < 1e-6, `max |fi+fo-1| = ${worstAmp.toExponential(2)} under '${SEAM_XFADE_LAW}'`);

    let worstPow = 0;
    for (let i = 0; i <= 100; i++) {
      const g = xfaderGains(i / 100, XF_CURVE_DEFAULT);
      worstPow = Math.max(worstPow, Math.abs(g.a * g.a + g.b * g.b - 1));
    }
    ok('DECK: constant POWER across the sweep (a² + b² = 1)',
      worstPow < 1e-12, `max |a²+b²-1| = ${worstPow.toExponential(2)} under '${XF_CURVE_DEFAULT}'`);

    // the midpoints are the whole argument, in one number each
    const sMid = seam.fi[n >> 1];
    const dMid = xfaderGains(0.5, XF_CURVE_DEFAULT).a;
    ok('and their midpoints DIFFER — 0.500 vs 0.707 is the +/-3.01 dB at stake',
      Math.abs(sMid - 0.5) < 0.01 && Math.abs(dMid - Math.SQRT1_2) < 1e-12,
      `seam ${sMid.toFixed(3)} (${(20 * Math.log10(2 * sMid)).toFixed(2)} dB summed) · ` +
      `deck ${dMid.toFixed(3)} (${(20 * Math.log10(dMid)).toFixed(2)} dB each)`);

    // THE unification guard, stated as the refactor it is defending against
    ok('the seam law is NOT the deck law (a "unify the crossfades" refactor fails here)',
      SEAM_XFADE_LAW === 'linear' && XF_CURVE_DEFAULT !== 'lin',
      `seam '${SEAM_XFADE_LAW}' vs deck '${XF_CURVE_DEFAULT}' — if the seam is ever 'equalPower' or the ` +
      `deck default ever 'lin', one of them is 3.01 dB wrong and this is where you find out`);
    ok('`lin` stays available for the case where it IS right: beat-juggling two ' +
       'phase-locked copies of one loop, where the decks ARE correlated',
      XF_CURVES.includes('lin') && Math.abs(xfaderGains(0.5, 'lin').a - 0.5) < 1e-12);
  }

  head('mix — QA-15: a kill must survive a dropped chunk');
  // RENDERING ONLY below the gain vector: `sumAt` reimplements the worklet's
  // summing line. Reached by: run-ext.mjs "EXACTLY zero for the whole kill".
  /**
   * The backpressure ladder substitutes the unseparated mix for a chunk it could
   * not deliver. The stem faders cannot act on that plane — it is the mix, not a
   * stem — so until this was fixed, a drop UNDID the user's kill and the vocal
   * punched back in at full level. Measured before the fix: all four muted,
   * input 0.5/-0.5, output 0.5/-0.5. QA counted 26 such spans in 155 s at the
   * default hop, i.e. ~51 s of a killed vocal returning.
   *
   * This reproduces the playback worklet's summing line verbatim against the
   * real LiveEmitter.gap() and the real resolveGains(), so the conclusion is
   * arithmetic, not inference.
   */
  {
    const p = makeLivePlan(1.95);
    const St = (m, so, db = 0) => ({ gainDb: db, muted: m, soloed: so });
    /**
     * The EIGHT worklet gain slots: `0..5` stems, `6` passthrough, `7` master.
     * It was six slots (`0..3 / 4 / 5`) at four stems. The two indices that
     * moved are exactly the two that mean something other than "a stem", so a
     * build that kept the old literals writes the passthrough onto GUITAR and
     * the master onto PIANO — audible, plausible, and green under the old
     * assertions.
     */
    const slots = (mix, masterDb = 0) => {
      const g = resolveGains(mix);
      return [...g, passthroughGain(g), dbToGain(masterDb)];
    };
    /** offscreen/playback-processor.js, per output sample */
    const sumAt = (planes, i, g) => {
      let L = 0, R = 0;
      for (let q = 0; q < STEM_PLANES; q += 2) { L += planes[q][i] * g[q / 2]; R += planes[q + 1][i] * g[q / 2]; }
      L += planes[PASS_PLANE_L][i] * g[G_PASS]; R += planes[PASS_PLANE_R][i] * g[G_PASS];
      return [L * g[G_MASTER], R * g[G_MASTER]];
    };
    ok(`the slot map is ${STEMS.length} stems then passthrough at ${G_PASS} then master at ${G_MASTER}`,
      slots(openStrips()).length === STEMS.length + 2 && G_PASS === 6 && G_MASTER === 7,
      `${slots(openStrips()).length} slots`);
    const gapPlanes = () => {
      const em = new LiveEmitter(p, 'linear');
      const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(p.L).fill(0.25));
      const mixL = new Float32Array(p.H).fill(0.5), mixR = new Float32Array(p.H).fill(-0.5);
      em.chunk(0, src, mixL, mixR);
      return em.gap(p.H, mixL, mixR).planes;   // the ladder's actual sequence
    };
    const pl = gapPlanes();
    const mid = p.H - 1;                        // past the entry crossfade

    ok('a skipped chunk does put the unseparated mix on planes 12/13 and zero ALL TWELVE stem planes',
      Math.abs(pl[PASS_PLANE_L][mid] - 0.5) < 1e-6 && Math.abs(pl[PASS_PLANE_R][mid] + 0.5) < 1e-6 &&
      Array.from({ length: STEM_PLANES }, (_, q) => pl[q][mid]).every((v) => v === 0));

    // --- the scenario from qa/passthrough-gain.mjs
    const allMuted = STEMS.map(() => St(true, false));
    const gM = slots(allMuted);
    ok('all six stems muted => passthrough gain is 0, not 1', gM[G_PASS] === 0, `slot ${G_PASS} = ${gM[G_PASS]}`);
    const outM = sumAt(pl, mid, gM);
    ok('WITH ALL SIX STEMS MUTED the output during a drop is EXACTLY zero',
      outM[0] === 0 && outM[1] === 0,
      `output ${outM[0].toFixed(4)} / ${outM[1].toFixed(4)} against an input of 0.5000 / -0.5000`);
    let leak = 0;
    for (let i = 0; i < p.H; i++) { const o = sumAt(pl, i, gM); if (o[0] !== 0 || o[1] !== 0) leak++; }
    ok('and it is zero across the WHOLE span, crossfades included', leak === 0, `${leak} non-zero frames of ${p.H}`);

    // --- no regression on the happy path
    const none = openStrips();
    const gN = slots(none);
    ok('nothing killed => passthrough gain is unity, bit-identical to before the fix', gN[G_PASS] === 1);
    let same = true;
    const legacy = [...resolveGains(none), 1, dbToGain(0)];   // the old, unwritten passthrough slot
    for (let i = 0; i < p.H; i += 97) {
      const a = sumAt(pl, i, gN), b = sumAt(pl, i, legacy);
      if (a[0] !== b[0] || a[1] !== b[1]) { same = false; break; }
    }
    ok('the unmuted passthrough span is bit-identical to today', same);

    // --- the rest of the truth table. The kill is applied at EVERY stem index,
    // not just at vocals: `passthroughGain` is a min over the whole vector, so a
    // caller handing it a four-wide slice ducks correctly on drums..vocals and
    // silently ignores a killed guitar or piano — the QA-15 defect, restored for
    // exactly the two stems nobody would think to re-test.
    const notDucked = STEMS.filter((s, k) => {
      const strips = openStrips(); strips[k].muted = true;
      return slots(strips)[G_PASS] !== 0;
    });
    ok('ONE stem killed — any one of the six — is enough to duck the passthrough (the stem cannot return)',
      notDucked.length === 0, notDucked.length ? `not ducked by ${notDucked.join(',')}` : `${STEMS.length}/${STEMS.length}`);
    const soloStrips = openStrips(); soloStrips[0].soloed = true;
    ok('solo ducks it for free (the others resolve to 0)', slots(soloStrips)[G_PASS] === 0);
    const sentinelStrips = openStrips(); sentinelStrips[S_IDX.piano].gainDb = SILENT_DB;
    ok('the -120 dB sentinel ducks it too, applied to the last stem', slots(sentinelStrips)[G_PASS] === 0);
    const partialStrips = openStrips(); partialStrips[S_IDX.guitar].gainDb = -6;
    const partial = slots(partialStrips);
    ok('a partial cut ducks to the quietest, no step',
      Math.abs(partial[G_PASS] - dbToGain(-6)) < 1e-12, `${partial[G_PASS].toFixed(4)} = ${dbToGain(-6).toFixed(4)}`);
    ok('passthroughGain is exactly min(resolved) — nothing sneaks above the quietest stem',
      [[1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 0.5, 1], [1, 1, 1, 1, 1, 0], [0.3, 0.2, 0.9, 0.25, 0.15, 0.4]]
        .every((v) => v.length === STEMS.length && passthroughGain(v) === Math.min(...v)));
  }

  head('mix — per-sample gain smoothing in the playback worklet (AUDIO.md §3.3)');
  // RENDERING ONLY: reimplements the worklet's loop, so it cannot see the worklet
  // failing to run it. Reached by: run-ext.mjs mute-to-silence timing.
  {
    // Mirrors the loop in offscreen/playback-processor.js exactly. If that loop
    // changes, this test must change with it — which is the point.
    const ramp = (from, to, tau, sr = SR) => {
      const a = smoothCoef(tau, sr);
      let g = from, d = Math.ceil(6 * tau * sr);
      const trace = [g];
      while (d > 0) { if (--d === 0) g = to; else g += (to - g) * a; trace.push(g); }
      return trace;
    };
    for (const [name, tau, ms] of [['mute', TAU.mute, 18], ['fader', TAU.fader, 60], ['master', TAU.master, 120]]) {
      const t = ramp(1, 0, tau);
      const settleMs = ((t.length - 1) / SR) * 1000;
      const at3tau = t[Math.round(3 * tau * SR)];
      const overshoot = Math.min(...t) < -1e-12 || Math.max(...t) > 1 + 1e-12;
      ok(`${name} (τ=${(tau * 1000).toFixed(0)} ms): reaches the target in ${settleMs.toFixed(1)} ms (<= ${ms}), 95 % at 3τ, no overshoot`,
        settleMs <= ms + 0.1 && t[t.length - 1] === 0 && Math.abs(at3tau - 0.05) < 0.01 && !overshoot,
        `3τ value ${at3tau.toFixed(4)}`);
    }
    const up = ramp(0, 1, TAU.mute);
    ok('an unmute is exactly 1.0 by 18 ms, not asymptotically close',
      up[up.length - 1] === 1 && ((up.length - 1) / SR) * 1000 <= 18.1);
    const t10 = ramp(1, 0.5, TAU.fader);
    const at20ms = t10[Math.round(0.020 * SR)];
    ok('a fader move is 86 % of the way there by 20 ms — audible immediately, not stepped',
      Math.abs(at20ms - (1 - 0.5 * (1 - Math.exp(-2)))) < 0.01, `g = ${at20ms.toFixed(4)} of 0.5`);
  }

  head('mix — master soft clip (AUDIO.md §4.3), NOT a DynamicsCompressorNode');
  // RENDERING ONLY: `applyCurve` reimplements WaveShaper's interpolation, so it
  // proves the CURVE and never that the node is wired in with 4x oversampling.
  // Reached by: run-ext.mjs reads oversample/curve length off the live graph.
  {
    const curve = softClipCurve(0.7079, 2);
    const at = (dbfs) => 20 * Math.log10(Math.abs(applyCurve(curve, dbToGain(dbfs), 2)));
    ok('-6 dBFS passes through untouched', Math.abs(at(-6) + 6) < 0.01, `${at(-6).toFixed(3)} dBFS`);
    ok('-3 dBFS (the knee) passes through untouched', Math.abs(at(-3) + 3) < 0.02, `${at(-3).toFixed(3)} dBFS`);
    ok('0 dBFS lands at -0.63 dBFS', Math.abs(at(0) + 0.63) < 0.05, `${at(0).toFixed(3)} dBFS`);
    ok('+6 dBFS is held at the ceiling', at(6) < 0.01 && at(6) > -0.1, `${at(6).toFixed(3)} dBFS`);
    ok('+12 dBFS cannot exceed the ceiling (Web Audio clamps the curve input)',
      at(12) <= 0 && Math.abs(at(12) - at(6)) < 1e-3, `${at(12).toFixed(3)} dBFS`);
    ok('the transfer function is monotone and odd',
      softClip(-0.9) === -softClip(0.9) && softClip(0.9) > softClip(0.8));
    /**
     * THE WORST-CASE SUM, RE-DERIVED AT SIX STEMS — AND A FINDING ABOUT WHAT
     * THIS ASSERTION CAN AND CANNOT SEE. Read this before citing it as headroom
     * evidence for the six-stem move.
     *
     * The arithmetic: every stem fader hard at the top is +6 dB = x1.9953, so
     * `STEMS.length` identical stems summed is 6 x 2 = 12.0 linear, where four
     * stems gave 8.0. That IS more summed energy and the number in the assertion
     * moves with it.
     *
     * The physics: it changes NOTHING, and pretending otherwise would be the
     * wrong estimator for the claim (AGENTS.md). `applyCurve` reproduces
     * WaveShaper, which CLAMPS its input to ±1 after the 1/headroom divide — so
     * every input at or above `headroom` (2.0) maps to the same last curve
     * sample. Measured: applyCurve(8, 2) and applyCurve(12, 2) are the identical
     * 0.99992, and so is applyCurve(2, 2). The four-stem form was already
     * saturated: at four stems, at six, at sixty, this returns the ceiling.
     *
     * So it stays green at six stems, and it stays green for a reason that has
     * nothing to do with stem count. IT IS NOT EVIDENCE THAT SIX STEMS IS
     * HEADROOM-SAFE. The clipper cannot let the DAC clip at any input; what six
     * stems changes is how much of the time the clipper is WORKING, which is a
     * measurement (`tools/mashup-probe.mjs`) and is SIX-STEM-CONTRACT §"known
     * debt" item 2 — `DUAL_MASTER_TRIM_DB = -3` was measured with four stems and
     * has not been re-measured. Do not close that item on the strength of this
     * line.
     *
     * Split into arithmetic and physics so the two claims cannot hide behind
     * each other, and the saturation is asserted explicitly rather than left as
     * the silent reason a `<= 1.0` gate passes.
     */
    const worstSum = STEMS.length * dbToGain(6);
    ok(`arithmetic: ${STEMS.length} stems at +6 dB sum to ${worstSum.toFixed(2)} linear, past the shaper's 2.0 headroom`,
      Math.abs(worstSum - STEMS.length * 1.99526) < 1e-3 && worstSum > 2,
      `${worstSum.toFixed(3)} vs ${(4 * dbToGain(6)).toFixed(3)} at four stems`);
    ok(`physics: ${STEMS.length} stems at +6 dB summed cannot leave the DAC clipping`,
      Math.abs(applyCurve(curve, worstSum, 2)) <= 1.0,
      `${applyCurve(curve, worstSum, 2).toFixed(6)} out`);
    ok('...and it is the SATURATED branch doing that, identically at four stems and at six — ' +
       'so this line can never go red on stem count and is not headroom evidence for the 6-stem move',
      applyCurve(curve, worstSum, 2) === applyCurve(curve, 4 * dbToGain(6), 2) &&
      applyCurve(curve, worstSum, 2) === applyCurve(curve, 2, 2) &&
      applyCurve(curve, 1.5, 2) < applyCurve(curve, 2, 2),
      `ceiling ${applyCurve(curve, 2, 2).toFixed(6)}, unsaturated 1.5 -> ${applyCurve(curve, 1.5, 2).toFixed(6)}`);
  }
}

// ===========================================================================
if (group('xf')) {
  head('xf — crossfader curves (docs/design/DESIGN.md §6.4)');
  // Pure maths against production code. Reachability: run-ext.mjs drives XFADER
  // over the wire and reads the resulting gain vector back out of the running
  // worklet; audible-probe.mjs proves it at the DAC.
  {
    const P = Array.from({ length: 201 }, (_, i) => i / 200);

    // --- dip: CONSTANT POWER. This is the one property the curve exists for and
    // the one an "improved" implementation always breaks.
    let worst = 0, worstAt = 0;
    for (const p of P) {
      const { a, b } = xfaderGains(p, 'dip');
      const e = Math.abs(a * a + b * b - 1);
      if (e > worst) { worst = e; worstAt = p; }
    }
    ok('dip sums to UNITY POWER at every one of 201 positions, not just the ends',
      worst < 1e-12, `worst |a²+b²−1| = ${worst.toExponential(2)} at p=${worstAt}`);
    {
      const c = xfaderGains(0.5, 'dip');
      ok('dip centre is −3.0103 dB on both decks (the "dip" the name refers to)',
        Math.abs(20 * Math.log10(c.a) + 3.0103) < 1e-3 && Math.abs(c.a - c.b) < 1e-12,
        `${(20 * Math.log10(c.a)).toFixed(4)} dB`);
      const l = xfaderGains(0, 'dip'), r = xfaderGains(1, 'dip');
      ok('dip ends are hard: p=0 is full A / silent B, p=1 the reverse',
        l.a === 1 && Math.abs(l.b) < 1e-15 && Math.abs(r.a) < 1e-15 && r.b === 1,
        `A ${l.a}/${r.a.toExponential(1)}  B ${l.b.toExponential(1)}/${r.b}`);
    }

    // --- lin: amplitudes sum to 1, which is a 3 dB POWER dip at centre. Both
    // facts matter: the first is why it exists, the second is why it is not the
    // default.
    {
      const bad = P.filter((p) => Math.abs(xfaderGains(p, 'lin').a + xfaderGains(p, 'lin').b - 1) > 1e-12);
      ok('lin sums to unity AMPLITUDE at every position', bad.length === 0);
      const c = xfaderGains(0.5, 'lin');
      ok('lin centre is −6.02 dB per deck (−3.01 dB in power) — the reason dip is the default',
        Math.abs(20 * Math.log10(c.a) + 6.0206) < 1e-3,
        `${(20 * Math.log10(c.a)).toFixed(4)} dB, power ${(10 * Math.log10(c.a * c.a + c.b * c.b)).toFixed(4)} dB`);
    }

    // --- cut: HARD. Both decks at unity across the middle; the cut lives in the
    // last XF_CUT_EDGE of travel. This is the scratch curve and "hard" is the
    // whole specification.
    {
      const mid = P.filter((p) => p > XF_CUT_EDGE && p < 1 - XF_CUT_EDGE);
      ok(`cut holds BOTH decks at exactly unity across the middle ${(100 * (1 - 2 * XF_CUT_EDGE)).toFixed(0)} % of travel`,
        mid.every((p) => { const g = xfaderGains(p, 'cut'); return g.a === 1 && g.b === 1; }),
        `${mid.length} positions checked`);
      const l = xfaderGains(0, 'cut'), r = xfaderGains(1, 'cut');
      ok('cut is silent on the closed deck at each end',
        l.b === 0 && r.a === 0 && l.a === 1 && r.b === 1);
      // "Hard" quantified: how far must the cap travel from the edge before the
      // deck is at full level? A constant-power fader needs 100 % of the travel.
      const toFull = P.find((p) => xfaderGains(p, 'cut').b >= 1);
      ok(`cut reaches FULL level ${(100 * toFull).toFixed(0)} % from the edge (dip needs 100 %) — this is what makes it a scratch curve`,
        Math.abs(toFull - XF_CUT_EDGE) < 1e-9, `${toFull}`);
      ok('cut is NOT constant power (it is not trying to be) — the middle is +3.01 dB',
        Math.abs(10 * Math.log10(2) - 3.0103) < 1e-3 &&
        Math.abs(xfaderGains(0.5, 'cut').a ** 2 + xfaderGains(0.5, 'cut').b ** 2 - 2) < 1e-12);
    }

    // --- shared properties
    for (const curve of XF_CURVES) {
      const g = P.map((p) => xfaderGains(p, curve));
      const monoA = g.every((v, i) => i === 0 || v.a <= g[i - 1].a + 1e-12);
      const monoB = g.every((v, i) => i === 0 || v.b >= g[i - 1].b - 1e-12);
      const bounded = g.every((v) => v.a >= 0 && v.a <= 1 && v.b >= 0 && v.b <= 1);
      const sym = P.every((p, i) => {
        const l = xfaderGains(p, curve), r = xfaderGains(1 - p, curve);
        return Math.abs(l.a - r.b) < 1e-12 && Math.abs(l.b - r.a) < 1e-12;
      });
      ok(`${curve}: A falls monotonically, B rises monotonically, both stay in [0,1], and the curve is A↔B symmetric`,
        monoA && monoB && bounded && sym);
    }
    ok('the position is clamped, not wrapped — a UI that sends 1.5 or −0.2 gets the end, not a fold-back',
      xfaderGains(1.5, 'dip').b === 1 && xfaderGains(-0.2, 'dip').a === 1);
    ok('an unknown curve name falls back to constant power, never to silence',
      xfaderGains(0.5, 'wobble').a === xfaderGains(0.5, 'dip').a);
  }

  head('xf — XF_ASSIGN truth table: a hard-assigned stem IGNORES the fader');
  // The flagship Mode 3 behaviour, and the one place the wire contract needed
  // interpretation. See engine/mixer.js xfFactor() for the reasoning.
  {
    const P = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    // The truth table, stated once, in the same shape the UI's matrix has:
    //   deck   target   expected
    const table = [
      ['A', 'A', 'hard ON  — 1 at every position'],
      ['A', 'B', 'hard OFF — 0 at every position'],
      ['B', 'B', 'hard ON  — 1 at every position'],
      ['B', 'A', 'hard OFF — 0 at every position'],
    ];
    for (const [deck, target, why] of table) {
      const want = target === deck ? 1 : 0;
      const all = XF_CURVES.every((c) => P.every((p) => xfStemGain(deck, target, p, c) === want));
      ok(`deck ${deck} stem assigned "${target}": ${why} (all 3 curves x 7 positions)`, all);
    }
    for (const curve of XF_CURVES) {
      const okXf = [0, 0.25, 0.5, 0.75, 1].every((p) => {
        const g = xfaderGains(p, curve);
        return xfStemGain('A', 'XF', p, curve) === g.a && xfStemGain('B', 'XF', p, curve) === g.b;
      });
      ok(`"XF" follows the fader on the stem's OWN deck side (${curve})`, okXf);
    }
    ok('a missing/undefined target defaults to XF rather than to silence — an under-specified UI must not mute a deck',
      xfFactor('A', undefined, xfaderGains(0, 'dip')) === 1 && XF_ASSIGN_DEFAULT === 'XF');

    // The two-click mashup, end to end. This is the acceptance criterion in
    // ARCHITECTURE §8 Phase 4 expressed as arithmetic.
    {
      /**
       * "vocals from A over the instrumental from B": the master matrix's
       * `vocals` row -> A, every other row -> B. One UI click per row writes TWO
       * XF_ASSIGN messages (one per deck), which is the part a UI would have to
       * infer and must not.
       *
       * The row vector is BUILT FROM STEMS rather than typed as `['B','B','B','A']`.
       * A four-entry assign array against a six-stem strip list is not an error
       * anywhere in `resolveDeckGains` — `assign[4]` and `assign[5]` come back
       * `undefined`, `xfFactor` defaults those to `'XF'`, and guitar and piano
       * quietly start FOLLOWING THE FADER while every other stem is hard-assigned.
       * The mashup still sounds right at the ends of the travel and collapses in
       * the middle. That is exactly the shape of bug this table exists to catch,
       * and a padded literal would have reintroduced it.
       */
      const LEAD = 'vocals';
      const assignA = STEMS.map((s) => (s === LEAD ? 'A' : 'B'));
      const assignB = assignA.slice();
      ok(`the assign row is one entry per stem (${assignA.join(',')}) — a short row silently reverts the tail to XF`,
        assignA.length === STEMS.length && assignA.filter((t) => t === 'A').length === 1);
      const flat = openStrips();
      const bad = [];
      for (const p of [0, 0.5, 1]) {
        for (const curve of XF_CURVES) {
          const a = resolveDeckGains('A', flat, assignA, p, curve).stems;
          const b = resolveDeckGains('B', flat, assignB, p, curve).stems;
          // A contributes the lead stem only; B contributes everything else.
          if (!STEMS.every((s, i) => a[i] === (s === LEAD ? 1 : 0))) bad.push(`A@${p}/${curve}=${a}`);
          if (!STEMS.every((s, i) => b[i] === (s === LEAD ? 0 : 1))) bad.push(`B@${p}/${curve}=${b}`);
        }
      }
      ok('acapella-over-instrumental: A gives vocals only, B gives the other five, and RIDING THE FADER CHANGES NOTHING',
        bad.length === 0, bad.join(' '));
      // ...and every stem is present exactly once across the two decks. A UI
      // that wrote only one of the two messages would double the vocal here.
      const sum = STEMS.map((_, i) =>
        resolveDeckGains('A', flat, assignA, 0.5, 'dip').stems[i] +
        resolveDeckGains('B', flat, assignB, 0.5, 'dip').stems[i]);
      ok(`each of the ${STEMS.length} stems sums to exactly 1.0 across both decks — nothing doubled, nothing missing`,
        sum.length === STEMS.length && sum.every((v) => Math.abs(v - 1) < 1e-12), `[${sum.join(', ')}]`);
      /**
       * THE NEW STEMS AS THE LEAD. The row above puts the decisive stem at
       * index 3, which four-stem code handles correctly. Running the same
       * gesture with guitar and then piano as the lead is what interrogates
       * indices 4 and 5 — and "guitar from A over everything else from B" is a
       * real gesture, not a synthetic one.
       */
      for (const lead of ['guitar', 'piano']) {
        const aRow = STEMS.map((s) => (s === lead ? 'A' : 'B'));
        const gA = resolveDeckGains('A', flat, aRow, 0.5, 'dip').stems;
        const gB = resolveDeckGains('B', flat, aRow, 0.5, 'dip').stems;
        ok(`...and the same gesture with ${lead} as the lead: A gives ${lead} only, B gives the other five`,
          STEMS.every((s, i) => gA[i] === (s === lead ? 1 : 0) && gB[i] === (s === lead ? 0 : 1)),
          `A [${gA.join(' ')}] B [${gB.join(' ')}]`);
      }
    }
  }

  head('xf — the dual-deck master trim, pinned to the peaks that motivated it');
  {
    ok('one deck (or none) gets no trim — Mode 1 and Mode 2 are untouched',
      masterTrimDb(0) === 0 && masterTrimDb(1) === 0);
    ok('two loaded decks default to -3 dB', masterTrimDb(2) === -3);
    /**
     * THE CONSTANT IS PINNED TO ITS EVIDENCE, not to taste. The clip flag arms at
     * 0.99 pre-soft-clip, and the whole point of the trim is that the flagship
     * gesture must not light it (a warning that fires on correct use stops being
     * a warning). These are the three master-bus peaks measured by
     * tools/mashup-probe.mjs at hop 2.6 with the mashup routing applied.
     */
    const MEASURED_PEAKS = [1.196, 1.317, 1.029];
    const g = dbToGain(masterTrimDb(2));
    ok('-3 dB puts every measured mashup peak under the 0.99 clip threshold',
      MEASURED_PEAKS.every((p) => p * g < 0.99),
      MEASURED_PEAKS.map((p) => `${p}->${(p * g).toFixed(3)}`).join(' '));
    ok('...and without it, two of the three would have armed the clip flag on correct use',
      MEASURED_PEAKS.filter((p) => p >= 0.99).length === 3,
      `${MEASURED_PEAKS.filter((p) => p >= 0.99).length} of 3 peaks were >= 0.99 untrimmed`);
    ok('the trim leaves the soft clipper doing almost nothing at the worst measured peak',
      Math.abs(20 * Math.log10(softClip(1.317 * g) / (1.317 * g))) < 0.5,
      `${(20 * Math.log10(softClip(1.317 * g) / (1.317 * g))).toFixed(2)} dB of reduction, was -2.47 dB untrimmed`);
  }

  head('xf — the combined gain vector: mute/solo x crossfader x passthrough');
  {
    const flat = () => openStrips();
    // One 'XF' PER STEM. `['XF','XF','XF','XF']` against six strips leaves
    // assign[4]/assign[5] undefined; that happens to resolve to 'XF' as well, so
    // the old literal would have gone green here while being the wrong length —
    // and the same literal one block below, where the row is NOT all-XF, is a
    // real defect. Same array, two call sites, one of them silent: `AGENTS.md`'s entry-point rule.
    const XF6 = XF_ALL;
    ok(`the assign row is ${STEMS.length} wide, one entry per stem`, XF6.length === STEMS.length);

    {
      const g = resolveDeckGains('A', flat(), XF6, 0.5, 'dip');
      ok('all six stems on XF get the same crossfader gain — a fader move cannot skew the stem balance',
        g.stems.length === STEMS.length && new Set(g.stems.map((v) => v.toFixed(12))).size === 1,
        `[${g.stems.map((v) => v.toFixed(4)).join(' ')}]`);
    }
    {
      // The QA-15 invariant, now under a crossfader. A dropped chunk on a deck
      // that has been faded out must NOT punch that deck's whole unseparated mix
      // back in at unity.
      const g = resolveDeckGains('A', flat(), XF6, 1, 'dip');   // deck A fully out
      ok('a deck faded fully OUT has passthrough gain 0 — a dropped chunk cannot resurrect a deck you just faded away',
        g.pass === 0 && g.stems.every((v) => Math.abs(v) < 1e-15), `pass ${g.pass}`);
      const h = resolveDeckGains('A', flat(), XF6, 0.5, 'dip');
      ok('a deck at the centre detent has passthrough gain equal to its crossfader gain, not unity',
        Math.abs(h.pass - Math.SQRT1_2) < 1e-12, `pass ${h.pass.toFixed(6)}`);
    }
    {
      // Driven on PIANO, the last stem: QA-15's duck is a min() over the whole
      // vector, so a kill at index 5 is the one a truncated loop would miss.
      const m = flat(); m[S_IDX.piano].muted = true;
      const g = resolveDeckGains('A', m, XF6, 0, 'dip');
      ok('QA-15 survives the crossfader: kill one stem (piano, index 5) and passthrough ducks to zero, at any fader position',
        g.stems[S_IDX.piano] === 0 && g.pass === 0);
    }
    {
      const so = flat(); so[S_IDX.bass].soloed = true;           // bass solo
      const g = resolveDeckGains('B', so, XF6, 1, 'dip');        // deck B fully in
      ok('solo resolves BEFORE the crossfader: soloed bass at full, the other five exactly 0',
        g.stems[S_IDX.bass] === 1 && STEMS.every((s, i) => i === S_IDX.bass || g.stems[i] === 0),
        `[${g.stems.join(' ')}]`);
    }
    {
      // A hard-assigned stem is immune to the fader but NOT to its own mute.
      // Those are different controls and the DJ expects both to work. The row is
      // built per stem: a four-entry row here leaves guitar and piano on 'XF' and
      // the "unmuted stays at full level" line below would then be testing the
      // fader, not the assignment.
      const HARD = STEMS.map((s) => (s === 'vocals' ? 'A' : 'XF'));
      const m = flat(); m[S_IDX.vocals].muted = true;
      const g = resolveDeckGains('A', m, HARD, 1, 'dip');
      ok('a hard-assigned stem still obeys its own mute — "ignores the crossfader" does not mean "ignores you"',
        g.stems[S_IDX.vocals] === 0);
      const u = resolveDeckGains('A', flat(), HARD, 1, 'dip');
      ok('...and unmuted it stays at full level while the other five are faded away',
        u.stems[S_IDX.vocals] === 1 && STEMS.every((s, i) => i === S_IDX.vocals || u.stems[i] === 0),
        `[${u.stems.join(' ')}]`);
    }
    {
      // Nothing above may change Mode 1. A single deck at the default position
      // must produce the byte-identical vector resolveGains() produced before
      // the crossfader existed... which it cannot, at the DEFAULT centre detent.
      // Say so out loud rather than let someone discover it as a 3 dB drop.
      const base = resolveGains(flat());
      const centre = resolveDeckGains('A', flat(), XF6, XF_POSITION_DEFAULT, XF_CURVE_DEFAULT).stems;
      const hardA = resolveDeckGains('A', flat(), XF6, 0, XF_CURVE_DEFAULT).stems;
      ok('at the CENTRE detent a deck is at −3.01 dB, not unity — Mode 1 must not boot with the fader centred',
        Math.abs(centre[0] - Math.SQRT1_2) < 1e-12 && Math.abs(base[0] - 1) < 1e-12);
      ok('with the fader hard against its own end a deck is byte-identical to the Mode 1 vector',
        hardA.every((v, i) => v === base[i]), `[${hardA.join(' ')}] vs [${base.join(' ')}]`);
    }
  }
}

// ===========================================================================
if (group('sched')) {
  head('sched — the shared GPU token: one GPU, two decks, one queue');
  // Drives the real GpuScheduler with an injectable clock and fake inferences.
  // Reachability: dual-live-probe.mjs reports granted/demoted/maxWait off the
  // running engine, and run-ext.mjs asserts the two-deck ordering gate.
  {
    const defer = () => { let r; const p = new Promise((res) => { r = res; }); return { p, r }; };

    {
      // The whole reason the token exists: two decks must never be inside
      // session.run() at the same time.
      const s = new GpuScheduler();
      let concurrent = 0, maxConcurrent = 0;
      const job = () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); return new Promise((r) => setTimeout(() => { concurrent--; r('ok'); }, 5)); };
      await Promise.all([s.run('A', 1e9, job), s.run('B', 1e9, job), s.run('A', 1e9, job), s.run('B', 1e9, job)]);
      ok('four overlapping requests across two decks never overlap on the GPU', maxConcurrent === 1, `peak ${maxConcurrent}`);
      ok('...and all four were granted', s.stats.granted.A === 2 && s.stats.granted.B === 2);
    }

    {
      // Priority ordering. B is queued first, then A; A must jump it.
      const s = new GpuScheduler({ priority: 'A' });
      const order = [];
      const hold = defer();
      const first = s.run('B', 1e9, () => hold.p);        // takes the token
      await null;
      const b2 = s.run('B', 1e9, async () => { order.push('B'); });
      const a1 = s.run('A', 1e9, async () => { order.push('A'); });
      await new Promise((r) => setTimeout(r, 0));
      hold.r();
      await Promise.all([first, b2, a1]);
      ok('the priority deck jumps the queue: B queued first, A ran first', order.join('') === 'AB', order.join(''));
    }

    {
      // ...but not forever. Two same-priority waiters must come out FIFO, or a
      // busy deck can starve the other indefinitely.
      const s = new GpuScheduler({ priority: 'A' });
      const order = [];
      const hold = defer();
      const first = s.run('A', 1e9, () => hold.p);
      await null;
      const w1 = s.run('B', 1e9, async () => { order.push('B1'); });
      const w2 = s.run('B', 1e9, async () => { order.push('B2'); });
      await new Promise((r) => setTimeout(r, 0));
      hold.r();
      await Promise.all([first, w1, w2]);
      ok('same-priority waiters are FIFO — no starvation', order.join(',') === 'B1,B2', order.join(','));
    }

    {
      // A throwing inference must still release the token, or both decks wedge
      // permanently. This is the exact failure mode the try/finally exists for.
      const s = new GpuScheduler();
      await s.run('A', 1e9, async () => { throw new Error('boom'); }).catch(() => {});
      ok('an inference that throws still releases the token', s.busy === null);
      const r = await s.run('B', 1e9, async () => 'after');
      ok('...and the next deck runs normally', r.demoted === false && r.result === 'after');
    }

    {
      const s = new GpuScheduler();
      await s.run('A', 1e9, async () => 'x');
      s.release('B');                    // a stale release from the wrong deck
      ok('releasing a token you do not hold is a no-op, not a double-release', s.busy === null);
    }
  }

  head('sched — L3 demotion: only ONE deck falls behind, and it is never deck A');
  {
    // The pure decision, first. `estMs` is the machine's p95 inference; the
    // budget is the audio still in the deck's playback ring.
    const D = (o) => demotionDecision({ priority: 'A', estMs: 900, armed: true, waitMs: 0, ...o });
    ok('deck B is demoted when the GPU cannot finish inside what is left of its buffer',
      D({ deck: 'B', budgetMs: 500 }).demote === true, D({ deck: 'B', budgetMs: 500 }).why);
    ok('deck B is NOT demoted when it still fits', D({ deck: 'B', budgetMs: 1500 }).demote === false);
    ok('deck A is NEVER demoted by the scheduler, however far behind it is — its own L2 ladder owns that call',
      D({ deck: 'A', budgetMs: 0 }).demote === false && D({ deck: 'A', budgetMs: -5000 }).demote === false);
    ok('queue wait counts against the budget: 800 ms already spent waiting turns a fitting chunk into a doomed one',
      D({ deck: 'B', budgetMs: 1500, waitMs: 0 }).demote === false &&
      D({ deck: 'B', budgetMs: 1500, waitMs: 800 }).demote === true);
    ok('switching priority switches who is protected — it is a policy, not a hardcoded deck',
      demotionDecision({ deck: 'A', priority: 'B', estMs: 900, budgetMs: 100, waitMs: 0 }).demote === true &&
      demotionDecision({ deck: 'B', priority: 'B', estMs: 900, budgetMs: 100, waitMs: 0 }).demote === false);
    ok('with L3 disarmed nobody is ever demoted (the probe runs both ways)',
      D({ deck: 'B', budgetMs: 0, armed: false }).demote === false);

    // THE ANTI-LOCKOUT INVARIANT. A demoted deck contributes no timing sample,
    // so an estimate it was never allowed to influence must not be grounds to
    // refuse it. Measured live: deck B demoted 15/15 hops with a 1.665 s buffer
    // trough, producing nothing for a whole run, because p95 over 17 samples is
    // the maximum of 17 and one slow post-create chunk on deck A set it.
    ok('a deck that has NEVER run is never demoted, however bad the estimate looks',
      D({ deck: 'B', budgetMs: 100, estMs: 99999, grantedToDeck: 0 }).demote === false,
      D({ deck: 'B', budgetMs: 100, estMs: 99999, grantedToDeck: 0 }).why);
    ok('...but once it has run, the estimate applies to it normally',
      D({ deck: 'B', budgetMs: 100, estMs: 9999, grantedToDeck: 3 }).demote === true);
    ok('a p95 over too few samples may not refuse work — it is just the maximum',
      D({ deck: 'B', budgetMs: 100, estMs: 9999, samples: 3 }).demote === false &&
      D({ deck: 'B', budgetMs: 100, estMs: 9999, samples: 64 }).demote === true);
    {
      // ...and through the real scheduler, end to end: a cold pair must not lock
      // the non-priority deck out on its own first slow chunk.
      const s2 = new GpuScheduler({ priority: 'A' });
      s2.observe(2400);                       // one slow post-create chunk on deck A
      let bRan = 0;
      for (let i = 0; i < 6; i++) {
        await s2.run('A', 1950, async () => 900);
        const r = await s2.run('B', 1950, async () => { bRan++; return 900; });
        if (r.demoted) break;
      }
      ok('a cold scheduler does not lock the non-priority deck out on one outlier',
        bRan === 6 && s2.stats.demoted.B === 0, `deck B ran ${bRan}/6, demoted ${s2.stats.demoted.B}`);
    }

    // And through the real scheduler: a demotion must be a RETURN VALUE, never a
    // throw. LivePipeline routes throws into the CHUNK_FAILED ladder, which
    // halts the deck after three — so a throw here would turn a designed
    // degradation into a dead deck.
    {
      const s = new GpuScheduler({ priority: 'A' });
      // Establish evidence first: the anti-lockout invariant means a deck that
      // has never run, or a population too small to have a real p95, is never
      // refused. Demotion is only reachable once both are satisfied.
      for (let i = 0; i < 12; i++) s.observe(900);
      await s.run('B', 1e9, async () => {});
      s.estMs = 900;
      let ran = false;
      const r = await s.run('B', 300, async () => { ran = true; });
      ok('a demotion resolves {demoted:true} and NEVER runs the inference — no wasted GPU, no throw',
        r.demoted === true && ran === false && typeof r.why === 'string', r.why);
      ok('...and the token was not taken, so deck A is not delayed by it', s.busy === null);
      ok('demotions are counted per deck', s.stats.demoted.B === 1 && s.stats.demoted.A === 0,
        `A ${s.stats.demoted.A}, B ${s.stats.demoted.B}`);
    }

    {
      // The headline scenario: deck B is starving, deck A is healthy. Deck A must
      // be completely unaffected.
      const s = new GpuScheduler({ priority: 'A' });
      for (let i = 0; i < 12; i++) s.observe(900);     // evidence, per the invariant
      await s.run('B', 1e9, async () => {});           // deck B has now run once
      const grantedBefore = s.stats.granted.B;
      s.estMs = 900;
      const results = [];
      for (let hop = 0; hop < 10; hop++) {
        results.push(await s.run('A', 1900, async () => 'A-separated'));
        results.push(await s.run('B', 200, async () => 'B-separated'));
      }
      const aOk = results.filter((_, i) => i % 2 === 0).every((r) => r.demoted === false);
      const bDemoted = results.filter((_, i) => i % 2 === 1).every((r) => r.demoted === true);
      ok('ten hops with deck B out of buffer: deck A separated every single chunk',
        aOk && s.stats.granted.A === 10, `granted A ${s.stats.granted.A}`);
      ok('...and deck B was demoted every time instead of stealing the GPU',
        bDemoted && s.stats.demoted.B === 10 && s.stats.granted.B === grantedBefore,
        `demoted ${s.stats.demoted.B}, granted ${s.stats.granted.B} (was ${grantedBefore})`);
    }

    {
      // estMs must track the machine, or the policy is tuned to a constant.
      const s = new GpuScheduler();
      for (let i = 0; i < 40; i++) s.observe(800);
      for (let i = 0; i < 3; i++) s.observe(1400);
      ok('estMs is the p95 of observed inference time, so one slow chunk does not panic the policy',
        s.estMs >= 800 && s.estMs <= 1400, `${s.estMs} ms`);
      ok('a nonsense observation is ignored rather than poisoning the estimate',
        (s.observe(NaN), s.observe(-5), Number.isFinite(s.estMs)));
    }
  }
}

// ===========================================================================
if (group('dual')) {
  head('dual — twenty-four stem planes, two decks, Δ = 0 (docs/AUDIO.md §8.1)');
  /**
   * AUDIO.md §8.1: "Every stem must be sample-aligned... Δ = 4 combs at 5.5 kHz,
   * Δ = 10 destroys the mid-range. Assert Δ === 0 in code, do not eyeball it."
   *
   * Within one deck, alignment is STRUCTURAL: fourteen planes share one ring and
   * one pair of indices, and `write()` refuses a non-contiguous `from`. That is
   * already asserted in the `live` group. What is new in Mode 3 is the pair of
   * decks, and the two things that can go wrong there are different:
   *
   *   1. the two decks' rings are advanced by DIFFERENT read pointers, so a
   *      frame index means a different instant on each deck;
   *   2. the two decks' pointers advance at different RATES, i.e. drift — which
   *      is what a second AudioContext would cause and is the whole reason
   *      there is only one.
   *
   * Both are checked here against the real StemRingWriter, by putting an impulse
   * at the same absolute frame on all TWENTY-FOUR stem planes of both decks
   * (12 per deck at six stems, was 8) and measuring where each one comes out.
   */
  {
    const plan = makeLivePlan(LIVE_HOP_DEFAULT);
    // 2^19 frames: three chunks at hop 1.95 publish 255 780 frames and the ring
    // must hold all of them un-lapped so the impulse can still be found.
    const mk = () => new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(1 << 19)), 1 << 19);
    const A = mk(), B = mk();
    const IMPULSE_AT = 5000;

    // Both decks publish through their own LiveEmitter, from their own model
    // output, exactly as runChunk does.
    const emit = (ring, seed) => {
      const em = new LiveEmitter(plan, SEAM_XFADE_LAW);
      const mixL = new Float32Array(plan.H), mixR = new Float32Array(plan.H);
      for (let k = 0; k < 3; k++) {
        const c = chunkPlan(k, plan);
        const src = Array.from({ length: STEM_PLANES }, () => new Float32Array(SEGMENT));
        // one impulse, same ABSOLUTE frame, on every plane of both decks
        const local = IMPULSE_AT - c.emitFrom + c.srcOffset;
        if (local >= 0 && local < SEGMENT) for (const p of src) p[local] = seed;
        const e = em.chunk(k, src, mixL, mixR);
        ring.write(e.from, e.planes, e.len);
      }
    };
    emit(A, 1);
    emit(B, 1);

    const findAll = (ring) => {
      const out = [];
      for (let q = 0; q < STEM_PLANES; q++) {
        const pl = ring.planes[q];
        let at = -1;
        for (let i = 0; i < ring.writeFrames(); i++) if (Math.abs(pl[i]) > 0.5) { at = i; break; }
        out.push(at);
      }
      return out;
    };
    const posA = findAll(A), posB = findAll(B);
    ok(`deck A: all ${STEM_PLANES} stem planes carry the impulse at the SAME frame, Δ = 0`,
      posA.length === STEM_PLANES && new Set(posA).size === 1 && posA[0] >= 0, `[${posA.join(' ')}]`);
    ok('deck B: same', posB.length === STEM_PLANES && new Set(posB).size === 1 && posB[0] >= 0, `[${posB.join(' ')}]`);
    ok(`ACROSS decks: all ${2 * STEM_PLANES} planes land on the same absolute frame, Δ = 0`,
      new Set([...posA, ...posB]).size === 1 && posA.length + posB.length === 2 * STEM_PLANES,
      `A ${posA[0]} vs B ${posB[0]} (Δ ${Math.abs(posA[0] - posB[0])})`);
    ok('...and that frame is where the schedule says it should be',
      posA[0] === IMPULSE_AT, `${posA[0]} vs ${IMPULSE_AT}`);
    ok('both decks published exactly the same number of frames — no per-deck length skew',
      A.writeFrames() === B.writeFrames(), `${A.writeFrames()} vs ${B.writeFrames()}`);
  }

  head('dual — one clock: two decks cannot drift (the reason there is one AudioContext)');
  {
    /**
     * The playback worklets advance their read pointers by exactly `n` frames
     * per process() call, and BOTH run in the same audio thread on the same
     * render quantum. So the invariant is not "the pointers are equal" — the
     * decks arm at different times and are deliberately allowed to be offset —
     * it is that the DIFFERENCE never changes.
     *
     * This mirrors playback-processor.js's `r += n; Atomics.store(...)`. It is a
     * RENDERING-ONLY test in the taxonomy at the top of this file: it cannot see
     * the worklet failing to run the loop. Reached by: dual-live-probe.mjs
     * reports both decks' playedFrames off the running engine over 340 s.
     */
    const cap = 1 << 16;
    const A = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(cap)), cap);
    const B = new StemRingWriter(new SharedArrayBuffer(stemRingByteLength(cap)), cap);
    const planes = Array.from({ length: RING_PLANES }, () => new Float32Array(4096));
    // deck A arms first; deck B arms 1500 frames later. That offset is expected.
    A.write(0, planes, 4096); A.play(true);
    B.write(0, planes, 4096); B.play(true);
    let rA = 0, rB = -1500;
    const skews = [];
    for (let quantum = 0; quantum < 200; quantum++) {
      // one shared render quantum advances BOTH decks by the same 128 frames
      const n = 128;
      if (A.writeFrames() - rA < n) A.write(A.writeFrames(), planes, 4096);
      if (B.writeFrames() - Math.max(0, rB) < n) B.write(B.writeFrames(), planes, 4096);
      rA += n; rB += n;
      skews.push(rA - rB);
    }
    ok('the A/B read-pointer skew is constant to the sample across 200 render quanta — one clock, zero drift',
      new Set(skews).size === 1 && skews[0] === 1500, `skew ${[...new Set(skews)].join(',')}`);
    ok('...which is what a second AudioContext would break, and why Mode 3 forbids one',
      DECKS.length === 2);
  }

  head('dual — backpressure when only ONE deck is late');
  {
    /**
     * RENDERING ONLY (taxonomy at the top): this drives the real `skipFrames`
     * decision against a simulated clock, exactly as the `live` group does, but
     * for two decks at once. Reached by: dual-live-probe.mjs reports per-deck
     * drops/demotions/underruns off the running engine.
     *
     * The property under test is ISOLATION. Deck B falling behind must produce
     * passthrough on deck B and change NOTHING about deck A — not its schedule,
     * not its drops, not its published frames.
     */
    const plan = makeLivePlan(LIVE_HOP_DEFAULT);
    const lowWater = Math.round(LIVE_LOW_WATER_SEC * SR);
    const step = (st, cap, cushion) => {
      let filled = 0;
      for (;;) {
        const n = skipFrames({ cap, commit: st.commit, plan, k: st.k, playing: true, cushion, lowWater });
        if (n === 0) break;
        st.commit += n; st.k++; st.drops++; filled += n;
      }
      // the on-time path
      const c = chunkPlan(st.k, plan);
      if (cap >= c.inputEnd && st.commit === c.emitFrom) { st.commit = c.emitTo; st.k++; st.done++; }
      return filled;
    };
    const A = { k: 0, commit: 0, drops: 0, done: 0 };
    const B = { k: 0, commit: 0, drops: 0, done: 0 };
    // 12 hops of capture. Deck A always has cushion; deck B is starved from hop 4.
    for (let hop = 1; hop <= 12; hop++) {
      const cap = hop * plan.H;
      step(A, cap, plan.H);                        // healthy
      step(B, cap, hop >= 4 ? 0 : plan.H);         // starving from hop 4
    }
    ok('deck B starving produces passthrough spans on deck B', B.drops > 0, `${B.drops} spans`);
    ok('deck A is untouched by deck B starving: zero drops', A.drops === 0);
    ok('both decks still published a contiguous, gapless stream — a drop fills the span, it never skips it',
      A.commit === B.commit && A.commit > 0, `A ${A.commit}, B ${B.commit}`);
    ok('and every published frame is accounted for as either separated or passthrough',
      A.done + A.drops === A.k && B.done + B.drops === B.k, `A ${A.done}+${A.drops}=${A.k}  B ${B.done}+${B.drops}=${B.k}`);
  }
}

// ===========================================================================
if (group('host')) {
  /**
   * THIS GROUP IS A CONFORMANCE REPORT, AND A REPORT THAT CRASHES IS NOT ONE (#30).
   *
   * `docs/VENDORING.md` sends a second Host here: swap the two holes for your
   * own files, run `node tools/verify.mjs --unit`, and read the reds. That only
   * works if the group can RUN to its end. A hole module that throws at MODULE
   * EVALUATION — the natural shape for a Host whose platform bridge lives on
   * `window` or in a preload — used to take the whole process out at the import
   * line: the first real second Host died here after 482 assertions and got a
   * stack trace where the report should have been. A crash is strictly worse
   * than a red. A red says "your `storageGet` is wrong"; a crash says nothing at
   * all and reads as a broken vendored copy.
   *
   * So the body below is wrapped, and it is wrapped in TWO places for two
   * different failures:
   *
   *   1. `importHole()` — an evaluation-time throw becomes ONE named red that
   *      names the hole's path and what it threw. That is the failure the rule
   *      "a hole must import inertly" exists to catch, and naming the file is
   *      the whole repair instruction.
   *   2. this `try` — a hole that imports fine and then throws on its FIRST DUTY
   *      CALL, or any other throw between here and the last assertion, becomes
   *      the named red at the foot of the group instead of ending the run. The
   *      three groups after this one, and the two checks at the foot of the
   *      file, still report.
   *
   * THIS IS A REPORTING IMPROVEMENT AND NOT A COMPLETENESS GUARANTEE. Anyone
   * adopting this shape elsewhere needs that distinction, because the failure it
   * invites is subtler than the one it fixes: the guard buys a named cause and a
   * summary, and it does NOT recover the assertions after the throw. Measured on
   * the mutation it was watched red against — a `ui/host.js` that reads its
   * preload bridge at module scope — `node test.js` goes from 622 passed to
   * 529 passed / 2 failed. NINETY-ONE ASSERTIONS DID NOT RUN. A guarded suite
   * that went red must not be read as fully covered.
   *
   * WHAT MAKES THAT TRUNCATION VISIBLE, rather than merely absent, is a gate
   * that already existed: `tools/verify.mjs`'s coverage diff prints
   * `no longer runs: <assertion name>` for every assertion that stopped
   * executing, under the warning "An ABSENT assertion reads as green. N/N is
   * only comparable between runs when N is." The guard's job is to make sure
   * there is a completed run for that diff to compare against at all — before
   * it, the process died and the runner reported `RED — 0 failing assertions`,
   * which names nothing and reads like a broken vendored copy. The count in this
   * group's own detail line is the other half: it says how much did not run.
   *
   * THE BODY IS DELIBERATELY NOT RE-INDENTED under this `try`. It is ~2800 lines
   * and 122 assertions; re-indenting them would bury a four-line change in a
   * whole-file diff and take the blame history with it.
   *
   * The two globals restored in the `finally` are the deck half's: `window` is
   * installed BEFORE `ui/host.js` is imported (that is the point of it) and
   * `chrome` is re-stubbed per block. The engine half restores its own three in
   * its own `finally`, further down, which a throw here cannot skip.
   */
  let hostGroupThrew = null;
  let realWindowDesc = null;
  let windowStubbed = false;
  const hostGroupAt = pass + fail;
  /**
   * Import one hole and ASSERT THAT IT IMPORTED, rather than letting the throw
   * out. Returns `null` on a throw, which every assertion downstream then reads
   * as a Host that owes nothing — a run of reds naming duties, which is the
   * report, instead of nothing at all.
   *
   * THE `import()` STAYS AT THE CALL SITE, as a literal, and is handed over as a
   * thunk rather than as a path this function imports. `tools/unit-check.mjs`
   * scans each suite for a seam path in READ POSITION — `import(`, `from`,
   * `new URL(`, `readFileSync(` next to a string literal — and holds the result
   * against the `reads` this suite declares in `extension/unit.json`, both ways.
   * A path passed in as a variable is invisible to that scan, and the first
   * symptom is `unit` losing its declared read of `offscreen/host.js` with
   * nothing saying why. Watched: it went red exactly that way, and the watch is
   * runnable rather than remembered --
   *
   *     node tools/mutations/u8-seam-fixes.mjs M20
   *
   * anchored on the `import()` literal below and reported by
   * `node tools/unit-check.mjs`, NOT by this file: "...and every one of them is
   * really read by the suite that declares it -- NOT IN A READ POSITION, the
   * declaration outlived the code: test.js -> offscreen/host.js", 90/1. The
   * control is the assertion beside it, "...and no suite reads across the seam
   * without declaring it", which stays green -- a needle that had simply
   * stopped matching would take BOTH red.
   *
   * @param {string} where  the hole's path, extension-relative. It is in the
   *   assertion name, because "something threw" is not a repair instruction and
   *   "extension/ui/host.js threw while being imported" is.
   * @param {() => Promise<object>} load  `() => import('./extension/…/host.js')`
   */
  const importHole = async (where, load) => {
    let mod = null, threw = null;
    try { mod = await load(); } catch (e) { threw = e; }
    ok(`THE HOLE AT ${where} IMPORTS INERTLY — it touches its platform on the first DUTY CALL, not at module scope  `
      + '[entry point: the import of this hole by the unit — offscreen/engine.js for the EngineHost, ui/embed.js for the DeckHost]',
      threw === null,
      threw === null
        ? 'imported without reaching for a platform that is not here'
        : `IT THREW WHILE BEING IMPORTED: ${String((threw && threw.message) || threw)} — nothing below this line could drive it, `
          + 'so the rest of this report is about a module that does not exist. Move the platform touch into the duties.');
    return mod;
  };
  try {
  head('host — the ENGINE half of the Host seam: a Host that cannot do the job is refused at boot');
  /**
   * WHAT THIS COVERS AND WHY IT IS WORTH A GATE.
   *
   * `extension/shared/host.js` declares what the unit asks of whatever is
   * hosting it, and `assertHost()` refuses a Host that is short a duty at MODULE
   * EVALUATION. The moment matters: without it, a Host missing `captureStream`
   * surfaces as `host.captureStream is not a function` thrown from inside
   * `captureStart`, which is precisely the halfway R5 is about — a capture that
   * fails after the track exists and leaves the user's tab silent.
   *
   * WHICH KIND OF TEST THIS IS — the RENDERING vs REACHABILITY rule at the head
   * of this file. NOT rendering-only, and in three separate ways, because
   * driving `assertHost()` with hand-built stubs and stopping there would be:
   *
   *   1. The shipping Host is DRIVEN, never imitated.
   *      `extension/offscreen/host.js` — the module `offscreen/engine.js`
   *      imports and the only EngineHost that ships — goes through the real
   *      `assertHost`, and further down every one of the duties it declares
   *      is CALLED with the platform stubbed underneath it. Deleting a duty
   *      from that file, or changing what one returns, turns this group red. It is also the CONTROL
   *      for the refusals below: without it, "a broken Host is refused" would be
   *      satisfied by a function that refuses everything.
   *   2. The CALL SITE is read out of `engine.js`. `assertHost` working proves
   *      nothing about the engine ever calling it — review proved exactly that,
   *      by deleting the module-scope call and watching the whole tree stay
   *      green while two assertion names went on claiming it as their entry
   *      point.
   *   3. The stubs exist only to break ONE declared duty at a time, which is the
   *      one thing a real Host cannot be asked to do on demand.
   *
   * ---- U4, HOST INTERFACE v1.1: EVERY ASSERTION ADDED HERE, WATCHED RED -----
   * AGENTS.md: "An assertion never observed failing is one whose ability to fail
   * is an assumption." Each row was applied, run, and reverted; the tree is
   * green with all of them undone. `file:line` is where the mutation was made,
   * NOT where the red appeared — for the first two rows those are different
   * files, which is the whole reason C3 is a trap.
   *
   *   mutation                                          | made at                  | gate         | red
   *   --------------------------------------------------+--------------------------+--------------+----
   *   delete the `sourceBytes` @property                 | shared/host.js:392       | unit-check   | "EngineHost is one interface, not two … CHECKED BUT UNDOCUMENTED: sourceBytes (in ENGINE_HOST_DUTIES, in no @property)"  90/1
   *   delete the `sourceBytes` key from the duty table   | shared/host.js:504       | unit-check   | "…DOCUMENTED BUT UNCHECKED: sourceBytes (in the typedef, in no duty table, and not a declared namespace)"  90/1
   *   `missing` filter skips `sourceBytes`               | shared/host.js:671       | test.js host | "A HOST THAT IS SHORT `sourceBytes` IS REFUSED… — a Host with no sourceBytes was ACCEPTED"  127/1
   *   `missing` filter skips `exportSink`                | shared/host.js:671       | test.js host | "A HOST THAT IS SHORT `exportSink` IS REFUSED… — a Host with no exportSink was ACCEPTED"  127/1
   *   the refusal drops each duty's SENTENCE             | shared/host.js:674       | test.js host | both new rows plus captureStream's and the transport's: "…missing 1 of its 11 duties: sourceBytes()"  123/5
   *   engine.js acquires a `host.sourceBytes(` caller    | offscreen/engine.js:96   | test.js host | "…no duty is exempted for longer than its reason lasts — sourceBytes HAS a caller now"  127/1
   *   the shipping `sourceBytes` resolves `ArrayBuffer(0)`| offscreen/host.js:147   | test.js host | "sourceBytes() REFUSES BY REJECTING… — RESOLVED with {}"  127/1
   *   the shipping `exportSink` resolves `{}`            | offscreen/host.js:160    | test.js host | "exportSink() REFUSES BY REJECTING… — RESOLVED with {}"  127/1
   *   the shipping `sourceBytes` loses its `async`       | offscreen/host.js:147    | test.js host | "sourceBytes() threw SYNCHRONOUSLY … a caller that attaches .catch() without awaiting first never sees it"  127/1
   *   the shipping Host loses `sourceBytes` entirely     | offscreen/host.js:147    | test.js host | "THE SHIPPING EngineHost SATISFIES EVERY DECLARED DUTY — missing 1 of its 11 duties: sourceBytes()"  126/2
   *   the exemption row for `sourceBytes` is deleted     | test.js:4884             | test.js host | "…every declared duty is actually reached for — declared but never called: sourceBytes"  127/1
   *
   * The last row is the one that says the exemption below is not a free pass: it
   * still reds for a duty that is unreached and unnamed, exactly as it did
   * before v1.1 added two duties one tag ahead of their callers.
   *
   * ------ U8, #30 AND #28: THE FOUR MUTATIONS THIS GROUP REPORTS, AND WHERE ---
   * THEY ARE RUN FROM. Unlike the table above, these are not a record of watches
   * made once at branch time — they are a RUNNABLE battery, because a watch made
   * at branch time expires the moment another slice edits the file it patched
   * and nothing announces that (`INTEGRATION.md` §18). Re-run them:
   *
   *     node tools/mutations/u8-seam-fixes.mjs M1 M2 M3 M4
   *
   * ANCHORS CUT AGAINST `5993d32`. That file reports two answers per case and
   * not one — whether the ANCHOR still matches, and whether the mutation still
   * REDS — because a battery that reports a single pass count is how ten dead
   * anchors once read as 44 of 51 rather than as ten instruments pointing at
   * nothing.
   *
   * THE `made at` COLUMN NAMES THE ANCHOR TEXT, NOT A LINE NUMBER, on purpose:
   * a line number is the first thing to decay and the battery patches text.
   *
   *   #    mutation                                          | made at                       | red here, and the control
   *   -----+----------------------------------------------------+-------------------------------+-------------------------
   *   M1   ui/host.js reads a bridge at module scope         | ui/host.js `const ME`         | "THE HOLE AT extension/ui/host.js IMPORTS INERTLY" + the foot. Control: the ENGINE hole's assertion still PASSES.   46/2, 84 did not run
   *   M2   offscreen/host.js reads a bridge at module scope  | offscreen/host.js `const ME`  | "THE HOLE AT extension/offscreen/host.js IMPORTS INERTLY" + "THE SHIPPING EngineHost…" + the foot. Control: the capture refusal still PASSES — the report survived.   17/3, 112 did not run
   *   M3   ui/host.js imports fine, send() throws on duty 1  | ui/host.js `send(msg) {`      | the foot ONLY. Controls: BOTH hole assertions still PASS. The case only the group guard can catch.   53/1, 78 did not run
   *   M4   engine.js words the line off `fromCache` again    | engine.js `log(\`weights `      | "THE `weights …` LOG LINE IS WORDED FROM THE ANNOUNCED SOURCE". Control: the foot still PASSES.   131/1
   *
   * THE `did not run` COLUMN IS THE POINT OF THE GUARD AND ITS BOUND IN ONE
   * NUMBER. M2 costs 112 of this group's 132 assertions: the report survives and
   * names its cause, and it is NOT a covered run. An assertion that did not run
   * reads exactly like one that passed if you only look at the red lines, which
   * is why the battery checks every control as a PASS rather than as "absent
   * from the reds", and why `tools/verify.mjs`'s coverage diff prints
   * `no longer runs:` for each one.
   */
  const {
    assertHost, assertHostOption,
    ENGINE_HOST_DUTIES, BACKEND_DUTIES, DECK_HOST_DUTIES, DECK_PAGE_DUTIES, DECK_TRANSPORT_DUTIES,
  } = await import('./extension/shared/host.js');
  const engineHost = await importHole('extension/offscreen/host.js',
    () => import('./extension/offscreen/host.js'));
  const duties = Object.keys(ENGINE_HOST_DUTIES);
  const threw = (fn) => { try { fn(); return null; } catch (e) { return String((e && e.message) || e); } };
  /** A Host that owes exactly what is declared, so each case below breaks ONE thing. */
  const stub = () => Object.fromEntries(duties.map((k) => [k, () => {}]));

  const shipping = threw(() => assertHost(engineHost, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('THE SHIPPING EngineHost SATISFIES EVERY DECLARED DUTY  '
    + '[entry point: extension/offscreen/host.js, the module extension/offscreen/engine.js imports]',
    duties.length > 0 && shipping === null,
    duties.length === 0
      ? 'ENGINE_HOST_DUTIES is empty — this assertion has no coverage at all'
      : shipping || `${duties.length} duties: ${duties.join(', ')}`);

  const noCapture = stub();
  delete noCapture.captureStream;
  const why = threw(() => assertHost(noCapture, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('A HOST THAT CANNOT OPEN A CAPTURE IS REFUSED, AND THE ERROR NAMES THE DUTY  '
    + '[entry point: assertHost(), called at extension/offscreen/engine.js module scope]',
    why != null && why.includes('captureStream') && why.includes(ENGINE_HOST_DUTIES.captureStream),
    why == null
      ? 'a Host with no captureStream was ACCEPTED — the engine would boot and fail at the first arm instead'
      : why);

  /**
   * Matched as `name() — `, the exact form `assertHost` lists a MISSING duty in,
   * rather than as a bare identifier anywhere in the sentence. The bare form
   * passes today only because no duty's help text happens to contain another
   * duty's name; a duty added by S2 or S7 whose sentence mentions one, or a
   * rewording of `captureStream`'s, would turn this red for a reason that has
   * nothing to do with the claim, and a red that is about wording costs an
   * investigation to discover that it is.
   */
  const listed = (k) => why != null && why.includes(`${k}() — `);
  ok('...and it names ONLY the duty that is missing, so the message is a repair instruction',
    listed('captureStream') && duties.filter((k) => k !== 'captureStream').every((k) => !listed(k)),
    why == null ? 'nothing was thrown' : why);

  /**
   * HOST INTERFACE v1.1 — A HOST SHORT ONE OF THE TWO NEW DUTIES IS REFUSED BY
   * NAME, which is the whole mechanism by which ADDING a duty is a MINOR change
   * rather than a silent one.
   *
   * `shared/host.js`'s freeze block: "Adding a duty is a MINOR change that every
   * existing Host fails at boot, loudly, by `assertHost`." That sentence is only
   * true if the failure NAMES the duty and says what it is for — otherwise the
   * author of a Host vendored against the previous tag is handed a count and
   * left to diff two interfaces. `captureStream`'s refusal above proves the
   * mechanism for a v1 duty; these prove it for the two duties v1.1 adds, which
   * are the ones an existing Host is actually short.
   *
   * Matched as `name() — `, the exact form `assertHost` lists a MISSING duty in,
   * for the reason the block above records: a bare identifier match goes red on
   * a rewording that has nothing to do with the claim.
   *
   * FAILS WHEN IT CANNOT LOOK: a duty that is not in `ENGINE_HOST_DUTIES` at all
   * cannot be deleted from a stub built out of it, and a green here would then
   * mean only that nothing was checked.
   */
  for (const k of ['sourceBytes', 'exportSink']) {
    const short = stub();
    delete short[k];
    const msg = threw(() => assertHost(short, ENGINE_HOST_DUTIES, 'EngineHost'));
    ok(`A HOST THAT IS SHORT \`${k}\` IS REFUSED, AND THE ERROR NAMES THAT DUTY AND WHAT IT IS FOR  `
      + '[entry point: assertHost(), called at extension/offscreen/engine.js module scope]',
      duties.includes(k) && msg != null && msg.includes(`${k}() — `)
      && msg.includes(ENGINE_HOST_DUTIES[k])
      && duties.filter((d) => d !== k).every((d) => !msg.includes(`${d}() — `)),
      !duties.includes(k)
        ? `${k} is in no duty table, so this assertion deleted nothing and checked nothing`
        : msg == null
          ? `a Host with no ${k} was ACCEPTED — the duty would be added and no existing Host ever told, `
            + 'which is the silent break the freeze exists to make loud'
          : msg);
  }

  const absent = threw(() => assertHost(undefined, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('AN ABSENT HOST IS THE LOUDEST FAILURE HERE, NOT THE QUIETEST  '
    + '[entry point: assertHost(), the `!host || ...` shape AGENTS.md bans]',
    absent != null && absent.includes('no host module was supplied'),
    absent == null
      ? 'assertHost(undefined) returned without throwing — a seam check that reports coverage exactly when it has none'
      : absent);

  const notCallable = stub();
  notCallable.assetUrl = 'vendor/ort/';
  const nc = threw(() => assertHost(notCallable, ENGINE_HOST_DUTIES, 'EngineHost'));
  ok('A DUTY THAT IS PRESENT BUT NOT CALLABLE COUNTS AS MISSING',
    nc != null && nc.includes('assetUrl'),
    nc == null ? 'a Host whose assetUrl is a string was ACCEPTED' : nc);

  const empty = threw(() => assertHost(stub(), {}, 'EngineHost'));
  ok('AN EMPTY DUTY LIST IS REFUSED — nothing can be asserted about a Host nothing was asked of',
    empty != null && empty.includes('no duties were declared'),
    empty == null ? 'assertHost(host, {}) accepted a Host it checked nothing about' : empty);

  /**
   * FROM HERE DOWN, THE ENGINE IS READ AS TEXT rather than imported.
   * `extension/offscreen/engine.js` builds an AudioContext, a Worker and a
   * MasterBus at module scope, so it cannot be evaluated from Node at all —
   * every claim below about what the engine DOES is therefore made against its
   * source, the same shape `qa/speed-pitch.mjs` uses to read the key-lock policy
   * out of `content.js`. Comments are stripped first: these are claims about
   * code, and a claim a doc comment can satisfy is not a claim.
   */
  const { readFileSync, readdirSync } = await import('node:fs');
  const engineRaw = readFileSync(new URL('./extension/offscreen/engine.js', import.meta.url), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const engineSrc = strip(engineRaw);
  /**
   * THE ENGINE'S UNIT, DERIVED RATHER THAN LISTED — every `.js` under
   * `offscreen/` and `shared/` except the Host modules themselves.
   *
   * It used to be `engine.js` alone. S7 made `modelcache.js` the second file to
   * take the Host as a PARAMETER — `loadModel(host, …)` calls `modelBytes` and
   * `clearModel` on it — and the scan below had to be widened by hand to see
   * it, having first gone red for a reason that was not true ("declared but
   * never used"). Widening by hand defers the same edit to the next slice that
   * does the same thing, and S2 is already the next one. A list that is
   * COMPUTED cannot be forgotten.
   *
   * `ui/` is deliberately outside it: that is the deck's Host, with its own
   * duty list (`DECK_HOST_DUTIES`), and folding it in here would report S4's
   * deck-side duties as undeclared engine ones.
   */
  const HOST_MODULES = new Set([
    'extension/offscreen/host.js', 'extension/offscreen/host-pin.js', 'extension/shared/host.js',
  ]);
  const unitWalk = (dir, out = []) => {
    for (const e of readdirSync(new URL(`./${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (e.name === 'vendor' || e.name === 'node_modules') continue;
      if (e.isDirectory()) unitWalk(`${dir}/${e.name}`, out);
      else if (e.name.endsWith('.js') && !HOST_MODULES.has(`${dir}/${e.name}`)) out.push(`${dir}/${e.name}`);
    }
    return out;
  };
  const unitFiles = [...unitWalk('extension/offscreen'), ...unitWalk('extension/shared')];
  const unitSrcs = unitFiles.map((f) => strip(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')));

  /**
   * THE CHECK IS ONLY WORTH ITS NAME IF THE ENGINE ACTUALLY RUNS IT — AND RUNS
   * IT FIRST.
   *
   * Every refusal above drives `assertHost` directly, which proves the function
   * works and proves nothing at all about `offscreen/engine.js` ever calling it.
   * Review proved the gap by deleting the module-scope call together with its
   * import: `node test.js host` stayed 11 passed 0 failed and the whole `--quick`
   * stayed GREEN, while two assertions above went on naming that call site as
   * their entry point. The interface-drift pair below cannot see it either — it
   * matches `host.x(`, and `assertHost` is not `host.`-prefixed.
   *
   * THE MOMENT IS THE POINT (`shared/host.js`): before `MasterBus`, before
   * `Deck`, and before the boot `HELLO` that is the first thing to reach
   * `host.send`. After any of those, a Host short a duty is a TypeError one
   * layer down — for `captureStream`, thrown from inside `captureStart` with a
   * track already taken off the user's tab, which is the halfway R5 exists to
   * prevent.
   *
   * FAILS IF IT CANNOT LOOK: a call that is gone, commented out or no longer
   * first is a red, and so is a build in which the three constructions it is
   * ordered against cannot be found.
   */
  const bootAt = engineSrc.indexOf('assertHost(host, ENGINE_HOST_DUTIES');
  ok('THE ENGINE ITSELF RUNS THE CHECK — assertHost() is called at engine.js module scope, not only from this file  '
    + '[entry point: extension/offscreen/engine.js module scope, comments stripped]',
    bootAt >= 0,
    bootAt >= 0
      ? 'engine.js refuses to boot on a Host that is short a duty'
      : 'no `assertHost(host, ENGINE_HOST_DUTIES` call in extension/offscreen/engine.js — every refusal above still '
        + 'passes, and a Host missing captureStream now fails inside captureStart with a track already off the tab (R5)');

  const BUILDS = ['new MasterBus(', 'new Deck(', "send({ type: 'HELLO' })"];
  const builtAt = BUILDS.map((b) => ({ b, i: engineSrc.indexOf(b) }));
  const unfound = builtAt.filter((x) => x.i < 0).map((x) => x.b);
  const firstBuild = builtAt.reduce((a, x) => (x.i >= 0 && (a.i < 0 || x.i < a.i) ? x : a));
  ok('...and it runs BEFORE the first construction that would otherwise fail one layer down',
    bootAt >= 0 && unfound.length === 0 && bootAt < firstBuild.i,
    unfound.length
      ? `cannot look: ${unfound.join(', ')} not found in engine.js, so this ordering claim has no anchor`
      : bootAt < 0
        ? 'there is no assertHost call to order'
        : bootAt < firstBuild.i
          ? `assertHost at ${bootAt} chars precedes \`${firstBuild.b}\` at ${firstBuild.i}`
          : `assertHost at ${bootAt} chars runs AFTER \`${firstBuild.b}\` at ${firstBuild.i} — `
            + 'the Host is already in use by the time it is checked');

  /**
   * THE INTERFACE AND ITS ONE CONSUMER MUST NOT DRIFT APART, in either
   * direction. S2 and S7 both add duties to this seam; a duty used but not
   * declared is a Host that passes `assertHost` and then throws, and a duty
   * declared but never used is one more thing a second Host must implement for
   * nothing.
   *
   * TWO SHAPES, because a duty can be reached for in two ways and S6 added the
   * second. A CALL is `host.x(`. A HAND-OFF is `host.x` passed by reference —
   * `assetUrl: host.assetUrl` and `createBackend: host.createBackend` on the
   * `shared` bundle, `new MasterBus(null, host.assetUrl)`.
   *
   * WHAT THE SECOND SHAPE ACTUALLY ADDED, measured rather than described:
   * exactly one name, `createBackend`. `assetUrl` was already in the calls-only
   * set — `engine.js` both hands it off AND calls it, at
   * `host.assetUrl('offscreen/capture-processor.js')` — so it is `createBackend`
   * alone that the engine never calls through the namespace, and a calls-only
   * scan reports it, and only it, as dead code.
   *
   * The hand-off pattern requires a `,`/`)`/`]`/`}` after the identifier rather
   * than matching any `host.x`, because `import * as host from './host.js'`
   * would otherwise contribute a duty named `js`.
   */
  const dutyCalls = (src) => [...src.matchAll(/\bhost\.(\w+)\s*\(/g)].map((m) => m[1]);
  const dutyRefs = (src) => [...src.matchAll(/\bhost\.(\w+)(?=\s*[,)\]}])/g)].map((m) => m[1]);
  const reached = [...new Set(unitSrcs.flatMap((src) => [...dutyCalls(src), ...dutyRefs(src)]))].sort();
  const undeclared = reached.filter((k) => !duties.includes(k));
  // FAILS IF IT CANNOT LOOK: a walk that returned nothing, or one that lost the
  // two files known to reach for a duty, would otherwise report a clean seam
  // most confidently at the moment it stopped reading the unit.
  const sawUnit = unitFiles.includes('extension/offscreen/engine.js')
    && unitFiles.includes('extension/shared/modelcache.js') && unitFiles.length > 5;
  ok('EVERY HOST DUTY THE UNIT REACHES FOR IS DECLARED  '
    + '[entry point: every .js under extension/offscreen and extension/shared except the Host modules, comments stripped]',
    sawUnit && reached.length > 0 && undeclared.length === 0,
    !sawUnit
      ? `this scan is not seeing the unit: ${unitFiles.length} file(s) walked, ${unitFiles.join(', ') || 'none'}`
      : reached.length === 0
        ? 'the unit calls no host duty at all — either the seam is gone or this scan cannot see it'
        : undeclared.length
          ? `undeclared: ${undeclared.map((k) => `host.${k}()`).join(', ')} — declare it in ENGINE_HOST_DUTIES or a Host will pass assertHost and still throw`
          : `${reached.length} reached across ${unitFiles.length} unit files: ${reached.join(', ')}`);

  /**
   * THE ONE LEGITIMATE REASON A DECLARED DUTY IS NOT REACHED FOR YET — and it is
   * a WINDOW, not a carve-out.
   *
   * `shared/host.js`'s freeze block makes adding a duty a MINOR change that every
   * existing Host fails at boot. That is precisely what lets a duty be DECLARED
   * in one tag and CONSUMED in the next: a second product implements it against
   * a tag it can already vendor, instead of against one that does not exist yet.
   * Host interface v1.1 does exactly that — `sourceBytes` and `exportSink` are
   * declared here for the ahead-of-time separation runner and the export path,
   * neither of which is in this tree. Without this window the seam could only
   * ever grow in the same tag as its caller, which is the serialisation the
   * split into two tags exists to avoid.
   *
   * SO THE EXEMPTION IS EXACT IN BOTH DIRECTIONS, and that is what keeps it from
   * becoming the "expected red" list AGENTS.md forbids:
   *   - a duty that is unreached and NOT named below is a red, unchanged;
   *   - a duty named below that IS reached is ALSO a red, so the slice that
   *     writes the caller has to delete its line in the same commit. An
   *     exemption that outlives its reason is the thing that rots;
   *   - a name below that is in no duty table is a red too, so a duty that gets
   *     renamed or removed cannot leave a permanent hole behind it.
   */
  const DECLARED_AHEAD_OF_ITS_CONSUMER = Object.freeze({
    sourceBytes: 'the ahead-of-time separation runner, which reads a Source that is a file',
    // `exportSink` WAS HERE, and U11 (#42) deleted it in the same commit as its
    // caller, which is the discipline the assertion below exists to enforce:
    // `offscreen/engine.js`'s EXPORT_START case now calls `host.exportSink(plan)`,
    // so leaving the line would have gone on exempting a duty from the check
    // that says every declared duty is reached for. The red that named it —
    // "exportSink HAS a caller now" — was watched before the line came out.
  });
  const ahead = Object.keys(DECLARED_AHEAD_OF_ITS_CONSUMER);
  const unreached = duties.filter((k) => !reached.includes(k) && !ahead.includes(k));
  ok('...and every declared duty is actually reached for, so a second Host implements nothing dead  '
    + `[less ${ahead.length} declared ahead of its consumer: ${ahead.join(', ')}]`,
    reached.length > 0 && unreached.length === 0,
    unreached.length ? `declared but never called: ${unreached.join(', ')}` : `all ${duties.length}`);

  const consumed = ahead.filter((k) => reached.includes(k));
  const phantom = ahead.filter((k) => !duties.includes(k));
  ok('...and no duty is exempted for longer than its reason lasts: each one named above is still declared, and still has no caller  '
    + '[entry point: the same scan, read against DECLARED_AHEAD_OF_ITS_CONSUMER]',
    consumed.length === 0 && phantom.length === 0,
    consumed.length
      ? `${consumed.join(', ')} HAS a caller now — delete its line from DECLARED_AHEAD_OF_ITS_CONSUMER in the `
        + 'same commit as the caller, or the exemption goes on covering a duty nothing is checking'
      : phantom.length
        ? `${phantom.join(', ')} is exempted from a check it is not subject to — it is in no duty table at all`
        : `${ahead.length} exempted, ${ahead.map((k) => `${k} (${DECLARED_AHEAD_OF_ITS_CONSUMER[k]})`).join('; ')}`);

  /**
   * R5 — TRACK-STOP DISCIPLINE, ASSERTED FOR THE FIRST TIME.
   *
   * `docs/ARCHITECTURE.md` R5: holding the MediaStream track IS the tab mute.
   * Chrome mutes a tab the moment it is captured and releasing the track
   * unmutes it, so a capture that fails after the stream exists — and does not
   * stop it — leaves the user's tab permanently silent with no affordance to
   * fix it. `SECURITY.md` puts that in scope as a vulnerability.
   *
   * It had no assertion anywhere before this slice, and the slice is exactly
   * the edit most likely to break it: the token now crosses a Host boundary
   * (`host.captureStream`), so the tempting mistake is a null check, a log line
   * or an early return between the stream arriving and the guard that stops it.
   *
   * READ OUT OF THE BUILD rather than reimplemented, the same shape
   * `qa/speed-pitch.mjs` uses to read the key-lock policy out of `content.js`
   * and `qa/passthrough-gain.mjs` uses to read `pushGains` out of `live.js`.
   * `captureStart` cannot be driven from Node — `offscreen/engine.js` builds an
   * AudioContext, a Worker and a MasterBus at module scope — so the claim is
   * made where it is checkable. FAILS IF IT CANNOT LOOK: a `captureStart` this
   * cannot locate, or a second `host.captureStream` call it did not expect, is
   * a red rather than a silent pass.
   */
  const capAt = engineRaw.indexOf('\nasync function captureStart(');
  const capBody = capAt < 0 ? null : engineRaw.slice(capAt + 1).split(/\n\}\n/)[0];
  /**
   * The WHOLE call statement is matched, up to its own `);`, and the stream's
   * name is read out of it rather than assumed. Splitting on the literal
   * `const s = await host.captureStream(` and then skipping to the next LINE was
   * blind to `const s = await host.captureStream(t); if (!s) return;` — the
   * third spelling of the very mistake the block above names, and the one the
   * typedef's "MUST REJECT rather than resolve null" exists because someone will
   * reach for. There is no linter in this repo to forbid the one-line form.
   * Matching the statement also means a reformat of the call, or a rename of
   * `s`, no longer reports a false R5 red.
   */
  const opens = capBody ? [...capBody.matchAll(/const (\w+) = await host\.captureStream\([\s\S]*?\);/g)] : [];
  const sVar = opens.length === 1 ? opens[0][1] : null;
  const afterOpen = opens.length === 1 ? strip(capBody.slice(opens[0].index + opens[0][0].length)) : null;
  ok('R5 — THE CAPTURE TOKEN IS SPENT INSIDE THE GUARD: nothing at all runs between the stream arriving and the try that stops it  '
    + '[entry point: extension/offscreen/engine.js captureStart(), reached from the CAPTURE_START case]',
    afterOpen != null && /^\s*try\s*\{/.test(afterOpen),
    capBody == null
      ? 'could not locate `async function captureStart(` in extension/offscreen/engine.js. The gate cannot look, so it fails.'
      : opens.length !== 1
        ? `expected exactly one \`const <name> = await host.captureStream(…);\`, found ${opens.length} — `
          + 'a second way to open a capture is a second way to leak one'
        : /^\s*try\s*\{/.test(afterOpen)
          ? 'the statement after the stream exists is `try {`'
          : `the statement after the stream exists is ${JSON.stringify(afterOpen.trim().slice(0, 90))}, not a try. `
            + 'Chrome mutes the tab the moment it is captured: anything that can return or throw here leaves it silent for good.');

  const guard = capBody ? capBody.match(/catch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\n {2}\}/) : null;
  /**
   * BOUND TO THE STREAM THIS FUNCTION JUST OPENED, and to every track on it.
   * An unbound `.getTracks() … .stop()` cannot tell `s` from `d.stream`, and on
   * the path this guard exists for they are not synonyms: `deck.js` throws
   * `deck <id> is already capturing` BEFORE it assigns `this.stream`, so on a
   * re-entrant start — the first case the comment above the try names —
   * `d.stream` is either null, and `null.getTracks()` throws inside the catch
   * and REPLACES the rethrow the sibling assertion checks for, or it is the
   * PREVIOUS stream, and the one just opened leaks with the tab muted for good.
   * Anchoring on `.forEach(` immediately after `.getTracks()` is what carries
   * the word EVERY: a `.filter((t) => t.kind === 'video')` in between stops no
   * audio track at all, and an unanchored match cannot see the difference.
   *
   * The exception this encodes, so the red is self-explaining: the guard must
   * stop the stream by the NAME the open bound it to, in one `.forEach((t) =>
   * t.stop())`. A `for (const t of …)` rewrite is a red — deliberately, because
   * the assertion cannot bind a receiver it cannot parse.
   */
  const stops = guard && sVar
    ? new RegExp(`\\b${sVar}\\.getTracks\\(\\)\\.forEach\\(\\((\\w+)\\) => \\1\\.stop\\(\\)\\)`).test(guard[2])
    : false;
  const rethrows = guard ? new RegExp(`throw\\s+${guard[1]}\\b`).test(guard[2]) : false;
  ok('...and that guard STOPS EVERY TRACK OF THE STREAM IT JUST OPENED, AND RETHROWS — a swallowed failure is a muted tab under a deck that reports idle',
    stops && rethrows,
    guard == null ? 'no catch block found in captureStart at all'
      : sVar == null ? 'the stream the guard must stop could not be named, so what it stops cannot be checked'
        : !stops ? `the catch does not stop every track of \`${sVar}\`: ${JSON.stringify(guard[2].trim())}`
          : !rethrows ? `the catch stops the tracks but does not rethrow ${guard[1]}, so the CAPTURE_START case would report success`
            : `catch (${guard[1]}) stops every track of \`${sVar}\` and rethrows`);

  /**
   * The other end of the same rule: R5's third track-stop site. `pagehide` used
   * to be written here; it is now `host.onTeardown`, because the moment a
   * context goes away is the Host's fact and not the engine's — but WHAT must
   * not be left behind is still the engine's.
   */
  const tdAt = engineRaw.indexOf('host.onTeardown(');
  const tdBody = tdAt < 0 ? null : engineRaw.slice(tdAt).split(/\n\}\);/)[0];
  ok('R5 — TEARDOWN STOPS THE TRACKS TOO, so a context going away unmutes the tab  '
    + '[entry point: extension/offscreen/engine.js, the host.onTeardown callback]',
    tdBody != null && /\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(tdBody),
    tdAt < 0
      ? 'no host.onTeardown( call in extension/offscreen/engine.js — R5s last-gasp stop is gone entirely'
      : /\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/.test(tdBody)
        ? 'the teardown callback stops every track on every live deck'
        : `the teardown callback does not stop the tracks: ${JSON.stringify(tdBody.trim().slice(0, 90))}`);

  /**
   * #28 — THE PROVENANCE REACHES THE ONE LINE A USER WOULD CHECK, AND IT IS NOT
   * A BOOLEAN.
   *
   * `engine.js` used to word this line `fromCache ? 'from cache' : 'downloaded'`.
   * That is a two-valued answer to a three-valued question: a Host that ships
   * the weights in its installer honestly reports `fromCache: false`, and the
   * engine then told the user 109 MB had been downloaded about a file no request
   * ever touched — contradicting P1 in the one place someone would go to check
   * it. READ AS TEXT for the reason everything in this block is: `engine.js`
   * builds an AudioContext at module scope and cannot be evaluated from Node.
   *
   * BOTH DIRECTIONS ARE ASSERTED. That the line quotes `modelSourceWord` is what
   * makes the three values reach it; that it no longer mentions `fromCache` is
   * what stops the old inference being restored beside the new one, where it
   * would go on being wrong for the third case only — the case with no test
   * before this one.
   */
  const weightsLog = (engineSrc.match(/log\(`weights[^`]*`\)/) || [null])[0];
  ok('THE `weights …` LOG LINE IS WORDED FROM THE ANNOUNCED SOURCE AND NOT FROM THE RETRY BOOLEAN — a Host that SHIPS the weights must not be told it downloaded them  '
    + '[entry point: extension/offscreen/engine.js loadOnce(), the line P1 is checked against]',
    weightsLog != null && weightsLog.includes('modelSourceWord(source)') && !/fromCache/.test(weightsLog),
    weightsLog == null
      ? 'there is no log(`weights …`) call in extension/offscreen/engine.js at all — the line this asserts about is gone'
      : /fromCache/.test(weightsLog)
        ? `it is still worded off the retry boolean: ${weightsLog}`
        : !weightsLog.includes('modelSourceWord(source)')
          ? `it does not quote the seam\u2019s vocabulary: ${weightsLog}`
          : weightsLog);

  /**
   * THE DUTIES SPELLED `MUST`, HELD AGAINST THE ONE IMPLEMENTATION THAT HAS
   * THEM RIGHT.
   *
   * `assertHost` checks `typeof host[k] === 'function'` and nothing else, so
   * every MUST in the `EngineHost` typedef was documentation with no gate: a
   * Host whose `send` returns a promise, whose `onMessage` drops the routing
   * guard or re-wraps the envelope, or whose `captureStream` resolves null
   * instead of rejecting, passes the boot check and then fails quietly, far from
   * the mistake. The sharpest case is the one an Electron Host reaches for
   * first — `send = (m) => ipcRenderer.invoke('unit', m)` — which satisfies
   * `assertHost` and reintroduces exactly the unhandled rejection per 10 Hz
   * heartbeat that this Host's `.catch(() => {})` is load-bearing against.
   *
   * The whole value of declaring an interface rather than grepping for `chrome.`
   * is that a second implementer can be checked against it, and "did you define
   * five functions" is the question they are least likely to get wrong. The
   * deck's half below is the same shape against `DeckHost`, so the coverage this
   * seam has is the coverage both contexts get.
   *
   * REACHABLE, NOT CONSTRUCTED: every assertion below CALLS the shipping
   * `extension/offscreen/host.js`. What is stubbed is the PLATFORM underneath it
   * — `chrome`, `navigator.mediaDevices`, `addEventListener` — never the Host
   * itself, because the platform is the only part that cannot be present in
   * Node. The globals are removed again in the `finally`.
   */
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const realCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const wire = [];
  const registered = [];
  let inbox = null;
  let handled = false;
  let gum = null;
  let gumArg = null;
  /**
   * NOT a real rejected promise. An unhandled rejection ENDS THE PROCESS in
   * Node, so the mutation this exists to catch — a `send` that does not attach a
   * rejection handler — would take the whole suite out instead of turning one
   * line red, and a suite that dies is not a suite that reports. This thenable
   * records whether a rejection handler was attached at all; `.catch(fn)` and
   * `.then(null, fn)` both count, because the claim is that the failure is
   * handled, not how.
   */
  const deliveryFailure = () => ({
    then(_ok, err) { handled = true; if (err) err(new Error('Could not establish connection.')); return this; },
    catch(err) { return this.then(undefined, err); },
  });
  globalThis.chrome = {
    runtime: {
      sendMessage: (m) => { wire.push(m); return deliveryFailure(); },
      onMessage: { addListener: (fn) => { inbox = fn; } },
      getURL: (rel) => `chrome-extension://ffffffffffffffffffffffffffff/${rel}`,
    },
  };
  globalThis.addEventListener = (type, fn) => { registered.push([type, fn]); };
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: (c) => { gumArg = c; return gum(); } } },
    configurable: true,
    writable: true,
  });
  /**
   * The HOST's half of the model pin, read out of the module the Host reads it
   * from, so the stub below can be KEYED BY IT rather than answering to any
   * name at all.
   */
  const PIN_URL = (await import('./extension/offscreen/host-pin.js')).MODEL_URL;
  const PIN_BUCKET = (await import('./extension/offscreen/host-pin.js')).MODEL_CACHE_NAME;
  /**
   * THE PLATFORM UNDER THE MODEL DUTIES — the Cache API and `fetch`, stubbed the
   * same way and for the same reason as `chrome` above: they are the part that
   * cannot be present in Node, and everything they stand under is the shipping
   * `extension/offscreen/host.js`.
   *
   * The stub COUNTS rather than times: how many network requests, how many body
   * reads, which key was stored under. Every claim below is a count, which is
   * what AGENTS.md asks for and what makes these reproducible on a loaded box.
   *
   * The body arrives in TWO chunks and both are `subarray` VIEWS, because that
   * is what a real stream hands over and because a Host that passes a view
   * straight through would satisfy a one-chunk stub and then transfer the wrong
   * buffer into the inference worker.
   */
  const store = { entry: null, opened: [], matched: [], put: [], deleted: [], bodyReads: 0 };
  const fetched = [];
  let served = null;
  const streamed = (bytes) => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(bytes.length) : null) },
    body: {
      getReader() {
        store.bodyReads++;
        const cut = Math.floor(bytes.length / 2);
        const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];
        let i = 0;
        return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) };
      },
    },
  });
  /**
   * THE STUB IS KEYED, and that is the whole of its dynamic range.
   *
   * `open(name)` and `match(url)` are where this Host spends its half of the
   * pin, so a store that recorded both arguments and then served its one entry
   * whatever it was asked for would take the claim out of the assertions that
   * rest on it: reading under a key nothing was written under is a 109 MB
   * download on EVERY load (P1), and opening a bucket by another name makes
   * `clearModel()` a no-op in effect. Both are green against a single slot. A
   * bucket by any other name is a DIFFERENT bucket here, and an empty one.
   */
  globalThis.caches = {
    open: async (name) => {
      store.opened.push(name);
      const live = name === PIN_BUCKET;
      return {
        match: async (url) => {
          store.matched.push(url);
          return live && url === PIN_URL && store.entry ? streamed(store.entry) : undefined;
        },
        put: async (url, res) => {
          store.put.push(url);
          if (live && url === PIN_URL) store.entry = new Uint8Array(await res.arrayBuffer());
        },
      };
    },
    delete: async (name) => { store.deleted.push(name); if (name === PIN_BUCKET) store.entry = null; return true; },
  };
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      fetched.push(url);
      return served ? streamed(served) : { ok: false, status: 404 };
    },
    configurable: true,
    writable: true,
  });
  /**
   * Every duty is reached through `probe`, never called bare. A Host short a
   * duty is already red at the top of this group, and it must not ALSO take the
   * suite out on its way past: a file that dies at assertion three reports
   * nothing about the seven after it. An unreachable duty becomes the
   * assertion's own detail and the assertion fails — the same verdict, by a
   * route someone can read.
   */
  const probe = (f, ...a) => {
    try { return { ok: true, v: f(...a) }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; }
  };
  try {
    const sendCall = probe(engineHost.send, { type: 'HELLO' });
    const ret = sendCall.v;
    ok('send() RETURNS UNDEFINED, NEVER A PROMISE  '
      + '[entry point: extension/offscreen/host.js send(), reached from the 22 `return send({...})` sites in engine.js]',
      sendCall.ok && ret === undefined,
      !sendCall.ok
        ? `send() could not be called at all: ${sendCall.e}`
        : ret === undefined
          ? 'undefined'
          : `send() returned ${ret && typeof ret.then === 'function' ? 'a thenable' : JSON.stringify(ret)} — `
            + 'a `case` that ends `return send({...})` inside an async function would await it');

    ok('...and it SWALLOWS the delivery failure: with no surface open there is no listener, and that is entirely normal',
      wire.length === 1 && handled === true,
      wire.length !== 1
        ? `send() put ${wire.length} messages on the bus, expected 1 — the claim has nothing to look at`
        : handled
          ? 'the rejection is handled; unhandled, it is one console error per 10 Hz heartbeat'
          : 'nothing was attached to the promise sendMessage returned — every heartbeat becomes an unhandled rejection');

    ok('...and the HOST addresses it, not the engine: the engine hands over a bare {type} and the deck sees a full envelope  '
      + '[entry point: extension/offscreen/host.js send()]',
      wire.length === 1 && wire[0].v === 1 && wire[0].to === 'ui' && wire[0].from === 'off' && wire[0].type === 'HELLO',
      wire.length === 1 ? JSON.stringify(wire[0]) : `${wire.length} messages on the bus, expected 1`);

    const seen = [];
    const inboxCall = probe(engineHost.onMessage, (m) => { seen.push(m); });
    const notMine = { v: 1, to: 'ui', from: 'off', type: 'STATE' };
    const rOther = inbox ? inbox(notMine) : null;
    const rNull = inbox ? inbox(null) : null;
    ok("onMessage()'s ROUTING GUARD IS THE HOST'S: a message addressed elsewhere never reaches the engine  "
      + '[entry point: extension/offscreen/host.js onMessage(), reached from engine.js module scope]',
      inbox != null && seen.length === 0,
      inbox == null
        ? `onMessage registered no listener with the platform at all — the engine has no inbox${inboxCall.ok ? '' : ` (${inboxCall.e})`}`
        : seen.length === 0
          ? 'chrome.runtime.sendMessage is a broadcast, so `to` is the routing, and the routing is applied here'
          : `the engine was handed ${seen.length} message(s) not addressed to it: ${JSON.stringify(seen)}`);

    const mine = { v: 1, to: 'off', from: 'sw', type: 'CAPTURE_START', sourceToken: 'tok' };
    const rMine = inbox ? inbox(mine) : null;
    ok('...and what it hands over is the RAW ENVELOPE — the same object, not a copy and not the payload',
      seen.length === 1 && seen[0] === mine,
      seen.length !== 1
        ? `the engine's inbox ran ${seen.length} times for one addressed message`
        : seen[0] === mine
          ? 'the same object, unwrapped and un-normalised'
          : `the engine was handed ${JSON.stringify(seen[0])}, not the envelope the bus carried`);

    ok('...and the listener returns falsy, so MV3 does not hold the message channel open for every message the engine receives',
      inbox != null && !rMine && !rOther && !rNull,
      inbox == null ? 'no listener was registered' : `to:'off' -> ${JSON.stringify(rMine)}, to:'ui' -> ${JSON.stringify(rOther)}, null -> ${JSON.stringify(rNull)}`);

    gum = () => Promise.reject(new Error('NotAllowedError: permission denied'));
    const failing = probe(engineHost.captureStream, 'token-A');
    const outcome = failing.ok
      ? await Promise.resolve(failing.v).then((v) => ({ resolved: true, v }), (e) => ({ resolved: false, e }))
      : { unreachable: failing.e };
    ok('captureStream() REJECTS RATHER THAN RESOLVING NULL — a null would travel on as a capture with no track  '
      + '[entry point: extension/offscreen/host.js captureStream(), reached from engine.js captureStart()]',
      outcome.resolved === false,
      outcome.unreachable
        ? `captureStream() could not be called at all: ${outcome.unreachable}`
        : outcome.resolved === false
          ? String(outcome.e && outcome.e.message)
          : `the failure resolved as ${JSON.stringify(outcome.v)} — every caller is .catch-wrapped, so the engine `
            + 'would attach it and report a live capture over a stream with no track');

    const track = { kind: 'audio', stop() {} };
    const stream = { getTracks: () => [track] };
    gum = () => Promise.resolve(stream);
    const opening = probe(engineHost.captureStream, 'token-B');
    const got = opening.ok ? await Promise.resolve(opening.v).catch(() => null) : null;
    const tokenThrough = gumArg && gumArg.video === false
      && gumArg.audio && gumArg.audio.mandatory && gumArg.audio.mandatory.chromeMediaSourceId === 'token-B';
    ok('...and OWNERSHIP TRANSFERS: the stream arrives exactly as the platform made it, and the opaque token reached the platform untouched',
      got === stream && tokenThrough === true,
      got !== stream
        ? 'the Host wrapped or replaced the stream — the engine stops the tracks (R5) on the object it is handed, so a wrapper leaks the real one'
        : tokenThrough
          ? JSON.stringify(gumArg)
          : `the token did not reach getUserMedia intact: ${JSON.stringify(gumArg)}`);

    const assetCall = probe(engineHost.assetUrl, 'offscreen/capture-processor.js');
    const url = assetCall.v;
    ok('assetUrl() IS SYNCHRONOUS AND RETURNS A STRING — it is called from constructors that run before there is an AudioContext to await on  '
      + '[entry point: extension/offscreen/host.js assetUrl(), reached from engine.js ensureContext()]',
      assetCall.ok && typeof url === 'string' && url.endsWith('/offscreen/capture-processor.js'),
      !assetCall.ok
        ? `assetUrl() could not be called at all: ${assetCall.e}`
        : typeof url !== 'string'
          ? `assetUrl returned ${url && typeof url.then === 'function' ? 'a promise' : typeof url} — `
            + 'audioWorklet.addModule() would be handed it verbatim'
          : url);

    /**
     * A DIRECTORY PATH COMES BACK AS A DIRECTORY URL — S2's obligation, held
     * against the SHIPPED Host rather than through the graph.
     *
     * `offscreen/deck.js` hands `assetUrl('vendor/ort/')` to the inference
     * worker's `INIT` and ONNX Runtime appends its own file names to it, so a
     * resolver that tidies the trailing slash away produces a wasm path with no
     * separator in it and ORT throws "w is not a function" several layers down
     * (R0 measured that one). Every other claim about this rule in the tree
     * drives a `stub://unit/` resolver written here, so all of them hold
     * `deck.js` and none of them holds a HOST: review changed this file's
     * `assetUrl` to `chrome.runtime.getURL(relPath.replace(/\/+$/, ''))` —
     * exactly what `path.join()` or `url.pathToFileURL()` does in a Node or
     * Electron Host — and the whole green tree accepted it, `node test.js`
     * 508/0 and embed-smoke 122/122.
     *
     * Called UNBOUND through `probe`, like every duty in this block, which is
     * the second half of the contract: `engine.js` hands `host.assetUrl` itself
     * to `MasterBus` and to the decks rather than calling it through the
     * namespace.
     */
    const dirCall = probe(engineHost.assetUrl, 'vendor/ort/');
    const dirUrl = dirCall.v;
    ok('...AND A PATH ENDING IN `/` COMES BACK AS A DIRECTORY URL, trailing slash intact  '
      + '[entry point: extension/offscreen/host.js assetUrl(), reached from workerbackend.js spawn() as the '
      + "worker's INIT wasmDirUrl]",
      dirCall.ok && typeof dirUrl === 'string' && dirUrl.endsWith('/vendor/ort/'),
      !dirCall.ok
        ? `assetUrl('vendor/ort/') could not be called at all: ${dirCall.e}`
        : typeof dirUrl !== 'string'
          ? `assetUrl returned ${typeof dirUrl}`
          : dirUrl.endsWith('/vendor/ort/')
            ? dirUrl
            : `assetUrl('vendor/ort/') returned ${JSON.stringify(dirUrl)} — ORT appends its own file names to this, `
              + 'so without the separator the wasm path is nonsense and the runtime throws "w is not a function"',
    );

    const tdFn = () => {};
    const tdCall = probe(engineHost.onTeardown, tdFn);
    ok("onTeardown() REGISTERS THE ENGINE'S OWN CALLBACK, unwrapped, so nothing can defer or await the last-gasp stop  "
      + '[entry point: extension/offscreen/host.js onTeardown(), reached from engine.js module scope]',
      tdCall.ok && registered.length === 1 && registered[0][0] === 'pagehide' && registered[0][1] === tdFn,
      !tdCall.ok
        ? `onTeardown() could not be called at all: ${tdCall.e}`
        : registered.length !== 1
          ? `onTeardown registered ${registered.length} listeners, expected 1`
          : registered[0][1] !== tdFn
            ? "the registered handler is a wrapper, not the engine's callback — teardown does not await, "
              + 'so a wrapper that returns a promise drops the track stop'
            : `${registered[0][0]}, the engine's own function`);

    /**
     * THE MODEL BYTES — the P1 surface, and the half of this seam no grep for
     * `chrome.` can see (S7, issue #5).
     *
     * `fetch` and the Cache API are not `chrome.*`. Before S7 the URL lived in
     * `shared/config.js` and the fetch in `shared/modelcache.js`, so the unit
     * carried a network path that the S9 unit gate — a grep for `chrome.` — was
     * structurally incapable of noticing. Moving `MODEL.url` to
     * `offscreen/host-pin.js` is what removed it, and these are the assertions
     * that hold the split in place from the HOST's side. The UNIT's side is the
     * `verifyModel` group below, and the two are complementary on purpose:
     * together they say the bytes come from here and the judgement happens
     * there, and neither one alone says it.
     *
     * REACHABLE, NOT CONSTRUCTED, like everything else in this block: the
     * shipping `extension/offscreen/host.js` is what runs, and only the Cache
     * API and `fetch` under it are stubbed.
     */
    const aprobe = async (f, ...a) => {
      try { return { ok: true, v: await f(...a) }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; }
    };
    const same = (a, b) => a instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);
    /** Not the real weights and deliberately not their size: the pin is the unit's, and this block never touches it. */
    const weights = new Uint8Array(4096);
    for (let i = 0; i < weights.length; i++) weights[i] = (i * 37 + 11) & 0xff;

    store.entry = weights; store.bodyReads = 0; store.opened.length = 0; store.matched.length = 0;
    const cachedYes = await aprobe(engineHost.modelCached);
    store.entry = null;
    const cachedNo = await aprobe(engineHost.modelCached);
    const askedRight = store.opened.length === 2 && store.opened.every((b) => b === PIN_BUCKET)
      && store.matched.length === 2 && store.matched.every((u) => u === PIN_URL);
    ok('modelCached() ANSWERS WITHOUT READING THE BYTES, AND ASKS THE PINNED KEY IN THE PINNED BUCKET — the deck asks at boot, before any gesture, and an answer that costs a 109 MB read is one nobody can afford to ask for  '
      + '[entry point: extension/offscreen/host.js modelCached(), reached from engine.js STATUS]',
      cachedYes.v === true && cachedNo.v === false && store.bodyReads === 0 && askedRight,
      !cachedYes.ok || !cachedNo.ok
        ? `modelCached() could not be called at all: ${cachedYes.e || cachedNo.e}`
        : store.bodyReads !== 0
          ? `it read the body ${store.bodyReads} time(s) to answer a yes/no question`
          : !askedRight
            ? `it looked for ${JSON.stringify([...new Set(store.matched)])} in ${JSON.stringify([...new Set(store.opened)])}, `
              + 'which is not the pinned url in the pinned bucket — it is answering about some other store'
            : `stored -> ${cachedYes.v}, empty -> ${cachedNo.v}, 0 body reads, both answers read ${PIN_URL} from ${PIN_BUCKET}`);

    store.entry = weights; store.bodyReads = 0; fetched.length = 0; served = null;
    store.opened.length = 0; store.matched.length = 0;
    const hit = await aprobe(engineHost.modelBytes);
    const readRight = store.opened.length === 1 && store.opened[0] === PIN_BUCKET
      && store.matched.length === 1 && store.matched[0] === PIN_URL;
    ok('modelBytes() SERVES A STORED COPY WITHOUT TOUCHING THE NETWORK — P1 is held by the ORDER of these lines, and by nothing else  '
      + '[entry point: extension/offscreen/host.js modelBytes(), reached from shared/modelcache.js loadModel()]',
      hit.ok && fetched.length === 0 && hit.v.fromCache === true && same(hit.v.bytes, weights) && readRight,
      !hit.ok
        ? `modelBytes() rejected on a stored copy: ${hit.e}`
        : fetched.length !== 0
          ? `it made ${fetched.length} network request(s) with the bytes already on disk — that is P1, once per browser start`
          : !readRight
            ? `it looked for ${JSON.stringify(store.matched)} in ${JSON.stringify(store.opened)} rather than ${PIN_URL} in `
              + `${PIN_BUCKET} — a read key that misses is a fresh download every single load`
            : `${weights.length} B from the store, fromCache=${hit.v.fromCache}, 0 fetches, read ${PIN_URL} from ${PIN_BUCKET}`);

    store.entry = null; fetched.length = 0; store.put.length = 0; served = weights;
    store.opened.length = 0; store.matched.length = 0;
    const miss = await aprobe(engineHost.modelBytes);
    ok('...and on a MISS it fetches the PINNED url exactly once, and stores what it fetched under THE SAME KEY IT JUST LOOKED UNDER — a write key that is not the read key is a fresh 109 MB on every load, for ever',
      miss.ok && fetched.length === 1 && fetched[0] === PIN_URL
        && store.matched.length === 1 && store.matched[0] === PIN_URL
        && store.put.length === 1 && store.put[0] === PIN_URL
        && store.opened.length === 1 && store.opened[0] === PIN_BUCKET && miss.v.fromCache === false,
      !miss.ok
        ? `modelBytes() rejected on a cold store: ${miss.e}`
        : `${fetched.length} fetch(es) ${JSON.stringify(fetched)}, looked under ${JSON.stringify(store.matched)}, `
          + `${store.put.length} put(s) ${JSON.stringify(store.put)}, bucket(s) ${JSON.stringify(store.opened)}, fromCache=${miss.v.fromCache}`);

    ok('...and the bytes it hands over OWN THEIR WHOLE BUFFER — the unit transfers `bytes.buffer` into the inference worker, so a VIEW would transfer the wrong thing',
      miss.ok && miss.v.bytes.byteOffset === 0
        && miss.v.bytes.byteLength === miss.v.bytes.buffer.byteLength && same(miss.v.bytes, weights),
      !miss.ok
        ? 'there are no bytes to look at'
        : `byteOffset ${miss.v.bytes.byteOffset}, ${miss.v.bytes.byteLength} of a ${miss.v.bytes.buffer.byteLength} B buffer, `
          + `content ${same(miss.v.bytes, weights) ? 'intact across the two chunks' : 'DIFFERENT from what was served'}`);

    /**
     * THE PROGRESS CALLBACK IS PART OF THE DUTY, so it is CALLED here rather
     * than described. `ui/welcome.js` keeps a set of the phases that carry a
     * byte count (`cache`, `download`) and quotes a percentage for those and
     * only those, because quoting 100 % through a phase that has not started is
     * the exact shape of a hang. That rule now rests on a Host-side line: which
     * phase is announced, that it is announced BEFORE any bytes move, and that
     * the counts that follow are real.
     */
    store.entry = weights; fetched.length = 0; served = null;
    const hitPhases = [];
    const warm = await aprobe(engineHost.modelBytes, (phase, got, total) => hitPhases.push([phase, got, total]));
    store.entry = null; served = weights; fetched.length = 0;
    const coldPhases = [];
    const cold = await aprobe(engineHost.modelBytes, (phase, got, total) => coldPhases.push([phase, got, total]));
    const announced = (rows, phase) => rows.length >= 2 && rows.every(([ph]) => ph === phase)
      && rows[0][1] === 0 && rows[rows.length - 1][1] === weights.length;
    ok("...and it ANNOUNCES ITS PHASE BEFORE ANY BYTES MOVE, and says 'cache' only when it is really serving from store — the progress card reads the phase to decide whether it may quote a percentage at all  "
      + '[entry point: extension/offscreen/host.js modelBytes(onProgress), reached from engine.js loadOnce() -> ui/welcome.js]',
      warm.ok && cold.ok && announced(hitPhases, 'cache') && announced(coldPhases, 'download'),
      !warm.ok || !cold.ok
        ? `modelBytes(onProgress) rejected: ${warm.e || cold.e}`
        : `store hit ${JSON.stringify(hitPhases)}, cold ${JSON.stringify(coldPhases)}`);

    store.entry = new Uint8Array(8); fetched.length = 0;
    const unjudged = await aprobe(engineHost.modelBytes);
    ok('THE HOST HANDS OVER WHATEVER IT HAS AND NEVER JUDGES IT — verification did NOT follow the fetch across the seam  '
      + '[entry point: extension/offscreen/host.js modelBytes(); the refusal is shared/modelcache.js verifyModel()]',
      unjudged.ok && unjudged.v.bytes.length === 8,
      !unjudged.ok
        ? `the Host refused eight zero bytes itself (${unjudged.e}) — a Host that CAN verify is a Host that can decline to, `
          + 'and M1 is not a property the unit may delegate'
        : `8 B of nothing handed straight over; the verifyModel group is where they are refused`);

    store.entry = weights; store.deleted.length = 0; store.opened.length = 0;
    const cleared = await aprobe(engineHost.clearModel);
    const afterClear = await aprobe(engineHost.modelCached);
    ok('clearModel() REALLY DROPS THE STORE, AND DROPS THE BUCKET THE OTHER TWO DUTIES OPEN — a no-op, or a bucket by another name, turns one corrupt download into a permanently dead deck',
      cleared.ok && store.deleted.length === 1 && store.deleted[0] === PIN_BUCKET
        && store.opened.length === 1 && store.opened[0] === PIN_BUCKET && afterClear.v === false,
      !cleared.ok
        ? `clearModel() could not be called at all: ${cleared.e}`
        : `deleted ${JSON.stringify(store.deleted)}, the reader then opened ${JSON.stringify(store.opened)}, modelCached() -> ${afterClear.v}`);

    store.entry = null; served = null; fetched.length = 0;
    const http = await aprobe(engineHost.modelBytes);
    ok('...and an HTTP failure REJECTS naming the status, instead of resolving with an empty buffer that fails the hash a minute later somewhere else',
      http.ok === false && http.e.includes('404'),
      http.ok ? `a 404 resolved as ${JSON.stringify(http.v && http.v.bytes && http.v.bytes.length)} bytes` : http.e);

    /**
     * THE ONE DUTY OF THE THREE THAT MAY NOT REJECT. Storage can be unavailable
     * — blocked, partitioned, or a context that never had it — and `modelCached`
     * is awaited by `engine.js`'s STATUS case BEFORE `ensureBackend()`,
     * `echoXf()` and `push()`. A rejection there does not paint a model error:
     * it abandons the rest of the case and lands in `handle()`'s catch, which
     * writes `state.job.error`, a field nothing reads. The deck stays blank.
     */
    const stubbedCaches = globalThis.caches;
    globalThis.caches = {
      open: async () => { throw new Error('storage is unavailable in this context'); },
      delete: async () => { throw new Error('storage is unavailable in this context'); },
    };
    const unsure = await aprobe(engineHost.modelCached);
    globalThis.caches = stubbedCaches;
    ok('modelCached() ANSWERS `false` WHEN IT CANNOT LOOK, rather than rejecting — the duty says so because a rejection here is not a model error, it is a deck that paints nothing at all  '
      + '[entry point: extension/offscreen/host.js modelCached(), reached from engine.js handle() case STATUS]',
      unsure.ok === true && unsure.v === false,
      unsure.ok
        ? `storage that throws -> ${unsure.v}, so the user is offered a download rather than shown nothing`
        : `it rejected instead: ${unsure.e} — engine.js awaits this before ensureBackend/echoXf/push`);

    /**
     * ---------------------------------------------------------------------
     * createBackend() — S6, and the one duty whose RETURN VALUE the unit calls
     * ---------------------------------------------------------------------
     *
     * The seam here is the AUDIO level (seed §16, option S2): the Host decides
     * WHICH engine separates a segment, and under this Host there is one to
     * decide between. So what is worth an assertion is not the choice — it is
     * the two properties a plausible second Host gets wrong for free.
     *
     * DRIVEN, NOT IMITATED, like every duty in this block: the shipped
     * `offscreen/host.js` builds the shipped `workers/workerbackend.js` over a
     * stubbed `Worker` and `fetch`, so the INIT that comes out carries the
     * shipped `chrome.runtime.getURL`. The `assetUrl` assertions above hold that
     * resolver to the trailing-slash rule; this one holds the HAND-OFF, which is
     * a separate step with a separate way to be lost — `new WorkerBackend({
     * ...hooks })` without it is a Host that satisfies every check above and a
     * backend that cannot find ORT.
     *
     * The platform stubs are LOCAL and restored immediately, because the model
     * duties above count `fetch` calls and the backend's ORT probe is one.
     */
    const spawnedByHost = [];
    const readies = [];
    const fails = [];
    const stubbedFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let backends = null;
    let backendWhy = null;
    try {
      globalThis.Worker = class {
        constructor(url) { this.url = String(url); this.onmessage = null; this.onerror = null; spawnedByHost.push(this); }
        postMessage(m) { (this.posts || (this.posts = [])).push(m); }
        terminate() { this.terminated = true; }
      };
      Object.defineProperty(globalThis, 'fetch', {
        value: async () => ({ ok: true }), configurable: true, writable: true,
      });
      /**
       * THE HOOKS GO THROUGH THE HOST, NOT AROUND IT. This block used to call
       * `createBackend({})`, and the `backend` group builds `new WorkerBackend`
       * itself — so the `...hooks` spread in `offscreen/host.js`, the one line
       * that carries them across, was covered by nothing. Review measured it:
       * `new WorkerBackend({ assetUrl })` left `node test.js` at 602 passed and
       * `embed-smoke` at 130/130.
       *
       * It is the one part of this duty `assertHost(backend, BACKEND_DUTIES)`
       * cannot reach — a backend short a hook owes every declared duty — and
       * losing it costs both things that arrive OUTSIDE a call the unit made:
       * `state.boot.{adapter,threads}` never populates, and an idle backend
       * death is silent until the next arm.
       */
      const first = probe(engineHost.createBackend, {
        name: 'deck A',
        onReady: (info) => readies.push(info),
        onFail: (e) => fails.push(e.message),
      });
      /**
       * AND A CALLER DOES NOT GET TO NAME THE HOST'S RESOLVER. `assetUrl` is
       * applied AFTER the spread for this reason: it is the Host's one
       * non-negotiable input, and a `hooks` object carrying that key would
       * otherwise take over where the unit's files live. Unreachable through the
       * declared hook type today, which is why it is asserted rather than
       * assumed to stay that way.
       */
      const second = probe(engineHost.createBackend, { assetUrl: () => 'stolen://elsewhere/' });
      if (first.ok && second.ok) backends = [first.v, second.v];
      else backendWhy = first.ok ? second.e : first.e;
      /**
       * Then drive the two things the WORKER originates. Both are one-way: the
       * backend is the only thing listening, and the deck is the only thing
       * behind it.
       */
      if (spawnedByHost.length && spawnedByHost[0].onmessage) {
        spawnedByHost[0].onmessage({ data: { type: 'READY', numThreads: 4, adapter: { vendor: 'nvidia', architecture: 'turing' } } });
      }
      // The EMPTY message is the shape a module worker that cannot resolve its
      // static import actually fires, and `name` is what turns it into a
      // sentence — so this half asserts the `name` hook crossed as well.
      if (spawnedByHost.length && spawnedByHost[0].onerror) spawnedByHost[0].onerror({ message: '' });
    } finally {
      delete globalThis.Worker;
      if (stubbedFetch) Object.defineProperty(globalThis, 'fetch', stubbedFetch);
    }

    const initFromHost = spawnedByHost.length ? (spawnedByHost[0].posts || []).find((m) => m && m.type === 'INIT') : null;
    const shortDuty = backends
      ? Object.keys(BACKEND_DUTIES).filter((k) => typeof backends[0][k] !== 'function')
      : Object.keys(BACKEND_DUTIES);
    ok('createBackend() HANDS BACK A BACKEND THAT OWES EVERY DECLARED DUTY, WITH THIS HOST’S RESOLVER ALREADY IN IT  '
      + '[entry point: extension/offscreen/host.js createBackend(), reached from deck.js Deck.ensureBackend()]',
      backends != null && shortDuty.length === 0
      && spawnedByHost.length === 2 && initFromHost != null
      && initFromHost.wasmDirUrl.endsWith('/vendor/ort/'),
      backends == null
        ? `createBackend() could not be called at all: ${backendWhy}`
        : shortDuty.length
          ? `the backend is short ${shortDuty.join(', ')} — Deck.ensureBackend() refuses it, but only at the first arm`
          : spawnedByHost.length !== 2
            ? `${spawnedByHost.length} worker(s) were spawned by two createBackend() calls`
            : initFromHost == null
              ? 'the backend posted no INIT, so nothing was told where the ORT runtime lives'
              : `${Object.keys(BACKEND_DUTIES).length} duties, INIT wasmDirUrl ${initFromHost.wasmDirUrl}`);

    /**
     * A FRESH INSTANCE PER CALL, AND THE WORKER COUNT IS WHAT SAYS SO.
     *
     * Memoising is the obvious optimisation and it is the one shape this duty
     * must never take: two decks sharing one worker is two ORT sessions on one
     * wasm instance, and a concurrent `run()` there PERMANENTLY WEDGES both
     * (`offscreen/deck.js` header, `engine/scheduler.js:19-23`,
     * `workers/inference.worker.js:10-12`). Nothing else in this tree would
     * notice: one deck ships, so a memoised backend is correct in every gate and
     * a grenade the moment deck B is armed.
     *
     * BOTH HALVES, because either alone can be satisfied by the wrong thing: two
     * distinct wrappers over one worker still share the wasm instance, and two
     * workers reached through one object is not a shape anything here builds.
     */
    ok('...and a FRESH one every call — two decks must never share a wasm instance  '
      + '[entry point: extension/offscreen/host.js createBackend()]',
      backends != null && backends[0] !== backends[1]
      && spawnedByHost.length === 2 && spawnedByHost[0] !== spawnedByHost[1],
      backends == null
        ? `createBackend() could not be called at all: ${backendWhy}`
        : backends[0] === backends[1]
          ? 'two calls returned THE SAME backend — deck B would drive deck A’s ORT session and wedge both'
          : `2 calls, 2 backends, ${spawnedByHost.length} worker(s)`);

    /**
     * ...AND THE UNIT'S HOOKS REACH THE BACKEND THE HOST BUILT.
     *
     * Both halves in one assertion because they are one line's worth of
     * behaviour — the spread either happened or it did not — and because each
     * alone is satisfiable by the wrong thing: a Host that forwarded `onReady`
     * and dropped `onFail` still loses the death, and one that forwarded the
     * callbacks and dropped `name` reports the death without saying whose.
     */
    const readyInfo = readies.length === 1 ? readies[0] : null;
    ok('...and the UNIT\u2019S HOOKS REACH IT — a backend that owes every duty and answers to nobody is the one shape assertHost cannot refuse  '
      + '[entry point: extension/offscreen/host.js createBackend(), the hooks deck.js Deck.ensureBackend() hands it]',
      readyInfo != null && readyInfo.threads === 4
      && readyInfo.adapter != null && readyInfo.adapter.vendor === 'nvidia'
      && fails.length === 1 && fails[0].includes('deck A'),
      readies.length !== 1
        ? `the worker announced READY and the unit heard it ${readies.length} time(s) — state.boot.{adapter,threads} `
          + 'never populates, so the deck reports no hardware at all'
        : readyInfo.threads !== 4 || !readyInfo.adapter
          ? `onReady arrived carrying ${JSON.stringify(readyInfo)}`
          : fails.length !== 1
            ? 'the worker DIED and the unit was never told — the deck goes on reporting a session it no longer has '
              + 'until the next arm, which is the whole reason onFail exists'
            : !fails[0].includes('deck A')
              ? `onFail arrived without the name it was given: ${fails[0]}`
              : `onReady{threads 4, gpu nvidia/turing} and onFail "${fails[0]}"`);

    /**
     * ...AND THE HOST'S OWN RESOLVER SURVIVED A CALLER THAT TRIED TO SUPPLY ONE.
     * Read off the SECOND worker, which is the one built from the hostile hooks
     * object; the first one's INIT is asserted above and would not move.
     */
    const initSecond = spawnedByHost.length > 1 ? (spawnedByHost[1].posts || []).find((m) => m && m.type === 'INIT') : null;
    ok('...and a hooks object CANNOT REPLACE THE HOST\u2019S RESOLVER — where the unit\u2019s files live is the Host\u2019s answer  '
      + '[entry point: extension/offscreen/host.js createBackend()]',
      initSecond != null && initSecond.wasmDirUrl.endsWith('/vendor/ort/')
      && !String(initSecond.wasmDirUrl).startsWith('stolen://'),
      initSecond == null
        ? 'the second backend posted no INIT, so this inspected nothing'
        : String(initSecond.wasmDirUrl).startsWith('stolen://')
          ? `the caller\u2019s assetUrl won: INIT wasmDirUrl ${initSecond.wasmDirUrl} — the unit now decides where the Host `
            + 'keeps the ORT runtime'
          : `INIT wasmDirUrl ${initSecond.wasmDirUrl}`);

    /**
     * THE TWO DUTIES THIS HOST REFUSES ARE STILL DRIVEN, because a refusal is an
     * implementation and an undriven implementation is a claim.
     *
     * `offscreen/host.js` answers `sourceBytes` and `exportSink` by rejecting:
     * its Sources are tabs, which have no encoded bytes behind them, and
     * `tools/tree-check.mjs` asserts this build requests no `downloads`
     * permission. Both refusals are legitimate — `sourceBytes`'s own
     * declaration says a Host whose Sources are all streams may reject every
     * token here — and both are exactly the shape that decays into a stub that
     * RESOLVES with an empty answer, which is strictly worse: a zero-length
     * buffer decodes to a track that is silently not the track, and a sink map
     * missing a stem exports five of six files and calls it done.
     *
     * REJECTS RATHER THAN THROWS. Each is declared `=> Promise<…>`, and a
     * synchronous throw escapes a `.catch()` that is not preceded by an `await`
     * — landing as an unhandled error one frame out from the call, which is the
     * late failure this seam moves earlier everywhere else. So `probe` is asked
     * whether the call RETURNED at all, and the settlement is asked separately.
     *
     * Called UNBOUND through `probe`, like every duty in this block.
     */
    for (const [duty, arg] of [['sourceBytes', 'token-A'],
      ['exportSink', { title: 'a track', files: ['vocals.wav'] }]]) {
      const call = probe(engineHost[duty], arg);
      const settled = call.ok
        ? await Promise.resolve(call.v).then((v) => ({ resolved: true, v }), (e) => ({ resolved: false, e }))
        : { threwSync: call.e };
      const msg = String((settled.e && settled.e.message) || settled.e || '');
      ok(`${duty}() REFUSES BY REJECTING, AND THE REFUSAL NAMES ITSELF — this Host has no file Sources and no `
        + 'export path, and an empty answer would travel on as a real one  '
        + `[entry point: extension/offscreen/host.js ${duty}(), called unbound as engine.js passes its duties]`,
        settled.resolved === false && msg.includes(duty),
        settled.threwSync
          ? `${duty}() threw SYNCHRONOUSLY (${settled.threwSync}) — it is declared => Promise, so a caller that `
            + 'attaches .catch() without awaiting first never sees it'
          : settled.resolved
            ? `${duty}() RESOLVED with ${JSON.stringify(settled.v)} — the unit would carry that forward as an answer`
            : msg || `${duty}() rejected with something carrying no message`);
    }
  } finally {
    delete globalThis.chrome;
    delete globalThis.addEventListener;
    Object.defineProperty(globalThis, 'navigator', realNavigator);
    if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch);
    else delete globalThis.fetch;
    if (realCaches) Object.defineProperty(globalThis, 'caches', realCaches);
    else delete globalThis.caches;
  }

  head('host — the DECK half of the same seam: the boot check, and the transport it hides');
  /**
   * The shipped DeckHost, driven and never imitated: a check that reimplemented
   * the module it is guarding would be a second copy of the bug.
   *
   * THE PLATFORM IS STUBBED, NEVER THE HOST — the same rule the engine half
   * states. `chrome` goes on `globalThis` at the point of use; `window` has to
   * go on before the import, because `ui/host.js` reads `window.parent` and
   * hangs its one `message` listener at MODULE SCOPE. That is deliberate on
   * both sides: the module asks `window.parent` rather than a bare `parent`
   * precisely so it can be driven from here, and the frame question is
   * evaluated once, at import, which is what makes the two-import test below
   * mean anything.
   *
   * `posted` is the outgoing postMessage wire and `listeners` the incoming one.
   * A LONE window is one whose `parent` is itself — a document opened outside a
   * frame, where a post to `parent` lands back on its own listener.
   *
   * WHICH WINDOW IT WENT TO IS TAGGED, and that tag is the whole difference
   * between an assertion and a name. Both sinks land in the same `posted` array,
   * so without `to` a Host that posted to its OWN window instead of its parent —
   * every deck -> host message reaching `content.js` never — is indistinguishable
   * from a correct one. Review measured exactly that: `window.postMessage(msg,
   * '*')` in place of `window.parent.postMessage` left `node test.js host` at
   * 58 passed, 0 failed, under an assertion whose name says "to `parent`".
   * On a LONE window `parent` IS the window, so `to: 'self'` there is the truth
   * and not a miss.
   */
  const makeWindow = (framed) => {
    const w = {
      listeners: [], posted: [],
      addEventListener(type, fn) { w.listeners.push([type, fn]); },
      postMessage(msg, targetOrigin) { w.posted.push({ to: 'self', msg, targetOrigin }); },
    };
    w.parent = framed
      ? { postMessage: (msg, targetOrigin) => w.posted.push({ to: 'parent', msg, targetOrigin }) }
      : w;
    return w;
  };
  /** Deliver one `message` event to whatever the module registered. */
  const deliver = (w, source, data) => {
    for (const [type, fn] of w.listeners) if (type === 'message') fn({ source, data });
  };
  realWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');
  windowStubbed = true;
  const framedWin = makeWindow(true);
  globalThis.window = framedWin;
  const deckHost = ((await importHole('extension/ui/host.js',
    () => import('./extension/ui/host.js'))) || {}).host;
  const deckDuties = Object.keys(DECK_HOST_DUTIES);
  /**
   * RENDERING vs REACHABILITY: reachable by construction. Every assertion below
   * drives the SHIPPED `extension/ui/host.js` and the SHIPPED `assertHost`, with
   * a `chrome` stub standing in for the bus. Nothing here reimplements either.
   *
   * WHY THESE ARE HERE AND NOT ONLY IN `tools/embed-smoke.mjs`. The browser gate
   * covers the deck end to end and it is the only thing that can — but CI runs
   * `--quick` and never reaches it (`.github/workflows/verify.yml`), which is
   * exactly why the chord fix had to leave an `embed-state` assertion behind as
   * well. The two things a broken Host breaks SILENTLY are late binding and the
   * envelope, so both get an assertion on this side of the browser too.
   */

  // ---------------------------------------------------------- the boot check
  /**
   * ENTRY POINT: `assertHost(host, DECK_HOST_DUTIES, 'DeckHost')` at the top of
   * `extension/ui/embed.js`. `assertHost` now has TWO callers — the block above
   * drives it through `ENGINE_HOST_DUTIES` from `offscreen/engine.js`'s side —
   * and a duty list that is right for one and wrong for the other is exactly the
   * "right at one call site, wrong at another" defect AGENTS.md counts five of.
   * So these name the deck's list, not "a host".
   */
  {
    /**
     * A DeckHost that owes EXACTLY what is declared, built from the list rather
     * than written out — and that is not tidiness, it is the difference between
     * these cases testing what they say they test and not testing it at all.
     * The list went from two duties to six in S4. A hand-written
     * `{ send() {}, onMessage() {} }` is short four of them, so every refusal
     * below would have gone on passing for the wrong reason: refused for the
     * four it never had, whatever was done to the one the case meant to break.
     */
    const stubDeck = () => Object.fromEntries(deckDuties.map((k) => [k, () => {}]));
    const complete = stubDeck();
    ok('assertHost-returns-the-host-it-was-given: a complete DeckHost boots',
      assertHost(complete, DECK_HOST_DUTIES, 'DeckHost') === complete,
      `${deckDuties.length} duties`);

    ok('assertHost-passes-the-SHIPPED-ui/host.js — this is the gate on its export list',
      assertHost(deckHost, DECK_HOST_DUTIES, 'DeckHost') === deckHost,
      deckDuties.join(', '));

    const threw = (h) => { try { assertHost(h, DECK_HOST_DUTIES, 'DeckHost'); return null; } catch (e) { return e; } };

    const noSend = threw({ ...stubDeck(), send: undefined });
    ok('assertHost-NAMES-the-missing-duty: a Host short ONLY `send` throws saying `send`, and says nothing about the five it has',
      noSend instanceof Error && /\bsend\b/.test(noSend.message) && /DeckHost/.test(noSend.message)
      && !/onMessage|storageGet|armShortcut/.test(noSend.message),
      noSend ? noSend.message : 'it did not throw');

    const noneAtAll = threw({});
    ok('assertHost-names-EVERY-missing-duty, not just the first',
      noneAtAll !== null && /\bsend\b/.test(noneAtAll.message) && /\bonMessage\b/.test(noneAtAll.message),
      noneAtAll ? noneAtAll.message : 'it did not throw');

    /**
     * NOT ONLY THE STRING CASE. Both reviews of this wave found the same
     * survivor: the deck's `assertHost` accepted `typeof v === 'object'` before
     * the two halves were merged, so `{ send: {} }` — an Electron preload
     * bridge wrapped one level too deep, and the likeliest shape a second Host
     * gets wrong — passed the boot check and then died at the first user
     * gesture with `host.send is not a function`, which is the exact failure
     * this check exists to move to boot. The engine's half already required a
     * function; the merged `assertHost` keeps that, and this holds it for the
     * deck's list too. Widening it again for a genuinely namespace-shaped duty
     * (S4's `storage`) turns this red, which is the point: it should be a
     * deliberate change with its own assertion, not a side effect.
     */
    const wrongShapes = [
      ['a lost export, which reads as a string rather than as absence', { ...stubDeck(), send: 'sendMessage' }],
      ['a namespace object where a callable was meant', { ...stubDeck(), send: {} }],
      ['an array', { ...stubDeck(), send: [] }],
      ['a storage duty that is an object, which is the shape S4 was warned it would arrive in', { ...stubDeck(), storageGet: {} }],
    ];
    const waved = wrongShapes.filter(([, h]) => threw(h) === null).map(([why]) => why);
    ok('assertHost-refuses-a-duty-that-is-present-but-NOT-CALLABLE, in every shape a wrong one arrives in',
      wrongShapes.length === 4 && waved.length === 0,
      waved.length ? `ACCEPTED: ${waved.join('; ')}` : `refused all ${wrongShapes.length}, each short exactly one callable of ${deckDuties.length}`);

    /**
     * THE S4 DECISION, ASSERTED RATHER THAN ASSUMED. `shared/host.js` gave the
     * slice two ways to carry storage across the seam: three FLAT callable
     * duties, or one `storage` namespace with `assertHost` widened to accept it
     * and the widening asserted. The flat branch was taken, and the whole reason
     * to prefer it was that `typeof host[k] === 'function'` stays exactly as
     * strong as it was.
     *
     * So the namespace shape must be REFUSED, and refused by name.
     *
     * WHAT ACTUALLY TURNS THIS LINE RED, stated because the first version of the
     * PR body claimed the wrong mutation for it and review caught that:
     *
     *   - `assertHost` widened to MAP the namespace — `typeof host[k] !==
     *     'function' && !(host.storage && /^(storageGet|storageSet|
     *     onStorageChanged)$/.test(k))`, which is the accidental widening a
     *     namespace migration actually arrives as. Watched: 1 red, this one,
     *     `… was ACCEPTED — the boot check has been widened without an
     *     assertion saying so`.
     *   - The DUTY-LIST half — `DECK_HOST_DUTIES` declaring a `storage` entry in
     *     place of the three flat duties. Watched: the shipped `ui/host.js` is
     *     then short a duty and the group dies at `assertHost` before reaching
     *     this line, which is a louder red than this one and not a substitute
     *     for it.
     *
     * WHAT DOES NOT REACH IT: widening the CALLABILITY test alone, e.g. to
     * `host[k] == null`. That is caught by the two not-callable checks above and
     * NOT here, because the three flat duties are `undefined` in this fixture and
     * `undefined == null` is still missing. Two halves, two assertions; neither
     * stands in for the other, and saying otherwise is reported coverage sitting
     * one assertion away from where it is claimed.
     */
    const nsShaped = threw({
      ...stubDeck(), storageGet: undefined, storageSet: undefined, onStorageChanged: undefined,
      storage: { get() {}, set() {}, onChanged() {} },
    });
    ok('assertHost-refuses-a-STORAGE-NAMESPACE and names the three flat duties it wanted instead',
      nsShaped !== null && /storageGet/.test(nsShaped.message)
      && /storageSet/.test(nsShaped.message) && /onStorageChanged/.test(nsShaped.message),
      nsShaped ? nsShaped.message : '`{ storage: { get, set, onChanged } }` was ACCEPTED — the boot check has been widened without an assertion saying so');

    /**
     * "An assertion must FAIL when it cannot look" (AGENTS.md). A boot check
     * that excused itself when there was no host at all would report the seam
     * intact on precisely the run where nothing was wired.
     *
     * IT IS NOT ENOUGH THAT SOMETHING THREW, which is all this could see before
     * the merge — and review proved it by deleting the absent-host guard and
     * watching the group stay green. Without the guard `assertHost(null, …)`
     * still throws, as `Cannot read properties of null (reading 'send')`: no
     * seam named, no duty named, no file to look in. That sentence is the whole
     * reason the check is at boot rather than at first call, so the assertion
     * reads the sentence rather than the fact of a throw.
     */
    const namesTheSeam = (h) => {
      const e = threw(h);
      return e !== null && /DeckHost/.test(e.message)
        && deckDuties.every((k) => new RegExp(`\\b${k}\\b`).test(e.message));
    };
    const noHost = threw(undefined);
    ok('assertHost-with-no-Host-AT-ALL-throws rather than passing vacuously, and the error still names the seam and every duty it owed',
      namesTheSeam(undefined) && namesTheSeam(null),
      noHost === null ? 'assertHost(undefined) returned without throwing' : noHost.message);
  }

  // ------------------------------------------------------- the outgoing wire
  /**
   * THE LATE-BINDING RULE, ASSERTED WITHOUT A BROWSER — `shared/host.js` rule 2.
   *
   * `tools/embed-smoke.mjs` observes the deck's whole outgoing wire by replacing
   * the PROPERTY `chrome.runtime.sendMessage` after the deck has booted. A Host
   * that captured the function at import time — `bind`, or a module-scope
   * `const send = chrome.runtime.sendMessage` — leaves that recorder empty, and
   * `[].every()` and `![].some()` are both true, so the transpose-ceiling and
   * speed/ad-gate assertions report GREEN while inspecting nothing. That is a
   * failure this repo has already paid for once, and CI cannot see the browser
   * gate. So it is re-asserted here, against the same shipped module, by doing
   * the same thing the smoke gate does: patch the property, and count.
   */
  {
    const before = [], after = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: (m) => { before.push(m); return Promise.resolve(); },
        onMessage: { addListener() {} },
      },
    };
    deckHost.send({ v: 1, to: 'off', from: 'ui', type: 'STATUS' });
    // exactly what tools/embed-smoke.mjs does, after boot, to the property
    chrome.runtime.sendMessage = (m) => { after.push(m); return Promise.resolve(); };
    deckHost.send({ v: 1, to: 'off', from: 'ui', type: 'PITCH', deck: 'A', semitones: 2 });

    ok('send-resolves-the-transport-at-CALL-time: a property swapped after boot receives the next message',
      before.length === 1 && after.length === 1 && after[0].type === 'PITCH',
      `${before.length} before the swap, ${after.length} after — a bound transport gives 2 and 0`);

    /**
     * THE ENVELOPE IS THE UNIT'S — `shared/host.js` rule 1. The host may not add
     * a field, rename one, or drop one: `tools/embed-smoke.mjs` injects a raw
     * `{v:1,to:'ui',from:'off',type:'LIVE_STATE',…}` from the service worker on
     * the strength of that, and a re-wrapping host breaks it with no symptom,
     * because a `LIVE_STATE` that never arrives leaves the last one on screen.
     */
    // `|| null` and not `|| {}`: an unrecorded message is this assertion's own
    // failure, not an excuse from it, and a bare `after[0]` would throw and take
    // the rest of the group with it instead of going red on its own line.
    const got = after[0] || null;
    ok('send-carries-the-envelope-VERBATIM: no field added, renamed or dropped',
      got !== null && Object.keys(got).sort().join(',') === 'deck,from,semitones,to,type,v'
      && got.v === 1 && got.to === 'off' && got.from === 'ui' && got.deck === 'A' && got.semitones === 2,
      got ? Object.keys(got).sort().join(',') : 'nothing reached the transport at all');

    ok('send-returns-nothing, so no call site can start awaiting delivery',
      deckHost.send({ v: 1, to: 'sw', from: 'ui', type: 'SW_STATUS' }) === undefined);
  }

  /**
   * DELIVERY FAILURE IS THE HOST'S TO SWALLOW — `shared/host.js` rule 3. There
   * is very often no listener on this bus, and the deck sends on a 10 Hz
   * heartbeat; one unhandled rejection per message is a console nobody can read.
   */
  {
    let unhandled = 0;
    const count = () => { unhandled++; };
    process.on('unhandledRejection', count);

    // INSTRUMENT CHECK. `unhandled === 0` below is worth nothing unless this
    // counter can move at all — an unwired handler and a swallowed rejection
    // look identical from the assertion's side.
    Promise.reject(new Error('control: this one is deliberately not caught'));
    await new Promise((r) => setTimeout(r, 20));
    ok('INSTRUMENT CHECK: an uncaught rejection in this harness IS counted',
      unhandled === 1, `${unhandled} counted`);

    unhandled = 0;
    globalThis.chrome = {
      runtime: {
        sendMessage: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
        onMessage: { addListener() {} },
      },
    };
    deckHost.send({ v: 1, to: 'off', from: 'ui', type: 'STATUS' });
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', count);
    ok('send-swallows-a-delivery-failure: a message nobody is listening for is not an error',
      unhandled === 0, `${unhandled} unhandled rejections from one undeliverable message`);
  }

  // ------------------------------------------------------- the incoming wire
  /**
   * THE ADDRESS FILTER AND THE RESPONSE CHANNEL ARE THE HOST'S — rule 4. Both
   * are facts about the transport: `chrome.runtime.sendMessage` is a BROADCAST,
   * so every context hears every message, and MV3 reads a truthy return from a
   * listener as "I will call `sendResponse` later" and holds the channel open
   * for it. Neither belongs in a deck that has to run somewhere else too.
   */
  {
    const listeners = [];
    globalThis.chrome = {
      runtime: {
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (f) => listeners.push(f) },
      },
    };
    const seen = [];
    deckHost.onMessage((m) => { seen.push(m); return true; });

    // INSTRUMENT CHECK: everything below reads `listeners[0]`, so an onMessage
    // that registered nothing would leave every one of them inspecting a stub
    // of this file's own making.
    ok('INSTRUMENT CHECK: onMessage registered exactly one listener on the bus',
      listeners.length === 1, `${listeners.length} registered`);

    const mine = { v: 1, to: 'ui', from: 'off', type: 'LIVE_STATE', status: 'running', latencySec: 1.5 };
    const rets = [
      listeners[0]({ v: 1, to: 'sw', from: 'ui', type: 'SW_STATUS' }),
      listeners[0]({ v: 1, to: 'off', from: 'ui', type: 'STATUS' }),
      listeners[0]({ v: 1, to: 'tab', from: 'sw', type: 'STEM_SPLITTER_LIVE_EMBED' }),
      listeners[0](null),
      listeners[0](mine),
    ];

    ok('onMessage-delivers-only-what-is-addressed-here: 1 of 5 on a broadcast bus',
      seen.length === 1 && seen[0].type === 'LIVE_STATE',
      `${seen.length} delivered of 5 (to: sw, off, tab, null, ui)`);

    ok('onMessage-hands-the-deck-the-SAME-message, envelope and all',
      seen.length === 1 && seen[0] === mine && seen[0].v === 1 && seen[0].from === 'off'
      && seen[0].latencySec === 1.5);

    /**
     * The handler above returns `true` on purpose: the control has to be able to
     * lose. If the host forwarded what the deck returned, this would read `true`
     * for the one message it delivered, and Chrome would hold a response channel
     * open for every `LIVE_STATE` at 10 Hz.
     */
    ok('onMessage-never-holds-the-response-channel-open, not even for a handler that returns true',
      rets.length === 5 && rets.every((r) => r === false),
      rets.map((r) => String(r)).join(' '));
  }

  // ------------------------------------------------------------- storage
  /**
   * THE AREA IS THE WHOLE POINT — `shared/host.js` rule 5. `local` outlives the
   * browser and `session` does not, and the deck uses one of each on purpose: a
   * preference must survive a restart, and a refusal to arm must not, because a
   * stale refusal painted as current teaches the user to ignore the banner.
   *
   * A Host that took the area and then ignored it is invisible to any check that
   * uses one area, so the stub below holds the SAME KEY in BOTH areas with
   * DIFFERENT values. That is the one arrangement in which "it read the area it
   * was given" and "it always reads local" give different answers.
   */
  {
    const store = { local: {}, session: {} };
    const writes = [];
    let unreadable = null;
    const areaApi = (name) => ({
      get(key) {
        if (unreadable === name) return Promise.reject(new Error(`${name} could not be read`));
        return Promise.resolve(Object.prototype.hasOwnProperty.call(store[name], key) ? { [key]: store[name][key] } : {});
      },
      set(obj) { writes.push({ area: name, obj }); Object.assign(store[name], obj); return Promise.resolve(); },
    });
    const feedListeners = [];
    globalThis.chrome = {
      storage: {
        local: areaApi('local'),
        session: areaApi('session'),
        onChanged: { addListener: (f) => feedListeners.push(f) },
      },
    };

    store.local.prefs = { autoplayNext: true };
    store.session.prefs = { autoplayNext: false };
    const fromLocal = await deckHost.storageGet('local', 'prefs');
    const fromSession = await deckHost.storageGet('session', 'prefs');
    ok('storageGet-READS-THE-AREA-IT-WAS-GIVEN: one key held in both areas comes back as the two different values  '
      + '[entry point: extension/ui/host.js storageGet(), reached from embed.js for local/prefs and session/armError]',
      fromLocal !== null && fromSession !== null
      && fromLocal.autoplayNext === true && fromSession.autoplayNext === false,
      `local ${JSON.stringify(fromLocal)}, session ${JSON.stringify(fromSession)} — a host that hard-coded one area returns the same object twice`);

    ok('storageGet-UNWRAPS-THE-BAG: the deck is handed the VALUE, never the platform\'s `{ [key]: value }` envelope',
      fromLocal !== null && typeof fromLocal === 'object' && !('prefs' in fromLocal),
      JSON.stringify(fromLocal));

    const absent = await deckHost.storageGet('local', 'nothing-was-ever-stored-here');
    ok('storageGet-answers-NULL-for-a-key-that-is-not-there, which is a fresh profile and not a fault',
      absent === null, String(absent));

    /**
     * ABSENT AND UNREADABLE ARE NOT THE SAME ANSWER — rule 6. Folding them
     * together is `!x || (real check)` one layer out: the deck would apply its
     * defaults most confidently on the run where storage could not be read at
     * all, and a preference silently reset is indistinguishable from one chosen.
     *
     * THE CONTROL IS THE LINE ABOVE: the same call, on the same area, resolved
     * `null` a moment ago. So a rejection here is the failure being reported,
     * and not this stub being broken.
     */
    unreadable = 'local';
    let rejected = null;
    try { await deckHost.storageGet('local', 'prefs'); } catch (e) { rejected = e; }
    unreadable = null;
    ok('storageGet-REJECTS-a-read-that-FAILED rather than reporting it as a key that was not there',
      rejected instanceof Error && /could not be read/.test(rejected.message),
      rejected ? rejected.message : 'it resolved — the deck cannot tell "no preferences" from "no storage"');

    /**
     * A BAD AREA IS A REJECTION, NOT A SYNCHRONOUS THROW. `chrome.storage.nope`
     * is undefined and `.get` on it throws at once; the deck's prefs read is a
     * bare `.then(...).catch(...)` at module scope, and a synchronous throw is
     * not caught by that `.catch` — it takes the rest of the deck's boot with
     * it. `async` on the method is what turns it into the rejection the call
     * site is already written to survive.
     */
    let badArea = null;
    try {
      await deckHost.storageGet('nope', 'prefs').catch((e) => { badArea = e; });
    } catch (e) { badArea = 'THREW SYNCHRONOUSLY'; }
    ok('storageGet-on-an-area-that-does-not-exist-REJECTS, so the deck\'s module-scope `.catch` can still catch it',
      badArea instanceof Error,
      badArea === 'THREW SYNCHRONOUSLY'
        ? 'it threw synchronously — the boot `.catch` never sees it and the rest of the deck never runs'
        : String(badArea && badArea.message));

    /**
     * P1, HELD AS A REFUSAL RATHER THAN AS A CONVENTION — and the review that
     * asked for this named the exact hazard: `chrome.storage[area]` is an
     * unvalidated index into the WHOLE namespace, so making the area a parameter
     * turned `sync` — a NETWORK WRITE, which CONTRIBUTING.md P1 forbids after
     * the model download and SECURITY.md promotes to a security property — from
     * structurally unreachable into a one-token typo. Before the parameter every
     * call site read `chrome.storage.local` literally and there was nothing to
     * get wrong.
     *
     * THE CONTROL CAN LOSE, WHICH IS THE POINT OF THE FIXTURE: `chrome.storage`
     * here really does carry a working `sync` area that records what it is
     * handed. Drop the guard and the read resolves, the write LANDS IN
     * `syncWrites`, and the listener registers — so this is not "an area that
     * happens not to exist", which is the version of this test that would pass
     * on `undefined.get` throwing and prove nothing about the policy.
     *
     * ALL THREE DUTIES, because the guard is per-duty and "right at one call
     * site, wrong at another" is the defect AGENTS.md counts five of here.
     */
    {
      const syncWrites = [];
      const syncListeners = [];
      const platform = globalThis.chrome.storage;
      globalThis.chrome.storage = {
        local: platform.local,
        session: platform.session,
        onChanged: { addListener: (f) => syncListeners.push(f) },
        sync: {
          get: () => Promise.resolve({ prefs: { autoplayNext: 'FROM THE NETWORK' } }),
          set: (o) => { syncWrites.push(o); return Promise.resolve(); },
        },
      };
      let getThrewSync = false;
      let getSettled = 'never settled';
      try {
        await deckHost.storageGet('sync', 'prefs')
          .then((v) => { getSettled = `RESOLVED ${JSON.stringify(v)}`; }, (e) => { getSettled = e; });
      } catch (e) { getThrewSync = true; getSettled = e; }
      let setOutcome = 'RETURNED';
      try { deckHost.storageSet('sync', 'prefs', { autoplayNext: true }); } catch (e) { setOutcome = e; }
      let feedOutcome = 'RETURNED';
      try { deckHost.onStorageChanged('sync', 'prefs', () => {}); } catch (e) { feedOutcome = e; }
      globalThis.chrome.storage = platform;

      const refused = [getSettled, setOutcome, feedOutcome].filter((o) => o instanceof Error).length;
      ok('NO DUTY WILL TOUCH AN AREA THE UNIT NEVER NAMED: all three refuse `sync`, and nothing reached it  '
        + '[entry point: extension/ui/host.js storageGet/storageSet/onStorageChanged, called with an area no call site spells]',
        refused === 3 && syncWrites.length === 0 && syncListeners.length === 0,
        `${refused} of 3 refused; ${syncWrites.length} write(s) reached sync${syncWrites.length ? ` (${JSON.stringify(syncWrites)})` : ''}`
        + `, ${syncListeners.length} listener(s) registered — sync is a NETWORK write and P1 forbids the network here`);

      /**
       * AND EACH REFUSES IN THE SHAPE ITS OWN CALL SITE CAN SURVIVE, which is
       * the asymmetry review asked to have declared instead of inherited.
       * `storageGet` is `async` so its refusal arrives as a rejection — the
       * deck's preferences read is a module-scope `.then(…).catch(…)` that a
       * synchronous throw jumps straight past, taking the rest of boot with it,
       * and one duty must not answer two ways at its two call sites. The other
       * two throw where they were called, which is the cheapest place to be told
       * that the deck asked for a lifetime it has no word for.
       */
      ok('...and each refuses in the shape its call site can survive: storageGet REJECTS, the write and the feed THROW where they were called',
        !getThrewSync && getSettled instanceof Error
        && setOutcome instanceof Error && feedOutcome instanceof Error,
        getThrewSync
          ? 'storageGet threw SYNCHRONOUSLY — the deck\'s boot `.catch` never sees it'
          : `get ${getSettled instanceof Error ? 'rejected' : String(getSettled)}`
            + `, set ${setOutcome instanceof Error ? 'threw' : String(setOutcome)}`
            + `, onChanged ${feedOutcome instanceof Error ? 'threw' : String(feedOutcome)}`);
    }

    // ---- writes
    const ret = deckHost.storageSet('session', 'armError', { code: 'TAB_BUSY' });
    ok('storageSet-WRITES-TO-THE-AREA-IT-WAS-GIVEN and returns nothing, so no call site can start awaiting a preference  '
      + '[entry point: extension/ui/host.js storageSet(), reached from embed.js writePrefs()]',
      ret === undefined && writes.length === 1 && writes[0].area === 'session'
      && JSON.stringify(writes[0].obj) === '{"armError":{"code":"TAB_BUSY"}}',
      `returned ${String(ret)}; ${writes.length} write(s): ${writes.map((w) => `${w.area} ${JSON.stringify(w.obj)}`).join(' | ')}`);

    /**
     * DELIVERY FAILURE IS THE HOST'S TO SWALLOW here too, and for a sharper
     * reason than on `send`: this one runs from a checkbox handler, where the
     * value being written is already the value on screen. There is nothing a
     * rejected write could tell the user that the next read would not tell them
     * better — and an unhandled rejection is a console nobody can read.
     */
    {
      let unhandled = 0;
      const count = () => { unhandled++; };
      process.on('unhandledRejection', count);
      Promise.reject(new Error('control: this one is deliberately not caught'));
      await new Promise((r) => setTimeout(r, 20));
      const instrument = unhandled;
      unhandled = 0;
      globalThis.chrome.storage.local = { set: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')) };
      deckHost.storageSet('local', 'prefs', { autoplayNext: true });
      await new Promise((r) => setTimeout(r, 20));
      process.off('unhandledRejection', count);
      globalThis.chrome.storage.local = areaApi('local');
      ok('storageSet-swallows-a-failed-write — and the INSTRUMENT that would have counted it was live',
        instrument === 1 && unhandled === 0,
        `${instrument} counted for the deliberate control, ${unhandled} from the rejected write`);
    }

    // ---- the change feed
    /**
     * INSTRUMENT CHECK FIRST: everything below drives `feedListeners[0]`, so an
     * `onStorageChanged` that registered nothing would leave each of them
     * inspecting a stub of this file's own making.
     */
    const seen = [];
    deckHost.onStorageChanged('local', 'prefs', (v) => seen.push(v));
    ok('INSTRUMENT CHECK: onStorageChanged registered exactly one listener on the platform feed',
      feedListeners.length === 1, `${feedListeners.length} registered`);

    const feed = feedListeners[0];
    if (feed) {
      feed({ prefs: { newValue: { autoplayNext: true } } }, 'local');       // mine
      feed({ instrument: { newValue: 'x' } }, 'local');                     // my area, another key
      feed({ prefs: { newValue: { autoplayNext: false } } }, 'session');    // my key, another area
      feed({ prefs: { oldValue: { autoplayNext: true } } }, 'local');       // mine, REMOVED
    }
    ok('onStorageChanged-delivers-only-MY-key-in-MY-area: 2 of 4 on a feed that carries every key of every area  '
      + '[entry point: extension/ui/host.js onStorageChanged(), reached from embed.js boot for local/prefs]',
      seen.length === 2 && seen[0] !== undefined && seen[0].autoplayNext === true,
      `${seen.length} delivered of 4 (mine; my area other key; my key other area; mine removed)`);
    /**
     * A REMOVAL IS `undefined`, NOT A DROPPED EVENT. The platform reports a
     * deleted key as a change record with an `oldValue` and no `newValue`, and
     * the deck's `applyPrefs(undefined)` is exactly "nothing is stored", which
     * is the right reading. A host that filtered on `newValue` being present
     * would leave the checkbox showing a preference that no longer exists.
     */
    ok('...and a REMOVAL arrives as undefined rather than being filtered out, which is what "the record is gone" means',
      seen.length === 2 && seen[1] === undefined,
      seen.map((v) => (v === undefined ? 'undefined' : JSON.stringify(v))).join(' then '));
  }

  // -------------------------------------------------------- the arm chord
  /**
   * RAW, NOT RENDERED — rule 7. The Host reads the binding and the unit spells
   * it: `chordLabel()` in `ui/embed-state.js` is where DRAWN and ANNOUNCED are
   * decided, it is gated without a browser, and it has already been wrong once
   * in a way a per-Host copy would have reproduced per Host.
   *
   * THE STUB RETURNS A GLYPH FORM ON PURPOSE. Chrome hands macOS back `⌃⇧9`
   * already drawn, so a Host that "helpfully" normalised what it found would be
   * doing it to a string that is already the answer.
   */
  {
    let table = [];
    globalThis.chrome = { commands: { getAll: () => Promise.resolve(table) } };

    table = [{ name: 'not-the-one', shortcut: 'Ctrl+K' }, { name: 'arm-tab', shortcut: '⌃⇧9' }];
    const bound = await deckHost.armShortcut();
    ok('armShortcut-returns-the-ACCELERATOR-VERBATIM, for `arm-tab` and not for whichever command came first  '
      + '[entry point: extension/ui/host.js armShortcut(), reached from embed.js boot]',
      bound === '⌃⇧9', JSON.stringify(bound));

    table = [{ name: 'arm-tab', shortcut: '' }];
    const unbound = await deckHost.armShortcut();
    ok('armShortcut-answers-NULL-for-a-command-with-no-chord-bound, so the deck prints a sentence instead of an empty key cap',
      unbound === null, JSON.stringify(unbound));

    table = [{ name: 'not-the-one', shortcut: 'Ctrl+K' }];
    const missing = await deckHost.armShortcut();
    ok('...and NULL again when there is no such command at all, rather than the first chord it could find',
      missing === null, JSON.stringify(missing));
  }

  // ------------------------------------------------- the deck's call sites
  /**
   * THE SAME TWO CLAIMS THE ENGINE HALF MAKES, and for the same reason: every
   * refusal above drives `assertHost` and the shipped Host directly, which
   * proves nothing whatever about `ui/embed.js` reaching for them. The engine's
   * version of this caught a real gap — a deleted module-scope call left the
   * whole tree green while two assertions went on naming it as their entry
   * point.
   *
   * `embed.js` CANNOT BE IMPORTED FROM NODE — it touches `document` at module
   * scope — so it is read as text with comments stripped, exactly as `engine.js`
   * is. A claim a doc comment can satisfy is not a claim.
   */
  {
    const { readFileSync } = await import('node:fs');
    const stripSrc = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const deckSrc = stripSrc(readFileSync(new URL('./extension/ui/embed.js', import.meta.url), 'utf8'));
    const hostSrc = stripSrc(readFileSync(new URL('./extension/ui/host.js', import.meta.url), 'utf8'));

    const reached = [...new Set([...deckSrc.matchAll(/\bhost\.(\w+)\s*\(/g)].map((m) => m[1]))].sort();
    const undeclared = reached.filter((k) => !deckDuties.includes(k));
    ok('EVERY HOST DUTY THE DECK REACHES FOR IS DECLARED  '
      + '[entry point: extension/ui/embed.js, comments stripped]',
      reached.length > 0 && undeclared.length === 0,
      reached.length === 0
        ? 'the deck calls no host duty at all — either the seam is gone or this scan cannot see it'
        : undeclared.length
          ? `undeclared: ${undeclared.map((k) => `host.${k}()`).join(', ')} — declare it in DECK_HOST_DUTIES or a Host will pass assertHost and still throw`
          : `${reached.length} reached: ${reached.join(', ')}`);

    const unreached = deckDuties.filter((k) => !reached.includes(k));
    ok('...and every declared duty is actually reached for, so a second Host implements nothing dead',
      reached.length > 0 && unreached.length === 0,
      unreached.length ? `declared but never called: ${unreached.join(', ')}` : `all ${deckDuties.length}`);

    /**
     * WHAT S3 AND S4 TOGETHER WERE FOR, put as the one fact that is either true
     * or not: with the storage duties landed there is no executable `chrome.`
     * left in the deck at all. Four prose mentions remain, which is why the
     * comments come off first.
     *
     * THE CONTROL IS THE DECK'S OWN HOST, AND IT CAN LOSE. `ui/host.js` is the
     * module that is SUPPOSED to name the platform; a broken stripper, a wrong
     * path or a regex that simply never matches would read zero on both halves
     * and this would pass on nothing at all. Requiring the Host to be non-zero
     * is what stops that.
     *
     * S9 gates this over the whole declared unit. This is the deck's half of it,
     * asserted in the slice that finished it, so a `chrome.` reached for again
     * in `embed.js` is caught by `--quick` rather than by a manifest that does
     * not exist yet.
     */
    const inDeck = (deckSrc.match(/\bchrome\./g) || []).length;
    const inHost = (hostSrc.match(/\bchrome\./g) || []).length;
    ok('THE DECK NAMES NO PLATFORM: zero executable `chrome.` in extension/ui/embed.js, while the Host it imports is made of them  '
      + '[entry point: extension/ui/embed.js and extension/ui/host.js, comments stripped]',
      inDeck === 0 && inHost > 0,
      `${inDeck} in embed.js, ${inHost} in host.js${inHost === 0 ? ' — THE CONTROL CANNOT LOSE, so this assertion is reading nothing' : ''}`);

    /**
     * WHICH LIFETIME EACH CALL SITE ASKED FOR, PINNED — the half of the storage
     * seam that nothing else can see.
     *
     * `test.js` proves the Host HONOURS whatever area it is handed (the
     * same-key-in-both-areas fixture above is the arrangement that catches a
     * Host that ignored it). The browser proves the WRITE lands somewhere the
     * content script reads. Nothing proved the deck hands over the right area at
     * the two sites where it is only READ — and review flipped each of them to
     * `'session'` on its own and watched the whole tree stay green.
     *
     * BOTH FAILURE MODES ARE SILENT, WHICH IS WHY THEY ARE WORTH FOUR LINES. A
     * boot read on `'session'` means preferences never survive a browser
     * restart: the defaults are re-applied every morning and nothing anywhere
     * says so. A change feed on `'session'` means a second deck's change never
     * arrives. Neither is a crash, neither is visible in one sitting, and both
     * are one token.
     *
     * THE PAIRS, NOT A COUNT — because "four storage call sites" is satisfied by
     * four wrong ones. A slice that adds a fifth is meant to fail here: the area
     * is a lifetime decision (`shared/host.js` rule 5) and this is where the
     * decision gets written down.
     */
    const storageSites = [...deckSrc.matchAll(/\bhost\.(storageGet|storageSet|onStorageChanged)\(\s*'([a-z]+)'\s*,\s*(\w+)/g)]
      .map((m) => `${m[1]}('${m[2]}', ${m[3]})`).sort();
    const WANT_SITES = [
      "onStorageChanged('local', PREFS_KEY)",
      "storageGet('local', PREFS_KEY)",
      "storageGet('session', ARM_ERROR_KEY)",
      "storageSet('local', PREFS_KEY)",
    ];
    ok('EVERY STORAGE CALL SITE SPELLS ITS OWN LIFETIME, and these are the four  '
      + '[entry point: extension/ui/embed.js, comments stripped — boot read, change feed, writePrefs(), and the durable arm refusal]',
      storageSites.length === WANT_SITES.length
      && storageSites.every((v, i) => v === WANT_SITES[i]),
      storageSites.length === 0
        ? 'the deck reaches storage through no literal area at all — either the seam moved or this scan cannot see it'
        : `got ${storageSites.join(' | ')}${storageSites.join() === WANT_SITES.join() ? '' : ` — want ${WANT_SITES.join(' | ')}`}`);

    /**
     * THE CHORD IS READ FROM THE PLATFORM — CI'S HALF OF A CLAIM THE BROWSER
     * OWNS.
     *
     * `tools/embed-smoke.mjs` proves this properly: it replaces the deck frame's
     * command table with a chord no manifest here declares and watches the deck
     * draw THAT. Nothing in `--quick` can do that, and `--quick` is all
     * `.github/workflows/verify.yml` runs — so a deck that typed a chord, or
     * that called `host.armShortcut()` and discarded the answer, would reach a
     * green badge on every pull request and be caught only by a gate someone
     * remembered to run locally. That is the same gap `e352b49` had to leave an
     * `embed-state` assertion behind for, and the same one the `chrome.` control
     * above exists to close.
     *
     * TWO SHAPES, BECAUSE THE TWO MUTATIONS REVIEW FOUND ARE DIFFERENT MISTAKES.
     * One types the chord; the other calls the Host and throws the answer away.
     * The first is caught by the literal ban below, the second by the thread
     * here — and a third, `chordLabel(SOME_IMPORTED_DEFAULT, MAC)`, is caught by
     * the thread alone, which is why the thread is not redundant.
     *
     * IT IS DELIBERATELY SHAPE-BOUND: it wants the resolved accelerator threaded
     * straight into `chordLabel()` on one line. A refactor that spells the boot
     * site differently should UPDATE this line rather than delete the claim; the
     * browser gate is what says whether the claim still holds.
     */
    const armLine = (deckSrc.match(/^.*\bhost\.armShortcut\(\).*$/m) || [''])[0];
    const armThread = /\(\s*(\w+)\s*\)\s*=>[\s\S]*?\bchordLabel\(\s*(\w+)\b/.exec(armLine);
    ok('THE CHORD THE DECK SPELLS IS THE ONE armShortcut() RESOLVED, threaded and not re-derived  '
      + '[entry point: extension/ui/embed.js boot, comments stripped — the browser half is in tools/embed-smoke.mjs]',
      !!armThread && armThread[1] === armThread[2],
      armLine === ''
        ? 'the deck never calls host.armShortcut() at all — either the seam moved or this scan cannot see it'
        : armThread
          ? `armShortcut() resolves \`${armThread[1]}\` and chordLabel() is handed \`${armThread[2]}\``
          : `no \`(accel) => … chordLabel(accel…)\` on the boot line: ${armLine.trim()}`);

    /**
     * AND NO ACCELERATOR IS TYPED INTO THE DECK AT ALL. A complete accelerator
     * is a modifier token followed by `+`, or an Apple glyph — `'Ctrl+Shift+9'`,
     * `'MacCtrl+Shift+9'`, `'⌃⇧9'`. The deck's own keyboard table lives in
     * `embed.html` and is spelled with `data-mod` attributes rather than
     * accelerators, so this scan is `embed.js`'s alone and reads ZERO today.
     * FLOOR: `armLine` again, so this cannot pass on a file the scan could not
     * read or on a deck that stopped asking for the chord.
     */
    const ACCEL_LITERAL = /(['"`])[^'"`\n]*(?:MacCtrl|Ctrl|Command|Alt|Shift)\s*\+[^'"`\n]*\1|(['"`])[^'"`\n]*[⌃⌘⌥⇧][^'"`\n]*\2/g;
    const typedChords = (deckSrc.match(ACCEL_LITERAL) || []);
    ok('...and no accelerator is TYPED into the deck, so the only chord it can draw is the one it was handed',
      typedChords.length === 0 && armLine !== '',
      typedChords.length
        ? `${typedChords.length} accelerator literal(s) in embed.js: ${typedChords.join(', ')}`
        : 'zero accelerator literals in embed.js');
  }

  delete globalThis.chrome;

  head('host — S2: the audio graph asks the Host for every asset URL it needs');
  /**
   * WHAT THIS COVERS, AND WHY IT IS NOT ALREADY COVERED BY THE BLOCK ABOVE.
   *
   * `assetUrl` was a declared duty before this slice and `offscreen/engine.js`
   * called it — once, for the capture worklet. The unit's other five asset URLs
   * did not go through the seam at all: the master meter worklet (`master.js`),
   * the playback worklet twice over (`live.js` and `cacheddeck.js`, once per
   * kind of deck), and the ORT runtime directory plus its presence probe
   * (`deck.js`) each called `chrome.runtime.getURL` themselves. A second Host
   * could therefore implement all five duties perfectly and still not load a
   * single worklet — and neither `assertHost` nor the interface-drift pair above
   * can see that, because both only ever look at `engine.js`.
   *
   * REACHABLE, NOT CONSTRUCTED — and the fact that it CAN be reachable is itself
   * the result this slice is after. All four files now import and run under Node
   * with no `chrome` global in existence, so every claim below drives the
   * shipped graph builder and reads back what it asked the Host for. The same
   * code before this slice threw `chrome is not defined` on the first line of
   * each of the five sites.
   *
   * WHAT IS STUBBED IS THE PLATFORM, NEVER THE GRAPH. `addModule` records the
   * URL it is handed and resolves; construction then dies at the first real Web
   * Audio node, which Node does not have. That is deliberate rather than
   * tolerated: the claim is about what the builder asked the Host for, and
   * everything after `addModule` is the browser gate's job
   * (`tools/embed-smoke.mjs`).
   *
   * THE RESOLVER IS A STUB WITH A SCHEME NOTHING ELSE USES (`stub://unit/`), so
   * a URL that reached `addModule` by any other route — a surviving literal, a
   * second copy of the path — cannot be mistaken for one that came from the Host.
   */
  {
    const asked = [];
    const assetUrl = (relPath) => { asked.push(relPath); return `stub://unit/${relPath}`; };
    /** a fake AudioContext that can do exactly one thing: record an addModule */
    const fakeCtx = () => {
      const added = [];
      return { added, sampleRate: SR, audioWorklet: { addModule: async (url) => { added.push(url); } } };
    };
    /** run a builder to the point where Node runs out of Web Audio, and keep the reason */
    const drive = (p) => p.then(() => null, (e) => String((e && e.message) || e));

    // ------------------------------------------------------------ master bus
    const { MasterBus } = await import('./extension/offscreen/master.js');
    let noResolver = null;
    try { new MasterBus(null); } catch (e) { noResolver = String((e && e.message) || e); }
    ok("THE MASTER BUS REFUSES TO BE CONSTRUCTED WITHOUT THE HOST'S RESOLVER  "
      + '[entry point: extension/offscreen/master.js constructor — its one construction is '
      + '`new MasterBus(null, host.assetUrl)` at engine.js module scope]',
      noResolver != null && noResolver.includes('assetUrl'),
      noResolver == null
        ? 'new MasterBus(null) was ACCEPTED. A short HOST is not what this catches — assertHost() already refuses '
          + 'one, a few lines earlier in engine.js. What is left is the WIRING: an engine.js that reverts to a late '
          + 'setter or drops the argument, after which a bus with no resolver says nothing at boot and throws inside '
          + '_build(), at the first arm, with a deck already half-wired'
        : noResolver);

    const busCtx = fakeCtx();
    const bus = new MasterBus(null, assetUrl);
    // exactly what engine.js does at ensureContext(): the context arrives late,
    // the resolver did not.
    bus.ctx = busCtx;
    const busWhy = await drive(bus.build());
    ok('THE MASTER METER WORKLET IS RESOLVED THROUGH THE HOST  '
      + '[entry point: extension/offscreen/master.js _build(), the only addModule in the file]',
      busCtx.added.length === 1 && busCtx.added[0] === 'stub://unit/offscreen/master-meter-processor.js',
      busCtx.added.length === 0
        ? `_build() never reached addModule, so this inspected nothing: ${busWhy}`
        : busCtx.added.join(', '));

    // ---------------------------------------------------------- the live deck
    const { LivePipeline } = await import('./extension/offscreen/live.js');
    const liveCtx = fakeCtx();
    const lp = new LivePipeline({
      deck: 'A', ctx: () => liveCtx, master: () => null, ring: () => null,
      infer: async () => ({}), ensureModel: async () => {}, send: () => {}, log: () => {},
      assetUrl,
    });
    const liveWhy = await drive(lp.build());
    ok('THE LIVE DECK RESOLVES ITS PLAYBACK WORKLET THROUGH THE HOST  '
      + '[entry point: extension/offscreen/live.js LivePipeline.build(), reached from start()]',
      liveCtx.added.length === 1 && liveCtx.added[0] === 'stub://unit/offscreen/playback-processor.js',
      liveCtx.added.length === 0
        ? `build() never reached addModule, so this inspected nothing: ${liveWhy}`
        : liveCtx.added.join(', '));

    // -------------------------------------------------------- the cached deck
    // A CONTEXT OF ITS OWN. The two kinds of deck register the same processor
    // name, and whether one registration is allowed to stand in for the other is
    // a separate claim with its own block below; here they must not share, or
    // this assertion would pass on the live deck's work.
    const cachedCtx = fakeCtx();
    const cd = new CachedDeck('A', {
      ctx: () => cachedCtx, master: () => null, send: () => {}, log: () => {}, assetUrl,
    });
    const cachedWhy = await drive(cd.ensureGraph());
    ok('...AND SO DOES THE CACHED DECK, which registers the same worklet by a different path  '
      + '[entry point: extension/offscreen/cacheddeck.js CachedDeck.ensureGraph(), reached from load()]',
      cachedCtx.added.length === 1 && cachedCtx.added[0] === 'stub://unit/offscreen/playback-processor.js',
      cachedCtx.added.length === 0
        ? `ensureGraph() never reached addModule, so this inspected nothing: ${cachedWhy}`
        : cachedCtx.added.join(', '));

    // ------------------------------------------------------- the ORT runtime
    /**
     * THE INFERENCE BACKEND'S TWO URLS, WHICH ARE NOT THE SAME KIND OF THING.
     *
     * `vendor/ort/` and the probe that names it are FILES ON DISK, so they go
     * through the Host. The worker module itself is reached by
     * `new URL(..., import.meta.url)` and must not — see the note in
     * `workers/workerbackend.js`. Both halves are asserted, because "thread
     * everything through the Host" and "thread the RIGHT things through the
     * Host" fail differently: the second is a Host handed authority over the
     * unit's own directory layout, and it would go unnoticed under this Host,
     * where the two answers happen to agree.
     *
     * S6 MOVED BOTH URLS ONE MODULE DOWN, from `offscreen/deck.js` into the
     * backend, and this block follows them rather than being rewritten around
     * the seam: the deck is still the entry point, the drive is still
     * `Deck.ensureSession()`, and the only difference is that `createBackend` on
     * the `shared` bundle is now what decides which backend gets built.
     */
    const { Deck } = await import('./extension/offscreen/deck.js');
    const { WorkerBackend } = await import('./extension/workers/workerbackend.js');
    const posts = [];
    const spawned = [];
    const fetched = [];
    const deckLog = [];
    const mirrored = [];
    const realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let deckWhy = null;
    let deck = null;
    try {
      globalThis.Worker = class {
        constructor(url, opts) {
          this.url = String(url); this.opts = opts; this.onmessage = null; this.onerror = null;
          spawned.push(this);
        }
        // The TRANSFER LIST is recorded, not just the message: it is the whole
        // of the difference between moving 109 MB and copying it, and nothing
        // else in the tree looks at it.
        postMessage(m, transfer) { posts.push({ m, transfer: transfer || [] }); }
        terminate() {}
      };
      globalThis.fetch = (url, init) => {
        fetched.push({ url: String(url), method: init && init.method });
        return Promise.resolve({ ok: true });
      };
      deck = new Deck('A', {
        ctx: () => null, master: () => null, gpu: null,
        modelBytes: async () => new ArrayBuffer(8),
        // The REAL backend over the stub resolver, hooks-first exactly as the
        // shipped `offscreen/host.js` builds it. This block's subject is where
        // the two URLs come from, and a fake backend would be answering that
        // question about itself.
        createBackend: (hooks) => new WorkerBackend({ ...hooks, assetUrl }),
        send: () => {}, log: (line) => deckLog.push(line), armRefMs: () => 0, assetUrl,
        // The engine's mirror to the UI, recorded rather than stubbed away: it
        // is the only route from the deck's session state to `state.model`, so
        // a hook that updates the deck and tells nobody is still a welcome page
        // stuck on "preparing the GPU".
        onWorkerState: (d) => mirrored.push({ session: d.session, threads: d.threads, adapter: d.adapter, error: d.sessionError }),
      });
      const session = deck.ensureSession();
      // LOAD_MODEL is posted after three awaits — the model bytes, the ORT
      // probe, and the queue the backend is wrapped in — and nothing here may
      // assume how many. Drive the loop until the message appears.
      const sentTypes = () => posts.map((p) => p.m && p.m.type);
      for (let i = 0; i < 200 && !sentTypes().includes('LOAD_MODEL'); i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      if (spawned.length === 1 && spawned[0].onmessage) {
        spawned[0].onmessage({ data: { type: 'MODEL_READY', ep: 'stub', createMs: 0, warmupMs: 0 } });
      }
      deckWhy = await drive(session);
    } finally {
      delete globalThis.Worker;
      if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch);
      else delete globalThis.fetch;
    }

    ok('THE ORT PRESENCE PROBE IS RESOLVED THROUGH THE HOST, and it is still a HEAD  '
      + '[entry point: extension/workers/workerbackend.js constructor, reached from Deck.ensureBackend()]',
      fetched.length === 1 && fetched[0].url === 'stub://unit/vendor/ort/ort.all.bundle.min.mjs'
      && fetched[0].method === 'HEAD',
      fetched.length === 0
        ? `the backend never reached the probe, so this inspected nothing: ${deckWhy}`
        : JSON.stringify(fetched));

    const init = posts.map((p) => p.m).find((m) => m && m.type === 'INIT');
    ok('...and the worker is told where the ORT runtime lives as a DIRECTORY url from the Host  '
      + '[entry point: extension/workers/workerbackend.js constructor, reached from Deck.ensureBackend()]',
      init != null && init.wasmDirUrl === 'stub://unit/vendor/ort/' && init.wasmDirUrl.endsWith('/'),
      init == null
        ? `no INIT was posted, so this inspected nothing: ${deckWhy}. Posted: ${posts.map((p) => p.m && p.m.type).join(', ')}`
        : String(init.wasmDirUrl));

    /**
     * THE ONE URL THE HOST DOES NOT GET TO RESOLVE, asserted from both sides: the
     * worker was spawned from a path ending in the unit's own layout, and the
     * Host was never asked about it. Asking only the first would be satisfied by
     * a build that resolved it through the Host to the same place, which is
     * exactly what this Host would do.
     */
    const workerUrl = spawned.length === 1 ? spawned[0].url : null;
    ok("THE INFERENCE WORKER'S OWN URL STAYS RELATIVE — the unit's directory layout is the unit's contract, not the Host's  "
      + '[entry point: extension/workers/workerbackend.js constructor]',
      workerUrl != null && workerUrl.endsWith('/extension/workers/inference.worker.js')
      && !asked.some((p) => /worker/i.test(p)),
      spawned.length !== 1
        ? `expected exactly one Worker to be spawned, got ${spawned.length}: ${deckWhy}`
        : asked.some((p) => /worker/i.test(p))
          ? `the Host was asked to resolve ${JSON.stringify(asked.filter((p) => /worker/i.test(p)))} — `
            + 'a Host that answers that owns where the unit keeps its own files'
          : workerUrl);

    /**
     * AND THE WEIGHTS ARE MOVED, NOT COPIED — the half of the zero-copy contract
     * that is paid once per deck rather than once per hop, and the only one that
     * `LOAD_MODEL` carries.
     *
     * 114,559,139 B copied instead of transferred is 109 MB duplicated across a
     * thread boundary at the exact peak-memory moment: FINDINGS §3 measured
     * 1761 MB renderer RSS with the duplicate resident, and review finding M4 is
     * the same buffer being held one reference too long inside the worker. The
     * TRANSFER LIST is the only thing that decides it, and a `postMessage` that
     * dropped it is invisible to every other assertion in this tree — the
     * message arrives, the session loads, and the deck goes green.
     */
    const loadPost = posts.find((p) => p.m && p.m.type === 'LOAD_MODEL');
    ok('THE MODEL BUFFER IS TRANSFERRED INTO THE BACKEND, NOT COPIED  '
      + '[entry point: extension/workers/workerbackend.js load(), reached from Deck.ensureSession()]',
      loadPost != null && loadPost.m.buffer instanceof ArrayBuffer
      && loadPost.transfer.length === 1 && loadPost.transfer[0] === loadPost.m.buffer,
      loadPost == null
        ? `no LOAD_MODEL was posted, so this inspected nothing: ${deckWhy}`
        : loadPost.transfer.length !== 1
          ? `LOAD_MODEL was posted with a transfer list of ${loadPost.transfer.length} — 109 MB is copied, not moved`
          : loadPost.transfer[0] !== loadPost.m.buffer
            ? 'LOAD_MODEL transfers something other than the buffer it carries'
            : 'the weights buffer is the transfer list');

    ok('...and the deck ends `ready` on MODEL_READY, carrying the EP the backend reported  '
      + '[entry point: extension/offscreen/deck.js Deck.ensureSession()]',
      deckWhy === null && deck != null && deck.session === 'ready' && deck.ep === 'stub',
      deckWhy !== null
        ? `ensureSession() rejected: ${deckWhy}`
        : `session ${deck && deck.session}, ep ${JSON.stringify(deck && deck.ep)}`);

    /* ------------------------------------ what the deck DOES with the hooks */
    /**
     * THE PUSH CHANNEL, DRIVEN FROM THE WORKER END.
     *
     * `onReady` and `onFail` are the two things that arrive OUTSIDE any call the
     * unit made, and the bodies the deck hands `createBackend()` are where they
     * become deck state. They were the newest non-trivial logic in this slice
     * and nothing looked at them: review deleted the whole `onFail` body — the
     * `session = 'error'` latch, `sessionError`, the log line and the
     * `onWorkerState` mirror — and `node test.js` stayed at 602 passed, 0
     * failed. Same for `onReady` writing `null` to both fields.
     *
     * The same `Deck` from the block above is used, and the same worker: the
     * stub's handlers are still attached after the platform globals are gone,
     * because the backend set them and nothing else did. That is what makes
     * this the DECK'S side of the seam rather than a second harness — the
     * `backend` group already asserts that `WorkerBackend` CALLS the hooks.
     *
     * WHAT GOES RED IF IT REGRESSES: `engine.js`'s `onWorkerState` turns
     * `d.session === 'error'` into `state.model.status = 'error'`, and the
     * comment there records what the missing half cost — the welcome page "sat
     * on 'preparing the GPU' with a live progress bar and no way to find out
     * that it had already failed".
     */
    const readyAt = mirrored.length;
    if (spawned.length === 1 && spawned[0].onmessage) {
      spawned[0].onmessage({ data: { type: 'READY', numThreads: 4, adapter: { vendor: 'nvidia', architecture: 'turing' } } });
    }
    const readyMirror = mirrored.length > readyAt ? mirrored[mirrored.length - 1] : null;
    const readyLine = deckLog.find((l) => l.includes('backend ready')) || null;
    ok('THE BACKEND\u2019S READY REACHES THE DECK: the hardware it found is recorded AND mirrored to the UI  '
      + '[entry point: the createBackend() `onReady` hook in extension/offscreen/deck.js ensureBackend()]',
      deck != null && deck.threads === 4
      && deck.adapter != null && deck.adapter.vendor === 'nvidia' && deck.adapter.architecture === 'turing'
      && readyMirror != null && readyMirror.threads === 4
      && readyLine === 'deck A backend ready \u00b7 wasm threads 4 \u00b7 gpu nvidia/turing',
      deck == null
        ? 'there is no deck to look at'
        : deck.threads !== 4 || deck.adapter == null
          ? `the deck recorded threads ${JSON.stringify(deck.threads)} and adapter ${JSON.stringify(deck.adapter)} — `
            + 'state.boot.{adapter,threads} is fed from these, so the deck reports no hardware at all'
          : readyMirror == null
            ? 'the deck recorded it and told nobody: onWorkerState never fired, so state.boot never learns'
            : `${JSON.stringify(readyLine)}`);

    /**
     * ...AND A BACKEND WITH NEITHER TO REPORT IS NOT DESCRIBED IN ORT'S WORDS.
     * `{threads: null, adapter: null}` is the only honest answer a native
     * backend (CoreML, DirectML, CUDA) can give, and the pre-seam spelling of
     * this line rendered it as "wasm threads null \u00b7 gpu none" — someone
     * else's hardware, reported to a user who has better. The fields stay as
     * they are (S11 freezes the interface); the render stops claiming.
     */
    const linesBefore = deckLog.length;
    if (spawned.length === 1 && spawned[0].onmessage) {
      spawned[0].onmessage({ data: { type: 'READY', numThreads: null, adapter: null } });
    }
    const bareLine = deckLog.length > linesBefore ? deckLog[deckLog.length - 1] : null;
    ok('...and a backend that reports NEITHER threads nor an adapter is not described in ORT\u2019s vocabulary  '
      + '[entry point: the createBackend() `onReady` hook in extension/offscreen/deck.js ensureBackend()]',
      bareLine === 'deck A backend ready' && deck != null && deck.threads === null && deck.adapter === null,
      bareLine == null
        ? 'the second READY was not logged at all, so this inspected nothing'
        : bareLine !== 'deck A backend ready'
          ? `a backend with no wasm and no WebGPU adapter is announced as ${JSON.stringify(bareLine)}`
          : `deck threads ${JSON.stringify(deck.threads)}, adapter ${JSON.stringify(deck.adapter)}, line ${JSON.stringify(bareLine)}`);

    /**
     * AND THE DEATH WITH NOTHING IN FLIGHT LATCHES THE SESSION. This is the
     * regression the hook exists to prevent, stated by the PR as the reason it
     * is there at all: without it the deck goes on reporting a session it no
     * longer has until the next arm. An EMPTY `onerror` message is the exact
     * shape a module worker that cannot resolve its static import fires.
     */
    const failAt = mirrored.length;
    if (spawned.length === 1 && spawned[0].onerror) spawned[0].onerror({ message: '' });
    const failMirror = mirrored.length > failAt ? mirrored[mirrored.length - 1] : null;
    const errLine = deckLog.find((l) => l.startsWith('ERROR [deck A backend]')) || null;
    ok('...and A BACKEND THAT DIES IDLE LATCHES THE SESSION AS `error`, WITH THE REASON, AND SAYS SO  '
      + '[entry point: the createBackend() `onFail` hook in extension/offscreen/deck.js ensureBackend()]',
      deck != null && deck.session === 'error'
      && typeof deck.sessionError === 'string' && deck.sessionError.includes('deck A')
      && failMirror != null && failMirror.session === 'error' && errLine != null,
      deck == null
        ? 'there is no deck to look at'
        : deck.session !== 'error'
          ? `the deck still reports session ${JSON.stringify(deck.session)} after its backend died — engine.js turns `
            + "d.session === 'error' into state.model.status, so the welcome page sits on \"preparing the GPU\" for ever"
          : !deck.sessionError || !deck.sessionError.includes('deck A')
            ? `the session failed with no usable reason: ${JSON.stringify(deck.sessionError)}`
            : failMirror == null
              ? 'the deck latched the error and told nobody: onWorkerState never fired, so state.model.status never moves'
              : `session ${deck.session}, sessionError ${JSON.stringify(deck.sessionError)}, logged ${JSON.stringify(errLine)}`);

    // ------------------------------------------- and nothing reaches past it
    /**
     * THE NEGATIVE HALF OF THE SLICE, read out of the tree rather than from a
     * grep in a PR body: after this slice `offscreen/host.js` is the only file
     * in the directory that says `chrome.` at all. Comments are stripped first —
     * three prose mentions survive on purpose (`live.js` twice, `cacheddeck.js`
     * once) and a claim a comment can satisfy is not a claim.
     *
     * FAILS IF IT CANNOT LOOK, in both directions: an empty or unrecognisable
     * file list is a red, and so is a strip that has eaten the calls it is
     * supposed to find — which the control below is the only thing that could
     * notice.
     */
    const { readdirSync } = await import('node:fs');
    const offDir = new URL('./extension/offscreen/', import.meta.url);
    const offFiles = readdirSync(offDir).filter((f) => f.endsWith('.js')).sort();
    const readOff = (f) => strip(readFileSync(new URL(f, offDir), 'utf8'));
    /**
     * `chrome[.:]` AND NOT `chrome\.`, because a URL is a coupling too. Review
     * found the last host-coupled string in the four files this checkbox covers
     * sitting just outside a `chrome\.`-shaped grep: `deck.js`'s ORT-missing
     * message told the user to "reload the extension at chrome://extensions",
     * which is wrong under every Host but this one — and the scan called the
     * file clean. The message now names the URL that failed instead, and the
     * scan can see the difference.
     */
    const offenders = offFiles.filter((f) => f !== 'host.js' && /\bchrome[.:]/.test(readOff(f)));
    ok('THE HOST IS THE ONLY FILE UNDER offscreen/ THAT NAMES chrome AT ALL — neither `chrome.` nor `chrome:`  '
      + '[entry point: the shipped tree, comments stripped]',
      offFiles.length >= 8 && offFiles.includes('host.js') && offenders.length === 0,
      offFiles.length < 8 || !offFiles.includes('host.js')
        ? `the scan found ${offFiles.length} .js files under offscreen/ and ${offFiles.includes('host.js') ? 'did' : 'did NOT'} `
          + 'find host.js — it is not looking at the directory it thinks it is'
        : offenders.length
          ? `Chrome is still named in ${offenders.join(', ')} — as a call, a second Host cannot load what that file `
            + 'loads; as a `chrome:` URL, it is advice that is wrong under every Host but this one'
          : `${offFiles.length - 1} files clean, host.js excepted`);

    ok('INSTRUMENT CHECK: the scan can still SEE a chrome. call — offscreen/host.js, the one file that must have them  '
      + '[control: it has to be able to lose]',
      offFiles.includes('host.js') && /\bchrome[.:]/.test(readOff('host.js')),
      offFiles.includes('host.js')
        ? `host.js: ${(readOff('host.js').match(/\bchrome[.:]\w*/g) || []).join(', ') || 'NOTHING — the strip ate them, and the claim above is vacuous'}`
        : 'offscreen/host.js was not found at all');

    /**
     * AND THEY TAKE THE RESOLVER RATHER THAN IMPORTING THE HOST. Four files that
     * each did `import { assetUrl } from './host.js'` would pass the scan above
     * and would work perfectly under this Host — while putting four more imports
     * of the platform into the half of the unit that is meant to be
     * host-agnostic, which is the property ADR 0001 decision 5 is buying.
     */
    /**
     * THE SCANNED SET IS THE DIRECTORY, not a list of four names, and both are
     * review findings rather than taste. A four-name list called itself "the
     * platform enters at one door" while `worklets.js` — the file this very
     * slice introduced — sat outside it: review put
     * `import { assetUrl } from './host.js'` into it and this assertion stayed
     * green. Reading the directory means the next file added under `offscreen/`
     * is held to the rule on the day it is added. `engine.js` is excepted
     * because it IS the door, and `host.js` because it is the platform.
     *
     * AND BOTH QUOTE STYLES, PLUS THE DYNAMIC FORM. The old pattern was
     * `from 'host.js'` with single quotes; there is no linter in this repo to
     * pin that style, and review walked past it twice — once with double quotes,
     * once with `await import('./host.js')`, both green. Matching the quoted
     * SPECIFIER covers every spelling of both.
     *
     * FAILS IF IT CANNOT LOOK: the five files the slice actually threads must
     * all be inside the scanned set, or the scan is not looking at the tree it
     * names.
     */
    const GRAPH = offFiles.filter((f) => f !== 'host.js' && f !== 'engine.js');
    const THREADED = ['deck.js', 'live.js', 'cacheddeck.js', 'master.js', 'worklets.js'];
    const importers = GRAPH.filter((f) => /['"]\.\/host\.js['"]/.test(readOff(f)));
    ok('...and the audio graph TAKES the resolver rather than importing the Host: the platform enters at one door  '
      + '[entry point: every .js under extension/offscreen/ except engine.js, the door, and host.js, the platform]',
      THREADED.every((f) => GRAPH.includes(f)) && importers.length === 0,
      !THREADED.every((f) => GRAPH.includes(f))
        ? `cannot look: ${THREADED.filter((f) => !GRAPH.includes(f)).join(', ')} is not in the scanned set`
        : importers.length
          ? `${importers.join(', ')} import ./host.js directly`
          : `${GRAPH.length} files scanned, resolver passed in from engine.js`);

    // ------------------------------------------ and where the thread STARTS
    /**
     * THE ORIGIN OF THE THREAD — the one claim the ten above cannot make, and
     * the one the slice is actually named after.
     *
     * Each of those ten hands the builder a `stub://unit/` resolver written in
     * this file. Together they prove the four files USE a resolver; not one of
     * them proves that `offscreen/engine.js` SUPPLIES one. Review measured the
     * hole exactly: delete the single line `assetUrl: host.assetUrl` from the
     * `shared` bundle and `--quick` stays GREEN at 18 of 20 steps and
     * `embed-smoke` stays at 122/122, while the shipped extension dies at
     * module evaluation — `engine.js` calls `decks.A.ensureBackend()` at module
     * scope and it throws `this.s.assetUrl is not a function`. No INIT, no
     * HELLO, no engine, and nothing red anywhere. That is the exact shape
     * AGENTS.md names as the source of five defects here: a value right at four
     * call sites and absent at the one that feeds them.
     *
     * TWO GATES NOW, BECAUSE CI IS ONLY ONE OF THEM. `Deck` and `CachedDeck`
     * refuse a bundle short the resolver (below), which turns that mutation
     * into a module-scope throw — and a module-scope throw takes `embed-smoke`
     * to `5/37 FAILED`. This pair is what makes `--quick`, the only gate
     * GitHub Actions runs, see it too.
     *
     * READ AS TEXT for the reason the block at the top of this group gives:
     * `engine.js` cannot be imported from Node at all. Comments are stripped —
     * which matters here more than usual, because the doc comment sitting
     * directly above the line quotes the seam in prose. The `strip` control a
     * few assertions above is what keeps that stripping honest.
     */
    const sharedAt = engineSrc.indexOf('const shared = {');
    const sharedLit = sharedAt < 0 ? null : engineSrc.slice(sharedAt).split(/\n\};/)[0];
    /**
     * EVERY construction is parsed, and the parsed count is compared with the
     * raw one, so a `new Deck(` this pattern cannot read is a red rather than a
     * silent pass — there are three today (deck A at module scope, deck B in
     * `deck()`, and the cached deck in `cachedDeck()`) and a fourth must not
     * arrive unnoticed.
     */
    const constructions = (engineSrc.match(/new (?:Deck|CachedDeck)\(/g) || []).length;
    const takers = [...engineSrc.matchAll(/new (?:Deck|CachedDeck)\(\s*[^,()]+,\s*([A-Za-z_$][\w$]*)\s*\)/g)];
    const notShared = takers.filter((m) => m[1] !== 'shared').map((m) => m[0]);
    const onBundle = sharedLit != null && /(^|\n)\s*assetUrl:\s*host\.assetUrl\s*,/.test(sharedLit);
    ok("THE ENGINE PUTS THE HOST'S RESOLVER ON THE BUNDLE, and the bundle is what every deck is built from  "
      + '[entry point: extension/offscreen/engine.js `const shared = {`, comments stripped]',
      sharedLit != null && onBundle
      && constructions >= 2 && takers.length === constructions && notShared.length === 0,
      sharedLit == null
        ? 'cannot look: no `const shared = {` in extension/offscreen/engine.js, so there is no bundle to inspect'
        : !onBundle
          ? 'the `shared` bundle does NOT carry `assetUrl: host.assetUrl`. Every deck then reads undefined: '
            + 'engine.js calls decks.A.ensureBackend() at module scope, so the engine does not boot at all — no INIT '
            + 'to the inference worker and no HELLO to the deck'
          : takers.length !== constructions
            ? `cannot look: ${constructions} deck constructions in engine.js but only ${takers.length} could be read, `
              + 'so one of them is built from something this claim never inspected'
            : notShared.length
              ? `built from something other than the bundle: ${notShared.join(', ')}`
              : `assetUrl: host.assetUrl on the bundle, and all ${constructions} deck constructions take it`);

    /**
     * The whole argument list is read to the statement's own `);` and the LAST
     * argument taken from it, rather than a shape-matched pair: a resolver
     * wrapped, replaced by a literal or dropped entirely all have to name the
     * defect, and a pattern that only matches two bare identifiers reports
     * "cannot look" for the two most likely of the three.
     */
    const busCall = engineSrc.match(/new MasterBus\(([\s\S]*?)\);/);
    const busSecond = busCall == null ? null : busCall[1].slice(busCall[1].indexOf(',') + 1).trim();
    ok('...AND HANDS IT TO THE MASTER BUS TOO, which is constructed before there is a context to await on  '
      + '[entry point: extension/offscreen/engine.js module scope, comments stripped]',
      busCall != null && busSecond === 'host.assetUrl',
      busCall == null
        ? 'cannot look: no `new MasterBus(…);` statement in extension/offscreen/engine.js'
        : busSecond === 'host.assetUrl'
          ? busCall[0]
          : `the bus is handed ${JSON.stringify(busSecond)} rather than host.assetUrl — the Host is no longer what `
            + 'decides where offscreen/master-meter-processor.js lives');

    /**
     * AND THE DECKS REFUSE A BUNDLE THAT LOST IT, which is what makes the two
     * source reads above a belt rather than the only strap.
     *
     * `assertHost()` cannot cover this: it checks the HOST — that
     * `host.assetUrl` is a function — and it runs before any of this. The
     * hand-off from the Host onto `shared` is a separate step with a separate
     * way to go wrong, and it had no alarm at all. `MasterBus` refuses the same
     * way and has since this slice's first commit; the asymmetry review found
     * was that the DECK side did not, so the mutation stayed silent in the
     * browser while `new MasterBus(null)` would have aborted engine.js on the
     * spot.
     */
    const shortLive = threw(() => new Deck('A', { ctx: () => null, master: () => null, send: () => {}, log: () => {} }));
    ok("THE LIVE DECK REFUSES A SHARED BUNDLE THAT IS SHORT THE HOST'S RESOLVER  "
      + "[entry point: extension/offscreen/deck.js constructor — `new Deck('A', shared)` runs at engine.js module scope]",
      shortLive != null && shortLive.includes('assetUrl'),
      shortLive == null
        ? 'new Deck(id, {…no assetUrl}) was ACCEPTED. The deck then reads undefined and throws `this.s.assetUrl is not '
          + 'a function` inside ensureBackend(), three layers from the mistake — and because that construction is at '
          + 'engine.js module scope, the browser gate is the only thing that could have seen it'
        : shortLive);

    /**
     * AND THE SAME HOLE ONE DUTY OVER. S6 threads `createBackend` onto the same
     * bundle by the same one line, so it has the same way to be lost and the
     * same silence when it is: `assertHost` is satisfied, every check in this
     * file is green, and `decks.A.ensureBackend()` — at engine.js module scope —
     * dies with `this.s.createBackend is not a function`. A deck with no way to
     * build a backend has no second path to inference, so this is a refusal
     * rather than a degradation.
     */
    const noBackend = threw(() => new Deck('A', {
      ctx: () => null, master: () => null, send: () => {}, log: () => {}, assetUrl,
    }));
    ok('...AND ONE THAT IS SHORT THE HOST\'S BACKEND FACTORY, which has no fallback at all  '
      + "[entry point: extension/offscreen/deck.js constructor — `new Deck('A', shared)` runs at engine.js module scope]",
      noBackend != null && noBackend.includes('createBackend'),
      noBackend == null
        ? 'new Deck(id, {…assetUrl but no createBackend}) was ACCEPTED. ensureBackend() then calls undefined() at '
          + 'engine.js module scope: no INIT, no HELLO, no engine, and nothing red in --quick'
        : noBackend);

    const shortCached = threw(() => new CachedDeck('A', { ctx: () => null, master: () => null, send: () => {}, log: () => {} }));
    ok('...AND SO DOES THE CACHED DECK, which is built lazily and would otherwise find out at the first cache hit  '
      + '[entry point: extension/offscreen/cacheddeck.js constructor — `new CachedDeck(k, shared)` in engine.js cachedDeck()]',
      shortCached != null && shortCached.includes('assetUrl'),
      shortCached == null
        ? 'new CachedDeck(id, {…no assetUrl}) was ACCEPTED — ensureGraph() would then hand undefined() to addModule at '
          + 'the first cached play'
        : shortCached);
  }

  head('host — one playback worklet per AudioContext, whichever deck gets there first');
  /**
   * THE DEFECT THIS CLOSES. Mode 3 puts both decks on ONE AudioContext and both
   * kinds of deck play through the same `stem-playback` processor, so the second
   * registration on a context rejects with "A processor named 'stem-playback' is
   * already registered". That fact was tracked in TWO module-scoped WeakSets
   * that did not share state — one in `live.js`, one in `cacheddeck.js` — and
   * only one of the two files swallowed the rejection. So whether the collision
   * was survivable depended on WHICH DECK GOT THERE FIRST: live-then-cached was
   * fine, and cached-then-live rejected out of `LivePipeline.build()` and
   * surfaced as `START_FAILED`. A live deck that refuses to start because a
   * cached deck is already playing is the flagship dual-deck gesture failing.
   *
   * S2 is the slice that edits both of those lines, so it is the slice that
   * either fixes this or entrenches it: the shared set now lives in
   * `offscreen/worklets.js` and both decks go through it.
   *
   * REACHABLE, NOT CONSTRUCTED: the two direction assertions drive the SHIPPED
   * `LivePipeline.build()` and `CachedDeck.ensureGraph()` against ONE fake
   * context, in both orders. Nothing here reimplements the decision.
   *
   * THE FAKE CONTEXT REFUSES A SECOND REGISTRATION THE WAY CHROME DOES, with
   * Chrome's own wording, and the instrument check below is what makes the two
   * claims able to lose: against a permissive fake, "cached then live" would
   * pass on a build where live.js registered a second time and threw in the
   * browser.
   */
  {
    const { ensurePlaybackWorklet } = await import('./extension/offscreen/worklets.js');
    const { LivePipeline } = await import('./extension/offscreen/live.js');
    const assetUrl = (relPath) => `stub://unit/${relPath}`;
    const drive = (p) => p.then(() => null, (e) => String((e && e.message) || e));
    /**
     * An AudioContext that registers a processor name exactly once, as Chrome
     * does — and that counts ATTEMPTS as well as registrations.
     *
     * `tried` IS THE ESTIMATOR THE CLAIM NEEDS, and `added` is not. Review
     * deleted the per-context dedup from `offscreen/worklets.js` outright — the
     * mechanism this whole block exists to hold — and both direction claims
     * below stayed GREEN, printing "1 registration" while the build had issued
     * TWO addModule calls: the second one throws before it can push to `added`,
     * so that count saturates at 1 before the range the claim needs (2) begins.
     * AGENTS.md rule 3, in the file it was written about. Counting every attempt
     * is what makes "once per context" refutable.
     */
    const oneShotCtx = () => {
      const added = [], tried = [];
      return {
        added,
        tried,
        sampleRate: SR,
        audioWorklet: {
          addModule: async (url) => {
            tried.push(url);
            if (added.includes(url)) throw new Error("A processor named 'stem-playback' is already registered");
            added.push(url);
          },
        },
      };
    };
    const liveOn = (ctx) => new LivePipeline({
      deck: 'A', ctx: () => ctx, master: () => null, ring: () => null,
      infer: async () => ({}), ensureModel: async () => {}, send: () => {}, log: () => {}, assetUrl,
    });
    const cachedOn = (ctx) => new CachedDeck('A', {
      ctx: () => ctx, master: () => null, send: () => {}, log: () => {}, assetUrl,
    });

    const probe = oneShotCtx();
    await probe.audioWorklet.addModule('stub://unit/offscreen/playback-processor.js');
    const second = await drive(probe.audioWorklet.addModule('stub://unit/offscreen/playback-processor.js'));
    ok('INSTRUMENT CHECK: the fake context refuses a second registration the way Chrome does  '
      + '[control: the refusal is what lets the two claims below SEE a builder trip; the attempt count is what '
      + 'lets them see a second registration at all]',
      second != null && /already registered/i.test(second) && probe.tried.length === 2 && probe.added.length === 1,
      second == null
        ? 'the fake accepted a second addModule of the same processor — it cannot reproduce the defect the two claims below exist for'
        : probe.tried.length !== 2 || probe.added.length !== 1
          ? `the fake recorded ${probe.tried.length} attempts and ${probe.added.length} registrations for 2 addModule calls — `
            + 'it cannot tell "registered once" from "tried twice and one throw was swallowed", which is the whole claim'
          : `${probe.tried.length} attempts, ${probe.added.length} registration, second refused with ${JSON.stringify(second)}`);

    // ---- live first, then a cached deck on the same context
    const ctxLF = oneShotCtx();
    const lfLive = await drive(liveOn(ctxLF).build());
    const lfCached = await drive(cachedOn(ctxLF).ensureGraph());
    ok('LIVE FIRST, THEN CACHED ON THE SAME CONTEXT: addModule is CALLED ONCE, and neither builder trips over it  '
      + '[entry point: live.js LivePipeline.build() then cacheddeck.js CachedDeck.ensureGraph()]',
      ctxLF.tried.length === 1 && ctxLF.added.length === 1
      && !/already registered/i.test(String(lfLive)) && !/already registered/i.test(String(lfCached)),
      ctxLF.tried.length !== 1
        ? `${ctxLF.tried.length} addModule ATTEMPTS on one context, expected 1 — the second deck re-registered and only `
          + "worklets.js's catch hid it"
        : ctxLF.added.length !== 1
          ? `${ctxLF.added.length} registrations on one context, expected 1`
          : `1 attempt, 1 registration; live stopped at ${JSON.stringify(String(lfLive).slice(0, 48))}, cached at ${JSON.stringify(String(lfCached).slice(0, 48))}`);

    // ---- and the other way round, which is the order that used to fail
    const ctxCF = oneShotCtx();
    const cfCached = await drive(cachedOn(ctxCF).ensureGraph());
    const cfLive = await drive(liveOn(ctxCF).build());
    ok('...AND CACHED FIRST, THEN LIVE — the order that used to reject out of build() as START_FAILED  '
      + '[entry point: cacheddeck.js CachedDeck.ensureGraph() then live.js LivePipeline.build()]',
      ctxCF.tried.length === 1 && ctxCF.added.length === 1
      && !/already registered/i.test(String(cfCached)) && !/already registered/i.test(String(cfLive)),
      ctxCF.tried.length !== 1
        ? `${ctxCF.tried.length} addModule ATTEMPTS on one context, expected 1 — the second deck re-registered and only `
          + "worklets.js's catch hid it"
        : ctxCF.added.length !== 1
          ? `${ctxCF.added.length} registrations on one context, expected 1`
          : /already registered/i.test(String(cfLive))
            ? `the live deck rejected with ${JSON.stringify(String(cfLive))} — a live prime cannot start while a cached deck holds the context`
            : `1 attempt, 1 registration; cached stopped at ${JSON.stringify(String(cfCached).slice(0, 48))}, live at ${JSON.stringify(String(cfLive).slice(0, 48))}`);

    /**
     * THE TWO REJECTIONS THAT ARE NOT THE SAME KIND, driven directly because
     * neither is reachable from a deck builder in Node: one is what the registrar
     * must swallow and the other is what it must never swallow, and a registrar
     * that got them the wrong way round would pass both direction claims above.
     */
    const collided = await drive(ensurePlaybackWorklet({
      audioWorklet: { addModule: async () => { throw new Error("A processor named 'stem-playback' is already registered"); } },
    }, assetUrl));
    ok('A NAME COLLISION IS TOLERATED — the module loaded, and the caller\'s AudioWorkletNode is what proves it  '
      + '[entry point: extension/offscreen/worklets.js ensurePlaybackWorklet(), the one both decks call]',
      collided === null,
      collided === null ? 'resolved' : `rejected with ${JSON.stringify(collided)}`);

    const broken = await drive(ensurePlaybackWorklet({
      audioWorklet: { addModule: async () => { throw new Error('Failed to fetch playback-processor.js'); } },
    }, assetUrl));
    ok('...AND A GENUINE LOAD FAILURE IS NOT — a 404 or a syntax error in the worklet still reaches the deck  '
      + '[entry point: extension/offscreen/worklets.js ensurePlaybackWorklet(), the one both decks call]',
      broken != null && /Failed to fetch/.test(broken),
      broken == null
        ? 'ensurePlaybackWorklet() SWALLOWED a load failure — the deck would then build a node for a processor that is not there'
        : broken);
  }

  // ------------------------------------------- the page, and the player on it
  head('host — the DECK half: the page it is drawn into, and the player above it');
  /**
   * WHAT S5 MOVED AND WHY IT NEEDS ITS OWN COVERAGE.
   *
   * The deck used to talk to the page it is drawn into with eight bare
   * `parent.postMessage` calls and one `window.addEventListener('message')`.
   * Both are now duties: `host.page` (keys, the autoplay report, the frame's
   * own life) and `host.transport` (the player). The split is not cosmetic —
   * `host.transport != null` is now the ONLY thing that decides whether this
   * deck is hosted, replacing `window.parent !== window`.
   *
   * That replacement is the whole slice, and it is the assertion that has to be
   * unmissable: a Host that draws the deck as a TOP-LEVEL document and reports
   * its player is hosted, and the old frame test called it unhosted — which
   * `follow()` reads as "nobody is ever going to tell me whether the video is
   * playing, so RUN", i.e. a capture and a 109 MB model download on boot, on a
   * page nobody pressed play on.
   */
  {
    const pageDuties = Object.keys(DECK_PAGE_DUTIES);
    const transportDuties = Object.keys(DECK_TRANSPORT_DUTIES);
    const threw = (fn) => { try { fn(); return null; } catch (e) { return String((e && e.message) || e); } };

    // ------------------------------------------------ the controls: it passes
    /**
     * THE CONTROL FOR EVERY REFUSAL BELOW. Without it, "a Host short a page duty
     * is refused" is satisfied by a function that refuses everything.
     */
    const pageOk = threw(() => assertHost(deckHost.page, DECK_PAGE_DUTIES, 'DeckHost.page'));
    ok('THE SHIPPED DeckHost.page SATISFIES EVERY DECLARED DUTY  '
      + '[entry point: extension/ui/host.js, the module extension/ui/embed.js imports]',
      pageDuties.length > 0 && pageOk === null,
      pageDuties.length === 0
        ? 'DECK_PAGE_DUTIES is empty — this assertion has no coverage at all'
        : pageOk || `${pageDuties.length} duties: ${pageDuties.join(', ')}`);

    const trOk = threw(() => assertHost(deckHost.transport, DECK_TRANSPORT_DUTIES, 'DeckHost.transport'));
    ok('...and so does the SHIPPED DeckHost.transport, when the Host has a player at all',
      transportDuties.length > 0 && trOk === null,
      transportDuties.length === 0
        ? 'DECK_TRANSPORT_DUTIES is empty — this assertion has no coverage at all'
        : trOk || `${transportDuties.length} duties: ${transportDuties.join(', ')}`);

    // --------------------------------- an optional namespace must be DECLARED
    /**
     * ENTRY POINT: `assertHostOption(host, 'transport', …)` at the top of
     * `extension/ui/embed.js`. It is a different question from `assertHost`'s,
     * and this is the case that makes it worth a function: a Host that MEANT to
     * supply a transport and misspelled the key looks exactly like a Host that
     * deliberately has no player. One of those boots a deck that waits for its
     * page; the other boots a deck that starts a capture on its own.
     */
    const silent = threw(() => assertHostOption({ send() {}, onMessage() {} }, 'transport', DECK_TRANSPORT_DUTIES, 'DeckHost'));
    ok('A HOST THAT NEVER MENTIONED `transport` IS REFUSED — an omission is not an answer  '
      + "[entry point: assertHostOption(), called at extension/ui/embed.js module scope]",
      silent != null && silent.includes('transport') && silent.includes('null'),
      silent == null
        ? 'a Host with no `transport` property was ACCEPTED as a Host with no player — a misspelled key now '
          + 'boots the deck into the state follow() reads as "nobody will ever tell me, so run"'
        : silent);

    const declared = { send() {}, onMessage() {}, transport: null };
    const declaredOut = probe(assertHostOption, declared, 'transport', DECK_TRANSPORT_DUTIES, 'DeckHost');
    ok('...and a DECLARED absence is accepted, and reads back as null  '
      + '[entry point: assertHostOption(), the `transport: null` a Host with no player writes]',
      declaredOut.ok && declaredOut.v === null,
      declaredOut.ok ? String(declaredOut.v) : `it threw: ${declaredOut.e}`);

    const short = { send() {}, onMessage() {}, transport: Object.fromEntries(transportDuties.map((k) => [k, () => {}])) };
    delete short.transport.drive;
    const shortWhy = threw(() => assertHostOption(short, 'transport', DECK_TRANSPORT_DUTIES, 'DeckHost'));
    ok('...and a transport that is PRESENT BUT SHORT is refused, naming the duty and the namespace',
      shortWhy != null && shortWhy.includes('drive() — ') && shortWhy.includes('DeckHost.transport'),
      shortWhy == null ? 'a transport with no drive() was ACCEPTED' : shortWhy);

    const noHostAtAll = threw(() => assertHostOption(undefined, 'transport', DECK_TRANSPORT_DUTIES, 'DeckHost'));
    ok('...and with NO HOST AT ALL it throws rather than answering "no player" — a check that cannot look must fail',
      noHostAtAll != null && noHostAtAll.includes('no host module was supplied'),
      noHostAtAll == null
        ? 'assertHostOption(undefined, …) returned without throwing — the absent-host case would read as a deliberate absence'
        : noHostAtAll);

    // -------------------------------------- hosted is a HOST fact, not a frame
    /**
     * THE SLICE'S CENTRAL CLAIM, DRIVEN RATHER THAN READ.
     *
     * The shipped `ui/host.js` is imported a SECOND time under a `window` whose
     * `parent` is itself — a document opened outside a frame. The query string
     * is what makes Node evaluate the module again rather than hand back the
     * cached instance; the frame question is answered once, at module scope,
     * which is exactly the thing being checked.
     *
     * BOTH HALVES, so the control can lose: framed must give a transport and
     * lone must give null. An implementation that returned `null` always, or an
     * object always, fails one of them.
     *
     * ...AND `page` SURVIVES BOTH. A deck with no player still has to be able to
     * size itself and take its keys, which is the whole reason these are two
     * namespaces and not one.
     */
    const loneWin = makeWindow(false);
    globalThis.window = loneWin;
    const lone = (await import('./extension/ui/host.js?lone')).host;
    globalThis.window = framedWin;

    ok('HOSTED IS A FACT ABOUT THE HOST, NOT ABOUT FRAMES: a player above the deck is what supplies a transport  '
      + '[entry point: extension/ui/host.js module scope, imported twice under two windows]',
      deckHost.transport !== null && typeof deckHost.transport === 'object' && lone.transport === null,
      `framed -> ${deckHost.transport === null ? 'null' : 'a transport'}, `
        + `lone -> ${lone.transport === null ? 'null' : 'a transport'}`);

    const lonePage = threw(() => assertHost(lone.page, DECK_PAGE_DUTIES, 'DeckHost.page'));
    ok('...and the PAGE survives either way — a deck with no player still has to size itself and take its keys',
      lonePage === null && lone.transport === null,
      lonePage || `page ok, transport ${lone.transport === null ? 'null' : 'present'}`);

    // ------------------------------------------ what the deck actually reaches
    /**
     * READ AS TEXT, like the engine half above it: `extension/ui/embed.js`
     * builds a whole DOM at module scope and cannot be evaluated from Node.
     * Comments are stripped first — these are claims about code, and a claim a
     * doc comment can satisfy is not a claim.
     */
    const embedRaw = readFileSync(new URL('./extension/ui/embed.js', import.meta.url), 'utf8');
    const embedSrc = strip(embedRaw);
    const hostRaw = readFileSync(new URL('./extension/ui/host.js', import.meta.url), 'utf8');
    const hostSrc = strip(hostRaw);

    /**
     * THE CHECKS ARE ONLY WORTH THEIR NAMES IF THE DECK ACTUALLY RUNS THEM, AND
     * RUNS THEM FIRST — the deck-side twin of "THE ENGINE ITSELF RUNS THE CHECK"
     * seven hundred lines above, here for the same reason and found the same way.
     *
     * Every refusal above drives `assertHost` and `assertHostOption` DIRECTLY,
     * which proves the two functions work and proves nothing at all about
     * `extension/ui/embed.js` ever calling them. Review proved the gap by making
     * the deck stop calling them — `const transport = host.transport || null;`
     * in place of the `assertHostOption` line, and the `assertHost(host.page, …)`
     * line deleted: `--quick` stayed GREEN and `unit` stayed at 513 passed, 0
     * failed, byte-identical, while two assertions above went on naming those
     * call sites as their entry point. `tools/embed-smoke.mjs` cannot see it
     * either, and that is not a gap in the browser gate: under THIS Host the
     * behaviour is identical, because the whole value of the calls is the refusal
     * a SECOND Host would get at boot instead of a TypeError at a user gesture.
     * S3 shipped with the same hole under `assertHost(host, DECK_HOST_DUTIES)`,
     * so all three are checked here and not only this slice's two.
     *
     * MATCHED AT THE START OF A LINE, which in this file means module scope. A
     * check that runs inside a function the deck may or may not reach is not a
     * boot check, and the `//`-and-`/* *\/`-stripped source is what it is matched
     * against so that a call commented out reads as a call that is gone.
     *
     * FAILS IF IT CANNOT LOOK: a build in which the first use each check is
     * ordered against cannot be found is a red, not a pass.
     */
    const BOOTS = [
      {
        call: 'assertHost(host, DECK_HOST_DUTIES, …)',
        at: /^assertHost\(host, DECK_HOST_DUTIES/m,
        use: /\bhost\.(send|onMessage)\s*\(/,
        guards: 'host.send()/host.onMessage()',
        cost: 'a Host short a bus duty boots, and the first STATUS goes nowhere — a deck that never '
          + 'leaves idle with nothing in the console',
      },
      {
        call: 'assertHost(host.page, DECK_PAGE_DUTIES, …)',
        at: /^assertHost\(host\.page, DECK_PAGE_DUTIES/m,
        use: /\bhost\.page\./,
        guards: 'host.page.*()',
        cost: 'a Host short a page duty boots clean and throws at the first height report',
      },
      {
        call: "assertHostOption(host, 'transport', DECK_TRANSPORT_DUTIES, …)",
        at: /^const transport = assertHostOption\(host, 'transport'/m,
        use: /\btransport\s*(\.|!=)/,
        guards: 'the `transport` binding',
        cost: 'a misspelled `transport` key reads as "this Host has no player", which follow() reads '
          + 'as licence to run: a capture and a 109 MB download on a page nobody pressed play on',
      },
    ];
    const boots = BOOTS.map((b) => ({ ...b, i: embedSrc.search(b.at), u: embedSrc.search(b.use) }));
    const notRun = boots.filter((b) => b.i < 0);
    ok('THE DECK ITSELF RUNS ALL THREE BOOT CHECKS — they are called at embed.js module scope, not only from here  '
      + '[entry point: extension/ui/embed.js module scope, comments stripped]',
      notRun.length === 0,
      notRun.length
        ? notRun.map((b) => `${b.call} is NOT called at embed.js module scope — every refusal above still passes and ${b.cost}`).join(' · ')
        : `3 of 3, at ${boots.map((b) => b.i).join(', ')} chars in`);

    const late = boots.filter((b) => b.i < 0 || b.u < 0 || b.i > b.u);
    ok('...and each runs BEFORE the deck first reaches for the thing it guards, so a refusal lands at boot',
      late.length === 0,
      late.length
        ? late.map((b) => (b.u < 0
          ? `cannot look: nothing in embed.js matches /${b.use.source}/, so the ordering claim for ${b.call} has no anchor`
          : b.i < 0
            ? `${b.call} is not there to order`
            : `${b.call} at ${b.i} runs AFTER ${b.guards} at ${b.u} — the Host is already in use by the time it is checked`)).join(' · ')
        : boots.map((b) => `${b.guards} ${b.i}<${b.u}`).join(' · '));

    /**
     * THE DECK NO LONGER KNOWS WHAT A FRAME IS, asserted as an ABSENCE and a
     * PRESENCE together — the shape `tools/tree-check.mjs` uses for the arm
     * chord, and for the same reason: the absence alone is satisfied by a build
     * in which the frame test was simply deleted and `hosted` hard-coded.
     */
    const hostedLine = /const HOSTED = transport != null;/.test(embedSrc);
    const framesInDeck = [...embedSrc.matchAll(/\bwindow\.parent\b|\bparent\.postMessage\b/g)].map((m) => m[0]);
    ok('THE DECK ASKS THE HOST, NOT THE WINDOW: `hosted` comes off the transport and embed.js names no frame at all  '
      + '[entry point: extension/ui/embed.js, comments stripped]',
      hostedLine && framesInDeck.length === 0,
      !hostedLine
        ? 'no `const HOSTED = transport != null;` in embed.js — the input to follow()`s hosted branch is not the Host'
        : framesInDeck.length
          ? `embed.js still names ${framesInDeck.join(', ')} — under a desktop Host that is the wrong question`
          : 'hosted <- transport != null, and no window.parent anywhere in the deck');

    ok('...and the frame test is the HOST\'s, where it is true: ui/host.js is the one file that asks it',
      /window\.parent !== window/.test(hostSrc),
      /window\.parent !== window/.test(hostSrc)
        ? 'extension/ui/host.js decides FRAMED, and nothing else does'
        : 'no `window.parent !== window` in extension/ui/host.js — the absence above is then satisfied by a build '
          + 'that simply stopped asking, and every deck is hosted or none is');

    /**
     * THE INTERFACE AND ITS ONE CONSUMER MUST NOT DRIFT APART, in either
     * direction — the deck-side twin of the engine's pair. A duty used but not
     * declared is a Host that passes the boot check and then throws at a user
     * gesture; a duty declared but never used is one more thing a second Host
     * implements for nothing.
     *
     * Matched as CALLS. `host.page.` is unambiguous; the transport is reached
     * through the module-scope `transport` binding `assertHostOption` returns,
     * which is why the two patterns differ.
     */
    const reachedPage = [...new Set([...embedSrc.matchAll(/\bhost\.page\.(\w+)\s*\(/g)].map((m) => m[1]))].sort();
    const reachedTr = [...new Set([...embedSrc.matchAll(/\btransport\.(\w+)\s*\(/g)].map((m) => m[1]))].sort();
    const undeclared = [
      ...reachedPage.filter((k) => !pageDuties.includes(k)).map((k) => `host.page.${k}()`),
      ...reachedTr.filter((k) => !transportDuties.includes(k)).map((k) => `transport.${k}()`),
    ];
    ok('EVERY PAGE AND TRANSPORT DUTY THE DECK REACHES FOR IS DECLARED  '
      + '[entry point: extension/ui/embed.js, comments stripped]',
      reachedPage.length > 0 && reachedTr.length > 0 && undeclared.length === 0,
      reachedPage.length === 0 || reachedTr.length === 0
        ? `the deck reaches ${reachedPage.length} page and ${reachedTr.length} transport duties — either the seam is gone or this scan cannot see it`
        : undeclared.length
          ? `undeclared: ${undeclared.join(', ')} — declare it or a Host will pass the boot check and still throw`
          : `${reachedPage.length} page: ${reachedPage.join(', ')} · ${reachedTr.length} transport: ${reachedTr.join(', ')}`);

    const unreached = [
      ...pageDuties.filter((k) => !reachedPage.includes(k)).map((k) => `page.${k}`),
      ...transportDuties.filter((k) => !reachedTr.includes(k)).map((k) => `transport.${k}`),
    ];
    ok('...and every declared one is actually reached for, so a second Host implements nothing dead',
      reachedPage.length > 0 && reachedTr.length > 0 && unreached.length === 0,
      unreached.length ? `declared but never called: ${unreached.join(', ')}` : `all ${pageDuties.length + transportDuties.length}`);

    // ------------------------------------------------- the outgoing page wire
    /**
     * REACHABLE, NOT CONSTRUCTED: every assertion below CALLS the shipped
     * `extension/ui/host.js` with the stubbed `window` underneath it and reads
     * what came out on the wire. Nothing here reimplements the module.
     */
    framedWin.posted.length = 0;
    deckHost.page.claimKeys({ armed: true, keys: ['Digit1', 'Escape'] });
    deckHost.page.setHeight(496);
    deckHost.page.ready();
    deckHost.page.close();
    deckHost.transport.release();
    const sent = framedWin.posted.map((p) => p.msg);
    ok('THE PAGE AND TRANSPORT DUTIES POST THE DECK\'S OWN NAMESPACE, one wire type each  '
      + '[entry point: extension/ui/host.js page/transport, reached from extension/ui/embed.js]',
      sent.length === 5
      && sent.every((m) => m.from === 'stem-splitter-live')
      && sent.map((m) => m.type).join(',') === 'DECK,HEIGHT,READY,CLOSE,VRELEASE',
      sent.length === 5
        ? sent.map((m) => `${m.from}/${m.type}`).join(' ')
        : `${sent.length} messages reached the wire for 5 calls`);

    ok('...and content.js is told which keys are the deck\'s, and how tall it is, verbatim',
      sent.length === 5 && sent[0].armed === true && Array.isArray(sent[0].keys)
      && sent[0].keys.join(',') === 'Digit1,Escape' && sent[1].height === 496,
      sent.length === 5 ? `${JSON.stringify(sent[0])} · ${JSON.stringify(sent[1])}` : 'nothing to read');

    ok('...to `parent` and to nothing else, and with no origin pinned — the deck cannot know at build '
      + 'time what page it was mounted into',
      framedWin.posted.length === 5
      && framedWin.posted.every((p) => p.to === 'parent' && p.targetOrigin === '*'),
      framedWin.posted.map((p) => `${p.to}@${String(p.targetOrigin)}`).join(' '));

    /**
     * THE WRITE SET IS CLOSED, AND THIS IS THE ASSERTION THAT HOLDS IT.
     *
     * ADR 0001 decision 4 sets the transport's write side at `muted`,
     * `currentTime` and `playbackRate`; L1 is why that is a rule and not a
     * preference, because the same channel reaches a `<video>` on somebody
     * else's page. `drive` therefore names its three fields instead of
     * spreading its argument — so the extra properties below must NOT appear on
     * the wire. Spreading is the one-character mistake this exists to catch, and
     * it would make the write set whatever a call site happened to pass.
     *
     * `currentTime -> seekTo` is checked in the same breath: the seam speaks the
     * ADR's name and the wire keeps content.js's, and a rename that dropped the
     * field would leave the cached deck unable to seek with no other symptom.
     */
    framedWin.posted.length = 0;
    deckHost.transport.drive({
      muted: true, currentTime: 12.5, playbackRate: 1.02,
      src: 'https://example.invalid/v.mp4', volume: 0.1, currentSrc: 'x',
    });
    const drove = framedWin.posted.length === 1 ? framedWin.posted[0].msg : null;
    ok('drive() WRITES ONLY THE THREE FIELDS ADR 0001 DECISION 4 NAMES, and carries currentTime as the wire\'s seekTo  '
      + '[entry point: extension/ui/host.js transport.drive(), reached from embed.js syncVideoLock()]',
      drove !== null
      && Object.keys(drove).sort().join(',') === 'from,muted,playbackRate,seekTo,type'
      && drove.muted === true && drove.playbackRate === 1.02 && drove.seekTo === 12.5,
      drove === null
        ? `drive() put ${framedWin.posted.length} messages on the wire, expected 1`
        : Object.keys(drove).sort().join(','));

    /**
     * ...AND THE UNIT CLOSES IT TOO, which is a different claim from the one
     * above and the reason both are here. The assertion above holds the closure
     * for THIS Host: it hands `drive()` a deliberately wide object and reads what
     * survived. But the closure is a mechanism only for the Host that implements
     * it — a second Host doing the obvious `Object.assign(player, patch)`
     * inherits whatever the unit passed, and no assertion in this tree would see
     * it. So the caller names its fields as well, and this is what holds that:
     * `transport.drive({ playbackRate: c.playbackRate, ...(seek || {}) })` was
     * the shipped shape, and a spread makes the write set whatever some future
     * correction happens to carry.
     *
     * L1 is a security property (`SECURITY.md`), not a preference: this channel
     * reaches a `<video>` on somebody else's page.
     *
     * FAILS IF IT CANNOT LOOK: zero `transport.drive(` calls in `embed.js` means
     * the deck no longer drives the player at all, and that is a red here rather
     * than a vacuous pass.
     */
    const driveCalls = [...embedSrc.matchAll(/transport\.drive\([\s\S]{0,240}?\);/g)].map((m) => m[0]);
    const spread = driveCalls.filter((c) => c.includes('...'));
    ok('...AND THE DECK HANDS IT A CLOSED OBJECT: every drive() call in embed.js names its fields, none spreads  '
      + '[entry point: extension/ui/embed.js, comments stripped]',
      driveCalls.length > 0 && spread.length === 0,
      driveCalls.length === 0
        ? 'no `transport.drive(` call in embed.js at all — either the deck stopped driving the player or this scan cannot see it'
        : spread.length
          ? `${spread.length} of ${driveCalls.length} spread into the patch: ${spread.join(' | ').replace(/\s+/g, ' ')} — `
            + 'the write set is then whatever the caller passed, and only this Host would filter it'
          : `${driveCalls.length} calls, all named`);

    framedWin.posted.length = 0;
    deckHost.transport.drive({ muted: true });
    deckHost.transport.requestSpeed(1.5);
    const two = framedWin.posted.map((p) => p.msg);
    ok('...and a mute-only acquire stays mute-only, while the USER\'s speed is a different message with a different type',
      two.length === 2
      && Object.keys(two[0]).sort().join(',') === 'from,muted,type' && two[0].type === 'VDRIVE'
      && two[1].type === 'SPEED' && two[1].rate === 1.5,
      two.map((m) => `${m.type}:${Object.keys(m).sort().join('+')}`).join(' '));

    // ------------------------------------------------- the incoming page wire
    /**
     * ONE LISTENER, TWO GUARDS, AND A ROUTE PER WIRE TYPE — all three the
     * Host's, because all three are facts about the transport rather than about
     * the deck. The source guard is the one that matters: this document is
     * embedded in a page running somebody else's JavaScript and any number of
     * other frames, all of which can postMessage at it.
     *
     * PUSH, NEVER POLL, is what the routing proves here: a registered handler
     * runs on the message, and a poll would have nothing to run on.
     */
    ok('INSTRUMENT CHECK: ui/host.js registered exactly one `message` listener on the window, at module scope',
      framedWin.listeners.length === 1 && framedWin.listeners[0][0] === 'message',
      framedWin.listeners.map(([t]) => t).join(',') || 'none');

    const heard = [];
    deckHost.transport.onState((d) => heard.push(['state', d]));
    deckHost.transport.onJump((d) => heard.push(['jump', d]));
    deckHost.transport.onSpeedReport((d) => heard.push(['speed', d]));
    deckHost.page.onKey((d) => heard.push(['key', d]));
    deckHost.page.onAutonav((d) => heard.push(['autonav', d]));

    /**
     * ALL FIVE ARE CHECKED BY IDENTITY, not four of them by arrival. The name
     * says "the payload arrives as the host sent it"; a routing count wearing
     * that name would be satisfied by a Host that dropped `shift`/`alt` off the
     * KEY payload, or normalised the SPEED verdict, and both of those are silent
     * — the deck would read `shift: undefined` as "no solo" forever.
     */
    const HOSTNS = 'stem-splitter-live-host';
    const WIRE = [
      ['state', { from: HOSTNS, type: 'VIDEO', playing: true, currentTime: 3, duration: 60 }],
      ['jump', { from: HOSTNS, type: 'JUMP' }],
      ['speed', { from: HOSTNS, type: 'SPEED', state: 'ad', why: null }],
      ['key', { from: HOSTNS, type: 'KEY', code: 'Digit1', shift: true, alt: false, repeat: false }],
      ['autonav', { from: HOSTNS, type: 'AUTONAV', state: 'missing' }],
    ];
    for (const [, d] of WIRE) deliver(framedWin, framedWin.parent, d);
    const routed = heard.length === 5 && heard.every(([k], i) => k === WIRE[i][0]);
    const kept = heard.length === 5 && heard.every(([, d], i) => d === WIRE[i][1]);
    ok('EACH WIRE TYPE REACHES ITS OWN DUTY, and all five payloads arrive as the host sent them — the SAME object  '
      + '[entry point: extension/ui/host.js, the module-scope message listener]',
      routed && kept,
      routed && kept
        ? `${heard.map(([k]) => k).join(',')} — same objects`
        : heard.length !== 5
          ? `${heard.length} of 5 delivered`
          : !routed
            ? `routed ${heard.map(([k]) => k).join(',')}, wanted ${WIRE.map(([k]) => k).join(',')}`
            : `the payload was rewritten on the way in for ${heard.filter(([, d], i) => d !== WIRE[i][1]).map(([k]) => k).join(',')}`);

    heard.length = 0;
    deliver(framedWin, { not: 'the host' }, { from: HOSTNS, type: 'VIDEO', playing: false });
    deliver(framedWin, framedWin.parent, { from: 'stem-splitter-live', type: 'VIDEO', playing: false });
    deliver(framedWin, framedWin.parent, { from: HOSTNS, type: 'NOT_A_TYPE' });
    deliver(framedWin, framedWin.parent, null);
    ok('...and nothing else does: another frame on the page, the deck\'s own namespace echoing back, an unknown type, and no data at all',
      heard.length === 0,
      heard.length === 0
        ? '4 refused: wrong source, wrong namespace, unrouted type, null'
        : `${heard.length} got through: ${heard.map(([k]) => k).join(',')}`);
  }
  } catch (e) {
    hostGroupThrew = e;
  } finally {
    // The deck half's two globals. Unconditional `delete` on `chrome` is what
    // the group did at this point before the guard; `window` is only restored if
    // it was ever replaced, so a throw in the ENGINE half leaves the real one
    // exactly as it found it.
    delete globalThis.chrome;
    if (windowStubbed) {
      if (realWindowDesc) Object.defineProperty(globalThis, 'window', realWindowDesc);
      else delete globalThis.window;
    }
  }
  /**
   * THE GROUP RAN TO ITS END. This is the assertion that turns "the conformance
   * report was replaced by a stack trace" into a line someone can read, and it
   * is the one that keeps the three groups after this one running.
   *
   * It counts what got through, because "it threw" and "it threw before it had
   * asserted anything" are different findings and the count is the only thing
   * that separates them.
   */
  ok('group(host) REACHED ITS LAST ASSERTION — a Host that throws anywhere in this report turns THIS red, and the report still prints  '
    + '[entry point: test.js group(\'host\'), the conformance suite docs/VENDORING.md option 3 points a second Host at]',
    hostGroupThrew === null,
    hostGroupThrew === null
      ? `${pass + fail - hostGroupAt} assertions, none of them a crash`
      : `IT THREW after ${pass + fail - hostGroupAt} assertions, so the rest of the report never ran: `
        + String((hostGroupThrew && hostGroupThrew.stack) || hostGroupThrew));
}

// ===========================================================================
if (group('verifyModel')) {
  head('verifyModel — the model pin the UNIT keeps, held over whatever a Host hands over');
  /**
   * WHAT THIS COVERS AND WHY IT IS WORTH A GATE (S7, issue #5).
   *
   * P1 says exactly one network request is ever made and M1 says the weights are
   * data, never script. Both are properties of the UNIT — but until S7 they were
   * enforced by code that also owned `MODEL.url`, so the whole download lived on
   * the unit's side of the seam, and `fetch` plus the Cache API are not
   * `chrome.*`: the S9 unit gate, a grep for `chrome.`, is structurally
   * incapable of seeing a network path shaped like that one. S7 moved the URL to
   * `extension/offscreen/host-pin.js` and left the judgement here. These are the
   * assertions that the judgement really did stay.
   *
   * WHICH KIND OF TEST THIS IS — the RENDERING vs REACHABILITY rule at the head
   * of this file. Reachable by construction, in both halves:
   *
   *   1. `verifyModel` is the SHIPPED function, driven over buffers that are
   *      actually built here rather than described. The pin is a PARAMETER for
   *      exactly this reason — hard-coding the real SHA-256 beside a fabricated
   *      buffer would put a second copy of the pin in this file, which is what
   *      `shared/config.js` exists to prevent. The parametrised pin is computed
   *      from the bytes by the same primitive the function uses, so a control is
   *      needed and there is one: the DEFAULT pin is the shipped one, and the
   *      same bytes fail against it.
   *   2. `loadModel` is the SHIPPED policy, driven over a fake Host whose only
   *      job is to hand over bytes and count how often it was asked. Every claim
   *      about the retry is a COUNT — `modelBytes` calls, `clearModel` calls —
   *      never a clock and never a timeout.
   *
   * The Host's side of the same seam is the `host` group above: that the bytes
   * come from `offscreen/host.js`, and that it never judges them. Neither group
   * alone says the split holds; together they do.
   */
  const { verifyModel, loadModel } = await import('./extension/shared/modelcache.js');
  const { MODEL_SOURCES, modelSourceWord } = await import('./extension/shared/host.js');
  const sha256 = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
  const threwAsync = (p) => p.then(() => null, (e) => String((e && e.message) || e));

  /** Not the real weights, and deliberately not their size — the real pin is never re-typed here. */
  const weights = new Uint8Array(4096);
  for (let i = 0; i < weights.length; i++) weights[i] = (i * 37 + 11) & 0xff;
  const PIN = { sha256: await sha256(weights), bytes: weights.length };

  const wrongContent = Uint8Array.from(weights);
  wrongContent[2048] ^= 0x01;                       // one bit, same length
  const truncated = Uint8Array.from(weights.subarray(0, weights.length - 1));

  const resolved = await verifyModel(weights, PIN).then((v) => v, (e) => e);
  ok('A MATCHING BUFFER RESOLVES, WITH THE BYTES — so a caller can check and use in one expression  '
    + '[entry point: shared/modelcache.js verifyModel(), reached from loadModel() on every load]',
    resolved === weights,
    resolved === weights
      ? `${weights.length} B accepted against the pin computed from them`
      : `verifyModel rejected bytes that match their own pin: ${resolved}`);

  const flippedSha = await sha256(wrongContent);
  const flipped = await threwAsync(verifyModel(wrongContent, PIN));
  ok('ONE FLIPPED BIT IS REFUSED, AND THE MESSAGE NAMES BOTH HASHES — the one it got and the one it wanted',
    flippedSha !== PIN.sha256 && flipped != null && flipped.includes(flippedSha) && flipped.includes(PIN.sha256),
    flipped == null
      ? 'a buffer differing from the pin by one bit was ACCEPTED — this is the check that stands between a corrupt '
        + 'download and InferenceSession.create'
      : flipped);

  const short = await threwAsync(verifyModel(truncated, PIN));
  ok('...and A TRUNCATED BUFFER IS REFUSED NAMING BOTH BYTE COUNTS, not as an unexplained hash mismatch  '
    + '[the byte count is NEW in S7: before it, a cut-short download reported only a sha256 nobody could interpret]',
    short != null && short.includes(String(truncated.length)) && short.includes(String(PIN.bytes))
      && !short.includes('sha256'),
    short == null ? `${truncated.length} of ${PIN.bytes} bytes was ACCEPTED` : short);

  const againstShipped = await threwAsync(verifyModel(weights));
  ok('THE CONTROL: the DEFAULT pin is the SHIPPED one, so the pass above is the pin doing work and not verifyModel accepting anything',
    againstShipped != null && againstShipped.includes(String(MODEL.bytes)),
    againstShipped == null
      ? '4096 fabricated bytes passed as the model — verifyModel() with no pin argument is checking nothing'
      : againstShipped);

  /**
   * THE LOAD POLICY, over a Host that is a byte source and a call counter.
   *
   * The queue is what makes the retry observable: every case below is about what
   * happens on the SECOND ask, and a Host that answered identically twice could
   * not tell "retried once" from "retried never". The counters are the claim.
   */
  const fakeHost = (...queue) => {
    const h = {
      asks: 0,
      clears: 0,
      modelBytes: async (onProgress = () => {}) => {
        const next = queue[Math.min(h.asks, queue.length - 1)];
        h.asks++;
        // A Host announces its own phase before the bytes move — see the
        // `EngineHost.modelBytes` typedef. Reported here so the ordering claim
        // below has something to order against.
        //
        // THE PHASE IS THE ROW'S OWN, NOT DERIVED FROM `fromCache` (#28). The
        // whole finding is that the boolean does not partition the three
        // answers, so a fixture that computed one from the other could not build
        // the case that exposed it: a `bundled` Host, `fromCache: false`, no
        // network.
        if (next.source !== null) onProgress(next.source, next.bytes.length, next.bytes.length);
        return { bytes: next.bytes, fromCache: next.fromCache };
      },
      clearModel: async () => { h.clears++; },
    };
    return h;
  };
  const stored = (bytes) => ({ bytes, fromCache: true, source: 'cache' });
  const wire = (bytes) => ({ bytes, fromCache: false, source: 'download' });
  /** A Host that SHIPS the weights: no cache to drop, no request made. */
  const shipped = (bytes) => ({ bytes, fromCache: false, source: 'bundled' });
  /** A Host that announces no phase at all — the case the wording must not guess at. */
  const silent = (bytes) => ({ bytes, fromCache: false, source: null });

  const clean = fakeHost(stored(weights));
  const cleanOut = await loadModel(clean, () => {}, PIN).then((v) => v, (e) => e);
  // BYTE FOR BYTE, not byteLength: the whole claim of this slice is that the
  // bytes which passed the check are the bytes that reach the worker, and a
  // length is a saturating estimator for it — `new ArrayBuffer(n)` has the right
  // length and none of the content.
  const cleanBytes = cleanOut instanceof Error ? new Uint8Array(0) : new Uint8Array(cleanOut.buffer);
  const cleanSame = cleanBytes.length === weights.length && cleanBytes.every((v, i) => v === weights[i]);
  ok('A GOOD STORED COPY IS STILL VERIFIED, NOTHING IS THROWN AWAY, AND THE BUFFER HANDED ON IS THE ONE THAT WAS CHECKED: 1 ask, 0 clears  '
    + '[entry point: shared/modelcache.js loadModel(), reached from engine.js modelBytes()]',
    !(cleanOut instanceof Error) && clean.asks === 1 && clean.clears === 0
      && cleanOut.fromCache === true && cleanSame,
    cleanOut instanceof Error
      ? `loadModel rejected good bytes: ${cleanOut.message}`
      : !cleanSame
        ? `the buffer handed on is ${cleanBytes.length} B and ${cleanBytes.length === weights.length ? 'differs from' : 'is not'} `
          + 'the bytes that were verified — this is what InferenceSession.create binds over'
        : `${clean.asks} ask, ${clean.clears} clears, ${cleanBytes.length} B identical to the verified bytes, fromCache=${cleanOut.fromCache}`);

  const heals = fakeHost(stored(wrongContent), wire(weights));
  const healed = await loadModel(heals, () => {}, PIN).then((v) => v, (e) => e);
  ok('A CORRUPT STORED COPY COSTS ONE RE-DOWNLOAD AND NOT A DEAD DECK: the store is dropped and the Host asked once more — 2 asks, 1 clear',
    !(healed instanceof Error) && heals.asks === 2 && heals.clears === 1 && healed.fromCache === false,
    healed instanceof Error
      ? `a corrupt stored copy became a permanent failure: ${healed.message} (${heals.asks} asks, ${heals.clears} clears)`
      : `${heals.asks} asks, ${heals.clears} clear, fromCache=${healed.fromCache}`);

  const offWire = fakeHost(wire(wrongContent));
  const wireOut = await threwAsync(loadModel(offWire, () => {}, PIN));
  ok('...but BYTES STRAIGHT OFF THE WIRE ARE NOT ASKED FOR TWICE — a second 109 MB fails the same way, so it throws after 1 ask',
    wireOut != null && wireOut.includes(PIN.sha256) && offWire.asks === 1 && offWire.clears === 1,
    wireOut == null
      ? `corrupt bytes off the wire were ACCEPTED (${offWire.asks} asks)`
      : `${offWire.asks} ask, ${offWire.clears} clear — ${wireOut}`);

  const rotten = fakeHost(stored(wrongContent));
  const rottenOut = await threwAsync(loadModel(rotten, () => {}, PIN));
  ok('AND NEVER A THIRD ATTEMPT: a Host that keeps handing back the same corrupt bytes fails at 2 asks rather than downloading for ever',
    rottenOut != null && rotten.asks === 2 && rotten.clears === 2,
    rottenOut == null
      ? `corrupt bytes were ACCEPTED on the retry (${rotten.asks} asks)`
      : `${rotten.asks} asks, ${rotten.clears} clears — ${rottenOut}`);

  /**
   * #28 — THE PROVENANCE, ALL THREE VALUES OF IT, ACROSS THE SEAM.
   *
   * `fromCache` is a two-valued answer to a three-valued question. It stays what
   * it always was — the retry decision, rule 3 of `EngineHost` — and the SOURCE
   * now travels beside it, taken off the phase the Host announces before any
   * bytes move. The case that matters is the third one: a Host that ships the
   * weights in its installer reports `fromCache: false` honestly, and every
   * consumer that read the boolean as provenance said "downloaded" about a file
   * no request ever touched.
   *
   * THREE HOSTS, THREE ANSWERS, DRIVEN THROUGH THE SHIPPED `loadModel`. The
   * counts ride along because a source that arrived by spending a retry would
   * be the wrong finding reported as the right one.
   *
   * ---- U8, #28: THE FIVE MUTATIONS THESE ASSERTIONS ARE HELD AGAINST -------
   * Runnable, and re-run against `main` rather than trusted from branch time
   * (`INTEGRATION.md` §18 — a battery is only valid against the source it was
   * cut for, and nothing announces the day that stops being true):
   *
   *     node tools/mutations/u8-seam-fixes.mjs M5 M6 M7 M8 M9
   *
   * ANCHORS CUT AGAINST `5993d32`. `made at` names the anchor TEXT, because a
   * line number decays a slice sooner than the code does. Counts are this
   * group's, whose clean total is 22.
   *
   *   #    mutation                                        | made at                                | red here, and the control
   *   -----+--------------------------------------------------+----------------------------------------+-------------------------
   *   M5   loadModel stops recording the announced phase   | modelcache.js `hasOwnProperty…, phase)` | "ALL THREE PROVENANCE VALUES CROSS THE SEAM", "…SHIPPED-WITH-THE-HOST case reports", "…a HEAL reports the attempt that SERVED". Control: the unannounced-Host assertion still PASSES.   19/3
   *   M6   MODEL_SOURCES.bundled is worded 'downloaded'    | shared/host.js `bundled:`               | "…SHIPPED-WITH-THE-HOST case reports", "…the three READ differently". Control: all three still cross the seam.   20/2
   *   M7   modelSourceWord guesses 'downloaded' again      | shared/host.js the `:` fallback branch  | "A HOST THAT ANNOUNCES NO PHASE IS QUOTED AS NAMING NO SOURCE". Control: all three still cross the seam.   21/1
   *   M8   loadModel keeps `source` across attempts        | modelcache.js `source = null;` in the loop | "…it never INHERITS the dropped attempt's phase". Control: the plain heal still PASSES.   21/1
   *   M9   two MODEL_SOURCES members read the same         | shared/host.js `cache:`                 | "…the three READ differently". Control: the bundled case still PASSES.   21/1
   *
   * M8 IS THE ROW THAT NEEDED A SECOND FIXTURE AND SAYS SO. Against the plain
   * heal it first went GREEN: when the second ask announces a phase, that
   * announcement overwrites the first whether or not anything was reset, so the
   * assertion had no dynamic range for the thing it claimed. The discriminating
   * fixture — a heal whose second ask announces NOTHING — is the one below, and
   * M8 is red against it. A mutation that will not go red is a finding about the
   * assertion, not about the mutation.
   */
  const sources = {};
  for (const [name, row] of [['cache', stored], ['download', wire], ['bundled', shipped]]) {
    const h = fakeHost(row(weights));
    const out = await loadModel(h, () => {}, PIN).then((v) => v, (e) => e);
    sources[name] = { out, asks: h.asks };
  }
  const eachRight = Object.entries(sources).every(([name, r]) => !(r.out instanceof Error)
    && r.out.source === name && r.asks === 1);
  ok('ALL THREE PROVENANCE VALUES CROSS THE SEAM — a Host cache, the network, and weights that SHIPPED WITH THE HOST, each reported as itself in 1 ask  '
    + '[entry point: shared/modelcache.js loadModel(), reached from engine.js loadOnce()]',
    eachRight,
    eachRight
      ? Object.entries(sources).map(([n, r]) => `${n} -> ${JSON.stringify(r.out.source)} (${r.asks} ask)`).join(', ')
      : Object.entries(sources).map(([n, r]) => `${n} -> ${r.out instanceof Error
        ? `REJECTED ${r.out.message}` : `${JSON.stringify(r.out.source)} in ${r.asks} ask(s)`}`).join(', '));

  /**
   * ...AND THE BUNDLED CASE IS THE ONE THE OLD BOOLEAN GOT WRONG, so it gets its
   * own assertion rather than being one row of the loop above. It is the whole
   * of issue #28: `fromCache` is honestly `false`, and every reading of that as
   * "then it was downloaded" contradicts P1 in the one place a user checks it.
   */
  const bundledOut = sources.bundled.out;
  const bundledWords = bundledOut instanceof Error ? '' : modelSourceWord(bundledOut.source);
  ok('...and the SHIPPED-WITH-THE-HOST case reports `fromCache: false` AND is not worded as a download — the two facts that used to be one boolean  '
    + '[entry point: shared/host.js modelSourceWord(), quoted by engine.js loadOnce()]',
    !(bundledOut instanceof Error) && bundledOut.fromCache === false && bundledOut.source === 'bundled'
      && bundledWords === MODEL_SOURCES.bundled && !/download/i.test(bundledWords),
    bundledOut instanceof Error
      ? `loadModel rejected a bundled Host: ${bundledOut.message}`
      : /download/i.test(bundledWords)
        ? `a Host that shipped its weights is told: "weights ${bundledWords}" — that is the defect, in the words of the fix`
        : `fromCache=${bundledOut.fromCache}, source=${JSON.stringify(bundledOut.source)}, worded "weights ${bundledWords}"`);

  /**
   * THE THREE WORDS ARE THREE WORDS. A vocabulary whose members read alike is a
   * vocabulary that partitions nothing: the assertion above would pass over a
   * `MODEL_SOURCES` in which `bundled` and `cache` were the same sentence, and
   * the user would be no better off than with the boolean.
   */
  const words = Object.keys(MODEL_SOURCES).map((k) => modelSourceWord(k));
  ok('...and the three READ differently, so the partition survives contact with a reader  '
    + '[entry point: shared/host.js MODEL_SOURCES, the vocabulary a Host picks its phase out of]',
    words.length === 3 && new Set(words).size === 3 && words.every((w) => typeof w === 'string' && w.length > 0),
    `${words.length} member(s), ${new Set(words).size} distinct: ${words.map((w) => JSON.stringify(w)).join(', ')}`);

  /**
   * A HOST THAT ANNOUNCES NOTHING IS SAID TO HAVE ANNOUNCED NOTHING. The defect
   * being fixed was a GUESS — "not a cache hit, therefore downloaded" — and
   * answering an unannounced source with any of the three real ones is the same
   * guess with a longer vocabulary. This is also the one case the loop above
   * cannot reach, because every row in it announces.
   */
  const mute = fakeHost(silent(weights));
  const muteOut = await loadModel(mute, () => {}, PIN).then((v) => v, (e) => e);
  const muteWords = muteOut instanceof Error ? '' : modelSourceWord(muteOut.source);
  ok('A HOST THAT ANNOUNCES NO PHASE IS QUOTED AS NAMING NO SOURCE, not as having downloaded 109 MB',
    !(muteOut instanceof Error) && muteOut.source === null
      && muteWords.length > 0 && !/download/i.test(muteWords) && !Object.values(MODEL_SOURCES).includes(muteWords),
    muteOut instanceof Error
      ? `loadModel rejected a Host that announced nothing: ${muteOut.message}`
      : `source=${JSON.stringify(muteOut.source)}, worded "weights ${muteWords}"`);

  /**
   * A HEAL REPORTS THE SOURCE THAT ACTUALLY SERVED, not the one that was thrown
   * away: the bad `cache` copy is dropped and the good bytes come off the wire,
   * and wording the line "from this Host's store" would name the copy that just
   * failed.
   */
  const healSrc = fakeHost(stored(wrongContent), wire(weights));
  const healSrcOut = await loadModel(healSrc, () => {}, PIN).then((v) => v, (e) => e);
  ok('...and a HEAL reports the attempt that SERVED, not the one that was dropped  '
    + '[entry point: shared/modelcache.js loadModel(), the retry loop]',
    !(healSrcOut instanceof Error) && healSrc.asks === 2 && healSrcOut.source === 'download'
      && healSrcOut.fromCache === false,
    healSrcOut instanceof Error
      ? `the heal failed: ${healSrcOut.message}`
      : `${healSrc.asks} asks, source=${JSON.stringify(healSrcOut.source)}, fromCache=${healSrcOut.fromCache}`);

  /**
   * ...AND IT DOES NOT INHERIT ONE EITHER, which is the case the assertion above
   * cannot see: when the second ask announces a phase, that announcement
   * overwrites the first whether or not anything was reset, so a `loadModel`
   * with no per-attempt reset passes it. The discriminating fixture is a heal
   * whose SECOND ask announces NOTHING — then a kept `source` reports `'cache'`,
   * naming the copy that was just deleted for failing its hash.
   */
  const healQuiet = fakeHost(stored(wrongContent), silent(weights));
  const healQuietOut = await loadModel(healQuiet, () => {}, PIN).then((v) => v, (e) => e);
  ok('...and it never INHERITS the dropped attempt\u2019s phase — `source` is reset per attempt, so an ask that announces nothing reports nothing  '
    + '[entry point: shared/modelcache.js loadModel(), the top of the retry loop]',
    !(healQuietOut instanceof Error) && healQuiet.asks === 2 && healQuietOut.source === null,
    healQuietOut instanceof Error
      ? `the heal failed: ${healQuietOut.message}`
      : healQuietOut.source === 'cache'
        ? 'the load reports `cache` — that is the copy it just deleted for failing its hash'
        : `${healQuiet.asks} asks, source=${JSON.stringify(healQuietOut.source)}`);

  /**
   * WHAT THE HOST HANDED OVER MUST BE WHAT THE WORKER GETS — rule 2 of
   * `EngineHost`'s model bytes, and the one rule of the three that the unit can
   * be made to check for itself.
   *
   * `loadModel` verifies `got.bytes` and hands on `got.bytes.buffer`. Those are
   * the same bytes only if the view owns the whole buffer, so a Host that hands
   * over a VIEW passes the identity check and the worker then binds a session
   * over something else entirely — a green integrity check followed by an ORT
   * error with no visible connection to it. That is not an exotic Host: it is
   * `subarray`, and it is `Buffer.concat` off Node's pool, i.e. what the first
   * Electron implementation of this duty returns.
   *
   * The rule was written down in `shared/host.js` and enforced nowhere: its only
   * check was the host-group assertion above, against the Chrome Host that is
   * being replaced. These drive the SHIPPED `loadModel` over Hosts that break it
   * in each of the three ways, and every one of them is a COUNT — 1 ask, 0
   * clears — because a Host defect is not a corrupt store and must not spend a
   * retry.
   */
  const backing = new Uint8Array(weights.length * 2);
  backing.set(weights, 1024);
  const view = backing.subarray(1024, 1024 + weights.length);
  const viewVerifies = await verifyModel(view, PIN).then((v) => v === view, () => false);
  const viewHost = fakeHost(stored(view));
  const viewOut = await threwAsync(loadModel(viewHost, () => {}, PIN));
  ok('A HOST THAT HANDS OVER A VIEW IS REFUSED — EVEN THOUGH THOSE BYTES THEMSELVES VERIFY: the unit hashes `bytes` and TRANSFERS `bytes.buffer`, so a slice means the worker loads bytes nobody checked  '
    + '[entry point: shared/modelcache.js loadModel(); the transfer is offscreen/deck.js LOAD_MODEL]',
    viewVerifies && viewOut != null && viewOut.includes('1024') && viewOut.includes(String(backing.length))
      && viewHost.asks === 1 && viewHost.clears === 0,
    !viewVerifies
      ? 'the fixture is wrong: these bytes do not pass verifyModel, so the refusal below would prove nothing'
      : viewOut == null
        ? `${weights.length} verified bytes at offset 1024 of a ${backing.length} B buffer were ACCEPTED — loadModel `
          + `hands the worker all ${backing.length} B, and the check that just passed said nothing about them`
        : `${viewHost.asks} ask, ${viewHost.clears} clears — ${viewOut}`);

  const rawHost = fakeHost({ bytes: Uint8Array.from(weights).buffer, fromCache: true });
  const rawOut = await threwAsync(loadModel(rawHost, () => {}, PIN));
  ok('...and an ArrayBuffer where a Uint8Array was meant is NAMED, not hashed as if it were the weights — `crypto.subtle.digest` accepts both, so this one otherwise fails as `undefined bytes` against the pin',
    rawOut != null && rawOut.includes('Uint8Array') && rawOut.includes('ArrayBuffer') && !rawOut.includes('undefined')
      && rawHost.asks === 1 && rawHost.clears === 0,
    rawOut == null
      ? 'a bare ArrayBuffer was accepted as the model bytes'
      : `${rawHost.asks} ask, ${rawHost.clears} clears — ${rawOut}`);

  const memoHost = fakeHost(stored(Uint8Array.from(weights)));
  const firstLoad = await loadModel(memoHost, () => {}, PIN).then((v) => v, (e) => e);
  // Exactly what `offscreen/deck.js`'s LOAD_MODEL does with the buffer it is
  // handed — and what makes the Host's own array 0 bytes long.
  if (!(firstLoad instanceof Error)) structuredClone(firstLoad.buffer, { transfer: [firstLoad.buffer] });
  const detached = await threwAsync(loadModel(memoHost, () => {}, PIN));
  ok('...and a Host that MEMOIZES its bytes is told which of the two mistakes it made, instead of being blamed for a 0-byte model: the transfer detaches the array it kept, and with two decks there is always a next load',
    !(firstLoad instanceof Error) && detached != null && /transferred/i.test(detached)
      && !detached.includes('integrity') && memoHost.asks === 2 && memoHost.clears === 0,
    firstLoad instanceof Error
      ? `the first load failed before the transfer could happen: ${firstLoad.message}`
      : detached == null
        ? 'a detached buffer was accepted as the model'
        : `${memoHost.asks} asks, ${memoHost.clears} clears — ${detached}`);

  /**
   * A CLEAR THAT FAILS IS ORDINARY FOR A SECOND HOST — a locked file on
   * Windows, an IPC round trip, a read-only bundle — and it must not become the
   * error the user is shown. `bad` is the reason the store was being dropped,
   * and it is the only thing anyone can act on.
   */
  const clearFails = fakeHost(stored(wrongContent));
  clearFails.clearModel = async () => { clearFails.clears++; throw new Error('EBUSY: could not delete the model store'); };
  const clearFailed = await threwAsync(loadModel(clearFails, () => {}, PIN));
  ok("...and a Host whose clearModel REJECTS still reports the integrity failure, not the clear's own error — and still spends its retry: 2 asks, 2 clears",
    clearFailed != null && clearFailed.includes(PIN.sha256) && !clearFailed.includes('EBUSY')
      && clearFails.asks === 2 && clearFails.clears === 2,
    clearFailed == null
      ? `corrupt bytes were ACCEPTED when the clear failed (${clearFails.asks} asks)`
      : `${clearFails.asks} asks, ${clearFails.clears} clears — ${clearFailed}`);

  const phases = [];
  // `.then(() => {}, () => {})` and not a bare await: a rejection here would end
  // the process before `ok()` ran, taking the assertions after it AND the
  // suite's summary line with it — which is the same rule the `probe` helper in
  // the `host` group exists for, applied to the one call that had escaped it.
  await loadModel(fakeHost(stored(weights)), (phase) => phases.push(phase), PIN).then(() => {}, () => {});
  ok("...and the load announces 'verify' AFTER the Host's own phase, so the deck's progress card can say what the wait past the last byte is for",
    phases.length === 2 && phases[0] === 'cache' && phases[1] === 'verify',
    phases.length ? phases.join(' -> ') : 'the loader reported no progress at all');

  /**
   * THE UNIT NAMES NO MODEL URL — the checkbox this slice exists for, asserted
   * rather than promised.
   *
   * A `grep`, deliberately, and over the RAW text rather than with comments
   * stripped: the claim is that knowledge of where the bytes come from lives in
   * ONE file, and a comment in `shared/config.js` naming the upstream host is a
   * second copy of that knowledge even when it is not a code path. Prose in the
   * unit that needs to refer to it says "the pinned upstream host".
   *
   * FAILS IF IT CANNOT LOOK, which is the failure this shape is most prone to:
   * the needle is read out of the pin itself so it cannot go stale, and the one
   * file ALLOWED to contain it must actually contain it. A scan for a string
   * nothing has would otherwise report a clean unit most confidently at the
   * moment it stopped looking at anything.
   *
   * `extension/manifest.json` is not scanned and must not be: `host_permissions`
   * and the CSP `connect-src` name the same origin because MV3 refuses the fetch
   * otherwise, and the manifest is the extension HOST's declaration about
   * itself. `offscreen/host-pin.js` says so, next to the URL.
   */
  const { readFileSync: readSrc, readdirSync } = await import('node:fs');
  const PIN_FILE = 'extension/offscreen/host-pin.js';
  const ORIGIN = new URL((await import('./extension/offscreen/host-pin.js')).MODEL_URL).hostname;
  const walk = (dir, out = []) => {
    for (const e of readdirSync(new URL(`./${dir}/`, import.meta.url), { withFileTypes: true })) {
      if (e.name === 'vendor' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, out);
      else if (e.name.endsWith('.js')) out.push(`${dir}/${e.name}`);
    }
    return out;
  };
  const jsFiles = walk('extension');
  const namesOrigin = jsFiles.filter((f) => readSrc(new URL(`./${f}`, import.meta.url), 'utf8').includes(ORIGIN));
  ok(`NO FILE UNDER extension/ NAMES THE MODEL'S UPSTREAM HOST EXCEPT ${PIN_FILE} — that move is what took the network path out of the unit  `
    + '[entry point: a grep over every .js under extension/, vendor excluded; the needle is read out of the pin]',
    jsFiles.length > 10 && namesOrigin.length === 1 && namesOrigin[0] === PIN_FILE,
    jsFiles.length <= 10
      ? `only ${jsFiles.length} files were scanned — this walk is not seeing extension/`
      : namesOrigin.includes(PIN_FILE)
        ? `${jsFiles.length} files scanned, ${ORIGIN} in ${namesOrigin.join(', ')}`
        : `${PIN_FILE} does not contain ${ORIGIN} — the scan is looking for a string nothing has, so it proves nothing`);

  const unitSrc = readSrc(new URL('./extension/shared/modelcache.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('...and the unit module the bytes pass through says neither `fetch` nor `caches` — the two words no `chrome.` grep would have caught  '
    + '[entry point: extension/shared/modelcache.js, comments stripped]',
    unitSrc.includes('verifyModel') && !/\bfetch\s*\(/.test(unitSrc) && !/\bcaches\b/.test(unitSrc),
    !unitSrc.includes('verifyModel')
      ? 'verifyModel is not in this file — the scan is reading the wrong module'
      : `${unitSrc.split('\n').filter((l) => l.trim()).length} lines of code, no fetch and no Cache API`);

}

// ===========================================================================
if (group('backend')) {
  head('backend — the seam serialises: one call in flight per backend, FIFO, and no caller can wedge a session');
  /**
   * WHAT THIS COVERS AND WHY IT IS WORTH A GATE.
   *
   * `workers/inference.worker.js:10-12`: "one session, one in-flight run().
   * ORT-Web serialises run() across all sessions on a wasm instance, and a
   * rejected concurrent call permanently wedges the session." Not slow — DEAD,
   * for the life of the worker. Seed §16 made that the SEAM'S contract rather
   * than one backend's private rule ("the seam serialises calls; no caller can
   * wedge a session"), and `shared/host.js` is that sentence.
   *
   * WHICH KIND OF TEST THIS IS — the RENDERING vs REACHABILITY rule at the head
   * of this file. Reachable by construction on the mechanism, rendering-only on
   * the consequence, and the split is deliberate:
   *   - the SHIPPED `serialiseBackend` is driven. Nothing below reimplements the
   *     queue, so deleting it turns this group red.
   *   - the BACKEND is fake, because the thing being asserted is that the
   *     wrapper never lets a second call reach it, and a real ORT session cannot
   *     be asked to report that: its answer to being re-entered is to wedge and
   *     stop answering anything. The fake COUNTS instead.
   *   - reached by: `offscreen/deck.js` `ensureBackend()` is the only caller of
   *     `serialiseBackend` in the tree, asserted below by reading it, and S8
   *     (#9) drives the same wrapper over a fake worker port that throws on
   *     INFER-while-busy the way the real one does.
   *
   * NOT ONE ASSERTION HERE READS A CLOCK. Every claim is a count: how many calls
   * were inside the backend at once, in what order they arrived, how many
   * results came back. A stopwatch would be measuring the machine's load.
   */
  const { serialiseBackend } = await import('./extension/shared/host.js');

  /**
   * A backend that RECORDS rather than separates.
   *
   * `yields` is how many microtask turns each call spends inside. It is what
   * makes overlap observable without a clock: every unserialised call increments
   * `inFlight` before any of them yields, so eight concurrent calls read eight,
   * deterministically, on any machine. One is the only other answer available.
   */
  const fakeBackend = (yields = 3) => {
    const st = { inFlight: 0, maxInFlight: 0, entered: [], loads: 0, disposed: 0 };
    const enter = async (tag) => {
      st.inFlight++;
      if (st.inFlight > st.maxInFlight) st.maxInFlight = st.inFlight;
      st.entered.push(tag);
      for (let i = 0; i < yields; i++) await Promise.resolve();
      st.inFlight--;
    };
    return {
      st,
      backend: {
        load: async (bytes) => { st.loads++; await enter('load'); return { ep: 'fake', createMs: 0, warmupMs: 0, bytes }; },
        separate: async (mix, out) => {
          await enter(`separate:${mix.byteLength}`);
          return { mix, stems: out, prepMs: 0, inferMs: 0, postMs: 0 };
        },
        dispose: async () => { st.disposed++; },
      },
    };
  };

  // ---------------------------------------------------- 8 concurrent separate()
  {
    const f = fakeBackend();
    const b = serialiseBackend(f.backend, 'fake');
    // Each call carries a DIFFERENT buffer size, so the order the backend saw
    // and the results the callers got are both identifiable without a clock and
    // without an index the wrapper could have preserved by accident.
    const mixes = Array.from({ length: 8 }, (_, i) => new ArrayBuffer(8 + i));
    const outs = Array.from({ length: 8 }, (_, i) => new ArrayBuffer(64 + i));
    const results = await Promise.all(mixes.map((m, i) => b.separate(m, outs[i])));

    ok('AT MOST ONE separate() IS INSIDE THE BACKEND, ACROSS 8 CONCURRENT CALLS  '
      + '[entry point: extension/shared/host.js serialiseBackend(), reached from deck.js Deck.ensureBackend()]',
      f.st.maxInFlight === 1,
      f.st.maxInFlight === 1
        ? '8 calls, max 1 in flight'
        : `${f.st.maxInFlight} were in flight at once — with a real ORT session that is a permanently wedged worker, `
          + 'not a slow one');

    const order = f.st.entered.join(',');
    const expected = mixes.map((m) => `separate:${m.byteLength}`).join(',');
    ok('...AND THEY REACH IT IN CALL ORDER — FIFO, because LivePipeline submits chunk k before k+1 and LiveEmitter refuses a non-contiguous chunk',
      order === expected, order === expected ? `8 in order: ${order}` : `${order}  (expected ${expected})`);

    const backAsGiven = results.every((r, i) => r.mix === mixes[i] && r.stems === outs[i]);
    ok('...AND ALL 8 RESOLVE, each with the buffers ITS OWN call lent  '
      + '[entry point: extension/shared/host.js serialiseBackend()]',
      results.length === 8 && backAsGiven,
      results.length !== 8
        ? `${results.length} results came back, not 8`
        : backAsGiven
          ? '8 results, each carrying its own mix and out'
          : 'a caller was handed another call’s buffers — the queue crossed two segments over');
  }

  // ------------------------------------------- load() is in the SAME queue
  /**
   * THE GAP THE WORKER'S OWN GUARD DOES NOT COVER, and the reason this queue
   * spans two methods rather than one.
   *
   * `inference.worker.js:99` guards INFER with `busy`, and nothing else touches
   * it — so the warm-up inference LOAD_MODEL runs at `:67-71` is OUTSIDE it, and
   * `self.onmessage` is `async` with no queueing behind an outstanding `await`.
   * An INFER arriving during the warm-up wedges the session. It is unreachable
   * today only because `Deck.ensureSession()` is awaited before `infer()` ever
   * runs, which is an ordering the DECK enforces and the worker does not.
   */
  {
    const f = fakeBackend();
    const b = serialiseBackend(f.backend, 'fake');
    const both = await Promise.all([
      b.load(new ArrayBuffer(4)),
      b.separate(new ArrayBuffer(9), new ArrayBuffer(99)),
    ]);
    ok('load() AND separate() SHARE ONE QUEUE — an inference during the model warm-up is the one overlap the worker’s own `busy` guard cannot see  '
      + '[entry point: extension/shared/host.js serialiseBackend()]',
      f.st.maxInFlight === 1 && f.st.entered.join(',') === 'load,separate:9' && both.length === 2,
      f.st.maxInFlight === 1
        ? `entered ${f.st.entered.join(',')}`
        : `${f.st.maxInFlight} in flight at once: ${f.st.entered.join(',')}`);
  }

  // -------------------------------------------------- dispose() is NOT queued
  /**
   * THE ONE DELIBERATE HOLE IN THE QUEUE, asserted so nobody closes it as a
   * tidy-up. Teardown is exactly when a backend that has stopped answering has
   * to be stopped anyway: queueing `dispose()` behind a hung `separate()` makes
   * the hang permanent, and under this Host that leaves the user's tab muted for
   * as long as the document lives (R5). `WorkerBackend.dispose()` terminates
   * unconditionally, so there is no ordering for a queue to protect either.
   */
  {
    const f = fakeBackend();
    let hung = null;
    f.backend.separate = () => new Promise((res) => { hung = res; });
    const b = serialiseBackend(f.backend, 'fake');
    const never = b.separate(new ArrayBuffer(8), new ArrayBuffer(8));
    // THE CALL IS LET INTO THE BACKEND FIRST, and that is what this block is
    // about: the queue dispatches one microtask turn after the call is made, so
    // disposing in the SAME turn would test a call still sitting in the queue —
    // which S8 (#9) made the wrapper refuse itself, and which is a different
    // claim, gated in tools/seam-check.mjs. `hung !== null` below is what says
    // the call really is inside the backend and not merely submitted.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    // NOT awaited: a queued `dispose()` would never settle behind a `separate()`
    // that never lands, and this suite would HANG rather than report. A hang is
    // the same defect wearing a worse costume — verify.mjs would kill the step
    // with no assertion name attached to it. Counting after a few turns of the
    // microtask queue makes the same mutation a FAIL that says what it is.
    const disposing = b.dispose();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    ok('dispose() IS NOT QUEUED — a backend that has stopped answering must still be stoppable  '
      + '[entry point: extension/shared/host.js serialiseBackend(), reached from deck.js Deck.dispose() and engine.js onTeardown]',
      f.st.disposed === 1 && hung !== null,
      hung === null
        ? 'the separate() never reached the backend, so nothing was outstanding and this inspected nothing'
        : f.st.disposed === 1
          ? 'disposed while a separate() was still outstanding'
          : 'dispose() waited behind an inference that never lands — teardown hangs and the tab stays muted');
    // The wrapper settles what it still owes at `dispose()` (S8, #9), so `never`
    // is ALREADY REJECTED — the fake's own resolution below lands on a promise
    // nobody is waiting on any more. Adopted rather than awaited bare, because
    // `await never` is now an unhandled rejection that would kill the suite.
    if (hung) hung({ mix: new ArrayBuffer(8), stems: new ArrayBuffer(8), prepMs: 0, inferMs: 0, postMs: 0 });
    await never.then(() => {}, () => {});
    await disposing;
  }

  // ------------------------------------------------ a worker that died under it
  /**
   * THE THREE THINGS A DEAD WORKER MUST DO, all of which used to live in
   * `offscreen/deck.js` and moved into `workers/workerbackend.js` with the seam.
   * A port is exactly where behaviour goes missing quietly, and none of the
   * three had an assertion on either side of the move.
   *
   *   1. EVERY PENDING CALL REJECTS. Review finding M1: a failure that does not
   *      arrive as `{type:'ERROR'}` — a module load failure, an uncaught
   *      rejection, an OOM that kills the worker — leaves entries nothing will
   *      ever settle, and `await separate(...)` then hangs for ever with no
   *      cancel path. Nothing times it out; nothing else would notice.
   *   2. THE NEXT `separate()` REFUSES WITH THE RECORDED REASON, and does not
   *      spawn a replacement. A worker that cannot resolve its imports dies
   *      identically every time, so one per chunk is what re-spawning here
   *      buys — and the failure ladder never sees a stable error to halt on.
   *   3. `load()` DOES REPLACE IT. That is the pre-seam asymmetry:
   *      `ensureSession()` called `ensureWorker()` (which spawned) and `infer()`
   *      called `requireWorker()` (which refused), so a worker killed for memory
   *      cost the user one gesture rather than a reload. `load()` is once per
   *      gesture; `separate()` is once per 1.95 s.
   *
   * The SHIPPED `WorkerBackend` is driven over a stubbed `Worker` and `fetch`.
   * The stub is the only thing a browser would have supplied — there is no fake
   * backend here, which is the point: this block is about the real one.
   */
  {
    const { WorkerBackend } = await import('./extension/workers/workerbackend.js');
    const spawnedHere = [];
    const failures = [];
    const realWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const realFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    let pendingRejected = null;
    let lentMix = null;
    let lentOut = null;
    let refused = null;
    let reloaded = null;
    let spawnedByRefusal = null;
    try {
      globalThis.Worker = class {
        constructor(url) {
          this.url = String(url); this.onmessage = null; this.onerror = null;
          this.posts = [];
          // THE TRANSFER LIST, recorded beside the message. It is the whole of
          // the difference between LENDING 19.3 MB per hop and COPYING it, and
          // a postMessage that dropped it is invisible to everything else here:
          // the message arrives, the worker answers, the deck goes green.
          this.xfers = [];
          spawnedHere.push(this);
        }
        postMessage(m, transfer) { this.posts.push(m); this.xfers.push(transfer || []); }
        terminate() {}
      };
      Object.defineProperty(globalThis, 'fetch', {
        value: async () => ({ ok: true }), configurable: true, writable: true,
      });
      const wb = new WorkerBackend({
        assetUrl: (rel) => `stub://unit/${rel}`,
        name: 'deck A',
        onFail: (e) => failures.push(e.message),
      });
      // In flight when the worker goes: nothing on the wire will ever answer it.
      //
      // RECORDED, NOT AWAITED. The mutation this assertion exists to catch — a
      // `die()` that does not reject the pending map — leaves this promise
      // pending for ever, and `await` on it would HANG the suite instead of
      // failing one line. A hang is the same defect wearing a worse costume:
      // verify.mjs kills the step with no assertion name attached to it.
      //
      // The two buffers are NAMED because the INFER assertion below identifies
      // them in the transfer list rather than counting entries: a list of two
      // that carries something else is the same bug with a passing count.
      lentMix = new ArrayBuffer(8);
      lentOut = new ArrayBuffer(64);
      let settled = null;
      wb.separate(lentMix, lentOut).then(() => { settled = '(it RESOLVED)'; }, (e) => { settled = e.message; });
      // A module worker that cannot resolve its static import fires `onerror`
      // with an EMPTY message — the exact shape that used to reach the deck.
      spawnedHere[0].onerror({ message: '' });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      pendingRejected = settled;
      // Recorded rather than awaited, for the reason above: the mutation here is
      // a `separate()` that spawns a replacement, and THAT call would sit
      // unanswered for ever because nothing ever posts it a RESULT.
      let refusedMsg = null;
      wb.separate(new ArrayBuffer(8), new ArrayBuffer(8)).then(() => { refusedMsg = '(it was ACCEPTED)'; }, (e) => { refusedMsg = e.message; });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      refused = refusedMsg;
      // The count AT THIS INSTANT is the half that says "and did not spawn one":
      // by the end of the block `load()` has legitimately made a second worker,
      // so a total taken later cannot tell the two apart.
      spawnedByRefusal = spawnedHere.length;
      const loading = wb.load(new ArrayBuffer(4)).then(() => 'ok', (e) => e.message);
      // Wait for LOAD_MODEL to be ON the replacement rather than for the
      // replacement to exist: `spawn()` is synchronous and the post is three
      // awaits later, so counting workers would answer MODEL_READY into a gate
      // that is not open yet and the load would hang.
      const loadPosted = () => spawnedHere.length === 2 && spawnedHere[1].posts.some((m) => m && m.type === 'LOAD_MODEL');
      for (let i = 0; i < 200 && !loadPosted(); i++) await new Promise((r) => setTimeout(r, 0));
      if (loadPosted() && spawnedHere[1].onmessage) {
        spawnedHere[1].onmessage({ data: { type: 'MODEL_READY', ep: 'stub', createMs: 0, warmupMs: 0 } });
      }
      reloaded = await loading;
    } finally {
      if (realWorker) Object.defineProperty(globalThis, 'Worker', realWorker); else delete globalThis.Worker;
      if (realFetch) Object.defineProperty(globalThis, 'fetch', realFetch); else delete globalThis.fetch;
    }

    ok('A WORKER THAT DIES REJECTS EVERY CALL IN FLIGHT — nothing on the wire would ever answer them  '
      + "[entry point: extension/workers/workerbackend.js die(), reached from the worker's onerror]",
      pendingRejected != null && pendingRejected.includes('deck A'),
      pendingRejected == null
        ? 'the in-flight separate() is still pending after the worker died — with no timeout anywhere, '
          + 'LivePipeline.runChunk awaits it for ever and the deck stops without saying anything'
        : pendingRejected);

    ok('...and it is ANNOUNCED, because at that moment nothing else is listening  '
      + '[entry point: the createBackend() `onFail` hook, reached from deck.js Deck.ensureBackend()]',
      failures.length === 1 && failures[0].includes('deck A'),
      failures.length === 0
        ? 'the death was silent — the deck goes on reporting a session it no longer has until the next arm'
        : failures.join(' | '));

    ok('...and the NEXT separate() refuses with the recorded reason rather than spawning a replacement per chunk  '
      + '[entry point: extension/workers/workerbackend.js require(), reached from Deck.infer() inside gpu.run()]',
      refused != null && refused.includes('deck A') && spawnedByRefusal === 1,
      refused == null
        ? 'separate() neither resolved nor rejected — a backend with no worker swallowed the call'
        : spawnedByRefusal !== 1
          ? `separate() spawned a replacement (${spawnedByRefusal} workers by then) — a worker that cannot resolve `
            + 'its imports dies identically every time, so that is one per capture tick and a ladder that never '
            + 'sees a stable error to halt on'
          : refused);

    ok('...while load() DOES replace it — a worker killed for memory costs one gesture, not a reload  '
      + '[entry point: extension/workers/workerbackend.js spawn(), reached from Deck.ensureSession()]',
      spawnedHere.length === 2 && reloaded === 'ok',
      spawnedHere.length !== 2
        ? `${spawnedHere.length} worker(s) were spawned in all — load() did not replace the dead one, so an OOM `
          + 'is terminal until the offscreen document is reloaded'
        : reloaded !== 'ok'
          ? `the replacement never loaded: ${reloaded}`
          : '2 workers in all: one dead, one replacement, and none spawned by separate()');

    /**
     * AND THE PER-HOP BUFFERS ARE LENT, NOT COPIED — the half of the zero-copy
     * contract that is paid once per 1.95 s, and the one the unit suite could
     * not see until now.
     *
     * The `host` group asserts the same thing for `LOAD_MODEL`: 109 MB, once per
     * deck. `INFER` is 2.75 MB + 16.51 MB, once per hop, and dropping ITS
     * transfer list left `node test.js` at 602 passed, 0 failed — the only gate
     * that caught it was `tools/backend-audio.mjs`, which is `slow` + `heavy` +
     * `needsSeed`, so `--quick` drops it and CI has never run it. That is the
     * asymmetry backwards: the cheap-and-rare transfer was gated in the suite CI
     * runs, the expensive-and-constant one only in the suite it does not.
     *
     * IDENTITY, NOT LENGTH: `[mix, out]` and not "a list of two", because a
     * transfer list carrying the wrong two objects is the same defect with a
     * passing count.
     */
    const inferPost = spawnedHere.length ? spawnedHere[0].posts.findIndex((m) => m && m.type === 'INFER') : -1;
    const inferXfer = inferPost >= 0 ? spawnedHere[0].xfers[inferPost] : null;
    ok('THE SEGMENT BUFFERS ARE TRANSFERRED INTO THE BACKEND, NOT COPIED — 19.3 MB per hop, on the thread that must not pause  '
      + '[entry point: extension/workers/workerbackend.js separate(), reached from Deck.infer() inside gpu.run()]',
      inferXfer != null && inferXfer.length === 2
      && inferXfer[0] === lentMix && inferXfer[1] === lentOut,
      inferPost < 0
        ? 'no INFER was posted at all, so this inspected nothing'
        : inferXfer.length !== 2
          ? `INFER was posted with a transfer list of ${inferXfer.length} — both buffers are COPIED across the thread `
            + 'boundary instead, every hop, and LivePipeline re-adopts a copy it did not lend'
          : (inferXfer[0] !== lentMix || inferXfer[1] !== lentOut)
            ? 'INFER transfers something other than the mix and out it carries — the caller re-adopts what comes '
              + 'back, so it would be re-adopting a buffer it never lent'
            : `the mix and the out buffer ARE the transfer list (${lentMix.byteLength} + ${lentOut.byteLength} B here, `
              + '2.75 MB + 16.51 MB in the deck)');
  }

  // ------------------------------- the demotion path never reaches the backend
  /**
   * THE ZERO-COPY ORDERING, ASSERTED WHERE S6 MOVED IT.
   *
   * The plan's one explicit instruction for this slice is "do not change which
   * buffers are transferred and which are not", and the transfer moved two
   * modules down: out of `offscreen/deck.js` and into
   * `workers/workerbackend.js`, with `Deck.infer()` left holding the ORDERING
   * that makes a demotion cost nothing —
   *
   *     "`separate()` — and therefore the `postMessage` that transfers both
   *      buffers — is INSIDE `fn`, and every demotion path returns before `fn`
   *      is ever called."
   *
   * WHAT USED TO COVER IT AND DID NOT. The `live` group demotes a chunk and
   * checks that `LivePipeline` does not reallocate — but its `infer` is a FAKE
   * standing in for exactly the two layers the transfer moved into, so it
   * carries the pipeline's half and nothing about the deck's. Review hoisted the
   * call out of `fn`:
   *
   *     const pre = this.requireBackend().separate(mixBuf, outBuf);
   *     const r = await gpu.run(this.id, budgetMs, () => pre);
   *
   * — verbatim the edit `deck.js` warns about — and `node test.js` (602 passed),
   * `--quick` (GREEN) and `backend-audio` (11 passed) all stayed green. The cost
   * of that regression is the one `deck.js` names: "Cannot perform Construct on
   * a detached ArrayBuffer" at `runChunk`'s first line, once per capture tick,
   * for ever.
   *
   * DRIVEN, NOT READ: the shipped `Deck.infer()` over the shipped
   * `GpuScheduler`, with a backend that detaches its arguments the way
   * `postMessage` with a transfer list does. A detached ArrayBuffer reads
   * `byteLength` 0, so "still attached" is a count rather than a promise.
   *
   * BOTH DEMOTION GATES ARE DRIVEN, because they are two different returns:
   * `Deck.infer`'s own pre-emptive L3 (another deck is compiling a session) and
   * the scheduler's (`scheduler.js:185`, `:194`). A hoist above either one is
   * the same defect.
   */
  {
    const { Deck } = await import('./extension/offscreen/deck.js');
    const seen = [];
    /**
     * A BACKEND THAT DETACHES, which is the whole instrument. `structuredClone`
     * with a transfer list is what `postMessage(m, [mix, out])` does to the
     * caller's buffers, minus the thread. The sizes are small and DISTINCT so
     * that "these four buffers, not some other four" needs no identity check to
     * be readable in the failure.
     */
    const detaching = {
      load: async () => ({ ep: 'fake', createMs: 0, warmupMs: 0 }),
      separate: async (mix, out) => {
        seen.push(mix.byteLength);
        const m = structuredClone(mix, { transfer: [mix] });
        const o = structuredClone(out, { transfer: [out] });
        return { mix: m, stems: o, prepMs: 0, inferMs: 1, postMs: 0 };
      },
      dispose: async () => {},
    };
    let loading = false;
    const gpu = new GpuScheduler({ priority: 'A', armed: true });
    const deck = new Deck('B', {
      ctx: () => null, master: () => null, gpu,
      modelBytes: async () => new ArrayBuffer(8),
      createBackend: () => detaching,
      send: () => {}, log: () => {}, armRefMs: () => 0,
      assetUrl: (rel) => `stub://unit/${rel}`,
      othersLoading: () => loading,
      anyLoading: () => loading,
    });
    deck.ensureBackend();

    // 1. GRANTED — the control, and it has to be able to LOSE: if this fake did
    //    not really detach, every "still attached" below would be vacuous.
    const okMix = new ArrayBuffer(8);
    const okOut = new ArrayBuffer(64);
    const granted = await deck.infer(okMix, okOut, Infinity);
    ok('A GRANTED CHUNK REACHES THE BACKEND AND ITS BUFFERS REALLY GO — the control for the demotion assertion below  '
      + '[entry point: extension/offscreen/deck.js Deck.infer(), through the real GpuScheduler]',
      seen.length === 1 && granted != null && !granted.demoted
      && okMix.byteLength === 0 && okOut.byteLength === 0
      && granted.mix.byteLength === 8 && granted.stems.byteLength === 64,
      seen.length !== 1
        ? `the backend was entered ${seen.length} time(s) for one granted chunk`
        : okMix.byteLength !== 0 || okOut.byteLength !== 0
          ? `the caller's buffers are still attached (${okMix.byteLength} B / ${okOut.byteLength} B) after a granted `
            + 'chunk — this fake does not transfer, so nothing below could observe one that does'
          : `lent 8 + 64 B (both detached here), came back ${granted.mix.byteLength} + ${granted.stems.byteLength} B`);

    // L3 may not refuse anyone without evidence — the anti-lockout invariant in
    // scheduler.js: eight samples, and a deck that has run. Eight observations
    // of a 900 ms machine against a 100 ms budget is the demotion the live path
    // actually takes.
    for (let i = 0; i < 8; i++) gpu.observe(900);

    const schedMix = new ArrayBuffer(16);
    const schedOut = new ArrayBuffer(128);
    const schedDemoted = await deck.infer(schedMix, schedOut, 100);
    loading = true;
    const preMix = new ArrayBuffer(32);
    const preOut = new ArrayBuffer(256);
    const preDemoted = await deck.infer(preMix, preOut, 100);
    loading = false;
    const attached = schedMix.byteLength === 16 && schedOut.byteLength === 128
      && preMix.byteLength === 32 && preOut.byteLength === 256;
    ok('A DEMOTED CHUNK NEVER REACHES THE BACKEND, SO NOTHING IS TRANSFERRED — both gates, and all four buffers are still the caller’s  '
      + '[entry point: extension/offscreen/deck.js Deck.infer(), its pre-emptive L3 and GpuScheduler.run()]',
      schedDemoted != null && schedDemoted.demoted === true
      && preDemoted != null && preDemoted.demoted === true
      && seen.length === 1 && attached,
      schedDemoted == null || !schedDemoted.demoted
        ? `the scheduler granted a 900 ms chunk into a 100 ms budget, so this inspected nothing: ${JSON.stringify(schedDemoted)}`
        : preDemoted == null || !preDemoted.demoted
          ? `the pre-emptive L3 did not fire while another deck was creating its session: ${JSON.stringify(preDemoted)}`
          : seen.length !== 1
            ? `the backend was entered ${seen.length} times for one granted chunk and two demoted ones — separate() is `
              + 'no longer inside gpu.run()’s fn, so a demotion transfers the buffers and the NEXT runChunk throws '
              + '"Cannot perform Construct on a detached ArrayBuffer" at its first line, once per capture tick, for ever'
            : !attached
              ? `a demotion moved the caller's buffers: ${schedMix.byteLength}/${schedOut.byteLength} B and `
                + `${preMix.byteLength}/${preOut.byteLength} B, of 16/128 and 32/256 (0 = detached)`
              : `2 demotions, 0 further entries into the backend, all four buffers still ${schedMix.byteLength}/`
                + `${schedOut.byteLength}/${preMix.byteLength}/${preOut.byteLength} B (scheduler: ${schedDemoted.why}; `
                + `pre-emptive: ${preDemoted.why})`);
    await deck.backend.dispose();
  }

  // ------------------------------------- a Host that answered with the wrong shape
  /**
   * `assertHost` at engine boot checks that `createBackend` is CALLABLE; it
   * cannot check what it returns. Without the check inside `serialiseBackend`, a
   * Host that answers with an object one level too deep — the Electron preload
   * shape `shared/host.js` already names — passes every boot check and fails at
   * the first arm, inside `gpu.run()`, as `backend.separate is not a function`.
   */
  const shortBackend = (() => {
    try { serialiseBackend({ load: () => {}, separate: () => {} }, 'Backend for deck A'); return null; }
    catch (e) { return String((e && e.message) || e); }
  })();
  ok('A BACKEND THE HOST ANSWERED WITH IS REFUSED WHERE IT ARRIVES, not at the first arm  '
    + '[entry point: extension/shared/host.js serialiseBackend(), reached from deck.js Deck.ensureBackend()]',
    shortBackend != null && shortBackend.includes('dispose') && shortBackend.includes('Backend for deck A'),
    shortBackend == null
      ? 'a backend with no dispose() was ACCEPTED — Deck.dispose() and the pagehide teardown both call it, so the '
        + '~1.7 GB wasm heap outlives the deck and nothing says why'
      : shortBackend);

  /**
   * ...AND THE REFUSED BACKEND IS GIVEN BACK, because by then it may already
   * exist. `createBackend` is documented as the place a Host that needs a
   * process STARTS one — "a backend that needs to spawn a process starts it
   * here and lets `load()` be where the waiting happens" — so a refusal that
   * simply drops the reference leaks whatever was started.
   *
   * Invisible under THIS Host, which is why it is asserted rather than
   * observed: the throw is fatal at `engine.js` module scope and the orphaned
   * worker dies with the document. Under the Electron Host this interface is
   * being written for, an out-of-process backend would outlive it — and the
   * mistake that gets you there is a shape mistake in the Host's own answer,
   * i.e. exactly the population this refusal is aimed at.
   *
   * A backend short `separate` but holding a `dispose` is the shape that can be
   * given back at all; the one above (no `dispose`) is the one that cannot, and
   * both must still REFUSE.
   */
  const refusedTeardown = (() => {
    let disposed = 0;
    let why = null;
    const half = { load: () => {}, dispose: () => { disposed++; } };
    try { serialiseBackend(half, 'Backend for deck B'); } catch (e) { why = String((e && e.message) || e); }
    return { disposed, why };
  })();
  ok('...AND IT IS GIVEN BACK ON THE WAY OUT — a Host that already spawned a process does not leak it to a shape refusal  '
    + '[entry point: extension/shared/host.js serialiseBackend(), reached from deck.js Deck.ensureBackend()]',
    refusedTeardown.why != null && refusedTeardown.why.includes('separate')
    && refusedTeardown.disposed === 1,
    refusedTeardown.why == null
      ? 'a backend with no separate() was ACCEPTED, so nothing was refused and nothing was disposed'
      : refusedTeardown.disposed !== 1
        ? `the refusal is right and the teardown is missing: dispose() was called ${refusedTeardown.disposed} time(s), `
          + 'so a backend that had already started a process is dropped without being stopped'
        : `refused ("${refusedTeardown.why.slice(0, 60)}…") and disposed once`);

  /**
   * AND THE UNIT REALLY WRAPS. Everything above proves the wrapper works; none
   * of it proves `Deck` uses it. Review has measured that exact hole twice on
   * this seam — a value right at four call sites and absent at the one that
   * feeds them — so the call site is read out of the build.
   *
   * READ AS TEXT with comments stripped, the same shape the `host` group uses on
   * `engine.js`: `deck.js` cannot be imported and inspected for this, because
   * the wrapping happens inside a method that spawns a Worker.
   */
  const { readFileSync: readDeckSrc } = await import('node:fs');
  const deckSrc = readDeckSrc(new URL('./extension/offscreen/deck.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const creates = (deckSrc.match(/this\.s\.createBackend\(/g) || []).length;
  const wrapped = /serialiseBackend\(this\.s\.createBackend\(/.test(deckSrc);
  ok('THE DECK BUILDS ITS BACKEND THROUGH THE QUEUE, AND ONLY THERE — one createBackend() call in the file, and it is inside serialiseBackend()  '
    + '[entry point: extension/offscreen/deck.js, comments stripped]',
    creates === 1 && wrapped,
    creates === 0
      ? 'cannot look: extension/offscreen/deck.js never calls this.s.createBackend() — the deck no longer builds a backend at all'
      : creates !== 1
        ? `${creates} createBackend() calls in deck.js — one deck must own exactly one backend`
        : wrapped
          ? '1 createBackend(), wrapped'
          : 'the deck holds the Host’s backend UNWRAPPED: nothing then serialises it, and the wedge is one concurrent '
            + 'chunk away');
}

// ===========================================================================
/**
 * THE FILTER HAS TO MATCH SOMETHING. `node test.js nosuchgroup` used to print
 * `0 passed, 0 failed` and exit 0 — a suite that asserted nothing while
 * reporting success, which is exactly what `tools/verify.mjs`'s VOID rule calls
 * a hard failure one level up. A typo'd or renamed group is the same event as a
 * suite that could not look.
 *
 * NOT an `ok()`, because it must not exist as an assertion on a normal run: on
 * an unfiltered run `only` is empty and there is nothing to check.
 */
const unmatched = only.filter((n) => !known.has(n));
if (unmatched.length) {
  fail += unmatched.length;
  console.log(`\n  \x1b[31mFAIL\x1b[0m no group is called ${unmatched.map((n) => `\`${n}\``).join(', ')} — `
    + `this run would otherwise assert nothing and exit 0. Groups: ${[...known].sort().join(', ')}`);
}

/**
 * AND THE HEADER LIST IS COMPUTED AGAINST THEM RATHER THAN MAINTAINED BESIDE
 * THEM. Three names — `ola`, `sum`, `wav` — described groups that had not
 * existed for months, and nothing could have noticed: the list is a comment.
 * The same file argues this for HOST_MODULES 4 000 lines up ("a list that is
 * COMPUTED cannot be forgotten"), and the argument does not stop at the top of
 * the file.
 *
 * Read out of this file's own header, from the sentence that says the list is
 * load-bearing to the end of that comment. FAILS IF IT CANNOT LOOK: a header
 * whose shape this no longer recognises reports zero names, which is a red.
 */
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./test.js', import.meta.url), 'utf8');
  const from = src.indexOf('THE GROUP NAMES BELOW');
  const to = from < 0 ? -1 : src.indexOf('*/', from);
  const listed = from < 0 || to < 0
    ? []
    : [...src.slice(from, to).matchAll(/^ \* {3}(\w+) {2,}\S/gm)].map((m) => m[1]);
  const groups = [...known].sort();
  const missing = groups.filter((n) => !listed.includes(n));
  const stale = listed.filter((n) => !known.has(n));
  ok('THE HEADER’S GROUP LIST IS THE GROUPS THIS FILE ACTUALLY HAS  '
    + '[entry point: test.js’s own header, against every name group() was asked about]',
    listed.length > 0 && missing.length === 0 && stale.length === 0,
    listed.length === 0
      ? 'the header list could not be read at all, so this inspected nothing — the block it parses has moved or changed shape'
      : missing.length || stale.length
        ? `${stale.length ? `listed but no such group: ${stale.join(', ')}. ` : ''}`
          + `${missing.length ? `a group nobody documented: ${missing.join(', ')}. ` : ''}`
          + '`node test.js <a stale name>` asserts nothing and exits 0'
        : `${groups.length} groups, all described: ${groups.join(', ')}`);
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
