/**
 * Every magic number in one place. Values marked "fixed by the graph" cannot be
 * changed without re-exporting the ONNX model.
 */

export const SR = 44100;                    // fixed by the graph (htdemucs samplerate)
export const SEGMENT = 343980;              // fixed by the graph — 7.7995 s
export const OVERLAP = 0.25;                // upstream apply.py default
export const STRIDE = Math.floor(SEGMENT * (1 - OVERLAP));   // 257985 = 5.85 s
/**
 * `model.sources` order for htdemucs_6s — do not reorder.
 *
 * `other` STAYS at index 2 (docs/SIX-STEM-CONTRACT.md). The two new stems append
 * so every existing plane index, gain slot and keyboard binding keeps its
 * meaning; engine/keytap.js's KEY_TAP_PLANE_L/R = 4/5 is derived from that one
 * fact and asserts it.
 */
export const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

/** Capture ring: power of two so addressing is `i & (CAP-1)`. 2^20 frames = 23.78 s. */
export const RING_FRAMES = 1 << 20;
export const RING_HEADER_BYTES = 64;        // 16 x Int32
export const RING_TICK_QUANTA = 32;         // worklet posts every 32*128 = 4096 frames

// ============================================================ live mode (Mode 1)
// Causal trailing window, spike/FINDINGS.md §5. Ring 7.8 s of PAST audio, run the
// model on [t-7.8, t], emit only the last `hop`. No lookahead.

/**
 * Hops the UI may select, seconds. 1.95 is the default and the only one measured
 * healthy end to end (cold 300 s session: RTF 0.4527, 6 drops of 156 = 3.8 %).
 *
 * ponytail: this list, and the console's `HOP_BLOCKED` set that disables 1.0
 * from it, are hardcoded against ONE machine's inference-time VARIANCE. Not its
 * mean — the mean says hop 1.0 is fine and the mean is wrong. Measured on an
 * M2 Max over a cold 300 s soak: hop 1.0 runs at RTF 0.8906, comfortably under
 * 1.0, and still misses 138 of 305 deadlines (45 %), because median chunk time
 * OSCILLATES 753 <-> 1002 ms across a 1000 ms deadline with no trend (+3.0 %
 * first-third to last-third; an independent 3 x 180 s cold probe measured the
 * ramp at 1.02x and total drops 5/535, i.e. it fell entirely on the fast phase —
 * a run shorter than the oscillation period reports whichever phase it landed
 * on, which is how two teams got 0 drops and 45 % drops from the same build).
 *
 * The ceiling: a faster or slower machine has a different spread and this list
 * is silently wrong for it in both directions — we block a hop a fast machine
 * could hold, and we offer 1.95 to a slow one that cannot.
 *
 * Upgrade path, and it is a real feature rather than a cleanup: have the engine
 * measure the T_inf DISTRIBUTION during warm-up — a handful of passes on the
 * zero-padded segment costs one hop of priming and is free — take p95 rather
 * than the median, and report the smallest hop with `p95 < 0.85 * hop` as the
 * one this machine can actually sustain. The runtime half of that already
 * exists: LivePipeline.warnIfMarginal() is the same test applied to live data.
 */
export const LIVE_HOPS = [1.0, 1.95, 2.6, 3.9];
export const LIVE_HOP_DEFAULT = 1.95;

/**
 * A hop is "marginal" when the SPREAD of inference times reaches the deadline,
 * not when the mean does. RTF 0.89 with 45 % of chunks missing is the case that
 * killed the mean test.
 */
export const MARGINAL_P95_FRACTION = 0.85;   // p95 chunk time vs the hop deadline
export const MARGINAL_DROP_RATE = 0.05;      // or 5 % of chunks already skipped

/** Join crossfade. FINDINGS §5: 0 ms clicks on bass at 13.6x baseline; 50 ms is clean. */
export const SEAM_XFADE_MS = 50;

