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

L1 is also why there is no offline export and no `downloads` permission —
`tools/tree-check.mjs` asserts the permission's absence.

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

- **One deck, live, drawn into the page.** An offline-export mode and a two-deck
  console were both built and both cut.
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
  - `extension/engine/pitch.js` interpolates **filter coefficients** between
    sub-phase branches, not the signal. Do not read this as "linear interpolation
    is fine now" — signal interpolation measured −8.6 dB and is banned.
  - **A File source is decoded at the model's clock, and that is RATIFIED rather
    than tolerated.** `decodeAudioData()` on the 44 100 Hz context converts a file
    that is not already at 44 100 inside Blink
    (`AudioBus::TryCreateBySampleRateConverting` → `SincResampler`, 32 taps,
    Blackman) — the call `docs/AUDIO.md` §1.3 evaluates and rates *Good*. It
    breaches no letter of the rule above: there is no capture clock in that path
    (a file is not a tab) and no JS resampler anywhere in it. It is written down
    because it is a **new** clock conversion the rule predates, and a decoder call
    in a codebase whose rules say "no resampling" is otherwise exactly the thing a
    future reader reverts. `extension/engine/offline.js` is the only path that
    does it, and ADR 0001 amendment A5 carries the same sentence.
- **Speed is key-locked. It changes tempo and nothing else.** TRANSPOSE is the only
  control that moves the key, at any speed, and the two compose. A user who slows a
  video down to learn a line expects the key to stay put, because every player they
  have ever used does that. The cost is real and stated: the separator sees
  phase-vocoded audio at every non-unity rate, so stems get rougher the further you
  push. `qa/speed-pitch.mjs` holds it at ±2 cents.
- **WebGPU is the target.** Take ORT Web's automatic WASM fallback if it is free;
  do not spend a day optimising it.
- **Model weights come from a pinned, hashed upstream host.** Do not self-host, and
  do not commit the weights. **The pin is split across the Host seam** (S7): the
  URL and the cache bucket live in `extension/offscreen/host-pin.js`, because
  fetching the bytes is a Host's job, and the SHA-256 and byte count live in
  `extension/shared/config.js`, because deciding whether the bytes are the model
  is the unit's — it decides it on every load, over whatever the Host hands over
  (`extension/shared/modelcache.js`). Each half is a single source of truth every
  script derives from; never re-type either into a second file. It reads as one
  pin in two places because it is: `fetch` and the Cache API are not `chrome.*`,
  so a URL in the unit is a network path no gate on the unit can see, and moving
  it is what makes P1 and M1 hold under a second Host rather than under this one.
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

## Cutting a tag

The tag is what a second product pins, so everything it points at has to be true
of the commit it points at — not of an ancestor, and not of the branch the work
was written on. Three things are easy to miss and none of them goes red:

- **`CHANGELOG.md`'s link-reference block at the bottom.** Converting
  `## [Unreleased]` into `## [x.y.z]` is the obvious half. The block underneath —
  `[Unreleased]: …/compare/vPREV...HEAD` — also has to move to the new tag, and a
  `[x.y.z]: …/compare/vPREV...vx.y.z` line has to be added. Nothing checks this,
  and a missed link is wrong until the next person notices.
- **`docs/VENDORING.md` §7's count table.** It is the intermediate green a
  vendoring host checks its fresh copy against, so a stale number there tells a
  correct copy it is broken. Re-measure it; do not adjust it arithmetically. This
  was shipped stale once, at v0.3.0.
- **Any number in a doc that says it was measured.** Re-derive it by running the
  thing, not by editing the digits. A figure that claims to have been re-measured
  and was not is worse than one that is merely old — v0.3.0 shipped one of those
  too, and the mutation counts around it had drifted by a different amount than
  the total had.

Run the full gate on the **release commit itself**, after the CHANGELOG and
version edits, not only on the code tree before them. `package.json` and
`extension/manifest.json` both carry the version and `tools/tree-check.mjs`
asserts they agree.

## Reporting bugs

Open an issue with the template. The two things that make an audio bug reproducible
are the **deck's latency readout** and your **Chrome version + GPU** — please
include both. For anything security-shaped, see [`SECURITY.md`](SECURITY.md)
instead; a regression in P1 or M1 counts.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
