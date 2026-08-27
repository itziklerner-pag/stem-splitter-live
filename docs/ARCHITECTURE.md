# Stem Splitter Live — architecture

One Chrome MV3 extension. It captures the audio the user's own YouTube tab is
already playing, separates it into six stems on-device, and plays the result
back through a deck drawn *into that page*.

Read `docs/AUDIO.md` for the DSP and the numbers, `docs/SIX-STEM-CONTRACT.md`
for the stem set and its ordering, `CONTRIBUTING.md` for the rules that govern edits.

---

## 0. The four decisions everything else follows from

| | decision | consequence |
|---|---|---|
| **1** | **Audio comes from `chrome.tabCapture` and nothing else.** | No URL resolution, no stream parsing, no downloader. This is `CONTRIBUTING.md` L1 and it is not a performance trade — it is what makes this an audio tool rather than a ripper. |
| **2** | **One deck.** | There is no deck B, no crossfader surface, no tab picker. A `tabCapture` grant is per-tab and only a browser-level invocation *on that tab* mints one, so arming is a toolbar click or `Ctrl+Shift+9`, and it always points the one deck at the tab it was performed in. |
| **3** | **The page is the surface.** | No side panel, no popup. A content script injects an iframe into the YouTube watch page, between the player and the title. The user never leaves the video they are listening to. |
| **4** | **One `AudioContext` at 44 100 Hz — the model's native rate — and no JS resampling anywhere.** | Chrome converts the 48 k tab stream on the way in and the 44.1 k bus on the way to the device, both inside its own media pipeline. Capture worklet, segmenter, overlap-add and player all share one integer sample clock at the model's rate. `docs/AUDIO.md` §1 carries the 1000.00 Hz round-trip measurement. |

**Nothing goes to the network after the model downloads.** One request, to a
pinned and hashed upstream host, cached thereafter. No telemetry, no fonts, no
CDN. `CONTRIBUTING.md` P1 states it as an acceptance test.

---

## 1. The four contexts, and why each exists

MV3 gives us four execution contexts and they are not interchangeable. Almost
every structural oddity below is a consequence of which context is allowed to do
what.

```
                  ┌──────────────────────────────────────────┐
   toolbar click  │  sw/service-worker.js   (service worker)  │
   Ctrl+Shift+9 ──▶  the ONLY context that can mint a         │
                  │  capture token. Killed at 30 s idle;      │
                  │  rehydrates from chrome.storage.          │
                  └───────┬──────────────────────┬────────────┘
        CAPTURE_START      │                     │ STEM_SPLITTER_LIVE_EMBED
        {sourceToken}      ▼                     ▼
   ┌──────────────────────────────────┐   ┌─────────────────────────────┐
   │ offscreen/offscreen.html         │   │ content.js  (content script)│
   │ THE ENGINE. Holds the            │   │ Injects the iframe into the │
   │ AudioContext, the capture ring,  │   │ watch page, owns the page's │
   │ the ORT session, the worklets.   │   │ <video>, relays by          │
   │ The only context with            │   │ postMessage.                │
   │ getUserMedia + workers + SAB.    │   └──────────┬──────────────────┘
   │                                  │              │ postMessage
   │   offscreen/engine.js   UNIT     │              ▼
   │   ────────────────────           │   ┌─────────────────────────────┐
   │   offscreen/host.js     HOLE ────┼──▶│ ui/embed.html   (the deck)  │
   └──────────────┬───────────────────┘   │ An extension page in an     │
                  │ chrome.runtime        │ iframe. Draws six stem      │
                  │  (BUS: off · ui · sw) │ strips, meters, key, tempo, │
                  └──────────────────────▶│ transpose, speed.           │
                                          │                             │
                                          │   ui/embed.js       UNIT    │
                                          │   ───────────────           │
                                          │   ui/host.js        HOLE    │
                                          └─────────────────────────────┘
```

**The dashed line inside two of those boxes is the Host seam** (ADR 0001
decision 4, built in S1–S11). Above it is the UNIT — the engine and the deck,
which must not know which Host they run under. Below it is the one module each
context imports to reach this Host: `offscreen/host.js` supplies the
`EngineHost` and `ui/host.js` the `DeckHost`. Both interfaces, their duty
tables and the boot-time `assertHost()` that refuses a Host short a duty are
declared in `extension/shared/host.js`, which is unit and names no `chrome.` at
all; `extension/unit.json` is the machine-readable map of which side each file
is on, and `node tools/unit-check.mjs` is what holds the tree to it.

