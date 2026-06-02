// W443.B — drift guard for apps/server/src/db/legal-repo.ts.
// LegalRepo with append-only acceptances + DISTINCT ON latest-per-
// document query. Drift here either drops the DISTINCT ON pattern
// (latest-acceptance per document silently returns the wrong row on
// re-accept) or breaks the dual-shape execute() driver compatibility
// (Drizzle-execute results differ across pg-style/array shapes).
//
//   • recordAcceptance: 6-field values write → returning(); throws
//     on no-row.
//   • latestAcceptancesForAccount framing pinned: DISTINCT ON
//     (document_key) keeps the row with the latest accepted_at;
//     Drizzle doesn't expose DISTINCT ON natively but raw SQL is
//     fine.
//   • Raw SQL with ORDER BY document_key, accepted_at DESC, id DESC
//     (the id tiebreaker makes the per-doc pick deterministic on an
//     accepted_at tie).
//   • Dual-shape iter framing pinned: Drizzle's execute() returns
//     RowList iterable but TS sometimes narrows differently per
//     driver; iterate for-of so both pg-style { rows } and array-
//     shaped results are covered.
//   • Output Map<documentKey, LegalAcceptanceRecord>.
//   • mapRow helper for the typed-insert path.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/legal-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W443.B apps/server/src/db/legal-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed implementation of LegalRepo.'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed implementation of LegalRepo\./);
  });

  it('imports: sql tag from drizzle-orm; LegalAcceptanceRecord/LegalRepo/RecordAcceptanceInput; Database; legalAcceptances schema', () => {
    expect(body).toMatch(/import \{ sql \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{ LegalAcceptanceRecord, LegalRepo, RecordAcceptanceInput \} from '\.\.\/services\/legal\.js';/,
    );
    expect(body).toMatch(/import \{ legalAcceptances \} from '\.\/schema\.js';/);
  });

  it("recordAcceptance: 6-field values write (accountId + documentKey + version + contentHash + acceptedFromIp + acceptedUserAgent) → returning(); throws 'legal_acceptances insert returned no row' on undefined", () => {
    expect(body).toMatch(
      /async recordAcceptance\(input: RecordAcceptanceInput\): Promise<LegalAcceptanceRecord> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.insert\(legalAcceptances\)\s*\n?\s*\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*documentKey: input\.documentKey,\s*\n?\s*version: input\.version,\s*\n?\s*contentHash: input\.contentHash,\s*\n?\s*acceptedFromIp: input\.acceptedFromIp,\s*\n?\s*acceptedUserAgent: input\.acceptedUserAgent,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(row === undefined\) \{\s*\n?\s*throw new Error\('legal_acceptances insert returned no row'\);\s*\n?\s*\}\s*\n?\s*return mapRow\(row\);\s*\n?\s*\}/,
    );
  });

  it("latestAcceptancesForAccount framing pinned: 'For each (account, document_key), keep the row with the latest accepted_at. Postgres DISTINCT ON is the cleanest way; Drizzle doesn't expose it natively but raw SQL is fine.'", () => {
    expect(body).toMatch(
      /\/\/ For each \(account, document_key\), keep the row with the latest\s*\n?\s*\/\/ accepted_at\. Postgres DISTINCT ON is the cleanest way; Drizzle\s*\n?\s*\/\/ doesn't expose it natively but raw SQL is fine\./,
    );
  });

  it('Raw SQL: SELECT DISTINCT ON (document_key) <8 fields> FROM legal_acceptances WHERE account_id = ${accountId} ORDER BY document_key, accepted_at DESC, id DESC (id tiebreaker = deterministic per-doc pick)', () => {
    expect(body).toMatch(
      /SELECT DISTINCT ON \(document_key\)\s*\n?\s*id, account_id, document_key, version, content_hash,\s*\n?\s*accepted_from_ip, accepted_user_agent, accepted_at\s*\n?\s*FROM legal_acceptances\s*\n?\s*WHERE account_id = \$\{accountId\}\s*\n?\s*ORDER BY document_key, accepted_at DESC, id DESC/,
    );
  });

  it("Dual-shape iter framing pinned: 'Drizzle's execute() returns RowList iterable but TS sometimes narrows differently per driver. Iterate `for-of` so both pg-style { rows } and array-shaped results are covered.'", () => {
    expect(body).toMatch(
      /\/\/ Drizzle's execute\(\) returns RowList iterable but TS sometimes\s*\n?\s*\/\/ narrows differently per driver\. Iterate `for-of` so both\s*\n?\s*\/\/ pg-style \{ rows \} and array-shaped results are covered\./,
    );
    expect(body).toMatch(
      /const iter = \(rows as unknown as \{ rows\?: unknown\[\] \}\)\.rows \?\? rows;/,
    );
  });

  it('Map<documentKey, LegalAcceptanceRecord> output; iterator maps raw row to {id, accountId(account_id), documentKey(document_key), version, contentHash(content_hash), acceptedFromIp(accepted_from_ip), acceptedUserAgent(accepted_user_agent), acceptedAt(new Date(accepted_at))}; out.set(mapped.documentKey, mapped)', () => {
    expect(body).toMatch(/const out = new Map<string, LegalAcceptanceRecord>\(\);/);
    expect(body).toMatch(
      /const mapped: LegalAcceptanceRecord = \{\s*\n?\s*id: raw\.id,\s*\n?\s*accountId: raw\.account_id,\s*\n?\s*documentKey: raw\.document_key,\s*\n?\s*version: raw\.version,\s*\n?\s*contentHash: raw\.content_hash,\s*\n?\s*acceptedFromIp: raw\.accepted_from_ip,\s*\n?\s*acceptedUserAgent: raw\.accepted_user_agent,\s*\n?\s*acceptedAt: new Date\(raw\.accepted_at\),\s*\n?\s*\};\s*\n?\s*out\.set\(mapped\.documentKey, mapped\);/,
    );
  });

  it('mapRow typed-insert helper: 8-field LegalAcceptanceRecord (id + accountId + documentKey + version + contentHash + acceptedFromIp + acceptedUserAgent + acceptedAt)', () => {
    expect(body).toMatch(
      /function mapRow\(row: typeof legalAcceptances\.\$inferSelect\): LegalAcceptanceRecord \{\s*\n?\s*return \{\s*\n?\s*id: row\.id,\s*\n?\s*accountId: row\.accountId,\s*\n?\s*documentKey: row\.documentKey,\s*\n?\s*version: row\.version,\s*\n?\s*contentHash: row\.contentHash,\s*\n?\s*acceptedFromIp: row\.acceptedFromIp,\s*\n?\s*acceptedUserAgent: row\.acceptedUserAgent,\s*\n?\s*acceptedAt: row\.acceptedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
