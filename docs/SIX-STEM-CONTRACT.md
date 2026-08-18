# The six-stem contract

The stem set, its ORDER, and the constants that follow from
both. Everything builds against THESE numbers; do not re-derive them.

> **Reconciled against what shipped.** This file was written at the *start* of the
> six-stem migration as a forward-looking contract, and several of its predictions
> were resolved differently by measurement. **Those are corrected in place, not
> edited to match.** **A contract that silently rewrites itself to have always been
> right is worth less than one that shows its corrections**: the constants below
> are binding *because* the record of how they were arrived at is checkable. Each
> correction carries the measurement that produced it.

## Wire order — the one source of truth

```js
export const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
```

`model.sources` order for htdemucs_6s. **`other` stays at index 2**, which is
what keeps `extension/engine/keytap.js`'s `KEY_TAP_PLANE_L/R` valid. This must
be verified against the actual re-export's metadata before merge.

**The adjacent question — the STFT packing — was settled by measurement rather
than by reading**, and it is the instrument to reach for here too: a permutation
sweep against real PyTorch `htdemucs_6s` (`tools/model-parity.mjs`, 22
assertions, against a PyTorch reference run out-of-tree) scores our `[L.re, L.im, R.re, R.im]`
packing at **2.43e-05–4.13e-05** and the three wrong packings at
**0.0515–1.318**. **Quote the conservative separation figure, 152×, not the
headline 1246×** — 152× is `bass` under a channel swap, which is near-mono and
therefore barely moves, and it is the number a reader sizing margin needs.
**A wrong packing separates PLAUSIBLY and incorrectly with no error**, which is
why nothing cheaper than a permutation sweep discharges this class of check.
*(The `model.sources` metadata tick above belongs to whoever ran the re-export.
If it was never explicitly ticked, it is still owed — do not read the packing
result as having covered it.)*

## Derived constants

| constant | file | was | is |
|---|---|---|---|
| `RING_PLANES` | `shared/config.js` | 10 | **14** |
| `PLANES[]` names | `shared/stemring.js` | 10 | **14** |
| `STEM_PLANES` | `engine/live.js` | 8 | **12** |
| `G_PASS` / `G_MASTER` | `offscreen/live.js`, `offscreen/cacheddeck.js` | 4 / 5 | **6 / 7** |
| `NSTEMS` / `NPLANES` | `offscreen/playback-processor.js` | 4 / 10 | **6 / 14** |
| `PITCH_LANES` | `engine/pitchbank.js` + worklet copy | 5 | **7** |
| `PITCH_PLANES` | same | 10 | **14** |
| `PITCH_SHIFTED_LANES` | same | `[1,2,3,4]` | **`[1,2,3,4,5,6]`** |
| `ExportOLA` / `OverlapAdd` nStems default | `engine/ola.js` | 4 | **6** |

Plane layout is unchanged in *form*: `(stemIdx * 2 + ch)`, then passthrough L/R
at planes 12/13 (was 8/9).

Gain slot map is unchanged in *form*: `0..5` stems, `6` passthrough, `7` master.

## Unchanged, and do not "fix" them

`demucs.js`'s `4 * BINS * FRAMES`, `stemIdx * 4 * BINS * FRAMES`, and the
`[1, 4, BINS, FRAMES]` feed are **complex-as-channels (L.re/L.im/R.re/R.im)**,
not stems. `SR 44100`, `SEGMENT 343980`, `OVERLAP 0.25`, `STRIDE 257985` are
untouched by stem count.

## Display order

```js
const STEM_ORDER = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
```

New stems append. The existing four do not move — muscle memory is a feature.

## Keyboard

Twelve digits do not exist. The rules:

- **The deck:** stems are `1`–`6`. (The ruling also assigned `Shift`+`1`…`6` to a
  second deck, which no longer exists. What survives of that half is the
  amendment below and the fact that **`Shift` is solo again**, because there is
  no deck B left for it to name.)
- **Solo moved to `A` `S` `D` `F` `G` `H` — AND THAT MOVE DIED WITH THE
  CONSOLE.** *(A later amendment superseded this.)*
  It was needed because **`Shift` was already solo's** and the ruling spent it on
  deck B without saying what became of the modifier it was taking — **a ruling
  that reassigns a modifier owes an answer for its previous tenant.** The tenant
  came back when deck B went, so **solo is `Shift`+`1`–`6` in the shipped build
  and `A`–`H` are bound to nothing.** `extension/ui/embed-state.js` asserts all
  six letters as `NO_ACT` at both entry points. Kept visible rather than deleted
  because `README.md` carried the `A S D F G H` row for a whole build after the
  console was cut, and a reader who finds only the correction cannot tell whether
  the row was wrong or merely absent.
