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
//   • upsertSecret framing: conditional enrolledAt set only when
//     args.enrolledAt !== null (preserves enrolledAt on re-enroll
//     verify path).
//   • touchLastUsed: lastUsedAt + updatedAt.
//   • deleteForAccount framing pinned: cascades on accounts FK but
//     belt-and-braces explicit delete on recovery codes (because
//     accountMfa cascade is on accounts only).
//   • insertRecoveryCodes: bulk insert; empty-hashes early return.
//   • listUnusedRecoveryCodes: account + isNull(usedAt) + desc
//     createdAt.
//   • markRecoveryCodeUsed: idempotent via and(eq(id), isNull(usedAt))
//     — replay-safe.
//   • markAllRecoveryCodesUsed: account-scoped invalidate-on-rotate.

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

  it('imports: and/desc/eq/isNull/or/sql from drizzle-orm; MfaEnrollmentRow/MfaRepo/RecoveryCodeRow from services/mfa; Database; accountMfa + accountMfaRecoveryCodes', () => {
    expect(body).toMatch(/import \{ and, desc, eq, isNull, or, sql \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{ MfaEnrollmentRow, MfaRepo, RecoveryCodeRow \} from '\.\.\/services\/mfa\.js';/,
    );
    expect(body).toMatch(/import \{ accountMfa, accountMfaRecoveryCodes \} from '\.\/schema\.js';/);
  });

  it('toEnrollmentRow: 9-field MfaEnrollmentRow (accountId + totpSecretCiphertext/Iv/Tag + enrolledAt + lastUsedAt + lastUsedTotpCounter + created/updated_at)', () => {
    expect(body).toMatch(
      /function toEnrollmentRow\(r: typeof accountMfa\.\$inferSelect\): MfaEnrollmentRow \{\s*\n?\s*return \{\s*\n?\s*accountId: r\.accountId,\s*\n?\s*totpSecretCiphertext: r\.totpSecretCiphertext,\s*\n?\s*totpSecretIv: r\.totpSecretIv,\s*\n?\s*totpSecretTag: r\.totpSecretTag,\s*\n?\s*enrolledAt: r\.enrolledAt,\s*\n?\s*lastUsedAt: r\.lastUsedAt,\s*\n?\s*lastUsedTotpCounter: r\.lastUsedTotpCounter,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('consumeTotpCounter: atomic strict-monotonic conditional UPDATE (TOTP replay defence, migration 0090)', () => {
    expect(body).toMatch(/async consumeTotpCounter\(args: \{/);
    expect(body).toMatch(/\.set\(\{ lastUsedTotpCounter: args\.counter, updatedAt: args\.now \}\)/);
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

  it("upsertSecret: setOnConflict seeded with ciphertext+iv+tag+updatedAt; conditional enrolledAt set only when args.enrolledAt !== null (preserves enrolledAt on re-enroll verify path); onConflictDoUpdate target=accountId; throws 'upsertSecret: insert returned no row'", () => {
    expect(body).toMatch(
      /const setOnConflict: Record<string, unknown> = \{\s*\n?\s*totpSecretCiphertext: args\.ciphertext,\s*\n?\s*totpSecretIv: args\.iv,\s*\n?\s*totpSecretTag: args\.tag,\s*\n?\s*updatedAt: args\.now,\s*\n?\s*\};\s*\n?\s*if \(args\.enrolledAt !== null\) setOnConflict\.enrolledAt = args\.enrolledAt;/,
    );
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*\n?\s*target: accountMfa\.accountId,\s*\n?\s*set: setOnConflict,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('upsertSecret: insert returned no row'\);/,
    );
  });

  it('touchLastUsed: update set lastUsedAt + updatedAt where accountId', () => {
    expect(body).toMatch(
      /async touchLastUsed\(accountId: string, now: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(accountMfa\)\s*\n?\s*\.set\(\{ lastUsedAt: now, updatedAt: now \}\)\s*\n?\s*\.where\(eq\(accountMfa\.accountId, accountId\)\);\s*\n?\s*\}/,
    );
  });

  it("deleteForAccount framing pinned: 'Recovery codes cascade via FK on accountId, but we rely on the accounts FK cascade — accountMfa cascade is on accounts only. Belt-and-braces: explicit delete on the recovery codes table.'", () => {
    expect(body).toMatch(
      /\/\/ Recovery codes cascade via FK on accountId, but we rely on the\s*\n?\s*\/\/ accounts FK cascade — accountMfa cascade is on accounts only\.\s*\n?\s*\/\/ Belt-and-braces: explicit delete on the recovery codes table\./,
    );
    expect(body).toMatch(
      /await this\.database\.db\.delete\(accountMfa\)\.where\(eq\(accountMfa\.accountId, accountId\)\);/,
    );
    expect(body).toMatch(
      /await this\.database\.db\s*\n?\s*\.delete\(accountMfaRecoveryCodes\)\s*\n?\s*\.where\(eq\(accountMfaRecoveryCodes\.accountId, accountId\)\);/,
    );
  });

  it('insertRecoveryCodes: empty-hashes early return; bulk insert maps each hash → {accountId, codeHash, createdAt}', () => {
    expect(body).toMatch(
      /async insertRecoveryCodes\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*hashes: string\[\];\s*\n?\s*now: Date;\s*\n?\s*\}\): Promise<void> \{\s*\n?\s*if \(args\.hashes\.length === 0\) return;\s*\n?\s*await this\.database\.db\.insert\(accountMfaRecoveryCodes\)\.values\(\s*\n?\s*args\.hashes\.map\(\(h\) => \(\{\s*\n?\s*accountId: args\.accountId,\s*\n?\s*codeHash: h,\s*\n?\s*createdAt: args\.now,\s*\n?\s*\}\)\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('listUnusedRecoveryCodes: where and(accountId, isNull(usedAt)); orderBy desc(createdAt)', () => {
    expect(body).toMatch(
      /async listUnusedRecoveryCodes\(accountId: string\): Promise<RecoveryCodeRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(accountMfaRecoveryCodes\)\s*\n?\s*\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(accountMfaRecoveryCodes\.accountId, accountId\),\s*\n?\s*isNull\(accountMfaRecoveryCodes\.usedAt\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.orderBy\(desc\(accountMfaRecoveryCodes\.createdAt\)\);\s*\n?\s*return rows\.map\(toRecoveryCodeRow\);\s*\n?\s*\}/,
    );
  });

  it("markRecoveryCodeUsed: idempotent via and(eq(id), isNull(usedAt)) — replay-safe (can't re-mark used→used)", () => {
    expect(body).toMatch(
      /async markRecoveryCodeUsed\(id: string, now: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(accountMfaRecoveryCodes\)\s*\n?\s*\.set\(\{ usedAt: now \}\)\s*\n?\s*\.where\(and\(eq\(accountMfaRecoveryCodes\.id, id\), isNull\(accountMfaRecoveryCodes\.usedAt\)\)\);\s*\n?\s*\}/,
    );
  });

  it("markAllRecoveryCodesUsed: account-scoped + isNull(usedAt) guard so already-used rows aren't re-stamped", () => {
    expect(body).toMatch(
      /async markAllRecoveryCodesUsed\(accountId: string, now: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(accountMfaRecoveryCodes\)\s*\n?\s*\.set\(\{ usedAt: now \}\)\s*\n?\s*\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(accountMfaRecoveryCodes\.accountId, accountId\),\s*\n?\s*isNull\(accountMfaRecoveryCodes\.usedAt\),\s*\n?\s*\),\s*\n?\s*\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
