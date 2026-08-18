# Writing assertions

Read this before you write a test in this repo. It is not style guidance. It is a
record of assertions that **could not fail**, each of which cost real investigation
time to find out — and finding out is the expensive part, because from the outside
a broken assertion and a broken program look identical.

It applies to humans and to coding agents equally. If you are an agent working in
this repo, this file plus [`CONTRIBUTING.md`](CONTRIBUTING.md) are your operating
rules.

---

## The core problem

Three consecutive changes here were reported as "N of N passing", none reproduced,
and in all three **the code was fine and the assertion was wrong**. A fourth was a
gate that hardcoded a timing constant while the engine *explicitly promised* to
defer a mid-run change of that constant to the next start — so it demanded an
invariant the code advertised that it does not hold. The evidence was a committed
log showing the identical failure long before the feature it supposedly tested
existed.

That is not four unlucky bugs. It is the single most-repeated failure in this
project's history.

> **An assertion encoding an invariant the code never promised costs exactly as
> much investigation time as a real defect** — and it also trains everyone to
> distrust reds, which is the more expensive half.

---

## An assertion about a function with more than one caller must name the entry point

If it holds at one call site and not another, that is two assertions, not one loose
one. **Five separate defects here came from a value being right at one call site
and wrong at another.**

*Worked example.* One unreliable latency assertion became three reliable ones, each
testing a single thing at a single entry point:

| | tests |
|---|---|
| `budget-tracks-hop` | arithmetic |
| `measured-never-below-budget` | physics |
| `measured-tracks-hop` | behaviour |

### Corollary: if a comment above an assertion documents an exception, the assertion must encode the exception or be deleted

The case that proves it: a comment described the ladder entry point, where
`firstChunkMs` is still `0` — and the assertion did not admit it. It then **passed
trivially** on one run (`1598.4 >= 0`) for the *same reason* it failed on the next.

> **An assertion that passes because a value was never recorded is worse than no
> assertion**, because it reports coverage it does not have.

---

## Pick the estimator for the claim

A ±3 dB tone bin can carry a 20 dB presence/absence claim and cannot carry a "still
at full level" claim. Two of the three assertion bugs above were this, not logic.

One idea, three faces:

### a. Range, not just precision

**An estimator that saturates before the claim's range begins can never go red.**

*"Four stems at +6 dB cannot leave the DAC clipping"* looked right, computed
something, and could not fail: `applyCurve` clamps to ±1 **after** the divide, so
every input ≥ 2.0 returns the identical `0.999916` — at four stems, six, or sixty.
The condition was right, the arithmetic was right, and the dynamic range had been
removed three lines upstream. It stood in for the master-headroom question for the
life of the project while answering a constant.

Padding a fixture and defaulting a missing field do the same thing by other means.

### b. If a claim can be carried by a COUNT, do not carry it with a stopwatch

Three runs of **identical code** put a pitch bank's p95 at **0.997 / 0.991 / 1.685
ms** — a 69 % swing, and a red on an unmodified tree — while **peak frames per
quantum read 5 / 5 / 5 and mean frames 3.182 / 3.182 / 3.182.**

> **A gate whose verdict changes on code that did not change is measuring the
> machine.**

Re-grounded on counts, the claim is exact: six lanes do **1.500×** the work of four
(3.182 / 2.121), and six *staggered* lanes pile up **less than four colliding ones
ever did** (5 against 8).

> **Ratios and counts are citable. Absolutes are not.**

### c. "Sample it less" is the reflex that looks like it respects (b) and does not

Same code, p50 over **800** quanta instead of 8000: **1.872 ms → RED**, then 0.918,
then 0.743. **The smaller window made the gate worse.** 8000 samples could *dilute*
a slow start; 800 could not, so the median inherited the warm-up the larger
window's p95 had been hiding. Shrinking removed the dilution that was concealing a
systematic bias, not the noise.

> **There is no window size that fixes an estimator problem.**

**The discriminator, because the lesson is NOT "never shrink":** the same work then
cut a fixture from 40 s to a few seconds with no ill effect — **because that
assertion counts allocations and never reads a clock.** Two shrinks, opposite
outcomes, one question:

> **Does the assertion read a clock?**

Take "don't shrink windows" as the lesson and you refuse a free optimisation; take
"shrinking is fine" and you re-create the flake.

### The three questions, in order of cheapness

1. **Name the value that would make this assertion go red — and ask whether it is
   reachable in this build.**
2. **Break the thing on purpose and confirm the assertion notices.** An assertion
   never observed failing is one whose ability to fail is an assumption.
