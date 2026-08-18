# Architecture Decision Records

This directory holds Architecture Decision Records (ADRs) — long-form
records for decisions where the rationale is too rich for the
one-paragraph `D-NNN` entries in `docs/decisions.md`.

## When to write an ADR

Write an ADR when:

- The decision is a **deviation from a planned approach** documented
  elsewhere (e.g., a architectural approved swap from a previously
  planned vendor / dependency / structural choice).
- The decision has **non-obvious tradeoffs** that future-you or a
  reviewer will need to reconstruct ("why did we pick X over Y when Y
  was the obvious choice?").
- The decision has **explicit revisit triggers** (capacity, cost,
  compliance, vendor change) that need to be persisted alongside the
  decision so we don't forget when to re-evaluate.

For routine decisions inside the locked stack, the one-paragraph
`D-NNN` entry in `decisions.md` is enough. ADRs are reserved for the
load-bearing contextual decisions.

## Format

```
# ADR-NNN — Short title

**Status:** Proposed | Accepted | Superseded by ADR-MMM | Deprecated
**Date:** YYYY-MM-DD
**Tier:** 1 | 2 | 3 (per AGENTS.md autonomy tiers)
**Related D-entry:** D-NNN (if applicable)
**Related V-entry:** V-NNN (if applicable)

## Context

What is the problem? What was the planned approach (if it differs
from what landed)? What constraints apply (technical, commercial,
regulatory, operational)?

## Decision

The choice that was made, stated clearly and tersely. One paragraph.

## Consequences

What does this enable? What does this rule out? What new operational
load does it create? What does it cost?

## Alternatives considered

Each viable alternative + why it was not chosen. Include the planned
approach if it was rejected.

## Revisit triggers

Specific conditions that should prompt re-evaluation of this decision.
Format each as a bullet that names the triggering condition + the
metric or event that detects it.
```

## Status

Four values, and nothing else:

- **Proposed** — written, not yet reviewed. The decision it records may
  already be implemented; being built is not the same as being agreed,
  and this status says which one is outstanding.
- **Accepted** — reviewed and in force.
- **Superseded by ADR-MMM** — replaced. The replacement must exist.
- **Deprecated** — no longer in force and not replaced.

`Proposed` was added to this list on 2026-08-18. Two ADRs had been
using it since May while this section allowed only the other three, so
the format spec and the record it describes disagreed for three months
in the one place a reader goes to learn what a status means.

## Numbering

ADRs are numbered sequentially as `ADR-001`, `ADR-002`, etc. Numbers
are never reused, even if an ADR is superseded — the superseded ADR
keeps its number and gets `Status: Superseded by ADR-MMM` in its
header. The history matters; the number is part of the record.

## Index

- [ADR-001](ADR-001-control-plane-hosting-hetzner.md) — Control-plane
  hosting on Hetzner Cloud (architectural deviation from PaaS plan).
- [ADR-002](ADR-002-stripe-only-payment-processing.md) — Stripe-only
  payment processing at launch (architectural deviation from Mollie-primary
  - Stripe-backup plan).
- [ADR-003](ADR-003-paid-trial-pack-replaces-free-tier.md) — $2.99
  paid trial pack replaces the free tier (explicit deviation from
  parent driftstack repo file 127 §6).
- [ADR-004](ADR-004-pricing-restructure-two-ladder.md) — Pricing
  restructure to two-ladder concurrent-only (explicit deviation from
  parent driftstack repo file 127 single-ladder hours-with-overage
  design).
