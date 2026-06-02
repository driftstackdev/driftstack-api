// W994 — db/legal-repo cross-source invariant. Three-hundred-
// twentieth in the drift-guard series. Pins the apps/server/src/db/
// legal-repo.ts Drizzle legal-acceptance repo primitive:
//
//   Header — 'Drizzle-backed implementation of LegalRepo'.
//
//   2-method surface — recordAcceptance + latestAcceptancesForAccount.
//
//   recordAcceptance values shape — 6 fields: accountId + documentKey
//     + version + contentHash + acceptedFromIp + acceptedUserAgent.
//
//   recordAcceptance throws 'legal_acceptances insert returned no row'
//     on missing returning() result.
//
//   latestAcceptancesForAccount DISTINCT ON framing — 'For each
//   (account, document_key), keep the row with the latest accepted_at.
//   Postgres DISTINCT ON is the cleanest way; Drizzle doesn't expose
//   it natively but raw SQL is fine'.
//
//   Raw SQL with 8-field SELECT — id + account_id + document_key +
//     version + content_hash + accepted_from_ip + accepted_user_agent
//     + accepted_at + ORDER BY document_key, accepted_at DESC, id DESC
//     (id tiebreaker = deterministic per-doc pick on an accepted_at tie).
//
//   RowList vs array framing — 'Drizzle's execute() returns RowList
//   iterable but TS sometimes narrows differently per driver. Iterate
//   for-of so both pg-style { rows } and array-shaped results are
//   covered'.
//
//   Map keyed by documentKey — out.set(mapped.documentKey, mapped).
//
//   mapRow 8-field shape — id + accountId + documentKey + version +
//     contentHash + acceptedFromIp + acceptedUserAgent + acceptedAt.
//
// stays in lockstep across apps/server/src/db/legal-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W994 db/legal-repo cross-source invariant', () => {
  // ─── Header + impl ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/legal-repo.ts header — 'Drizzle-backed implementation of LegalRepo'. The Drizzle-impl + LegalRepo-interface separation is the V-156 + L-001 legal repo contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed implementation of LegalRepo\./);
    expect(p).toMatch(/export class DrizzleLegalRepo implements LegalRepo \{/);
  });

  // ─── 2-method surface ────────────────────────────────────────

  it('CRITICAL 2-method surface — recordAcceptance + latestAcceptancesForAccount. The 2-method LegalRepo contract: insert one + fetch latest-per-doc.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(
      /async recordAcceptance\(input: RecordAcceptanceInput\): Promise<LegalAcceptanceRecord> \{/,
    );
    expect(p).toMatch(/async latestAcceptancesForAccount\(/);
    expect(p).toMatch(/\): Promise<Map<string, LegalAcceptanceRecord>> \{/);
  });

  // ─── recordAcceptance 6-field values shape ───────────────────

  it('CRITICAL recordAcceptance values 6-field shape — accountId + documentKey + version + contentHash + acceptedFromIp + acceptedUserAgent. The 6-field record carries the V-218 legal-evidence shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/\.values\(\{/);
    expect(p).toMatch(/accountId: input\.accountId,/);
    expect(p).toMatch(/documentKey: input\.documentKey,/);
    expect(p).toMatch(/version: input\.version,/);
    expect(p).toMatch(/contentHash: input\.contentHash,/);
    expect(p).toMatch(/acceptedFromIp: input\.acceptedFromIp,/);
    expect(p).toMatch(/acceptedUserAgent: input\.acceptedUserAgent,/);
  });

  it("CRITICAL recordAcceptance defensive 'legal_acceptances insert returned no row' check. The named-error guards against silent drizzle behavior.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/if \(row === undefined\) \{/);
    expect(p).toMatch(/throw new Error\('legal_acceptances insert returned no row'\);/);
  });

  // ─── DISTINCT ON framing ─────────────────────────────────────

  it("CRITICAL DISTINCT ON framing — 'For each (account, document_key), keep the row with the latest accepted_at. Postgres DISTINCT ON is the cleanest way; Drizzle doesn't expose it natively but raw SQL is fine'. The latest-per-document_key + raw-SQL design is the L-001 acceptance contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/\/\/ For each \(account, document_key\), keep the row with the latest/);
    expect(p).toMatch(/\/\/ accepted_at\. Postgres DISTINCT ON is the cleanest way; Drizzle/);
    expect(p).toMatch(/\/\/ doesn't expose it natively but raw SQL is fine\./);
  });

  // ─── Raw SQL 8-field SELECT ──────────────────────────────────

  it('CRITICAL raw SQL has DISTINCT ON (document_key) + 8-field SELECT + WHERE account_id + ORDER BY document_key, accepted_at DESC, id DESC. The DISTINCT-ON + ORDER-BY pair is what makes the latest-per-doc query work; the id tiebreaker makes the pick deterministic on an accepted_at tie.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/SELECT DISTINCT ON \(document_key\)/);
    expect(p).toMatch(/id, account_id, document_key, version, content_hash,/);
    expect(p).toMatch(/accepted_from_ip, accepted_user_agent, accepted_at/);
    expect(p).toMatch(/FROM legal_acceptances/);
    expect(p).toMatch(/WHERE account_id = \$\{accountId\}/);
    expect(p).toMatch(/ORDER BY document_key, accepted_at DESC, id DESC/);
  });

  // ─── RowList vs array framing ────────────────────────────────

  it("CRITICAL RowList-vs-array framing — 'Drizzle's execute() returns RowList iterable but TS sometimes narrows differently per driver. Iterate for-of so both pg-style { rows } and array-shaped results are covered'. The dual-shape iteration is what makes the repo driver-agnostic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle's execute\(\) returns RowList iterable but TS sometimes/);
    expect(p).toMatch(/\/\/ narrows differently per driver\. Iterate `for-of` so both/);
    expect(p).toMatch(/\/\/ pg-style \{ rows \} and array-shaped results are covered\./);
    expect(p).toMatch(
      /const iter = \(rows as unknown as \{ rows\?: unknown\[\] \}\)\.rows \?\? rows;/,
    );
  });

  // ─── Map keyed by documentKey ────────────────────────────────

  it("CRITICAL output Map keyed by documentKey — 'out.set(mapped.documentKey, mapped)'. The documentKey-keyed Map lets callers do O(1) per-doc lookup.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/const out = new Map<string, LegalAcceptanceRecord>\(\);/);
    expect(p).toMatch(/out\.set\(mapped\.documentKey, mapped\);/);
  });

  // ─── acceptedAt Date coercion ────────────────────────────────

  it("CRITICAL acceptedAt coerced via 'new Date(raw.accepted_at)'. The string-or-Date input is normalized to Date.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(/acceptedAt: new Date\(raw\.accepted_at\),/);
  });

  // ─── mapRow 8-field shape ────────────────────────────────────

  it('CRITICAL mapRow 8-field shape — id + accountId + documentKey + version + contentHash + acceptedFromIp + acceptedUserAgent + acceptedAt. The 8-field LegalAcceptanceRecord is the V-218 service-layer shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts'));
    expect(p).toMatch(
      /function mapRow\(row: typeof legalAcceptances\.\$inferSelect\): LegalAcceptanceRecord \{/,
    );
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/accountId: row\.accountId,/);
    expect(p).toMatch(/documentKey: row\.documentKey,/);
    expect(p).toMatch(/version: row\.version,/);
    expect(p).toMatch(/contentHash: row\.contentHash,/);
    expect(p).toMatch(/acceptedFromIp: row\.acceptedFromIp,/);
    expect(p).toMatch(/acceptedUserAgent: row\.acceptedUserAgent,/);
    expect(p).toMatch(/acceptedAt: row\.acceptedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/db-legal-repo-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
