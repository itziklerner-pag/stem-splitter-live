# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because [`PRIVACY.md`](PRIVACY.md) promises that any change to data handling is
disclosed, **any such change gets its own entry here**, at the top of the
release, whether or not it is otherwise notable.

## [Unreleased]

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

[Unreleased]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/itziklerner-pag/stem-splitter-live/releases/tag/v0.1.0
