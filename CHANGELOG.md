# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because [`PRIVACY.md`](PRIVACY.md) promises that any change to data handling is
disclosed, **any such change gets its own entry here**, at the top of the
release, whether or not it is otherwise notable.

## [Unreleased]

Nothing about what the extension does changes. This is for the second
product: a deck can be rendered offline, as one file, with its own settings
baked in. This extension's own Host still refuses every destination.

### Added

- **Bounce — a deck rendered offline, as one file, with its own settings baked
  in.** `engine/bounce.js` (the plan arithmetic and the closed `BOUNCE_CODES`
  vocabulary) and `offscreen/bounce.js` (the render path) drive the SHIPPED
  `stem-playback` worklet on an `OfflineAudioContext`, so the file carries the
  same faders, mute/solo, crossfader and transpose the listener heard — from the
  same code, not from a second copy of the mixer. The engine answers
  `BOUNCE_START` / `BOUNCE_CANCEL` and reports `BOUNCE_PROGRESS` /
  `BOUNCE_DONE` / `BOUNCE_ERROR`; the file goes wherever the Host's `exportSink`
  puts it. This extension's own Host still refuses every destination, so nothing
  about what the extension does changes.
- **A bounce bakes THREE things, and "speed" is withdrawn with its reason.**
  Faders, mute/solo (with the crossfader) and transpose. A File source is the
  only kind a bounce can render, and there is no rate to bake on that path — the
  engine refuses `SPEED` for a cached deck in terms, and a Live source's speed is
  already inside the captured stems. A bounce at a *different* speed is new
  time-stretch DSP, not baking, and it collides with the standing key ruling.
  `docs/AUDIO.md` §4.6 carries the ruling; §1.3 now says in place that its
  `OfflineAudioContext` warning is about `AudioBufferSourceNode` and does not
  reach a bounce, which renders 44 100 → 44 100 and constructs no resampler.
- **`exportSink` says out loud that N may be one.** The duty's prose read as a
  six-file promise because the six-stem export is its example; a bounce passes
  one base name and reads one writable back out of a one-key map. The duty
  itself is unchanged — this is the sentence that stops a Host special-casing
  six.
- **`qa/bounce.mjs` — the first offline-render harness in this repository.**
  Before it, neither `OfflineAudioContext` nor `startRendering` appeared anywhere
  under `tools/` or `qa/`, and the playback worklet's ring read, gain stage, sum
  and starvation fade were exercised only by a real browser. It boots the shipped
  worklet in a `vm` realm and pumps it at the 128-frame render quantum, with a
  fourteen-second fixture — longer than the 11.89 s stem ring on purpose, because
  a bounce gate shorter than the ring cannot see the failure the whole feature
  exists to prevent. `qa/bounce-mutations.mjs` is its mutation battery, in the
  repository beside it, stamped against the commit its anchors were cut from.
## [0.3.1] — 2026-08-27

A documentation release. No code in the unit changed; no assertion count moved.
v0.3.0 shipped **seven stale measured claims across four files**, and this
release re-derives every one of them by running the thing rather than by
adjusting the digits.

This is worth stating plainly rather than correcting quietly, because it is this
project's own subject found in its own release artefacts: **an instrument that
reports what it did not measure.** Every figure below was green, internally
consistent, and wrong.

### Fixed

- **`docs/VENDORING.md` §7 promised 1183 assertions where the tree measures
  1327**, with `unit` at 622 against an actual 766. §7 is the intermediate green
  a vendoring host checks its fresh copy against, and it closes with *"If a step
  is red here, before you have changed anything, the copy is wrong"* — so the
  stale table told a **correct** copy that it was broken, in the document the tag
  body sends a second product to as the procedure. It was **not** stale at
  v0.2.0, which read 1156 with `unit` 612 and matched that tag's own body
  exactly; this was introduced by v0.3.0.
- **`extension/unit.json` carried five stale figures and it ships.** It is
  hashed, and a vendoring product reads it. The `group('host')` line range, the
  `ok()`-site counts, the entry-point count, the line the Chrome platform is
  installed at, and the `send()` measurement were all stale — the old install
  line now pointed *before* the group it describes. `tools/unit-check.mjs` holds
  this file to the code structurally and asserts none of its prose numbers,
  which is how every one of them rotted with the gate green.
- **Two paragraphs asserted their own freshness while stale.** Both
  `VENDORING.md` and `unit.json` introduced the `send()` measurement with
  *"re-measured at v0.3.0"* while carrying the pre-v0.3.0 number. A stale figure
  is a decayed instrument; one that claims to have been re-measured is the same
  thing wearing a certificate, because it tells the reader the check has already
  been done. Every measured figure now names the tree it was taken on.
