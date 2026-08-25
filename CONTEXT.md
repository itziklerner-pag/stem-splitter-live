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
URLs.
_Avoid_: platform, shell, wrapper, container, app

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
- Anything derived from a **Live source** — a stem, a cache, an export in a
  product that allows one — is bound by real time: the player has to play
  through.
- A **File source** is available whole, up front, so separation runs at engine
  speed rather than playback speed.
- **L1** admits exactly one Source: a **Live source** through
  `chrome.tabCapture`. This repository implements no **File source** and no
  export; both exist only in the separate desktop product
  (`docs/adr/0001-desktop-app-is-a-separate-product.md`).
- There is exactly one **Host** per product: the extension host here, the
  desktop host there. The **engine** and the **deck** must not know which
  **Host** they run under.
- A **Source** is always obtained through the **Host**.

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
- **`source` in code** (`extension/offscreen/offscreen.js`, `deck.js`) is the
  captured tab's `{url, title}` — *which* **Live source** is attached, not
  which kind of **Source**. Resolved: read it as the Live source's identity;
  do not rename it on the strength of this glossary.
