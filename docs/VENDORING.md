# Vendoring the unit

How a second product takes the engine and the deck out of this repository, and
what it owes them once it has.

This is the procedure ADR 0001 decision 3 describes — "vendored by pinned tag
plus SHA-256, the discipline `tools/fetch-vendor.sh` already applies to ONNX
Runtime" — written out and **dry-run from an empty directory** before it was
committed. Every command below was executed in that order; the numbers quoted are
from that run.

> **There is no npm publish and no separate package.** ADR 0001 decision 6: one
> repository, one tag series. You copy files at a tag and verify them. That is
> the whole distribution mechanism, and it is deliberate — a package is a
> promise about a boundary, and the boundary this project has is
> [`extension/unit.json`](../extension/unit.json), which travels with the copy
> and is checked on every run of `node tools/unit-check.mjs`.

---

## 0. What you are copying

Three groups of files, and the difference between them is the whole of this
document.

| group | what it is | you may edit it |
|---|---|---|
| **the unit** — 35 files | the engine and the deck. `extension/unit.json` declares it; `extension/unit.sha256` fixes it byte for byte | **no.** Edit it and you have forked, not vendored |
| **the reference Host** — 5 files | `offscreen/host.js`, `ui/host.js`, `offscreen/host-pin.js`, `content.js`, `speed.js`. This repository's Chrome implementation of the seam | **yes — that is the point.** The first two are the *holes* you replace |
| **the harness** — 14 files | the suites whose subject is the unit, and the two files that run them | **yes**, once you have read §6 |

`extension/unit.json` is the machine-readable version of that table: `entries`,
`roots` and `required` are the unit; `holes` are the two modules a Host
replaces; `suites` and `runners` are the harness, with a `reads` list naming
every file each one opens across the seam. Step 2 below derives the copy list
from it rather than from a list in this document, because a list in a document
rots and `tools/unit-check.mjs` gates the declaration on every run.

**Host interface v1 is frozen at `v0.2.0`.** What that means, what changed at
the freeze, and the two limitations it did not close are at the top of
[`extension/shared/host.js`](../extension/shared/host.js). Read that file
before you write a Host; this document is the mechanics.

---

## 1. Fetch the tag's archive

```bash
TAG=v0.2.0
curl -fsSL "https://github.com/itziklerner-pag/stem-splitter-live/archive/refs/tags/$TAG.tar.gz" | tar xz
cd "stem-splitter-live-${TAG#v}"
```

A tag, never a branch. The sums file in the archive describes the tree at that
tag and nothing else, so a copy taken off `main` is a copy whose verification
step is theatre.

> Working from a clone instead? `git archive --format=tar "$TAG" | tar -x -C <dir>`
> produces the same tree. That is what the dry run used, because the dry run
> happened before the tag was pushed.

## 2. Verify the archive before you copy out of it

```bash
shasum -a 256 -c extension/unit.sha256      # macOS, and Linux with perl
# or: sha256sum -c extension/unit.sha256    # GNU coreutils
```

Expect 35 lines of `: OK` and exit 0. **Any `FAILED` line means stop.** You have
a corrupt download, a tarball that was rewritten in transit, or an archive that
is not the tag it claims to be — and there is nothing further down this page
worth doing until you know which.

`extension/unit.sha256` is written by `node tools/unit-hash.mjs` and is checked
against the tree by `node tools/unit-check.mjs` on every run of the gate, so a
sums file that had gone stale on our side could not have reached the tag. It does
not hash itself — no sums file can — and it does hash
`extension/unit.json`, because that is the file everything else is verified
*against*, and a copy that verified 34 files against a manifest it had taken on
faith would have checked its own homework. What authenticates the sums file is
the tag.

## 3. Derive the copy list from the declaration

```bash
node -e '
const fs = require("fs"), d = require("./extension/unit.json"), ext = (p) => "extension/" + p;
const unit    = fs.readFileSync("extension/unit.sha256", "utf8").trim().split("\n").map((l) => l.slice(66));
const host    = [...d.holes.map((h) => ext(h.path)),
                 ...d.hostReads.map((r) => ext(r.path)),
                 ...[...d.suites, ...d.runners].flatMap((s) => (s.reads || []).map(ext))];
const harness = [...d.suites, ...d.runners].map((s) => s.path);
console.log([...new Set([...unit, ...host, ...harness,
  "extension/unit.sha256", ...d.external.map((e) => e.fetch)])].sort().join("\n"));
' > /tmp/vendor-list.txt
wc -l < /tmp/vendor-list.txt      # 50
```

