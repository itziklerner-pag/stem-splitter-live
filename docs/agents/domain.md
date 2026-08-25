# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo: one `CONTEXT.md` and one `docs/adr/`, both at the root.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If these files don't exist, **proceed silently**. Don't flag their absence; don't
suggest creating them upfront. The producer skills (`/grill-with-docs`,
`/domain-modeling`) create them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
├── extension/
├── tools/
└── qa/
```

There is no `CONTEXT-MAP.md`; if one ever appears at the root, this repo has moved
to a multi-context layout and per-context `CONTEXT.md` files take precedence.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to
synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're
inventing language the project doesn't use (reconsider) or there's a real gap (note
it for `/grill-with-docs`).

Note that this repo already carries prose that fixes some vocabulary — notably
[`docs/SIX-STEM-CONTRACT.md`](../SIX-STEM-CONTRACT.md),
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) and [`docs/AUDIO.md`](../AUDIO.md).
Those are not a substitute for `CONTEXT.md`, but where they define a term, that
definition wins.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