- **The mutation battery's own header was stale** — `tools/mutations/u8-seam-fixes.mjs`
  said a hole that throws at import takes "ninety-one later assertions" out of
  the run. It takes eighty-four. The instrument built to catch decayed claims had
  one in its own prose.
- **A correction in `630e9bd` used the wrong metric and is itself corrected
  here.** "125 of the file's assertions" was never an assertion count — the same
  sentence in `unit.json` says "125 of the file's 592 `ok()` sites". Sites and
  assertions differ (128 sites run 132 assertions), so both are now given with
  the metric named. The entry-point count reads 30, 37 or 48 depending on where
  an `ok()` statement is judged to end, and none of those reproduces the
  original 28 — so the metric is written down beside the number.

### Changed

- **`package.json` and `extension/manifest.json` now have an assertion between
  them.** Both carry the version, a release bumps both by hand, and no gate
  compared them: v0.1.0 and v0.2.0 matched because someone remembered.
  `tools/tree-check.mjs` compares **the two files to each other** and never
  either to a literal — a literal would be a third place the version lives, and
  the next release would have three to remember instead of two.
- **`CONTRIBUTING.md` gains a "Cutting a tag" section** for the three things
  that are easy to miss and none of which goes red: this file's link-reference
  block at the bottom, `VENDORING.md` §7's table, and any documented number that
  claims to have been measured.

### A note on why the numbers could not simply be rescaled

The totals moved by 144, so the truncation claim looked rescalable:
`622 → 529 / 91 not run` is internally consistent, so `766 → 673 / 91` looks
right. It is wrong on two of three figures — the real answer is
**`766 → 680 / 84 not run`**, because the mutation reaches a different set of
assertions on the new tree and nothing in the old arithmetic predicts it.

**A stale figure that is internally consistent is more dangerous than one
obviously broken: the consistency is what persuades you to rescale instead of
re-run.**

## [0.3.0] — 2026-08-27

Nothing about what the extension does changes. This release is for the second
product: the Host interface gains the two duties a desktop host needs, the cache
gains a lossless tier and an identity for sources that are files, and the WAV
writer learns to stream so a half-gigabyte export is never resident. The engine
and the deck are unchanged in what they do and stricter in what they check.

One fix here would have destroyed data in any host that ran two cache tiers, and
it went unnoticed because the code that did it reported success.

### Security and privacy

