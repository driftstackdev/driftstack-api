// W1006 — db/email-preferences-repo V-204 cross-source invariant.
// Three-hundred-thirty-second in the drift-guard series. Pins the
// apps/server/src/db/email-preferences-repo.ts Drizzle email-prefs
// repo primitive:
//
//   V-204 anchor — 'V-204 — Drizzle-backed EmailPreferencesRepo'.
//
//   DrizzleEmailPreferencesRepo 3-method surface — list + set +
//     isOptedOut.
//
//   Opt-in-via-delete framing — 'Default is opted-in; deleting the
//   row preserves that default while reverting any prior explicit
//   opt-out'. The delete-on-optedIn=true design encodes the V-204
//   default-opted-in policy as an absence of row.
//
//   Opt-out onConflictDoUpdate target — compound (accountId,
//     eventType). The conflict target enforces 1-row-per-(account,
//     event-type) uniqueness.
//
//   Opt-out values + set — both write { optedIn: false, updatedAt:
//     new Date() }. The 2-field initialise + same 2-field SET on
//     conflict keeps prior preferences clean.
//
//   isOptedOut returns false when no row exists (default opted-in).
//     Only returns true when row.optedIn === false (explicit opt-out).
//
//   toRecord 4-field shape — accountId + eventType (as
//     OptOutableEmailEvent) + optedIn + updatedAt.
//
// stays in lockstep across apps/server/src/db/email-preferences-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1006 db/email-preferences-repo V-204 cross-source invariant', () => {
  // ─── V-204 anchor ────────────────────────────────────────────

  it("CRITICAL apps/server/src/db/email-preferences-repo.ts header pins V-204 — 'V-204 — Drizzle-backed EmailPreferencesRepo'. The V-204 anchor is the email-prefs-repo provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/\/\/ V-204 — Drizzle-backed EmailPreferencesRepo\./);
    expect(p).toMatch(
      /export class DrizzleEmailPreferencesRepo implements EmailPreferencesRepo \{/,
    );
  });

  // ─── 3-method surface ────────────────────────────────────────

  it('CRITICAL 3-method surface — list + set + isOptedOut. The 3-method shape covers the customer email-prefs API.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/async list\(accountId: string\): Promise<EmailPreferenceRecord\[\]> \{/);
    expect(p).toMatch(
      /async set\(accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean\): Promise<void> \{/,
    );
    expect(p).toMatch(
      /async isOptedOut\(accountId: string, eventType: OptOutableEmailEvent\): Promise<boolean> \{/,
    );
  });

  // ─── Opt-in-via-delete framing ───────────────────────────────

  it("CRITICAL opt-in-via-delete framing — 'Default is opted-in; deleting the row preserves that default while reverting any prior explicit opt-out'. The delete-on-optIn=true design encodes the V-204 default policy as row-absence.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/\/\/ Default is opted-in; deleting the row preserves that default/);
    expect(p).toMatch(/\/\/ while reverting any prior explicit opt-out\./);
    expect(p).toMatch(/if \(optedIn\) \{/);
    expect(p).toMatch(/\.delete\(accountEmailPreferences\)/);
    expect(p).toMatch(/eq\(accountEmailPreferences\.accountId, accountId\),/);
    expect(p).toMatch(/eq\(accountEmailPreferences\.eventType, eventType\),/);
    expect(p).toMatch(/return;/);
  });

  // ─── Opt-out onConflictDoUpdate compound target ──────────────

  it('CRITICAL opt-out onConflictDoUpdate target — compound (accountId, eventType). The compound-key conflict enforces 1-row-per-(account, event-type) uniqueness.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/\.onConflictDoUpdate\(\{/);
    expect(p).toMatch(
      /target: \[accountEmailPreferences\.accountId, accountEmailPreferences\.eventType\],/,
    );
    expect(p).toMatch(/set: \{ optedIn: false, updatedAt: new Date\(\) \},/);
  });

  it('CRITICAL opt-out values 4-field initialise — accountId + eventType + optedIn:false + updatedAt. The shape matches the onConflict SET clause for re-opt-out idempotency.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/accountId,/);
    expect(p).toMatch(/eventType,/);
    expect(p).toMatch(/optedIn: false,/);
    expect(p).toMatch(/updatedAt: new Date\(\),/);
  });

  // ─── isOptedOut default-opted-in ─────────────────────────────

  it('CRITICAL isOptedOut returns false on missing row (default opted-in). Only returns true when row.optedIn === false (explicit opt-out). The absence-as-default design matches the V-204 opt-out-via-explicit-row policy.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/if \(!row\) return false;/);
    expect(p).toMatch(/return row\.optedIn === false;/);
  });

  it('CRITICAL isOptedOut where — and(eq(accountId), eq(eventType)) + limit(1). The 2-cond AND looks up the (account, eventType) row.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(/eq\(accountEmailPreferences\.accountId, accountId\),/);
    expect(p).toMatch(/eq\(accountEmailPreferences\.eventType, eventType\),/);
    expect(p).toMatch(/\.limit\(1\);/);
  });

  // ─── toRecord 4-field shape ──────────────────────────────────

  it('CRITICAL toRecord 4-field shape — accountId + eventType (cast as OptOutableEmailEvent) + optedIn + updatedAt. The 4-field EmailPreferenceRecord is the service-layer consumer shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts'));
    expect(p).toMatch(
      /function toRecord\(r: typeof accountEmailPreferences\.\$inferSelect\): EmailPreferenceRecord \{/,
    );
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/eventType: r\.eventType as OptOutableEmailEvent,/);
    expect(p).toMatch(/optedIn: r\.optedIn,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-email-preferences-repo-v204-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
