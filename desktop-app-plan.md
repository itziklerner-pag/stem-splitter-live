# Desktop app plan (stem-workbench)

Status: approved 2026-08-25 by the owner after a design interview. Records:
ADR 0001 (`docs/adr/0001-desktop-app-is-a-separate-product.md`), `CONTEXT.md`
(root), Appendix A (the design-session seed, verbatim).

What is being built: a separate Electron desktop product — working codename
`stem-workbench`, its own repository, its own trust story and documents — that
vendors this repository's engine and deck by pinned tag plus SHA-256 and runs
them behind a Host seam. It takes two Sources: YouTube, a Live source captured
from an embedded `WebContentsView`, and local files, a File source. It exports
stems to disk from both. It is non-commercial, permanently — the `htdemucs_6s`
weights are CC BY-NC 4.0. The extension's identity does not change; this
repository's share of the work is the seam (§4), built here, under the
extension, first.

This file is a working plan. The sections about the desktop product itself
(§2 steps 1 and 3–7, §3, §5, Appendix A) migrate to the `stem-workbench`
repository once it exists. §4 (step 2) is this repository's work and stays.

## 1. Decision index

The section numbers are the seed's (Appendix A).

| § | Decision | Outcome |
|---|---|---|
| 1 | Motivation | install-path friction (c) + capabilities an extension cannot have (d) |
| 2 | v1 scope | YouTube (Live) + local files (File); native inference a seam, not shipped |
| 3 | Export | from every Source, YouTube included — option C |
| 4 | A separate product | own repo; engine + deck vendored by pinned tag behind a Host seam (ADR 0001) |
| 5 | Non-commercial | permanently; donations only |
| 6 | Framework | Electron ≥ 32 |
| 7 | Capture path | `getDisplayMedia` answered by `setDisplayMediaRequestHandler`; silencing the original is the #1 risk |
| 8 | Shape | a player window: youtube.com in a `WebContentsView`, deck in the host window |
| 9 | Sign-in | Chrome UA on `persist:youtube`, disclosed in the FAQ |
| 10 | Terms | Source / Live source / File source, in `CONTEXT.md` |
| 11 | Open questions | all ticked; each line points at its section |
| 12 | File-source flow | F2: separate ahead of time into a 32f cache tier; deck is transport master |
| 13 | Export semantics | E3: Export = raw stems (v1); Bounce = as heard (later); ask-once folder |
| 14 | Platforms, release, updates, network | three platforms, macOS first; pre-release channel; updates on; P1′ = one host |
| 15 | Model delivery | M2: bundled in the installer, unpacked from asar |
| 16 | Native-inference seam | S2: audio-level `separate()`; STFT inside the backend; today's worker is backend #1 |
| 17 | Test strategy | T2: the vendored unit carries its own gates; desktop adds host suites only |
| 18 | Sequencing | spike first (kill criterion), then the seam in `stem-splitter-live`, then host v0 |

## 2. Sequencing (tracer bullets)

Seven steps, each with a pass condition (seed §18). Step 1 comes before
step 2 even though step 2 is the more serious work: the refactor is worth
doing only if the spike passes, and the spike costs days. The alternative —
the seam first, the serious work done before the cheap experiment that
decides whether it is needed — was rejected.

1. **The spike** (desktop repository, throwaway, days). Electron +
   `WebContentsView` on youtube.com + `setDisplayMediaRequestHandler`
   returning the view's `mainFrame` for audio and video +
   `webContents.setAudioMuted(true)` (seed §7). PASS: the captured stream is
   non-silent while the speakers are silent. **Kill criterion for the whole
   plan:** if the original cannot be silenced while captured, the
   mute-and-replay model does not exist on Electron — stop before touching
   `stem-splitter-live`. Issue: §3.
2. **The seam**, in `stem-splitter-live` (ADR 0001 decision 5; seed §4).
   Split `extension/offscreen/offscreen.js` into host-agnostic orchestration
   + a thin extension host; route the deck's `chrome.*` touch-points through
   the Host; the audio-level backend interface with today's worker behind it
   (seed §16); model bytes as a Host duty (seed §15); a declared entry point;
   the `chrome.*`-free unit gate (seed §17); the first version tag. PASS:
   `tools/verify.mjs` and `tools/embed-smoke.mjs` green under the existing
   host — the extension behaves identically. Issues: §4, S1–S11.
3. **Desktop host v0.** Vendor script (pinned tag + SHA-256); the Electron
   host — main process, preloads, transport, storage, messaging, shortcut,
   assets, bundled model; the deck in the host window; the YouTube Live
   source end-to-end. PASS: a notarized macOS pre-release a tester can open
   and arm.
4. **File source + export.** Ahead-of-time separation into the 32f tier
   (seed §12); the in-app transport; E1 export with the ask-once folder;
   live-export recording with the contiguity rule (seed §13).
5. **Sign-in.** Chrome UA on `persist:youtube`, the allowlist, graceful
   fallback, the FAQ disclosure (seed §9).
6. **Updates + other platforms.** electron-updater on the pre-release
   channel; Windows Trusted Signing; Linux AppImage (seed §14).
7. **Later.** CoreML backend in a utility process (seed §16); Bounce
   (seed §13).

## 3. Step 1 — the spike (issue for the stem-workbench repo)

Filed as itziklerner-pag/stem-workbench#1 on 2026-08-25, unlabelled — that repo has no triage labels yet. The title and body below are the issue as filed.

**Title:** Spike: prove Electron can capture the YouTube view's audio while the speakers stay silent

**Body:**

````markdown
## What to build

A throwaway Electron app (current stable Electron; Chromium ≥ 128 required):
a host `BrowserWindow` page plus a `WebContentsView` loading a known YouTube
watch URL.

In the main process:

```js
session.setDisplayMediaRequestHandler((req, cb) =>
  cb({ video: ytView.webContents.mainFrame, audio: ytView.webContents.mainFrame }));
```

The host page calls `getDisplayMedia({ audio: true, video: true })` (the spec
forbids audio-only), stops the video track, and feeds the audio track into an
`AnalyserNode` or an `AudioWorklet` that reports RMS.

Try three variants and record each:

- (a) default handler options (`enableLocalEcho` false) and the view NOT
  muted;
- (b) `ytView.webContents.setAudioMuted(true)`;
- (c) both.

For each variant: is the captured stream non-silent (RMS above threshold),
and are the speakers silent (by ear; by OS loopback if available)?

Also record:

- the captured sample rate (48 kHz expected — today Chrome resamples
  48k→44.1k natively in the extension);
- whether capture survives YouTube's SPA navigation and a page reload;
- Electron, Chromium and OS versions.

## Acceptance criteria