- **Embed overlay: `1`–`6`, one digit per strip.** *(amended since.)*
  This clause used to read: *digits `1`–`4` keep their meaning, guitar and piano
  get NO digit — pointer only, and `Digit5`–`Digit8` continue to reach YouTube
  for seek-to-50%…80%; that carve-out is documented and load-bearing.* **It was
  neither documented nor load-bearing — it was the four-stem era, preserved by a
  clause nobody re-read.** Three pieces of evidence, and the third is the one
  that settles it:

  | | |
  |---|---|
  | **the digits predate the stem** | the in-page rack shipped with four strips and four digits. The count was the stem count. No seek-preservation argument was made, because none was needed |
  | **the carve-out's SHAPE is deck B's** | it protects `Digit5`–`Digit8` — **four** keys — when the rack had **two** unkeyed strips. Four is deck B's stem count on the console, whose bare `5`–`8` this same ruling retired. A carve-out sized for the surface it serves would have been `5`–`9`; this one is a block inherited from a surface that no longer exists |
  | **its stated reason does not discriminate** | *"a key we take is a key YouTube stops getting"* is true and it applies **identically to `1`, `2`, `3`, `4` and `0`**, which this build had already taken. A principle that condemns the digits already spent cannot be what justifies stopping at four |

  **The rack now takes exactly as many digits as it has strips**, which is a rule
  that scales with the stem set instead of freezing at a retired one. `7` `8` `9`
  reach YouTube for seek-to-70%…90%, and **that** boundary is load-bearing:
  `KEYED_STEMS` is the single constant behind the intercept list, the `n >
  KEYED_STEMS` guard and the printed hint, asserted as a count at both entry
  points so it cannot move in one place quietly.
- **Fader keys are the deck's own and are NOT in the intercept list.** They fire
  only when a fader inside the extension iframe has focus, so they can collide
  with neither YouTube nor `hostKeys()`.

  | chord | on macOS | does | alias kept |
  |---|---|---|---|
  | `↑` `↓` (and `←` `→`) | same | ±0.5 dB | — |
  | `Shift`+`↑`/`↓` | `⇧`+`↑`/`↓` | ±0.1 dB | — |
  | **`Alt`+`↑`/`↓`** | **`⌥`+`↑`/`↓`** | unity / −∞ | `Home` / `End` |
  | **`Shift`+`Alt`+`↑`/`↓`** | **`⇧`+`⌥`+`↑`/`↓`** | ±6 dB | `PgUp` / `PgDn` |

  *(The macOS column is LETTERING, not a second binding — Option is the key that
  sets `event.altKey`, so these chords always worked on a Mac and only said the
  wrong thing. It was reported by a user: someone reading `Alt` on an Apple
  keyboard does not own that key, so the shortcut did not exist for them. The
  `?` overlay now draws `⌥ ⇧ ⌃` there and the words elsewhere;
  `extension/ui/embed-state.js` owns the one platform test and pins the printed
  set to the modifiers `shortcut()` reads.)*

  *(**None of `Home`, `End`, `PageUp` or `PageDown` exists
  on a Mac laptop** — all four are `fn`+an arrow, which the browser frequently
  eats first — so both the ARIA landmark convention and the coarse step were, on
  that hardware, bindings with no keys. `Shift`+`↑`/`↓` was considered for the
  landmarks and refused: it is already the fine step. `Alt`+`←`/`→` was refused
  too — that is YouTube's chapter nav on macOS (`⌥`+`←`/`→`) and Chrome's
  back/forward elsewhere, so `Alt` is up-and-down only. The coarse chord had one
  real in-build collision: before it existed, `Shift`+`Alt`+`↑` fell through to
  the landmark case and was silently bound to unity. It is resolved by testing
  `Shift` first inside the `Alt` branch, and the browser gate pins the coarse
  step from `-1`, a value no landmark produces.)*

## Known debt this migration creates — track, do not silently absorb

