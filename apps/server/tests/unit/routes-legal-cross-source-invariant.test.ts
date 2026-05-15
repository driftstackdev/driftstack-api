// W1036 — routes/legal cross-source invariant. Three-hundred-sixty-
// second in the drift-guard series. Pins the apps/server/src/routes/
// legal.ts legal-acceptance routes:
//
//   Header — 'Legal routes — three endpoints under /v1/legal'.
//
//   3-endpoint inventory:
//     - GET /v1/legal/documents — list catalog (auth required).
//     - GET /v1/legal/required — list documents the calling account
//       must accept (auth required).
//     - POST /v1/legal/accept — record acceptance (auth required).
//
//   Static-text framing — 'Documents themselves are static text in
//   docs/legal/*.md; this endpoint set deals with the acceptance
//   side. Document content is not served via this API — the GUI /
//   customer dashboard reads from the published static URLs once
//   the marketing site is live'.
//
//   AcceptBodySchema — document_key (1-64) + version (1-64) +
//     content_hash (64-char lowercase hex SHA-256 regex).
//
//   POST /accept response 6-field — id (lacc_ prefix) + account_id
//     (acc_ prefix) + document_key + version + content_hash +
//     accepted_at (ISO) + 201 status.
//
//   3-error mapping in /accept:
//     - LegalDocumentNotFoundError → NotFoundError.
//     - LegalDocumentMismatchError → ConflictError with 5-field
//       payload (document_key + provided_version + current_version
//       + provided_content_hash + current_content_hash).
//     - ZodError → BadRequestError joining issues with '; '.
//
//   ipFromRequest helper — request.ip non-empty-string or null
//     (test seam).
//
//   userAgentFromRequest helper — truncate to 1024 chars.
//
// stays in lockstep across apps/server/src/routes/legal.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1036 routes/legal cross-source invariant', () => {
  it('CRITICAL header + 3-endpoint inventory.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/\/\/ Legal routes — three endpoints under \/v1\/legal\./);
    expect(p).toMatch(/GET\s+\/v1\/legal\/documents\s+— list catalog \(auth required\)/);
    expect(p).toMatch(/GET\s+\/v1\/legal\/required\s+— list documents the calling account/);
    expect(p).toMatch(/POST \/v1\/legal\/accept\s+— record acceptance \(auth required\)/);
  });

  it("CRITICAL static-text framing — 'Documents themselves are static text in docs/legal/*.md; this endpoint set deals with the acceptance side. Document content is not served via this API — the GUI / customer dashboard reads from the published static URLs once the marketing site is live'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/\/\/ Documents themselves are static text in `docs\/legal\/\*\.md`; this/);
    expect(p).toMatch(/\/\/ endpoint set deals with the acceptance side\. Document content is/);
    expect(p).toMatch(/\/\/ not served via this API — the GUI \/ customer dashboard reads from/);
    expect(p).toMatch(/\/\/ the published static URLs once the marketing site is live\./);
  });

  it('CRITICAL AcceptBodySchema — document_key (1-64) + version (1-64) + content_hash 64-char lowercase-hex SHA-256 regex.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/document_key: z\.string\(\)\.min\(1\)\.max\(64\),/);
    expect(p).toMatch(/version: z\.string\(\)\.min\(1\)\.max\(64\),/);
    expect(p).toMatch(/content_hash: z/);
    expect(p).toMatch(
      /\.regex\(\/\^\[0-9a-f\]\{64\}\$\/i, 'content_hash must be a 64-character lowercase hex SHA-256 digest'\)/,
    );
  });

  it('CRITICAL POST /accept 201 response 6-field — id (lacc_ prefix) + account_id (acc_ prefix) + document_key + version + content_hash + accepted_at (ISO).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/return reply\.code\(201\)\.send\(\{/);
    expect(p).toMatch(/id: prefixId\('lacc', record\.id\),/);
    expect(p).toMatch(/account_id: prefixId\('acc', record\.accountId\),/);
    expect(p).toMatch(/document_key: record\.documentKey,/);
    expect(p).toMatch(/version: record\.version,/);
    expect(p).toMatch(/content_hash: record\.contentHash,/);
    expect(p).toMatch(/accepted_at: record\.acceptedAt\.toISOString\(\),/);
  });

  it("CRITICAL /accept 3-error mapping — LegalDocumentNotFoundError → NotFoundError + LegalDocumentMismatchError → 409 ConflictError with 5-field payload + ZodError → BadRequestError joining issues with '; '.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/if \(err instanceof LegalDocumentNotFoundError\) \{/);
    expect(p).toMatch(
      /throw new NotFoundError\(`Legal document \$\{err\.documentKey\} not found\.`\);/,
    );
    expect(p).toMatch(/if \(err instanceof LegalDocumentMismatchError\) \{/);
    expect(p).toMatch(/throw new ConflictError\(/);
    expect(p).toMatch(/document_key: err\.documentKey,/);
    expect(p).toMatch(/provided_version: err\.providedVersion,/);
    expect(p).toMatch(/current_version: err\.currentVersion,/);
    expect(p).toMatch(/provided_content_hash: err\.providedHash,/);
    expect(p).toMatch(/current_content_hash: err\.currentHash,/);
    expect(p).toMatch(/if \(err instanceof z\.ZodError\) \{/);
    expect(p).toMatch(
      /throw new BadRequestError\(err\.issues\.map\(\(i\) => i\.message\)\.join\('; '\)\);/,
    );
  });

  it("CRITICAL stale-version conflict framing — '409: customer attempted to accept a stale version. The response carries the current version + hash so the client can re-fetch + retry'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/\/\/ 409: customer attempted to accept a stale version\. The/);
    expect(p).toMatch(/\/\/ response carries the current version \+ hash so the client/);
    expect(p).toMatch(/\/\/ can re-fetch \+ retry\./);
  });

  it('CRITICAL ipFromRequest helper — string + length > 0 else null; userAgentFromRequest truncates to 1024 chars.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/return typeof ip === 'string' && ip\.length > 0 \? ip : null;/);
    expect(p).toMatch(/\/\/ Truncate to a sane bound — UA strings can be exotic\./);
    expect(p).toMatch(/return ua\.slice\(0, 1024\);/);
  });

  it('CRITICAL prefixId helper + GET /documents 7-field list (document_key + title + version + effective_date + content_hash + source_path + byte_size).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts'));
    expect(p).toMatch(/function prefixId\(prefix: string, uuid: string\): string \{/);
    expect(p).toMatch(/return `\$\{prefix\}_\$\{uuid\}`;/);
    expect(p).toMatch(/document_key: entry\.documentKey,/);
    expect(p).toMatch(/title: entry\.title,/);
    expect(p).toMatch(/version: entry\.version,/);
    expect(p).toMatch(/effective_date: entry\.effectiveDate,/);
    expect(p).toMatch(/content_hash: entry\.contentHash,/);
    expect(p).toMatch(/source_path: entry\.sourcePath,/);
    expect(p).toMatch(/byte_size: entry\.byteSize,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/routes-legal-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
