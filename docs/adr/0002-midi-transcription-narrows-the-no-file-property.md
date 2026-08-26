---
status: accepted
date: 2026-08-26
supersedes: 0001 decision 2
---

# MIDI transcription ships in the extension, and narrows the no-file property

The extension gains a MIDI transcription of the six stems, written live off the
stem ring as the video plays and handed over as one zip of seven `.mid` files
through a `Blob` and an `<a download>` in the deck iframe. That is a
user-accessible file made from captured audio, so **ADR 0001 decision 2 is
superseded in full** and re-taken here. Its three conjuncts — *"L1 stays"*,
*"the `downloads` assertion in `tools/tree-check.mjs` stays"* and *"its
documents remain true"* — are settled one at a time rather than as a block: the
first two survive untouched, and **the third does not.** The property those
documents state is
narrowed from *"cannot produce a user-accessible file from captured audio"* to
*"cannot produce a user-accessible file that **reproduces** the captured
audio"*, and the narrowed property is carried by a gate that can go red
(`qa/midi-pack.mjs`), not by a sentence. The rights question the narrowing
raises is **recorded here as OPEN and is not settled by this ADR.**

## Context

- **ADR 0001 decision 2 has three conjuncts and this change lands on the third.**
  Its first two sentences, which are the part this ADR touches: *"The extension's
  identity is unchanged. L1 stays, the `downloads` assertion in
  `tools/tree-check.mjs` stays, and its documents remain true."* (The third
  sentence, about the seam of decision 5, is untouched and stands.)
  L1's operative rule — *"Audio comes from `chrome.tabCapture` and nothing else.
  Never resolve, fetch, or parse a media stream URL"* — is untouched by a
  transcriber that reads the stem ring, and the `downloads` assertion is
  untouched because no permission is added. The third conjunct fails: four
  documents say the extension cannot produce a file, and after this change it
  produces one.
- **The property is held JOINTLY, not by this ADR alone.** Four documents state
  it, in four voices, and only one of them carries the qualifier that makes it
  precise. Quoted here as they stood **before** this change, because after it
  three of them read differently and this is the record of what was narrowed:
  - ADR 0001's Context — *"structured so it cannot produce a **user-accessible**
    file from captured audio"*;
  - `README.md` — *"It cannot save a file — there is no `downloads` permission,
    and an automated check asserts its continued absence"*;
  - `FAQ.md` — *"**The extension cannot save a file.**"*, and, under *"Are you
    going to add a download button"*, *"writing a separated copy of somebody's
    track to disk is the thing this project exists not to do"*;
  - `PRIVACY.md` — *"**It cannot save a file.** The extension does not request
    the `downloads` permission, and an automated check asserts its continued
    absence."*

  Superseding the ADR alone would leave three documents standing that say the
  same thing more broadly than the ADR ever did. That is why this change edits
  all four, in one branch, with this ADR as its first commit.
- **The permission was never what enforced it.** `tools/tree-check.mjs` asserts
  that `manifest.json` requests no `downloads` permission, under the message
  *"no downloads permission — nothing in this build writes a file"*. The
  assertion is true and stays true. **The message was always wider than the
  assertion**: an extension-origin page can mint a `Blob` and click an anchor
  with no permission at all, and could have on the day that check was written.
  Three of the four documents cite the permission as the reason the property
  holds, which reads as enforcement and is not. Narrowing the message is not a
  weakening of the check — the check is byte-for-byte unchanged and stays green.
- **What already writes to disk, and the argument this ADR does NOT make.** The
  build writes stems to OPFS (`extension/shared/stemcache.js`) and the engine's
  `DEV_*` handlers can dump there too. It would be convenient to argue from that
  that the documents were already false and this change merely tidies them.
  **That argument is rejected.** OPFS is origin-private: the bytes are not a file
  the user can open, attach, upload or hand to anybody, and they die with the
  extension's storage. ADR 0001 states exactly that qualifier —
  *user-accessible* — and it is the qualifier the whole property rests on. The
  other three documents drop it, which makes their wording loose, not false.
  **This plan breaks the property. It does not discover it broken.**