/**
 * THE SEAM CROSSFADE LAW — the join between two consecutive chunks INSIDE one
 * deck. This is not the deck crossfader; see XF_CURVES for that one, and read
 * both comments before touching either.
 *
 *   'linear'      fi + fo = 1        — DEFAULT
 *   'equalPower'  fi^2 + fo^2 = 1
 *
 * LINEAR, because the two signals being crossfaded here are two estimates of the
 * SAME audio (corr ~0.99, FINDINGS §5). Correlated signals add in AMPLITUDE, so
 * complementary amplitudes are what reconstruct unity; equal-power would put
 * +3.01 dB in the middle of every join, a 50 ms blip every hop. Measured by
 * identity-model reconstruction: -inf dB under 'linear', -22.8 / -25.7 / -28.7 dB
 * at hops 1.0 / 1.95 / 3.9 under 'equalPower'.
 *
 * THE DECIDING VARIABLE IS CORRELATION, NOT ANYTHING ABOUT FADERS. The deck
 * crossfader (XF_CURVES) mixes two DIFFERENT records — uncorrelated, so their
 * POWERS add — and its correct default is therefore constant power, the exact
 * opposite of this. Two crossfades, opposite laws, same word.
 *
 * A future agent "unifying the two crossfade laws" is a plausible and completely
 * wrong refactor. `node test.js mix` fails loudly if these two are ever set to
 * the same law; that test is the defence and it exists on purpose.
 */
export const SEAM_XFADE_LAW = 'linear';

/**
 * Playback stem ring: 2^19 frames = 11.89 s per plane, 14 planes
 * (drums/bass/other/vocals/guitar/piano/passthrough, each stereo) = 29.4 MB of
 * SAB per deck. Must exceed hop + cushion by a wide margin; 3x the largest hop.
 */
export const STEM_RING_FRAMES = 1 << 19;
export const STEM_RING_HEADER_BYTES = 128;   // 32 x Int32
export const RING_PLANES = STEMS.length * 2 + 2;   // 6 stems x 2ch + passthrough x 2ch = 14

/**
 * Jitter cushion held ahead of the playhead, seconds. This is the single number
 * that trades latency against dropouts, so the derivation matters.
 *
 * Playback arms at S = hop + xfade + T_inf(chunk 0) + LIVE_CUSHION_SEC after the
 * first captured frame. Chunk k then lands at (k+1)·hop + T_inf(k) and the
 * cushion just before it lands is exactly
 *
 *     cushion_trough = LIVE_CUSHION_SEC + T_inf(chunk 0) − T_inf(k)
 *
 * — the offset is anchored to ONE sample of a noisy distribution, so the cushion
 * has to cover the SPREAD of inference times, not their mean.
 *
 * THE VALUE IS RIGHT; THE JUSTIFICATION IT SHIPPED WITH WAS NOT. 0.40 s was
 * derived from a "200–240 ms spread" measured over a 75 s soak — one phase of an
 * oscillation whose period is longer than that, so the spread was understated.
 * Re-measured over 600 s at hop 1.95 (`tools/hop-probe.mjs`, n = 307, full audio
 * graph):
 *
 *     min 781 · p01 785 · p05 790 · p50 811 · p95 978 · p99 1130 · max 1268 ms
 *     p99 − p01 = 345 ms          max − min = 487 ms
 *
 * So 0.40 s covers p99 − p01 (345 ms) but NOT the worst case (487 ms, which is
 * chunk 0 landing at the floor and a later chunk at the ceiling). The residual
 * is absorbed by the backpressure ladder's cushion trigger, which converts it to
 * one passthrough span: measured 1 drop in 307 chunks (0.3 %), 0 underruns. That
 * is the designed behaviour and the reason the wrong number never showed up as a
 * defect — but a correct decision resting on a wrong number is a landmine for
 * whoever revisits it, so: the tail is 2x wider than the comment used to claim.
 *
 * Raising this to 0.50 s would cover max − min and remove that 0.3 %, at a cost
 * of 100 ms of latency (3.4 s -> 3.5 s). Deliberately NOT done: post-QA-15 a
 * dropped span is silent rather than unseparated when the user has killed a
 * stem, so drops matter more than they did — but 0.3 % is one ~2 s span per
 * ~10 minutes, and the honest fix is the ponytail below, not a bigger constant.
 * Note also that the tail itself is not stable: two 600 s runs of the same build
 * gave max 996 ms and max 1268 ms. Do not over-fit this constant.
 *
 * ponytail: the arm offset is anchored to a SINGLE sample, T_inf(chunk 0), so a
 * lucky-fast first chunk spends the whole session with a small cushion and an
 * unlucky-slow one adds latency for nothing. The ceiling is that the spread is
 * machine-specific and this constant cannot know it. Upgrade path: measure the
 * T_inf distribution during warm-up (a few passes on the zero-padded segment,
 * free inside the first hop) and arm from `p95(probe)` instead of `T_inf(0)`,
 * which makes the trough independent of chunk 0's luck.
 */
