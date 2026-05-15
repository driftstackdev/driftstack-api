// W1008 — db/account-lifecycle-repo V-202c + V-304a cross-source
// invariant. Three-hundred-thirty-fourth in the drift-guard series.
// Pins the apps/server/src/db/account-lifecycle-repo.ts Drizzle
// lifecycle repo:
//
//   V-202c anchor — 'V-202c — Drizzle implementation of
//     AccountLifecycleRepo'.
//
//   DrizzleAccountLifecycleRepo 3-method surface — findForLifecycle
//     + markFirstFailureEmailSent + markFirstSuccessEmailSent.
//
//   findForLifecycle narrow 4-field projection — id + email +
//     firstFailureEmailSentAt + firstSuccessEmailSentAt.
//
//   markFirstFailureEmailSent isNull(firstFailureEmailSentAt) guard
//     framing — 'Conditional UPDATE ... WHERE first_failure_email_
//     sent_at IS NULL. Drizzle's update returns affected rows; we
//     set updatedAt so the row's mutation timestamp reflects the
//     lifecycle state change'.
//
//   V-304a markFirstSuccessEmailSent framing — 'V-304a — same
//     pattern as markFirstFailureEmailSent. Different column'.
//
//   Both mark* methods return boolean via returning({id}).length > 0
//     (mutation-or-not signal for first-email idempotency).
//
//   Both mark* methods touch 2 fields — firstX-EmailSentAt + updatedAt.
//
// stays in lockstep across apps/server/src/db/account-lifecycle-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1008 db/account-lifecycle-repo V-202c + V-304a cross-source invariant', () => {
  it("CRITICAL V-202c anchor — 'V-202c — Drizzle implementation of AccountLifecycleRepo'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts'));
    expect(p).toMatch(/\/\/ V-202c — Drizzle implementation of AccountLifecycleRepo\./);
    expect(p).toMatch(
      /export class DrizzleAccountLifecycleRepo implements AccountLifecycleRepo \{/,
    );
  });

  it('CRITICAL 3-method surface — findForLifecycle + markFirstFailureEmailSent + markFirstSuccessEmailSent.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts'));
    expect(p).toMatch(
      /async findForLifecycle\(accountId: string\): Promise<AccountLifecycleRow \| null> \{/,
    );
    expect(p).toMatch(
      /async markFirstFailureEmailSent\(accountId: string, at: Date\): Promise<boolean> \{/,
    );
    expect(p).toMatch(
      /async markFirstSuccessEmailSent\(accountId: string, at: Date\): Promise<boolean> \{/,
    );
  });

  it('CRITICAL findForLifecycle narrow 4-field projection — id + email + firstFailureEmailSentAt + firstSuccessEmailSentAt. The narrow projection avoids hauling unrelated account columns on lifecycle hot path.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts'));
    expect(p).toMatch(/\.select\(\{/);
    expect(p).toMatch(/id: accounts\.id,/);
    expect(p).toMatch(/email: accounts\.email,/);
    expect(p).toMatch(/firstFailureEmailSentAt: accounts\.firstFailureEmailSentAt,/);
    expect(p).toMatch(/firstSuccessEmailSentAt: accounts\.firstSuccessEmailSentAt,/);
  });

  it("CRITICAL markFirstFailureEmailSent framing — 'Conditional UPDATE ... WHERE first_failure_email_sent_at IS NULL. Drizzle's update returns affected rows; we set updatedAt so the row's mutation timestamp reflects the lifecycle state change'. The IS-NULL once-only guard + updatedAt-bump design.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts'));
    expect(p).toMatch(/\/\/ Conditional UPDATE \.\.\. WHERE first_failure_email_sent_at IS NULL\./);
    expect(p).toMatch(/\/\/ Drizzle's update returns affected rows; we set updatedAt so the/);
    expect(p).toMatch(/\/\/ row's mutation timestamp reflects the lifecycle state change\./);
    expect(p).toMatch(/\.set\(\{ firstFailureEmailSentAt: at, updatedAt: at \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.firstFailureEmailSentAt\)\)\)/,
    );
  });

  it("CRITICAL V-304a framing — 'V-304a — same pattern as markFirstFailureEmailSent. Different column'. The DRY-by-comment pattern keeps the second method body short.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts'));
    expect(p).toMatch(
      /\/\/ V-304a — same pattern as markFirstFailureEmailSent\. Different column\./,
    );
    expect(p).toMatch(/\.set\(\{ firstSuccessEmailSentAt: at, updatedAt: at \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.firstSuccessEmailSentAt\)\)\)/,
    );
  });

  it('CRITICAL both mark* methods return boolean via returning({id}).length > 0. The mutation-or-not signal is the first-email idempotency contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-lifecycle-repo.ts'));
    expect(p).toMatch(/\.returning\(\{ id: accounts\.id \}\);/);
    expect(p).toMatch(/return result\.length > 0;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-account-lifecycle-repo-v202c-v304a-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
