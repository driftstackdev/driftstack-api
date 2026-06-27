// W997 — db/mfa-repo V-353b cross-source invariant. Three-hundred-
// twenty-third in the drift-guard series. Pins the apps/server/src/
// db/mfa-repo.ts Drizzle MFA repo primitive:
//
//   V-353b anchor — 'V-353b — Drizzle implementation of MfaRepo'.
//
//   DrizzleMfaRepo 8-method surface — findByAccount + upsertSecret +
//     touchLastUsed + deleteForAccount + insertRecoveryCodes +
//     listUnusedRecoveryCodes + markRecoveryCodeUsed +
//     markAllRecoveryCodesUsed.
//
//   upsertSecret onConflictDoUpdate framing — target accountId; set
//     ciphertext + iv + tag + updatedAt; preserve enrolledAt unless
//     explicitly provided. The 'preserve enrolledAt' design lets
//     mid-enrollment + post-enrollment-change paths share one method.
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
//   markAllRecoveryCodesUsed mass-set + same isNull(usedAt) guard.
//
//   insertRecoveryCodes early-return on empty hashes array.
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

  // ─── 8-method surface ────────────────────────────────────────

  it('CRITICAL 8-method surface — findByAccount + upsertSecret + touchLastUsed + deleteForAccount + insertRecoveryCodes + listUnusedRecoveryCodes + markRecoveryCodeUsed + markAllRecoveryCodesUsed. The 8-method MfaRepo contract covers enrollment + recovery-code lifecycle.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(
      /async findByAccount\(accountId: string\): Promise<MfaEnrollmentRow \| null> \{/,
    );
    expect(p).toMatch(/async upsertSecret\(args: \{/);
    expect(p).toMatch(/async touchLastUsed\(accountId: string, now: Date\): Promise<void> \{/);
    expect(p).toMatch(/async deleteForAccount\(accountId: string\): Promise<void> \{/);
    expect(p).toMatch(/async insertRecoveryCodes\(args: \{/);
    expect(p).toMatch(
      /async listUnusedRecoveryCodes\(accountId: string\): Promise<RecoveryCodeRow\[\]> \{/,
    );
    expect(p).toMatch(/async markRecoveryCodeUsed\(id: string, now: Date\): Promise<boolean> \{/);
    expect(p).toMatch(
      /async markAllRecoveryCodesUsed\(accountId: string, now: Date\): Promise<void> \{/,
    );
  });

  // ─── upsertSecret onConflictDoUpdate ─────────────────────────

  it('CRITICAL upsertSecret onConflictDoUpdate target = accountId. The conflict-on-accountId design enforces 1-row-per-account uniqueness.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/\.onConflictDoUpdate\(\{/);
    expect(p).toMatch(/target: accountMfa\.accountId,/);
    expect(p).toMatch(/set: setOnConflict,/);
  });

  it('CRITICAL upsertSecret setOnConflict 4 always-fields — ciphertext + iv + tag + updatedAt. EnrolledAt is conditionally set only when args.enrolledAt !== null (preserves first-enrollment timestamp during rotation).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/totpSecretCiphertext: args\.ciphertext,/);
    expect(p).toMatch(/totpSecretIv: args\.iv,/);
    expect(p).toMatch(/totpSecretTag: args\.tag,/);
    expect(p).toMatch(/updatedAt: args\.now,/);
    expect(p).toMatch(
      /if \(args\.enrolledAt !== null\) setOnConflict\.enrolledAt = args\.enrolledAt;/,
    );
  });

  it("CRITICAL upsertSecret 'upsertSecret: insert returned no row' defensive check. The named-error captures the never-happens path.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/if \(!row\) throw new Error\('upsertSecret: insert returned no row'\);/);
  });

  // ─── touchLastUsed 2-field touch ─────────────────────────────

  it('CRITICAL touchLastUsed updates lastUsedAt + updatedAt. The 2-field touch keeps the audit-trail consistent.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/\.update\(accountMfa\)/);
    expect(p).toMatch(/\.set\(\{ lastUsedAt: now, updatedAt: now \}\)/);
    expect(p).toMatch(/\.where\(eq\(accountMfa\.accountId, accountId\)\)/);
  });

  // ─── deleteForAccount 2-delete framing ───────────────────────

  it("CRITICAL deleteForAccount 2-delete framing — 'Recovery codes cascade via FK on accountId, but we rely on the accounts FK cascade — accountMfa cascade is on accounts only. Belt-and-braces: explicit delete on the recovery codes table'. The belt-and-braces double-delete is defense-in-depth against FK-cascade misconfig.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/\/\/ Recovery codes cascade via FK on accountId, but we rely on the/);
    expect(p).toMatch(/\/\/ accounts FK cascade — accountMfa cascade is on accounts only\./);
    expect(p).toMatch(/\/\/ Belt-and-braces: explicit delete on the recovery codes table\./);
    expect(p).toMatch(
      /await this\.database\.db\.delete\(accountMfa\)\.where\(eq\(accountMfa\.accountId, accountId\)\);/,
    );
    expect(p).toMatch(/await this\.database\.db/);
    expect(p).toMatch(/\.delete\(accountMfaRecoveryCodes\)/);
    expect(p).toMatch(/\.where\(eq\(accountMfaRecoveryCodes\.accountId, accountId\)\);/);
  });

  // ─── insertRecoveryCodes early-return ────────────────────────

  it("CRITICAL insertRecoveryCodes early-return on empty hashes — 'if (args.hashes.length === 0) return;'. The 0-on-empty avoids emitting empty INSERT VALUES.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/if \(args\.hashes\.length === 0\) return;/);
    expect(p).toMatch(/args\.hashes\.map\(\(h\) => \(\{/);
    expect(p).toMatch(/accountId: args\.accountId,/);
    expect(p).toMatch(/codeHash: h,/);
    expect(p).toMatch(/createdAt: args\.now,/);
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

  // ─── markAllRecoveryCodesUsed mass-set ───────────────────────

  it("CRITICAL markAllRecoveryCodesUsed mass-set — 'and(eq(accountId), isNull(usedAt))' affects every unused code. The mass-mark-used design is what V-353b 'regenerate-codes' flow calls before issuing fresh codes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/mfa-repo.ts'));
    expect(p).toMatch(/eq\(accountMfaRecoveryCodes\.accountId, accountId\),/);
    expect(p).toMatch(/isNull\(accountMfaRecoveryCodes\.usedAt\),/);
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
