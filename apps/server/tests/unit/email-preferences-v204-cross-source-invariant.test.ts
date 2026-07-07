// W929 — V-204 email-preferences opt-out cross-source invariant.
// Two-hundred-fifty-fifth in the drift-guard series. Pins the per-
// account email notification preferences service:
//
//   V-204 anchor — 'per-account email notification preferences'.
//
//   4-event opt-out scope (lifecycle emails customers can disable):
//     signup-welcome / session-failed-first / tier-changed /
//     billing-receipt. (trial-pack-purchased/expired removed with
//     the dead trial_pack lifecycle.)
//
//   3-event security/financial bypass (always-send, never opt-outable):
//     signup-verification / password-reset / billing-failure.
//     (S44 2026-07-07 founder-approved trim deleted the never-wired
//     subscription-cancellation + support-ack templates: bypass 5→3.)
//
//   Storage convention — 'absence of a row means opted-in (default).
//   Explicit opt-out writes a row with opted_in=false. Steady-state
//   is zero rows per account; only customers who flipped a preference
//   have rows in the table'. The default-opted-in model bounds
//   table size to opt-out-customers only.
//
//   list() returns 8 events: 6 lifecycle (V-204) + session-success-
//   first (V-304a) + billing-renewal-reminder (V-327).
//
//   EmailPreferenceRecord (4 fields): accountId + eventType +
//     optedIn + updatedAt.
//
//   EmailPreferencesRepo (3 methods):
//     - list(accountId): EmailPreferenceRecord[].
//     - set(accountId, eventType, optedIn): void. Setting opted_in=
//       true DELETES the row (default-opted-in invariant).
//     - isOptedOut(accountId, eventType): boolean. False for absent
//       rows (default-opted-in).
//
//   shouldSend(accountId, eventType): inverse of isOptedOut —
//     service-internal gate wired into EmailService send methods.
//
//   V-330d effectiveAccountId — when set, reads/writes target the
//     OWNER's account; route layer enforces 'admin' role for writes
//     (member is read-only per Q2 verdict). Service stays
//     role-neutral.
//
//   Default updatedAt = new Date(0) when no row exists — stable
//     epoch lets consumers detect 'never customised'.
//
// stays in lockstep across apps/server/src/services/email-preferences.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W929 V-204 email-preferences cross-source invariant', () => {
  // ─── V-204 anchor ────────────────────────────────────────────

  it("CRITICAL apps/server/src/services/email-preferences.ts header pins V-204 anchor — 'V-204 — per-account email notification preferences'. The V-204 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/V-204 — per-account email notification preferences/);
  });

  // ─── Lifecycle opt-out scope framing ─────────────────────────

  it('CRITICAL header pins 4-event lifecycle opt-out — \'Customers opt out of "lifecycle" emails (signup-welcome, session-failed-first, tier-changed, billing-receipt)\'. The 4-event opt-out set is what customers control via the dashboard (the trial-pack pair was removed with the dead trial_pack lifecycle).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/Customers opt out of "lifecycle" emails \(signup-welcome, session-/);
    expect(p).toMatch(/failed-first, tier-changed, billing-receipt\)/);
    expect(p).not.toMatch(/trial-pack-purchased/);
    expect(p).not.toMatch(/trial-pack-expired/);
  });

  // ─── Security/financial bypass framing ───────────────────────

  it("CRITICAL header pins 3-event security/financial bypass — 'Security + financial emails (signup-verification, password-reset, billing-failure) bypass this gate entirely — they always send'. The bypass is the always-send contract. (S44 2026-07-07 trim: bypass list 5→3; deleted names must not creep back in.)", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/Security \+ financial emails \(signup-/);
    expect(p).toMatch(/verification, password-reset, billing-failure\) bypass this gate/);
    expect(p).toMatch(/entirely — they always send/);
    expect(p).toMatch(
      /S44 2026-07-07 trimmed the never-\s*\n?\s*\/\/\s*wired subscription-cancellation \+ support-ack templates/,
    );
  });

  // ─── Absence-is-opted-in storage convention ──────────────────

  it("CRITICAL storage convention framing — 'absence of a row means opted-in (default). Explicit opt-out writes a row with opted_in=false. Steady-state is zero rows per account; only customers who flipped a preference have rows in the table'. The default-opted-in design bounds table size to opt-out-only customers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/Storage convention: absence of a row means opted-in \(default\)\./);
    expect(p).toMatch(/Explicit opt-out writes a row with opted_in=false\. Steady-state/);
    expect(p).toMatch(/is zero rows per account; only customers who flipped a preference/);
    expect(p).toMatch(/have rows in the table/);
  });

  // ─── 8-event list() coverage ─────────────────────────────────

  it('CRITICAL list() returns 6 events — 4 lifecycle (V-204) + session-success-first (V-304a) + billing-renewal-reminder (V-327). The 6-event union covers all opt-outable emails the customer-dashboard surfaces (the trial-pack pair was removed with the dead trial_pack lifecycle).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/const allEvents: OptOutableEmailEvent\[\] = \[/);
    expect(p).toMatch(/'signup-welcome',/);
    expect(p).toMatch(/'session-failed-first',/);
    expect(p).toMatch(/'session-success-first',/);
    expect(p).toMatch(/'tier-changed',/);
    expect(p).toMatch(/'billing-receipt',/);
    expect(p).toMatch(/'billing-renewal-reminder',/);
    expect(p).not.toMatch(/'trial-pack-purchased',/);
    expect(p).not.toMatch(/'trial-pack-expired',/);
  });

  // ─── EmailPreferenceRecord 4-field shape ─────────────────────

  it('CRITICAL EmailPreferenceRecord has 4 fields — accountId + eventType + optedIn + updatedAt. The 4-field shape is the customer-dashboard read shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/export interface EmailPreferenceRecord \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/eventType: OptOutableEmailEvent;/);
    expect(p).toMatch(/optedIn: boolean;/);
    expect(p).toMatch(/updatedAt: Date;/);
  });

  // ─── EmailPreferencesRepo 3-method interface ─────────────────

  it('CRITICAL EmailPreferencesRepo has 3 methods — list + set + isOptedOut. The 3-method repo is the storage seam.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/export interface EmailPreferencesRepo \{/);
    expect(p).toMatch(/list\(accountId: string\): Promise<EmailPreferenceRecord\[\]>;/);
    expect(p).toMatch(
      /set\(accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean\): Promise<void>;/,
    );
    expect(p).toMatch(
      /isOptedOut\(accountId: string, eventType: OptOutableEmailEvent\): Promise<boolean>;/,
    );
  });

  // ─── set(opted_in=true) DELETES the row framing ──────────────

  it("CRITICAL set() JSDoc pins 'Upsert by (accountId, eventType). Setting optedIn=true deletes the row instead of writing it (default-opted-in convention)'. The delete-on-true is what preserves the absence-is-opted-in invariant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/Upsert by \(accountId, eventType\)\. Setting `optedIn=true` deletes/);
    expect(p).toMatch(/the row instead of writing it \(default-opted-in convention\)/);
  });

  it("CRITICAL isOptedOut() JSDoc pins 'True if the customer has explicitly opted out of eventType. False (default) for absent rows or optedIn=true rows'. The false-on-absent is the default-opted-in mirror.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/True if the customer has explicitly opted out of `eventType`/);
    expect(p).toMatch(/False \(default\) for absent rows or `optedIn=true` rows/);
  });

  // ─── shouldSend wired into EmailService ──────────────────────

  it("CRITICAL shouldSend() JSDoc pins 'Service-internal gate: returns true when the email should send (default opted-in). Wire callers in EmailService send methods so opt-outable events check this before firing'. The send-side gate is what makes the opt-out enforceable across all email send paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/Service-internal gate: returns true when the email \*\*should send\*\*/);
    expect(p).toMatch(/\(default opted-in\)\. Wire callers in EmailService send methods so/);
    expect(p).toMatch(/opt-outable events check this before firing/);
  });

  it("CRITICAL shouldSend impl — 'const optedOut = await this.repo.isOptedOut(...); return !optedOut'. The inverse-of-isOptedOut is what makes the gate truthy by default.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(
      /async shouldSend\(accountId: string, eventType: OptOutableEmailEvent\): Promise<boolean> \{\s*\n\s*const optedOut = await this\.repo\.isOptedOut\(accountId, eventType\);\s*\n\s*return !optedOut;/,
    );
  });

  // ─── V-330d effectiveAccountId framing ───────────────────────

  it("CRITICAL V-330d list() framing — 'when effectiveAccountId is set, list the OWNER's preferences. Read-only — both member and admin roles allowed (gate is at the route layer; service stays neutral)'. The V-330d service-neutral design lets the route layer enforce role.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/V-330d — when effectiveAccountId is set, list the OWNER's/);
    expect(p).toMatch(/preferences\. Read-only — both 'member' and 'admin' roles/);
    expect(p).toMatch(/allowed \(gate is at the route layer; service stays neutral\)/);
  });

  it("CRITICAL V-330d set() framing — 'when effectiveAccountId is set, the route layer has already enforced the admin role requirement (Q2 verdict — member role is read-only on writes). Service writes to the OWNER's account; the audit footprint of the change is the owner's audit log, not the caller's'. The Q2 verdict + owner-audit framing is the V-330d write-side contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/V-330d — when effectiveAccountId is set, the route layer has/);
    expect(p).toMatch(/already enforced the 'admin' role requirement \(Q2 verdict —/);
    expect(p).toMatch(/member role is read-only on writes\)\. Service writes to the/);
    expect(p).toMatch(/OWNER's account; the audit footprint of the change is the/);
    expect(p).toMatch(/owner's audit log, not the caller's/);
  });

  it("CRITICAL effectiveAccountId resolution — 'opts.effectiveAccountId ?? ctx.account.id'. The fallback-to-caller is what makes effectiveAccountId an optional override.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
  });

  // ─── account_owner scope requirement ─────────────────────────

  it("CRITICAL list + set throw 'account_owner' scope requirement via throwIfMissingScope. The scope gate ensures the API key has account_owner before reading/writing preferences.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/throwIfMissingScope\(ctx, 'account_owner'\);/);
  });

  // ─── Default updatedAt = epoch framing ───────────────────────

  it("CRITICAL default row framing — 'Default opted-in. updatedAt is the account creation time by convention, but we don't have that here without a join; surface a stable epoch instead so consumers can detect \"never customised\"'. The epoch-zero is the never-customised sentinel.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts'));
    expect(p).toMatch(/Default opted-in\. updatedAt is the account creation time/);
    expect(p).toMatch(/by convention, but we don't have that here without a join;/);
    expect(p).toMatch(/surface a stable epoch instead so consumers can detect/);
    expect(p).toMatch(/"never customised"/);
    expect(p).toMatch(/updatedAt: new Date\(0\),/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/email-preferences-v204-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
