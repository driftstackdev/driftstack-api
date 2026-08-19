// W446.A — drift guard for apps/server/src/db/mfa-repo.ts.
// V-353b Drizzle MfaRepo. Drift here either drops the explicit
// recovery-codes-cascade delete on deleteForAccount (orphans
// codes when accountMfa cascade is account-scoped only) or breaks
// the isNull(usedAt) guard on markRecoveryCodeUsed (replay-attack
// vector: same code can be re-marked from "used" back to "used",
// resetting telemetry timestamps).
//
//   • V-353b framing pinned.
//   • toEnrollmentRow: 8-field MfaEnrollmentRow incl. encrypted
//     ciphertext+iv+tag for TOTP secret at rest.
//   • toRecoveryCodeRow: 5-field RecoveryCodeRow (codeHash + usedAt).
//   • findByAccount: account-scoped + limit 1.
//   • enrollment start/complete use one per-account advisory lock;
//     completion CASes the pending revision and inserts hashes in-transaction.
//   • touchLastUsed: lastUsedAt + updatedAt.
//   • deleteForAccount framing pinned: cascades on accounts FK but
//     belt-and-braces explicit delete on recovery codes (because
//     accountMfa cascade is on accounts only).
//   • listUnusedRecoveryCodes: account + isNull(usedAt) + desc
//     createdAt.
//   • markRecoveryCodeUsed: idempotent via and(eq(id), isNull(usedAt))
//     — replay-safe.
//   • replacement CASes the enrollment revision, invalidates old codes,
//     and inserts the sole new batch in one transaction.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W446.A apps/server/src/db/mfa-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-353b framing pinned: 'Drizzle implementation of MfaRepo.'", () => {
    expect(body).toMatch(/\/\/ V-353b — Drizzle implementation of MfaRepo\./);
  });

  it('imports the MFA tables plus account/web-session authority primitives', () => {
    expect(body).toMatch(
      /import \{ and, asc, count, desc, eq, gt, isNull, or, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{ MfaEnrollmentRow, MfaRepo, RecoveryCodeRow \} from '\.\.\/services\/mfa\.js';/,
    );
    expect(body).toMatch(
      /import \{ accountMfa, accountMfaRecoveryCodes, accounts, webSessions \} from '\.\/schema\.js';/,
    );
  });

  it('boot migration prevalidates a bounded legacy page, binds account context, exact-CASes the tuple, and preserves updatedAt', () => {
    expect(body).toMatch(/async migrateTotpSecretEnvelopes\(/);
    expect(body).toMatch(/decryptSecret\(v2Probe, keyBase64, v2Probe\.accountId\);/);
    expect(body).toMatch(/const plaintext = decryptLegacyMfaSecret\(row, keyBase64\);/);
    expect(body).toMatch(/encryptSecret\(plaintext, keyBase64, row\.accountId\)/);
    expect(body).toMatch(/eq\(accountMfa\.totpSecretCiphertext, row\.ciphertext\)/);
    expect(body).toMatch(/eq\(accountMfa\.totpSecretIv, row\.iv\)/);
    expect(body).toMatch(/eq\(accountMfa\.totpSecretTag, row\.tag\)/);
    expect(body).toMatch(/Deliberately leave updatedAt unchanged/);
    expect(body).toMatch(/remaining: remainingRow\?\.value \?\? 0/);
  });

  it('toEnrollmentRow: 9-field MfaEnrollmentRow (accountId + totpSecretCiphertext/Iv/Tag + enrolledAt + lastUsedAt + lastUsedTotpCounter + created/updated_at)', () => {
    expect(body).toMatch(
      /function toEnrollmentRow\(r: typeof accountMfa\.\$inferSelect\): MfaEnrollmentRow \{\s*\n?\s*return \{\s*\n?\s*accountId: r\.accountId,\s*\n?\s*totpSecretCiphertext: r\.totpSecretCiphertext,\s*\n?\s*totpSecretIv: r\.totpSecretIv,\s*\n?\s*totpSecretTag: r\.totpSecretTag,\s*\n?\s*enrolledAt: r\.enrolledAt,\s*\n?\s*lastUsedAt: r\.lastUsedAt,\s*\n?\s*lastUsedTotpCounter: r\.lastUsedTotpCounter,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('consumeTotpCounter: atomic strict-monotonic conditional UPDATE (TOTP replay defence, migration 0090)', () => {
    expect(body).toMatch(/async consumeTotpCounter\(args: \{/);
    expect(body).toMatch(/const nowIso = args\.now\.toISOString\(\);/);
    expect(body).toMatch(/lastUsedTotpCounter: args\.counter,/);
    expect(body).toMatch(
      /updatedAt: sql`GREATEST\(\$\{accountMfa\.updatedAt\} \+ INTERVAL '1 millisecond', \$\{nowIso\}::timestamptz\)`,/,
    );
    expect(body).toMatch(/isNull\(accountMfa\.lastUsedTotpCounter\)/);
    expect(body).toMatch(/sql`\$\{accountMfa\.lastUsedTotpCounter\} < \$\{args\.counter\}`/);
    expect(body).toMatch(/return result\.length > 0;/);
  });

  it('toRecoveryCodeRow: 5-field (id + accountId + codeHash + usedAt + createdAt)', () => {
    expect(body).toMatch(
      /function toRecoveryCodeRow\(r: typeof accountMfaRecoveryCodes\.\$inferSelect\): RecoveryCodeRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*codeHash: r\.codeHash,\s*\n?\s*usedAt: r\.usedAt,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('findByAccount: account-scoped + limit 1', () => {
    expect(body).toMatch(
      /async findByAccount\(accountId: string\): Promise<MfaEnrollmentRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(accountMfa\)\s*\n?\s*\.where\(eq\(accountMfa\.accountId, accountId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toEnrollmentRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('startEnrollmentIfNotEnrolled serializes the account and cannot overwrite enrolled credentials', () => {
    expect(body).toMatch(/async startEnrollmentIfNotEnrolled\(args: \{/);
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toMatch(/if \(existing\?\.enrolledAt != null\) return null;/);
    expect(body).toMatch(/updatedAt: nextRevision\(args\.now, existing\.updatedAt\),/);
    expect(body).toMatch(/enrolledAt: null,/);
  });

  it('completeEnrollmentIfPending CASes the exact pending revision and inserts hashes in the transaction', () => {
    expect(body).toMatch(/async completeEnrollmentIfPending\(args: \{/);
    expect(body).toMatch(/currentWebSessionId: string;/);
    expect(body).toMatch(/\.from\(accounts\)[\s\S]{0,180}\.for\('update'\)/);
    expect(body).toMatch(/eq\(webSessions\.id, args\.currentWebSessionId\)/);
    expect(body).toMatch(/eq\(webSessions\.authEpoch, authority\.authEpoch\)/);
    expect(body).toMatch(/gt\(webSessions\.expiresAt, args\.now\)/);
    expect(body).toMatch(/isNull\(accountMfa\.enrolledAt\)/);
    expect(body).toMatch(/eq\(accountMfa\.updatedAt, args\.expectedUpdatedAt\)/);
    expect(body).toMatch(/if \(!updated\) return false;/);
    expect(body).toMatch(/await tx\.insert\(accountMfaRecoveryCodes\)\.values\(/);
    expect(body).toMatch(/authEpoch: sql`\$\{accounts\.authEpoch\} \+ 1`/);
    expect(body).toMatch(
      /\.set\(\{ authEpoch: nextAuthority\.authEpoch, mfaSatisfiedAt: args\.now \}\)/,
    );
  });

  it('touchLastUsed: update set lastUsedAt + updatedAt where accountId', () => {
    expect(body).toMatch(/async touchLastUsed\(accountId: string, now: Date\): Promise<void> \{/);
    expect(body).toMatch(/const nowIso = now\.toISOString\(\);/);
    expect(body).toMatch(/lastUsedAt: now,/);
    expect(body).toMatch(
      /updatedAt: sql`GREATEST\(\$\{accountMfa\.updatedAt\} \+ INTERVAL '1 millisecond', \$\{nowIso\}::timestamptz\)`,/,
    );
    expect(body).toMatch(/\.where\(eq\(accountMfa\.accountId, accountId\)\);/);
  });

  it('deleteForAccount shares the credential lock and deletes codes plus enrollment atomically', () => {
    expect(body).toMatch(/async deleteForAccount\(accountId: string\): Promise<void> \{/);
    expect(body).toMatch(/await this\.database\.db\.transaction\(async \(tx\) => \{/);
    expect(body).toMatch(/mfa-credentials:\$\{accountId\}/);
    expect(body).toMatch(/\.delete\(accountMfaRecoveryCodes\)/);
    expect(body).toMatch(/await tx\.delete\(accountMfa\)/);
    // V-994 — the two account predicates, which ARE the tenant boundary here.
    // The two assertions above pin the delete CALLS, and both match a delete with
    // no WHERE clause at all: removing both predicates left this file's six arms
    // green, along with 73 unit tests and 67 real-Postgres integration tests. The
    // executable proof is `db-mfa-delete-for-account-tenant-scope-drizzle`; this
    // is the cheap text layer beside it, in the shape the `listUnusedRecoveryCodes`
    // arm below already uses for its own predicate.
    expect(body).toMatch(
      /\.delete\(accountMfaRecoveryCodes\)\s*\n?\s*\.where\(eq\(accountMfaRecoveryCodes\.accountId, accountId\)\)/,
    );
    expect(body).toMatch(
      /await tx\.delete\(accountMfa\)\.where\(eq\(accountMfa\.accountId, accountId\)\)/,
    );
  });

  it('nextRevision guarantees a stale snapshot cannot share the persisted revision', () => {
    expect(body).toMatch(
      /function nextRevision\(now: Date, previous: Date\): Date \{\s*\n?\s*return new Date\(Math\.max\(now\.getTime\(\), previous\.getTime\(\) \+ 1\)\);/,
    );
  });

  it('listUnusedRecoveryCodes: where and(accountId, isNull(usedAt)); orderBy desc(createdAt)', () => {
    expect(body).toMatch(
      /async listUnusedRecoveryCodes\(accountId: string\): Promise<RecoveryCodeRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(accountMfaRecoveryCodes\)\s*\n?\s*\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(accountMfaRecoveryCodes\.accountId, accountId\),\s*\n?\s*isNull\(accountMfaRecoveryCodes\.usedAt\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.orderBy\(desc\(accountMfaRecoveryCodes\.createdAt\)\);\s*\n?\s*return rows\.map\(toRecoveryCodeRow\);\s*\n?\s*\}/,
    );
  });

  it('markRecoveryCodeUsed: atomic consume via and(eq(id), isNull(usedAt)) + .returning length===1 — replay-safe AND returns whether THIS call spent it (#5 double-spend gate)', () => {
    expect(body).toMatch(
      /async markRecoveryCodeUsed\(id: string, now: Date\): Promise<boolean> \{[\s\S]*?const updated = await this\.database\.db\s*\n?\s*\.update\(accountMfaRecoveryCodes\)\s*\n?\s*\.set\(\{ usedAt: now \}\)\s*\n?\s*\.where\(and\(eq\(accountMfaRecoveryCodes\.id, id\), isNull\(accountMfaRecoveryCodes\.usedAt\)\)\)\s*\n?\s*\.returning\(\{ id: accountMfaRecoveryCodes\.id \}\);\s*\n?\s*return updated\.length === 1;\s*\n?\s*\}/,
    );
  });

  it('replaceRecoveryCodesIfCurrent is one CAS + invalidate + insert transaction', () => {
    expect(body).toMatch(/async replaceRecoveryCodesIfCurrent\(args: \{/);
    expect(body).toMatch(/eq\(accountMfa\.updatedAt, args\.expectedUpdatedAt\)/);
    expect(body).toMatch(/sql`\$\{accountMfa\.enrolledAt\} IS NOT NULL`/);
    expect(body).toMatch(/\.set\(\{ usedAt: args\.now \}\)/);
    expect(body).toMatch(/isNull\(accountMfaRecoveryCodes\.usedAt\)/);
    expect(body).toMatch(/args\.hashes\.map\(\(codeHash\) => \(\{/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
