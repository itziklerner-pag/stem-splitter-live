# Stem Splitter Live — Audio & DSP Specification

**Owner:** Music / Audio DSP
**Status:** Normative for implementation. Where this document disagrees with `ARCHITECTURE.md`, **this document wins on audio behaviour** — sample rates, chunking, windows, gain law, levels, file formats, and latency numbers. Flag the conflict rather than silently reconciling it.
**Companion code:** [`docs/snippets/`](./snippets) — zero-dependency reference implementations. Run `node docs/snippets/selftest.js` (all green as of writing).

---


> ## ⚠️ RULED: : the ladder's no-silence guarantee does NOT hold for the mashup gesture
>
> `passthroughGain = min(post-crossfader gains)`. Under hard `XF_ASSIGN` routing —
> the flagship gesture, deck A vocals over deck B instrumental — **at least one
> stem on each deck is always routed away, so that minimum is always 0.** The
> ladder's stated guarantee, *"a drop degrades to unseparated audio, never to
> silence"*, therefore **does not apply to the mashup use case at all.**
>
> **Ruled: ducking to zero is correct and stays.** During a drop the passthrough
> plane carries the **full unseparated mix**, so playing it would bring back
> precisely the stem the DJ routed away — on top of the other deck already
> supplying it. That is the QA-15 failure, louder and doubled. Silence on one
> deck for one span means you hear the other deck, which is musically
> survivable. The alternative is not.
>
> **The consequence that makes this load-bearing:** the relief valve is gone for
> the gesture the product exists for, so **L3 scheduler correctness is now
> load-bearing in a way it was not.** A deck that is wrongly demoted no longer
> degrades to unseparated audio — it goes silent. Defect 1 of is
> exactly what that looks like: a self-reinforcing L3 lockout demoted deck B
> 15 of 15 hops while it held a healthy 1.665 s trough, and the mashup played
> deck A alone while sounding plausible.

> **WHAT THIS DOCUMENT STILL GOVERNS.** Stem Splitter Live ships ONE deck, live, and no
> offline export. The DSP below is the DSP that runs: constants, chunking,
> seams, the gain law, levels, latency. Sections written for the offline export
> path and for a second deck are KEPT rather than deleted, because their numbers
> are measurements and deleting evidence is how a project forgets what it
> learned — but they describe capability this build does not have. They are
> marked where they start. `engine/ola.js`, the export overlap-add this document
> repeatedly cites, is gone; the live path's own plan and seam laws are in
> `engine/live.js` and are covered by `node test.js`.

## 0. Normative constants

