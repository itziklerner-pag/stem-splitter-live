# FAQ

Jump to the awkward ones: [is this piracy?](#is-this-a-piracy-tool) ·
[is it really MIT?](#is-it-really-mit-if-the-model-isnt) ·
[can I use it commercially?](#can-i-use-this-commercially) ·
[what if the model host disappears?](#what-happens-if-the-model-host-disappears)

---

## Using it

### Why is it a few seconds behind the video?

Because the model can only separate sound it has already heard.

To decide what is a vocal, the network needs context — 7.8 seconds of it. It
runs on the audio that has already played, then emits the most recent slice. At
the default setting the deck runs about **3.4 seconds behind the picture**, and
further on a slower machine. The readout shows exactly how far, measured rather
than predicted.

This is not a bug queued for a later release. A version with no delay would be a
version that can see the future. What you *can* do is pick a shorter hop if your
machine is fast enough — the deck offers the choice and tells you when it cannot
keep up.

### What about a file? Is it just as far behind?

No — and the reason is the same one as above, which is exactly why the two paths
run different windows.

The delay exists because the model can only separate sound it has already
heard, so a **live capture** (a tab, a microphone) must run a *causal* window
that only ever looks back. A **file** cannot be captured, but it also cannot
disappear: the model may look at any part of it in any order, because the whole
of it is already there. The ahead-of-time path uses that freedom — it runs the
*symmetric* window, advancing by a fixed stride and crossfading the overlaps, so
there is no "behind" at all and nothing needs to be predicted. The live delay is
not a limitation carried over to files; it is the price of not seeing the
future, and a file can always see the future.

### Why does the first few seconds of a track sound rough?

For roughly the first 8 seconds the model has no history to work with — its
context window is still filling with silence. Separation quality ramps over that
window, and the deck shows the progress. Skip back a few seconds and it will
sound noticeably better on the second pass.

### Why YouTube only?

That is where the content permission model is simplest and where the deck's
placement is predictable. The extension declares `youtube.com` and nothing else,
which is also what lets it make a narrow, honest permission request.

Other sites are technically possible — the engine has nothing YouTube-specific
in it — but each one needs its own player integration and its own permission.
If you want a specific site, open a Discussion; that is genuinely how it will
get prioritised.

### Why can't I pick which tab to capture?

Because Chrome will not let us build that, however we build it.

`chrome.tabCapture` grants are per-tab, and only a *browser-level* invocation on
that specific tab mints one — a toolbar click, a context-menu item, or a keyboard
shortcut. A list rendered inside our own page is not a browser-level invocation,
so a picker could not grant capture even if we drew one. This is the platform,
not a design preference.

### Why did my tab go silent?

Holding the capture stream *is* the tab mute — that is how `chrome.tabCapture`
works. While the deck is armed, the deck is your audio output; the page's own
audio is routed through it.

If a tab is left silent *after* you disarm the deck, that is a bug and we want
the report. Reloading the tab always recovers it.

### Will it run on my machine?

You need Chrome 128+ and, realistically, a GPU with WebGPU. The reference
figures come from an Apple M2 Max, where the model runs at roughly 0.45×
real-time at the default hop.

ONNX Runtime falls back to threaded WASM automatically if WebGPU is
unavailable. It works, but it blocks for seconds at a time and is not a pleasant
experience. If the deck cannot keep up it says so rather than glitching quietly.

### Why Chrome and not Firefox or Safari?

The extension needs four things together: Manifest V3 offscreen documents,
`chrome.tabCapture`, `SharedArrayBuffer`, and WebGPU. As of now that
combination exists in Chrome and Chromium-based browsers (Edge, Brave, Arc)
and nowhere else. It is not a preference; the other browsers do not currently
have the APIs.

Chromium forks generally work. We test on Chrome.

### Does it phone home?

No. It makes exactly one network request in its lifetime — downloading the model
once — and never contacts the network again.

You do not have to take our word for it. Open the Network tab, or just turn off
Wi-Fi and use it. [`PRIVACY.md`](PRIVACY.md) has the details.

### Why six stems and not four?

Because `htdemucs_6s` separates guitar and piano out of the "other" bucket, and
those are the two most useful extra stems for anyone learning a part.

A pleasant surprise: the six-stem model is a **smaller** download than the
four-stem one — 109 MB against 172 MB — because it drops the 512-channel
transformer bottleneck. It has 27.4 M parameters against 41.9 M.

### Can I export the stems as files?

No, and this is deliberate rather than unimplemented. See below.

If you have arrived here from another product built on this engine, two words in
it mean different things and it is worth knowing which you want. An **Export** is
the six untouched model outputs at unity, one file per stem, for a DAW. A
**Bounce** is one file: the deck as you heard it, with its faders, mute/solo,
crossfader and transpose baked in. Never call either of them "the mix". A bounce
does **not** bake the playback speed — a bounce at a different speed is
time-stretching, not baking, and it is not the same feature
([`docs/AUDIO.md`](docs/AUDIO.md) §4.6 has the reasoning). This extension writes
no files of either kind.

---

## The awkward ones

### Is this a piracy tool?

No, and the architecture is the argument rather than the promise.

Stem Splitter Live separates audio **that your own browser is already playing**,
through the same API a screen recorder uses, and plays the result back through
your speakers. It has no capacity to obtain, store, or hand you a media file.

Concretely:

- Audio comes from `chrome.tabCapture` and nothing else. There is no
  stream-URL resolution, no `yt-dlp`, no innertube, no `/videoplayback`, no
  player-response scraping.
- The content script reads exactly three values off the page's `<video>`
  element — `paused`, `currentTime`, `duration`. That is transport state, not
  media. It never reads `src`, `currentSrc`, `buffered` or `srcObject`, never
  calls `captureStream()`, and never runs in the page's JavaScript context.
- **The extension cannot save a file.** It does not request the `downloads`
  permission, and an automated gate asserts its continued absence on every
  commit.

A content script on a video page is exactly where a ripper *would* live, which
is why the boundary is stated in terms of what the code does rather than as a
slogan. It is a project rule — no pull request may cross it, however well it
works — and it is why offline export was built, and then cut.

### Is it really MIT if the model isn't?

The repository's own code is MIT. The model weights are separately licensed and
we never claim otherwise.

`htdemucs_6s` is Meta's. The Demucs *code* is MIT; the *pretrained weights* are
CC BY-NC 4.0 — non-commercial — because they were trained partly on a proprietary
dataset. **Nobody can relicense them, including us.** So:

- Our MIT grant covers our source. It grants you nothing about the weights.
- We do not redistribute the weights. The extension downloads them at runtime
  from a pinned, hash-verified upstream revision. This repository has never
  contained them.
- Every public surface says so, including the badge at the top of the README.

We could have quietly said "MIT" and let people assume. Publishing a licence
claim you cannot support is a worse problem than the constraint itself.

### Can I use this commercially?

**No** — and neither can we, which is why the project is structured the way it
is.

Non-commercial weights mean **Stem Splitter Live is free and will stay free.**
There is no paid tier, no licence key, no donation-gated feature, and no plan
for one.

If you want to build something commercial, our MIT code is yours; the separator
is not. You would need weights you are allowed to use commercially — train your
own, or use a permissively-licensed model. The engine is not especially coupled
to Demucs, so that is a real option rather than a brush-off.

If you are a rights holder or a lawyer and you think we have got this wrong in
either direction, please open an issue. We would rather be corrected than be
confidently wrong in public.

### What happens if the model host disappears?

New installs break. Existing installs keep working from their cached copy.

This is a real single point of failure and we would rather name it than have you
discover it. The weights are pinned by commit SHA to a third-party ONNX
re-export on Hugging Face. Pinning by SHA means the bytes cannot change under us
— the hash check would catch it — but it does not mean they cannot be *deleted*.

If that happens, the fix is a one-line pin change plus a release: the URL
lives in `extension/offscreen/host-pin.js` (fetching the bytes is the Host's
job), and if the replacement bytes are not identical, the SHA-256 and byte count
in `extension/shared/config.js` change with it (deciding whether the bytes are
the model is the unit's job). Watching for it is on us.

### Are you going to add a download button / offline export / a second deck?

No to the first. An offline export mode and a two-deck DJ console were both
built and both cut — `docs/ARCHITECTURE.md`'s appendix records what went and
why, so a re-proposal starts from that rather than from scratch.

Export specifically is not coming back, because writing a separated copy of
somebody's track to disk is the thing this project exists not to do.

---

## Contributing

### I found a bug. What do you need?

The deck's **latency readout** and your **Chrome version + GPU**. Those two
turn most audio reports from unreproducible into obvious. The issue template
asks for both.

### Can I contribute?

Yes. [`CONTRIBUTING.md`](CONTRIBUTING.md) is the short version; the three rules
that override everything are at the top of it. If you are writing a test, read
[`AGENTS.md`](AGENTS.md) first — it is a record of assertions that could not
fail and what each one cost to find out.

There is no CLA. Sign your commits off with `git commit -s` (DCO) and open the
PR.

### Why is there an AGENTS.md?

Because the discipline in it applies to anyone writing assertions here, human or
otherwise, and because coding agents work in this repository and need the same
rules stated where they will read them.

It is also, unexpectedly, the file people find most useful. It is not about AI;
it is about the fact that a broken assertion and a broken program look identical
from the outside.