- **The engine no longer says "downloaded" about weights it did not download.**
  The `weights … + hash verified` line was worded off a boolean that meant "not
  served from a cache", so a host that ships the model beside its binary — which
  reports that boolean honestly as `false` — had the engine tell the user 109 MB
  had been fetched over the network about a file that had been on disk since
  install. The provenance now travels across the seam with three values, not
  two: a host cache, the network, or shipped-with-the-host. Nothing about what
  this extension does changes — it still has exactly one network request in its
  lifetime and still reports it as a download when it is one — but the one line
  a user would read to check that claim can no longer contradict it
  (upstream [#28](https://github.com/itziklerner-pag/stem-splitter-live/issues/28)).

### Fixed

- **One `StemCache` owned every `StemCache`'s directory, and `clear()` deleted
  across tiers reporting success.** `dir()` read the module constant `CACHE_DIR`
  and ignored `this`, so a second cache constructed for a second tier operated
  on the *first* tier's directory: `list()` returned the other tier's entries,
  `evict()` deleted against the wrong cap, and `put()` wrote its stems where
  another cache would find them. `clear()` was worse and separately hard-coded —
  it removes the directory whole, and its `.catch(() => {})` swallowed the
  evidence, so clearing a 32-bit-float tier would have deleted the live 16-bit
  cache and returned as though it had worked: a cache the caller never named,
  gone, with nothing red anywhere. Each instance now owns the directory it was
  constructed with
  ([#33](https://github.com/itziklerner-pag/stem-splitter-live/issues/33)).
- **`ARM_ERROR.code` is checked, and says so when it is wrong.** It was always a
  closed vocabulary the unit owns (`ARM_CODES`, eight members, five of them tab
  nouns) and nothing anywhere checked it: a host that invented a plausible code
  got a banner the user could not dismiss with a Restart control that could not
  fix it, and nothing went red. `checkArmCode()` now writes one `console.error`
  naming the offending value and the whole legal set, on both ways into the
  banner. It does not throw and does not change what is painted
  ([#29](https://github.com/itziklerner-pag/stem-splitter-live/issues/29)).
- **A hole that throws while being imported is a named red, not a crash.**
  `test.js`'s `group('host')` — the conformance report `docs/VENDORING.md` sends
  a second host to — used to die at the import line, replacing ~120 assertions
  and the summary with a stack trace, which `verify.mjs` then reported as *RED —
  0 failing assertions*. Each hole is now imported defensively and the group
  runs to its end or names what stopped it. `docs/VENDORING.md` carries the rule
  the fix is a safety net for: **a hole must import inertly**, touching its
  platform on the first duty call
  ([#30](https://github.com/itziklerner-pag/stem-splitter-live/issues/30)).

### Changed

- **Host interface v1.1: `ENGINE_HOST_DUTIES` goes 9 → 11.** The addition is
  additive and therefore MINOR by the freeze's own terms — no v1 name is removed
  or renamed — but it is not invisible to a host: **a Host vendored against
  v0.2.0 is refused at boot by `assertHost` until it supplies the two new
  duties.** That refusal is the upgrade notice, and it is deliberate; a Host that
  silently lacked them would answer a duty call with `undefined` and the unit
  would carry that forward as a real answer
  ([#38](https://github.com/itziklerner-pag/stem-splitter-live/issues/38)).

### Added — for anyone building on this

None of this is visible in the browser. It is here because the tag is what a
second product pins.

- **`sourceBytes` and `exportSink`.** A Source that is a FILE and a deliverable
  that is a FOLDER are not expressible on v1: `captureStream` answers a token
  with a live stream, and nothing on the seam said where finished bytes go. Both
  duties are declared in `shared/host.js` rather than in a downstream repo,
  because that file is a unit file — an edit over there is detectable by
  `shasum -c` and is a fork by definition (ADR 0001 decision 3). The extension's
  own implementations are honest refusals with named errors: its Sources are
  tabs and it holds no `downloads` permission.
- **A streaming WAV writer, so a 508 MB export is never resident.** `encodeWav`
  allocates `8 + riffSize` and fills it per sample, so the whole file existed in
  memory before a byte was written — and six 32-bit-float stems of a four-minute
  track are ~508 MB, the ceiling `ARCHITECTURE` R6 names for export and the one
  `stemcache.js` names for the cache write. Two writers, because there are two
  cases and only one of them can seek: `WavStreamEncoder` writes a complete,
  final header on the first chunk and never patches it, and `WavSyncWriter`
  serves the cache path ([#35](https://github.com/itziklerner-pag/stem-splitter-live/issues/35)).
- **A 32-bit-float cache tier, with depth in the key.** The ahead-of-time
  separation path plays from the cache and the same stems are what an export
  ships; neither is served by the lossy 16-bit tier. Depth goes in the KEY and
  never as a flag on `put()` — a flag would let a 32f write land on
  `${key}.${stem}.wav` for a key a 16-bit entry already owns: same name,
  different bytes, and `get()` returning whichever was written last. The tier has
  its own directory and its own cap, and refuses before the model rather than
  after ([#36](https://github.com/itziklerner-pag/stem-splitter-live/issues/36)).
- **File sources are identified by their content.** A file has no `videoId`, and
  every way of borrowing one is wrong: feed a file's address to
  `videoIdFromUrl` and it returns `null`, which `cacheKey` turns into the literal
  key `'null--<pipelineVersion>'` — ONE key shared by every file the user ever
  opens, serving the first file's stems for the second with nothing able to tell.
  Identity is now the whole file's SHA-256, with its own refusal pair
  ([#37](https://github.com/itziklerner-pag/stem-splitter-live/issues/37)).
- **Coverage for the half of `StemCache` that had none.** `test.js` previously
  imported only the pure half of `stemcache.js`; everything the class does over
  storage was untested, and this release lands two slices in exactly that code.
  51 assertions now drive `StemCache` and `CacheWriter` over a real OPFS shim —
  the `put`/`get` round trip through the real encode and decode, an L/R assertion
  that fails if the channels are shared or swapped, and the manifest-written-last
  claim checked by the recorded order in which bytes landed rather than believed
  ([#34](https://github.com/itziklerner-pag/stem-splitter-live/issues/34)).
- **Both mutation batteries are files in the repository, not scratch.** A
  "watched red" is a claim about the source as it stood when it was written, and
  nothing announces the day a later change rewrites the line an anchor patched.
  Two of this phase's five batteries had decayed silently — one reported 51/51
  at branch time and 44/51 against the final tree, and the seven gaps were ten
  dead anchors rather than seven weak assertions. `tools/mutations/u8-seam-fixes.mjs`
  and `qa/mutations-u1-wavstream.mjs` are now in the tree beside what they test,
  each anchor stamped with the landed commit it was cut against. Each reports two
  answers per case and not one — whether the anchor still MATCHES, and separately
  whether the mutation still REDS — because a decayed instrument and a real
  coverage loss need opposite responses and a single pass count collapses them.
  Neither is a `verify.mjs` step: they edit tracked source, and a gate that writes
  the tree it gates can leave it written.

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

[Unreleased]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/itziklerner-pag/stem-splitter-live/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/itziklerner-pag/stem-splitter-live/releases/tag/v0.1.0
