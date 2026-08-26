# Stem Splitter Live

The language of one product: a Chrome extension that captures what the user's
own YouTube tab is already playing, separates it into six stems on-device, and
mixes them back live through a deck drawn into the page. Single context — one
`CONTEXT.md`, one `docs/adr/`, both at the root (`docs/agents/domain.md`).

## Language

### Sources

**Source**:
Where the audio the engine separates comes from.
_Avoid_: input, feed, media, origin, stream (a `MediaStream` is a conduit, not a Source)

**Live source**:
A **Source** captured, as it plays, from a player the app does not own the
bytes of — today a YouTube tab, through `chrome.tabCapture`.
_Avoid_: tab source, capture source, stream source, YouTube source (YouTube is
today's instance, not the kind)

**File source**:
A **Source** the user handed the app as a file, so the whole signal exists
before separation starts.
_Avoid_: local source, offline source, upload, import

### Hosts

**Host**:
The part of a product that wraps the **engine** and the **deck** and supplies
what they cannot obtain themselves — a **Source**'s stream, a transport (play,
pause, seek and rate on the player), storage, messaging, the shortcut, asset
URLs, the model's bytes, and an inference **backend**.
_Avoid_: platform, shell, wrapper, container, app

**Unit**:
The **engine** and the **deck** together, as the thing a second product copies:
what `extension/unit.json` declares, `extension/unit.sha256` fixes byte for
byte, and `node tools/verify.mjs --unit` runs. Not a synonym for the engine —
the deck's markup and stylesheets are in it, and the two **Host** modules are
not.
_Avoid_: core, library, package, SDK, module (it is not published and is not
one file)

**Hole**:
A module the **unit** imports and a **Host** supplies —
`extension/offscreen/host.js` for the `EngineHost`, `extension/ui/host.js` for
the `DeckHost`. Exactly one per context, because `embed.html`'s
`script-src 'self'` forbids an inline `boot(host)` and the deck's markup is part
of the unit, so a static `import` from a sibling module is the only route a Host
object has.
_Avoid_: adapter, shim, plugin, injection point

**Duty**:
One thing a **Host** owes the **unit**, named for what it is FOR rather than for
its type. The duty tables in `extension/shared/host.js` are the list, the
sentence beside each one is what `assertHost()` puts in the refusal, and a
**Host** short a duty is refused at boot rather than at the user's gesture.
_Avoid_: method, API, capability, hook (`hooks` is a different thing on
`createBackend`, and it belongs to the unit)

**Backend**:
What separates one segment of mix into six **stems** — waveforms in, waveforms
out, with the STFT and the model graph inside it. A **duty** the **Host**
supplies (`createBackend`); today the only implementation is the unit's own
`extension/workers/workerbackend.js`, driving ONNX Runtime in a Worker.
_Avoid_: model, engine (the **engine** is the whole pipeline), inference server,
runtime

### Deliverables

**Transcription**:
A description of what was played — note number, onset, duration, velocity —
derived from **stems** and carrying none of their audio. The one artifact this
product hands the user: a MIDI pack. A reader performs it on its own
synthesiser, so it sounds like that synthesiser and never like the recording.
_Avoid_: export, bounce, render, rip, copy (a **Copy** is the other thing
entirely, and this glossary keeps them apart on purpose)

**Copy**:
Audio that **reproduces** a **Source** — samples, in any container, at any bit
depth, however derived. This product makes none, and the whole reconciliation in
[ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md)
rests on this one word: the property was narrowed from *"cannot produce a
user-accessible file from captured audio"* to *"cannot produce a user-accessible
file that **reproduces** the captured audio"*. A **Transcription** is derived
from captured audio and is not a **Copy** of it, so "derived from" is not a
synonym for "reproduces" here and must not be written as one. The distinction is
enforced by an allowlist (`extension/shared/midi.js`) and gated by
`qa/midi-pack.mjs`, not by a permission.
_Avoid_: export, download, dump, rip (each of those hides which of the two is
meant)

### Fixed elsewhere

Where these documents define a term, their definition wins; this file points
and does not restate (`docs/agents/domain.md`).

- **Stem** — the six-stem set, its wire order (`STEMS`) and its display order:
  `docs/SIX-STEM-CONTRACT.md`.
- **Engine**, **deck**, the four contexts, **arming** and the capture grant,
  the capture ring, **passthrough**: `docs/ARCHITECTURE.md` §0–§1, §3, §5.
  **Engine** is ARCHITECTURE.md's whole offscreen audio pipeline; the files in
  `extension/engine/` are its DSP modules — "engine modules", §6.
- **Hop** (`H`), left/right context, crossfade, the live presets, **lane**,
  the latency budget: `docs/AUDIO.md` §2.2–§2.3, §1.6, §7.
- **L1** (capture only what the user's own player renders), **P1** (no network
  after the model download), **M1** (no remote code): `CONTRIBUTING.md`, "The
  three rules that override everything".

## Relationships