Fifty paths: 35 unit, 5 reference Host, 14 harness (12 suites and 2 runners,
seven of which are unit files that are their own suite and are therefore already
counted), plus `extension/unit.sha256` and `tools/fetch-vendor.sh`.

The unit half comes out of the **sums file** rather than out of `unit.json`'s
`required` clauses, and that is not an accident of convenience: two of those
clauses are whole directories expanded with `git ls-files`, and an unpacked
archive is not a git repository. The sums file is the enumeration, already
verified one step ago.

## 4. Copy, with the repo-relative layout preserved

```bash
DEST=/path/to/your-product/vendor/stem-splitter-live
mkdir -p "$DEST"
tar -cf - -T /tmp/vendor-list.txt | tar -x -C "$DEST"
find "$DEST" -type f | wc -l      # 50
```

**The layout is part of the contract, not a preference.**
`workers/workerbackend.js` reaches the inference worker with
`new URL('./inference.worker.js', import.meta.url)`; the suites live outside
`extension/` and import `../extension/...`; `assetUrl('vendor/ort/')` resolves a
directory. A copy that flattens directories, renames one, or drops the
`extension/` prefix does not run, and most of the ways it fails are late and
quiet.

## 5. Verify the copy

```bash
cd "$DEST"
shasum -a 256 -c extension/unit.sha256
```

The same 35 `: OK` lines, now about the files you will actually run. Doing it
twice is not superstition: step 2 proves the download, this proves the copy, and
they fail for different reasons.

## 6. Fetch ONNX Runtime

```bash
bash tools/fetch-vendor.sh
```

~27 MB into `extension/vendor/ort/`, pinned at `onnxruntime-web@1.27.0` and
verified against two SHA-256s recorded in the script itself. **Run the script;
do not copy our drop.** It is not in git for the same reason the model weights
are not, it is not this project's code, and the script is the pin.

## 7. Run the unit's own gate

```bash
node tools/verify.mjs --unit
```

Expect, verbatim on the last line:

```
GREEN (partial — the vendored unit's suites only; 12 of 23 steps)
```

exit 0, 12 of 12 steps PASS, **1327 assertions**, about 74 s. Per step:

> These twelve numbers are this repository's own `--unit` counts, **measured at
> `b9dc537` (v0.3.0)** — not a floor and not a target. They move whenever a
> suite gains an assertion, so they are a fact about a tag rather than about
> the code in general. **If yours differ, compare against the figure in the
> annotated tag you pinned** (`git cat-file -p v0.3.0`), which is immutable and
> was measured at that commit; this table is a convenience for finding WHICH
> step differs. A mismatch here with the tag body's total means this table is
> stale — please report it rather than editing your copy.

| step | count | step | count |
|---|---|---|---|
| `unit` (`test.js`) | 766 | `chroma` | 37 |
| `seam` | 17 | `keytap` | 23 |
| `ui` | 124 | `bpmtap` | 46 |
| `qa-edge` | 13 | `speed-pitch` | 10 |
| `passthrough` | 16 | `embed-state` | 224 |
| `pitch` | 23 | `pitchbank` | 28 |

**No `npm install`, no `node_modules`, no `package.json`, no git.** The dry run
had none of them; `--unit` is the plain-Node plan and spawns nothing that is not
in the list above. Node 22 or newer.

If a step is red here, before you have changed anything, the copy is wrong —
re-read step 4. Nothing in `--unit` needs a browser, a GPU or the model weights.

---

## The decisions this document exists to record