export const LIVE_CUSHION_SEC = 0.40;   // see above: value right, old justification wrong

/** Below this the state goes 'starving' (report only; the worklet handles panic). */
export const LIVE_LOW_WATER_SEC = 0.12;

/** Worklet fade in/out on starvation. Never a discontinuity, never garbage. */
export const LIVE_PANIC_FADE_MS = 20;

/**
 * Gain smoothing time constants, seconds. docs/AUDIO.md §3.3.
 *
 * `xfader` is deliberately the SAME as `mute`, not the same as `fader`. The
 * crossfader is a performance control: with the `cut` curve a scratch DJ expects
 * the channel to appear the instant the cap leaves the edge, and a 10 ms fader
 * tau smears a transformer cut into a fade. 3 ms is 95 % in 9 ms and exactly
 * zero by 18 ms, which is below the ~20 ms window a cut is audible in, while
 * still being long enough that the discontinuity in `cut`'s control curve cannot
 * click.
 */
export const TAU = { mute: 0.003, fader: 0.010, master: 0.020, xfader: 0.003 };

/** Post rates from the playback worklet (docs: METERS ~30 Hz, LIVE_STATE ~10 Hz). */
export const METER_HZ = 30;
export const HEALTH_HZ = 10;

// ============================================================ key detection (play-along)
/**
 * How often the offscreen MAIN thread pulls a window off the `other` plane, and
 * how often it re-runs the 24 correlations. Both are main-thread work and
 * neither is anywhere near the render deadline — `node engine/keytap.js` measures
 * one 16384-point window (read + Hann + rfft + fold + accumulate) at
 * 0.211–0.218 ms, so 10 Hz is 2.11–2.18 ms per second of one thread, and
 * `node engine/chroma.js` measures `correlateKey` — which is all 24 correlations,
 * not one — at 0.5–0.6 us per estimate.
 *
 * A RANGE, BECAUSE A POINT HERE HAS NOW BEEN WRONG TWICE. This line has carried
 * 0.213 ms and then 0.220 ms; 12 consecutive runs on this machine on 2026-08-15
 * spanned 0.211–0.218 with no value repeating more than three times, so the
 * run-to-run spread (±1.6 %) is larger than the gap between the two figures
 * people have argued about. Quote the range or re-run it; do not copy a single
 * number out of a change. The correlation figure moved further — it was
 * written as ~5 us and measures 0.5 us — and neither number changes any
 * decision, which is exactly why nobody re-ran them.
 *
 * THE RATIO IS THE PART THAT MATTERS, not either number. 10 Hz accumulate with
 * a 371 ms window is 73 % overlap, which is enough that a four-bar phrase is
 * seen from many positions; 2 Hz estimate is the rate the display hysteresis
 * was tuned against (DISPLAY_POLICY.switchUpdates is 3 consecutive updates, so
 * a key change takes ~1.5 s to be believed, which is the right feel for a label
 * someone is fingering an instrument against). Raising the estimate rate
 * shortens that hold without anyone noticing they changed it.
 */
export const KEY_ACCUM_HZ = 10;
export const KEY_ESTIMATE_HZ = 2;

// ============================================================ dual deck (Mode 3)

/** Deck ids. Two, fixed: one AudioContext, one offscreen document, two decks. */
export const DECKS = ['A', 'B'];
export const DECK_DEFAULT = 'A';

/**
 * Crossfader curves. docs/design/DESIGN.md §6.4.
 *
 *   'dip'  constant power, -3.01 dB at centre. DEFAULT. gA^2 + gB^2 = 1 at every
 *          position, which is right for two DIFFERENT tracks (uncorrelated) —
 *          the opposite of the join crossfade inside one deck (SEAM_XFADE_LAW),
 *          where the two signals are estimates of the same audio and must be
 *          added linearly. Both laws are correct; they are solving opposite
 *          problems, and swapping them is a +3 dB error in either direction.
 *   'lin'  gA + gB = 1. Amplitude-linear; dips 3 dB in POWER at centre.
 *   'cut'  hard, for scratching: full volume within XF_CUT_EDGE of each end, so
 *          both decks are at unity across the middle 80 % of travel.
 */
