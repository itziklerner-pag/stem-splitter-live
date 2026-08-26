# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because [`PRIVACY.md`](PRIVACY.md) promises that any change to data handling is
disclosed, **any such change gets its own entry here**, at the top of the
release, whether or not it is otherwise notable.

## [Unreleased]

### Security and privacy

- **The extension can now hand you one file, and the claim that it could not has
  been narrowed rather than deleted.** It was *"the extension cannot save a
  file"*, in four documents; it is now *"it cannot produce a user-accessible file
  that **reproduces** the captured audio"*. The one file it makes is a MIDI
  transcription — note numbers, onsets, lengths and velocities, and no samples of
  anything. **Nothing about data collection changes**: still nothing collected,
  still exactly one network request in the extension's lifetime, still nothing
  transmitted, and the pack is built and handed over entirely on your machine.
  [ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md)
  supersedes ADR 0001 decision 2 and records what the narrowing costs, including
  the rights question it raises, which is **recorded as open**.
- **No new permission.** There is still no `downloads` permission and the gate
  asserting its absence is unchanged. What changed is that we stopped citing it
  as the thing that enforced the claim: an extension page can create a `Blob`
  and click an anchor without any permission, and always could. The claim is now
  held by an allowlist of exactly `application/zip` and `audio/midi` in
  `extension/shared/midi.js`, gated by `qa/midi-pack.mjs`, whose control is a
  real WAV inside a real pack that must be **refused**.
- **An obligation this release has not discharged yet:**
  [`PRIVACY.md`](PRIVACY.md)'s change clause promises users are notified in the
  extension itself before a change takes effect. That notice is product work and
  **must land before release**. It is written down in `PRIVACY.md` itself rather
  than in a tracker.

### Added

- **Transcribe to MIDI.** While the video plays, the deck writes a note
  transcription of all six stems and hands you a zip of seven `.mid` files — one
  per stem, plus a combined multi-track file. It rides the player: only what
  actually plays through is written, the deck shows how much of the song it has,
  and a stretch you skipped past is a hole rather than silence pretending to be
  music. Pitched stems use Spotify's Basic Pitch; drums are hand-written onset
  detection into four General MIDI classes, because no permissively licensed
  drum transcriber exists to use instead.
- **The Basic Pitch weights are committed to this repository** — 225 KiB,
  Apache-2.0 over the code *and* the weights, with the upstream `NOTICE` beside
  them as Apache §4(d) requires. Unlike the separator's 109 MB, there is no host
  that can disappear. [`NOTICE.md`](NOTICE.md) carries the row and the one test
  that decided it: has the publisher granted rights over the **weights**?
- **Host interface v1.1** — one appended duty, `DeckHost.deliver(name, bytes,
  mime)`. A MINOR change: every existing Host fails `assertHost` at boot until it
  implements it, which is what that check is for. Bytes cross the seam, never a
  URL.
- **Four new gates**, all in `node tools/verify.mjs --quick`:
  `extension/engine/resample2.js`, `extension/engine/notes.js`,
  `extension/engine/drumtap.js` and `qa/midi-pack.mjs`. Each carries a control
  that must lose — an unfiltered decimator, a one-class drum detector, and a WAV
  the delivery guard has to refuse.

### Changed

- `tools/tree-check.mjs`'s downloads assertion is unchanged; its **message** is
  narrowed from *"nothing in this build writes a file"* to *"this build cannot
  use `chrome.downloads`"*, which is what it actually checks.
- [`FAQ.md`](FAQ.md) keeps its old "No" to export **visible and dated** beside
  the new answer. A silently vanished answer is worse than a documented change
  of mind.

## [0.2.0] — 2026-08-26

The Host seam. Nothing about what the extension does changes; what changes is
that the engine and the deck no longer know they are inside a Chrome extension,
so a second product can host them without forking them
([ADR 0001](docs/adr/0001-desktop-app-is-a-separate-product.md)). Three
user-visible fixes rode along.

### Security and privacy

- **A seek no longer starts the model download the user declined.** Scrubbing
  the video restarted live capture through a path that did not ask whether the
  weights were on disk, so a user who had said no to the 172 MiB download could
  have it start anyway by dragging the scrubber. The guard that the rest of the
  build goes through is now on that path too. No other change to data handling:
  still no telemetry, still exactly one network request in the extension's
  lifetime, still nothing transmitted.

