---
status: accepted
date: 2026-08-24
---

# The desktop app is a separate product that vendors the engine

We want a desktop app that installs without developer mode, takes local files as
well as captured audio, and exports stems to disk from every source. Export from
a captured YouTube stream is the one thing the extension is built and documented
not to do, so the desktop app is a separate product — its own name, repository
and documents — that vendors the engine and the deck out of this repository by
pinned tag and SHA-256, the discipline `tools/fetch-vendor.sh` already applies
to ONNX Runtime. Both sit behind a Host seam that is built here, under the
extension, first. The extension's identity does not change.

## Context

- `stem-splitter-live` is a Chrome MV3 extension. Its identity is stated in the
  same terms in `FAQ.md` ("Is this a piracy tool?"), `PRIVACY.md` ("What the
  extension deliberately does not do") and `CONTRIBUTING.md` rule L1: it captures
  only what the user's own player renders, through `chrome.tabCapture`, and is
  structured so it cannot produce a user-accessible file from captured audio.
  The property is enforced by the platform — the manifest requests no
  `downloads` permission — and asserted by `tools/tree-check.mjs` ("no downloads
  permission — nothing in this build writes a file"), which
  `node tools/verify.mjs --quick` runs on every push and pull request
  (`.github/workflows/verify.yml`). `NOTICE.md` carries the other half of the
  trust story: the `htdemucs_6s` weights are CC BY-NC 4.0, so the project is
  free and structured to stay free. `docs/ARCHITECTURE.md`'s appendix records
  that offline export was built and cut.
- The extension has not been submitted to the Chrome Web Store. The install path
  is `chrome://extensions` → Developer mode → Load unpacked (`README.md`,
  `CONTRIBUTING.md`), which limits adoption to people willing to do that.
- We want a desktop app that (a) a non-developer can install, (b) adds local
  audio files as a source, (c) exports stems to disk from every source,
  including captured YouTube audio, and (d) is built so the WebGPU/WASM ONNX
  Runtime worker can later be swapped for native inference.
- (c) contradicts L1 and every document that states it. Exporting audio derived
  from a YouTube stream is a download under YouTube's terms, and it puts the
  artifact in the category of tool that has drawn takedown requests against
  repositories (youtube-dl, October 2020). That exposure should not attach to
  the extension, its documents or its issue tracker.
- Chrome loads the unpacked `extension/` directory and cannot import a module
  from outside it, so any code shared with another product has to be copied in.
  `tools/fetch-vendor.sh` already does this for ONNX Runtime Web: fetch a pinned
  version (`V=1.27.0`) from npm, copy the needed files into
  `extension/vendor/ort/`, verify each against a recorded SHA-256, fail on
  mismatch. The output is gitignored and CI caches it on the hash of the script.
- "The engine" is `docs/ARCHITECTURE.md`'s engine: the whole offscreen audio
  pipeline — the `AudioContext`, the capture ring and worklets, the decks, the
  live pipeline, the master bus, the inference worker (§1 "THE ENGINE"; §4
  "The engine is authoritative for everything audible"). The ten files in
  `extension/engine/` (~7.6k lines) are its DSP modules — §6's "engine
  modules". Those are already separable: no browser API in them (`live.js`:
  "pure arithmetic, no browser APIs"); `pitch.js`, `pitchbank.js`, `chroma.js`,
  `keytap.js` and `bpmtap.js` run their own `selfCheck()` under plain `node`,
  and `tools/verify.mjs` runs them as suites; their only import from outside
  the directory is `extension/shared/config.js` — the constants (`SR`,
  `SEGMENT`, `STEMS`, the ring sizes) and the model pin — and
  `docs/SIX-STEM-CONTRACT.md` fixes the stem order those constants encode. Of
  `verify.mjs`'s twenty suites only `embed-smoke` launches a browser; by
  assertion count, about 89% of what `verify.mjs` checks runs in plain Node.
- The rest of the engine is nearly as separable. Its whole `chrome.*` surface
  is `chrome.runtime` (`offscreen.js`'s header: "its entire chrome.* surface
  is runtime.{connect,getURL,id,onConnect,onMessage,sendMessage}"): messaging
  in `offscreen.js`, and `getURL` for the worklet modules and the ORT bundle
  in `offscreen.js`, `deck.js`, `master.js`, `live.js` and `cacheddeck.js`.
  The one other platform-bound call is `getUserMedia` with the `tabCapture`
  stream id (`offscreen.js`, `captureStart`). The deck
  (`extension/ui/embed*.js`) is the same shape: an extension page that touches
  `chrome.*` for `prefs` in `chrome.storage.local`, the arm-error record in
  `chrome.storage.session`, and `chrome.runtime` messaging to the engine and
  the service worker; its shortcut list is authored into `embed.html`, and the
  arm chord is read from `chrome.commands` by `welcome.js`, not by the deck.
  Everything it needs from the page's `<video>` — `paused`, `currentTime`,
  `duration` to read; `muted`, `currentTime`, `playbackRate` to set — already
  crosses a `postMessage` boundary owned by `content.js`, `autonav.js` and
  `speed.js`.
- There are no version tags in this repository today.
- This is a one-person project. Every additional repository and publish step has
  a real cost.

## Decision

1. The desktop app is a separate product with its own name (working codename:
   `stem-workbench`), its own repository, its own trust story, and its own
   `NOTICE`, `FAQ` and `PRIVACY` written for what it actually does. It is not a
   variant of the `stem-splitter-live` brand.
2. The extension's identity is unchanged. L1 stays, the `downloads` assertion
   in `tools/tree-check.mjs` stays, and its documents remain true. This
   decision changes its code in one way, the seam of decision 5.
3. The vendored unit is the engine and the deck. "Engine" is
   `docs/ARCHITECTURE.md`'s: the whole offscreen audio pipeline — the DSP
   modules in `extension/engine/`, the audio graph in `extension/offscreen/`
   (`deck.js`, `live.js`, `master.js`, `cacheddeck.js`, the worklet
   processors), `extension/shared/` and `extension/workers/` —
   `inference.worker.js` and, since S6 (#8), `workerbackend.js`, the unit's own
   implementation of the inference backend the Host hands over. Both worker
   files are named here rather than left to a crawl because neither is reachable
   by import from the unit's entry point: `inference.worker.js` is reached by
   `new URL(..., import.meta.url)`, and `workerbackend.js` only by
   `offscreen/host.js`, which is a declared Host hole.
   The deck is `extension/ui/embed*.js`. Everything that is not bound to
   `chrome.*` goes. The unit stays in this repository, gets a declared entry
   point and version tags, and the desktop repository vendors it by pinned tag
   plus SHA-256, with the same discipline `tools/fetch-vendor.sh` applies to
   ONNX Runtime. No npm publish.
4. The unit sits behind a Host seam. A Host supplies what the engine and the
   deck cannot obtain themselves: a Source's media stream (the capture grant),
   storage get/set, messaging send/onMessage, the arm shortcut (the deck reads
   the chord from the Host rather than authoring it into its markup), asset
   URLs (`getURL`), a transport — the player's `paused`, `currentTime` and
   `duration` to read and `muted`, `currentTime` and `playbackRate` to set,
   which `content.js`, `autonav.js` and `speed.js` do today against YouTube's
   `<video>` — and, later, an inference backend (the native-inference seam).
   There is exactly one Host per product, and the engine and the deck must not
   know which one they run under. The extension host is what stays behind:
   `sw/`, `content.js`, `autonav.js`, `speed.js`, `ui/welcome*`,
   `manifest.json`, and the `chrome.runtime` and `getUserMedia` half of
   `offscreen.js`. The desktop host adds its own: the Electron main process,
   the preloads, the `WebContentsView`.
5. The seam is built here first, before the desktop repository exists:
   `extension/offscreen/offscreen.js` is split into host-agnostic
   orchestration and a thin extension host (the `chrome.runtime` messaging,
   the `tabCapture` `getUserMedia` call), and the deck's `chrome.*`
   touch-points — `prefs` in `chrome.storage.local`, the arm-error record in
   `chrome.storage.session`, `chrome.runtime` messaging, the chord — are
   routed through the same seam. The existing gates (`tools/verify.mjs`,
   `tools/embed-smoke.mjs`) prove the seam under the existing host; that is
   the tracer bullet, and it needs no second host to run.
6. Extracting the unit into its own repository or package is deferred until
   its release cadence diverges from the extension's. That friction is the
   trigger, and it has not happened.

## Amendments — what building it changed (S1–S11, issues #2–#12)

An ADR records the decision that was taken, so the decisions above are left as
they were written. These are the places where the implementation is not what
that wording describes, and what it is instead. Every one of them is a
correction of FACT, not a reversal: no decision above was overturned.

**A1 — there is no `offscreen.js`.** Decision 5 says
`extension/offscreen/offscreen.js` "is split into host-agnostic orchestration
and a thin extension host". It was, in S1 (#2), and the file ceased to exist in
the same commit: the orchestration is `extension/offscreen/engine.js` and the
Chrome half is `extension/offscreen/host.js`. Decision 4 and the Context section
cite the old name six more times; read them as those two files.
`docs/ARCHITECTURE.md` §1 has the current picture.

**A2 — the unit's public surface is declared, and this is where.** Consequences
names it as a cost ("must be declared and kept stable"). It is now three
artifacts: `extension/unit.json` — which file is on which side of the seam, with
the argument for each — `extension/shared/host.js` — the interfaces, their duty
tables and the boot-time `assertHost()` — and `extension/unit.sha256`, one
SHA-256 per unit file in `shasum -c` format. `tools/unit-check.mjs` gates all
three on every run, and `docs/VENDORING.md` is the procedure a second product
follows, dry-run from an empty directory before it was published. The worry in
the same sentence about `extension/shared/config.js` was answered in S7 (#5): the
model's URL moved out of the unit into `offscreen/host-pin.js`, so what the unit
keeps is the model's IDENTITY (the SHA-256 and the byte count) and never its
origin.

**A3 — Host interface v1 is frozen at `v0.2.0`,** and decision 6 stands
unchanged: one repository, one tag series, no npm publish, no extraction. What
"frozen" means here is weaker than the word usually is and is written out at the
top of `extension/shared/host.js`, along with the four Chrome-shaped assumptions
that were taken off the wire at the freeze and the two limitations that were
named rather than closed.

**A4 — decision 4's READ side is narrower than what ships, and the code is not
what is wrong.** It words the transport's read side as `paused`, `currentTime`
and `duration`; `extension/content.js` has read five since before the seam
existed — those three plus `ended` and `playbackRate`, with `seeking` arriving as
an event rather than a poll — and the deck reads all five. Every one of them is
transport state and none of them is media: no `src`, no `currentSrc`, no
`buffered`, no `srcObject`, no `captureStream()`. So L1's rule holds and this
wording does not, and the same is true of the sentence in `CONTRIBUTING.md` that
L1 is stated in. **Correcting it is the owner's, not a seam slice's:**
`CONTRIBUTING.md` outranks every other document here, narrowing the payload would
break the deck, and a rule promoted to a security property by `SECURITY.md` is
not one an implementer restates on its own authority. Flagged in S11 (#12) and
left open deliberately. The WRITE side — `muted`, `currentTime`, `playbackRate`
— is exact, closed, and enforced at both ends.

## Consequences

Positive:

- Every document in this repository stays true.
- Legal and takedown blast radius is confined to the artifact that takes the
  risk.
- The Host seam is forced into existence under the existing host, with the
  existing gates, before a second host exists — and an inference backend is
  one of the things a Host supplies, so the native-inference plan lands on the
  same seam.
- One deck. A deck change ships to both products; so does an engine fix.
- Issue trackers and triage labels stay separate for products with different
  trust postures. `docs/agents/issue-tracker.md` and
  `docs/agents/triage-labels.md` are per-repository, so nothing about them
  changes here.

Negative:

- Two products to keep green.
- The unit's public surface — its entry point and the Host interface — must be
  declared and kept stable, including what it needs from
  `extension/shared/config.js`, which today is the whole extension's constants
  file.
- An engine or deck fix reaches the desktop app only through a new tag here
  and a pin bump there.
- The extension pays for the refactor: `offscreen.js` and the deck's `chrome.*`
  touch-points are reworked in this repository, on the most tuned real-time
  code in the project, for a product that does not exist yet.
- The desktop product carries the export and terms-of-service exposure alone,
  and needs its own documents written from scratch. It inherits the CC BY-NC
  weights constraint from `NOTICE.md` unchanged: it is non-commercial too, and
  its `NOTICE` has to say so.
- The deck is shared: its `chrome.*` touch-points go through the Host seam, a
  deck change ships to both products, and every deck change is tested under two
  hosts. Because the deck must not know which Host it runs under, a control one
  product has and the other does not — export — reaches it through the Host,
  not through a branch in `embed.js`.

## Considered Options

- **Same product, identity changes ("stem-splitter-live exports").** Rewrites
  `NOTICE.md`, `FAQ.md`, `PRIVACY.md` and `CONTRIBUTING.md`, deletes L1, spends
  the extension's existing trust position, and makes any future store submission
  the thing reviewers are primed to reject. Rejected.
- **Source-dependent export: file sources may export, live sources never,
  enforced by separate renderer processes and preloads.** Coherent, and would
  have kept L1 sharp. Rejected by the product owner: export from every source is
  a requirement.
- **Same repository, `apps/desktop/` next to `extension/`.** One CI and one
  `verify` run. But a takedown against the export-capable app takes the
  extension, its documents and its tracker down with it, and forces one issue
  tracker onto two trust postures. Rejected.
- **Vendor only the DSP modules (`extension/engine/`) and re-implement the
  audio graph in the desktop app.** The smallest unit and the cleanest boundary
  on paper: ten files, no browser API, already gated in plain Node. But the
  audio graph — the capture ring, `deck.js`, `live.js`, `master.js`, the
  worklets — is the most tuned real-time code in the project, and a second
  copy drifts the moment it exists. Rejected.
- **The unit as its own repository or npm package now.** Cleaner long-term. But
  it is a third repository and a publish step for a one-person project with no
  demonstrated cadence divergence. Deferred (decision 6), not rejected.