export const XF_CURVES = ['dip', 'lin', 'cut'];
export const XF_CURVE_DEFAULT = 'dip';

/**
 * Width of the `cut` curve's transition, as a fraction of full travel.
 * DESIGN.md §6.4 says "hard cut within 10% of each end".
 *
 * NOT zero, deliberately. A true step in the control signal is still smoothed by
 * TAU.xfader so it would not click, but 10 % of a 240 px fader is 24 px, which is
 * what a hardware cut fader feels like — and a literal step makes the curve
 * non-invertible for a UI that wants to draw it.
 */
export const XF_CUT_EDGE = 0.10;

/** Per-stem crossfader assignment targets. See engine/mixer.js xfStemGain(). */
export const XF_TARGETS = ['A', 'B', 'XF'];
export const XF_ASSIGN_DEFAULT = 'XF';

/** Crossfader position: 0 = full deck A, 1 = full deck B, 0.5 = centre. */
export const XF_POSITION_DEFAULT = 0.5;

/**
 * Master trim applied to EACH deck once a second deck is loaded, dB.
 *
 * WHY THIS EXISTS, because it will look arbitrary later. Hard-assigned stems
 * bypass the crossfader entirely (engine/mixer.js xfFactor: `target === deck`
 * returns 1 at every position), so BOTH decks run at unity — whereas ordinary
 * centre-detent use puts each at 0.707. That makes the flagship gesture, deck A
 * vocals over deck B instrumental, SYSTEMATICALLY THE LEAST-HEADROOM CASE IN THE
 * PRODUCT rather than an edge case.
 *
 * Measured over three runs of tools/mashup-probe.mjs at hop 2.6: master bus peak
 * 1.03-1.32 pre-clip (+0.25 to +2.39 dBFS), 0.058-0.290 % of samples above the
 * 0.7079 soft-clip knee, 0.77-2.47 dB of peak reduction, and the DAC never above
 * 0.99. Accepting that was defensible — it is the safety net doing exactly its
 * designed job (docs/AUDIO.md §4.3).
 *
 * It was rejected for one reason: THE CLIP INDICATOR SHOULD MEAN "YOU PUSHED
 * IT", NOT "YOU USED THE FEATURE". The clip flag arms at 0.99 pre-clip, so the
 * marquee gesture lit a warning on first use — and a warning that fires on
 * correct, intended operation teaches the user to ignore it, at which point it
 * is not an indicator any more. -3 dB puts all three measured peaks under 0.99
 * (1.196 -> 0.847, 1.317 -> 0.932, 1.029 -> 0.728) and drops the clipper's work
 * at the peak from -1.73 dB to about -0.10 dB.
 *
 * Two properties that are part of the decision, not implementation detail:
 *   - it keys on a second deck being LOADED, not on hard routing. A user who
 *     loads deck B and leaves everything on XF must not get a different master
 *     gain from one who routes immediately.
 *   - it is a DEFAULT, not a clamp. Once the user moves the master it is theirs
 *     and the engine stops touching it.
 */
export const DUAL_MASTER_TRIM_DB = -3;

/**
 * Stem cache cap. docs/AUDIO.md §8.3 sized a 4 GiB LRU at ~24 tracks of 16-bit
 * PCM when a track was four stems (169 MB for 4 minutes). At SIX stems a
 * 4-minute track is ~254 MB — `bytesForSeconds(240)` — so the SAME cap now holds
 * about SIXTEEN tracks, not twenty-five (docs/SIX-STEM-CONTRACT.md, "known debt"
 * §3). The cap is deliberately unchanged: it is a disk budget, not a track
 * count, and shrinking the number of tracks it holds is the honest consequence
 * of wider stems rather than something to hide by raising it.
 *
 * Visible in the UI and evicted strictly oldest-used-first, because a cache that
 * silently drops a set prepared the night before a gig is a bug even when every
 * line of it is correct.
 */
