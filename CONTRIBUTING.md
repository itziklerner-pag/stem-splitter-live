# Contributing to Stem Splitter Live

Thanks for looking. This file is the short version of how the project is built and
what will get a pull request merged or rejected. If you are here to change audio
code, read [`docs/AUDIO.md`](docs/AUDIO.md) as well — it is normative, not
descriptive.

## Getting set up

There is **no build step**. `extension/` *is* the extension.

```bash
git clone https://github.com/itziklerner-pag/stem-splitter-live
cd stem-splitter-live
bash tools/fetch-vendor.sh          # ONNX Runtime Web, ~26 MB, not in git
node tools/verify.mjs --quick       # a green baseline before you touch anything
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → pick
`extension/`. Chrome 128 or newer.

To run the two gates that `--quick` skips:

```bash
bash tools/fetch-model.sh           # seeds the 109 MB weights from the pin
node tools/verify.mjs               # + model parity + the real-browser smoke
```

`node tools/verify.mjs` is the only test entry point that matters. It runs each
suite, classifies the output, and **refuses to call a run green if a suite exited 0
while asserting nothing** — silence is not a pass.

## The three rules that override everything

A pull request that crosses one of these is rejected regardless of how well it
works. They are not style preferences; each one is load-bearing for something the
project cannot get back if it is lost.

### L1 — Capture only what the user's own player renders

Audio comes from `chrome.tabCapture` and nothing else. Never resolve, fetch, or
parse a media stream URL. No yt-dlp, no innertube, no `/videoplayback`, no
player-response scraping.

**This is the line between an audio tool and a ripper**, and it is load-bearing for
the project's legal posture. A content script on a video page is exactly where a
ripper would live, so the boundary is stated in terms of what the code actually
does: `content.js` reads three numbers off the page's `<video>` element — `paused`,
`currentTime`, `duration`. That is transport state, not media. It never reads
`src`, `currentSrc`, `buffered`, `srcObject` or any URL; never calls
`captureStream()`; never touches a byte of audio or video; and never executes in
the page's JavaScript world.

L1 is also why there is **no audio export and no `downloads` permission** —
`tools/tree-check.mjs` asserts the permission's absence. The one file this build
hands over is a MIDI transcription, which carries no samples and cannot be
played back as the recording; what holds that line is `qa/midi-pack.mjs` and the
allowlist in `extension/shared/midi.js`, not the missing permission. See
[ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md).

### P1 — No network after the model download

No telemetry, no analytics, no error reporting, no font or CDN fetches. The
extension must complete a full session with every network interface disabled.
**This is an acceptance test, not an aspiration.**

Exactly one network request is made, ever: the model weights, from a pinned and
hashed host, cached thereafter.

### M1 — No remote code

MV3 forbids it. ONNX Runtime wasm binaries and model weights are bundled or fetched
as *data* and cached. Never inject a script tag pointing at a CDN.

## Engineering bias

Fewest files, least tooling that works. No bundler unless ORT Web forces one. No
abstraction with one implementation. No config for a value that never changes.

Mark deliberate shortcuts with a `ponytail:` comment naming the ceiling and the
upgrade path — for example `// ponytail: global lock, per-account locks if
throughput matters`. Simple should read as intent, not as ignorance.

## Every non-trivial change leaves one runnable check behind

Audio DSP especially: overlap-add windows get a COLA assertion, the WAV writer gets
a round-trip test, the stem sum gets a null test. No frameworks, no fixtures, no
per-function suites. The smallest thing that fails if the logic breaks.

**Before you write the assertion, read [`AGENTS.md`](AGENTS.md).** It is mostly a
record of assertions that could not fail and cost real time to find that out —
vacuous guards, estimators that saturate below the claim, controls that could not
lose. It is the most useful file in the repo and it will save you a day.

## Settled decisions

These were each built, argued, or measured, and they are closed. Re-proposing one
is fine, but start from the reason it was settled rather than from scratch —
`docs/ARCHITECTURE.md`'s appendix names what was cut and why.

- **One deck, live, drawn into the page.** An offline **audio**-export mode and a
  two-deck console were both built and both cut.
- **The one file this product hands over is a MIDI pack, and that is permanent.**
  A `.mid` carries note, onset, duration and velocity — no samples, no timbre,
  no performance — so it cannot be played back as the recording, which is why it
  ships where audio export does not. It is not held by the absent `downloads`
  permission (an extension page can mint a `Blob` and click an anchor without
  one, and always could): it is held by an allowlist of exactly
  `{application/zip, audio/midi}` in `extension/shared/midi.js` and by
  `qa/midi-pack.mjs`, which builds a real pack, asserts every zip entry begins
  `MThd`, and refuses the same pack with a real WAV inside. Widening that
  allowlist turns the gate red. The rights question a transcription raises is
  **open** and is recorded as open —
  [ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md),
  which supersedes ADR 0001 decision 2.
- **One `AudioContext` at 44 100 Hz — the model's native rate — and no JS
  resampling anywhere on the live path.** Chrome converts the 48 k tab stream on
  the way in and the 44.1 k bus on the way to the device, both inside its own media
  pipeline. `docs/AUDIO.md` §1 carries the measurement (1000.00 Hz round-trip) and
  §1.3 records why the obvious `OfflineAudioContext` route is the bad one in Blink.
  - The absolute prohibition is on **sample-rate conversion between the capture
    clock and the model clock**. A user-requested pitch transform *downstream of
    the mixer* is permitted, subject to three tested conditions: after the model
    never before; `framesIn === framesOut` at 44 100; and its interpolation clears
    the same `docs/AUDIO.md` §6.6 gates used to reject Blink's linear interpolator.
  - A **read-only tap downstream of the separator** may resample onto its own
    model's clock, subject to three conditions that are the same discipline as
    the carve-out above: it is downstream of the separator, never between the
    capture clock and the model clock; no sample it produces is ever returned
    to the audio graph — not the mixer, not the master bus, not the worklet;
    and its output is an opinion, not audio. `extension/engine/resample2.js`
    is the one instance: a fixed 2:1 half-band decimation, 44 100 → 22 050 mono,
    feeding Basic Pitch on the clock that model is built on, so the MIDI lanes
    exist. It is the same class of thing as `engine/keytap.js` and
    `engine/bpmtap.js` reading planes off the stem ring and forming an opinion
    about key and tempo. **A general rational resampler is not covered by this**
    and must not be written: a fixed ratio cannot be pointed at the capture path
    by the next person, and a general one can, which is the shape the
    prohibition is actually about.
  - `extension/engine/pitch.js` interpolates **filter coefficients** between
    sub-phase branches, not the signal. Do not read this as "linear interpolation
    is fine now" — signal interpolation measured −8.6 dB and is banned.
- **Speed is key-locked. It changes tempo and nothing else.** TRANSPOSE is the only
  control that moves the key, at any speed, and the two compose. A user who slows a
  video down to learn a line expects the key to stay put, because every player they
  have ever used does that. The cost is real and stated: the separator sees
  phase-vocoded audio at every non-unity rate, so stems get rougher the further you
  push. `qa/speed-pitch.mjs` holds it at ±2 cents.
- **WebGPU is the target.** Take ORT Web's automatic WASM fallback if it is free;
  do not spend a day optimising it.
- **The separator's weights come from a pinned, hashed upstream host.** Do not
  self-host `htdemucs_6s`, and do not commit it. That is not a size rule and it
  is not a preference: the weights are **CC BY-NC 4.0**, nobody can relicense
  them and nobody may redistribute them, so fetching is the only lawful way to
  put them on a user's disk. **The pin is split across the Host seam** (S7): the
  URL and the cache bucket live in `extension/offscreen/host-pin.js`, because
  fetching the bytes is a Host's job, and the SHA-256 and byte count live in
  `extension/shared/config.js`, because deciding whether the bytes are the model
  is the unit's — it decides it on every load, over whatever the Host hands over
  (`extension/shared/modelcache.js`). Each half is a single source of truth every
  script derives from; never re-type either into a second file. It reads as one
  pin in two places because it is: `fetch` and the Cache API are not `chrome.*`,
  so a URL in the unit is a network path no gate on the unit can see, and moving
  it is what makes P1 and M1 hold under a second Host rather than under this one.
  - **The Basic Pitch weights are the one exception, and they are committed** —
    `extension/models/nmp.onnx`, 230,444 bytes. Three things distinguish them
    from the rule above, and a second committed model would have to clear all
    three. **Apache-2.0 covers the code *and* the weights**, so redistribution
    is granted rather than assumed — an explicit grant over the WEIGHTS is the
    only test that decides which model this project may ship, and `NOTICE.md`
    applies it to every candidate the same way. 225 KiB is not a large binary.
    And committing removes the single point of failure the Demucs pin openly
    confesses to in `NOTICE.md` — a third-party re-export that can be deleted
    out from under new installs. The hash half of the pin still lives in
    `extension/shared/config.js`, and the file is declared `external` in
    `extension/unit.json` so a vendoring copy carries the bytes and still
    checks them. See
    [ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md).
- **No tab picker, ever.** `tabCapture` grants are per-tab, and only a
  browser-level invocation *on that tab* mints one — a toolbar click or
  `Ctrl+Shift+9`. A list rendered inside our own page is not one, so a picker could
  not grant capture however it is built. This is the platform, not a UX preference.
- **The clip indicator must mean "you pushed it", not "you used the feature."** A
  gesture the product exists for must not light a warning on first use — that
  teaches the user to ignore the warning.
- **Channel meters are post-stem-fader, pre-soft-clip.** Mute and solo zero a
  meter; nothing downstream of the stem fader does.

## Commits

The convention exists because `git log` has to stay a usable record.

```
<type>(<scope>): <what changed, imperative, no trailing period>