- [ ] On macOS (the priority platform) at least one variant yields captured
      RMS above threshold while the speakers are silent. **This is the KILL
      CRITERION for the whole plan:** if no variant does, stop before
      touching `stem-splitter-live` and reconsider.
- [ ] Results for Windows and Linux recorded if machines are available (not
      blocking).
- [ ] Findings written to `docs/spike-capture-mute.md` in the
      `stem-workbench` repo: the variant table, versions, sample rate,
      navigation/reload behaviour, and the Electron issue 32788 maintainer
      comment addressed (it says `tabCapture`'s "silence the tab locally
      while captured" behaviour is not replicable, even with
      `enableLocalEcho`).
- [ ] The throwaway code lives under `spike/` or is deleted after the
      write-up.
- [ ] Which variant becomes the permanent capture-mute gate (seed §17
      item 3: the YouTube view reports muted *and* the captured stream is
      non-silent) is stated.

## Blocked by

None.
````

## 4. Step 2 — the Host seam in this repo (issues S1–S11)

Pass condition for every slice: `node tools/verify.mjs --quick` and
`node tools/embed-smoke.mjs` green under the extension host (embed-smoke
prints the same or a higher `N/N passed`); the extension behaves identically;
L1/P1/M1 hold; `tree-check`'s `downloads`-absent and one-chord assertions
hold.

Seam shape (ratified): each context imports exactly one host-supplied module —
`offscreen/host.js` (EngineHost) and `ui/host.js` (DeckHost) — because
embed.html's CSP (`script-src 'self'`) forbids an inline `boot(host)` and the
deck's markup is part of the unit. JSDoc typedefs plus a boot-time
`assertHost()` live in `extension/shared/host.js`.

Type: AFK — an agent can take the slice end to end (`ready-for-agent`,
`docs/agents/triage-labels.md`); HITL — needs the owner's decisions
(`ready-for-human`). Line numbers (`file:NNN`) refer to the tree on
2026-08-25, before any slice lands; if they drift, re-locate by the quoted
identifier.

| # | Title | Type | Blocked by | Issue |
|---|---|---|---|---|
| S1 | Split `offscreen.js` into the engine's orchestration and a thin extension host | AFK | — | #2 |
| S2 | Asset URLs as a Host duty across the audio graph | AFK | S1 | #4 |
| S3 | Deck-side Host seam: messaging | AFK | — | #3 |
| S4 | Deck-side Host: storage and the arm shortcut | AFK | S3 | #6 |
| S5 | The transport as a Host duty | AFK | S3 | #7 |
| S6 | S2 inference backend on the engine Host; today's worker is backend #1 | AFK | S1, S2 | #8 |
| S7 | Model bytes as a Host duty | AFK | S1 | #5 |
| S8 | Seam-contract gate: serialised backend calls and the wedge rule | AFK | S6 | #9 |
| S9 | Declare the unit and gate it: `extension/unit.json` + `tools/unit-check.mjs` | AFK | S2, S4, S5, S7 | #10 |
| S10 | The unit's own verify entry | AFK | S9 | #11 |
| S11 | Freeze Host interface v1, cut the first tag, write the vendoring instructions | HITL | S8, S10 | #12 |

### S1 — Split `offscreen.js` into the engine's orchestration and a thin extension host — #2

AFK. Blocked by: —.

Move everything in `extension/offscreen/offscreen.js` except its four
`chrome.*` sites into host-agnostic `extension/offscreen/engine.js`. The
chrome half — `send` (:103), the `onMessage` listener (:1031), the
`tabCapture` `getUserMedia` inside `captureStart` (:814), `getURL` (:198) —
becomes `extension/offscreen/host.js` exposing `send`, `onMessage`,
`captureStream(streamId) → MediaStream`, `assetUrl`. Orchestration keeps
`state.job` (:91), the `DEV_*`/`DIAG`/`TEARDOWN` switch verbatim, R5's
track-stop on every failing path (:819-826, the `pagehide` stop :1577), and
boot order (:1587-1589).

- [ ] `--quick` green; embed-smoke same `N/N`.
- [ ] `tree-check` crawl reaches `engine.js` and `host.js` from
      `offscreen.html` (it prints the crawled count).
- [ ] `grep -n 'chrome\.' extension/offscreen/engine.js` matches comments
      only (manual until S9).
- [ ] `node test.js` gains an `assertHost` case: a Host lacking
      `captureStream` throws naming the duty.

Notes: fix the header (:6-8) — only `getURL/onMessage/sendMessage` are used,
not `connect/id/onConnect`. `DEV_*` have no in-repo caller (ARCHITECTURE §6):
review the move by diff.

### S2 — Asset URLs as a Host duty across the audio graph — #4

AFK. Blocked by: S1.

Thread `host.assetUrl` through `shared` into `deck.js:139` (`vendor/ort/`),
`deck.js:225` (ORT HEAD probe), `live.js:593`, `cacheddeck.js:222`,
`master.js:64` (`MasterBus` takes it as a constructor arg — it is built before
`ctx` exists, offscreen.js:193). The worker URL (`deck.js:117`,
`new URL(..., import.meta.url)`) stays relative: the unit's directory layout
is part of its contract.

- [ ] `--quick` green — `test.js` builds `CachedDeck` with a `shared` stub;
      extend the stub, do not skip.
- [ ] embed-smoke green, including "declining downloads nothing" (:587-647),
      which exercises `ensureSession`'s probe path.
- [ ] No executable `chrome.` in `offscreen/{deck,live,master,cacheddeck}.js`
      (comments at live.js:1572, 2107, cacheddeck.js:755 remain).

### S3 — Deck-side Host seam: messaging — #3

AFK. Blocked by: — (appends the DeckHost typedef to `shared/host.js`;
whichever of S1/S3 merges second rebases).

`embed.js` imports its Host from `extension/ui/host.js`: `send` →
`chrome.runtime.sendMessage`, *late-bound* so embed-smoke's patch (:975) still
intercepts; `onMessage` → `chrome.runtime.onMessage`. `toOff`/`toSw` (:92-93)
and the listener (:1855) become `host.send`/`host.onMessage`; the
`{v:1,to,from}` envelope and `__embed` (:2272) unchanged.

- [ ] embed-smoke green: the PITCH wire block (:973-995, counts messages) and
      the SW-injected `LIVE_STATE` blocks (:1199, :1231).
- [ ] `--quick` green; `tree-check` crawl covers `ui/host.js`.
- [ ] Executable `chrome.runtime` in embed.js = 0.

### S4 — Deck-side Host: storage and the arm shortcut — #6

AFK. Blocked by: S3.

