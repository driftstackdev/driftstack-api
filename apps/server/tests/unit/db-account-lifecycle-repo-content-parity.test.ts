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
      /export class DrizzleAccountLifecycleRepo implements AccountLifecycleRepo \{\s*constructor\(private readonly database: Database\) \{\}/,
    );
  });

  it('findForLifecycle: 4-field select (id + email + firstFailureEmailSentAt + firstSuccessEmailSentAt) from accounts where id matches + limit 1; returns rows[0] ?? null', () => {
    expect(body).toMatch(
      /async findForLifecycle\(accountId: string\): Promise<AccountLifecycleRow \| null> \{\s*const rows = await this\.database\.db\s*\.select\(\{\s*id: accounts\.id,\s*email: accounts\.email,\s*firstFailureEmailSentAt: accounts\.firstFailureEmailSentAt,\s*firstSuccessEmailSentAt: accounts\.firstSuccessEmailSentAt,\s*\}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, accountId\)\)\s*\.limit\(1\);\s*return rows\[0\] \?\? null;\s*\}/,
    );
  });

  it("markFirstFailureEmailSent framing pinned: conditional UPDATE ... WHERE first_failure_email_sent_at IS NULL; sets updatedAt so row's mutation timestamp reflects lifecycle state change; returning {id} with result.length > 0 boolean", () => {
    expect(body).toMatch(
      /\/\/ Conditional UPDATE \.\.\. WHERE first_failure_email_sent_at IS NULL\.\s*\/\/ Drizzle's update returns affected rows; we set updatedAt so the\s*\/\/ row's mutation timestamp reflects the lifecycle state change\./,
    );
    expect(body).toMatch(
      /const result = await this\.database\.db\s*\.update\(accounts\)\s*\.set\(\{ firstFailureEmailSentAt: at, updatedAt: at \}\)\s*\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.firstFailureEmailSentAt\)\)\)\s*\.returning\(\{ id: accounts\.id \}\);\s*return result\.length > 0;/,
    );
  });

  it('V-304a markFirstSuccessEmailSent: same pattern as markFirstFailureEmailSent (rationale comment); different column firstSuccessEmailSentAt + isNull guard', () => {
    expect(body).toMatch(
      /\/\/ V-304a — same pattern as markFirstFailureEmailSent\. Different column\./,
    );
    expect(body).toMatch(
      /\.set\(\{ firstSuccessEmailSentAt: at, updatedAt: at \}\)\s*\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.firstSuccessEmailSentAt\)\)\)\s*\.returning\(\{ id: accounts\.id \}\);\s*return result\.length > 0;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
