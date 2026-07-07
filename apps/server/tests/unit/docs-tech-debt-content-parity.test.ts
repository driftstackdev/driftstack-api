// W546.B — drift guard for /docs/tech-debt.md.
// Append-only technical-debt ledger. Drift here either drops the
// 'NOT a TODO list' framing (would let routine TODOs pollute the
// ledger), changes the TD-NNN id-reservation scheme (would break
// cross-reference parity with V-log entries), or weakens the
// 'append-only + reference-from-V-log' contract.
//
//   • Append-only log of deferred work.
//   • NOT a TODO list — entries already considered + explicitly
//     deferred.
//   • Format: TD-NNN + deferral source (V-NNN) + trigger conditions
//     + implementation notes.
//   • TD-001 — Driftstack-branded billing receipts (V-202b deferral
//     → RESOLVED 2026-07-07 by the S44 founder-approved wire-in).
//   • TD-002 — Drizzle-kit reinstatement (V-228 → RESOLVED in V-231).
//   • TD-003 — V-184b onboarding visual polish (V-235 deferred
//     post-launch).
//   • Add-entry checklist: 1. deferral in V-log 2. reserve TD-NNN
//     3. cross-reference 4. short entry.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/tech-debt.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W546.B /docs/tech-debt.md content parity', () => {
  const body = read(LIB);

  it("Header + append-only + NOT-a-TODO + TD-NNN format framing pinned: '# Technical debt ledger' + 'Append-only log of deferred work that has been identified, discussed, and consciously put off — typically because the right time to land it is post-launch (real customer feedback) or because doing it now creates more risk than the value it adds.' + 'This is NOT a TODO list. Items here have already been considered against current priorities and are EXPLICITLY deferred. New work goes into the V-log queue; debt entries here are referenced from V-log entries that recorded the deferral decision.' + 'Format: each entry has a stable id (TD-NNN), the deferral source (V-NNN entry where the decision was recorded), trigger conditions for revisiting, and implementation notes for whoever picks it up.' — pinned so the append-only-not-TODO + post-launch-or-risk-now + TD-NNN id + deferral-source-V-NNN + trigger-conditions + implementation-notes-4-element commitment survives", () => {
    expect(body).toMatch(/^# Technical debt ledger$/m);
    expect(body).toMatch(/Append-only log of deferred work that has been identified, discussed,/);
    expect(body).toMatch(/and consciously put off — typically because the right time to land it/);
    expect(body).toMatch(
      /is post-launch \(real customer feedback\) or because doing it now creates/,
    );
    expect(body).toMatch(/more risk than the value it adds\./);
    expect(body).toMatch(/This is NOT a TODO list\. Items here have already been considered/);
    expect(body).toMatch(/against current priorities and are EXPLICITLY deferred\. New work goes/);
    expect(body).toMatch(/into the V-log queue; debt entries here are referenced from V-log/);
    expect(body).toMatch(/entries that recorded the deferral decision\./);
    expect(body).toMatch(/Format: each entry has a stable id \(TD-NNN\), the deferral source/);
    expect(body).toMatch(/\(V-NNN entry where the decision was recorded\), trigger conditions for/);
    expect(body).toMatch(/revisiting, and implementation notes for whoever picks it up\./);
  });

  it("TD-001 Driftstack-branded billing receipts — RESOLVED 2026-07-07 (S44 founder-approved wire-in; receipt = V-204 opt-OUT superseding the Phase-1 opt-IN sketch, failure notice never opt-outable, original entry retained as history) — framing pinned: '## TD-001 — Driftstack-branded billing receipts — RESOLVED 2026-07-07' + '**Source:** V-202b (founder verdict 2026-05-05).' + 'Stripe's own infrastructure fires billing receipts (payment*succeeded / payment_failed) directly to the customer's email on file.' + 'Stripe receipts are a solved problem — legally compliant (tax-included, receipt-trail-acceptable for accounting), infrastructure-free (Stripe SLA covers delivery), and customer-trusted (customers recognize Stripe-branded receipts).' + 'Augmenting (both Stripe AND Driftstack fire on each charge) creates two-emails-per-charge spam.' + 'Replacing entirely creates a delivery dependency: a Driftstack-side outage during a Stripe charge means no receipt at all, with no easy fallback. Skip is the conservative choice; reversal is straightforward when the customer-feedback signal arrives.' + 'Use `AccountLifecycleService` (V-202c abstraction). Add a `billing.receipt_succeeded` and `billing.payment_failed` `LifecycleEvent` kind.' + '\"augment-then-eventually-replace\" rollout' + 'V-204 `billing-receipt` opt-out preference key is already in the catalog and would naturally apply to Phase 1 + Phase 2.' — pinned so the V-202b-deferral + Stripe-solved-tax-trail-customer-trust + 2-emails-spam-risk + V-202c AccountLifecycleService + V-204 billing-receipt-opt-out-key + augment-then-replace-rollout commitment survives", () => {
    // S44 2026-07-07 — TD-001 is RESOLVED (founder-approved wire-in);
    // heading carries the RESOLVED marker like TD-002, the resolution
    // block records what landed, and the original entry is retained
    // as the historical record (all original pinned phrases below
    // still hold against that retained body).
    expect(body).toMatch(/## TD-001 — Driftstack-branded billing receipts — RESOLVED 2026-07-07/);
    expect(body).toMatch(
      /\*\*Resolution:\*\* Landed as S44 2026-07-07 \(founder-approved wire-in\)\./,
    );
    expect(body).toMatch(/`invoice\.payment_succeeded` \/ `invoice\.payment_failed` now dispatch/);
    expect(body).toMatch(
      /uses\s*\n?the standard V-204 `billing-receipt` opt-OUT preference \(superseding the\s*\n?Phase-1 opt-IN toggle sketched below\)/,
    );
    expect(body).toMatch(/the failure notice is never\s*\n?opt-outable\./);
    expect(body).toMatch(/\*\*Current state \(historical\):\*\*/);
    expect(body).toMatch(/\*\*Source:\*\* V-202b \(founder verdict 2026-05-05\)\./);
    expect(body).toMatch(/Stripe's own infrastructure fires billing receipts/);
    expect(body).toMatch(
      /\(`payment_succeeded` \/ `payment_failed`\) directly to the customer's email/,
    );
    expect(body).toMatch(/Stripe receipts are a solved problem — legally/);
    expect(body).toMatch(/compliant \(tax-included, receipt-trail-acceptable for accounting\),/);
    expect(body).toMatch(/infrastructure-free \(Stripe SLA covers delivery\), and customer-/);
    expect(body).toMatch(/trusted \(customers recognize Stripe-branded receipts\)\./);
    expect(body).toMatch(/Augmenting/);
    expect(body).toMatch(/\(both Stripe AND Driftstack fire on each charge\) creates two-emails-/);
    expect(body).toMatch(/per-charge spam\./);
    expect(body).toMatch(/Replacing entirely creates a delivery dependency:/);
    expect(body).toMatch(/a Driftstack-side outage during a Stripe charge means no receipt at/);
    expect(body).toMatch(/all, with no easy fallback\. Skip is the conservative choice; reversal/);
    expect(body).toMatch(/is straightforward when the customer-feedback signal arrives\./);
    expect(body).toMatch(/Use `AccountLifecycleService` \(V-202c/);
    expect(body).toMatch(/abstraction\)\. Add a `billing\.receipt_succeeded` and/);
    expect(body).toMatch(/`billing\.payment_failed` `LifecycleEvent` kind\./);
    expect(body).toMatch(/"augment-then-eventually-replace" rollout:/);
    expect(body).toMatch(/The V-204 `billing-receipt` opt-out preference key is already in the/);
    expect(body).toMatch(/catalog and would naturally apply to Phase 1 \+ Phase 2\./);
  });

  it("TD-002 Drizzle-kit reinstatement RESOLVED framing pinned: '## TD-002 — Drizzle-kit reinstatement (auto-update journal + snapshots) — RESOLVED 2026-05-06' + '**Source:** V-228 (Drizzle migration journal regression catch).' + '**Resolution:** Landed in **V-231** per founder-approved Option A; pre-push backstop added; future migrations land cleanly.' + '`drizzle-orm@^0.38.4` added to root `devDependencies`' + '`apps/server/src/db/migrations/0022_consolidate_snapshot.sql` lands as a comment-only no-op' + 'The auto-generated `meta/0022_snapshot.json` is the load-bearing artifact: future `drizzle-kit generate` runs diff against it cleanly.' + '`.husky/pre-push` gains a journal-sync backstop: aborts push if any `*.sql` in `apps/server/src/db/migrations/` lacks a corresponding `\"tag\": \"<filename>\"` entry in `_journal.json`.' + 'V-228-class regressions cannot recur.' + 'Snapshot directory has 0000–0006 + 0022. 0007–0021 remain absent (intentional; the proposal's Option A explicitly accepts this gap).' — pinned so the V-228-trigger + V-231-resolution + drizzle-orm-^0.38.4-added + 0022-comment-only-no-op + 0022_snapshot.json-load-bearing + .husky/pre-push-journal-sync-backstop + V-228-class-regressions-cannot-recur + 0007-0021-gap-accepted commitment survives", () => {
    expect(body).toMatch(
      /## TD-002 — Drizzle-kit reinstatement \(auto-update journal \+ snapshots\) — RESOLVED 2026-05-06/,
    );
    expect(body).toMatch(/\*\*Source:\*\* V-228 \(Drizzle migration journal regression catch\)\./);
    expect(body).toMatch(
      /\*\*Resolution:\*\* Landed in \*\*V-231\*\* per founder-approved Option A; pre-push backstop added; future migrations land cleanly\./,
    );
    expect(body).toMatch(/`drizzle-orm@\^0\.38\.4` added to root `devDependencies`/);
    expect(body).toMatch(
      /`apps\/server\/src\/db\/migrations\/0022_consolidate_snapshot\.sql` lands as a comment-only no-op/,
    );
    expect(body).toMatch(
      /The auto-generated `meta\/0022_snapshot\.json` is the load-bearing artifact: future `drizzle-kit generate` runs diff against it cleanly\./,
    );
    expect(body).toMatch(/`\.husky\/pre-push` gains a journal-sync backstop: aborts push if any/);
    expect(body).toMatch(
      /`\*\.sql` in `apps\/server\/src\/db\/migrations\/` lacks a corresponding `"tag": "<filename>"` entry in `_journal\.json`\./,
    );
    expect(body).toMatch(/V-228-class regressions cannot recur\./);
    expect(body).toMatch(
      /Snapshot directory has 0000–0006 \+ 0022\. 0007–0021 remain absent \(intentional; the proposal's Option A explicitly accepts this gap\)\./,
    );
  });

  it("TD-003 V-184b onboarding deferred framing pinned: '## TD-003 — V-184b onboarding visual UX polish' + '**Source:** V-235 (founder direction 2026-05-06: \"V-184b copy redline NOT done now\").' + '**Status:** Deferred post-launch.' + 'Functional onboarding flow exists (signup → verify-email → welcome → select-tier → first-session) per V-184a / V-217.' + 'V-184b is visual polish ON TOP of working onboarding, not a launch blocker.' + 'Tier-3 copy decisions need founder energy + focus; founder is currently directing all attention at the GUI client launch arc (V-235 onwards).' + 'Onboarding visual polish benefits from real customer feedback signals' + 'The proposal at `docs/proposals/post-launch/v-184b-onboarding-visual-scope.md` carries the per-page scope outline + `[FOUNDER COPY]` markers.' + 'Estimated mechanical-edit effort: ~30min per page once founder copy is set.' — pinned so the V-235-deferral + 5-page-flow (signup → verify-email → welcome → select-tier → first-session) + V-184a-Tier-1-scaffolding + GUI-client-launch-arc-attention + customer-feedback-signal + [FOUNDER COPY]-markers + 30min-mechanical-effort-per-page commitment survives", () => {
    expect(body).toMatch(/## TD-003 — V-184b onboarding visual UX polish/);
    expect(body).toMatch(
      /\*\*Source:\*\* V-235 \(founder direction 2026-05-06: "V-184b copy redline NOT done now"\)\./,
    );
    expect(body).toMatch(/\*\*Status:\*\* Deferred post-launch\./);
    expect(body).toMatch(
      /Functional onboarding flow exists \(signup → verify-email → welcome → select-tier → first-session\) per V-184a \/ V-217\./,
    );
    expect(body).toMatch(
      /- V-184b is visual polish ON TOP of working onboarding, not a launch blocker\./,
    );
    expect(body).toMatch(
      /- Tier-3 copy decisions need founder energy \+ focus; founder is currently directing all attention at the GUI client launch arc \(V-235 onwards\)\./,
    );
    expect(body).toMatch(/- Onboarding visual polish benefits from real customer feedback signals/);
    expect(body).toMatch(
      /The proposal at `docs\/proposals\/post-launch\/v-184b-onboarding-visual-scope\.md` carries the per-page scope outline \+ `\[FOUNDER COPY\]` markers\./,
    );
    expect(body).toMatch(
      /Estimated mechanical-edit effort: ~30min per page once founder copy is set\./,
    );
  });

  it("How-to-add-an-entry 4-step framing pinned: '## How to add an entry' + '1. The deferral decision must already be recorded in a V-log entry.' + '2. Reserve a TD-NNN id by appending below the most recent entry.' + '3. Cross-reference: V-log entry should mention \"see TD-NNN\"; this doc should mention \"see V-NNN\".' + '4. Keep entries short. The V-log carries the full reasoning; this ledger is just the index.' — pinned so the 4-step add-entry process + cross-reference-contract + entries-short-V-log-carries-full-reasoning commitment survives (drift to skipping step 1 would let TD entries land without a V-log record of the deferral decision)", () => {
    expect(body).toMatch(/## How to add an entry/);
    expect(body).toMatch(/1\. The deferral decision must already be recorded in a V-log entry\./);
    expect(body).toMatch(/2\. Reserve a TD-NNN id by appending below the most recent entry\./);
    expect(body).toMatch(/3\. Cross-reference: V-log entry should mention "see TD-NNN"; this doc/);
    expect(body).toMatch(/should mention "see V-NNN"\./);
    expect(body).toMatch(/4\. Keep entries short\. The V-log carries the full reasoning; this/);
    expect(body).toMatch(/ledger is just the index\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
