// W400.A — drift guard for apps/server/src/services/email-preferences.ts.
// V-204 per-account email notification preferences. Customers opt out
// of LIFECYCLE emails only; security + financial emails bypass this
// gate entirely. Drift here either silently disables a customer's
// opt-out (regulatory risk for unsolicited marketing) OR adds a
// password-reset to the opt-outable set (catastrophic for security).
//
//   • V-204 framing pinned + opt-outable cluster (4 lifecycle:
//     signup-welcome, session-failed-first, tier-changed,
//     billing-receipt) vs bypass cluster (3 security/financial:
//     signup-verification, password-reset, billing-failure).
//     (trial-pack-purchased/expired removed with the dead trial_pack
//     lifecycle; S44 2026-07-07 founder-approved trim deleted the
//     never-wired subscription-cancellation + support-ack templates,
//     bypass 5→3.)
//   • Storage convention: absence-of-row = opted-in default; steady-
//     state zero rows per account.
//   • EmailPreferenceRecord: 4 fields (accountId / eventType /
//     optedIn / updatedAt).
//   • Repo set: optedIn=true deletes row (default-opted-in convention)
//     — upsert-by-(account, eventType).
//   • list: account_owner scope; V-330d effectiveAccountId team-
//     member read-only-allowed (route layer enforces 'admin' for
//     writes — Q2 verdict).
//   • 8-entry allEvents matrix surfaced in list (default opted-in
//     for absent rows, updatedAt=epoch sentinel).
//   • shouldSend: service-internal gate, returns !isOptedOut
//     (default opted-in semantic).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/email-preferences.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W400.A apps/server/src/services/email-preferences.ts content parity', () => {
  const body = read(LIB);

  it('V-204 framing pinned + opt-out cluster (lifecycle) vs bypass cluster (security + financial)', () => {
    expect(body).toMatch(/V-204 — per-account email notification preferences\./);
    expect(body).toMatch(
      /Customers opt out of "lifecycle" emails \(signup-welcome, session-\s*\n?\s*\/\/\s*failed-first, tier-changed, billing-receipt\)\./,
    );
    expect(body).not.toMatch(/trial-pack-purchased/);
    expect(body).not.toMatch(/trial-pack-expired/);
    expect(body).toMatch(
      /Security \+ financial emails \(signup-\s*\n?\s*\/\/\s*verification, password-reset, billing-failure\) bypass this gate\s*\n?\s*\/\/\s*entirely — they always send\./,
    );
    // S44 2026-07-07 — deleted-template names must not creep back into
    // the bypass framing as if those emails still existed.
    expect(body).toMatch(/S44 2026-07-07 trimmed the never-/);
  });

  it('Storage-convention framing: absence-of-row = opted-in default, steady-state zero rows', () => {
    expect(body).toMatch(
      /Storage convention: absence of a row means opted-in \(default\)\.\s*\n?\s*\/\/\s*Explicit opt-out writes a row with opted_in=false\. Steady-state\s*\n?\s*\/\/\s*is zero rows per account; only customers who flipped a preference\s*\n?\s*\/\/\s*have rows in the table\./,
    );
  });

  it('EmailPreferenceRecord: 4 fields (accountId / eventType / optedIn / updatedAt)', () => {
    expect(body).toMatch(
      /export interface EmailPreferenceRecord \{\s*\n?\s*accountId: string;\s*\n?\s*eventType: OptOutableEmailEvent;\s*\n?\s*optedIn: boolean;\s*\n?\s*updatedAt: Date;\s*\n?\s*\}/,
    );
  });

  it('EmailPreferencesRepo: 3 methods (list / set with optedIn=true→delete / isOptedOut)', () => {
    expect(body).toMatch(/export interface EmailPreferencesRepo \{/);
    expect(body).toMatch(/list\(accountId: string\): Promise<EmailPreferenceRecord\[\]>;/);
    expect(body).toMatch(
      /Upsert by \(accountId, eventType\)\. Setting `optedIn=true` deletes\s*\n?\s*\*\s*the row instead of writing it \(default-opted-in convention\)\./,
    );
    expect(body).toMatch(
      /set\(accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean\): Promise<void>;/,
    );
    expect(body).toMatch(
      /True if the customer has explicitly opted out of `eventType`\.\s*\n?\s*\*\s*False \(default\) for absent rows or `optedIn=true` rows\./,
    );
    expect(body).toMatch(
      /isOptedOut\(accountId: string, eventType: OptOutableEmailEvent\): Promise<boolean>;/,
    );
  });

  it('list: account_owner scope + effectiveAccountId fallback to ctx.account.id', () => {
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'account_owner'\);/);
    expect(body).toMatch(/const accountId = opts\.effectiveAccountId \?\? ctx\.account\.id;/);
    expect(body).toMatch(/const stored = await this\.repo\.list\(accountId\);/);
    expect(body).toMatch(
      /const storedMap = new Map\(stored\.map\(\(r\) => \[r\.eventType, r\]\)\);/,
    );
  });

  it('V-330d list framing: effectiveAccountId → OWNER preferences; read-only allowed for member + admin (route enforces gate)', () => {
    expect(body).toMatch(
      /V-330d — when effectiveAccountId is set, list the OWNER's\s*\n?\s*\/\/\s*preferences\. Read-only — both 'member' and 'admin' roles\s*\n?\s*\/\/\s*allowed \(gate is at the route layer; service stays neutral\)/,
    );
  });

  it('list: 6-entry allEvents matrix pinned (signup-welcome / session-failed-first / session-success-first / tier-changed / billing-receipt / billing-renewal-reminder; trial-pack pair removed with the dead trial_pack lifecycle)', () => {
    expect(body).toMatch(/const allEvents: OptOutableEmailEvent\[\] = \[/);
    expect(body).toMatch(/'signup-welcome',/);
    expect(body).toMatch(/'session-failed-first',/);
    expect(body).toMatch(/'session-success-first',/);
    expect(body).toMatch(/'tier-changed',/);
    expect(body).toMatch(/'billing-receipt',/);
    expect(body).toMatch(/'billing-renewal-reminder',/);
    expect(body).not.toMatch(/'trial-pack-purchased',/);
    expect(body).not.toMatch(/'trial-pack-expired',/);
  });

  it('list: absent-row default returns optedIn=true + updatedAt=new Date(0) epoch sentinel ("never customised")', () => {
    expect(body).toMatch(
      /\/\/ Default opted-in\. updatedAt is the account creation time\s*\n?\s*\/\/\s*by convention, but we don't have that here without a join;\s*\n?\s*\/\/\s*surface a stable epoch instead so consumers can detect\s*\n?\s*\/\/\s*"never customised"\./,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*accountId,\s*\n?\s*eventType,\s*\n?\s*optedIn: true,\s*\n?\s*updatedAt: new Date\(0\),\s*\n?\s*\};/,
    );
  });

  it("set: account_owner scope; V-330d effectiveAccountId → audit lives on OWNER's log (Q2 verdict)", () => {
    expect(body).toMatch(
      /async set\(\s*\n?\s*ctx: AccountContext,\s*\n?\s*eventType: OptOutableEmailEvent,\s*\n?\s*optedIn: boolean,\s*\n?\s*opts: \{ effectiveAccountId\?: string \} = \{\},\s*\n?\s*\): Promise<void> \{/,
    );
    expect(body).toMatch(
      /V-330d — when effectiveAccountId is set, the route layer has\s*\n?\s*\/\/\s*already enforced the 'admin' role requirement \(Q2 verdict —\s*\n?\s*\/\/\s*member role is read-only on writes\)\. Service writes to the\s*\n?\s*\/\/\s*OWNER's account; the audit footprint of the change is the\s*\n?\s*\/\/\s*owner's audit log, not the caller's\./,
    );
    expect(body).toMatch(/await this\.repo\.set\(accountId, eventType, optedIn\);/);
  });

  it('shouldSend: service-internal gate, returns !isOptedOut (default opted-in semantic)', () => {
    expect(body).toMatch(
      /Service-internal gate: returns true when the email \*\*should send\*\*\s*\n?\s*\*\s*\(default opted-in\)\. Wire callers in EmailService send methods so\s*\n?\s*\*\s*opt-outable events check this before firing\./,
    );
    expect(body).toMatch(
      /async shouldSend\(accountId: string, eventType: OptOutableEmailEvent\): Promise<boolean> \{\s*\n?\s*const optedOut = await this\.repo\.isOptedOut\(accountId, eventType\);\s*\n?\s*return !optedOut;\s*\n?\s*\}/,
    );
  });

  it('imports: OptOutableEmailEvent type + AccountContext + requireScope-as-throwIfMissingScope', () => {
    expect(body).toMatch(/import type \{ OptOutableEmailEvent \} from '@driftstack\/api-types';/);
    expect(body).toMatch(/import type \{ AccountContext \} from '\.\/auth\.js';/);
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
