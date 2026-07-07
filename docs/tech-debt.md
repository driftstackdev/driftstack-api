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

## TD-001 — Driftstack-branded billing receipts — RESOLVED 2026-07-07

**Source:** V-202b (founder verdict 2026-05-05).
**Resolution:** Landed as S44 2026-07-07 (founder-approved wire-in).
`invoice.payment_succeeded` / `invoice.payment_failed` now dispatch
`billing.payment_succeeded` / `billing.payment_failed` lifecycle events
through `AccountLifecycleService` → `sendBillingReceipt` /
`sendBillingFailure`. Per the founder-approved S44 spec the receipt uses
the standard V-204 `billing-receipt` opt-OUT preference (superseding the
Phase-1 opt-IN toggle sketched below); the failure notice is never
opt-outable. Stripe's own processor receipts remain enabled (augment
posture — the Phase-2 flip below stays a future option). Dedup rides the
`processed_stripe_events` ledger; zero-amount invoices are skipped. The
original entry is retained below for the record.

**Current state (historical):** Stripe's own infrastructure fires billing receipts
(`payment_succeeded` / `payment_failed`) directly to the customer's email
on file. Driftstack templates exist (`sendBillingReceipt`,
`sendBillingFailure`) and are listed in the V-204 opt-out preference
set, but the wire-in at the `invoice.payment_*` Stripe handler points
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

## TD-002 — Drizzle-kit reinstatement (auto-update journal + snapshots) — RESOLVED 2026-05-06

**Source:** V-228 (Drizzle migration journal regression catch).
**Resolution:** Landed in **V-231** per founder-approved Option A; pre-push backstop added; future migrations land cleanly.

**What landed:**

- `drizzle-orm@^0.38.4` added to root `devDependencies` so the existing root-level `drizzle-kit` CLI can resolve the schema. Existing root `drizzle.config.ts` (already pointing at `apps/server/src/db/schema.ts`) now functional.
- `apps/server/src/db/migrations/0022_consolidate_snapshot.sql` lands as a comment-only no-op (the auto-generated SQL was NOT idempotent — would crash against any database that already ran 0017–0021). The auto-generated `meta/0022_snapshot.json` is the load-bearing artifact: future `drizzle-kit generate` runs diff against it cleanly.
- `.husky/pre-push` gains a journal-sync backstop: aborts push if any `*.sql` in `apps/server/src/db/migrations/` lacks a corresponding `"tag": "<filename>"` entry in `_journal.json`. Self-tested: green on real state; synthetic 9999-tag missing-entry correctly fails.

**Why the proposal's wording was revised mid-implementation:** drizzle-kit doesn't generate idempotent SQL by default. Caught + fixed inline rather than punting back to founder for a verdict refinement; the no-op approach achieves the same goal (snapshot directory becomes usable; migrator records idx 22 as applied without re-creating tables).

**Status going forward:**

- Adding a new migration: run `npm run db:generate -- --name=<short_descriptor>` from repo root; drizzle-kit auto-updates the journal + snapshot. Verified.
- Skipping the journal update is now structurally caught by the pre-push hook (V-231 backstop). V-228-class regressions cannot recur.
- Snapshot directory has 0000–0006 + 0022. 0007–0021 remain absent (intentional; the proposal's Option A explicitly accepts this gap). Diffs from 0022 onward are clean.

See V-231 V-log entry for the full reasoning chain.

---

## TD-003 — V-184b onboarding visual UX polish

**Source:** V-235 (founder direction 2026-05-06: "V-184b copy redline NOT done now").
**Status:** Deferred post-launch.

**Current state:** Functional onboarding flow exists (signup → verify-email → welcome → select-tier → first-session) per V-184a / V-217. All five pages work end-to-end against the V-049 / V-202c lifecycle. The visual UX is V-184a Tier-1 scaffolding placeholder copy + minimal styling.

**Why deferred:**

- V-184b is visual polish ON TOP of working onboarding, not a launch blocker.
- Tier-3 copy decisions need founder energy + focus; founder is currently directing all attention at the GUI client launch arc (V-235 onwards).
- Onboarding visual polish benefits from real customer feedback signals — better to ship as-is, observe which sections customers stumble on, then redline with data rather than guesses.

**Revisit triggers:**

1. First paying customers report onboarding friction in a specific page (e.g. "I didn't understand which tier to pick"). The data points to which page needs the redline first.
2. Conversion-rate telemetry on the onboarding funnel (post-launch ETA) shows a clear drop-off step.
3. Founder bandwidth opens up post-launch and the polish becomes the highest-leverage T3 work.

**Implementation when revived:** The proposal at `docs/proposals/post-launch/v-184b-onboarding-visual-scope.md` carries the per-page scope outline + `[FOUNDER COPY]` markers. Founder reds in copy + structure picks → autopilot lands per-page Astro edits as V-184b-1 through V-184b-5. Estimated mechanical-edit effort: ~30min per page once founder copy is set.

---

## How to add an entry

1. The deferral decision must already be recorded in a V-log entry.
2. Reserve a TD-NNN id by appending below the most recent entry.
3. Cross-reference: V-log entry should mention "see TD-NNN"; this doc
   should mention "see V-NNN".
4. Keep entries short. The V-log carries the full reasoning; this
   ledger is just the index.