- **The reason the decision was settled is the blast-radius argument, and that
  is where a re-proposal has to start** (`CONTRIBUTING.md`: *"start from the
  reason it was settled rather than from scratch"*). ADR 0001's Context:
  *"Exporting audio derived from a YouTube stream is a download under YouTube's
  terms, and it puts the artifact in the category of tool that has drawn
  takedown requests against repositories (youtube-dl, October 2020). That
  exposure should not attach to the extension, its documents or its issue
  tracker."* Not `FAQ.md`'s copy-to-disk sentence — that sentence is a
  consequence of this argument, and answering the consequence while leaving the
  argument alone would be answering the easier thing.
- **Engaging it head on, and the half of it that survives.** The argument has two
  halves. The first is about the **artifact**: a download under YouTube's terms
  is a copy of the recording, and what made youtube-dl the precedent is that its
  output *substitutes* for the thing it came from — you can listen to it instead.
  A MIDI transcription substitutes for nothing. It cannot be played as the
  recording, it cannot be converted into it, it carries no audio to recover, and
  a person who wanted the track would not accept it. That half this ADR answers.
  The second half is about how the artifact is **read** — takedown pressure falls
  on what a project appears to be for, not only on what its files contain — and
  **no property of a file format disposes of it.** That half is not answered
  here, and decision 5 is what happens to it instead of a paragraph pretending
  otherwise.
- **What a `.mid` from this build actually contains.** Note number, onset,
  duration, velocity, a General MIDI program number per stem, one tempo and one
  time signature. No samples, no timbre, no performance, no room, no lyrics, no
  vocal. It is played back by the reader's own synthesiser and sounds like that
  synthesiser. It cannot be turned back into the recording by any process, and
  nothing in the pack is a copy of anything that was captured.
- **And it is a poor transcription, which is part of the argument rather than an
  apology.** `melodia_trick` and `infer_onsets` are off, because both are
  whole-file operations that invent notes at a window edge when run per window,
  so this build finds fewer notes than Basic Pitch's own CLI on legato and quiet
  passages. Drums are hand-written DSP with four General MIDI classes (kick,
  snare, closed hat, crash), not a model, because **no permissively licensed
  ONNX drum transcriber exists**. Coverage is reported as source seconds
  actually written against the video's duration, so a seek, a pause, an ad or a
  starve show up as a hole rather than as silence presented as music.
- **It rides the player, and that is a design constraint, not a limitation to be
  optimised away.** The transcriber taps the 14-plane stem ring in real time, so
  `CONTEXT.md`'s *"the player has to play through"* stays literally true. Bulk
  transcription by reading the OPFS stem cache would falsify it and is
  prohibited.
- **The pitched model is a licence question before it is an accuracy question.**
  Weights are separately licensed from the code that loads them, this project
  already carries that constraint for `htdemucs_6s` (CC BY-NC 4.0, never
  redistributed), and a second model that could not be redistributed would put
  a second single point of failure on a third-party host.

## Decision

1. **ADR 0001 decision 2 is superseded in full**, and its three conjuncts are
   settled separately: **L1 stays** — its operative rule is untouched and this
   change adds no route to a media URL; **the `downloads` assertion stays** —
   `tools/tree-check.mjs` keeps the assertion byte for byte, and only its
   message is narrowed to what it actually checks (*"no downloads permission —
   this build cannot use `chrome.downloads`"*); **its documents do not remain
   true** — they are edited, in this branch, and the property they state is
   narrowed rather than deleted.
2. **The narrowed property, stated once, in the words the four documents now
   use:** *the extension cannot produce a user-accessible file that reproduces
   the captured audio.* It produces exactly one kind of file — a MIDI
   transcription — and a MIDI transcription is not a reproduction of the
   recording by any route.
3. **The narrowed property is held by a mechanical gate, not by a sentence.** A
   narrowed property with no gate is precisely the unfalsifiable claim
   `AGENTS.md` exists to prevent, so the narrowing arrives with three things:
   - one declared delivery module, `extension/shared/midi.js::assertDeliverable`,
     whose allowlist is exactly `{ application/zip, audio/midi }` and which
     refuses synchronously at the one call site any bytes leave through;
   - `qa/midi-pack.mjs`, which builds a **real** pack and asserts every entry of
     the delivered zip begins `MThd`;
   - **a control that can lose**: the same suite builds the same pack with one
     entry replaced by a real WAV from this repo's own `encodeWav`, and asserts
     the guard **refuses it and names `4-other.mid`**. If `assertDeliverable`
     ever degenerated to `return true`, that half goes red. Without it, the
     first half is a second copy of the measurement wearing the word "control".

   **THE BLIND SPOT, STATED BESIDE IT:** this is a check on bytes at one call
   site, in a tree a static scan can read. **A reference assembled at runtime
   defeats a static scan** — `window['fe' + 'tch']`, a name built from parts, a
   guard called on a path nothing greps. That is why the `downloads` permission
   stays absent: the platform withholds what the grep cannot. The gate is the
   second line. The absent permission is the first.
4. **No new permission, no new command, no manifest change.** Delivery is a
   `Blob` and an `<a download>` inside the deck's own extension-origin iframe,
   behind one appended Host duty (`DeckHost.deliver(name, bytes, mime)`), so a
   second Host discharges it with a save dialog and invents nothing. The unit
   decides identity; the Host does transport. Bytes cross that seam, never a
   `blob:` URL — an extension-origin blob URL is unresolvable from
   `youtube.com`, so a Host routing this through a content script must carry the
   bytes.
5. **The rights question is recorded as OPEN, and this ADR does not close it.**
   A transcription is a derivative of the **composition**; a copy of the audio
   would be a copy of the **recording**. Those are different rights, held by
   different parties, and **"different" is not automatically "safer"** — a lead
   sheet of a song under copyright is a derivative work of that song, and the
   fact that no sound was copied does not by itself dispose of it. The
   engineering position, stated precisely and claiming nothing beyond itself:

   - `CONTRIBUTING.md` L1's operative rule is untouched — audio still comes from
     `chrome.tabCapture` and nothing else, and no media URL is resolved, fetched
     or parsed.
   - `SECURITY.md`'s three properties are untouched — no network after the model
     download, no remote code, capture only what the user's own player renders.
   - No new permission is requested, and `tools/tree-check.mjs`'s assertion is
     unchanged.
   - Nothing leaves the machine. The pack is built in the deck and handed to the
     user; no byte of it is transmitted anywhere.

   **Everything past that line requires the owner's review before merge.**
   Whether the blast-radius argument reaches a `.mid`, whether shipping it
   changes how the extension is read by a rights holder or a store reviewer, and
   whether the desktop product (ADR 0001 decision 1) is the right home for it
   after all, are questions this ADR raises and does not answer. **Ship the
   branch; do not merge it without that review.**
6. **The pitched model is Spotify's Basic Pitch (`icassp_2022` `nmp.onnx`),
   committed to this repository** — `spotify/basic-pitch` @
   `9991303bba609a3b93089d13ec80d1d495083596` (tag `v0.4.0`), path
   `basic_pitch/saved_models/icassp_2022/nmp.onnx`, 230,444 bytes, sha256
   `2c3c1d14…59a0ec`; the pin in full is in `NOTICE.md` and
   `extension/unit.json`. **The test that decides is whether the publisher has
   issued an explicit grant over the WEIGHTS.** Spotify has: the
   `spotify/basic-pitch` repository is Apache-2.0 and the `.onnx` is committed
   inside it, and Spotify's own model card carries `license: apache-2.0`.
   Google/Magenta has not. Meta's are non-commercial. 225 KiB is not a large
   binary and Apache-2.0 permits redistribution, so committing it removes the
   single point of failure, the fetch-script edit, the CI cache widening and the
   install-line change in one move — and it is the one thing this project has
   that `htdemucs_6s` can never be. Apache §4(d) requires the upstream `NOTICE`
   to travel with it; it is on disk at `extension/models/NOTICE.basic-pitch` and
   `NOTICE.md` points at it.

   **The test is the grant, and it is NOT training-data lineage.** Basic Pitch's
   own lineage includes MAESTRO and iKala, so a lineage test would disqualify it
   too. Saying so here is not a caveat, it is the point: a reader who works that
   out later and finds it unmentioned will conclude the analysis was selective,
   and will be right to. `NOTICE.md` states it in the same terms.
7. **The deliverable is MIDI-only, permanently.** The allowlist in decision 3 is
   the mechanism, not a convention: widening it is a code change that turns the
   gate red until somebody edits the gate, which is a diff a reviewer can see.
   Audio export remains cut — `docs/ARCHITECTURE.md`'s appendix records it, and
   this ADR does not reopen it.

## Consequences

Positive:

- The four documents are true again, and the property they state is narrower and
  sharper than the one they had. "Cannot save a file" was enforced by nothing;
  "cannot produce a file that reproduces the captured audio" is enforced by an
  allowlist and a control that can lose.
- The claim in the documents is now checkable by a stranger in one command
  (`node qa/midi-pack.mjs`) rather than by reading a permission list and
  believing an inference about it.
- `tools/tree-check.mjs`'s message stops overstating its own assertion, which
  removes a small false confidence that three other documents were built on.
- The extension gains the thing people ask for after they hear a bass line
  isolated, without gaining the thing it exists not to do.
- The weights ship in the repository. There is no second host to disappear, no
  second fetch script, no second cache key, and the licence permits it — which
  is the first dependency in this project that has none of `htdemucs_6s`'s
  problems.

Negative:

- **A settled decision was reopened, and one of its conjuncts did not survive.**
  That has a cost independent of the merits: ADR 0001 decision 2 was part of the
  extension's trust position, and "we narrowed it once" is now a fact about this
  project that any future re-proposal will cite.
- **The rights question is open at merge time.** This ADR states an engineering
  position and explicitly declines to state a legal one. A branch that ships on
  an unresolved question is a branch that may have to be reverted, and the
  revert is cheap only while the release has not gone out.
- **The blast-radius argument is not disproved, only distinguished.** This ADR
  argues a `.mid` is a different artifact from a copy of the recording. It does
  not argue that no exposure attaches to it, and the youtube-dl precedent is
  about how an artifact is *read*, not only about what it contains.
- The four documents now each carry a change of mind. `FAQ.md` in particular
  keeps its old "No" visible and dated beside the new answer, which is longer
  and less clean than a single answer would be — deliberately: **a silently
  vanished answer is worse than a documented change of mind.**
- `PRIVACY.md`'s own change clause promises users are notified *in the
  extension itself* before a change to data practice takes effect. That notice
  is product work that does not exist yet, and it must land before release, not
  after. `PRIVACY.md` says so in its own text rather than in a tracker.
- A second ONNX session and a second Worker exist for the life of a take, at a
  measured +0.091 RTF on the WASM execution provider beside htdemucs at 0.4527.
  Basic Pitch cannot run on the WebGPU provider at all, so that cost cannot be
  moved to the GPU.
- The transcription is honestly mediocre and the UI has to keep saying so —
  coverage, tempo provenance, "no notes" per stem. Every one of those strings is
  a maintenance obligation that a confident progress bar would not have.

## Considered Options

- **Do not build it; leave ADR 0001 decision 2 whole.** The cheapest option and
  the one with no rights question at all. Rejected by the owner's ruling: the
  feature is wanted, the artifact is not a copy of the recording, and the
  alternative is a capability that exists in the desktop product for a user who
  will never install it.
- **Build it in the desktop product only** (ADR 0001 decision 1's home for
  export). Coherent, and it keeps this repository's documents untouched. But the
  desktop product does not exist, the transcriber must ride the live stem ring
  either way, and the artifact it produces is not the artifact ADR 0001 moved
  over there — that was audio. Rejected: it defers a shippable feature onto an
  unbuilt product to avoid editing four paragraphs.
- **Ship it and leave the documents alone.** Rejected outright. This is exactly
  the failure ADR 0001 decision 2's third conjunct exists to prevent, and a
  false sentence in `PRIVACY.md` is a different category of problem from a
  narrowed one.
- **Argue the documents were already false, because the build already writes to
  OPFS.** Rejected, and recorded here because it is the argument that will be
  reached for again. Origin-private storage is not user-accessible; ADR 0001
  carries that qualifier explicitly. The argument is the weakest one available
  and it takes the credible half of the case down with it.
- **Add audio export alongside the MIDI pack.** Rejected. This is precisely the
  thing the blast-radius argument is about, the artifact would be a copy of the
  recording, and nothing in this ADR applies to it.
- **Request the `downloads` permission for delivery.** Rejected. The anchor
  needs no permission, so the permission would buy nothing but a wider install
  prompt — and its absence is a real, mechanically-asserted reduction in what
  this build *can* do, which is worth more than the convenience. It is also the
  first line the blind spot in decision 3 relies on.
- **Transcribe by bulk-reading the OPFS stem cache**, so a previously-played
  track converts at engine speed. Rejected: it would falsify `CONTEXT.md`'s "the
  player has to play through", which the live path keeps literally true. Noted
  as an upgrade path the day the cache grows a second reader; not before.

**Model candidates, all rejected on the weights-grant test in decision 6:**

| candidate | why not |
|---|---|
| **MuScriptor** | CC BY-NC 4.0 **plus** gated access terms. The July-2026 frontier for this task and comfortably the most accurate of them — and unusable: NC is the same constraint `htdemucs_6s` already imposes, and the gate means the weights can be neither redistributed nor fetched unattended, so there is no shape in which this build could load them |
| **ByteDance `piano_transcription`** | **no licence file at all.** Not permissive-by-omission; unlicensed means no grant |
| **Magenta Onsets & Frames** | piano-only, no explicit grant over the weights, and a TensorFlow.js runtime this build does not have |
| **madmom / ADTLib / ADTOF** (drums) | non-commercial licences. This is why drums are hand-written DSP and not a model |
| **CREPE, pYIN** | monophonic pitch trackers with no note segmentation. They answer a different question |
| **`@spotify/basic-pitch` (TFJS build)** | the same model behind a second multi-MB runtime, and it needs a bundler this repository does not have and will not add |
