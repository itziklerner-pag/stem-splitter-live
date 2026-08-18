<div align="center">

<img src="brand/mark.svg" alt="" width="88" height="88">

# Stem Splitter Live

### Split any YouTube video into six stems, live and on your own machine.

Mute the vocals. Solo the drums. Slow it down without changing the key.
Nothing is uploaded, nothing is downloaded, nothing leaves your computer.

[![License: MIT](https://img.shields.io/badge/code-MIT-blue.svg)](LICENSE)
[![Model: CC BY-NC 4.0](https://img.shields.io/badge/model-CC%20BY--NC%204.0-lightgrey.svg)](NOTICE.md)
[![Chrome 128+](https://img.shields.io/badge/Chrome-128%2B-4285F4.svg)](#install)
[![Verify](https://github.com/itziklerner-pag/stem-splitter-live/actions/workflows/verify.yml/badge.svg)](https://github.com/itziklerner-pag/stem-splitter-live/actions/workflows/verify.yml)
[![Discussions](https://img.shields.io/badge/community-Discussions-5865F2.svg)](https://github.com/itziklerner-pag/stem-splitter-live/discussions)

<!--
  DEMO GIF GOES HERE. Drop the recording in at brand/demo.gif, then replace this
  comment with:
      <img src="brand/demo.gif" alt="The deck separating a track live" width="720">
  Left as a comment on purpose — a broken image is worse than no image.
-->

</div>

---

Open a YouTube video, press `Ctrl+Shift+9`, and a mixing deck appears in the
page. Every fader is a separate instrument, pulled out of the audio in real time
by a neural network running on your GPU.

It is for learning a bass line, practising over a drum track, hearing what a
producer actually did, or just turning the singer off.

## Two properties are load-bearing, not features

**It only ever hears what your own player renders.** Audio comes from
`chrome.tabCapture` and nothing else. No stream-URL resolution, no `yt-dlp`, no
parsing of anybody's player response. It cannot save a file — there is no
`downloads` permission, and an automated check asserts its continued absence.
This is the line between an audio tool and a ripper, and it is enforced as a
project rule that no pull request may cross.

**It makes exactly one network request, ever.** The model weights, from a pinned
and hashed host, cached after the first fetch. No telemetry, no analytics, no
error reporting, no fonts, no update pings. A full session completes with every
network interface disabled — that is an acceptance test, not an aspiration.

## Install

There is no build step, so the repository *is* the extension.

```bash
git clone https://github.com/itziklerner-pag/stem-splitter-live
cd stem-splitter-live
bash tools/fetch-vendor.sh     # the ONNX Runtime WebGPU runtime, ~26 MB, not in git
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension/` directory.

On first run a welcome tab offers the 109 MB model download. It is asked for
once, up front, rather than at the moment you first press play.

> Chrome 128 or newer. A GPU with WebGPU is strongly recommended — the WASM
> fallback works, but it blocks for seconds at a time.

## Use

1. Open a YouTube video.
2. **Click the toolbar icon, or press `Ctrl+Shift+9`** (`⌃⇧9` on macOS). The
   gesture has to happen on the tab you want: Chrome only grants audio capture
   on a real toolbar or shortcut invocation. That is also why there is no tab
   picker, and cannot be one.
3. The deck appears between the player and the title. Press play — YouTube's own
   play button. The deck follows it; there is no second transport.

| key | does |
|---|---|
| `1`–`6` | mute a stem — vocals, drums, bass, other, guitar, piano, left to right |
| `Shift`+`1`–`6` | solo a stem |
| `Alt`+`1`–`6` | reset that stem's fader to unity |
| `0` | unmute everything and clear the solo |
| `?` | the full list, including the fader keys |
| `Ctrl+Shift+9` | show / hide the deck |

On macOS the chords are the Apple ones — `⌥` is Alt/Option, `⇧` is Shift, `⌃` is
Control. Nothing about the bindings differs; the deck's `?` overlay draws the
glyphs on a Mac and the words everywhere else.

The stem digits work anywhere on the watch page **while the deck is armed, and
only while it is armed.** With nothing armed they are YouTube's jump-to-10–60 %,
exactly as they are with this extension uninstalled. `7`–`9` and `Space` are
never ours.

**Transpose** is ±6 semitones, and the drums lane is deliberately left
unshifted. **Speed** is key-locked: it changes tempo and nothing else, across
0.5×–2.0× in 29 geometric steps. The two compose — 0.75× with transpose +5 is a
fourth *up* from the original. Detected key and tempo are shown, and key can be
read in a transposing instrument's written pitch.

## How it works

```
YouTube tab (48 kHz)
  → chrome.tabCapture                      ← the only source of audio
  → AudioContext @ 44 100 Hz               ← the model's native rate
  → capture worklet → SharedArrayBuffer ring (23.8 s)
  → causal chunk plan: run the model on the last 7.8 s, emit the last hop
  → ONNX Runtime Web + WebGPU · htdemucs_6s
       in (1,2,343980) → out (1,6,2,343980)
  → weighted overlap-add, 50 ms linear seam crossfade
  → 14-plane stem ring (6 stems × 2 ch + passthrough)
  → optional transpose (drums lane untouched)
  → playback worklet: per-stem gain, mute, solo, master, soft clip, meters
  → your speakers
```

Four Manifest V3 contexts, none interchangeable: a **service worker** (the only
context that can mint a `tabCapture` stream), an **offscreen document** (the
engine — the only context with `getUserMedia`, workers and SharedArrayBuffer), a
**content script** (injects the deck, owns the page's `<video>`), and the
**deck** itself as an extension-origin iframe.
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the full picture.

**Latency is inherent, not a bug.** The model can only separate sound it has
already heard, so the deck runs about **3.4 seconds behind the picture** at the
default hop — further on a slower machine. The readout shows exactly how far,
measured rather than predicted. A version with no delay would be a version that
can see the future.

## Receipts

Claims here are backed by assertions that run in CI. A few worth quoting:

| | |
|---|---|
| Sample-clock round trip, capture → model → output | **1000.00 Hz** — one `AudioContext` at 44 100 Hz, no JS resampling anywhere on the live path |
| Overlap-add reconstruction, identity model | **−160.6 dB** against a −120 dB gate |
| COLA error, Float32 | **3.0e-8** against a 1e-6 gate |
| Six-source synthetic separation null | **−144.5 dB**, against a worst-single-omission control of **−6.3 dB** |
| Pitch shifter, bypass identity | **−294.5 dB** against a −120 dB gate |
| Pitch shifter, alias floor | **−116.9 dB** against a −60 dB gate |
| Pitch shifter, passband 40 Hz – 19 kHz | **±0.02 dB** against ±0.5 dB |
| Key-lock: speed must not move pitch | held to **±2 cents** across all 29 rungs |
| Transpose group delay | exactly **3072 samples (69.66 ms)** on every lane at every setting, so transposing never steps the alignment |
| Verification gates | **19**, 1302 assertions — 17 of them, 1160 assertions, run with no browser and no weights |

Two numbers we deliberately do **not** quote: any millisecond figure from the
pitch bank (three runs of identical code swung 69 %, so that is the machine, not
the code — we quote frame counts instead), and any repo-wide timing absolute.
[`AGENTS.md`](AGENTS.md) explains why at some length, and it is the most useful
file here if you write tests for a living.

## Develop

```bash
node tools/verify.mjs --quick     # 17 gates, no browser, no weights (~1 min)
bash tools/fetch-model.sh         # seeds the weights so the browser gate doesn't refetch 109 MB
node tools/verify.mjs             # ...plus model parity and the real-browser smoke
```

`verify` is the only entry point that matters. It runs each suite, classifies the
output, and **refuses to call a run green if a suite exited 0 while asserting
nothing** — silence is not a pass.

| gate | subject |
|---|---|
| `test.js` | the DSP — causal chunk plan, seam crossfades, plane alignment, backpressure, WAV round trip, FFT, the SAB ring |
| `extension/engine/*.js` | each engine module runs its own suite: `node extension/engine/pitch.js`, and so on |
| `extension/ui/dev/selftest.mjs` | the deck's display laws — fader, meter scale, buffer health, error families |
| `tools/tree-check.mjs` | `extension/` really loads: every manifest path, every transitive import |
| `tools/name-check.mjs` | no former product name survives, and both halves of each renamed IPC pair are present |
| `tools/model-parity.mjs` | the pinned weights really carry six sources, in the contract's order |
| `tools/embed-smoke.mjs` | real Chromium, the real extension, the deck injected into a real page |

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). If you are touching audio,
[`docs/AUDIO.md`](docs/AUDIO.md) is normative, not descriptive.

## Layout

```
extension/         the extension — load this unpacked
  content.js         injects the deck into the watch page, owns the <video>
  autonav.js         suppresses YouTube's autoplay-next while the deck is up
  speed.js           the page-speed transport, clamped, ad-aware
  sw/                service worker: arming, the capture grant, routing
  offscreen/         THE ENGINE — AudioContext, capture ring, worklets
  engine/            pure DSP, each file with its own runnable suite
  workers/           ONNX Runtime inference worker
  shared/            config, ring buffers, model cache, WAV, stem cache
  ui/                the deck (embed.*), the welcome page, display maths
docs/              ARCHITECTURE, AUDIO (the DSP spec), SIX-STEM-CONTRACT
tools/             verify + the gates + the fetch scripts
qa/                edge cases and the passthrough-gain acceptance gate
test.js            the DSP suite
```

## Licence

**The code in this repository is MIT.** Take it, fork it, ship it.

**The model weights are not ours to license.** `htdemucs_6s` is Meta's, released
under **CC BY-NC 4.0** — non-commercial. We do not redistribute it; the extension
downloads it at runtime from a pinned, hashed upstream revision, and this
repository has never contained it.

The practical consequence, stated plainly: **Stem Splitter Live is free and will
stay free.** There is no paid tier and no plan for one, because a commercial
product built on NC weights would be a licence violation. If you fork this and
want to sell something, our MIT grant covers our code and grants you nothing
about the weights — you would need a separator you are allowed to use
commercially.

[`NOTICE.md`](NOTICE.md) carries the full attribution, including the ONNX
Runtime build and the known single point of failure on the model host.

## More

[**FAQ**](FAQ.md) — including "is this piracy?" and "why is it three seconds
behind?", answered directly ·
[Privacy](PRIVACY.md) · [Security](SECURITY.md) ·
[Code of Conduct](CODE_OF_CONDUCT.md) ·
[Discussions](https://github.com/itziklerner-pag/stem-splitter-live/discussions)

<sub>Not affiliated with, endorsed by, or sponsored by Google or Meta. YouTube
and Chrome are trademarks of Google LLC.</sub>