- A **Source** is exactly one of **Live source** or **File source**.
- The **engine** is **Source**-agnostic: a Source decides *when* audio
  arrives, never what the engine does with it.
- A **Live source** arrives in real time, as the player plays. The **deck**
  therefore runs behind the picture — about 3.4 s at the default **hop**
  (`FAQ.md`, "Why is it a few seconds behind the video?").
- Anything derived from a **Live source** — a stem, a cache, a
  **Transcription**, a **Copy** in a product that allows one — is bound by real
  time: the player has to play through.
- A **File source** is available whole, up front, so separation runs at engine
  speed rather than playback speed.
- **L1** admits exactly one Source: a **Live source** through
  `chrome.tabCapture`. This repository implements no **File source** and no
  **Copy**: both exist only in the separate desktop product
  (`docs/adr/0001-desktop-app-is-a-separate-product.md`). It does deliver one
  artifact — a **Transcription**, as a MIDI pack — which is why ADR 0002
  supersedes ADR 0001 decision 2 and narrows the property those documents
  jointly stated.
- A **Transcription** is bound by real time exactly as a stem is: it is written
  off the live stem ring as the player plays. Transcribing by bulk-reading the
  stem cache would be faster and would falsify "the player has to play through",
  so it is prohibited rather than merely unimplemented.
- There is exactly one **Host** per product: the extension host here, the
  desktop host there. The **engine** and the **deck** must not know which
  **Host** they run under.
- A **Source** is always obtained through the **Host**.
- The **unit** reaches its **Host** only through the two **holes**, and asks of
  it only what a **duty** names. `tools/unit-check.mjs` is what holds that to
  the tree: it crawls the unit from its entry points, stops at the holes, and
  goes red on a reference that leaves the closure any other way.
- Not everything a **Host** owes is a **duty**. Four messages it must
  ORIGINATE, the autoplay-next preference key it must watch, and the
  cross-origin isolation the **engine**'s `SharedArrayBuffer`s need are all
  obligations no `assertHost()` can check — they are declared in
  `extension/shared/host.js` and listed in `docs/VENDORING.md` instead.

## Example dialogue

> **Dev:** "If I add an 'open a WAV' button to the deck, is that a second
> **Live source**?"
> **Domain expert:** "No — a WAV is a **File source**: the whole signal is on
> disk before we start, so separation runs at engine speed. And it is not this
> product. **L1** admits one Source, a **Live source** through
> `chrome.tabCapture`; File sources live in the desktop product (ADR 0001)."
> **Dev:** "Then does the **engine** know which kind it is being fed?"
> **Domain expert:** "It must not. The engine is Source-agnostic; the Source
> only decides *when* audio arrives. From a Live source it arrives as the
> player plays, so everything downstream — the **deck** 3.4 s behind the
> picture, a stem cache, an export in a product that has one — waits on real
> time. A File source removes the wait, not the model."
> **Dev:** "So 'export at engine speed from YouTube' —"
> **Domain expert:** "— is a contradiction. The player has to play through."

## Flagged ambiguities

- **"engine"** was used at two sizes. `docs/ARCHITECTURE.md` labels the whole
  offscreen document "THE ENGINE" (§1 diagram; §4 "The engine is authoritative
  for everything audible") and `README.md` says the same, while §6 calls the
  files in `extension/engine/` "engine modules" and ADR 0001 once used "the
  engine" for that directory alone. Resolved: "engine" is ARCHITECTURE.md's —
  the whole offscreen audio pipeline; `extension/engine/` holds its DSP
  modules, "engine modules" when the size matters. The unit the desktop
  product vendors is the engine and the **deck**, behind the **Host** seam
  (ADR 0001).
- **"source" vs "sources".** Demucs calls the separated signals *sources*
  (`model.sources`; `VERIFIED_SOURCES` in `tools/model-parity.mjs`;
  "six-source variant" in `NOTICE.md`; the testbed's "six sources"). In this
  glossary a **Source** is where audio comes *from*; the separated signals are
  **stems**. Resolved: "stem" in prose; "sources" only when quoting model
  metadata or the ground-truth multitrack.
- **`source` in code** (`extension/offscreen/engine.js`, `deck.js`) is the
  attached **Live source**'s `{title, url}` — *which* Live source is attached,
  not which kind of **Source**. Resolved: read it as the Live source's identity;
  do not rename it on the strength of this glossary. It carried a `tabId` until
  Host interface v1 (S11) removed it: nothing in the unit read it, and a **Host**
  with no tabs had to invent one. `extension/offscreen/offscreen.js`, which the
  first version of this entry cited, has not existed since S1 — the file is
  `extension/offscreen/engine.js`.

- **"host" is two words in one.** The **Host** of this glossary is the part of a
  product that wraps the unit. `host` in `extension/content.js` and
  `extension/ui/host.js` — `'stem-splitter-live-host'`, "host → deck" — is the
  PAGE the deck is drawn into, which is one duty namespace (`DeckHost.page`) of
  the Host and not the Host. Resolved: capital-H **Host** in prose for the
  product's half; where the page is meant, say "the page".