**There is no `offscreen.js`.** It was one file until S1 split it: the
orchestration is `offscreen/engine.js` and the Chrome half is
`offscreen/host.js`. Older documents — ADR 0001 among them — cite the old name.

**The service worker and the setup page are Host too.** `sw/service-worker.js`
is the origin of `CAPTURE_START`, `CAPTURE_STOP` and `DECK_PREPARE`, the three
messages the unit cannot send itself; `ui/welcome*` explains how to arm THIS
product in THIS browser. Every context addresses the bus out of `BUS` in
`shared/host.js` rather than spelling `'off'` / `'ui'` / `'sw'` — one address
set, so it cannot be changed on one side only.

**Why the engine is in an offscreen document.** A service worker cannot hold an
`AudioContext`, cannot call `getUserMedia`, and dies on an idle timer. The
offscreen document is the only MV3 context that can do all three and stay alive.
It is created with `reasons: ['USER_MEDIA', 'WORKERS', 'BLOBS']` — deliberately
**not** `AUDIO_PLAYBACK`, whose reaper is a *silence* reaper and buys nothing
here; the three we declare impose no lifetime limit at all.

**Why arming lives in the service worker.** `ActiveTabPermissionGranter` issues
the per-tab capture grant only on a real browser-level invocation. A button
inside our own page is not one, however it is built. This is the platform, not a
UX preference — see §5 R4.

**Why the deck is an iframe and not injected DOM.** It is an extension page, so
it runs at the extension's origin with the extension's CSP and can talk to the
offscreen document over `chrome.runtime` directly. Injected DOM would run at
YouTube's origin, inherit YouTube's CSP, and be one stylesheet change away from
breaking.

---

## 2. Message protocol

Three hops, three transports. Every message carries `{v: 1, to, from, type}`.

**`chrome.runtime` — deck ⇄ service worker.** The deck asks for things only the
worker can do.

| type | direction | meaning |
|---|---|---|
| `SW_STATUS` | deck → sw | boot: ensure the offscreen document, send me the session |
| `SW_ENSURE_OFFSCREEN` | deck → sw | create the engine if it is not up |
| `SW_CAPTURE_START` | deck → sw | mint a stream id for the armed tab and hand it to the engine |
| `SW_DECK_PREPARE` | deck → sw | build the ORT session ahead of time — routed through the worker so it cannot be dropped on the floor before the offscreen document exists |
| `SW_DISARM` | deck → sw | forget the armed tab |
| `SW_ARM_ERROR_CLEAR` | deck → sw | dismiss a refusal, carrying the `seq` the user actually saw |
| `SESSION` | sw → deck | the armed tab, or an empty record |
| `ARM_ERROR` / `ARM_ERROR_CLEARED` | sw → deck | a refusal, and its clearance. `code` is drawn from `ARM_CODES` (`ui/audio-math.js`) — a closed set, checked on arrival since v0.3.0 |

**`chrome.runtime` — deck ⇄ engine.** The fast path: a fader move must not wait
for a chunk boundary, so these go straight to the offscreen document and are
applied inside the playback worklet.

| type | direction | meaning |
|---|---|---|
| `STATUS`, `MODEL_LOAD`, `CACHE_STATUS`, `CACHE_CLEAR` | deck → engine | lifecycle and the model cache |
| `CAPTURE_START` / `CAPTURE_STOP` | sw / deck → engine | attach or release the tab stream |
| `LIVE_START` / `LIVE_STOP` | deck → engine | run or stop the separation pipeline |
| `STEM_GAIN`, `STEM_MUTE`, `STEM_SOLO`, `MASTER_GAIN` | deck → engine | the mixer |
| `PITCH`, `SPEED`, `SET_HOP` | deck → engine | transpose, rate, chunk cadence |
| `PAGE_VIDEO` | deck → engine | what the page's `<video>` is doing |
| `DECK_PREPARE` | sw → engine | warm the ORT session |
| `STATE`, `LIVE_STATE`, `METERS`, `LIVE_ERROR`, `SPEED_STATE` | engine → deck | engine truth, ~10–20 Hz |
| `DIAG`, `TEARDOWN`, `DEV_*` | either | the debug surface — see §6 |