Everything below is derived from the actual upstream Demucs source, not from memory. See [§9](#9-appendix--what-upstream-demucs-actually-does) for the verbatim quotes.

| Symbol | Value | Where it comes from |
|---|---|---|
| `MODEL_SR` | **44100 Hz** | `htdemucs.py`: `samplerate=44100` |
| `SEGMENT_SECONDS` | **7.8 s** = `Fraction(39,5)` | pretrained `htdemucs` checkpoint `model.segment`; longer segments are refused (`max_allowed_segment`) |
| `L` (segment samples) | **343 980** | `int(44100 * 7.8)` |
| `nfft` / `hop_length` | 4096 / 1024 | `htdemucs.py`: `nfft=4096`, `hop_length = nfft // 4` |
| STFT reflect pad | 1536 samples (34.8 ms) | `htdemucs.py::_spec`: `pad = hl // 2 * 3` |
| Source order | **`[drums, bass, other, vocals, guitar, piano]`** | `htdemucs_6s` `model.sources`. Get this wrong and every stem is mislabelled — and nothing at runtime can tell. An `.onnx` file carries no source names, so this was read off the real PyTorch checkpoint (demucs 4.1.0, `get_model('htdemucs_6s').sources`) and is pinned in `tools/model-parity.mjs` as `VERIFIED_SOURCES` **against the model's SHA-256**: if the hash moves, the order is unverified again. **`other` stays at index 2** — `docs/SIX-STEM-CONTRACT.md`, and it is what keeps `keytap.js`'s `KEY_TAP_PLANE_L/R = 4/5` valid. |
| Channels | 2 (stereo), planar internally | `audio_channels=2` |
| Export overlap | 0.25 → stride **257 985** | `apply.py` default `overlap: float = 0.25` |
| Live overlap | 0.615 (hop 3.0 s) — see [§2.3](#23-live-presets) | this document |
| Input normalisation | per-track `(x − mean)/(std + 1e-8)` on the channel-mean | `api.py::separate_tensor` |

**Non-negotiables**

1. The model is fed **exactly 343 980 samples at 44 100 Hz**, always. Not 2 s, not 3 s. (§2.1 explains why a shorter segment costs the *same* compute.)
2. All six stems for a given chunk come out of one forward pass and are **sample-aligned with each other and with the mix**. A one-sample skew between stems puts a comb-filter null at `f = fs/(2Δ)`; Δ = 10 samples puts it at 2.2 kHz, which is catastrophic. Δ must be **0**.
3. Never use `AudioBufferSourceNode` or `OfflineAudioContext` to change sample rate (§1.3).
4. Normalisation (`mean`/`std`) is computed **per track or per rolling window, never per chunk**. Per-chunk normalisation makes the output pump at every seam.

---

## 1. Signal chain — sample-accurate

### 1.1 The chain

```
YouTube <video>  ──(muted for the user, still decoding)
   │  48 000 Hz (assume; verify at runtime)
   ▼
chrome.tabCapture  →  MediaStream
   │
   ▼
AudioContext({ sampleRate: 44100, latencyHint: 'playback' })     ← offscreen document
   │  Chrome resamples 48000 → 44100 in the media pipeline
   │  (media::SincResampler, 32–64-tap windowed sinc, Blackman, 32 kernel offsets)
   ▼
MediaStreamAudioSourceNode → AudioWorkletNode "capture"
   │  128-frame render quantum @ 44100 = 2.902 ms
   │  writes into a SharedArrayBuffer ring (planar float32, L and R)
   ▼
Worker: segmenter                       ← pure integer sample arithmetic, no resampling
   │  emits chunk k = samples [k·H − P, k·H − P + 343980)
   ▼
ONNX Runtime Web / WebGPU — HT-Demucs v4 (htdemucs_6s)
   │  in  : (1, 2, 343980) float32
   │  out : (1, 6, 2, 343980) float32   [drums, bass, other, vocals, guitar, piano]
   ▼
Worker: overlap-add (§2) → per-stem ring buffers @ 44100
   ▼
AudioWorklet "player" → 6 × GainNode (§3) → master bus (§4)
   ▼
AudioContext.destination
   │  Chrome resamples 44100 → device rate (48000) in AudioDestination
   │  (MediaMultiChannelResampler — same sinc family)
   ▼
CoreAudio
```

Sample-accurate mapping between domains: output sample `n` at 44 100 Hz corresponds to capture time `n · 160/147` samples at 48 000 Hz. `gcd(48000, 44100) = 300`, so the rational ratio is exactly **147/160** and there is no drift — a frame counter at 44.1 k and a frame counter at 48 k stay locked forever, no resync needed.

### 1.2 Recommendation: let Chrome do both conversions

**Create one `AudioContext` at 44 100 Hz and do no resampling in JavaScript on the live path.**

```js
const ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
if (ctx.sampleRate !== 44100) throw new Error('UA refused 44100 — fall back to §1.4');
const src = ctx.createMediaStreamSource(tabStream);   // Chrome resamples 48k → 44.1k here
```

Why this is the right call:

* It is **free** — the conversion happens in C++/SIMD inside Chrome's media pipeline, off the JS thread, in code that is already running.
* Both conversions use a real windowed-sinc resampler, not linear interpolation (verified in Chromium source: `blink::SincResampler` uses a Blackman window with `alpha = 0.16`; `media::SincResampler` uses `kMinKernelSize = 32`, `kMaxKernelSize = 64`, `kKernelOffsetCount = 32`).
* The `AudioWorklet` then runs natively at 44 100 Hz, so the capture worklet, the segmenter, the OLA and the player all share **one integer sample clock at the model's rate**. Every off-by-one becomes impossible by construction.
* Forcing a non-native context rate makes Chrome instantiate a `MediaMultiChannelResampler` in `AudioDestination` for output (confirmed in `audio_destination.cc`: it is created when `context_sample_rate_ != web_audio_device_->SampleRate()`). Cost: a few ms of latency, no quality issue.

**Verify once, empirically**, don't take my word for it — run the sweep test in §6.6. If Chrome's input resampler ever regresses, that test will catch it.

### 1.3 What NOT to use, and why (this is the trap)

Blink has **three different resamplers** and they are wildly different in quality:

| Path | Implementation | Verdict |
|---|---|---|
| `decodeAudioData()` into a context of a different rate | `AudioBus::TryCreateBySampleRateConverting` → `blink::SincResampler` (32 taps, 32 kernel offsets, Blackman) | Good. But needs *encoded* bytes — useless for our `Float32Array`s. |
| `AudioContext` rate ≠ device rate (input and output) | `media::SincResampler` via `MediaMultiChannelResampler` | Good. **This is what §1.2 uses.** |
| **`AudioBufferSourceNode` playing a buffer whose `sampleRate` ≠ the context rate**, or with `playbackRate` ≠ 1 | **linear interpolation** | **Unusable for music.** |

That last row is the trap, and it is exactly what "just use an `OfflineAudioContext` at 44100" resolves to. `new OfflineAudioContext(2, len, 44100)` + `AudioBufferSourceNode(buffer @ 48000)` + `startRendering()` runs the buffer through the **linear** interpolator.

> **A BOUNCE IS NOT THAT, AND THIS ROW MUST NOT BE CITED AGAINST IT.** The offline
> render in `extension/offscreen/bounce.js` does use `new OfflineAudioContext(2, len, 44100)`
> — and it instantiates **no `AudioBufferSourceNode` at all**. The stems reach the graph
> through the SAB stem ring, at 44 100 Hz, into the same `stem-playback` worklet the
> speakers use; the render is 44 100 -> 44 100, so **no resampler of any kind is
> constructed** and none of the three rows above is on the path. What the trap is really
> about is the SOURCE NODE, not the context, and the sentence above is easy to read as
> being about the context. Written out because a bounce is exactly the feature somebody
> will reach for this paragraph to veto. The Web Audio spec deliberately leaves this implementation-defined; Gecko uses a higher-quality (Speex) resampler, Blink uses linear. So: **browser-implementation-defined, and the browser we target picked the bad one.**

Quantitatively, linear interpolation at fractional phase `α` has magnitude response

```
|H(f)| = sqrt( 1 − 2·α·(1−α)·(1 − cos(2π f / fs)) )
```

Worst case (`α = 0.5`): **−2.0 dB at 10 kHz, −6.02 dB at 16 kHz**. And `α` is not constant — for the 147/160 ratio it cycles through all 147 phases every 147 output samples (3.33 ms), so the high end is amplitude-modulated at ~300 Hz. That is an audible HF warble on cymbals, not a subtle spec-sheet difference.

Measured (`selftest.js`, sum of tones 100 Hz … 19 kHz, 48 k → 44.1 k → 48 k round trip):

| Resampler | Round-trip error |
|---|---|
| Linear interpolation (Blink `AudioBufferSourceNode`) | **−8.6 dB** |
| `docs/snippets/resample.js` polyphase | **−112.7 dB** |

### 1.4 The JS resampler — when you do need one

Needed for: the offline/export path when audio arrives as `Float32Array` (imported file, cached stems at a different rate), any environment where `AudioContext({sampleRate: 44100})` is refused, and any place we want **bit-reproducible** results for the null test in §6.4.

`docs/snippets/resample.js` — rational polyphase windowed-sinc:

```js
import { Resampler, resampleBuffer } from './snippets/resample.js';

const y = resampleBuffer(x48k, 48000, 44100);      // one-shot
const r = new Resampler(44100, 48000);             // streaming
const chunk = r.process(x); /* … */ const tail = r.flush();
```

Design, 48 k ↔ 44.1 k, both directions:

| Parameter | Value |
|---|---|
| L / M | 147 / 160 (or 160 / 147) |
| taps per polyphase branch `P` | 128 |
| prototype length `N = P·L` | 18 816 taps @ 7.056 MHz |
| window | Kaiser, β = 9.5 → stopband A = β/0.1102 + 8.7 = **95.9 dB** |
| transition width | `(A−8)/(2.285·N) · fsUp/2π` = **2 270 Hz** |
| cutoff | `min(fsIn,fsOut)/2 − Δf/2` = **20 915 Hz** |
| passband | flat (< 0.001 dB) to **19.78 kHz** |
| alias / image floor | ≤ **−96 dB** at 22.05 kHz (measured −107 dB on a 23 kHz tone) |
| group delay | **exactly 64 input samples** (the prototype is centred on `P/2·L`, so no fractional correction is needed) |
| cost | 128 MAC / output sample / channel = **11.3 MMAC/s** at 44.1 k stereo |

The exact-integer group delay matters: without it there is a residual 0.0034-sample offset which shows up as a −41 dB round-trip error at 19 kHz (pure timing, not filtering). We hit that bug during development; the fix is in `designPrototype({ center })`.

### 1.5 The pitch shifter's resampler — three findings that cost real time

`extension/engine/pitch.js` (STFT phase vocoder + polyphase resampler, ±6
semitones) is a *second* rational resampler in the tree, and it is **not**
`docs/snippets/resample.js` with a different ratio. Three things it measured are
recorded here because they are not derivable from §1.4 and will otherwise be
re-derived — the first one by someone "fixing" the kernel back to the snippet's
design.

**Provenance.** Findings 1 and 2 are printed by
`node extension/engine/pitch.js` on every run (in `verify --quick`); the numbers
below are from a run. Finding 3 was reported by the engine owner
and is **not** currently asserted by any suite — see the note under it.

#### 1. The cutoff is exactly `0.5·min(1, M/L)` with NO transition-band backoff, and that is what makes bypass bypass

§1.4's prototype backs the cutoff off by `Δf/2` (20 915 Hz rather than 22 050).
It can afford to: it is a fixed 48 k↔44.1 k converter with ~2 kHz of spare band.
The shifter cannot. Its ratio is `2^(k/12)`, so a backoff costs the top of the
band at *every* setting — and, far worse, **it breaks the identity case**:

| kernel | bypass (`shiftSemitones(0)`, deck-bus entry point) |
|---|---|
| cutoff = exactly the effective Nyquist | **−294.5 dB** (gate: −120) |
| ...with the §1.4 snippet's `Δf/2` backoff put back | **−14.2 dB** |

At ratio 1 and a cutoff of exactly Nyquist the integer-offset taps are an exact
delta — `sin(πj)/(πj) = 0` for integer `j ≠ 0` — so bypass is a **bit-exact
delay through the same 128-tap convolution**, no special case, no branch. Back
the cutoff off and those taps stop being a delta, and −14.2 dB is not a bypass;
it is a lowpass the user did not ask for, on a deck they set to 0.

**The general point, which is the reason this is in the spec and not only in a
comment: the kernel design here is load-bearing, not incidental.** −294.5 dB and
−14.2 dB are the same code with one parameter changed.

*(Related, and the reason the shifter clears §6.6's gates at all: it linearly
interpolates the two neighbouring branches' **filter coefficients**, not the
signal. §1.3's −8.6 dB is **signal** interpolation. The evidence for the
distinction is the measured alias floor of −116.9 dB against a −60 dB gate and a
passband of ±0.02 dB from 40 Hz to 19 kHz — not the distinction itself.)*

#### 2. 20 Hz is below the STFT's own resolution, and the assertion says so rather than a comment

At `N = 2048` a bin is **21.53 Hz**. A 20 Hz partial therefore sits at **bin
0.93** — under DC, and on top of its own negative-frequency image. No phase
vocoder at this FFT size resolves it. **Measured −2.21 dB** at `k = −6`, against
§6.6's ±0.5 dB passband gate.

The tone sweep either side of it is flat, which is what makes this a resolution
floor and not a filter roll-off:

```
20 Hz −2.21 | 25 −0.47 | 30 −0.20 | 35 −0.08 | 40 −0.02 | 50 +0.02 | 80…19 k ≤ 0.01 dB
```

**It is encoded as an assertion exception, not a comment**, per `AGENTS.md`'s
corollary — *if a comment above an assertion documents an exception, the
assertion must encode the exception or be deleted.* `passband-flat-at-minus-6`
gates on 25 Hz and up, **prints the 20 Hz value in its detail every run**, and
fails if any tone came back unmeasurable (`unmeasured === 0`) so it cannot pass
by not looking. The 25 Hz and 30 Hz figures are also a fix, not a given: the
textbook 5-bin peak rule starts its scan at `k = 2`, which makes every partial
below 43 Hz un-peakable — 30 Hz came out **−5.49 dB** before bin 1 was admitted
as a candidate, and −0.20 dB after. The bass stem lives in that band.

*ponytail:* the ceiling is `N = 2048`. The upgrade is a 4096-point analysis on
the bass plane only, which doubles that plane's group delay and therefore
reopens the whole §7 latency contract. Not worth it for one third-octave band.

#### 3. A phase vocoder loses coherence on noise-like material — it is a level offset, not a tilt

Broadband noise through the shifter comes out **0.4–1.2 dB down**, and
**band-flat to ±0.05 dB above 500 Hz**. Tones do not do this (`pitch.js`'s `unity-gain`
assertion holds to 0.000 dB on a 440 Hz sine at +5); the loss is the phase
vocoder failing to keep partials coherent across hops when there are no partials
to keep coherent.

**Why this is in the spec: it matters to anyone matching levels between a
shifted deck and an unshifted one.** It is a broadband offset, so it is
correctable with a gain trim and it will not be heard as a tone change — but a
null test between a shifted and an unshifted render of the same material will
not go below it, and someone will otherwise spend a day looking for the bug.

> **Unverified by Release Engineering.** This one was reported, not re-run here,
> and — unlike findings 1 and 2 — **no assertion currently pins it**, so nothing
> would tell us if it moved. If a level-matching feature is ever built on top of
> it, it needs an assertion first.

### 1.6 The shifter on the live path — six findings from the integration

*(Added after `extension/engine/pitchbank.js` wired §1.5's shifter
into the playback worklet. §1.5 is the shifter in isolation; this is what
happened when ten planes, two decks and a render deadline were put around it.)*

> ### ⚠ FINDING 1'S MILLISECOND FIGURES ARE **WITHDRAWN**, AND THE INSTRUMENT WAS REPLACED
>
> *(An earlier revision of this note said these figures were
> taken at four shifters and **must be re-measured**. That was the right call with
> what was known then, and it is **not what happened.** The re-measurement was
> attempted and its finding is that **a wall clock on this machine cannot carry
> these claims at all** — so the millisecond figures are withdrawn as
> uninterpretable rather than corrected, and a **counting** instrument took over.)*
>
> **The evidence is three consecutive runs of IDENTICAL code:**
>
> | | run 1 | run 2 | run 3 |
> |---|---|---|---|
> | `cost-at-+6` p95 (ms) | 0.997 | 0.991 | **1.685 ← false red** |
> | max (ms) | 4.17 | 4.08 | 23.55 |
> | **peak frames/quantum** | **5** | **5** | **5** |
> | **mean frames** | **3.182** | **3.182** | **3.182** |
> | frames counted | 6364 | 6364 | 6364 |
>
> **The wall clock swung 69 % and threw a red on unmodified code. The counts did
> not move a digit.** That is the whole argument. A figure that fires a red on a
> build with no diff is not measuring the build, and per `AGENTS.md` the false red
> is the more expensive half of the damage — it trains everyone to distrust reds.
>
> **What replaces it — frame counts, two decks both transposed:**
>
> | | peak frames/quantum | mean |
> |---|---|---|
> | 4 lanes, colliding *(the four-stem build that shipped)* | **8** | 2.121 |
> | 6 lanes, colliding | **12** | 3.182 |
> | 6 lanes, staggered *(this build)* | **5** | 3.182 |
>
> **`3.182 / 2.121 = 1.500` exactly. Six stems do 1.5× the work and nothing makes
> them not** — the stagger moves *peaks*, not the mean. What it buys is that six
> staggered lanes pile up **less than the four-lane build ever did** (5 against 8)
> while carrying 1.5× the load.
>
> **Finding 1's "the peak scales linearly with the shifter count" is CONFIRMED,
> not superseded** — 8 → 12 across the two colliding rows at 4 → 6 lanes. The
> mechanism sentence outlived the instrument that first suggested it.
>
> **RATIOS AND COUNTS ARE CITABLE. ABSOLUTES ARE NOT.** ABBA-interleaved in one
> process, 8 passes: the collide/stagger **p95 ratio is 1.63×** at +6 (range
> 1.62–1.65) and **2.13×** at −6 (2.13–2.14), reproducing an earlier session's
> 1.63× / 2.14× **to within 1 % while the absolutes moved 69 %.** The **p50 ratio
> inverts, to 0.37× / 0.53×** — the staggered median is *higher* — and that pair is
> the mechanism in two numbers: *cheap in three quanta out of four and brutal on
> the fourth* becomes *flat, same area*.
>
> This is **ratios and counts are citable, absolutes are not** applied to a
> second instrument, for the reason
> it applies to RTF: on a box several agents share, a first attempt at absolutes
> swings far more than the effect being measured. **No absolute millisecond figure
> from this section may be quoted** — not in a commit body, not in a status line,
> not here. The ms rows in the first table above are the exception that proves it:
> they are evidence that **the instrument is unusable**, and quoting one of them as
> a cost would be quoting the thing they disprove.
>
> **The adversarial-row debt is unchanged, and it now rests on arithmetic rather
> than on a stopwatch.** The stagger moves peaks and not means; the mean is 1.5×
> by frame count; and even taking the four-lane build's own — now withdrawn —
> figure at face value, `2 decks BOTH switching` already sat at ~90 % of the render
> deadline. **1.5× the work does not fit in that.** It **ships as recorded debt**
> (`docs/SIX-STEM-CONTRACT.md` "Known debt" item 1), not as a solved problem, and
> the counting instrument is what will show it moving.
>
> **The rest of the section stands.** Findings 2–6 are **mechanism** claims — a
> constant group delay, a fade law, a routing order, a per-window cost. Their
> figures are re-printed by `node extension/engine/pitchbank.js` and
> `node extension/engine/keytap.js` on every run; read them from a run if a
> decimal matters, and apply the same rule — the ratios and the `-Infinity dB`
> identities are the durable half.
>
> Shape, for reading the row labels below: they say "5 delay lines / 4 shifters /
> ten planes" and describe `PITCH_LANES = 5`, `PITCH_PLANES = 10`, four shifted
> lanes. The shipped configuration is **`PITCH_LANES = 7`, `PITCH_PLANES = 14`,
> `PITCH_SHIFTED_LANES = [1,2,3,4,5,6]`** (`docs/SIX-STEM-CONTRACT.md`).

**Provenance, stated per line because these split three ways.** The
render-quantum costs, the equal-power crossfade figure and the gain-order figure
are printed by `node extension/engine/pitchbank.js` and the key-tap cost by
`node extension/engine/keytap.js` — **both now steps in `verify --quick`**
(added by Release Engineering in the same batch; before that neither was run by
anything). The numbers marked *measured here* are from runs on
this machine. The end-to-end cross-correlation is still **reported by the engine
owner and is not re-run here** — it needs the model seed and an exclusive machine
(the short-soak trap).

#### 1. The default state has no vocoder in the path at all

Per render quantum, 8000 quanta = 23.2 s of audio per row, node v24.7.0 on an
M-series Mac, 128-frame quantum = a **2.902 ms** deadline. **The columns are the
four `measure()` in `pitchbank.js` §8 actually returns.** *(This table carried a
`p99` column — `p99 1.772` and `p99 2.866` for the two-deck
rows, and `p99 0.004` / `p99 0.947` for two of the single-deck ones. `measure()`
has only ever computed **mean/p50/p95/max**, so no run of this suite could
produce, check or refute a single one of those figures. All six rows were then
re-measured, twice.)*

**⚠ THE TABLE BELOW IS WITHDRAWN — KEPT AS HISTORY, NOT AS EVIDENCE.** Every
figure in it is an absolute millisecond reading, and the note at the head of §1.6
records why none of them is citable: identical code re-measured 0.997 → 0.991 →
**1.685** ms at p95 on three consecutive runs. Read the frame counts in that note
instead. Nothing below has been edited — a withdrawn measurement is left legible
so the withdrawal can be checked.

| state | mean | p50 | **p95** | max | source |
|---|---|---|---|---|---|
| 1 deck at 0 — the DEFAULT, 5 delay lines | 0.002 | 0.003 | **0.003** | 0.051 | re-run every suite run |
| 1 deck at +6 — 4 shifters + 1 delay | 0.393 | 0.144 | **0.882** | 4.071 | re-run every suite run |
| 1 deck at −6 | 0.266 | 0.139 | **0.861** | 1.030 | re-run every suite run |
| 2 decks both transposed (Mode 3, +6 / −6) | 0.656 | 0.288 | **1.686** | 8.275 | harness, not the suite |
| 2 decks, one of them switching non-stop | 0.939 | 1.086 | **1.832** | 5.513 | harness, not the suite |
| 2 decks BOTH switching non-stop | 1.174 | 1.229 | **2.616** | 3.259 | harness, not the suite |

**All figures in ms. Two provenance tiers, and they are not the same claim.**
Rows 1–3 are re-measured on **every run** of `node extension/engine/pitchbank.js`
and printed — the suite builds one `PitchLanes`, so it cannot produce rows 4–6.
Those three were measured with a harness **mirroring `measure()`** (same 8000
quanta, same warm-up, same four statistics) driving two banks, and **nothing in
the tree re-runs them.** They are the best number available for the multi-deck
case and they are not a gate; treat a change in them as unnoticed until someone
measures again.

> **READ p95, NOT max, and the second run is why.** Between two consecutive runs
> `2 decks both transposed` moved its max **8.275 → 2.022 ms** while its p95 moved
> **1.686 → 1.693**. Every p95 held to within **0.02 ms** across the pair (the
> last row 2.616 → 2.630); **no max held to within 1 ms.** The row that settles it
> is `1 deck at 0`, which constructs **no shifter at all** — 640 array copies and
> nothing else — and still reports a **0.051 ms max against a 0.003 ms p95**, 17×
> its own p95. That column is GC, not this code.

*(Release Engineering re-ran rows 1–3 as a third sample: 0 →
mean 0.003 / p50 0.003 / p95 0.003 / max 0.010; +6 → 0.389 / 0.141 / **0.872** /
0.996; −6 → 0.265 / 0.138 / **0.857** / 1.012. Every p95 within 0.01 ms of the
table; the +6 max moved 4.071 → 0.996. Third consecutive confirmation of both
halves of the rule.)*

> **⚠ THE p95-IS-STABLE HALF OF THAT RULE IS NOW REFUTED, AND BY THE SAME KIND OF
> EVIDENCE THAT ESTABLISHED IT.** *()* "Read p95, not max" was inferred
> from three runs in which p95 happened to hold — 0.872, 0.882, and the 0.997 that
> opened the series. A **fourth and fifth** run of unmodified code then
> gave 0.991 and **1.685**. So p95 is *more* stable than max and is still **not
> stable enough to compare against a budget**, which is precisely what this block
> claimed it was good for. **Max was never citable and p95 is not either.** What
> holds across all of it is the frame counts and the collide/stagger ratios; the
> diagnosis in the block — that the max column is GC and not this code — survives
> and is in fact the same diagnosis, one percentile further in.

**The cost is bimodal**, because one quantum in four carries an STFT frame: the
synthesis hop is 512 samples and the quantum is 128. All shifters in a bank hit
that frame in the **same** quantum when they share the frame grid, so the **peak**
scales linearly with the shifter count while the mean scales with the work.

**That sentence is the one thing in finding 1 that has been independently
confirmed, and it was confirmed by counting rather than by timing:** 4 → 6
colliding lanes takes the peak **8 → 12 frames per quantum** while the mean goes
2.121 → 3.182, i.e. ×1.5 — peak linear in lane count, mean linear in work,
exactly as written. *(The withdrawn table showed the same shape as a p50/p95
spread within one row; that reading is no longer citable, and it does not need to
be — the counts say it better and they reproduce.)*

**The 0-semitone row is not a fast path, it is an absent one.** `pitchbank.js`
asserts `0 shifters constructed` at the home position — the ten planes are ten
exact delays and nothing else.

**What that does and does not license, stated as two claims because one clause
was carrying both and the second half of it was false.**

1. **CPU and underruns — not invalidated.** Every soak this project has already
   run was run in this state, and the state is unchanged, so the existing cost
   and dropout evidence still describes the shipped default.
2. **Latency — invalidated, by a known constant.** Those soaks ran a worklet
   with **no `PitchLanes` in it at all**: `extension/engine/pitch.js` and
   `pitchbank.js` are new files in this batch and
   `offscreen/playback-processor.js` grew the lanes with them. **A delay is not
   a shifter, and `0 shifters constructed` says nothing about it.** Ten exact
   delays are still ten delays of 3072 samples, so **every historical latency
   figure is 69.66 ms below what the same configuration reports today** — at 0
   semitones included. §7.2 carries the row; finding 2 below carries the
   constant.

The distinction is the whole design and it is worth stating in one line: *the
vocoder is conditional, the group delay is not.*

> ### The wall, restated in the units that survived — and the stagger has now been taken
>
> *(Rewritten This block used to read "p95 2.616 ms (2.630 on the
> second run) against 2.902 ms is the wall … ~270 µs of headroom at p95". **Those
> numbers are withdrawn** — see the head of §1.6 — and the paragraph below carries
> the same warning without them, because the warning was never really about the
> decimals.)*
>
> **The adversarial row is `2 decks BOTH transposed AND both mid-switch`.** It is
> a ~120 ms window per gesture and the shipped default costs a fraction of a core,
> which is why this is debt and not a defect. It was tight at four lanes and it is
> tighter now: **six lanes do exactly 1.5× the frames** (mean 2.121 → 3.182), and
> nothing in the design makes them not.
>
> **The stagger was the recorded upgrade path and it has been taken.** The two
> banks' frame grids now interleave instead of colliding, and the counting
> instrument says what it bought: the colliding six-lane peak of **12 frames per
> quantum drops to 5** — **below the four-lane build's own 8**, while carrying 1.5×
> the load. Expressed as the only kind of timing figure that reproduces here, the
> collide/stagger **p95 ratio is 1.63× at +6 and 2.13× at −6**, holding to 1 %
> across sessions in which the absolutes moved 69 %.
>
> **What the stagger does NOT do is remove the debt, and this is the part to read
> twice.** It moves *peaks*; the *mean* is untouched at ×1.5, which the p50 ratio
> makes visible by **inverting** (0.37× / 0.53× — the staggered median is
> *higher*). Cheap-in-three-quanta-and-brutal-on-the-fourth became flat with the
> same area under it. Since the four-lane build already sat at roughly 90 % of the
> render deadline on this row, **1.5× the work does not fit**, and no rearrangement
> of when the work happens changes that. It **ships as recorded debt** —
> `docs/SIX-STEM-CONTRACT.md` "Known debt" item 1.
>
> **The condition attached to the stagger was met.** The old text said: *"do not
> take the stagger without a matching content-anchor change or Δ stops being 0"*,
> the offset §6.5 calls structural. **The anchor did not move.** The onset lands at
> **sample 91272 on all seven lanes at +6, −6 and +3**, and both
> `drums-lane-is-never-shifted` and `all-lanes-are-one-exact-delay` still read
> **`-Infinity dB`**. The condition was real and it was cleared; it is recorded as
> cleared rather than deleted, so the next person to touch the frame grids knows
> which assertions are load-bearing.

#### 2. The transpose group delay is 3072 samples = 69.66 ms, and it is IMPORTED, not re-typed

It is added explicitly to `latencySec()` in **both** deck kinds. The reason the
constant is imported rather than copied is not tidiness: **`syncCorrection`'s
threshold is 60 ms and the delay is 69.7 ms**, so a second copy that drifted
would not throw — it would silently push every reading across a live threshold.
This is the entry-point family again (`AGENTS.md`): one value, two call
sites, and the failure mode is that they disagree quietly.

**End-to-end cross-correlation confirms the correction is right and not merely
present: reported 3.252 s vs measured 3.252 s, Δ −0 ms. Without it the Δ would
have been −70 ms.** *(Reported by the engine owner, not re-run here. It is the
only figure in this section that comes from a browser.)*

#### 3. Bank switching is an EQUAL-POWER crossfade, and the drums lane sits outside the banks because of it

The two banks' outputs are **uncorrelated** — different phase-vocoder state, the
same partials at different phases — so their **powers** add, not their
amplitudes. A linear law therefore dips: `pitchbank.js` measures **−2.66 dB at
the midpoint** against a ±1.0 dB gate. Equal power holds it to **0.11 dB** of the
mean steady-state power (0.3538 before, 0.3582 during, 0.3537 after). *Measured
here.*

**And that is exactly why the drums lane is routed outside the banks.** Drums are
never shifted, so both banks would render that lane **identically** — and an
equal-power fade of two *identical* signals is **+3.01 dB**, not 0. Every
transpose change would have put a ~50 ms bump on the kick. The lane is asserted
bit-exact through the switch (`-Infinity dB` residual, and again `-Infinity dB`
at +6 through and after the switch), which is the assertion that would catch
someone "simplifying" it back into the bank.

#### 4. The passthrough planes ARE shifted, and the reasoning is a product one

Passthrough is the unseparated mix, used to fill a span the engine could not
separate in time. It goes through the shifter with bass, other, vocals, guitar
and piano — `PITCH_SHIFTED_LANES = [1,2,3,4,5,6]` of 7 lanes, i.e. everything
except drums. *(Was `[1,2,3,4]` of 5; the two new stems are harmonic, so they
shift.)*

**The trade is: a wrong-key span against a drum-transient artefact, and they are
not comparable costs.** A user fingering an instrument against the track acts on
the key — a passthrough span in the original key while the rest of the mix is at
+3 is a musical error he plays into. A smeared transient degrades a span that is
*already* advertised as degraded, and the deck says so. **At 0 semitones — the
default, and the state the feature is off in — it costs nothing at all**, because
there is no shifter in the path (finding 1).

#### 5. Stem gains are applied DOWNSTREAM of the transpose, and an assertion pins the order

Gain and a linear shifter commute, so **the audio is identical either way** and
no listening test would find this. The cost is entirely in *when*: upstream
placement puts one group delay between the fader and the output, taking mute
response from a measured **18.0 ms** (the 6·τ ramp) to **~88 ms**. `run-ext.mjs`
gates mute response, so this would have shown up as a harness red with no
audible symptom and no obvious cause.

`shipped-worklet-applies-the-stem-gain-DOWNSTREAM-of-the-transpose` drives the
real processor and measures it: 0.500 before the mute, silence 18.0 ms after.
*Measured here.* **An ordering that is inaudible and load-bearing is exactly the
kind that gets refactored away**, which is why it is an assertion and not a
comment.

#### 6. The key tap costs 0.220 ms per window — 2.20 ms per second of one main thread

One 16 384-point window (read + Hann + rfft + fold + accumulate) at 10 Hz.
*Measured here; `keytap.js` prints it every run.* It runs on the **offscreen main
thread beside the pump, never on the render deadline** — which is why the
assertion's bar is 5 ms and not 2.902 ms. *(Handed over as 0.213 ms / 2.1 ms per
second; corrected to the run.)*