1. **Pitch bank misses its deadline.** p95 was 2.616 ms against 2.902 ms with 4
   shifters, and the peak scales linearly with shifter count. Six harmonic
   stems is ~3.9 ms. Staggering the frame grids (`pitchbank.js` ponytail note)
   becomes mandatory, with a matching content-anchor change or Δ stops being 0.

   **The deadline miss was real, the ~3.9 ms projection was not the number that
   showed up, and the fix is the one this item named — but THE MILLISECONDS ARE
   WITHDRAWN and the claim now rests on frame counts.** Read this correction as
   two separate things: *the stagger works* (it does, and it is now proved by
   construction), and *every stopwatch figure this item ever quoted is
   uninterpretable on a contended machine* (including the ones this paragraph
   used to carry: 3.238 → 1.716 ms p95, means 0.744 → 0.775 ms, p50 at 77 % of
   budget, the adversarial 2.903 vs 2.902 ms. **They are left visible as the
   retracted record and must not be re-quoted.**)

   **The evidence for the withdrawal — three consecutive runs of IDENTICAL code:**

   | | run 1 | run 2 | run 3 |
   |---|---|---|---|
   | p95 (ms) | 0.997 | 0.991 | **1.685 ← a red on unmodified code** |
   | **peak frames / quantum** | **5** | **5** | **5** |
   | **mean frames** | **3.182** | **3.182** | **3.182** |

   **The wall clock swung 69 % and threw a false red; the counts did not move a
   digit.** A gate whose verdict changes on unmodified code is measuring the
   machine, and on this box that is what a millisecond is.

   **Re-grounded on the deterministic quantity:**

   | | peak | mean |
   |---|---|---|
   | 4 lanes colliding — *the four-stem build that shipped* | 8 | 2.121 |
   | 6 lanes colliding | 12 | 3.182 |
   | **6 lanes staggered — this build** | **5** | 3.182 |

   **3.182 / 2.121 = 1.500 exactly. Six stems do 1.5× the work and nothing makes
   them not** — the stagger moves **peaks, not means**, which is the same finding
   the withdrawn millisecond means were groping at, now stated in a unit that does
   not move. And the result that settles the design: **six staggered lanes pile up
   LESS than the four-lane build ever did — 5 against 8 — while carrying 1.5× the
   load.**

   > **Ratios and counts are citable; absolutes are not.** That is `AGENTS.md`
   > **O-6.7**'s rule, and this is the **second instrument** it has had to be
   > applied to — CPU RTF first, now the pitch bank's quantum timer. **It is a
   > pattern, not a one-off:** on this hardware, any figure whose between-session
   > variance exceeds its within-session spread is a property of the day. When a
   > claim can be re-grounded on a count, re-ground it rather than tightening the
   > tolerance around a stopwatch.
   >
   > **And do not reach for the obvious remedy — it was tried here and it made
   > the gate worse.** Same code, `1 deck at +6`, p50 over **800** quanta instead
   > of 8000: **1.872 ms → RED**, 0.918, 0.743. 8000 samples could *dilute* a slow
   > start and 800 could not, so **the median inherited the warm-up the larger
   > window's p95 had been hiding.** **Changing the sample size is not changing
   > the instrument** (`AGENTS.md` § *"Pick the estimator for the claim"*, (c)).

   **The surviving debt is unchanged, and it now rests on arithmetic instead of a
   stopwatch: the adversarial row CANNOT be staggered off.** Staggering
   redistributes peaks and removes no work; the mean is **1.5× by frame count**;
   and the four-lane build already ran *2 decks BOTH switching* at **90 % of
   deadline** — a **ratio**, which survives the withdrawal above; the absolute it
   came from does not, and is not needed. **1.5× the work does not fit in the
   remaining 10 %** — that is the whole argument, and it needs no timer.    debt.** Upgrade path *"the work has to come down, not move"* — fewer shifted
   lanes, a cheaper kernel, or a longer quantum. A second stagger pass is not one
   of the options, and neither is a re-measurement: **the arithmetic does not get
   better on a quiet machine.**

   ✅ **RESOLVED — the all-zero stagger vector was hypothesis (a), an artifact of
   the observed tree, not a defect.** The engine track had zeroed
   `PITCH_GRID_OFFSETS` **five times** to take collide-baselines; the save files
   were still on disk with matching timestamps, and one of those windows was a
   **deliberate** full-suite run with the vector zeroed **to prove the deadline
   assertion could go red** — it printed `staggered by [0,0,0,0,0,0]`, which is
   QA's run 1. *(Two different p95s are quoted for that window in the two reports
   of it — 3.529 ms and 3.193 ms. With the frame counts fixed, that 10 % spread is
   the instrument, and it is a second, incidental instance of the withdrawal
   above.)*

   > **(b) was tested anyway, and that is the half that earned the ruling.** Nine
   > construction paths, **26 bank states** — first engage unrendered, mid-switch,
   > latched, second and third switch, down to zero and re-engaged, `reset()` at
   > +6, `reset()` **during** a switch, the dragged-control pending queue, and the
   > worklet's rebuild path. **All 26 correctly staggered; no path reaches a
   > running state unstaggered.** Pinned by a two-halved assertion that goes red
   > for the **wrong-constant** case and the **missing-application** case with
   > *different messages*.
   >
   > **"We could not reproduce it" and "we proved it cannot happen" are different
   > claims, and only the second one earned this.** The reproduction was explained
   > by the observer's own tree — which is exactly the evidence that feels like
   > closure and is not, because it says nothing about whether the state is
   > reachable by some other route. **When an anomaly dissolves into an artifact,
   > test the mechanism anyway.**
