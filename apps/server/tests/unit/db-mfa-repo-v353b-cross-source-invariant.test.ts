// W997 — db/mfa-repo V-353b cross-source invariant. Three-hundred-
// twenty-third in the drift-guard series. Pins the apps/server/src/
// db/mfa-repo.ts Drizzle MFA repo primitive:
//
//   V-353b anchor — 'V-353b — Drizzle implementation of MfaRepo'.
//
//   Enrollment start/completion and recovery-code replacement serialize on a
//     per-account transaction lock. Credential issuers also compare-and-set a
//     monotonic updatedAt revision so only one plaintext batch can win.
//
//   deleteForAccount 2-delete framing — 'Recovery codes cascade via
//   FK on accountId, but we rely on the accounts FK cascade —
//   accountMfa cascade is on accounts only. Belt-and-braces: explicit
//   delete on the recovery codes table'.
//
//   listUnusedRecoveryCodes WHERE — and(eq(accountId), isNull(usedAt))
//     + orderBy desc(createdAt).
//
//   markRecoveryCodeUsed double-check — and(eq(id), isNull(usedAt))
//     prevents replay (idempotency).
//
//   Recovery-code replacement invalidates and inserts in one transaction.
//
//   toEnrollmentRow 8-field shape — accountId + totpSecretCiphertext
//     + totpSecretIv + totpSecretTag + enrolledAt + lastUsedAt +
//     createdAt + updatedAt.
//
//   toRecoveryCodeRow 5-field shape — id + accountId + codeHash +
//     usedAt + createdAt.
//
// stays in lockstep across apps/server/src/db/mfa-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W997 db/mfa-repo V-353b cross-source invariant', () => {
  // ─── V-353b anchor ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/mfa-repo.ts header pins V-353b anchor — 'V-353b — Drizzle implementation of MfaRepo'. The V-353b anchor is the MFA repo policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/\/\/ V-353b — Drizzle implementation of MfaRepo\./);
    expect(p).toMatch(/export class DrizzleMfaRepo implements MfaRepo \{/);
  });

  // ─── repository surface ─────────────────────────────────────

  it('CRITICAL surface includes atomic start/complete/replace credential transitions', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(
      /async findByAccount\(accountId: string\): Promise<MfaEnrollmentRow \| null> \{/,
    );
    expect(p).toMatch(/async startEnrollmentIfNotEnrolled\(args: \{/);
    expect(p).toMatch(/async completeEnrollmentIfPending\(args: \{/);
    expect(p).toMatch(/async touchLastUsed\(accountId: string, now: Date\): Promise<void> \{/);
    expect(p).toMatch(/async deleteForAccount\(accountId: string\): Promise<void> \{/);
    expect(p).toMatch(
      /async listUnusedRecoveryCodes\(accountId: string\): Promise<RecoveryCodeRow\[\]> \{/,
    );
    expect(p).toMatch(/async markRecoveryCodeUsed\(id: string, now: Date\): Promise<boolean> \{/);
    expect(p).toMatch(/async replaceRecoveryCodesIfCurrent\(args: \{/);
  });

  // ─── serialized issuance + monotonic CAS ─────────────────────

  it('CRITICAL all credential lifecycle transactions share the per-account advisory lock', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p.match(/pg_advisory_xact_lock/g)).toHaveLength(4);
    expect(p.match(/mfa-credentials:/g)).toHaveLength(4);
  });

  it('CRITICAL start refuses enrolled rows and advances pending revisions monotonically', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/if \(existing\?\.enrolledAt != null\) return null;/);
    expect(p).toMatch(/totpSecretCiphertext: args\.ciphertext,/);
    expect(p).toMatch(/totpSecretIv: args\.iv,/);
    expect(p).toMatch(/totpSecretTag: args\.tag,/);
    expect(p).toMatch(/updatedAt: nextRevision\(args\.now, existing\.updatedAt\),/);
  });

  it('CRITICAL completion CASes pending+expected revision before inserting the first code batch', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/isNull\(accountMfa\.enrolledAt\),/);
    expect(p).toMatch(/eq\(accountMfa\.updatedAt, args\.expectedUpdatedAt\),/);
    expect(p).toMatch(/if \(!updated\) return false;/);
    expect(p).toMatch(/await tx\.insert\(accountMfaRecoveryCodes\)\.values\(/);
  });

  // ─── touchLastUsed 2-field touch ─────────────────────────────

  it('CRITICAL touchLastUsed updates lastUsedAt + updatedAt. The 2-field touch keeps the audit-trail consistent.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/\.update\(accountMfa\)/);
    expect(p).toMatch(/lastUsedAt: now,/);
    expect(p).toMatch(/GREATEST\(\$\{accountMfa\.updatedAt\} \+ INTERVAL '1 millisecond'/);
    expect(p).toMatch(/\.where\(eq\(accountMfa\.accountId, accountId\)\)/);
  });

  // ─── deleteForAccount 2-delete framing ───────────────────────

  it('CRITICAL deleteForAccount deletes recovery codes and enrollment inside the same locked transaction', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/async deleteForAccount[\s\S]*?this\.database\.db\.transaction/);
    expect(p).toMatch(/\.delete\(accountMfaRecoveryCodes\)/);
    expect(p).toMatch(/await tx\.delete\(accountMfa\)/);
  });

  // ─── listUnusedRecoveryCodes WHERE + ORDER ───────────────────

  it('CRITICAL listUnusedRecoveryCodes filter — and(eq(accountId), isNull(usedAt)) + orderBy desc(createdAt). The (account, unused) pair is the V-353b recovery-pull contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/eq\(accountMfaRecoveryCodes\.accountId, accountId\),/);
    expect(p).toMatch(/isNull\(accountMfaRecoveryCodes\.usedAt\),/);
    expect(p).toMatch(/\.orderBy\(desc\(accountMfaRecoveryCodes\.createdAt\)\);/);
  });

  // ─── markRecoveryCodeUsed isNull double-check ────────────────

  it("CRITICAL markRecoveryCodeUsed double-check — 'and(eq(id), isNull(usedAt))' prevents replay (idempotency) + returns rowcount (#5 double-spend gate). The isNull(usedAt) guard makes the mark-used UPDATE match exactly one row on the first consume; .returning + length===1 lets the caller reject a concurrent second consume.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/\.update\(accountMfaRecoveryCodes\)/);
    expect(p).toMatch(/\.set\(\{ usedAt: now \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(accountMfaRecoveryCodes\.id, id\), isNull\(accountMfaRecoveryCodes\.usedAt\)\)\)/,
    );
    expect(p).toMatch(/\.returning\(\{ id: accountMfaRecoveryCodes\.id \}\);/);
    expect(p).toMatch(/return updated\.length === 1;/);
  });

  // ─── atomic recovery-code replacement ────────────────────────

  it('CRITICAL replacement CASes the enrolled revision and atomically invalidates+inserts', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/async replaceRecoveryCodesIfCurrent\(args: \{/);
    expect(p).toMatch(/sql`\$\{accountMfa\.enrolledAt\} IS NOT NULL`/);
    expect(p).toMatch(/eq\(accountMfa\.updatedAt, args\.expectedUpdatedAt\)/);
    expect(p).toMatch(/eq\(accountMfaRecoveryCodes\.accountId, args\.accountId\),/);
    expect(p).toMatch(/isNull\(accountMfaRecoveryCodes\.usedAt\),/);
    expect(p).toMatch(/args\.hashes\.map\(\(codeHash\) => \(\{/);
  });

  // ─── toEnrollmentRow 8-field mapper ──────────────────────────

  it('CRITICAL toEnrollmentRow 8-field mapper — accountId + totpSecretCiphertext + totpSecretIv + totpSecretTag + enrolledAt + lastUsedAt + createdAt + updatedAt. The 8-field row includes both ciphertext-IV-tag (envelope-encrypted TOTP secret) and lifecycle timestamps.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(
      /function toEnrollmentRow\(r: typeof accountMfa\.\$inferSelect\): MfaEnrollmentRow \{/,
    );
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/totpSecretCiphertext: r\.totpSecretCiphertext,/);
    expect(p).toMatch(/totpSecretIv: r\.totpSecretIv,/);
    expect(p).toMatch(/totpSecretTag: r\.totpSecretTag,/);
    expect(p).toMatch(/enrolledAt: r\.enrolledAt,/);
    expect(p).toMatch(/lastUsedAt: r\.lastUsedAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
  });

  // ─── toRecoveryCodeRow 5-field mapper ────────────────────────

  it('CRITICAL toRecoveryCodeRow 5-field mapper — id + accountId + codeHash + usedAt + createdAt. The 5-field shape carries the recovery-code minimal-fact set.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(
      /function toRecoveryCodeRow\(r: typeof accountMfaRecoveryCodes\.\$inferSelect\): RecoveryCodeRow \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/codeHash: r\.codeHash,/);
    expect(p).toMatch(/usedAt: r\.usedAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-mfa-repo-v353b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