---

## 2. Chunking and seams

This is the section that decides whether the product sounds professional or broken. There are two independent failure modes:

1. **Clicks** — a waveform discontinuity at a splice. Broadband, obvious, easy to detect.
2. **Separation discontinuities** — the model assigns a held vocal note to `vocals` in chunk *k* and partly to `other` in chunk *k+1*. The waveform can be perfectly continuous and it still sounds like the singer is being switched on and off. This is the one that ruins the product, and naive butt-splicing guarantees it.

### 2.1 The counter-intuitive fact that drives the whole design

`HTDemucs.forward` with `use_train_segment=True` (the default, and the setting the pretrained checkpoints ship with) does this:

```python
training_length = int(self.segment * self.samplerate)     # 343980
if mix.shape[-1] < training_length:
    length_pre_pad = mix.shape[-1]
    mix = F.pad(mix, (0, training_length - length_pre_pad))
```

**A short segment is zero-padded up to 7.8 s and costs a full 7.8-second forward pass.** There is no compute saving whatsoever from feeding 2 s instead of 7.8 s — you just throw away context and get worse separation for the same money.

Consequence: **always feed the full 343 980 samples.** The only real design freedom is *where inside that window the emitted region sits*.

### 2.2 The segmentation

Split the 7.8 s window into four contiguous regions:

```
 chunk k input  = absolute samples [ k·H − P ,  k·H − P + L )
 chunk k emits  = absolute samples [ k·H ,  k·H + H + X )
                        crossfaded with chunk k−1 over the first X samples

 |<--------------------------- L = 343980 (7.8 s) --------------------------->|
 |<------- P ------->|<------ X ----->|<-------- H − X ------->|<-- X -->|<-R->|
 |   left context    |  crossfade in  |        emit flat       | fade out|right|
 |   (discarded)     |                |                        |         |ctx  |
                     ^
                     absolute sample k·H

 P + H + X + R = L        (invariant, asserted in makeLivePlan)
```

* `P` — **left context.** Real audio the model gets to look back at. **Costs nothing in latency** (it has already been captured).
* `H` — **hop.** One inference produces `H` new output samples. Real-time constraint: `T_inference ≤ H / fs`.
* `X` — **crossfade.** The overlap-add transition length.
* `R` — **right context / lookahead.** Real audio after the emitted region.

**Algorithmic lookahead = `H + X + R`.** That is the whole latency story: to emit output sample `k·H` you need input through `k·H − P + L = k·H + H + X + R`.

This is why left context is the thing to spend on. Set `P` as large as the budget allows and squeeze `H + X + R`.

### 2.3 Live presets

| Preset | `H` | `X` | `R` | `P` | lookahead | max `T_inf` | required RTF | model-seconds per output-second |
|---|---|---|---|---|---|---|---|---|
| **safe** (default) | 3.00 s | 0.50 s | 0.50 s | 3.80 s | **4.00 s** | 3.00 s | ≤ 0.385 | 2.6× |
| **fast** | 1.50 s | 0.25 s | 0.25 s | 5.80 s | **2.00 s** | 1.50 s | ≤ 0.192 | 5.2× |
| **tight** | 1.00 s | 0.15 s | 0.20 s | 6.45 s | **1.35 s** | 1.00 s | ≤ 0.128 | 7.8× |

`RTF = T_inference / 7.8`. "Model-seconds per output-second" = `7.8 / H` — the multiplier on GPU load versus a hypothetical zero-overlap pipeline. Note the tight preset burns **3× the GPU of the safe preset** to save 2.65 s of latency, and it needs a machine that runs HT-Demucs at RTF 0.128. Measure first (§7.3), then pick.

Export uses a different plan — see §2.7.

```js
import { makeLivePlan, TrapezoidOLA } from './snippets/ola.js';
const plan = makeLivePlan({ hopSeconds: 3.0, crossfadeSeconds: 0.5, rightContextSeconds: 0.5 });
// plan.L=343980  plan.H=132300  plan.X=22050  plan.R=22050  plan.P=167580
```

### 2.4 The window

**What upstream Demucs does.** `apply.py` lines 268–276, verbatim:

```python
# We start from a triangle shaped weight, with maximal weight in the middle
# of the segment. Then we normalize and take to the power `transition_power`.
weight = th.cat([th.arange(1, segment_length // 2 + 1, device=device),
                 th.arange(segment_length - segment_length // 2, 0, -1, device=device)])
assert len(weight) == segment_length
# If the overlap < 50%, this will translate to linear transition when
# transition_power is 1.
weight = (weight / weight.max())**transition_power
```

So: **a triangular (Bartlett) weight, linear transition, `transition_power = 1`** — not a Hann window. And crucially, upstream does **not** rely on COLA. It accumulates a running `sum_weight` and divides:

```python
out[..., offset:offset + segment_length] += (weight[:chunk_length] * chunk_out)
sum_weight[offset:offset + segment_length] += weight[:chunk_length]
...
assert sum_weight.min() > 0
out /= sum_weight
```

At the default `overlap = 0.25` the triangular weights sum to a *non-constant* function (measured peak-to-peak error 0.498 — see `selftest.js`), and the division is what fixes it. This is weighted-overlap-add (WOLA), which is a superset of COLA.

**What Stem Splitter Live does for the live path.** We use an exact-COLA trapezoid instead, because:

* No division ⇒ no `sum_weight` array ⇒ O(X) memory instead of O(track length).
* No division ⇒ a sample can be emitted the instant its last contributing chunk lands, with no bookkeeping about future contributions.
* Explicit `P` and `R` regions, so context discard is part of the window rather than a separate step.

```
 w[n] = 0                        0     ≤ n < P
        (n − P + 0.5) / X        P     ≤ n < P+X
        1                        P+X   ≤ n < L−R−X
        (L − R − n − 0.5) / X    L−R−X ≤ n < L−R
        0                        L−R   ≤ n < L
```

**Why the sum must be 1.0.** At any output sample `t`, the value we emit is `Σ_k w[t − k·H] · ŝ_k(t)`. If the overlapping chunks' model outputs `ŝ_k` agreed exactly (`k` is the chunk index here, not a stem index), that expression collapses to `ŝ(t) · Σ_k w[t − k·H]`. Any deviation of `Σ_k w` from 1.0 is therefore a **direct gain error on the output**, applied with a period of `H` samples — i.e. an amplitude modulation at `fs/H` = 0.33 Hz for the safe preset. A 0.5 dB ripple at 0.33 Hz is clearly audible as breathing. So COLA is not aesthetics; it is the difference between a flat frequency-independent gain of exactly 1 and a slow tremolo.

The proof that this trapezoid is COLA with hop `H = L − P − X − R`: in the crossfade, chunk *k*'s rise at local index `P+i` has weight `(i+0.5)/X`, and chunk *k−1*'s fall at the same absolute sample has weight `(X − i − 0.5)/X`. They sum to `X/X = 1` for every `i`. Outside the crossfade exactly one window is 1 and the rest are 0.

**Unit test.** `colaError(window, hop)` sums shifted copies and returns `max |Σ − 1|` over the steady-state interior:

```js
import { makeLivePlan, colaError } from './snippets/ola.js';
const p = makeLivePlan({ hopSeconds: 3.0, crossfadeSeconds: 0.5, rightContextSeconds: 0.5 });
assert(colaError(p.window, p.H) < 1e-6);   // measured: 3.0e-8 in Float32
```

Tolerance: **1e-6 for `Float32Array` windows** (1 ulp of float32 near 1.0 is 6e-8; a few accumulations puts you at ~3e-8, so 1e-6 leaves 30× headroom without being able to hide a real bug — a single-sample-off window gives an error of `1/X` ≈ 4.5e-5). Use 1e-12 if you build the window in Float64.

### 2.5 Choosing `X` (crossfade) and `R` (right context)

**`X` — crossfade length.** The crossfade's job is to hide *separation* discontinuities, not waveform discontinuities. A vocal note that chunk *k−1* put 100 % in `vocals` and chunk *k* puts 70 % in `vocals` / 30 % in `other` will cross-fade smoothly over `X`. The modulation rate you create is `1/X`:

| `X` | modulation | perceptual result |
|---|---|---|
| 5 ms | 200 Hz | reads as a click / buzz |
| 50 ms | 20 Hz | reads as a flutter |
| 250 ms | 4 Hz | reads as a fast fade — borderline |
| **500 ms** | **2 Hz** | **reads as a musical crescendo — inaudible as an artifact** |

**Recommend `X = 0.5 s` for the safe preset, never below 0.15 s.** Note this is the *opposite* of the usual DSP instinct (short crossfades preserve transients); here the thing being cross-faded is a slowly-varying assignment decision, so longer is better. Since the two segments contain the *same source audio*, a long crossfade costs nothing in transient smearing — where the model agrees, the crossfade is a no-op (`a·x + (1−a)·x = x`).

**`R` — right context.** There is no clean answer from architecture, and you should not pretend there is: HT-Demucs contains a **cross-domain transformer with global self-attention over the whole 7.8 s segment**, so the formal receptive field is the entire segment and no finite `R` guarantees edge-independence. What we *can* bound:

* STFT edge: `_spec` reflect-pads by `hop_length//2*3 = 1536` samples and uses `nfft = 4096`. The first/last ≈ 1.5 frames are edge-contaminated ⇒ **≥ 6 144 samples = 139 ms**.
* Temporal U-Net branch: 5 encoder layers, kernel 8, stride 4 ⇒ `1 + 7·(1+4+16+64+256) = 2 388` samples ≈ 54 ms one-sided, ~108 ms through the decoder.
* Musical context: an onset just past the boundary should be visible to the model. One beat at 90 BPM = 667 ms; half a beat at 120 BPM = 250 ms.

**Calibrate it, don't guess.** Runnable procedure:

1. Take a 30 s clip. Compute the reference output `y_∞` by centring the emit region (`P = R = (L − H − X)/2`).
2. For `R ∈ {0, 0.1, 0.25, 0.5, 1.0} s`, recompute the emit region with the same absolute sample positions.
3. Report `20·log10( ‖y_R − y_∞‖ / ‖y_∞‖ )` restricted to the emit region.
4. Pick the smallest `R` where that number is **below −40 dB**.

Until that measurement exists on real hardware, use `R = 0.5 s` (safe), `0.25 s` (fast), `0.20 s` (tight) — all comfortably above the 139 ms STFT floor.

### 2.6 The streaming overlap-add

Because the window is exact-COLA and `X ≤ H`, the entire accumulator is one `X`-sample tail per channel:

```js
const ola = new TrapezoidOLA(plan, 2);
for (let k = 0; ; k++) {
  const { start } = ola.inputRange(k);          // k*H − P, zero-pad where start < 0
  const seg  = readInput(start, plan.L);        // 2 × 343980
  const stem = await model.run(seg);            // 6 × 2 × 343980
  const out  = ola.push(stem.vocals, isFinal);  // exactly H samples (H+X+R when final)
}
```

Edge handling:

* **Chunk 0** has no predecessor, so its rise is bypassed (`w = 1` over the crossfade) — otherwise the track would fade in over 0.5 s. `TrapezoidOLA` does this automatically at `k === 0`.
* `start < 0` ⇒ zero-pad on the left. This matches upstream, which zero-pads with `F.pad` only at the true track edges and otherwise pulls real neighbouring samples (`TensorChunk.padded` clamps `correct_start`/`correct_end` to the real tensor).
* **Final chunk** emits `H + X + R` samples with `w = 1` after the rise (`push(seg, true)`).

**The strongest test available** is in `selftest.js`: replace the model with the identity function and require the pipeline to return its input.

```
TrapezoidOLA identity reconstruction   −160.6 dB   (gate: < −120 dB)
DemucsOLA    identity reconstruction   −Inf   dB   (gate: < −120 dB)
```

This isolates the DSP from the model completely. If this test fails, no amount of listening will tell you anything useful.

### 2.7 Export path — mirror upstream exactly

For Mode 2 (offline export) use `DemucsOLA`, which is a line-for-line port of `apply.py`:

* `segment_length = 343980`, `stride = int((1 − 0.25) · 343980) = 257985`
* offsets `range(0, length, stride)`
* triangular weight, `transition_power = 1`
* accumulate `weight·chunk` and `sum_weight`, then `out /= sum_weight`

This is not cosmetic: it is what makes the null test in §6.4 possible. If our export matches `python -m demucs -n htdemucs --shifts 0 --overlap 0.25` to −50 dB, every part of the port is proven at once.

Cost for a 4-minute track (10 584 000 samples): `len(range(0, 10584000, 257985)) = 42` forward passes × 7.8 s = 328 model-seconds. Multiply by `shifts` if > 0 and by 4 if using the `htdemucs_ft` bag.

`shifts`: upstream default is 1 (one random shift in `[0, 0.5·fs]`, output shifted back and averaged; worth "up to 0.2 points" of SDR per the docstring). Use `shifts = 0` for live (it multiplies cost with no latency benefit) and `shifts = 1` for export. `shifts = 2` costs 2× for maybe +0.1 dB; not worth it.

---

## 3. Stem mixing math

Reference: [`docs/snippets/mixer.js`](./snippets/mixer.js).

### 3.1 Fader law

Faders must be **linear in dB, not linear in amplitude**. A linear-amplitude fader spends its top half on the last 6 dB and its bottom 10 % on 20 dB — unusable for performance.

Stem Splitter Live fader law: piecewise-linear in dB, **unity at u = 0.80**, +6 dB at the top, hard zero at exactly u = 0.

```
 u = 0            → −∞ dB (true zero)
 0   < u ≤ 0.25   → −60 + 120·u                slope 120 dB/unit
 0.25 < u ≤ 0.50  → −30 +  60·(u − 0.25)       slope  60 dB/unit
 0.50 < u ≤ 0.80  → −15 +  50·(u − 0.50)       slope  50 dB/unit
 0.80 < u ≤ 1.00  →   0 +  30·(u − 0.80)       slope  30 dB/unit
```

Rationale for the shape: consoles put unity at ~80 % of travel so there is boost available above it; the resolution is finest (30–50 dB/unit) in the −15…+6 dB region where a DJ actually works, and coarsest at the bottom where nobody is listening. `dbToFader()` is the exact inverse (verified to 5.6e-17), so saved presets round-trip.

If you want a one-liner instead, the cube law `g = u³` is the common cheap alternative — but it puts unity at u = 1 and gives −5.8 dB at u = 0.8, which does not feel like a mixer. Use the piecewise law.

### 3.2 Mute / solo

```js
const anySolo = state.some(s => s.solo);
gain[i] = (anySolo ? state[i].solo : !state[i].mute) ? faderGain(state[i].fader) * master : 0;
```

Semantics, matching every DAW and every DJ mixer:

* **Any stem soloed ⇒ only soloed stems are audible.** A soloed stem's own mute is *ignored* ("solo wins").
* **Multiple solos are a union** — all soloed stems play, each at its own fader.
* **Solo-in-place**: soloing does not change the level of the soloed stem. Don't "make up" gain.
* Un-soloing everything restores the previous mute states — so store mute and solo as independent booleans, never collapse them into one tri-state.

Verified by truth table in `selftest.js`.

### 3.3 Ramping — no zipper noise, no clicks

Never write `gainNode.gain.value = x` on a user action. Use `setTargetAtTime`, which is a one-pole exponential: it reaches 63.2 % in τ, **95 % in 3τ, 99 % in 4.6τ**.

| Action | τ | 95 % settled | Rationale |
|---|---|---|---|
| Stem mute / kill | **3 ms** | 9 ms | Feels instantaneous (well under the ~20 ms rhythmic JND) and is far longer than the ~1 ms a step needs to become inaudible |
| Fader move | **10 ms** | 30 ms | Smooth under a fast hand, no stair-stepping from 60 Hz UI events |
| Master | 20 ms | 60 ms | |

Two mandatory details:

1. `setTargetAtTime` is **asymptotic** — it never reaches the target. For a mute, follow it with `param.setValueAtTime(0, t + 6τ)` so the node truly silences (otherwise you leave −80 dB of residue and, worse, denormals in the graph).
2. Always `cancelScheduledValues(t)` first, or a fast double-tap will interleave two ramps.

```js
rampGain(stem.gain, 0, ctx, TAU.mute);   // mute:   silent and exactly zero by t+18 ms
rampGain(stem.gain, 1, ctx, TAU.mute);   // unmute
```

### 3.4 Does Σ stems = original?

**Approximately, and you should measure it — but do not expect it to be exact.** HT-Demucs is trained with an L1 loss on each source independently. There is **no mixture-consistency constraint** in the architecture or the loss, so `Σ ŝ_i ≠ x` in general.

Measure `20·log10( ‖x − Σ ŝ_i‖ / ‖x‖ )`. Interpretation:

| Value | Meaning |
|---|---|
| −18 dB or better | Normal. This is the model's intrinsic mixture inconsistency. |
| −12 to −18 dB | Acceptable; investigate if it moves. |
| **worse than −12 dB** | **Bug.** Gain staging, window normalisation, resampling misalignment, or stem order. |
| −6 dB | Almost certainly a COLA/`sum_weight` error (a constant gain error of x means residual ≈ 20log10(x−1)). |
| −3 dB | One stem is missing or one is doubled. |

This is a **smoke test for our plumbing, not a quality metric for the model** — but it is the single cheapest test that catches the highest-severity class of bug, so run it on every export.

Two gotchas that will bite you:

* Upstream applies `out *= ref.std(); out += ref.mean()` to **every source**, so the denormalised stems carry `6 × mean` of DC while the mix carries `1 × mean`. For music `mean` ≈ 1e-5, i.e. ≈ −100 dB, so it is harmless — but subtract it (or set `mean = 0` on the stems) before running an exact reconstruction test, and fit a DC blocker anyway (§4.4).
* Compare in the same domain. If you resampled the mix to 44.1 k for the model, compare against the **resampled** mix, not the 48 k original.

---

## 4. Levels and headroom

### 4.1 How much can it overshoot?

| Source of overshoot | Realistic amount |
|---|---|
| `Σ ŝ_i` vs. `x` at unity gain | +0.5 to +1.5 dB (mixture inconsistency adds incoherently at peaks) |
| Any single stem in isolation | can exceed the mix peak — an isolated bass line reconstructed without the masking of the other stems routinely peaks +2 to +4 dB above its contribution to the mix |
| Fader boost | +6 dB per stem, by design |
| Two decks summed | +6 dB (coherent worst case), +3 dB (typical incoherent) |
| Sinc resampling intersample peaks | +0.5 to +3 dB on loud modern masters |
| Theoretical worst case, 6 stems at +6 dB, 2 decks | **+27.6 dB** — `20·log10(6) + 6 + 6`. Was +24.0 dB at four stems (`20·log10(4) + 6 + 6`); the stem count moves only the first term |

YouTube loudness-normalises to roughly −14 LUFS with peaks near −1 dBFS, so the *input* is well behaved. Everything downstream of the faders is not.

### 4.2 Gain staging alone is not sufficient

The argument for "just stage it properly": the DSP path is float32, which does not clip; only `AudioContext.destination` clamps to [−1, 1].

The argument against, which wins: a DJ **will** solo the vocal and push it to +6 dB, that is the point of the product. And Mode 3 sums two decks. Hard clipping in the DAC at a moment when the performer is pushing the vocal is exactly the worst possible failure, and it is silent-until-it-isn't. We need a backstop.

### 4.3 Recommendation: soft-clip the master, don't compress it

**Do not use `DynamicsCompressorNode`.** Its ratio is capped at 20:1 (a compressor, not a limiter), it colours the sound with its attack/release, and it introduces a fixed lookahead delay we would have to compensate everywhere.

Use a **`WaveShaperNode` soft clipper with 4× oversampling**. Zero latency, bit-transparent below the knee, no release-time tuning, no pumping:

```
sum → trim → gain(1/2) → WaveShaper(curve, oversample:'4x') → gain(2) → destination
```

```
 y = x                                              |x| ≤ T
 y = sign(x)·[ T + (1−T)·tanh((|x| − T)/(1 − T)) ]  |x| > T
 T = 0.7079  (−3.0 dBFS knee)
```

The ±2 pre/post gain pair exists because a `WaveShaper`'s curve domain is fixed to [−1, +1]; scaling by 2 lets the curve cover signals up to +6 dBFS, and Web Audio's clamping of the curve input gives a hard ceiling above that. Measured behaviour (`selftest.js`):

| Input | Output |
|---|---|
| −6 dBFS | −6.000 dBFS (transparent) |
| −3 dBFS (the knee) | −3.000 dBFS (transparent) |
| 0 dBFS | −0.63 dBFS |
| +6 dBFS | −0.001 dBFS |
| +12 dBFS and above | −0.001 dBFS (hard ceiling) |

`oversample: '4x'` is mandatory — without it, the harmonics the soft clipper generates above 11 kHz fold back as aliasing.

**Also required:** a true peak meter and a CLIP indicator. Compute peak **inside the AudioWorklet** over every sample and `postMessage` a max every 50 ms. Do *not* use `AnalyserNode` for this — it hands you a snapshot of the last 2048 samples whenever you happen to poll, so it misses peaks between polls. Light the CLIP indicator when the pre-shaper peak exceeds 0.99 so the user learns to pull down rather than relying on the safety net.

### 4.4 DC blocker

Separated stems, especially `bass` and `other`, can carry a small DC offset (partly the `+ref.mean()` quirk of §3.4, partly the model). Six of them summed, then soft-clipped, turns DC into asymmetric headroom loss. Insert a one-pole DC blocker per stem:

```
 y[n] = x[n] − x[n−1] + R·y[n−1]      R = 1 − 2π·fc/fs = 0.999288  (fc = 5 Hz @ 44100)
```

−3 dB at 5 Hz — well below the lowest musical fundamental (a 5-string bass low B is 30.9 Hz), so it removes nothing you want.

### 4.5 Export levels

Different rules — see §5.3. **Do not soft-clip exported stems.** Export 32-bit float and leave the samples untouched.

### 4.6 Export vs Bounce — two deliverables, two names, and a word withdrawn

**Export** is the six untouched model outputs at unity, 32-bit float, for a DAW (§4.5, §5.1).
**Bounce** is ONE file: what a deck is *playing*, rendered offline with its own settings baked
in, for a listener who wants what they heard. A deliverable and a mix are different things with
different consumers, so they get different names, and neither is ever called "the mix".

**A bounce bakes THREE things: faders, mute/solo (with the crossfader, which is the same
stage), and transpose.**

**Speed is not one of them, and the word is withdrawn WITH ITS REASON rather than dropped.**
The original wording — "faders, mute/solo, transpose and speed" — has no referent on the only
path that can bounce:

- `offscreen/engine.js`'s `SPEED` case refuses a cached deck in terms: *"this deck is playing
  stems from disk, so there is no page rate to drive"*.
- `CachedDeck` has no rate control anywhere in its surface, and a **File source is the only
  kind a Bounce can render** — a live deck holds no whole track.
- A **Live** source's speed is already baked into the captured stems by the browser's own
  renderer, upstream of the capture tap. `engine.js` says why the engine's rate field is not a
  control: *"IT IS A RECORD AND NOT A CONTROL."*

A bounce at a **different** speed is new time-stretch DSP. It is not baking, and it collides
with the standing key ruling that speed must not move the key (`qa/speed-pitch.mjs`). That is a
separate, later item and must not arrive here by accident.

**The master bus is NOT in a bounce**, and that is also deliberate: `offscreen/master.js` is one
soft clipper on the SUM of both decks — its own header says *"a soft clipper per deck cannot
protect the sum"* — so a per-deck bounce that ran one would apply a non-linearity that never
acted on this deck alone, to a deliverable. A bounce may therefore exceed ±1.0, which is
correct rather than tolerated: it is 32-bit float and `shared/wav.js`'s float path does not
clamp, for exactly the reason §5.1 gives.

The transpose lanes delay every plane by a constant 3072 samples at every setting including 0,
so the render is `frames + 3072` long and the deliverable is that render with its first 3072
frames trimmed off the head.

---

## 5. WAV format

Reference: [`docs/snippets/wav.js`](./snippets/wav.js).

> Stem Splitter Live no longer writes files for the user. `shared/wav.js` survives as the
> STEM CACHE's on-disk format in OPFS, and §5.4's byte map is what
> `node test.js wav` round-trips. §5.1–§5.3 are the offline-export policy and are
> retained as the reasoning behind 32-bit float, not as a description of a
> feature that exists.

### 5.1 Bit depth: 32-bit IEEE float (default), 24-bit PCM (option), 16-bit PCM (compatibility)

**Default: 32-bit float.** Justification, for a music-production deliverable:

* The whole chain is float32. 32f WAV is **lossless with respect to the model output** — no rounding, no dither decision, no clipping decision, no information lost.
* Individual stems routinely exceed 0 dBFS (§4.1). An integer format forces a destructive choice: clip, or rescale the file and destroy its relationship to the other five stems. Upstream Demucs faces exactly this and defaults to `--clip-mode rescale` (`wav / max(1.01·peak, 1)`), which silently changes the level of one stem relative to the others. That is a bug for our use case: **the six stems must remain at unity relative to each other so they sum back to the mix.**
* Every DAW built this century imports 32f WAV natively: Ableton Live, Logic, Pro Tools, Reaper, Bitwig, FL Studio, Cubase.
* Cost is 2× 16-bit. Real numbers for a 4-minute stereo stem at 44.1 kHz — 240 s × 44 100 = **10 584 000 frames**:

| Depth | per stem | all six |
|---|---|---|
| 32-bit float | 84.7 MB | **508.0 MB** |
| 24-bit PCM | 63.5 MB | 381.0 MB |
| 16-bit PCM | 42.3 MB | 254.0 MB |

*(Per-stem figures are unchanged; only the column that multiplies by the stem
count moved — **×6, was ×4**, so the totals were 338.7 / 254.0 / 169.3 MB.
Watch the collision: **254.0 MB is now the 16-bit total**, and it used to be the
24-bit one. Sample bytes only; add 58 B of RIFF per 32f file and 44 B per PCM
file, per §5.4.)*

Offer 24-bit for users who care about size (144 dB of dynamic range is far below any real noise floor; dither is optional and off by default) and 16-bit for compatibility with old samplers/hardware.

**Dither is mandatory for 16-bit.** Truncating a float32 signal to 16 bits correlates the quantisation error with the signal, which turns reverb tails and fade-outs into granular distortion instead of noise. Use **TPDF dither at 2 LSB peak-to-peak** (the sum of two independent uniform ±0.5 LSB variables), added before rounding:

```js
v = x * 32768 + (Math.random() - Math.random());
s = clamp(Math.round(v), -32768, 32767);
```

TPDF fully decorrelates the error and eliminates noise modulation, at the cost of raising the total error variance from `q²/12` to `q²/4` — **+4.77 dB** of noise, i.e. dynamic range for a full-scale sine drops from 98.1 dB to 93.3 dB. Do not add noise shaping in v1: it is a lot of code for a benefit nobody can hear in a stem that is about to be re-mixed.

Full-scale convention: multiply by **32768** (not 32767) and clamp. −1.0 maps to −32768, +1.0 clamps to +32767. This is what every DAW does; the alternative introduces a 0.0003 dB gain error and a needless asymmetry.

### 5.2 Sample rate: export at 44 100 Hz

**Export at the model's native 44.1 kHz. Offer 48 kHz as an explicit, off-by-default option.**

* The stems *are* 44 100 Hz. Upsampling to 48 k adds information-free samples, 8.8 % file size, one more filter pass of passband ripple, and creates intersample peaks that did not exist.
* We already resampled once on the way in (48 → 44.1). Exporting at 48 k means the audio round-trips **48 → 44.1 → 48**, passing through the transition band twice. Exporting at 44.1 k means one conversion, total.
* 44.1 kHz is the dominant music-production rate and the CD rate. A user working at 48 k in a video project has a DAW that will resample on import, using a resampler at least as good as ours, at a point in the workflow where they can hear the result.
* Offer the 48 k option (same `Resampler`, `resampleBuffer(x, 44100, 48000)`) for post/video users, clearly labelled, and never make it the default.

### 5.3 Channel layout and clipping policy

* **Stereo, interleaved L R L R …**, matching the model's 2-channel output. No mid/side, no channel mask, no `WAVE_FORMAT_EXTENSIBLE` (unnecessary and confuses some readers at 2 channels).
* **No clip protection on export at 32f.** Write the samples exactly as the model produced them, out-of-range values included; the DAW will handle them.
* For 24/16-bit export, clamp (do not rescale) and surface a warning listing which stems clipped and by how much, with a one-click "switch to 32-bit float" action. Rescaling breaks the stems' mutual balance and must never be silent.
* Trim to the source length. The final chunk emits `H + X + R` samples and the model may have been zero-padded; the file must be exactly `numFrames = round(sourceSeconds · 44100)`.
* RIFF sizes are 32-bit: hard limit `numFrames · blockAlign ≤ 2^32 − 100`. At 44.1 k stereo 32f that is **3.38 hours** (6.76 h at 16-bit) — fine for songs, but assert it rather than producing a corrupt file. Beyond that you need RF64 or Wave64, which is out of scope.

### 5.4 Exact WAV byte layout

**32-bit float (default).** Format tag 3 requires `cbSize` (so `fmt ` is 18 bytes) and a `fact` chunk per the WAVE spec.

| Offset | Size | Type | Value |
|---|---|---|---|
| 0 | 4 | ASCII | `"RIFF"` |
| 4 | 4 | u32 LE | `fileSize − 8` = `4 + 8+18 + 12 + 8 + dataSize` |
| 8 | 4 | ASCII | `"WAVE"` |
| 12 | 4 | ASCII | `"fmt "` (note the trailing space) |
| 16 | 4 | u32 LE | **18** |
| 20 | 2 | u16 LE | `audioFormat` = **3** (`WAVE_FORMAT_IEEE_FLOAT`) |
| 22 | 2 | u16 LE | `numChannels` = 2 |
| 24 | 4 | u32 LE | `sampleRate` = 44100 |
| 28 | 4 | u32 LE | `byteRate` = `sampleRate · blockAlign` = 352800 |
| 32 | 2 | u16 LE | `blockAlign` = `numChannels · bitsPerSample/8` = 8 |
| 34 | 2 | u16 LE | `bitsPerSample` = 32 |
| 36 | 2 | u16 LE | `cbSize` = 0 |
| 38 | 4 | ASCII | `"fact"` |
| 42 | 4 | u32 LE | 4 |
| 46 | 4 | u32 LE | `numFrames` (samples **per channel**) |
| 50 | 4 | ASCII | `"data"` |
| 54 | 4 | u32 LE | `dataSize` = `numFrames · blockAlign` |
| 58 | … | float32 LE | interleaved `L₀ R₀ L₁ R₁ …` |

