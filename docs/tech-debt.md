# Technical debt ledger

Append-only log of deferred work that has been identified, discussed,
and consciously put off — typically because the right time to land it
is post-launch (real customer feedback) or because doing it now creates
more risk than the value it adds.

This is NOT a TODO list. Items here have already been considered
against current priorities and are EXPLICITLY deferred. New work goes
into the V-log queue; debt entries here are referenced from V-log
entries that recorded the deferral decision.

Format: each entry has a stable id (TD-NNN), the deferral source
(V-NNN entry where the decision was recorded), trigger conditions for
revisiting, and implementation notes for whoever picks it up.

---

## TD-001 — Driftstack-branded billing receipts

**Source:** V-202b (founder verdict 2026-05-05).

**Current state:** Stripe's own infrastructure fires billing receipts
(payment*succeeded / payment_failed) directly to the customer's email
on file. Driftstack templates exist (`sendBillingReceipt`,
`sendBillingFailure`) and are listed in the V-204 opt-out preference
set, but the wire-in at the `invoice.payment*\*` Stripe handler points
is intentionally not done.

**Why deferred:** Stripe receipts are a solved problem — legally
compliant (tax-included, receipt-trail-acceptable for accounting),
infrastructure-free (Stripe SLA covers delivery), and customer-
trusted (customers recognize Stripe-branded receipts). Augmenting
(both Stripe AND Driftstack fire on each charge) creates two-emails-
per-charge spam. Replacing entirely creates a delivery dependency:
a Driftstack-side outage during a Stripe charge means no receipt at
all, with no easy fallback. Skip is the conservative choice; reversal
is straightforward when the customer-feedback signal arrives.

**Revisit triggers:**

1. Customer feedback explicitly asks for Driftstack-branded receipts
   (e.g. "I get receipts from Stripe, but I want them to look like
   Driftstack so my accounting team recognizes them").
2. Stripe's auto-receipt feature degrades (delivery issues, template
   inflexibility blocks a real need).
3. We need to attach Driftstack-specific information to the receipt
   that Stripe's template can't carry (e.g. tier-specific welcome
   copy on first paid period; usage summary on renewal).

**Implementation when revived:** Use `AccountLifecycleService` (V-202c
abstraction). Add a `billing.receipt_succeeded` and
`billing.payment_failed` `LifecycleEvent` kind. Wire at the matching
`invoice.payment_succeeded` / `invoice.payment_failed` Stripe handler
points. Recommend "augment-then-eventually-replace" rollout:

- Phase 1: Both Stripe AND Driftstack fire. Customer-controlled toggle
  (separate from V-204 opt-out — this would be opt-IN to Driftstack
  receipts because the default is "Stripe only"). Validate template
  - delivery against real charges.
- Phase 2: Once stable, flip default to Driftstack-only. Disable
  Stripe's auto-receipts via the Stripe dashboard for the relevant
  product (Stripe supports per-product receipt suppression).

The V-204 `billing-receipt` opt-out preference key is already in the
catalog and would naturally apply to Phase 1 + Phase 2.

---

## TD-002 — Drizzle-kit reinstatement (auto-update journal + snapshots)

**Source:** V-228 (Drizzle migration journal regression catch).

**Current state:** Hand-edited `_journal.json` for migrations 0017–0020.
Snapshots only exist for 0000–0006 (drizzle-kit was used for those;
discontinued afterward). The hand-edited journal works for `migrate()`
application but means:

1. New migrations require manually appending an idx + tag entry to the
   journal. Easy to forget (this is what V-228 caught).
2. Snapshots can't be regenerated cleanly — drizzle-kit's `generate`
   would produce a giant diff against the schema state from 0006.

**Why deferred:** Reinstating drizzle-kit requires a one-time cleanup
pass (regenerate ALL snapshots from the current schema, or accept the
0007–0020 snapshot gap permanently). The V-223 pre-push gate doesn't
cover migration application, so the fail-fast feedback loop for "did
I update the journal?" is weak. Adding it to the gate requires Docker
in CI/pre-push, which V-223 explicitly excluded.

**Revisit triggers:**

1. A second journal-out-of-sync regression occurs (would prove
   hand-editing isn't sufficient).
2. A schema change requires drizzle-kit's diff-generation specifically
   (e.g. an enum mutation that's painful to write by hand).
3. CI infrastructure adds Docker + Postgres for e2e tests (would
   provide the fail-fast loop).

**Implementation when revived:**

- Install `drizzle-kit` in `apps/server/package.json` devDeps.
- Add a `drizzle.config.ts` pointing at `src/db/schema.ts` +
  `src/db/migrations/`.
- Run `drizzle-kit generate` on the current schema → expect a single
  consolidated migration that captures the 0007–0020 schema delta.
  Either (a) accept that as `0021_consolidated_snapshot.sql` and
  acknowledge the gap, or (b) drop and recreate snapshots 0007–0020
  by hand-editing `meta/_journal.json` to claim each existing SQL
  file is the canonical migration for that idx.
- Add a `drizzle:generate` npm script.
- Update the pre-push hook (or CI workflow) to fail if a new SQL file
  in `src/db/migrations/` lacks a journal entry.

---

## How to add an entry

1. The deferral decision must already be recorded in a V-log entry.
2. Reserve a TD-NNN id by appending below the most recent entry.
3. Cross-reference: V-log entry should mention "see TD-NNN"; this doc
   should mention "see V-NNN".
4. Keep entries short. The V-log carries the full reasoning; this
   ledger is just the index.
