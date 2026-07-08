// W441.B — drift guard for apps/server/src/db/account-lifecycle-repo.ts.
// V-202c first-failure + V-304a first-success email idempotency repo.
// Drift here either drops the conditional WHERE ... IS NULL clause
// (idempotency lost — customer receives the milestone email every
// retry) or stops updating updatedAt (row mutation timestamp goes
// stale).
//
//   • V-202c framing pinned.
//   • findForLifecycle: 4-field select (id + email + 2 sent-at).
//   • markFirstFailureEmailSent: conditional UPDATE WHERE
//     first_failure_email_sent_at IS NULL; updatedAt set so row
//     mutation timestamp reflects lifecycle state change; returns
//     bool from result.length > 0.
//   • V-304a markFirstSuccessEmailSent: same pattern, different
//     column (first_success_email_sent_at).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W441.B apps/server/src/db/account-lifecycle-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-202c framing pinned: 'Drizzle implementation of AccountLifecycleRepo'", () => {
    expect(body).toMatch(/\/\/ V-202c — Drizzle implementation of AccountLifecycleRepo\./);
  });

  it('imports: and/eq/isNull from drizzle-orm; Database type; accounts schema; AccountLifecycleRepo/Row from services', () => {
    expect(body).toMatch(/import \{ and, eq, isNull \} from 'drizzle-orm';/);
    expect(body).toMatch(/import type \{ Database \} from '\.\/client\.js';/);
    expect(body).toMatch(/import \{ accounts, billingEmailSends \} from '\.\/schema\.js';/);
    expect(body).toMatch(
      /import type \{ AccountLifecycleRepo, AccountLifecycleRow \} from '\.\.\/services\/account-lifecycle\.js';/,
    );
  });

  it('DrizzleAccountLifecycleRepo class implements AccountLifecycleRepo; constructor(private readonly database: Database)', () => {
    expect(body).toMatch(
      /export class DrizzleAccountLifecycleRepo implements AccountLifecycleRepo \{\s*\n?\s*constructor\(private readonly database: Database\) \{\}/,
    );
  });

  it('findForLifecycle: 4-field select (id + email + firstFailureEmailSentAt + firstSuccessEmailSentAt) from accounts where id matches + limit 1; returns rows[0] ?? null', () => {
    expect(body).toMatch(
      /async findForLifecycle\(accountId: string\): Promise<AccountLifecycleRow \| null> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\{\s*\n?\s*id: accounts\.id,\s*\n?\s*email: accounts\.email,\s*\n?\s*firstFailureEmailSentAt: accounts\.firstFailureEmailSentAt,\s*\n?\s*firstSuccessEmailSentAt: accounts\.firstSuccessEmailSentAt,\s*\n?\s*\}\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.id, accountId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return rows\[0\] \?\? null;\s*\n?\s*\}/,
    );
  });

  it("markFirstFailureEmailSent framing pinned: conditional UPDATE ... WHERE first_failure_email_sent_at IS NULL; sets updatedAt so row's mutation timestamp reflects lifecycle state change; returning {id} with result.length > 0 boolean", () => {
    expect(body).toMatch(
      /\/\/ Conditional UPDATE \.\.\. WHERE first_failure_email_sent_at IS NULL\.\s*\n?\s*\/\/ Drizzle's update returns affected rows; we set updatedAt so the\s*\n?\s*\/\/ row's mutation timestamp reflects the lifecycle state change\./,
    );
    expect(body).toMatch(
      /const result = await this\.database\.db\s*\n?\s*\.update\(accounts\)\s*\n?\s*\.set\(\{ firstFailureEmailSentAt: at, updatedAt: at \}\)\s*\n?\s*\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.firstFailureEmailSentAt\)\)\)\s*\n?\s*\.returning\(\{ id: accounts\.id \}\);\s*\n?\s*return result\.length > 0;/,
    );
  });

  it('V-304a markFirstSuccessEmailSent: same pattern as markFirstFailureEmailSent (rationale comment); different column firstSuccessEmailSentAt + isNull guard', () => {
    expect(body).toMatch(
      /\/\/ V-304a — same pattern as markFirstFailureEmailSent\. Different column\./,
    );
    expect(body).toMatch(
      /\.set\(\{ firstSuccessEmailSentAt: at, updatedAt: at \}\)\s*\n?\s*\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.firstSuccessEmailSentAt\)\)\)\s*\n?\s*\.returning\(\{ id: accounts\.id \}\);\s*\n?\s*return result\.length > 0;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