**`postMessage` — content script ⇄ deck**, across the iframe boundary, because
that is the only channel a page and an extension frame share. `from:
'stem-splitter-live-host'` is the page side, `from: 'stem-splitter-live'` is the deck side.

| type | direction | meaning |
|---|---|---|
| `VIDEO`, `JUMP`, `SPEED`, `AUTONAV`, `KEY` | host → deck | what the page is doing, and the user's keystrokes |
| `VDRIVE` / `VRELEASE` | deck → host | take or release control of the page's `<video>` |
| `DECK`, `HEIGHT`, `READY`, `CLOSE` | deck → host | deck state, iframe sizing, teardown |

**And one `chrome.tabs.sendMessage`:** `STEM_SPLITTER_LIVE_EMBED` from the worker to the
armed tab's content script — show or toggle the deck. It is per-tab and
fire-and-forget by construction: every tab that is not YouTube has nothing
listening.

---

## 3. Audio path

```
 YouTube tab (48 kHz)
        │  chrome.tabCapture — the ONLY source (L1)
        ▼
 capture-processor.js  ──▶  SharedArrayBuffer ring  (shared/ring.js)
   AudioWorklet, 44.1 k                │   lossless across wrap, asserted in test.js
        │                              │
        │                    offscreen/live.js — the causal chunk plan
        │                              │   re-reads 7.8 s of history per chunk
        │                              ▼
        │                    workers/inference.worker.js
        │                      ORT Web + WebGPU, htdemucs_6s
        │                              │  6 stems x 2 channels
        │                              ▼
        │                    engine/live.js — the seam crossfade
        │                              │   equal-power ramps, no lookahead
        │                              ▼
        │                    shared/stemring.js — 14 planes
        │                              ▼
        │                    engine/pitchbank.js — optional transpose,
        │                              │   drums lane deliberately unshifted
        │                              ▼
        └──────────────────▶ playback-processor.js
                                AudioWorklet: per-stem gain, mute, solo,
                                master trim, soft clip, meters
                                       │
                                       ▼
                                 the user's DAC
```

**Passthrough.** If a chunk is late the mixer falls back to the unseparated mix
at `min(resolved stem gains)` — never at unity, or a killed vocal comes back for
one hop.

**The page's `<video>` is the clock.** Live mode locks the picture to the audio
clock rather than the reverse; `ui/audio-math.js::syncCorrection` and
`audioClockAt` own that arithmetic, and `content.js` applies it.

---

## 4. State

The engine is authoritative for everything audible. The deck holds only what it
is drawing, and reconciles on every `STATE` / `LIVE_STATE`.

| where | what | lifetime |
|---|---|---|
| `chrome.storage.session` | the armed tab (`session`), the last arm refusal (`armError`) | until the browser closes |
| `chrome.storage.local` | the user's preferences — instrument, autoplay-next | forever |
| offscreen document | the AudioContext, the ring, the ORT session, all mixer state | until teardown or document death |
| deck page | render state only | until the iframe closes |
| OPFS | the cached model weights, the stem cache | forever, `unlimitedStorage` |

**A refusal is both sent and persisted.** `sendMessage` with nothing listening
rejects into a `catch`, which is correct for state chatter — the next tick
carries the same truth — and a defect for a refusal, because the user performed a
gesture and was told no, and the no was discarded because the deck had not
finished booting. The persisted record carries a `seq` so a user's dismissal
cannot delete a newer refusal that landed while their finger was moving.

---

## 5. Risk register

The constraints that will be re-discovered by anyone who does not read them.