S11 (#12) was asked two questions by `extension/unit.json` and answered both
here rather than in a comment.

### `speed.js` and `content.js` travel — as reference Host, not as unit

Two suites read a content script as **text**: `qa/speed-pitch.mjs` reads
`content.js` and `speed.js` to assert that no path in the build leaves the
page's `<video>` key-unlocked, and `extension/ui/embed-state.js` reads
`speed.js` to pin the deck's speed ladder against the page's clamp. Those reads
are declared in `unit.json` (`hostReads`, and `reads` on each suite) and they are
not guarded — a read that silently skipped would report coverage it does not
have, which `AGENTS.md` forbids.

So a copy that left them behind would take a red naming a file it deliberately
did not take. **Copy them.** They are the reference Host's answer to a policy
question whose other end is in the unit: the ladder decides what the user may
ASK for, the clamp decides what the element may BE GIVEN, and a disagreement is
a button that moves the readout to a rate the player refuses. When your Host has
its own transport, replace them and the two suites re-aim at your files — or
retire those halves deliberately, in writing, the way this paragraph does.

`offscreen/host-pin.js` travels for a blunter reason: `tools/verify.mjs`
imports `MODEL_URL`, `MODEL_BYTES`, `MODEL_SEED_REL` and `modelSeed` from it at
module scope, so the runner does not load without a file at that path. Yours or
ours; there has to be one.

### `test.js`'s `group('host')` stays inside step `unit` — and it will go red

**This is the one thing in `--unit` a second Host cannot pass, and it is
expected rather than broken.**

`test.js` is the largest suite over the unit in this repository — the DSP, the
rings, the mixer, the OLA planes, the scheduler — *and* it is this Host's
conformance suite. Its `group('host')` installs a Chrome platform
(`globalThis.chrome = { runtime: { … } }`) and asserts that
`extension/offscreen/host.js` and `extension/ui/host.js` really behave the way
`shared/host.js` declares: 132 of the file's assertions, 33 of them naming an
`extension/{ui,offscreen}/host.js` entry point explicitly.

Replace the two holes with your own — which you must; they are holes — and those
132 assertions become claims about a platform that is no longer there. Measured
in #11's review, and **re-measured at `b9dc537` (v0.3.0)** because the step's
count has moved twice since: swapping `offscreen/host.js`'s `send()` for a
contract-satisfying non-Chrome implementation — same envelope, same `undefined`
return, same swallowed delivery failure, over a plain bus — takes step `unit`
from 766 passed to 764 passed, 2 failed, both reds naming `send()`.

S11 considered splitting the group into a step of its own and **did not**,
because the honest way to do that is to carve `test.js` in two, and a mechanical
split of the repository's largest suite is not a thing to do in the same commit
that freezes an interface. The cost of the decision is this paragraph; the
benefit is that it is written down instead of discovered.

**What to do with it, in order of increasing effort:**

1. **Run `--unit` before you swap the holes** — that is the green in §7, and it
   is a real result: it says the unit arrived intact and runs.
2. **After you swap them, expect `unit` red and read the reds.** They are a
   conformance report on YOUR Host, in the unit's own words, and most of them are
   worth passing: they are where `assetUrl`'s trailing slash, `send`'s
   `undefined` return and `storageGet`'s absent-vs-unreadable split are checked
   against a real implementation rather than a stub.
3. **Point the group at your files.** `group('host')` reads the two holes by
   path. Same paths, your implementations, and the group becomes your
   conformance suite — which is what it is for.

### A hole must import INERTLY — touch your platform on the first duty call

**This is a rule, not a style note, and it is the one that decides whether you
get a conformance report or a stack trace.**

`group('host')` imports each hole by path. A hole that reaches for its platform
at **module evaluation** — `window.parent`, an `ipcRenderer` off a preload
bridge, a `document` — is the natural first shape for a Host whose platform is
not available in Node, and it does not produce reds. Before v0.3.0 it ended the
process: the first real second Host died at the import line after 482
assertions, and the report the group exists to produce was replaced by a stack
trace. `verify.mjs` then reported *RED — 0 failing assertions*, which names
nothing and reads exactly like a broken vendored copy.

Since v0.3.0 the group imports each hole in a `try`, so an evaluation-time throw
is a **named red** carrying the hole's path and what it threw, and a throw
anywhere else in the group turns the assertion at its foot red instead of ending
the run.

**That is a reporting improvement, not a completeness guarantee.** A hole that
throws at import still takes the assertions after it with it, and they are the
ones you wanted: measured at `b9dc537` (v0.3.0), `node test.js` goes from 766
passed to 680 passed / 2 failed — **84 assertions did not run**. Do not read a
guarded suite that went red as fully covered. What tells you it was truncated is `tools/verify.mjs`'s
coverage diff, which lists `no longer runs: <assertion name>` and warns that an
absent assertion reads as green; the guard exists so that there is a completed
run for it to compare against.

**So: hold nothing at module scope that your platform has to be present for.**
Read the bridge, the window, the IPC channel inside the duty, on the first call.
Both shipped holes are written that way and `ui/host.js` says so in its own
comment — its `window.parent` question is asked at import *deliberately*, and
the suite installs a `window` before importing it for exactly that reason.

---

## What your Host owes the unit

Read [`extension/shared/host.js`](../extension/shared/host.js) for the duties.
Five things are *not* duties and are easy to miss:

**You must ORIGINATE four messages.** `assertHost` cannot check for a message
nobody sent. To the engine (`to: BUS.engine`): `CAPTURE_START { sourceToken,
source: { title, url }, deck? }`, `CAPTURE_STOP { deck? }`,
`DECK_PREPARE { deck? }`. To the deck (`to: BUS.deck`):
`SESSION { session: { armed, title, url, armedAt } }`, plus
`ARM_ERROR { code, message }` and `ARM_ERROR_CLEARED` if your product can refuse
to arm. The addresses are `BUS` in `shared/host.js` — three strings, declared
once, read by every context.

**`ARM_ERROR.code` is a CLOSED VOCABULARY, and five of its eight members are tab
nouns.** `ARM_CODES` in
[`extension/ui/audio-math.js`](../extension/ui/audio-math.js) is the legal set:
`NOT_CAPTURING`, `NOT_ARMED`, `NEEDS_GESTURE`, `TAB_GONE`, `TAB_BUSY`,
`TAB_UNSUPPORTED`, `ARM_FAILED`, `NO_ACTIVE_TAB`. Three deck behaviours are
gated on membership — whether the banner can be **dismissed**, whether
**Restart** is offered, and **which sentence** is printed — so a Host that
invents a plausible-looking code (`NO_SOURCE`, say) ships a banner the user
cannot dismiss with a Restart control that cannot fix it. Since v0.3.0 the deck
says so: `checkArmCode()` writes one `console.error` naming your value and the
whole legal set, on both ways in — the live `ARM_ERROR` and the refusal you
persisted at `ARM_ERROR_KEY`. It does not throw and it does not change the
banner; the user still sees their own problem. **Pick a member.** If your Source
kind genuinely needs a new one, it is a change here, behind a tag — not a string
your Host invents.

**You must wire the autoplay-next preference.** The deck writes
`prefs.autoplayNext` through `storageSet('local', PREFS_KEY, …)`; nothing tells
your Host to act on it. A Host that implements all six `DeckPage` duties still
ships a dead checkbox. Host interface v1 declared this rather than closing it —
see freeze item 8.

**You must patch one string.** `ui/embed.js` prints "Click the Stem Splitter Live
toolbar icon on this tab to arm it" when nothing is armed. That is true of a
browser extension and of nothing else. `armShortcut()` returning `null` is the
honest answer for a Host with no command table, and the sentence the deck then
prints alone is still ours. v1 did not make it a duty, because user-facing copy
behind a seam hands you one English sentence you cannot lay out, wrap or
translate. It is cosmetic and it is on your first screenshot.

**You must arrange cross-origin isolation.** The engine builds
`SharedArrayBuffer`s directly and asserts on the constructor, not on
`crossOriginIsolated` — which is false on an extension page and does not need to
be true there. Serving the unit from any other scheme means COOP/COEP, or the
flag, before `offscreen/engine.js` loads.

**The model weights are not in the copy.** 109 MB, not in git, fetched by
`tools/fetch-model.sh` here. `modelBytes` / `modelCached` / `clearModel` are
where your Host says where they come from; the SHA-256 and the byte count stay
in `shared/config.js`, and the unit checks them over whatever you hand it, every
load. A Host that verified would be a Host that could decline to.

**Announce a phase from `MODEL_SOURCES`, and remember it is three-valued.**
`modelBytes(onProgress)` announces its phase before any bytes move, and since
v0.3.0 that announcement is also the **provenance**: `'cache'`, `'download'`, or
`'bundled'` for a Host that ships the weights beside its binary. It is what the
engine words its `weights … + hash verified` line from — the one line a user
reads to check the network claim. `fromCache` is unchanged and is **not** the
provenance: it is the retry decision (rule 3 on `EngineHost`), and a bundled
Host answers `'bundled'` there and `false` here, which is right on both counts.
A Host that announces nothing is quoted as having named no source, which is
honest and is also the only thing that will make it announce one.

---

## Upgrading to a later tag

Repeat §1–§7 at the new tag and diff the unit against your copy. Two rules keep
this cheap:

- **Never edit the unit in place.** `shasum -a 256 -c extension/unit.sha256`
  against your copy is the check that says whether that rule held, and it is
  worth running in your own CI.
- **Read the freeze block** at the top of `shared/host.js`. A duty added is a
  MINOR change that your Host fails at boot, loudly, by `assertHost` naming the
  missing duty — which is the entire reason `assertHost` exists. A duty removed
  or renamed is a MAJOR change and gets a major tag.

## The dry run

This procedure was executed end to end from an empty directory on the branch
that became `v0.2.0`, using `git archive` in place of the GitHub tarball because
the tag did not exist yet, and again against the pushed tag. 50 files copied, 35
verified `: OK` twice, ORT fetched and both hashes matched, and
`node tools/verify.mjs --unit` printed
`GREEN (partial — the vendored unit's suites only; 12 of 23 steps)` at exit 0
with the 12 counts in §7. Nothing in the copy was edited to make that happen.
