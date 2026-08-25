// W419.C — drift guard for apps/server/src/routes/admin-force-actions.ts.
// V-100 admin force-actions — destroy session + revoke API key. Both
// bypass usual ownership check (admin-scope only) + write
// admin_audit_log row before responding (D-025). Idempotent on
// already-destroyed/already-revoked. D-020 auth-cache invalidation on
// key revoke. Drift here either drops idempotency (re-destroys a
// destroyed session = double driver call) or drops D-020 cache
// invalidation (revoked key keeps working until cache TTL).
//
//   • V-100 framing pinned: 2 routes (destroy session + revoke API
//     key); ownership-check bypass (admin scope only); D-025 audit-
//     write before response is NOT best-effort.
//   • Defense-in-depth scope check: preHandler app.requireScope +
//     in-handler requireScope helper.
//   • ForceActionBodySchema: zod reason 1..500 optional; whole body
//     optional.
//   • clientIp helper: shared Fastify trustProxy-resolved request.ip
//     ?? null.
//   • withAudit wrapper: takes args object with targetAccountId +
//     targetResourceId + inputPayload + perform thunk; dual-write
//     success + error.
//   • Idempotency: authoritative serialized loser outcomes mark the
//     audit payload idempotent and return the persisted timestamp.
//   • Session destroy: explicit unscoped serialized repo authority
//     contains driver callback + terminal/event transaction.
//   • API key revoke: D-020 auth-cache invalidation; cache failure
//     non-fatal (swallow).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W419.C apps/server/src/routes/admin-force-actions.ts content parity', () => {
  const body = read(LIB);

  it('V-100 framing pinned: 2 routes — destroy session + revoke API key; admin-scope-only ownership bypass; D-025 audit-write-before-response NOT best-effort', () => {
    expect(body).toMatch(/V-100: admin force-actions on customer resources\./);
    expect(body).toMatch(
      /POST \/v1\/admin\/sessions\/:id\/destroy\s+— force-destroy a customer session/,
    );
    expect(body).toMatch(
      /POST \/v1\/admin\/api-keys\/:id\/revoke\s+— force-revoke a customer API key/,
    );
    expect(body).toMatch(
      /These bypass the usual ownership check \(admin scope only\)\. Both\s*\/\/\s*write an admin_audit_log row before responding \(D-025: audit-write\s*\/\/\s*before response is not best-effort\)\./,
    );
  });

  it('Defense-in-depth scope: preHandler app.requireScope + in-handler requireScope helper invocation in BOTH routes', () => {
    expect(body).toMatch(
      /\{ preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\] \},/,
    );
    const matches = body.match(/requireScope\(ctx, 'driftstack_internal_admin'\);/g);
    expect(matches?.length).toBe(2);
  });

  it('ForceActionBodySchema: zod reason 1..500 optional + whole body optional', () => {
    expect(body).toMatch(
      /const ForceActionBodySchema = z\s*\.object\(\{\s*reason: z\.string\(\)\.min\(1\)\.max\(500\)\.optional\(\),\s*\}\)\s*\.optional\(\);/,
    );
  });

  it('readClientIp imported from shared trustProxy-aware lib/client-ip.ts', () => {
    expect(body).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    expect(body).toMatch(/ipAddress: readClientIp\(request\),/);
  });

  it('AdminForceActionsRoutesOptions: sessionRepo + apiKeysRepo + driver + audit + authCache (nullable)', () => {
    expect(body).toMatch(
      /export interface AdminForceActionsRoutesOptions \{\s*sessionRepo: SessionRepo;\s*apiKeysRepo: ApiKeysRepo;\s*driver: Driver;\s*audit: AdminAuditService;\s*authCache: AuthCache \| null;\s*\}/,
    );
  });

  it('withAudit wrapper: D-025 success + error dual-write with deferred target/payload authority', () => {
    expect(body).toMatch(/Wrap a force-action with audit-on-success \+ audit-on-error per D-025\./);
    expect(body).toMatch(
      /async function withAudit<T>\(\s*request: FastifyRequest,\s*action: AdminAuditAction,\s*args: \{\s*targetAccountId: DeferredAuditValue<string \| null>;\s*targetResourceId: string;\s*inputPayload: DeferredAuditValue<Record<string, unknown>>;\s*perform: \(\) => Promise<T>;\s*\},\s*\): Promise<T> \{/,
    );
    expect(body).toContain('targetAccountId: resolveAuditValue(args.targetAccountId),');
    expect(body).toContain('inputPayload: resolveAuditValue(args.inputPayload),');
    expect(body).toMatch(
      /const normalizedCode =\s*err instanceof Error && err\.name \? err\.name\.toLowerCase\(\)\.replace\(\/error\$\/, ''\) : 'unknown';/,
    );
    expect(body).toContain("const code = normalizedCode || 'unknown';");
  });

  it('Session destroy idempotency comes from the authoritative serialized outcome inside D-025', () => {
    expect(body).toContain('const outcome = await withAudit(request,');
    expect(body).toContain("if (result.kind === 'already_terminal') {");
    expect(body).toContain('resolvedInputPayload = { ...inputPayload, idempotent: true };');
    expect(body).toMatch(
      /destroyed_at: outcome\.session\.destroyedAt\?\.toISOString\(\) \?\? null,/,
    );
  });

  it('Session destroy fresh path: explicit admin-unscoped serialized authority with driver callback + destroyed {force:true, by_admin:true, reason?} event', () => {
    expect(body).toMatch(
      /const result = await sessionRepo\.destroySessionSerialized\([\s\S]+?id: sessionId,\s*accountId: null,[\s\S]+?type: 'destroyed',[\s\S]+?force: true,\s*by_admin: true,[\s\S]+?destroyDriverSessionWithTimeout\(\(\) => driver\.destroy\(session\.driverSessionId\)\)/,
    );
    expect(body).toContain("if (result.kind === 'driver_error') throw result.error;");
  });

  it('API key revoke uses atomic authoritative outcome and marks concurrent losers idempotent', () => {
    expect(body).toContain('const outcome = await withAudit(request,');
    expect(body).toContain('const result = await apiKeysRepo.revokeApiKeyAtomic({');
    expect(body).toContain('accountId: null,');
    expect(body).toContain("if (result.kind === 'already_revoked') {");
    expect(body).toContain('resolvedInputPayload = { ...inputPayload, idempotent: true };');
    expect(body).toContain('const persistedRevokedAt = outcome.key.revokedAt;');
    expect(body).toContain('revoked_at: persistedRevokedAt.toISOString(),');
  });

  it('D-020 cache invalidation on key revoke: authCache.invalidateKey(key.id); failure non-fatal (swallow); pattern rationale comment', () => {
    expect(body).toMatch(
      /\/\/ Invalidate any cached AccountContext entries for this key\s*\/\/ so the next auth read sees the revocation immediately\s*\/\/ \(D-020 cache invalidation pattern\)\./,
    );
    expect(body).toMatch(
      /if \(authCache !== null\) \{\s*try \{\s*await authCache\.invalidateKey\(key\.id\);\s*\} catch \{\s*\/\* cache failure non-fatal \*\/\s*\}\s*\}/,
    );
  });

  it("404 NotFoundError on session-not-found OR key-not-found (uses uuidFromPrefixedId 'ses'|'key' for params)", () => {
    expect(body).toMatch(/const sessionId = uuidFromPrefixedId\(request\.params\.id, 'ses'\);/);
    expect(body).toMatch(/const keyId = uuidFromPrefixedId\(request\.params\.id, 'key'\);/);
    expect(body).toMatch(/if \(result\.kind === 'not_found'\) \{/);
    expect(body).toMatch(/throw new NotFoundError\(`Session "\$\{sessionId\}" not found\.`\);/);
    expect(body).toMatch(/if \(result\.kind === 'not_found'\) \{/);
    expect(body).toMatch(/throw new NotFoundError\(`API key "\$\{keyId\}" not found\.`\);/);
  });

  it('imports: FastifyInstance/FastifyRequest + zod + AdminAuditService/Action + SessionRepo + ApiKeysRepo + Driver + AuthCache + BadRequestError/NotFoundError + requireScope helper', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import type \{ AdminAuditService, AdminAuditAction \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(
      /import \{ destroyDriverSessionWithTimeout, type SessionRepo \} from '\.\.\/services\/sessions\.js';/,
    );
    expect(body).toMatch(/import type \{ ApiKeysRepo \} from '\.\.\/services\/api-keys\.js';/);
    expect(body).toMatch(/import type \{ Driver \} from '\.\.\/drivers\/types\.js';/);
    expect(body).toMatch(/import type \{ AuthCache \} from '\.\.\/services\/auth-cache\.js';/);
    expect(body).toMatch(
      /import \{ BadRequestError, NotFoundError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import \{ requireScope \} from '\.\.\/lib\/errors-helpers\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