**16- or 24-bit PCM.** Format tag 1, `fmt ` is 16 bytes, no `cbSize`, no `fact`:

| Offset | Size | Type | Value |
|---|---|---|---|
| 0 / 4 / 8 | 4 / 4 / 4 | | `"RIFF"` / `fileSize − 8` / `"WAVE"` |
| 12 | 4 | ASCII | `"fmt "` |
| 16 | 4 | u32 LE | **16** |
| 20 | 2 | u16 LE | `audioFormat` = **1** |
| 22 | 2 | u16 LE | 2 |
| 24 | 4 | u32 LE | 44100 |
| 28 | 4 | u32 LE | `44100 · blockAlign` (176400 @16-bit, 264600 @24-bit) |
| 32 | 2 | u16 LE | `blockAlign` (4 @16-bit, 6 @24-bit) |
| 34 | 2 | u16 LE | `bitsPerSample` (16 or 24) |
| 36 | 4 | ASCII | `"data"` |
| 40 | 4 | u32 LE | `dataSize` |
| 44 | … | | samples |

Sample encoding:

* **16-bit** — `int16` LE, two's complement, `round(x · 32768 + tpdf)` clamped to [−32768, 32767].
* **24-bit** — 3 bytes LE, two's complement, `round(x · 8388608)` clamped to [−8388608, 8388607]. Write low byte first: `v & 0xFF`, `(v >> 8) & 0xFF`, `(v >> 16) & 0xFF` (after adding `0x1000000` to negatives).
* **32f** — IEEE-754 `float32` LE. Nominal full scale ±1.0; values outside are legal.

Every chunk body is padded to an even length. With stereo, `blockAlign` is 4/6/8 so `dataSize` is always even and the pad byte never appears — but write the code that handles it anyway (`if (dataSize & 1) writeByte(0)`), because mono debug dumps at 24-bit will hit it.

All of the above offsets are asserted in `selftest.js`, section 5.

---

## 6. Objective quality tests QA can automate

Reference: [`docs/snippets/make-testbed.js`](./snippets/make-testbed.js), [`docs/snippets/bss-eval.js`](./snippets/bss-eval.js), [`docs/snippets/selftest.js`](./snippets/selftest.js).

The tests are ordered by value per unit of effort. **Tier 1 and 2 must be in CI.**

### 6.1 Tier 1 — `selftest.js` (no model, no audio device, < 3 s)

```
node docs/snippets/selftest.js
```

Covers: segment constants, COLA for all three presets, **identity-model overlap-add reconstruction** (the single most valuable DSP test we have — gate −120 dB, measured −160.6 dB), resampler round-trip and alias rejection, WAV round-trip and byte-exact header layout, fader/mute/solo truth table, soft-clip transfer function, DC blocker, Demucs normalisation round-trip, and — **section 9, added by the 6-stem migration** — the testbed ground truth of §6.2, by running `make-testbed.js`'s own `checkTestbed()` inside the suite.

**84 assertions, 2.76 s** (run here node v24.7.0). Section
9 exists because `make-testbed.js` synthesised exactly **four** sources through
the whole first pass of the 6-stem migration and **nothing went red**: a 6-stem
model run on 4-source material produces a near-silent `guitar` and `piano`, and
near-silent output satisfies every "reads exactly 0" assertion in the repo. That
is the VOID rule at the suite scale — two stems reported green by reading
nothing. Section 9 is the fix, and it has no `!x || (check)` guard anywhere in
it: a missing source is a FAIL.

Every one of these will fail loudly on the bugs engineers actually ship: off-by-one in the window, wrong stride, stem order swapped, 32767-vs-32768 scaling, `setTargetAtTime` never reaching zero.

### 6.2 Generate the ground truth

```
node docs/snippets/make-testbed.js  ./qa/testbed  30 120            # musical
node docs/snippets/make-testbed.js  ./qa/steady   30 120 --steady   # stationary
```

Two 30 s / 44.1 kHz / stereo / 32f multitracks, deterministic from a seed, with `mix.wav` **exactly** equal to the sum of **all six** sources — `drums + bass + other + vocals + guitar + piano` — asserted at generation. Measured **−144.5 dB** (musical) and **−143.6 dB** (stationary) by `node docs/snippets/make-testbed.js --check`, which renders 8 s and 6 s respectively; the 30 s QA renders read −144.4 / −143.7 and a CLI max |err| of **1.19e-7**. *(Was "max error 9.7e-8" against four sources.)*

The honesty gate is not just the sum: `--check` also runs **six single-omission controls**, one per source, so the reconstruction assertion cannot pass by comparing a mix against itself. Worst single omission on the musical testbed is **−6.3 dB** (dropping `vocals`) and all six land between **−6.3 and −9.8 dB**, against a −144.5 dB reconstruction — three orders of magnitude of margin. On the stationary testbed the worst is **−1.9 dB** (`bass`, which dominates that render).

*Musical* testbed, 120 BPM, four-bar loop: synthesised kick/snare/hats, a filtered saw bass, a formant-synthesised vocal line with vibrato, a detuned pad plus a plateau-envelope synth stab (`other`), a strummed Karplus–Strong guitar, and an inharmonic piano. Levels are mixed like a pop record — **drums −23.9 dBFS RMS, bass −25.3, other −26.9, vocals −23.3, guitar −24.9, piano −25.0; mix peak −1.00 dBFS** (30 s render). Every onset has a 1.5 ms raised-cosine attack, **every note now ends on a raised-cosine release taper** (see the defect below), and every stem is band-limited at 18 kHz, so **the material itself contains no sample-scale discontinuities** — any spike in the output came from us.

**`guitar` and `piano` are built to be confusable but separable, and both properties are asserted as numbers by `checkTestbed()`.** All three of `other`, `guitar` and `piano` play the same progression in the same key as the vocal, in overlapping registers, so their octave-band energy profiles have cosine similarity **> 0.5** — a separator cannot win on a band-split. What differs is time and partial structure: `guitar` is purely harmonic, strummed (six strings 14 ms apart, alternating strokes) with broadband pick noise; `piano` is inharmonic (`f_n = n·f0·√(1 + B·n²)`, `B = 3.5e-4`), with per-partial decay, a low-passed hammer thump and sustain pedal. No two sources share an onset grid.

> **Why `other` lost its plucks, so this does not read as a regression.** The Karplus–Strong pluck was **removed from `other` and moved to `guitar`**, and `other` gained the plateau-envelope stab in its place. `htdemucs_6s` pulls plucked strings out of `other` *by definition*, so a pluck left in `other` would make §6.3's leakage gate — a hard FAIL when a row's diagonal is not its row maximum — **fire on correct separation.** A false red costs more than a missing test.

> ### The "no sample-scale discontinuities" claim above was FALSE
>
> It is stated as a defect rather than edited in silently, because **§6.5's
> `[ADVISORY]` seam numbers on musical material were taken against contaminated
> material** and a future reader needs to know that.
>
> The bass, the kick, the snare, the hats and the old `other` pluck all simply
> **stopped mid-decay** — at **4.1 %, 6.9 %, 1.8 %, 5.0 % and 41 %** of their own
> envelopes respectively. Those steps sat *inside* the material the seam detector
> normalises against, so **the detector was partly measuring its own testbed.**
> The 41 % is the one to look at: the old `other` pluck was still at 41 % of its
> own envelope when it stopped, every note.
>
> All six generators now end on a raised-cosine release taper (`rel()` in
> `make-testbed.js`). The claim is true for the first time.
>
> **Second defect, same file, same class.** `makeStationary`'s fade was a fixed
> **0.5 s**, which is **17 % of a 6 s render** — so the 5th percentile of the
> 20 ms envelope landed *inside the ramp*, every source read as dynamic, and
> `bss-eval.js` classified the stationary file as **MUSICAL**. That turns the
> seam gate to ADVISORY **in the one place it is a gate.** The fade now scales:
> never more than **2.5 % of the file at each end**, and at the 30 s QA renders it
> is the same 0.5 s it always was. `checkTestbed()` now asserts the classification
> of both testbeds, so it cannot flip silently again.

*Stationary* testbed: the same **six** source categories held as steady states — steady cymbal wash plus low rumble (`drums`), sustained saw bass, sustained chord (`other`), sustained vowel, and, for the two new stems, the one spectral fact that tells them apart with the onsets removed: `guitar` is a sustained **exactly-harmonic** partial stack behind the same body filter, `piano` a sustained **inharmonic** one at the same `B = 3.5e-4`. No onsets at all. This is what the seam gate runs on — see §6.5.

> **⚠ ALL GOLDEN NUMBERS RECORDED AGAINST THE 4-SOURCE TESTBED ARE VOID.** The
> mix is a different signal: two more sources, a different `other`, and a
> different peak-normalisation gain. Every per-stem SDR/SIR/SAR golden, every
> leakage figure and every seam measurement taken before must be
> **RE-RECORDED**. Do not adjust a gate to match a new number, and do not carry
> an old number forward.

**Honest caveat, put it in the QA runbook:** synthetic material is out of distribution for HT-Demucs. Absolute SDR here will be well below the 8–10 dB the model gets on MUSDB. Use it as a **regression gate against a recorded golden run**, not as an absolute quality bar. For absolute quality, keep one real MUSDB18-HQ test track (or a Cambridge-MT multitrack) in the QA fixtures.

### 6.3 Tier 2 — separation metrics

```
node docs/snippets/bss-eval.js ./qa/testbed ./qa/out --hop 132300 --crossfade 22050
```

Reports per stem:

* **SDR / SIR / SAR** — BSS-Eval with filter length 1: project the estimate onto the span of the **six** ground-truth sources, split into target / interference / artifact. Reported both globally and as the **median of 1 s frames** (the `museval` convention).

  **That span is the whole reason §6.2 had to grow to six sources, and it is not a coverage argument.** The projection basis *is* the span of the ground truth. Run a 6-stem model against 4-source truth and the energy that belongs to `guitar` and `piano` does not go unmeasured — it gets **attributed to whichever source is nearest**, and every number in the table changes. **A narrow basis does not produce narrow metrics; it produces WRONG metrics**, for the four stems that were already there as much as for the two that were not.
* **SI-SDR** — scale-invariant SDR (Le Roux et al. 2019). Gain-robust, so it separates "wrong level" from "wrong content".
* **Leakage matrix** — Pearson correlation of 20 ms log-energy envelopes, estimate × ground truth. The diagonal must be the row maximum; this is what catches a **stem-order swap**, which SDR alone will not make obvious.
* **Reconstruction** — `20·log10(‖mix − Σ est‖ / ‖mix‖)`, gated at −12 dB (§3.4).

Reference points from the HT-Demucs paper (MUSDB HQ test, 800 extra training songs), for calibrating expectations on *real* music:

| Model | All | Drums | Bass | Other | Vocals |
|---|---|---|---|---|---|
| HT Demucs (`htdemucs`) | 8.80 | 10.05 | 9.78 | 6.42 | 8.93 |
| HT Demucs fine-tuned (`htdemucs_ft`) | 9.00 | 10.08 | 10.39 | 6.32 | 9.20 |

Note `other` is always ~3 dB worse than the rest. That is the model, not our bug.

> **This table is the FOUR-source `htdemucs`, and there is no `htdemucs_6s` row in
> it.** It is left standing because it is still the right calibration for what a
> hybrid-transformer separator achieves on real music, and because §6.3's gates
> are relative to a golden run rather than to these absolutes. **Do not read the
> `Other` column as a prediction for our `other`**: the 6-source model carves
> `guitar` and `piano` out of exactly that residue, so the two are not the same
> quantity. A per-source `htdemucs_6s` reference belongs here and must be
> **sourced, not estimated**.

Also from the paper's ablation, the quantified segment/quality trade-off:

| training segment | params | RTF (CPU) | SDR (All) |
|---|---|---|---|
| 3.4 s | 26.9 M | 1.02 | 8.17 |
| **7.8 s** | 26.9 M | 1.49 | **8.70** |
| 7.8 s (dim 512) | 41.4 M | 1.77 | 8.80 |
| 12.2 s | 26.9 M | 2.04 | OOM |

**+0.53 dB for 7.8 s over 3.4 s.** That is the price of latency, and it is why we keep the full segment and shrink `H + X + R` instead.

**How to set the gates.** Run the pipeline once on a build you have listened to and approved. Record the numbers. Gate at **golden − 0.5 dB** per stem, plus the absolute gates (reconstruction < −12 dB, diagonal-dominant leakage). Do not invent absolute SDR thresholds for synthetic material.

**The golden run itself is VOID since** (§6.2): the testbed is a
different signal, so a `golden − 0.5 dB` gate carried over from four sources is
measuring against material that no longer exists. Re-record the golden on the
6-source testbed. The two *absolute* gates are unaffected and stay exactly where
they are — do not move a gate to accommodate a new number.

### 6.4 Tier 2 — the null test against the Python reference (highest value)

This is the test that proves the entire ONNX/WebGPU/JS port at once.

```bash
python -m demucs -n htdemucs_6s --shifts 0 --overlap 0.25 --float32 -o ref qa/testbed/mix.wav
node docs/snippets/bss-eval.js ref/htdemucs_6s/mix ./qa/out    # ref as "truth"
```

Then compute per stem `20·log10(‖ours − ref‖ / ‖ref‖)`.