`prefs` get/set/onChanged (embed.js:1811, 2227-2231) and the arm-error read
(:2262) go through `host.storage.{get,set,onChanged}` over `local`/`session`
areas. `host.armShortcut()` returns the chord (extension:
`chrome.commands.getAll` + `chordLabel`, as welcome.js:127 does). The deck
shows the chord: its not-armed hint (:997) names it. This is a visible
addition to the deck — today only `welcome.js` shows the chord — and it is
approved. Move `PREFS_KEY` into `shared/config.js` so content.js
(autonav.js:77) and the deck share one literal.

- [ ] embed-smoke autoplay block green (:1296-1325): the checkbox write
      reaches `storage.local` and YouTube's toggle.
- [ ] New embed-smoke assertions: an `armError` seeded via
      `sw.evaluate(chrome.storage.session.set)` before mount paints the banner
      (the read at :2262 has no browser assertion today); the hint's chord
      equals `chrome.commands.getAll`'s, mirroring :232-256.
- [ ] `--quick` green.

### S5 — The transport as a Host duty — #7

AFK. Blocked by: S3.

The deck's `parent.postMessage` sites — `VDRIVE`/`VRELEASE` (:852-887),
`SPEED` (:1446), `DECK` (:1213), `HEIGHT` (:2175), `READY` (:2242), `CLOSE`
(:2127) — and the inbound handler (:2000-2015: `VIDEO`, `JUMP`, `SPEED`,
`KEY`, `AUTONAV`) move behind `host.transport` (read
paused/currentTime/duration, set muted/currentTime/playbackRate) and
`host.page` (keys, autonav report, frame lifecycle). `ui/host.js` implements
both with the existing `stem-splitter-live(-host)` postMessage protocol to
content.js, unchanged. `HOSTED` (:700, `window.parent !== window`) becomes
`host.transport != null`.

- [ ] embed-smoke green: play/pause/seek (:594-668), speed and the ad gate
      (:1045-1175), page keys (:709-852), frame height (:682-692).
- [ ] `node tools/name-check.mjs` green — both halves of each IPC pair still
      present.
- [ ] `node extension/ui/embed-state.js` green (`follow()`'s `hosted`
      semantics untouched).

Notes: under the desktop host `window.parent === window` yet the deck *is*
hosted; today's `HOSTED` would auto-run it on boot (embed-state.js:60-70).
This slice closes that.

### S6 — S2 inference backend on the engine Host; today's worker is backend #1 — #8

AFK. Blocked by: S1, S2. ("S2" in the title is seed §16's option S2 — the
audio-level seam — not slice S2.)

Declare `Backend` — `load(bytes)`, `separate(mix Float32Array[2·SEGMENT]) →
six stereo stems in `STEMS` order`, `dispose()` — and `WorkerBackend`
wrapping `workers/inference.worker.js` (INIT/LOAD_MODEL/INFER/RESULT/DISPOSE
and the pending map from deck.js:115-205; `assetUrl('vendor/ort/')`). A
serialising wrapper queues `separate()` so one call is in flight per
instance. `deck.js:261 infer()` keeps `gpu.run()` and calls
`backend.separate`. `host.createBackend()` returns a fresh instance per deck
(one worker per deck, deck.js:18-25).

`WorkerBackend` keeps today's zero-copy buffer transfer semantics
(deck.js:257-259, :295): the worker's RESULT hands both buffers back, and
demotion relies on *not* transferring. Do not change which buffers are
transferred and which are not.

- [ ] `--quick` and embed-smoke green.
- [ ] `node test.js` gains a `backend` group: 8 concurrent `separate()` on a
      fake backend → max in flight 1, FIFO, 8 results (counts, not clocks).
- [ ] Manual: load unpacked, play, hear six stems (CONTRIBUTING's audio-path
      rule).

### S7 — Model bytes as a Host duty — #5

AFK. Blocked by: S1.

`host.modelBytes(onProgress)`, `host.modelCached()`, `host.clearModel()`
replace the `shared/modelcache.js` import (offscreen.js:34; its only
importer). The Cache-API + `fetch(MODEL.url)` half moves into
`offscreen/host.js`; SHA-256 and byte-count verification stay in the unit
(`shared/modelcache.js::verifyModel(bytes)`) and run on every load whatever
the Host hands over (seed §15, M1). `modelChain` serialisation and
`state.model` progress (:155-190) stay in orchestration.

`MODEL.url` leaves the unit too. The unit's `shared/config.js` keeps only the
SHA-256 and the byte count; the URL moves to the extension host (beside the
`fetch` in `offscreen/host.js`, or a host-side module it imports).
`config.js` stays the single source of the pin for `tools/fetch-model.sh` and
`tools/host.mjs`, which take the URL from the extension-host side.

- [ ] embed-smoke green: "nothing fetched yet" (:228) and "declining
      downloads nothing" (:587-647).
- [ ] `node test.js` gains `verifyModel`: a mismatching buffer rejects naming
      both hashes; a matching one (pin parametrised) resolves.
- [ ] `bash tools/fetch-model.sh` and `tools/host.mjs` still derive the pin
      from `config.js`.
- [ ] Unit files contain no model URL (a grep for it hits only the extension
      host); `verifyModel` unchanged.

### S8 — Seam-contract gate: serialised backend calls and the wedge rule — #9

AFK. Blocked by: S6.

A Node suite (registered as a `--quick` step) drives the serialising wrapper
over a fake worker port that throws on INFER-while-busy (the guard at
inference.worker.js:10-12). Asserts: no overlap under 16 concurrent calls;
one rejecting call does not wedge the queue (15 results + 1 named rejection);
`dispose()` rejects pending calls by name; positive control — bypassing the
wrapper trips the fake's guard (the control can lose).

The seam's per-backend queue is the one true serialisation. `GpuScheduler.run`
stays the cross-deck policy, and the worker's `busy` guard becomes a backstop
that this suite proves unreachable through the wrapper.

- [ ] Every assertion watched red by mutation (drop the queue; drop the
      `finally`); mutations named in the PR body.
- [ ] `node tools/verify.mjs --only <id>` is PASS, not VOID (prints
      `N passed, 0 failed`).
- [ ] No assertion reads a clock.

### S9 — Declare the unit and gate it: `extension/unit.json` + `tools/unit-check.mjs` — #10

AFK. Blocked by: S2, S4, S5, S7.