2. **`DUAL_MASTER_TRIM_DB = -3` was measured with four stems.** Re-measure with
   `tools/mashup-probe.mjs`; do not edit the expected number to match.

   **Still open, and it has been open longer than it looked.** The assertion
   that appeared to cover it — *"four stems at +6 dB cannot leave the DAC
   clipping"* — **was saturated and could never have gone red**: `applyCurve`
   clamps to ±1 after the divide, so every input ≥ 2.0 returns the identical
   `0.999916`, at four stems or sixty. It was standing in for this question while
   answering a constant. `AGENTS.md` § *"Pick the estimator for the claim"*, (a).
3. **Memory.** Stem ring 21.0 → 29.4 MB per deck. Export OLA 338 → 508 MB for
   4 min. 16-bit cache 169 → ~254 MB/track, so the 4 GiB LRU holds ~16 tracks,
   not ~25.

   **The three figures above stand. What this item did not predict is that the
   MODEL got smaller** — 172 MiB at four stems, **114,559,139 B = 109 MiB** at
   six, i.e. **66 MB less**, because `htdemucs_6s` drops the transformer
   bottleneck (27.4 M params and `bottom_channels=0` against 41.9 M and 512).
   The item counted only the things that grew, which is the natural bias of a
   migration debt list and worth naming: **"six stems costs more memory" is true
   of the ring, the OLA and the cache, and false of the weights.**
4. ~~**No ground truth for the new stems.**~~ **CLOSED — and REPLACED, because
   the closure exposed a different defect underneath it.** *()*

   The original entry read: *`docs/snippets/make-testbed.js` synthesises exactly
   four sources. Until it emits guitar and piano, every downstream quality gate is
   4 stems wide and the two new ones read green by reading nothing.* **Both halves
   are now closed, by two different artifacts:**

   | half | what closed it |
   |---|---|
   | **synthetic** | `docs/snippets/make-testbed.js` emits **six** sources. Reconstruction **−144.5 dB**, against a worst-single-omission control of **−6.3 dB** — and the control is the load-bearing half: it is what proves the null can still *lose* when a stem is missing, which is exactly the failure the padded 4-stem null could not see (`AGENTS.md` § *"When you write a control, check that the control CAN LOSE"*) |
   | **real music** | a **CC BY 2.5** fixture that exercises all six stems through the real model: drums **−23.0**, bass **−13.0**, other **−23.9**, vocals **−23.8**, guitar **−19.6**, piano **−18.9 dBFS**. **Not committed** — the fixture is copyrighted material fetched locally, and the repo redistributes no audio |

   > **4′. THE SURVIVING DEBT — THE RUN WINDOW, NOT THE FIXTURE.** The old
   > fixture's `bass` was never *depleted*; **the run window was.**
   > `mix_full.wav` has **no bass for its first 31 seconds**, so any live QA run
   > that starts at t=0 and lasts under ~31 s gates `bass` on a passage that
   > contains none.
   >
   > **A new fixture does not fix a run window.** A six-stem fixture guarantees
   > the *file* contains every stem; it guarantees nothing about the **seconds
   > the harness actually samples**, and a short run starting at t=0 can be
   > stem-blind on a file that is fully populated. Any gate asserting a stem is
   > present must state the window it sampled, and either start past the intro or
   > run long enough to reach the stem.
   >
   > **This is ORTHOGONAL to stem count. It would have been true at four stems
   > and nobody noticed** — QA-22 read it as "the fixture has no bass", which was
   > the wrong diagnosis of the right symptom, and the fix everyone reached for
   > (a better fixture) would not have moved it. It is the same shape as
   > the short-soak trap one level down: **the estimator was the
   > window, not the material.**
