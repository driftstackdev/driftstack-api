// W418.A — drift guard for apps/server/src/routes/legal.ts.
// /v1/legal/{documents,required,accept}. Drift here either drops the
// content-hash gate (lets customers "accept" a stale version with no
// way to recover the original) or breaks the 409-with-current-hash
// envelope (client can't refresh-and-retry on version drift).
//
//   • Framing pinned: 3 routes — list catalog + required-for-account
//     + record acceptance; all auth-gated.
//   • Document text NOT served via API — read from published static
//     URLs once marketing site is live.
//   • AcceptBodySchema: zod document_key + version (each 1..64) +
//     content_hash 64-char hex SHA-256 (case-insensitive regex).
//   • Auth posture: requireAuth + rateLimit('global') on all 3.
//   • LegalDocumentNotFoundError → 404; LegalDocumentMismatchError
//     → 409 with refresh+retry envelope (document_key + provided/
//     current version + provided/current content_hash).
//   • zod.ZodError → 400 BadRequestError with semicolon-joined issues
//     (defensive: AcceptBodySchema.parse throws ZodError on miss).
//   • requireCtx helper: null-safe ctx accessor.
//   • prefixId helper: `${prefix}_${uuid}`.
//   • ipFromRequest helper: trustProxy-aware request.ip with null
//     fallback for unit-test inject paths.
//   • userAgentFromRequest helper: 1024-char truncation cap.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/legal.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W418.A apps/server/src/routes/legal.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: 3 routes (list documents + required + accept); auth-gated; document text NOT served via API', () => {
    expect(body).toMatch(/Legal routes — three endpoints under \/v1\/legal\./);
    expect(body).toMatch(/GET\s+\/v1\/legal\/documents\s+— list catalog \(auth required\)/);
    expect(body).toMatch(/GET\s+\/v1\/legal\/required\s+— list documents the calling account/);
    expect(body).toMatch(/POST \/v1\/legal\/accept\s+— record acceptance \(auth required\)/);
    expect(body).toMatch(
      /Documents themselves are static text in `docs\/legal\/\*\.md`; this\s*\/\/\s*endpoint set deals with the acceptance side\. Document content is\s*\/\/\s*not served via this API — the GUI \/ customer dashboard reads from\s*\/\/\s*the published static URLs once the marketing site is live\./,
    );
  });

  it('AcceptBodySchema: document_key/version 1..64 + content_hash 64-char hex SHA-256 case-insensitive', () => {
    expect(body).toMatch(
      /const AcceptBodySchema = z\.object\(\{\s*document_key: z\.string\(\)\.min\(1\)\.max\(64\),\s*version: z\.string\(\)\.min\(1\)\.max\(64\),\s*content_hash: z\s*\.string\(\)\s*\.regex\(\/\^\[0-9a-f\]\{64\}\$\/i, 'content_hash must be a 64-character lowercase hex SHA-256 digest'\),\s*\}\);/,
    );
  });

  it("Auth posture: requireAuth + rateLimit('global') on all 3 routes; account_owner on the accept mutation", () => {
    // POST /v1/legal/accept now carries app.requireScope('account_owner')
    // between requireAuth and rateLimit (V-481), so count each guard
    // independently. The two GET routes keep the bare pair.
    expect((body.match(/app\.requireAuth/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((body.match(/app\.rateLimit\('global'\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((body.match(/app\.requireScope\('account_owner'\)/g) ?? []).length).toBe(1);
  });

  it('GET /v1/legal/documents: catalog list with 7-field public shape (document_key, title, version, effective_date, content_hash, source_path, byte_size)', () => {
    expect(body).toMatch(
      /return \{\s*data: service\.list\(\)\.map\(\(entry\) => \(\{\s*document_key: entry\.documentKey,\s*title: entry\.title,\s*version: entry\.version,\s*effective_date: entry\.effectiveDate,\s*content_hash: entry\.contentHash,\s*source_path: entry\.sourcePath,\s*byte_size: entry\.byteSize,\s*\}\)\),\s*\};/,
    );
  });

  it('GET /v1/legal/required: service.required(accountId); 5-field shape (document_key/current_version/content_hash/reason/last_accepted_version)', () => {
    expect(body).toMatch(/const required = await service\.required\(ctx\.account\.id\);/);
    expect(body).toMatch(
      /return \{\s*data: required\.map\(\(r\) => \(\{\s*document_key: r\.documentKey,\s*current_version: r\.currentVersion,\s*content_hash: r\.contentHash,\s*reason: r\.reason,\s*last_accepted_version: r\.lastAcceptedVersion,\s*\}\)\),\s*\};/,
    );
  });

  it('POST /v1/legal/accept: service.recordAcceptance dispatch with snake→camel mapping + acceptedFromIp/acceptedUserAgent + 201 reply with lacc_/acc_ prefixed ids', () => {
    expect(body).toMatch(
      /const record = await service\.recordAcceptance\(\{\s*accountId: ctx\.account\.id,\s*documentKey: body\.document_key,\s*version: body\.version,\s*contentHash: body\.content_hash,\s*acceptedFromIp: ipFromRequest\(request\),\s*acceptedUserAgent: userAgentFromRequest\(request\),\s*\}\);/,
    );
    expect(body).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*id: prefixId\('lacc', record\.id\),\s*account_id: prefixId\('acc', record\.accountId\),\s*document_key: record\.documentKey,\s*version: record\.version,\s*content_hash: record\.contentHash,\s*accepted_at: record\.acceptedAt\.toISOString\(\),\s*\}\);/,
    );
  });

  it('Accept error map: LegalDocumentNotFoundError → 404 + LegalDocumentMismatchError → 409 with refresh-and-retry envelope (provided/current version + hash)', () => {
    expect(body).toMatch(
      /if \(err instanceof LegalDocumentNotFoundError\) \{\s*throw new NotFoundError\(`Legal document \$\{err\.documentKey\} not found\.`\);/,
    );
    expect(body).toMatch(
      /\/\/ 409: customer attempted to accept a stale version\. The\s*\/\/ response carries the current version \+ hash so the client\s*\/\/ can re-fetch \+ retry\./,
    );
    expect(body).toMatch(
      /throw new ConflictError\(\s*`Legal document \$\{err\.documentKey\} has changed since you fetched it\. Refresh and re-accept\.`,\s*\{\s*document_key: err\.documentKey,\s*provided_version: err\.providedVersion,\s*current_version: err\.currentVersion,\s*provided_content_hash: err\.providedHash,\s*current_content_hash: err\.currentHash,\s*\},\s*\);/,
    );
  });

  it('Accept error map: zod.ZodError → 400 BadRequestError with semicolon-joined issue messages', () => {
    expect(body).toMatch(
      /if \(err instanceof z\.ZodError\) \{\s*throw new BadRequestError\(err\.issues\.map\(\(i\) => i\.message\)\.join\('; '\)\);/,
    );
  });

  it('requireCtx + prefixId helpers: null-safe ctx accessor + `${prefix}_${uuid}` formatter', () => {
    expect(body).toMatch(
      /function requireCtx\(request: FastifyRequest\): NonNullable<FastifyRequest\['account'\]> \{\s*if \(request\.account === null \|\| request\.account === undefined\) \{\s*throw new Error\('account context missing after requireAuth'\);\s*\}\s*return request\.account;/,
    );
    expect(body).toMatch(
      /function prefixId\(prefix: string, uuid: string\): string \{\s*return `\$\{prefix\}_\$\{uuid\}`;/,
    );
  });

  it('ipFromRequest framing pinned: trustProxy-aware + null fallback for fastify.inject without real socket', () => {
    expect(body).toMatch(
      /\/\/ Fastify exposes request\.ip after the trustProxy plumbing in app\.ts\s*\/\/ populates from X-Forwarded-For\. Null if not available \(e\.g\. unit\s*\/\/ tests injecting through fastify\.inject without a real socket\)\./,
    );
    expect(body).toMatch(/return typeof ip === 'string' && ip\.length > 0 \? ip : null;/);
  });

  it('userAgentFromRequest: 1024-char truncation cap; null on miss', () => {
    expect(body).toMatch(
      /function userAgentFromRequest\(request: FastifyRequest\): string \| null \{\s*const ua = request\.headers\['user-agent'\];\s*if \(typeof ua === 'string' && ua\.length > 0\) \{\s*\/\/ Truncate to a sane bound — UA strings can be exotic\.\s*return ua\.slice\(0, 1024\);/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + zod + LegalDocumentMismatch/NotFoundError/LegalService + BadRequestError/ConflictError/NotFoundError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{\s*LegalDocumentMismatchError,\s*LegalDocumentNotFoundError,\s*type LegalService,\s*\} from '\.\.\/services\/legal\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, ConflictError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