**Gate: ≤ −50 dB.** Rationale: `demucs-onnx` reports PyTorch parity of ~1.6e-4 (≈ −76 dB), and fp32 GPU-vs-CPU reduction-order differences add a few dB on top. Anything worse than −50 dB means a real discrepancy — a window, a stride, a normalisation, a resampling offset, or a transposed tensor. Anything better than −70 dB means the port is essentially exact.

**The model is `htdemucs_6s` and the checkpoint name matters twice here** — it
selects the six-source reference, and it is what `tools/model-parity.mjs` pins
the verified source order against. Run the null test per stem across all six;
a port that is exact on four and wrong on two is the exact failure the 6-stem
migration can produce.

Run this on the export path (`DemucsOLA`, overlap 0.25, shifts 0) so the chunk grids match exactly.

### 6.5 Tier 2 — seam detection

Two complementary tests. **Chunk seams are the highest-severity audio risk in this product, so both are worth having.**

**(a) Single-pass click detector, on stationary material.**

`bss-eval.js` computes, at every boundary `k·H` and `k·H + X`, the peak second difference within ±1 ms normalised by the median over a ±6 ms neighbourhood, then divides by the 95th percentile of the same statistic at 24 jittered control positions (±5–80 ms) around each boundary.

The control normalisation matters: chunk boundaries land on downbeats (3.00 s hop at 120 BPM is beat 6, every time) and any naive absolute threshold just measures the kick drum. Even with controls, on musical material the statistic is confounded — which is why the **gate only applies to the stationary testbed**, where there are no transients at all and any spike is definitionally ours. On musical material the numbers print as `[ADVISORY]`.

Measured discrimination on the stationary testbed:

| synthetic separator | worst clickRatio | verdict |
|---|---|---|
| clean (constant 6 % leakage) | **1.02 – 1.06** | PASS |
| butt-spliced (leakage sign flip at every `k·H`) | **up to 3.37** | FAIL |
| same flip, cross-faded over `X` | **1.02 – 1.03** | PASS |

> **⚠ VOID — all three rows were measured on the 4-source stationary testbed.**
> That file is a different signal now: six sources, a different `other`, and a
> different peak-normalisation gain, all of which move the ±6 ms neighbourhood
> median and the 24 jittered controls this statistic is normalised by.
> **RE-RECORD all three rows.** The discrimination may come out wider or
> narrower; neither is a licence to move the gate.
>
> **Two further reasons to re-run rather than assume**, both from §6.2. First,
> the stationary file's fade defect meant a short render classified as MUSICAL,
> so any seam figure taken from a short stationary render was **advisory, not
> gated** — check the header of the run you are comparing against. Second, the
> release-taper defect was in the *musical* generators, so it is the
> `[ADVISORY]` musical seam numbers that were taken against material carrying
> its own steps; the detector was partly measuring its own testbed there.

**Gate: clickRatio < 2.0** on stationary material. **The gate does not move** —
it is an absolute, and §6.2's fade fix is what makes the stationary file actually
reach it (before that fix a 6 s render classified as MUSICAL and the gate was
never armed).

**(b) Grid-offset invariance — the definitive test.**

Run the same audio through the live pipeline twice, the second time with the chunk grid shifted by `H/2`. A correct pipeline is *nearly* grid-independent (the model output genuinely differs with different context, so expect a global difference around −15 to −25 dB), but the difference must **not be concentrated at the boundaries**:

```
excess_dB = 20·log10( RMS(A − B) within ±X of any boundary of A or B )
          − 20·log10( RMS(A − B) elsewhere )
```

**Gate: `excess_dB < 3 dB`.** A butt splice puts all the difference at the seams and blows straight through this. It is content-independent, needs no stationary material, and cannot be fooled.

### 6.6 Tier 3 — resampler verification in the real browser

Because §1.2 delegates resampling to Chrome, verify Chrome. In the offscreen document:

1. Synthesise a 20 s logarithmic sweep, 20 Hz → 20 kHz, at 48 000 Hz, amplitude 0.5, in a `Float32Array`.
2. Feed it through the production path (`MediaStreamAudioDestinationNode` → `MediaStreamAudioSourceNode` into the 44 100 Hz context) and capture the worklet output.
3. Report: passband deviation 20 Hz–19 kHz (**gate: ±0.5 dB**), and out-of-band energy above 19 kHz relative to the sweep (**gate: ≤ −60 dB**).

If this ever fails, flip a feature flag to route the input through `docs/snippets/resample.js` instead. The flag should exist from day one.

**These two gates are also the bar every other resampler in the tree has to
clear**, and that is deliberate — one bar, not one per component. `AGENTS.md`'s
amended no-JS-resampling ruling makes clearing them a *condition* of shipping a
downstream pitch transform, and `extension/engine/pitch.js` runs them against
its own kernel in Node rather than in the browser (tones and white noise
straight into the shifter, no `MediaStream`): passband **±0.02 dB, 40 Hz–19 kHz**
against ±0.5, out-of-band **−116.9 dB** against −60. The one exception, 20 Hz, is
§1.5 finding 2, and it is encoded in the assertion rather than waived in prose.

### 6.7 CI shape

| Job | Runtime | Needs GPU | Gate |
|---|---|---|---|
| `selftest.js` | 3 s | no | all assertions |
| `make-testbed` + export path + `bss-eval` (musical) | ~2 min | yes | golden − 0.5 dB, recon < −12 dB, leakage diagonal |
| `make-testbed --steady` + live path + `bss-eval` | ~2 min | yes | clickRatio < 2.0 |
| grid-offset invariance | ~4 min | yes | excess < 3 dB |
| Python null test | ~5 min | yes | ≤ −50 dB per stem |
| Chrome sweep test | 30 s | no | ±0.5 dB / −60 dB |

---

## 7. Latency budget for live mode

### 7.1 The formula

```
D_startup  =  (H + X + R)   +   T_inf   +   J   +   D_fixed
                lookahead      inference    jitter    ~165 ms
```

*(`D_fixed` was `~96 ms`. The transpose group delay — 69.66 ms,
present at **every** setting including the 0-semitone default — is now a row in
§7.2's table rather than a note under it, and every figure below carries it. The
old value is what the pre-`PitchLanes` soaks measured; see §1.6 finding 1.)*

subject to the real-time constraint `T_inf ≤ H` (one forward pass must complete within one hop, or the buffer drains and you get a dropout).

Choosing `H = T_inf / ρ` with a utilisation target `ρ ≈ 0.7`:

```
D_startup  ≈  2.43 · T_inf  +  X  +  R  +  J  +  165 ms
```

**Latency is set by inference speed, and it costs about 2.4 seconds of startup per second of inference time.** That is the single most important number in this document.

### 7.2 Itemised budget

Safe preset, assuming a measured `T_inf` of 2.0 s for one 7.8 s forward pass:

| # | Contributor | ms | Notes |
|---|---|---|---|
| 1 | YouTube decoder → tab audio | 10 | Chrome's capture pipeline works in 10 ms chunks |
| 2 | `tabCapture` → `MediaStreamAudioSourceNode` FIFO + 48→44.1 sinc | 20 | includes the resampler's own buffering |
| 3 | Capture `AudioWorklet` render quantum | 2.9 | 128 frames @ 44100 |
| 4 | **Segment fill — algorithmic lookahead `H + X + R`** | **4000** | **dominant; see §2.2** |
| 5 | Worker transfer in | 1 | 343 980 × 2 × 4 B = 2.75 MB, transferable, zero-copy |
| 6 | **Inference `T_inf`** | **2000** | **measure this; everything else follows from it** |
| 7 | GPU→CPU readback + OLA + gain | 30 ⚠ | **6** stems × 2.75 MB. The 30 ms is an ESTIMATE sized at four stems and has NOT been re-measured; six stems move 50 % more data through the same readback |
| 8 | **Jitter buffer `J`** | **1000** | absorbs inference-time variance; size at `3σ + worst observed spike` |
| 9 | Player `AudioWorklet` quantum | 2.9 | |
| 10 | **Transpose group delay — `PitchLanes`** | **69.66** | **3072 samples, at EVERY setting including 0. See below** |
| 11 | `AudioContext.outputLatency` | 25 | macOS CoreAudio, `latencyHint: 'playback'` |
| 12 | 44.1→48 output sinc resample | 4 | |
| | **Total** | **≈ 7 165 ms** | |

Items 1–3, 5, 7, 9–12 sum to **165.5 ms**. Everything else is the model.

*(Row 7 carries the one un-re-measured number in that sum after the 6-stem
migration. It is 18 % of the fixed 165.5 ms and 0.4 % of the total, so it does
not change any recommendation in §7.3 — but it is flagged rather than quietly
scaled, because the last time this table carried a wrong row it cost an
investigation, and the fix for that is not to add a second one.)*

**Row 10 is permanent, and the previous revision of this section got it exactly
backwards.** *(Corrected It read: "not in the budget because it is
zero at the default setting … when a deck is transposed, add 70 ms by hand." The
instruction is inverted — it applies always, and the row is the fix.)*

At 0 semitones there is no **phase vocoder** in the path (§1.6 finding 1, and
`pitchbank.js` asserts `0 shifters constructed` there). There is still a
`MatchedDelay` of exactly 3072 samples **on every lane** — `pitch.js`'s constant
is documented as the latency "at EVERY setting including 0 semitones",
`live.js::latencySec()` and `cacheddeck.js::latencySec()` both add
`PITCH_GROUP_DELAY_SAMPLES / SR` **unconditionally**, and `test.js` pins a cached
deck at 0 semitones to `48 ms out + 69.66 ms transpose` as an equality to 1e-9.
§1.6 finding **1** states it as "the ten planes are ten exact delays" — that
sentence is in finding 1, not finding 2; §7.2 mis-cited it, and
its "ten" is the pre-6-stem plane count that §1.6's header note explains. The
assertion
that says it outright is `pitchbank.js`'s
**`all-lanes-are-one-exact-delay: at semitones 0 every one of the 14 planes is
its own input delayed by exactly 3072`** — `-Infinity dB` residual, re-run here
*(The assertion name read `10 planes`; the 6-stem
migration took `PITCH_PLANES` 10 → 14 and the quote is updated to match the code.
The delay itself, 3072 samples = 69.66 ms, is set by the causality floor of the
worst ratio and **does not depend on the plane count** — see below.)*
**Neither the plane count nor the frame-grid stagger moved this row.** Both
`all-lanes-are-one-exact-delay` and `drums-lane-is-never-shifted` still read
`-Infinity dB` at fourteen planes with the banks staggered, and the content
anchor is unmoved: the onset lands at **sample 91272 on all seven lanes at +6,
−6 and +3.** That is what makes the 69.66 ms in row 10 a single constant rather
than a function of the interval or of which bank is live. Note that
it sits *beside*
`routing-uses-no-phase-vocoder-at-semitones-0`: the two together are the whole
point, and reading only the second is how the row went missing. So the old
"Items 1–3, 5, 7, 9–11 sum to 96 ms" was not merely light for transposed decks —
it was **69.66 ms light in every configuration the product ships in**, the
default loudest among them.

**Why the delay is constant rather than conditional, since this is the part
worth not re-litigating.** A latency that appeared when the user engaged
transpose would step both decks' alignment mid-set: two decks, one transposed,
would flam by 70 ms against a project drift bar of **< 50 ms**
(the two-deck acceptance criterion). Paying the
delay unconditionally buys a group delay that is one number rather than a
function of the interval — which is also what lets `drums` (never shifted) stay
sample-aligned with the five shifted stems and the shifted passthrough through
the same read pointer, and what lets the bank crossfade be latency-exact. `pitch.js`'s header
carries the causality floor that sets the value: `D ≥ 2562` at the worst ratio,
rounded up to 6·Hs = 3072.

The number is still applied at run time from one **imported** constant, in both
deck kinds — never re-typed. `syncCorrection`'s correction threshold is 60 ms and
sits *below* 69.66 ms, so a second copy that drifted would not throw; it would
push every reading across a live threshold in silence.

*Provenance of this correction: found by adversarial review, not by a reader —
and that is the same failure mode as a scope cut list
(). **A budget table is read by someone
planning work, not by someone doing it**, so a wrong row is never hit by the
person who would notice. It needs auditing, because it will not report itself.*

### 7.3 What it looks like across presets and hardware

Sizing the jitter buffer at `J = 0.5·T_inf`, startup is `lookahead + 1.5·T_inf + 165 ms`:

| Measured `T_inf` (7.8 s pass) | RTF | safe (H=3.0) | fast (H=1.5) | tight (H=1.0) |
|---|---|---|---|---|
| 0.8 s | 0.103 | 5.37 s | 3.37 s | **2.72 s** |
| 1.0 s | 0.128 | 5.67 s | 3.67 s | 3.02 s ⚠ |
| 1.5 s | 0.192 | 6.42 s | 4.42 s ⚠ | ✗ drains |
| 2.0 s | 0.256 | 7.17 s | ✗ drains | ✗ |
| 3.0 s | 0.385 | 8.67 s ⚠ | ✗ | ✗ |
| > 3.0 s | > 0.385 | **live mode impossible** | ✗ | ✗ |

*(Every finite cell moved by exactly **+0.07 s** — the transpose
group delay, now in the fixed sum. The shift is uniform and was applied to the
published cells directly, not re-derived from a per-preset lookahead, because
the `tight` column's lookahead is not stated anywhere in this document. The
`⚠` and `✗` markers are set by `T_inf` vs `H` and are unaffected.)*

