// Security drift-guard — the legacy `*Unscoped` by-id finders must have no
// callers. Customer-facing by-id lookups are account-scoped at the repo
// layer (`findSession(id, accountId)`, `findApiKey(id, accountId)`, ...) so
// a non-owned id returns null -> 404 (no IDOR). The two deliberate escape
// hatches, `findSessionUnscoped(id)` + `findApiKeyUnscoped(id)`, skip that
// scoping. Admin force-actions now use the stronger atomic repository
// primitives with an explicit `accountId: null` opt-in inside their D-025
// audit boundary instead of performing a separate unscoped read.
//
// This sweep pins that invariant: if a future change calls an `*Unscoped`
// finder from any other route/service, a non-owned id could be acted on
// without the account check — a customer-reachable IDOR. The guard fails
// the moment such a call appears anywhere in apps/server/src. A second
// non-vacuous assertion pins both deliberate admin-unscoped atomic calls.
//
// Discrimination: a CALL is a dot-invocation (`repo.findSessionUnscoped(`),
// whereas the repo definition (`async findSessionUnscoped(id`) and the repo
// interface declaration (`findSessionUnscoped(id: string): Promise<...>;`)
// have no leading dot — so matching `\.findXUnscoped\(` selects only call
// sites and ignores the definition + the type signatures.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!statSync(dir, { throwIfNoEntry: false })) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// A method CALL has a leading dot; the repo definition + interface
// declarations do not, so these select invocations only.
const CALL_PATTERNS = [/\.findSessionUnscoped\(/, /\.findApiKeyUnscoped\(/];
const ALLOWED_CALLER = 'apps/server/src/routes/admin-force-actions.ts';

describe('security: unscoped access requires explicit admin atomic authority', () => {
  it('CRITICAL findSessionUnscoped / findApiKeyUnscoped have zero callers — any new invocation bypasses the account check', () => {
    const files = listFiles(resolve(REPO_ROOT, 'apps/server/src'), ['.ts']);
    const callers = new Set<string>();
    for (const f of files) {
      const body = read(f);
      if (CALL_PATTERNS.some((re) => re.test(body))) {
        callers.add(relative(REPO_ROOT, f).split('\\').join('/'));
      }
    }
    expect([...callers].sort()).toEqual([]);
  });

  it('non-vacuous: admin force-actions explicitly opt into null scope on BOTH atomic primitives inside D-025', () => {
    const adminBody = read(resolve(REPO_ROOT, ALLOWED_CALLER));
    const apiRouteStart = adminBody.indexOf('// ── POST /v1/admin/api-keys/:id/revoke');
    expect(apiRouteStart).toBeGreaterThan(0);
    const sessionSection = adminBody.slice(0, apiRouteStart);
    const apiKeySection = adminBody.slice(apiRouteStart);
    expect(sessionSection).toMatch(
      /withAudit\(request, 'session\.destroyed_by_admin',[\s\S]+?perform: async \(\) => \{[\s\S]+?sessionRepo\.destroySessionSerialized\([\s\S]+?accountId: null,/,
    );
    expect(apiKeySection).toMatch(
      /withAudit\(request, 'api_key\.revoked_by_admin',[\s\S]+?perform: async \(\) => \{[\s\S]+?apiKeysRepo\.revokeApiKeyAtomic\(\{[\s\S]+?accountId: null,/,
    );
  });

  it('sanity: the call regex matches a dot-invocation but NOT the repo definition or interface declaration', () => {
    expect(/\.findSessionUnscoped\(/.test('await sessionRepo.findSessionUnscoped(sessionId)')).toBe(
      true,
    );
    // repo definition — `async findSessionUnscoped(id: string)` — no leading dot
    expect(
      /\.findSessionUnscoped\(/.test('async findSessionUnscoped(id: string): Promise<X> {'),
    ).toBe(false);
    // interface declaration — `findSessionUnscoped(id: string): Promise<...>;` — no leading dot
    expect(
      /\.findApiKeyUnscoped\(/.test('findApiKeyUnscoped(id: string): Promise<ApiKeyRow | null>;'),
    ).toBe(false);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/unscoped-finders-admin-only-sweep.test.ts'),
      ),
    ).toBe(true);
  });
});