3. **Re-ground the claim before you touch the tolerance or the window.** Changing
   the sample size is not changing the instrument.

---

## An assertion must FAIL when it cannot look

A guard of the form `!x || (real check)` **passes when `x` is absent** — so the
assertion reports coverage *precisely when it has none*.

> **If the thing being inspected is missing, that is the failure, not an excuse
> from it.**

Applies to `undefined` payload fields, unsampled inputs, and every "we could not
measure" branch.

**Twenty instances of this were found in this one codebase**, which is why it is a
rule and not a note. Ten of them came out of a deliberate audit rather than falling
out of other work — and **only one of the ten was on the recon list drawn up at the
start of that audit.** Grepping for the syntactic form accounts for one of the ten;
the other nine had to be read, one assertion at a time. That is the argument for
scheduling this as its own audit instead of expecting it to surface on its own.

The first four, kept as the short form of the list:

| # | assertion | how it was vacuous |
|---|---|---|
| 1 | the audio-thread read-back | the stats message sends `worklet: {A, B}` at the **top level**; the assertion read `d.A.worklet` → `undefined` → `!wr \|\| …` short-circuits. **It had never once executed a comparison.** |
| 2 | four `!clean \|\|` mixer guards | stopped measuring above a 10 % drop rate and reported PASS. `clean` is **a property of the system under test**, so it also broke the independence rule below. |
| 3 | *"the captured input contained no digital silence"* | passed on `!inputSilence` — **claiming the input was clean on runs where it was never sampled.** The name asserted a fact the code never checked. |
| 4 | `armMs >= firstChunkMs` | passed vacuously whenever `firstChunkMs` was `0`. |

> **"A skipped assertion at least moves the count you were diffing; a vacuous one
> is invisible at any denominator."**

This is the same idea as `tools/verify.mjs`'s **VOID** rule — *"exited 0 but
asserted nothing — silence is not a pass"* — one level down: from the suite to the
individual assertion. One principle, two scales. A suite that asserts nothing and
an assertion that inspects nothing both report green for the same reason, and
neither is detectable from the exit code.

**The related rule this keeps colliding with:** an instrument may excuse itself only
on evidence **independent of the thing it is measuring**. Instance 2 above breaks
both rules at once — it excused itself on `clean`, which is the system under test.

**And the sibling failure this rule does NOT describe:** an assertion that *could*
look, *did* compute, and still could not go red. That is an estimator-range defect,
and it is under *Pick the estimator for the claim* above. Both report coverage they
do not have; they are found by different questions, which is why they are written
down separately.

---

## When you write a control, check that the control CAN LOSE

The STFT parity gate's first stereo control used **mono-duplicated** stimuli — and a
channel-swap permutation on mono-duplicated stereo is a mathematical **no-op**. The
wrong packing scored *identically* to the right one, and would have been reported as
"control confirms".

> **A control that cannot distinguish the hypothesis from its negation is not a
> control.** It is a second copy of the measurement wearing the word "control".

In its first form, the gate that proves the STFT packing had **no ability to reject
any packing at all** — and a wrong packing separates plausibly and incorrectly with
no error, so nothing else would have caught it. Fixed, the discrimination is now the
evidence: **2.43e-05–4.13e-05** for the shipped packing against **0.0515–1.318** for
the three wrong ones.

---

## An assertion parked on an "expected red" list stops being read at all

A known-red entry is the only kind of red nobody investigates **when it changes
meaning**, because the list exists precisely to stop people looking. That is how the
hop-display assertion described at the top of this file survived its own fix
landing. The list that taught this lesson was deleted for exactly that reason, and
**both** of its entries were stale when it went.

> **A red is either investigated, or the assertion is corrected.**

If a failure is genuinely acceptable for now it belongs in `tools/verify.mjs`'s
`FLAKY` carve-out — narrow, printed in full whenever it fires, scoped by section
*and* assertion text — and **it carries an expiry condition: what must become true
for it to stop being acceptable, and what happens if that never arrives.** An entry
without one is invisible, which is the whole mechanism above.

---

## Checklist

Before you commit an assertion:

- [ ] Can I name a concrete value that makes it go red, and is that value reachable?
- [ ] Have I watched it fail? (Break the code on purpose.)
- [ ] Does it read a clock? If so, can the claim be carried by a count instead?
- [ ] Does it short-circuit on anything being absent? If so, that branch must fail.
- [ ] Does it excuse itself on evidence from the system under test?
- [ ] Does the function it covers have more than one caller? Then name the entry point.
- [ ] If there is a control, can the control lose?
- [ ] If a comment above it documents an exception, does the assertion encode it?
