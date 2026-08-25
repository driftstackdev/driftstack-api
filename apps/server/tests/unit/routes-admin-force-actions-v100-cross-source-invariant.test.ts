// W1046 — routes/admin-force-actions V-100 + D-020/D-025 cross-source
// invariant. Pins apps/server/src/routes/admin-force-actions.ts:
//
//   V-100 anchor — 'V-100: admin force-actions on customer resources'.
//
//   Endpoint roster — 2 routes:
//     POST /v1/admin/sessions/:id/destroy   — force-destroy
//     POST /v1/admin/api-keys/:id/revoke    — force-revoke
//
//   Bypass-ownership framing — 'These bypass the usual ownership
//   check (admin scope only). Both write an admin_audit_log row
//   before responding (D-025: audit-write before response is not
//   best-effort)'.
//
//   driftstack_internal_admin scope on both routes (preHandler) +
//   redundant requireScope() call inside handler — defense-in-depth
//   for any future preHandler regression.
//
//   PUBLIC_ID_RE prefix_uuid pattern shared with admin-incidents /
//   admin-webhooks.
//
//   Session destroy: ses_-prefixed id, explicit admin-unscoped
//   serialized repo outcome inside D-025, authoritative idempotency.
//
//   API-key revoke: key_-prefixed id, idempotent on already-revoked,
//   uses an explicitly admin-unscoped atomic outcome inside D-025,
//   and invalidates authCache only for the persisted winner.
//
//   D-020 authCache.invalidateKey is best-effort (try/catch — cache
//   failure non-fatal).
//
//   AdminAuditAction taxonomy — 'session.destroyed_by_admin' +
//   'api_key.revoked_by_admin' with idempotent: true marker on
//   already-terminal-state replays.
//
// stays in lockstep across apps/server/src/routes/admin-force-actions.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1046 routes/admin-force-actions V-100 + D-020/D-025 cross-source invariant', () => {
  // ─── V-100 anchor + framing ──────────────────────────────────

  it("CRITICAL V-100 anchor — 'V-100: admin force-actions on customer resources'. The single-anchor design ties the route to the admin force-action family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/V-100: admin force-actions on customer resources\./);
  });

  it("CRITICAL bypass-ownership framing — 'These bypass the usual ownership check (admin scope only). Both write an admin_audit_log row before responding (D-025: audit-write before response is not best-effort)'. The bypass posture + audit-before-response is what makes admin force actions both powerful and auditable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/These bypass the usual ownership check \(admin scope only\)\. Both/);
    expect(p).toMatch(/write an admin_audit_log row before responding \(D-025: audit-write/);
    expect(p).toMatch(/before response is not best-effort\)\./);
  });

  // ─── Endpoint roster ─────────────────────────────────────────

  it('CRITICAL endpoint roster — POST /v1/admin/sessions/:id/destroy + POST /v1/admin/api-keys/:id/revoke. The 2-endpoint surface is the canonical force-action set.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(
      /POST \/v1\/admin\/sessions\/:id\/destroy\s+— force-destroy a customer session/,
    );
    expect(p).toMatch(
      /POST \/v1\/admin\/api-keys\/:id\/revoke\s+— force-revoke a customer API key/,
    );
    expect(p).toMatch(/'\/v1\/admin\/sessions\/:id\/destroy'/);
    expect(p).toMatch(/'\/v1\/admin\/api-keys\/:id\/revoke'/);
  });

  // ─── Defense-in-depth admin scope ────────────────────────────

  it('CRITICAL defense-in-depth — driftstack_internal_admin scope appears in BOTH preHandler AND in-handler requireScope() call. The redundant in-handler check protects against future preHandler regression.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    const preHandlerRefs =
      p.match(
        /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\]/g,
      ) ?? [];
    expect(preHandlerRefs.length, 'preHandler scope chain count').toBeGreaterThanOrEqual(2);
    const inHandlerRefs = p.match(/requireScope\(ctx, 'driftstack_internal_admin'\);/g) ?? [];
    expect(inHandlerRefs.length, 'in-handler requireScope count').toBeGreaterThanOrEqual(2);
  });

  // ─── PUBLIC_ID_RE + uuidFromPrefixedId ───────────────────────

  it("CRITICAL PUBLIC_ID_RE — '^[a-z]{3}_(uuid)$'. Shared with admin-incidents + admin-webhooks; drift would break the prefix-id family contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\//,
    );
  });

  // ─── Session destroy ─────────────────────────────────────────

  it('CRITICAL session destroy — ses_-prefixed id + explicit null admin scope + authoritative serialized outcome inside D-025', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/uuidFromPrefixedId\(request\.params\.id, 'ses'\)/);
    expect(p).toMatch(/sessionRepo\.destroySessionSerialized\(/);
    expect(p).toMatch(/id: sessionId,\s*accountId: null,/);
    expect(p).toMatch(/if \(result\.kind === 'already_terminal'\) \{/);
    expect(p).toMatch(/idempotent: true/);
    expect(p).toMatch(
      /destroyDriverSessionWithTimeout\(\(\) => driver\.destroy\(session\.driverSessionId\)\)/,
    );
    expect(p).toMatch(/if \(result\.kind === 'driver_error'\) throw result\.error;/);
  });

  it("CRITICAL session destroy response — { id: ses_<uuid>, status: 'destroyed', destroyed_at: ISO|null }. The 3-field envelope is identical between fresh-destroy and idempotent-replay paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/id: `ses_\$\{outcome\.session\.id\}`,/);
    expect(p).toMatch(/status: 'destroyed',/);
    expect(p).toMatch(/destroyed_at: outcome\.session\.destroyedAt\?\.toISOString\(\) \?\? null,/);
  });

  it("CRITICAL session destroy event payload — 'destroyed' event type with { force: true, by_admin: true, reason? } shape. The by_admin marker distinguishes admin force-destroys from customer-initiated destroys in event history.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/type: 'destroyed',/);
    expect(p).toMatch(/force: true,\s*by_admin: true,/);
    expect(p).toMatch(/\.\.\.\(reason !== undefined \? \{ reason \} : \{\}\),/);
  });

  // ─── API-key revoke + D-020 ──────────────────────────────────

  it('CRITICAL API-key revoke — explicit unscoped atomic outcome inside D-025; authoritative loser marker; winner-only cache invalidation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/uuidFromPrefixedId\(request\.params\.id, 'key'\)/);
    expect(p).toContain('const result = await apiKeysRepo.revokeApiKeyAtomic({');
    expect(p).toContain('accountId: null,');
    expect(p).toContain("if (result.kind === 'already_revoked') {");
    expect(p).toContain('resolvedInputPayload = { ...inputPayload, idempotent: true };');
    expect(p).toMatch(/authCache\.invalidateKey\(key\.id\)/);
  });

  it("CRITICAL D-020 cache invalidation comment + best-effort pattern — 'Invalidate any cached AccountContext entries for this key so the next auth read sees the revocation immediately (D-020 cache invalidation pattern)'. The post-write timing is what makes the revocation visible to the next request.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/Invalidate any cached AccountContext entries for this key/);
    expect(p).toMatch(
      /so the next auth read sees the revocation immediately\s*\/\/ \(D-020 cache invalidation pattern\)\./,
    );
  });

  it('CRITICAL cache-invalidation best-effort — try/catch around authCache.invalidateKey with comment "cache failure non-fatal". Drift to throw-on-cache-failure would prevent admin revocation when cache is offline.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/\/\* cache failure non-fatal \*\//);
  });

  // ─── AdminAuditAction taxonomy ───────────────────────────────

  it("CRITICAL admin audit-action taxonomy — 'session.destroyed_by_admin' + 'api_key.revoked_by_admin'. The _by_admin suffix distinguishes admin force-actions from customer self-service in audit-log filter UI.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/'session\.destroyed_by_admin'/);
    expect(p).toMatch(/'api_key\.revoked_by_admin'/);
  });

  // ─── ForceActionBodySchema ───────────────────────────────────

  it("CRITICAL ForceActionBody — optional reason 1..500 chars. The optional 500-char reason gives ops a free-text 'why' field without forcing process overhead.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(p).toMatch(/reason: z\.string\(\)\.min\(1\)\.max\(500\)\.optional\(\),/);
  });

  // ─── trusted-proxy-aware client IP ───────────────────────────

  it('CRITICAL clientIp uses shared trustProxy-resolved request.ip for D-025 audit-IP capture.', () => {
    const route = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-force-actions.ts'));
    expect(route).toMatch(/import \{ readClientIp \} from '\.\.\/lib\/client-ip\.js';/);
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/client-ip.ts'));
    expect(lib).toMatch(/return request\.ip \?\? null;/);
    expect(lib).not.toMatch(/request\.headers\['x-forwarded-for'\]/);
  });
});