`unit.json` names the entries (`offscreen/engine.js`, `ui/embed.html`), the
host-supplied holes (`offscreen/host.js`, `ui/host.js`) and the external ORT
drop (by reference to `tools/fetch-vendor.sh`). `unit-check.mjs` (reads,
writes nothing; tree-check's crawl regexes): every file in the closure
resolves; comments stripped, the closure contains no `chrome.`; the only
imports leaving it are the declared holes; the closure contains every path
ADR 0001 decision 3 lists (presence — an empty crawl cannot pass); positive
control — the extension-host files *do* contain `chrome.`.

- [ ] Registered in verify.mjs `steps` beside `tree`; `--quick` and CI green.
- [ ] Mutations watched red: `chrome.runtime.id` in `engine/mixer.js`; a unit
      file importing `../sw/service-worker.js`; a deleted hole.
- [ ] A comment mention (live.js:1572) stays green.

### S10 — The unit's own verify entry — #11

AFK. Blocked by: S9.

`unit.json` lists the plain-Node suites that exercise the unit (`test.js`,
`extension/ui/dev/selftest.mjs`, the engine self-checks, `ui/embed-state.js`,
`qa/test-edge.mjs`, `qa/passthrough-gain.mjs`, `qa/speed-pitch.mjs`) and the
runner files (`tools/verify.mjs`, `tools/host.mjs`);
`node tools/verify.mjs --unit` runs exactly that plan under the VOID rule
(verify.mjs:422). `unit-check` asserts every listed path exists.

- [ ] `--unit` green; its plan equals the manifest's list, asserted in
      `--self-check`.
- [ ] `--quick` unchanged and green; `--only` still works.
- [ ] `unit-check` red when a listed suite path is removed.

### S11 — Freeze Host interface v1, cut the first tag, write the vendoring instructions — #12

HITL. Blocked by: S8, S10.

Review `shared/host.js` and `unit.json` as the unit's public surface. Add
`tools/unit-hash.mjs` producing `extension/unit.sha256` (one SHA-256 per unit
file, mirroring fetch-vendor.sh's `verify`). Write `docs/VENDORING.md`: fetch
the tag's archive, copy the `unit.json` paths verbatim (repo-relative layout
preserved), verify each file against `unit.sha256`, run
`tools/fetch-vendor.sh` for ORT, run `node tools/verify.mjs --unit`, fail on
any mismatch. Update ARCHITECTURE §1/§6 and CONTEXT.md.

Tags: one series, per ADR 0001 decision 6 (the unit is not extracted). Tag
`v0.1.0` retroactively at the initial public release commit `87aa27b` — that
resolves the `v0.1.0` links CHANGELOG.md already carries — and cut the seam as
`v0.2.0` on `main`. Push both.

- [ ] `unit-check` asserts `unit.sha256` matches the tree (a stale sums file
      goes red).
- [ ] The instructions, dry-run from an empty directory, end in `--unit`
      green.
- [ ] `v0.1.0` on `87aa27b` and `v0.2.0` on `main`, both pushed; CHANGELOG
      entry for `0.2.0`; the `v0.1.0` links resolve.

Notes: the interface's final shape is the human decision; the tag names are
fixed above.

### Dependency graph

```
S1 ─→ S2 ─→ S6 ─→ S8 ─────────────┐
S1 ─→ S7 ──────────┐              │
S3 ─→ S4 ──────────┼→ S9 → S10 ──┴→ S11
S3 ─→ S5 ──────────┤
S2 ────────────────┘
```

S1 and S3 start in parallel; S2/S7 and S4/S5 are parallel pairs; no cycles.
Critical path: S1 → S2 → S6 → S8 → S11.

### Implementer notes / open points from planning

- The postMessage boundary carries more than the transport — `KEY`,
  `AUTONAV`, `HEIGHT`, `READY`, `CLOSE`, `DECK` — hence `host.page` beside
  `host.transport` (S5).
- `hosted` is derived from the Host (S5), never from `window.parent`.
- `fetch` and the Cache API are not `chrome.*`, so the unit gate (S9) cannot
  catch a network path left in the unit. S7's URL split is what removes it.
- `DEV_*`/`DIAG` are unverified and S1 moves ~300 lines of them. Optionally
  add a `DIAG` round-trip to embed-smoke.
- The unit's suites live outside `extension/` and import `../extension/...`;
  vendoring preserves the repo-relative layout (S11's `docs/VENDORING.md`).
- `extension/vendor/ort/` is gitignored; the desktop runs the same
  `fetch-vendor.sh` pin.
- `offscreen.js` ceases to exist under this shape. Amend ADR 0001's wording
  and the ARCHITECTURE §1 diagram in S11.
- ARCHITECTURE.md §3 cites `engine/ola.js`, which does not exist. Fix in
  S11's doc pass.

## 5. Steps 3–7 (desktop repo) — pointers

Step 3, desktop host v0: the product shape and the seam's other half are
seed §4 (what the Host supplies), §6 (Electron, Chromium ≥ 128), §7 (the
capture path and its risk), §8 (the player window, the preload as
transport), §14 (macOS first, notarized pre-release) and §15 (the model
bundled in the installer).

Step 4, File source + export: seed §12 (F2 — ahead-of-time separation into a
32f cache tier; the deck as transport master; the `stemcache.js` consequence
for this repository) and §13 (Export vs Bounce, the contiguity rule, the
ask-once folder).

Step 5, sign-in: seed §9 (Chrome UA on `persist:youtube`, the allowlist,
fallback, the FAQ disclosure).

Step 6, updates + other platforms: seed §14 (signing per platform,
electron-updater on the pre-release channel, P1′).

Step 7, later: seed §16 (CoreML backend in a utility process, the open
backend-selection questions) and §13 (Bounce).

## Appendix A — stem-workbench seed (verbatim)

The design-session record, pasted verbatim. Its headings are demoted two
levels to fit this document's outline; nothing else is changed.

### stem-workbench — design-session seed

Running record of the decisions taken in the 2026-08-24 design session for the
desktop product (working codename `stem-workbench`). Raw material for that
repository's README, `CONTEXT.md`, ADRs and first issues — not yet any of them.
Companion to `docs/adr/0001-desktop-app-is-a-separate-product.md` and the
Source terms in `CONTEXT.md`, both in `stem-splitter-live`.

One section per decision: decision · rationale · rejected · open.

#### Decision index

| § | Decision | Outcome |
|---|---|---|
| 1 | Motivation | install-path friction (c) + capabilities an extension cannot have (d) |
| 2 | v1 scope | YouTube (Live) + local files (File); native inference a seam, not shipped |
| 3 | Export | from every Source, YouTube included — option C |
| 4 | A separate product | own repo; engine + deck vendored by pinned tag behind a Host seam (ADR 0001) |
| 5 | Non-commercial | permanently; donations only |
| 6 | Framework | Electron ≥ 32 |
| 7 | Capture path | `getDisplayMedia` answered by `setDisplayMediaRequestHandler`; silencing the original is the #1 risk |
| 8 | Shape | a player window: youtube.com in a `WebContentsView`, deck in the host window |
| 9 | Sign-in | Chrome UA on `persist:youtube`, disclosed in the FAQ |
| 10 | Terms | Source / Live source / File source, in `CONTEXT.md` |
| 11 | Open questions | all ticked; each line points at its section |
| 12 | File-source flow | F2: separate ahead of time into a 32f cache tier; deck is transport master |
| 13 | Export semantics | E3: Export = raw stems (v1); Bounce = as heard (later); ask-once folder |
| 14 | Platforms, release, updates, network | three platforms, macOS first; pre-release channel; updates on; P1′ = one host |
| 15 | Model delivery | M2: bundled in the installer, unpacked from asar |
| 16 | Native-inference seam | S2: audio-level `separate()`; STFT inside the backend; today's worker is backend #1 |
| 17 | Test strategy | T2: the vendored unit carries its own gates; desktop adds host suites only |
| 18 | Sequencing | spike first (kill criterion), then the seam in `stem-splitter-live`, then host v0 |

---

#### 1. Motivation

**Decision.** Two motives, both real: (c) the extension's install path —
`chrome://extensions` → Developer mode → Load unpacked — limits adoption to
people willing to do that; (d) capabilities an extension cannot have. *(The
letters are the session's motive list, not ADR 0001's (a)–(d).)*

**Rationale.** (c) is on record in ADR 0001 ("limits adoption to people willing
to do that"); (d) is the product surface of §2–§3 below.

**Rejected.** Store-rejection fear as a motive. The extension was never
submitted to the Chrome Web Store, so nothing was rejected.

**Open.** —

#### 2. v1 scope

**Decision.** v1 separates two Sources: YouTube (a Live source) and local
files (a File source). Native inference is planned as an architectural seam
in v1, not shipped in v1.

**Rationale.** ADR 0001 wants (b) local audio files as a source and (d) a
build in which the WebGPU/WASM ONNX Runtime worker can later be swapped for
native inference; the seam is what (d) costs now.

**Rejected (out of scope).**
- Desktop-app / system audio capture. Keeping the mute-and-delay model — the
  user hears the stems, not the original — needs a virtual audio device. That
  is a second product.
- DRM'd web players (Spotify Web, Apple Music). Stock Electron ships no
  Widevine CDM; it would need the castLabs fork plus VMP signing, and DRM
  output is capture-protected anyway.

**Open.** Platforms: resolved, §14. Model delivery: resolved, §15.
File-source flow: resolved, §12.

#### 3. Export

**Decision.** Export is allowed from every Source, including captured YouTube
audio — option C.

**Rationale.** The product owner's requirement (ADR 0001, considered options):
export from every source.

**Rejected.**
- A — no export.
- B — source-dependent export (File sources may export, Live sources never),
  enforced by separate renderer processes.

**Consequences.**
- Contradicts `stem-splitter-live`'s L1 identity → a separate product
  (ADR 0001).
- Legal exposure acknowledged: YouTube's ToS download clause; the
  youtube-dl-style takedown category (October 2020). It attaches to this
  product alone.
- Live-source export is real-time bound — the player has to play through.
  File-source export runs at engine speed: ~0.45× real time on WebGPU, M2 Max
  reference. (A ratio on a named machine; re-measure on the target.)

**Prior art in `stem-splitter-live`.**
- The engine still carries an `'export'` mode. `extension/offscreen/deck.js:73`:
  "`'export'` drains the ring destructively; `'live'` reads it by absolute
  frame". It is the default `attach()` mode (`deck.js:320`;
  `offscreen.js:811` `captureStart(streamId, source, mode = 'export')`) and
  `startLive()` flips it. Chunked job model (`pending`, `nextId`, `blocks`).
- `extension/shared/wav.js` encodes 32-bit float WAV at 44.1 kHz by default
  (also 24-bit and 16-bit PCM; TPDF dither on 16-bit only —
  `dither = bitDepth === 16 && !isFloat`). `docs/AUDIO.md` §4.5: export
  32-bit float, samples untouched.
- Historically export produced six 32-bit float WAVs through
  `chrome.downloads`; only the delivery step was removed — on identity, not
  technical grounds (`FAQ.md`: "offline export was built, and then cut";
  `docs/ARCHITECTURE.md` appendix). It predates the squashed initial commit,
  so there is no diff to recover. *(The session record says "dithered";
  `wav.js` does not dither float output — verify before quoting.)*

**Open.** Export semantics: resolved, §13.

#### 4. A separate product

**Decision.** Recorded as ADR 0001 in `stem-splitter-live`: own name (codename
`stem-workbench`), own repository, own `NOTICE` / `FAQ` / `PRIVACY`. The
vendored unit is the engine and the deck, behind a Host seam:

- *Engine* in `docs/ARCHITECTURE.md`'s sense — the whole offscreen audio
  pipeline: the DSP modules in `extension/engine/`, the audio graph in
  `extension/offscreen/` (`deck.js`, `live.js`, `master.js`, `cacheddeck.js`,
  the worklet processors), `extension/shared/`,
  `extension/workers/inference.worker.js`.
- *Deck* — `extension/ui/embed*.js`.
- Everything that is not `chrome.*`-bound goes.
- *Host* — one per product; supplies what the engine and the deck cannot
  obtain themselves: a Source's media stream (the capture grant), storage
  get/set, messaging send/onMessage, the arm shortcut (the deck reads the
  chord from the Host), asset URLs (`getURL`), a **transport** — read
  `paused` / `currentTime` / `duration`, set `muted` / `currentTime` /
  `playbackRate`; today `content.js` / `autonav.js` / `speed.js` against
  YouTube's `<video>`, in this product the YouTube view's preload (§8) — and
  later an inference backend (the native-inference seam, §16). For a File
  source the deck itself becomes the transport master: the host supplies an
  in-app transport instead of YouTube's `<video>`.
- Extension host (stays in `stem-splitter-live`): `sw/`, `content.js`,
  `autonav.js`, `speed.js`, `ui/welcome*`, `manifest.json`, the
  `chrome.runtime` / `getUserMedia` half of `offscreen.js`. Desktop host: the
  Electron main process, preloads, the `WebContentsView`.

The unit stays in `stem-splitter-live` with a declared entry point and version
tags; the desktop repository vendors it by pinned tag + SHA-256 — the
discipline `tools/fetch-vendor.sh` already applies to ONNX Runtime. Extracting
it into its own package is deferred until its release cadence diverges from the
extension's.

**Sequencing.** The seam is built in `stem-splitter-live` first, before this
repository exists: split `extension/offscreen/offscreen.js` into host-agnostic
orchestration and a thin extension host (`chrome.runtime` messaging, the
`tabCapture` `getUserMedia` call); route the deck's `chrome.*` touch-points
(`prefs` in `chrome.storage.local`, the arm-error record in
`chrome.storage.session`, `chrome.runtime` messaging, the chord) through the
same seam. `tools/verify.mjs` and `tools/embed-smoke.mjs` prove the seam under
the existing host — the tracer bullet — before a second host exists.

**Rationale.** Every document in the extension stays true; takedown blast
radius is confined to the artifact that takes the risk; the Host seam is
forced into existence, and the inference backend is one of its methods, so
native inference lands on the same seam (ADR 0001, consequences). The audio
graph is the most tuned real-time code in the project; a second copy drifts
immediately.

**Rejected.** Same product with its identity rewritten; `apps/desktop/` in the
same repository; the unit as its own repository/package now (deferred, not
rejected); vendor only `extension/engine/` (pure DSP) and re-implement the
audio graph here — duplicates the most tuned real-time code in the project and
the copies drift immediately.

**Open.** The Host interface's exact shape; the inference backend method is
fixed (§16), the model-bytes source too (§15).

#### 5. Non-commercial, permanently

**Decision.** The product is non-commercial and stays so. `NOTICE` says so
from the first commit. Donations are fine; paid tiers and bundling are not.

**Rationale.** The `htdemucs_6s` weights are CC BY-NC 4.0. The six-stem
contract is model-specific, so a commercial door would mean a different model,
a different contract and no shared engine — a different product.

**Rejected.** A commercial tier, now or later.

**Open.** —

#### 6. Framework: Electron

**Decision.** Electron. Chromium ≥ 128 is required (the extension's floor), so
Electron ≥ 32; current stable is 44 (Chromium 152).

**Rationale.** The three things Tauri lacks (below) are the three things the
engine needs: capture of an embedded frame's audio, SharedArrayBuffer, WebGPU.

**Rejected.**
- Tauri: no engine can capture an embedded frame's audio; SAB is flaky on
  WKWebView / WebKitGTK; no WebGPU on WebKit engines.
- A Chromium / CEF fork.

**Note.** Electron's extension shim lacks `chrome.tabCapture` and
`chrome.offscreen`, so this is a port of the extension, not a load of it.

**Open.** —

#### 7. Capture path

**Decision.**
- The host renderer calls `getDisplayMedia({ audio: true, video: true })` —
  the spec forbids audio-only — and stops the video track.
- `session.setDisplayMediaRequestHandler` answers with
  `{ video: ytView.webContents.mainFrame, audio: ytView.webContents.mainFrame }`
  (Electron ≥ 22; cross-WebContents verified in source). No Windows-only
  caveat — that applies only to `'loopback'`.
- SharedArrayBuffer via COOP/COEP on the app's own protocol (worklets inherit
  isolation; workers must be same-origin), or the SharedArrayBuffer feature
  switch.
- WebGPU is on by default on Windows and macOS; Linux mostly needs flags; the
  ORT threaded-WASM fallback already exists.

**Rationale.** Electron has no `chrome.tabCapture`; `getDisplayMedia` answered
by `setDisplayMediaRequestHandler` is the supported way to capture one
WebContents' audio.

**Rejected.** —

**FIRST SPIKE / #1 RISK.** The product depends on the user *not* hearing the
original. An Electron maintainer comment (issue 32788, Nov 2025) says
`tabCapture`'s "silence the tab locally while captured" behaviour is not
replicable, even with `enableLocalEcho`. Candidate fallback:
`webContents.setAudioMuted(true)` on the YouTube view — Chromium's local muter
should still feed capture. Unverified. Prove it first; nothing else in this
list matters if it fails.

#### 8. Shape: a player window

**Decision.**
- youtube.com in an embedded `WebContentsView` (not `<webview>`, which the
  Electron docs discourage). No address bar, no tabs.
- Navigation allow-listed to youtube.com plus accounts.google.com,
  accounts.youtube.com, consent.youtube.com, myaccount.google.com.
- The deck is drawn in the host window beneath the view — not injected into
  YouTube's DOM.
- A preload in the YouTube view does what `content.js`, `autonav.js` and
  `speed.js` do today: read `paused` / `currentTime` / `duration`; write
  `muted` / `currentTime` / `playbackRate`; autonav.

**Rationale.** Same boundary as the extension's content script: transport
state, never media (`CONTRIBUTING.md` L1).

**Rejected.** A general browser with tabs; a deck injected into YouTube's DOM
(the extension's reason, `docs/ARCHITECTURE.md` §1: YouTube's origin, YouTube's
CSP, one stylesheet change from breaking).

**Open.** —

#### 9. Sign-in

**Decision.** Set a stock Chrome user-agent on the persistent YouTube partition
(`persist:youtube`) so users can sign in to Premium; the session persists
across restarts via cookies; graceful anonymous fallback if Google refuses.
The FAQ must disclose that Google does not endorse this, that it may stop
working, and that account challenges / flaky 2FA are possible.

**Rationale.** Google blocks sign-in from embedded frameworks by user-agent
("This browser or app may not be secure"; policy since 2019).

**Rejected.**
- Anonymous-only: ads get separated too; bot-check walls.
- Cookie import from Chrome: invasive, and app-bound encryption.

**Open.** —

#### 10. Terms

**Decision.** Source / Live source / File source — recorded in
`stem-splitter-live/CONTEXT.md` (Language → Sources; Relationships).

**Open.** —

#### 11. Open questions — TODO

- [x] Shared unit boundary — resolved (§4, ADR 0001): engine in
      ARCHITECTURE.md's sense (DSP modules + audio graph) + deck, behind the
      Host seam. Prerequisite in `stem-splitter-live`: split `offscreen.js`;
      route the deck's `chrome.*` touch-points through the seam.
- [x] File-source playback model — resolved (§12, F2): separated ahead of
      time into a 32f cache tier; the deck plays from it and is the transport
      master (§4).
- [x] Export semantics — resolved (§13, E3; E1 in v1): **Export** = the raw
      stems, 32f WAV; **Bounce** = as heard, not v1; naming and destination
      fixed.
- [x] Platforms, signing / notarization, auto-update, network rule — resolved
      (§14): all three platforms from day one, macOS first; GitHub pre-release
      channel; electron-updater on by default; P1′ = one named host.
- [x] Model delivery — resolved (§15, M2): bundled in the installer, unpacked
      from asar; the Hugging Face single point of failure is gone.
- [x] Native inference seam — resolved (§16, S2): audio-level `separate()`
      on the Host; STFT/iSTFT inside the backend; today's worker is the first
      backend, untouched.
- [x] Test strategy — resolved (§17, T2): the vendored unit carries its own
      gates; the desktop repository adds host suites only (Playwright for
      Electron against a local fake player). The `verify.mjs` port is rejected.
- [x] Sequencing / tracer bullets — resolved (§18): §7's spike first, with a
      kill criterion; the seam refactor in `stem-splitter-live` second; desktop
      host v0 third.

#### 12. File-source flow

**Decision.** Option F2. A File source is decoded whole, then separated ahead
of time at engine speed through the existing chunked `'export'`-mode job model
(`extension/offscreen/deck.js:73`; progress as `state.job` — `pct` / `etaMs` /
`stage`, `extension/offscreen/offscreen.js:91`) into a 32-bit-float tier of
the OPFS stem cache — today's cache is 16-bit and for live playback only
(`extension/shared/stemcache.js`, header). The deck plays from that cache with
zero lag and free seeking, and is itself the transport master (the in-app
transport, §4). Export (§13) reads the same 32f stems: the model runs once.

The standing rule in `extension/shared/stemcache.js:12-14` / `docs/AUDIO.md`
§4.5 — "export always re-derives from the model at 32f, so no lossy artefact
can ever reach a deliverable" — is sharpened to *a deliverable is never derived
from a lossy cache*: its original intent, which the 32f tier satisfies.

**Rationale.** Engine-speed separation and free seeking are the File source's
defining property (`CONTEXT.md`, Relationships). F2 is the only option that
keeps both and runs the model once for playback and export.

**Rejected.**
- F1 — play the file like a tab, through an in-app `<audio>` element: inherits
  the 3.4 s lag and real-time export; discards the File source's defining
  property.
- F3 — stream ahead through the live ring faster than real time: most of F2's
  complexity, worse UX.

**Consequence for `stem-splitter-live`.** `stemcache.js` gains a 32f tier
option, used by the desktop host only; the live 16-bit cache is unchanged.

**Open.** Eviction policy for 32f entries (~508 MB per 4-minute track at six
stems, `stemcache.js` header); whether the 32f tier counts against the existing
4 GiB cap (`STEM_CACHE_MAX_BYTES`, `extension/shared/config.js`).

#### 13. Export semantics

**Decision.** Option E3; E1 ships in v1. Two terms for the desktop glossary:

- **Export** — the six untouched model outputs (drums, bass, other, vocals,
  guitar, piano) written as files: 32-bit float, 44.1 kHz, stereo WAV
  (`docs/AUDIO.md` §4.5; the historical export, §3). v1.
- **Bounce** — what the deck is playing, rendered offline with faders,
  mute/solo, transpose and speed baked in. Not v1: needs an
  `OfflineAudioContext` path through the playback worklet's DSP, which today
  runs only in real time.

Never call raw stems "the mix".

Live-source export is a recording: arm export, the video plays through, stems
stream into the 32f cache tier (never accumulated in RAM), files are written at
the end. Contiguity rule: a live export is one contiguous real-time pass from
the current position; a seek ends it; whatever was captured up to that point
remains exportable; autonav is suspended while a live export runs (else the
next video records into the same file); mid-roll ads break contiguity, which
Premium sign-in (§9) avoids.

Destination: ask for a folder once via the OS dialog, remember it through the
Host's storage, write `<title>/<title> - <stem>.wav`. No silent default folder.

**Rationale.** A deliverable and a mix are different things with different
consumers — a DAW wants the raw stems at unity (`docs/AUDIO.md` §5.1), a
listener wants what they heard — so they get different names. E1 is what the
engine already produces (§3, prior art); a bounce needs an offline render path
that does not exist yet.

**Rejected.**
- E1 only, forever — bounce is a real user need, just not v1.
- E2 as the definition of export — confuses deliverable with mix.
- A fixed export folder.

**Open.** —

#### 14. Platforms, release channel, updates, network rule

**Decision.**
- All three platforms — macOS, Windows, Linux — built from day one in CI with
  electron-builder. Release priority: macOS, then Windows, then Linux. An
  Apple Developer account already exists.
- The first release is a pre-release channel, not a launch: GitHub
  pre-releases, no announcement, no website.
- Signing. macOS betas signed and notarized from the first beta. Windows betas
  unsigned during beta (testers click through SmartScreen); Azure Trusted
  Signing (~$10/month, individuals eligible) before the official release.
  Linux AppImage / deb unsigned; Flathub is optional and is itself a review
  process — opt-in later.
- Auto-update: default ON with a visible toggle, via electron-updater against
  GitHub Releases, following the pre-release channel during beta.
- Network rule **P1′** — successor to `stem-splitter-live`'s P1 ("no network
  after the model download"): the app's own code talks to exactly one named
  host, GitHub Releases, for the update check, and nothing else. No telemetry,
  no crash reporting. The YouTube view's traffic is the user's browsing, and
  `PRIVACY` says so. *(Drafted as two hosts — model + updates — before the
  model was bundled; §15.)*

**Rationale.**
- macOS first because notarization is the one gate that cannot be clicked
  through: an un-notarized beta is the one thing testers on current macOS
  cannot open. The account is already paid; notarization is an automated
  scan, not a review.
- Updates on by default: the app owns a Chromium engine that loads
  youtube.com, and therefore owns Chromium's security patches (Electron ships
  them roughly every two weeks). An app that cannot update itself has a worse
  security posture than the extension, where Google did this.

**Rejected.**
- Release order by gatekeeper cost (Linux first).
- Updates off by default, for P1 purity — the Chromium-patch argument wins.

**Open.** —

#### 15. Model delivery

**Decision.** Option M2: the model ships inside the installer. The 109 MiB
`htdemucs_6s` ONNX (pinned commit + SHA-256,
`extension/shared/config.js:333-338`) is packaged in the app and unpacked from
asar (`asarUnpack`) so ONNX Runtime can read it by path / `app://` URL. The
26.5 MiB ORT runtime is vendored at build time as today
(`tools/fetch-vendor.sh`).

**Rationale.** No first-run download; works offline from first launch; the
third-party Hugging Face single point of failure (`NOTICE.md:44-49`) is gone
for the desktop product.

**Consequences.**
- Installers ≈ 300 MB. Windows NSIS and macOS zip updates are differential —
  the unchanged model blocks are not re-downloaded; Linux AppImage updates
  re-ship the whole artifact.
- `modelcache.js`'s SHA-256 check on every load
  (`extension/shared/modelcache.js:58-72`) still runs against the bundled
  file: integrity and rule M1 ("no remote code") preserved.
- "Where the model bytes come from" becomes a Host duty on the seam (§4):
  extension host = Cache API + Hugging Face download; desktop host = bundled
  file.
- `NOTICE` must carry the weights' provenance and licence — CC BY-NC 4.0,
  attribution to Meta / Demucs; the ONNX is a third-party re-export with no
  model card — because the product now redistributes them. The extension's
  "we do not redistribute the weights" (`NOTICE.md:40-42`) does not carry
  over.

**Rejected.**
- M1 — first-run download from Hugging Face as today: keeps the single point
  of failure, now for installers in the wild.
- M3 — first-run download from a self-controlled GitHub Release asset, Hugging
  Face as fallback: smaller installers, cheap Linux updates. The recommended
  option, overruled by the product owner in favour of offline-from-first-launch
  simplicity.

**Open.**
- The desktop host's own first-run screen — the extension's `ui/welcome*`
  stays behind; it is `chrome.commands`-bound.
- Whether to keep a download path at all, for a future model swap.

#### 16. Native-inference seam

**Decision.** Option S2 — an audio-level seam. The Host provides an inference
backend behind

    separate(stereo Float32Array, 343,980 samples) → six stereo Float32Arrays

in `STEMS` order (`docs/SIX-STEM-CONTRACT.md:17`: drums, bass, other, vocals,
guitar, piano). STFT / iSTFT live *inside* the backend. Today's worker —
`extension/workers/inference.worker.js`, WebGPU or threaded WASM ORT, with its
~283 ms/segment JS STFT/iSTFT (`inference.worker.js:5`) around the
hoisted-STFT ONNX graph (`extension/engine/demucs.js:11-15`: `[1,2,343980]` +
`[1,4,2048,336]` → `[1,6,4,2048,336]` + `[1,6,2,343980]`) — becomes the first
backend, untouched inside.

The worker's standing rule — one in-flight `run()` per wasm instance or the
session wedges permanently (`inference.worker.js:10-12`,
`extension/engine/scheduler.js:21`, `extension/offscreen/deck.js:21`) —
becomes the seam's contract: the seam serialises calls; no caller can wedge a
session.

Process placement, desktop host: native backends run in an Electron utility
process — crash isolation, and native modules stay out of the sandboxed
renderer. IPC per segment ≈ 2.7 MB in / ≈ 16.5 MB out as transferables, one
call per 7.8 s segment.

Target EPs, when it happens (not v1): CoreML first (macOS first, §14; Apple
Silicon), then DirectML (Windows), then CUDA.

**Rationale.** The audio-level interface is the one the engine already speaks
(`docs/AUDIO.md` §1 figure: in `(1, 2, 343980)`, out `(1, 6, 2, 343980)`), and
it puts the JS spectral path — the slowest stage on WebGPU — inside the thing
meant to speed it up. The serialisation rule already exists in three files;
the seam is where it belongs.

**Rejected.** S1 — a tensor-level seam: freezes the JS spectral path into the
interface and keeps the slowest stage out of reach of the thing meant to speed
it up.

**Open.**
- Whether the native backend runs the same hoisted-STFT ONNX with a native
  STFT, or a different export of the model.
- Backend selection / fallback policy, and how the deck reports which backend
  is live.

#### 17. Test strategy

**Decision.** Option T2 — the vendored unit carries its own gates.

- The unit ships with its self-tests and a `verify` entry, so the desktop
  repository runs the *same* suites on the vendored copy on every pin bump.
- `stem-splitter-live` adds one gate in the spirit of `tools/tree-check.mjs`
  (reads, writes nothing) — a unit check: every file in the declared unit
  resolves, and none of them, transitively, touches `chrome.*`. The desktop
  vendor script trusts it.
- The desktop repository adds only host-specific suites, in the same
  conventions — custom runner, no framework, a suite that asserts nothing is
  not green (`tools/verify.mjs:423`, "no assertions produced" is a hard
  failure):
  1. A Playwright-for-Electron smoke against a *local* fake player page — a
     `<video>` the preload drives — so CI never depends on YouTube's DOM and
     never hits bot walls. Same trick as `tools/host.mjs` answering as
     `huggingface.co`.
  2. A real-YouTube smoke as a manual / nightly gate.
  3. The capture-mute assertion as a permanent gate: the YouTube view reports
     muted *and* the captured stream is non-silent — the property §7's spike
     must prove.
  4. A P1′ acceptance test ported from P1's (`CONTRIBUTING.md`, P1): the
     app's own sessions make no request except to the update host; the
     `persist:youtube` partition excluded.

**Rationale.** One runner, one set of conventions; the suites that guard the
audio graph travel with the audio graph, so a pin bump is verified by the
tests written against that exact code.

**Rejected.** T1 — copy `tools/verify.mjs` into the desktop repository and
write its own suites: two runners, drift where it is most expensive.

**Open.** —

#### 18. Sequencing — tracer bullets

**Decision.** Seven bullets, each with a pass condition.

1. **The spike** (desktop repository, throwaway, days). Electron +
   `WebContentsView` on youtube.com + `setDisplayMediaRequestHandler`
   returning the view's `mainFrame` for audio and video +
   `webContents.setAudioMuted(true)` (§7). PASS: the captured stream is
   non-silent while the speakers are silent. **Kill criterion for the whole
   plan:** if the original cannot be silenced while captured, the
   mute-and-replay model does not exist on Electron — stop before touching
   `stem-splitter-live`.
2. **The seam**, in `stem-splitter-live` (ADR 0001, decision 5; §4). Split
   `extension/offscreen/offscreen.js` into host-agnostic orchestration + a
   thin extension host; route the deck's `chrome.*` touch-points through the
   Host; the S2 backend interface with today's worker behind it (§16); model
   bytes as a Host duty (§15); a declared entry point; the `chrome.*`-free
   unit gate (§17); the first version tag. PASS: `tools/verify.mjs` and
   `tools/embed-smoke.mjs` green under the existing host — the extension
   behaves identically.
3. **Desktop host v0.** Vendor script (pinned tag + SHA-256); the Electron
   host — main process, preloads, transport, storage, messaging, shortcut,
   assets, bundled model; the deck in the host window; the YouTube Live source
   end-to-end. PASS: a notarized macOS pre-release a tester can open and arm.
4. **File source + export.** Ahead-of-time separation into the 32f tier
   (§12); the in-app transport; E1 export with the ask-once folder;
   live-export recording with the contiguity rule (§13).
5. **Sign-in.** Chrome UA on `persist:youtube`, the allowlist, graceful
   fallback, the FAQ disclosure (§9).
6. **Updates + other platforms.** electron-updater on the pre-release channel;
   Windows Trusted Signing; Linux AppImage (§14).
7. **Later.** CoreML backend in a utility process (§16); Bounce (§13).

**Rationale.** Step 1 before step 2 even though step 2 is the more serious
work: the refactor is worth doing only if the spike passes, and the spike
costs days.

**Rejected.** The seam first — the serious work done before the cheap
experiment that decides whether it is needed.

**Issue filing.** The spike is the first issue on the new `stem-workbench`
repository (to be created by the owner; `docs/agents/issue-tracker.md`
conventions are per-repository). The step-2 refactor is filed as issues in
`stem-splitter-live`.

**Open.** —
