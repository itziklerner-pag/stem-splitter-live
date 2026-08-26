# Notices and attribution

Stem Splitter Live's own source is MIT ([`LICENSE`](LICENSE)). It depends on
third-party work that is **not** MIT. Most of it is **not** redistributed by
this repository; exactly one piece is — the Basic Pitch weights, because their
publisher granted the rights to do it. This file states what each piece is,
where it comes from, whether it is in here, and what you may do with it.

---

## The model weights — Demucs `htdemucs_6s`

| | |
|---|---|
| what | Hybrid Transformer Demucs v4, six-source variant (27.4 M parameters) |
| origin | [facebookresearch/demucs](https://github.com/facebookresearch/demucs) — Meta Platforms, Inc. |
| code licence | MIT |
| **weights licence** | **CC BY-NC 4.0 — non-commercial** |
| distributed here? | **No.** `.gitignore` excludes `*.onnx` — with exactly one declared exception, and it is not this file (see below); the repository carries only the pin |
| fetched from | an ONNX re-export on Hugging Face, pinned by commit SHA |
| pin | split across the Host seam: the URL and the cache bucket in [`extension/offscreen/host-pin.js`](extension/offscreen/host-pin.js), the SHA-256 and byte count in [`extension/shared/config.js`](extension/shared/config.js) — each half a single source of truth every script derives from |
| size | 114,559,139 bytes (109 MiB) |

**This is the constraint that matters most, so it is stated plainly:**

> The Demucs *code* is MIT. The *pretrained weights* are not. Meta's position is
> that the weights are released under CC BY-NC 4.0 and provided for scientific
> purposes; they were trained partly on a proprietary dataset. **Nobody can
> relicense them, including us.**

What follows from that:

- **Stem Splitter Live is free and will stay free.** There is no paid tier, no
  licence key, no donation-gated feature, and no plan for one. A commercial
  product built on NC weights would be a licence violation, so the project is
  structured to make that impossible rather than merely unlikely.
- **If you fork this, the same applies to you.** Our MIT grant covers our code.
  It cannot and does not grant you anything about the weights. If you want to
  ship something commercial, you need weights you are allowed to use
  commercially — train your own, or use a permissively-licensed separator.
- **We do not redistribute the weights.** The extension downloads them from an
  upstream host and hash-verifies them. This repository has never contained
  them.

**Known limitation, stated rather than buried:** the pinned host is a
third-party ONNX re-export, not an official Meta release, and it carries no
model card of its own. If that revision is removed, new installs will fail the
hash check and the model will not download. Existing installs keep their cached
copy. This is a real single point of failure and it is tracked as such.

If you are the author of that re-export and would like different attribution,
or would like us to point somewhere else, please open an issue.

## The transcription weights — Spotify Basic Pitch `nmp.onnx`

| | |
|---|---|
| what | Basic Pitch, the `icassp_2022` note-transcription model (`nmp`): audio in, note events out — pitch, onset, duration, velocity |
| origin | [spotify/basic-pitch](https://github.com/spotify/basic-pitch) — Spotify AB — at commit `9991303bba609a3b93089d13ec80d1d495083596` (tag `v0.4.0`), path `basic_pitch/saved_models/icassp_2022/nmp.onnx` |
| code licence | Apache-2.0 |
| **weights licence** | **Apache-2.0** |
| distributed here? | **Yes** — Apache-2.0 permits it, and it is 225 KiB |
| **licence text** | [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) — the official Apache License 2.0, verbatim. It is tracked because **§4(a)** requires it, not as decoration; see below |
| where | [`extension/models/nmp.onnx`](extension/models/nmp.onnx) |
| size | 230,444 bytes (225 KiB) |
| sha256 | `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec` |
| pin | the SHA-256 and byte count above are `BASIC_PITCH` in [`extension/shared/config.js`](extension/shared/config.js) and the `external` entry in [`extension/unit.json`](extension/unit.json) — the same two-step the model pin uses, and here both halves are about bytes that are already in the tree |

**Redistributing an Apache-2.0 Work costs two clauses, and both are paid in the
tree rather than promised here.**

**§4(a) — give every recipient a copy of the License.** Not a link to it, not a
name for it: a copy. So there is one, verbatim, at
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) — the official text as
published at <https://www.apache.org/licenses/LICENSE-2.0.txt>. **That file
exists for this reason and no other, which is worth saying out loud**: it looks
like clutter in a repository whose own code is MIT, and it is not. It became
required the moment `nmp.onnx` was committed, it applies to every clone and
every vendored copy, and deleting it puts this repository out of compliance
without changing a line of code.

**§4(d) — the upstream `NOTICE` travels with the work.** It does: it is
reproduced verbatim on disk at
[`extension/models/NOTICE.basic-pitch`](extension/models/NOTICE.basic-pitch),
beside the weights it belongs to, and it is part of what a vendoring product
copies ([`docs/VENDORING.md`](docs/VENDORING.md)).

**This row does not inherit the Demucs row's single point of failure, and that
is the whole reason it is committed.** The file is in this repository. There is
no upstream host to disappear, no hash check that can start failing for new
installs, nothing to re-pin and nothing to watch. If `spotify/basic-pitch` were
deleted tomorrow, this build would be unaffected.

### The one test that decides which model we may use

**Has the publisher issued an explicit grant over the WEIGHTS?** Not over the
code that loads them — over the weights themselves. Spotify has: the repository
is Apache-2.0 and the `.onnx` is committed inside it, and Spotify's own model
card carries `license: apache-2.0`. Google/Magenta has not. Meta's are
CC BY-NC 4.0, which is the constraint the section above is about.

**We deliberately do not use training-data lineage as the test, and it matters
that we say so.** Basic Pitch's own lineage includes MAESTRO and iKala, so a
lineage test would disqualify it too. A reader who discovers that later, having
read a case built on lineage, would reasonably conclude the analysis was
selective — so the test is stated as the narrow thing it is, once, and applied
to every candidate the same way.

**Rejected on that test, recorded so a re-proposal starts here:** MuScriptor
(CC BY-NC 4.0 plus gated access terms — the July-2026 frontier for this task and
unusable); ByteDance `piano_transcription` (**no licence file at all** — that is
not permissive by omission); Magenta Onsets & Frames (piano-only, no explicit
grant over the weights, TensorFlow.js); madmom, ADTLib and ADTOF for drums (all
non-commercial — which is why the drum transcription here is hand-written DSP
and not a model); CREPE and pYIN (monophonic pitch trackers with no note
segmentation); and the `@spotify/basic-pitch` TensorFlow.js build (the same
model behind a second multi-megabyte runtime, needing a bundler this repository
does not have). [ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md)
carries the same list with the decision it belongs to.

## ONNX Runtime Web

| | |
|---|---|
| what | [ONNX Runtime Web](https://onnxruntime.ai/) 1.27.0, WebGPU + threaded-WASM build |
| origin | Microsoft |
| licence | MIT |
| distributed here? | **No.** Fetched from npm by [`tools/fetch-vendor.sh`](tools/fetch-vendor.sh), hash-verified, and gitignored |
| size | ~26.5 MiB |

## Test fixtures

The real-music quality fixture is **CC BY 2.5** material. It is fetched locally
and **not committed** — this repository redistributes no audio. The synthetic
six-source testbed is generated by
[`docs/snippets/make-testbed.js`](docs/snippets/make-testbed.js) and is
original to this project.

## Reference implementations in `docs/snippets/`

Zero-dependency reference implementations of the DSP described in
[`docs/AUDIO.md`](docs/AUDIO.md). Original to this project and MIT, like the
rest of the source. Where one mirrors an upstream algorithm — Demucs' triangular
transition weight, the `bss_eval` metrics — the upstream is named in the file
header.

## Trademarks

YouTube is a trademark of Google LLC. Chrome and the Chrome Web Store are
trademarks of Google LLC. This project is not affiliated with, endorsed by, or
sponsored by Google or Meta.