<why — the failure it prevents or the decision it implements>
<evidence — the numbers, if the change claims any>
```

`type` ∈ `feat` `fix` `perf` `test` `docs` `qa` `chore` `revert`.
`scope` is the owning area, not the file list: `live` `engine` `ui` `sw` `harness`.

Rules, in the order they get broken:

1. **The subject describes what is in the diff.** If the fix is in
   `offscreen/offscreen.js`, the scope is not `ui`. If a message names three fixes,
   `git show` must contain three fixes.
2. **`git add -A` is banned.** Stage paths.
3. **Numbers go in the body, not the subject**, and only if the run happened. A
   performance figure needs the window it was measured over.
4. **Never write "all green" without having run `node tools/verify.mjs`.**
5. **Artifacts do not get committed.** No logs, no screenshots, no `.venv`.
6. **Revert is a commit, not a rebase.** History here is pushed.

A good one:

```
fix(live): passthrough gain = min(resolved stem gains)

A dropped chunk fell back to the unseparated mix at unity, so a killed
vocal came back for one hop — ~51 s of it in the first 155 s at the
default hop. Slot 4 was never written by any message.
qa/passthrough-gain.mjs 13/13, verified in the browser at hop 1.0.
```

## Sign your commits off (DCO)

Add a `Signed-off-by` line to certify you wrote the patch or have the right to
submit it under the MIT licence — see [developercertificate.org](https://developercertificate.org/).
`git commit -s` adds it for you. No CLA, no paperwork, no bot.

## Pull requests

- One logical change per PR. If it cannot be described in one subject line, it is
  two PRs.
- `node tools/verify.mjs --quick` green before you open it. CI runs it again.
- If the change claims a number, put the number and the window in the PR body.
- New code that touches the audio path needs the manual check too: load unpacked,
  play something, confirm you hear it.

## Reporting bugs

Open an issue with the template. The two things that make an audio bug reproducible
are the **deck's latency readout** and your **Chrome version + GPU** — please
include both. For anything security-shaped, see [`SECURITY.md`](SECURITY.md)
instead; a regression in P1 or M1 counts.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