### Fixed

- The arm chord is announced as **words** on every platform that draws it in
  words. It was being labelled as a graphic on non-Mac machines, which replaced
  text a screen reader could already read with an accessible name saying the
  same thing — so the chord was announced twice or awkwardly, depending on the
  reader. The announced form now follows the drawn form.
- The brand mark and wordmark parse as XML, so they render through `<img src>`
  and not only when inlined.

### Changed

- The deck's "not armed" line now names the keyboard chord as well as the
  toolbar icon — "…to arm it, or press Ctrl+Shift+9". The chord is read from the
  browser rather than typed into the page, so a rebind at
  `chrome://extensions/shortcuts` is what the deck shows, and it is announced in
  words where the platform draws it in glyphs. The shortcut itself is unchanged
  and has worked since 0.1.0; until now only the one-time setup page said so.
  Both routes the line offers are the same show/hide gesture: pressing the chord
  (or clicking the icon) while the deck is on screen arms the tab AND puts the
  deck away, and a second press brings it back.

### Added — for anyone building on this

None of this is visible in the browser. It is here because the tag is what a
second product pins.

- **Host interface v1, frozen.** `extension/shared/host.js` declares what the
  engine and the deck ask of whatever hosts them — five interfaces, their duty
  tables, and a boot-time `assertHost()` that refuses a Host short a duty and
  names the duty. The file opens with what v1 freezes, the four Chrome-shaped
  assumptions taken off the wire at the freeze, and the two limitations named
  rather than closed.
- **`extension/unit.json`** — which file is on which side of the seam, with the
  argument for each — and **`extension/unit.sha256`**, one SHA-256 per unit file
  in `shasum -c` format, written by `node tools/unit-hash.mjs`.
- **[`docs/VENDORING.md`](docs/VENDORING.md)** — how a second product copies the
  unit out of a tag and verifies it, dry-run from an empty directory before it
  was published.
- **Three new gates**, all in `node tools/verify.mjs --quick`:
  `tools/unit-check.mjs` (the unit still comes out, reaches for no `chrome.`,
  and the sums file still describes the tree), `tools/seam-check.mjs` (one
  inference call in flight per backend; `dispose()` settles what it takes away),
  and `node tools/verify.mjs --unit`, the plan `unit.json` declares — 12 steps,
  no browser, no weights, no `node_modules`.
- Verification is 23 gates and 1452 assertions in `--quick`, up from 19 gates
  and 1302 at 0.1.0.

## [0.1.0] — 2026-08-17

First public release.

### Added

- Six-stem live separation of the audio your own YouTube tab is playing —
  vocals, drums, bass, other, guitar, piano — using HT-Demucs v4 (`htdemucs_6s`)
  through ONNX Runtime Web on WebGPU, with automatic threaded-WASM fallback.
- A mixing deck drawn into the watch page between the player and the title:
  per-stem fader, mute, solo, master, meters, and a detected key and tempo
  readout.
- Keyboard control: `1`–`6` mute, `Shift`+`1`–`6` solo, `Alt`+`1`–`6` reset a
  fader to unity, `0` clears everything, `?` for the full list, `Ctrl+Shift+9`
  to arm and to show or hide the deck.
- Transpose, ±6 semitones, with the drums lane deliberately left unshifted and a
  constant 3072-sample group delay on every lane so transposing never steps the
  alignment.
- Key-locked speed across 0.5×–2.0× in 29 geometric steps. Speed changes tempo
  and nothing else; transpose is the only control that moves the key, and the
  two compose. Held to ±2 cents.
- A measured latency readout, because the delay is inherent and the honest thing
  is to show it rather than describe it.
- 19 verification gates, 1302 assertions. `node tools/verify.mjs --quick` runs 17
  of them with no browser and no model weights.

### Security and privacy

- **No data collection of any kind.** No telemetry, no analytics, no error
  reporting, no accounts, no cookies.
- **Exactly one network request in the extension's lifetime** — the model
  weights, from a pinned and SHA-256-verified upstream revision, cached
  thereafter. A full session completes with every network interface disabled.
- Audio is separated on-device and never transmitted.
- No `downloads` permission, and an automated gate asserts its continued
  absence.

[Unreleased]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/itziklerner-pag/stem-splitter-live/releases/tag/v0.1.0
