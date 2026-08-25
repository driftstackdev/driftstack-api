// W441.C — drift guard for apps/server/src/db/email-preferences-repo.ts.
// V-204 EmailPreferences repo. Drift here either inverts the
// default-opted-in convention (silently opts customers out of every
// email by storing a row on every change) or breaks the
// onConflictDoUpdate target (duplicate-key insert on resubmit).
//
//   • V-204 default-opted-in framing pinned: opting back in deletes
//     the row, preserves the default while reverting any prior
//     explicit opt-out.
//   • set() with optedIn=true: DELETE matching (account, eventType).
//   • set() with optedIn=false: INSERT … ON CONFLICT (account,
//     eventType) DO UPDATE → optedIn=false + updatedAt now.
//   • isOptedOut: returns false on no-row (default opted-in); true
//     when row.optedIn === false.
//   • toRecord: cast eventType as OptOutableEmailEvent.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/email-preferences-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W441.C apps/server/src/db/email-preferences-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-204 framing pinned: 'Drizzle-backed EmailPreferencesRepo.'", () => {
    expect(body).toMatch(/\/\/ V-204 — Drizzle-backed EmailPreferencesRepo\./);
  });

  it('imports: and/asc/eq from drizzle-orm; OptOutableEmailEvent from api-types; EmailPreferenceRecord/Repo from services; Database type; accountEmailPreferences schema', () => {
    expect(body).toMatch(/import \{ and, asc, eq \} from 'drizzle-orm';/);
    expect(body).toMatch(/import type \{ OptOutableEmailEvent \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import type \{ EmailPreferenceRecord, EmailPreferencesRepo \} from '\.\.\/services\/email-preferences\.js';/,
    );
    expect(body).toMatch(/import type \{ Database \} from '\.\/client\.js';/);
    expect(body).toMatch(/import \{ accountEmailPreferences \} from '\.\/schema\.js';/);
  });

  it('DrizzleEmailPreferencesRepo implements EmailPreferencesRepo; constructor(private readonly database: Database)', () => {
    expect(body).toMatch(
      /export class DrizzleEmailPreferencesRepo implements EmailPreferencesRepo \{\s*constructor\(private readonly database: Database\) \{\}/,
    );
  });

  it('list(accountId): select * from accountEmailPreferences where accountId, ordered by eventType; map via toRecord', () => {
    // V-1201 — split from one chain regex into two. The method gained an ORDER BY (the rows are
    // rendered as the customer's preference list, and without one the same account saw them in a
    // different order per load), and extending the single expression through the new comment
    // block would have made an already-brittle chain worse. The halves are asserted separately.
    expect(body).toMatch(
      /async list\(accountId: string\): Promise<EmailPreferenceRecord\[\]> \{[^}]*\.select\(\)[^}]*\.from\(accountEmailPreferences\)[^}]*\.where\(eq\(accountEmailPreferences\.accountId, accountId\)\)/,
    );
    expect(body).toMatch(
      /\.orderBy\(asc\(accountEmailPreferences\.eventType\)\);\s*return rows\.map\(toRecord\);/,
    );
  });

  it("V-204 default-opted-in framing pinned on set(): 'Default is opted-in; deleting the row preserves that default while reverting any prior explicit opt-out.' — DELETE on optedIn=true", () => {
    expect(body).toMatch(
      /if \(optedIn\) \{\s*\/\/ Default is opted-in; deleting the row preserves that default\s*\/\/ while reverting any prior explicit opt-out\.\s*await this\.database\.db\s*\.delete\(accountEmailPreferences\)\s*\.where\(\s*and\(\s*eq\(accountEmailPreferences\.accountId, accountId\),\s*eq\(accountEmailPreferences\.eventType, eventType\),\s*\),\s*\);\s*return;\s*\}/,
    );
  });

  it('set() optedIn=false: INSERT values (accountId, eventType, optedIn:false, updatedAt: new Date()) onConflictDoUpdate target [accountId, eventType] set {optedIn:false, updatedAt: new Date()}', () => {
    expect(body).toMatch(
      /await this\.database\.db\s*\.insert\(accountEmailPreferences\)\s*\.values\(\{\s*accountId,\s*eventType,\s*optedIn: false,\s*updatedAt: new Date\(\),\s*\}\)\s*\.onConflictDoUpdate\(\{\s*target: \[accountEmailPreferences\.accountId, accountEmailPreferences\.eventType\],\s*set: \{ optedIn: false, updatedAt: new Date\(\) \},\s*\}\);/,
    );
  });

  it('isOptedOut: returns false on no-row (default opted-in); true when row.optedIn === false; limit(1)', () => {
    expect(body).toMatch(
      /const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(accountEmailPreferences\)\s*\.where\(\s*and\(\s*eq\(accountEmailPreferences\.accountId, accountId\),\s*eq\(accountEmailPreferences\.eventType, eventType\),\s*\),\s*\)\s*\.limit\(1\);\s*if \(!row\) return false;\s*return row\.optedIn === false;/,
    );
  });

  it('toRecord helper: cast eventType as OptOutableEmailEvent; returns {accountId, eventType, optedIn, updatedAt}', () => {
    expect(body).toMatch(
      /function toRecord\(r: typeof accountEmailPreferences\.\$inferSelect\): EmailPreferenceRecord \{\s*return \{\s*accountId: r\.accountId,\s*eventType: r\.eventType as OptOutableEmailEvent,\s*optedIn: r\.optedIn,\s*updatedAt: r\.updatedAt,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