export const STEM_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Model — pinned host, pinned hash. The pin is the single source of truth every
 * script derives from; never re-type it into a second file.
 *
 * SIX STEMS, AND SMALLER. The 6-stem move was once blocked on the
 * claim that every public `htdemucs_6s.onnx` carries the STFT in-graph, which
 * ORT-Web's WebGPU EP refuses. That claim is FALSIFIED: two public exports use
 * the same hoisted-STFT, dual-input / dual-output design as the 4-stem pin did
 * (see engine/demucs.js's MODEL INPUT CONTRACT). This is the static-shape one.
 *
 * PINNED BY COMMIT SHA, NOT BY `main`. The 4-stem pin resolved through the
 * mutable `main` ref, so upstream could have moved the bytes under a hash we had
 * already written down — the SHA-256 would have caught it, but as a download
 * failure with no explanation. `resolve/<40-hex>` cannot move. Keep it that way.
 *
 * 114,559,139 B is **66 MB SMALLER** than the 4-stem file's 180,534,758, which
 * is counter-intuitive enough to be worth stating: `htdemucs_6s` is 27.4 M
 * parameters against `htdemucs`'s 41.9 M because it drops the 512-channel
 * transformer bottleneck. Six stems cost less to download than four, and the
 * download-size ceiling (was ~180 MB) moves DOWN to ~115 MB rather than up.
 *
 * opset 17, was 18. fp32, unchanged. Same `huggingface.co` origin, so
 * `extension/manifest.json`'s `host_permissions` and CSP `connect-src` need no
 * change — verified against the manifest, not assumed.
 *
 * ponytail: THE PIN IS NOT SETTLED. Two facts about this file are still being
 * measured against the real PyTorch `htdemucs_6s` and both are load-bearing:
 *   1. that the `[1, 4, 2048, 336]` STFT input is packed channel-major
 *      `[L.re, L.im, R.re, R.im]`, which is how `engine/demucs.js` packs it —
 *      wrong packing separates plausibly and incorrectly, with no error;
 *   2. that `model.sources` really is
 *      `['drums','bass','other','vocals','guitar','piano']`, i.e. that `other`
 *      is at index 2 — `engine/keytap.js`'s KEY_TAP_PLANE_L/R and every gain
 *      slot depend on it, and `keytap.js`'s `tap-point-is-the-other-stem` only
 *      checks that STEMS below agrees with itself, not that STEMS agrees with
 *      the checkpoint.
 * If either comes back wrong, this pin reverts. Ceiling: nothing in the codebase
 * can detect either failure at runtime. Upgrade path: the parity gate's output
 * becomes a recorded fixture and `STEMS` is asserted against it.
 */
export const MODEL = {
  url: 'https://huggingface.co/arjune123/demucs-onnx/resolve/0168b73c5fbf38462be79c051b003844a4820e7a/htdemucs_6s.onnx',
  sha256: 'b19cdf832edeb50274b36d6928a8bf83202237c71a4836c4cca45e843316ee17',
  bytes: 114559139,
  label: 'HT-Demucs v4 (htdemucs_6s)',
};

/**
 * NOT bumped for the 6-stem model, deliberately. `shared/stemcache.js`
 * `pipelineVersion()` already folds `MODEL.sha256.slice(0, 12)` into every cache
 * key, so the new hash invalidates every cached track on its own. A second
 * invalidation mechanism for the same event is one more thing to forget.
 */
export const CACHE_NAME = 'model-cache-v1';

/** OPFS filenames for finished stems. */
export const OPFS_DIR = 'exports';
export const OPFS_DEV_INPUT = 'dev-input.wav';
export const OPFS_LIVE_TAP = 'live-tap.wav';

// ============================================== the durable arm refusal
/**
 * `ARM_ERROR` is fire-and-forget: `toUi()` swallows the rejection, so a refusal
 * raised with no extension page listening is discarded and the user is told
 * nothing. The service worker therefore also PERSISTS the last refusal here, and
 * every surface reads it on boot. The message is unchanged — this is a durable
 * fallback beside it, never a replacement.
 */
export const ARM_ERROR_KEY = 'armError';

/**
 * How long a persisted refusal may still be painted, milliseconds, measured from
 * `armError.at` (epoch ms, the moment the SERVICE WORKER raised it).
 *
 * 60 s is chosen against one gesture: click the toolbar, notice nothing happened,
 * open the console to find out why. That is tens of seconds, not minutes. Longer
 * and a refusal from a previous sitting paints as current, which would turn a fix
 * for a silent failure into a new false-alarm source — the more expensive defect
 * of the two, because it trains the user to ignore the banner.
 */
export const ARM_ERROR_TTL_MS = 60000;