| | risk | resolution |
|---|---|---|
| **R1** | **No remote code.** MV3 forbids it. | ORT wasm binaries and model weights are bundled or fetched **as data** and cached. Never a script tag at a CDN. |
| **R2** | **SharedArrayBuffer needs cross-origin isolation.** | The offscreen document is same-origin extension content and gets SAB without COOP/COEP headers. Verified in a real browser, not inferred. |
| **R3** | **WebGPU may be unavailable.** | ORT Web falls back to WASM automatically. Take the fallback; do not spend a day optimising it. |
| **R4** | **A capture grant needs a browser-level invocation.** | Arming is a toolbar click or a `chrome.commands` chord, both handled in the service worker. A button in our own UI cannot grant capture however it is built — this is why there is no tab picker and cannot be one. |
| **R5** | **Holding the `MediaStream` track IS the tab mute.** | Chrome mutes a tab the moment it is captured; releasing the track unmutes it. So every failing path in `captureStart` must stop the track, or the user's tab is permanently silent with no affordance to fix it. |
| **R6** | **The model is ~109 MB.** | Asked for at install time, not at the moment of first play. Pinned URL, pinned SHA-256, pinned byte count, verified before use. |

---

## 6. Building, running, testing

There is **no build step**. `extension/` is the extension: load it unpacked.

```bash
bash tools/fetch-vendor.sh    # once — the ORT wasm runtime (not in git)
bash tools/fetch-model.sh     # optional — seeds the gates so they do not fetch 109 MB
node tools/verify.mjs         # everything
node tools/verify.mjs --quick # everything that needs no browser and no weights
node tools/verify.mjs --unit  # only the suites whose subject is the vendored unit
```

`chrome://extensions` → Developer mode → **Load unpacked** → `extension/`.

**The gates**, and what each is for:

| gate | subject |
|---|---|
| `test.js` | the DSP: the chunk plan, the stem sum null test, the WAV round-trip, the FFT, the capture ring — **and** this Host's conformance to the seam, in `group('host')` |
| `extension/engine/*.js` | each engine module runs its own suite as `node engine/<x>.js` — pitch, pitchbank, chroma, keytap, bpmtap |
| `extension/ui/dev/selftest.mjs` | the deck's display laws — the fader, the meter scale, buffer health, the error families |
| `extension/{autonav,speed}.js`, `ui/embed-state.js` | the content-script decisions and pure UI state |
| `tools/seam-check.mjs` | the seam serialises: one call in flight per backend, and `dispose()` settles what it takes away |
| `tools/tree-check.mjs` | `extension/` really loads: every manifest path, every transitive import, the single-deck properties |
| `tools/unit-check.mjs` | the unit is still vendorable: the closure resolves, reaches for no `chrome.`, leaves only through a declared hole, and `unit.sha256` still describes the tree |
| `tools/name-check.mjs` | no former product name and no unpublished document is cited; both halves of every renamed IPC pair are present |
| `tools/model-parity.mjs` | the pinned weights really carry six sources, in the contract's order |
| `tools/embed-smoke.mjs` | **the one browser gate** — real Chromium, the real extension, the deck injected into a real page |

**`--unit` is the vendored unit's own plan**, built from the `suites` list in
`extension/unit.json` rather than from a list in the runner, so a suite is gated
by being declared there and by nothing else. It runs 12 of the 23 steps and
needs no browser, no weights and no `node_modules`. `node tools/unit-hash.mjs`
rewrites `extension/unit.sha256` after any change to a unit file — the gate
above is what tells you that you forgot. [`docs/VENDORING.md`](VENDORING.md) is
the procedure a second product follows, dry-run from an empty directory.

**`embed-smoke` carries more weight than a smoke test normally would**, and that
is stated rather than discovered: the console-driven live suites went with the
console they drove, so it is the only check that the engine and the surface meet
correctly in a browser.

**The `DEV_*` message handlers in `offscreen/engine.js` are the engine's debug
surface and have no in-repo caller.** They are instrumentation, not dead code — a live
audio engine that cannot be asked what it is doing is much harder to fix — but
nothing gates them, so treat them as unverified until something drives one.

---

## Appendix — what is deliberately absent

Named because each was present and was removed, and re-proposing one should
start from why it went.

- **A second deck, and the crossfader.** The engine's internals still carry a
  deck registry and the crossfader law, dormant. Removing those touches the live
  audio path and the only gate that would catch a mistake was itself part of the
  two-deck build, so they are left in place and marked rather than ripped out on
  a guess.
- **Offline export (six WAVs to Downloads).** The manifest has no `downloads`
  permission and no code path could reach it.
- **The side panel and the DJ console.** §0 decision 3.
- **A tab picker.** §5 R4 — not a UX choice.