`✗ drains` = `T_inf > H`, the output buffer empties and you get dropouts. `⚠` = utilisation above 70 % (`T_inf > 0.7·H`); it will run, but a single slow frame causes a glitch. Note the safe column is dominated by its fixed 4.0 s lookahead, so it barely improves with a faster GPU — **the fast and tight presets are where GPU speed converts into responsiveness**, which is the argument for measuring `T_inf` early and hard.

**Minimum achievable startup delay.** In the limit of infinitely fast inference, `D → X + R + J + 165 ms`. With `X = R = 0.15 s` and a 0.2 s jitter buffer that floor is **≈ 0.67 s**. On plausible Apple-Silicon-via-WebGPU numbers (`T_inf` 0.8–2.0 s) the realistic best case is **2.72 – 3.67 s** (tight/fast presets, if the hardware sustains them) and the recommended default (safe preset, `T_inf` 2.0 s) lands at **≈ 7.17 s**.

### 7.4 This contradicts the PRD — deliberately

The PRD says "hit play, wait 1–3 s, then continuous" (§6.1, §12). **That is not achievable with HT-Demucs at its native 7.8 s segment.** The options are:

1. **Revise the target to 3–7 s** for live mode, and manage it in the UI (a "priming" progress bar with the beat grid already visible; it reads as loading, not as lag).
2. Use the tight preset on a machine that hits RTF 0.13, for ~2.7 s — at 7.8× GPU load, which forecloses dual-deck.
3. **Change the mode.** See §8.3: pre-render + cache turns the startup delay into *zero* on the second play and makes dual-deck actually feasible. This is the recommendation.

Also worth stating plainly: **the PRD's Mode 3 (two live pipelines) needs `RTF ≤ H/7.8` per deck simultaneously.** At the safe preset that is 2 × 2.6 = 5.2 model-seconds per output-second. A WebGPU context does not magically get 2× throughput from two workers — they queue on the same GPU. Dual-deck live is only viable if a single deck measures RTF ≤ 0.19, i.e. half the safe-preset budget. Plan on cached stems for deck B.

---

## 8. DJ UX — the audio things engineers forget

### 8.1 Response and feel

* **Mute is instant but ramped**: τ = 3 ms, 95 % in 9 ms, exactly zero by 18 ms (§3.3). Never a raw `.value =` assignment.
* **Beat-quantised kills.** A DJ does not want the vocal to drop when they hit the key; they want it to drop *on the 1*. Offer quantise = off / ¼ / ½ / 1 bar, scheduling with `setTargetAtTime(target, beatTime − 3τ, τ)`.
  Here is the nice part: **live mode makes this easy, not hard.** The processed audio is 4 s behind the capture, so by the time the user presses the key we already hold the samples for the next several beats and know exactly where the downbeats are. The lookahead buffer that costs us startup latency buys us perfect beat-locked effects.
* **Every stem must be sample-aligned.** One code path, one resampler instance, one OLA, one `start()` time. A Δ-sample skew between stems combs at `f = fs/(2Δ)`: Δ = 1 → 22 kHz (inaudible), Δ = 4 → 5.5 kHz (audible), Δ = 10 → 2.2 kHz (destroys the mid-range). Assert `Δ === 0` in code, do not eyeball it.
* **Both decks share one `AudioContext` and one live plan.** If deck A runs `safe` and deck B runs `fast`, their outputs are 2 s apart and nothing will beat-match.
* **Metering in the worklet**, not `AnalyserNode` (§4.3).
* **Headphone cue** is what makes this a DJ tool rather than a toy: `new AudioContext({ sinkId })` (Chrome 110+), or a `MediaStreamAudioDestinationNode` feeding a hidden `<audio>` with `setSinkId()`. Route a separate stem mix there. Worth scoping early because it constrains the graph topology.

### 8.2 Audio/video sync — firm recommendation

The problem, stated numerically: in live mode the processed audio trails the video by the full startup delay, **3–8 s** (§7.3). At 120 BPM that is **6 to 17 beats — one and a half to four bars.** There is no adapting to that; a performer watching the video for a cue will be wrong by a whole phrase.

Options, and why most of them lose:

| Option | Verdict |
|---|---|
| **Accept it** | No. Two bars of offset is not "a bit out of sync", it is a different part of the song. |
| **Delay the video by pausing/seeking the `<video>`** | **No.** YouTube's keyframe interval is 2–5 s, so seek granularity is worse than the error you are correcting, and every seek triggers a buffering stall plus a fresh quality/ad negotiation. You would be trading a constant 5 s offset for a jittery 2–5 s offset with dropouts. |
| **Frame-buffer the video into a canvas** | Workable, but a v2 experiment. `requestVideoFrameCallback` + `createImageBitmap` into a ring buffer, rendered `D` seconds late. At 640×360 RGBA that is 0.92 MB/frame; 30 fps × 5 s = 150 frames = **138 MB**, plus a per-frame GPU copy. At 480×270 it is 78 MB. Feasible on the reference Mac, but it is real memory, real GPU bandwidth, and a new class of bug — for a feature that is decoration. |
| **Hide the video** | **Yes. This is the recommendation for v1.** |

**Recommendation: in live mode, collapse the YouTube player to a small dimmed thumbnail and put Stem Splitter Live's own transport in its place** — a scrolling waveform of the *processed* output, the beat grid, six stem meters, and the fader wall. A DJ performing is looking at the deck, not at the music video. This costs zero engineering, has zero failure modes, and is honest about what the pipeline is doing.

Ship the canvas frame-buffer later as an opt-in "Sync video (experimental)" toggle capped at 480×270 / 30 fps, for people who want the visual.

### 8.3 The recommendation that changes the product: pre-render + cache

The AV-sync problem, the startup-latency problem, and the dual-deck GPU problem all have the same solution.

Once a track's stems are on disk, playback is *free*: no GPU, no lookahead, no delay, and the video syncs perfectly because we can drive playback from a shared clock. So:

* **Cache stems per video, keyed by `videoId` + a pipeline version hash**, in IndexedDB.
* The first play of a track populates the cache in real time (you are cueing something else anyway). Subsequent plays are **instant, offline-quality, perfectly synced, and cost 0 % GPU**.
* Sync in cached mode: drive `video.currentTime` from the audio clock. Soft-correct with `video.playbackRate = 1 ± 0.02` when the error exceeds 60 ms; hard-seek only above 500 ms.
* **Dual-deck becomes trivial** when at least one deck is cached — which is the normal case for a prepared set.

Storage, 4-minute track, **6 stems**, stereo, 44.1 kHz. **Both units are pinned,
because "4 GB" is ambiguous and the two answers differ by a whole track:**

| Cache format | per track | tracks in a 4 GiB LRU | tracks in a 4×10⁹ B LRU |
|---|---|---|---|
| **16-bit PCM** (recommended) | **254.0 MB** | **16** | **15** |
| 32-bit float | 508.0 MB | 8 | 7 |
| Opus 128 kbps/stem (`WebCodecs AudioEncoder`) | 23.0 MB | 186 | 173 |

Derivation, so nobody has to re-do it:

```
240 s × 44 100          = 10 584 000 frames
× 4 B/frame × 6 stems   = 254 016 000 B          (16-bit stereo)
+ 6 × 44 B RIFF         = 254 016 264 B ≈ 254.0 MB   per track

4 GiB / 254 016 264     = 16.91  → 16 tracks     (was 25 at four stems)
4e9   / 254 016 264     = 15.75  → 15 tracks     (was 23)
```

*(§8.3 read `16-bit PCM | 169 MB | 24`. That row was **stale on
its own terms even at four stems** — 169.3 MB into 4 GiB is 25, not 24 — which is
why the unit is now stated rather than assumed.)*

**The 32-bit-float row is the argument for 16-bit, and it is the one part of this
table the stem count cannot move: 8 is exactly half of 16.** Doubling the sample
width halves the LRU depth at any stem count.

The Opus row is derived rather than measured: 128 000 b/s × 240 s = 3.84 MB per
stem, × 6 = 23.04 MB.

**RAM, not disk, and both grew with the stem count** (`docs/SIX-STEM-CONTRACT.md`
"Known debt" item 3):

| | was (4 stems) | is (6 stems) |
|---|---|---|
| stem ring, per deck | 21.0 MB | **29.4 MB** |
| export overlap-add, 4-minute track | 338 MB | **508 MB** |

Two decks of live stem ring is now ~59 MB before anything else, and the export
OLA is the number that decides whether a 4-minute export fits alongside a model
in a tab.

Recommend **16-bit PCM** for the cache (playback only — export always re-derives from the model at 32f, so no lossy artifacts ever reach a deliverable), with Opus as a "save space" setting. Note that stems are more revealing of codec artifacts than full mixes, because there is no masking material; do not go below 128 kbps per stem.

One honest constraint worth writing down: **you cannot harvest tab audio faster than real time.** Raising `video.playbackRate` with `preservesPitch = false` does produce a time-compressed stream, but the capture is still at 48 kHz, so at rate `r` everything above `24/r` kHz is lost — at r = 3 you throw away everything over 8 kHz. Time-stretching (`preservesPitch = true`) is worse: it phase-vocodes the audio and destroys exactly the fine structure the separator relies on. Populating the cache takes one real-time pass. Design the UX around that (prime a track while the previous one plays), not around a trick.

---

## 9. Appendix — what upstream Demucs actually does

Fetched from `facebookresearch/demucs@main` while writing this document, not recalled.

**`demucs/apply.py`** — `apply_model` signature and defaults:

```python
def apply_model(model, mix, shifts: int = 1, split: bool = True,
                overlap: float = 0.25, transition_power: float = 1.,
                progress: bool = False, device=None,
                num_workers: int = 0, segment: tp.Optional[float] = None, ...)
```

Chunking (lines 257–301):

```python
segment_length: int = int(model.samplerate * segment)
stride = int((1 - overlap) * segment_length)
offsets = range(0, length, stride)
weight = th.cat([th.arange(1, segment_length // 2 + 1, device=device),
                 th.arange(segment_length - segment_length // 2, 0, -1, device=device)])
weight = (weight / weight.max())**transition_power
...
out[..., offset:offset + segment_length] += (weight[:chunk_length] * chunk_out)
sum_weight[offset:offset + segment_length] += weight[:chunk_length]
...
assert sum_weight.min() > 0
out /= sum_weight
```

Random-shift equivariance (lines 237–256): `max_shift = int(0.5 * model.samplerate)`, offset drawn uniformly in `[0, max_shift]`, output shifted back and averaged over `shifts` runs.

Padding (`TensorChunk.padded`, lines 108–124): the requested window is **centred**, real neighbouring samples are used where they exist (`correct_start`/`correct_end` clamp to the tensor), and only the true track edges are zero-padded.

**`demucs/htdemucs.py`** — `samplerate=44100`, `segment=10` (constructor default; the *pretrained* checkpoint carries `Fraction(39, 5) = 7.8`), `use_train_segment=True`, `nfft=4096`, `self.hop_length = nfft // 4`. `_spec` pads by `pad = hl // 2 * 3`. `valid_length` raises if the input exceeds `training_length`; shorter inputs are zero-padded up to it and cropped back afterwards.

**`demucs/apply.py`** — `BagOfModels.max_allowed_segment` returns `min(float(model.segment))` over the HTDemucs members; `separate.py` fatals with *"Cannot use a Transformer model with a longer segment than it was trained for."*

**`demucs/api.py`** — normalisation, `separate_tensor`:

```python
ref = wav.mean(0)
wav -= ref.mean()
wav /= ref.std() + 1e-8
out = apply_model(...)
out *= ref.std() + 1e-8
out += ref.mean()
```

**`demucs/audio.py`** — `prevent_clip(wav, mode='rescale')` → `wav / max(1.01 * wav.abs().max(), 1)`; `save_audio` defaults to `bits_per_sample=16`, `clip='rescale'`; `separate.py` exposes `--int24` and `--float32`.

**Sources**

- [facebookresearch/demucs — `apply.py`](https://github.com/facebookresearch/demucs/blob/main/demucs/apply.py), [`htdemucs.py`](https://github.com/facebookresearch/demucs/blob/main/demucs/htdemucs.py), [`api.py`](https://github.com/facebookresearch/demucs/blob/main/demucs/api.py), [`audio.py`](https://github.com/facebookresearch/demucs/blob/main/demucs/audio.py), [`separate.py`](https://github.com/facebookresearch/demucs/blob/main/demucs/separate.py)
- [Rouard, Massa, Défossez — *Hybrid Transformers for Music Source Separation* (arXiv 2211.08553)](https://arxiv.org/abs/2211.08553) — per-source SDR and the segment-duration ablation
- [Chromium `blink::SincResampler`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/sinc_resampler.h), [`audio_bus.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/audio_bus.cc), [`audio_destination.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/platform/audio/audio_destination.cc), [`media::SincResampler`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/base/sinc_resampler.h)
- [Paul Adenot — *Web Audio API performance and debugging notes*](https://padenot.github.io/web-audio-perf/) — "Blink-based browsers use linear resampling… Gecko-based browsers use a more expensive but higher quality technique"
- [Le Roux et al. — *SDR: half-baked or well done?*](https://arxiv.org/abs/1811.02508) — SI-SDR
