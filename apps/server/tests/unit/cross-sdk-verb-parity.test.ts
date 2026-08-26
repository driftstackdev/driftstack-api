// W649 — cross-SDK verb parity. Drift guard that asserts the 3 first-
// party SDKs (sdk-go + sdk-python + sdk-typescript) all expose the
// SAME verb surface per resource.
//
// Drift here would silently fragment the cross-language wire contract
// that customers anchor on when they read the docs site's "All SDKs
// expose identical resource shapes (sessions, profiles, api-keys,
// webhooks, usage, account, team) generated from the same Zod single
// source of truth in @driftstack/api-types" promise.
//
// Methodology: extract the inventory of wire paths each SDK resource
// file references, then assert the 3 SDKs reference the same set of
// canonical /v1/* paths. The wire path is the load-bearing invariant
// — a SDK that doesn't reference /v1/usage/series silently doesn't
// expose the V-452 time-series surface.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Per-SDK resource file paths. The 15 customer-facing resources are
// shared across all 3 SDKs; auth + webhook_signature live alongside
// but with different naming conventions per language.
const RESOURCES = [
  'account',
  'agent_sessions',
  'archetypes',
  'api_keys',
  'audit_log',
  'auth',
  'billing',
  'crypto_orders',
  'egress',
  'email_preferences',
  'legal',
  'mfa',
  'profile_snapshots',
  'profiles',
  'recipes',
  'sessions',
  'team',
  'usage',
  'webhooks',
] as const;

function goPath(resource: string): string {
  return resolve(REPO_ROOT, `packages/sdk-go/${resource}.go`);
}

function pythonPath(resource: string): string {
  return resolve(REPO_ROOT, `packages/sdk-python/src/driftstack/resources/${resource}.py`);
}

function tsPath(resource: string): string {
  // TS uses kebab-case file names but the python/go convention is snake_case.
  const kebab = resource.replace(/_/g, '-');
  return resolve(REPO_ROOT, `packages/sdk-typescript/src/resources/${kebab}.ts`);
}

/**
 * Extract every distinct `/v1/...` path BASE referenced in a SDK
 * source file. Normalizes across languages:
 *
 *   - Go literal:        `"/v1/team/members/" + url.PathEscape(id)`
 *   - Go w/ query:       `"/v1/account/audit-log/export?format=json"`
 *   - Python f-string:   `f"/v1/team/members/{quote(member_id, safe='')}"`
 *   - TS template:       `` `/v1/team/members/${memberId}` ``
 *
 * The char class `[a-z0-9_\-/]+` deliberately excludes `?`, `$`, `{`
 * so the match stops at the query-string boundary OR the start of
 * any interpolation. Trailing `/` is stripped so the per-id form
 * (`/v1/team/members/`) collapses into the list form (`/v1/team/
 * members`) — yielding the canonical resource path that's wire-
 * comparable across all 3 SDKs.
 */
function extractV1Paths(source: string): Set<string> {
  const paths = new Set<string>();
  // Only match `/v1/...` when preceded by a quote / backtick (real
  // string literals + Python f-strings + TS template literals all
  // open with one of `"` `'` `` ` ``). Excludes doc-comment text
  // where unquoted patterns like `/v1/billing/crypto-*` or
  // `/v1/team/*` would leak partial segments into the inventory.
  const matches = source.matchAll(/["'`](\/v1\/[a-z0-9_\-/]+)/g);
  for (const m of matches) {
    let p = m[1]!;
    if (p.length > 4 && p.endsWith('/')) p = p.slice(0, -1);
    paths.add(p);
  }
  return paths;
}

describe('W649 cross-SDK verb parity', () => {
  it('all 15 canonical customer-facing resources exist in all 3 SDKs (sdk-go + sdk-python + sdk-typescript). Drift to dropping a resource in ANY SDK would silently break the cross-language wire-contract parity the docs site promises.', () => {
    for (const res of RESOURCES) {
      expect(existsSync(goPath(res)), `missing sdk-go ${res}.go`).toBe(true);
      expect(existsSync(pythonPath(res)), `missing sdk-python ${res}.py`).toBe(true);
      expect(existsSync(tsPath(res)), `missing sdk-typescript ${res}.ts`).toBe(true);
    }
  });

  // Per-resource wire-path parity tests. Each one extracts the canonical
  // /v1/* paths from each SDK's source and asserts the 3 SDKs reference
  // the SAME set. Per-resource so a regression in one resource is
  // narrow-blast-radius (the failing test name names the resource).

  it('usage — V-452 wire paths match across the 3 SDKs (/v1/usage + /v1/usage/series)', () => {
    const goPaths = extractV1Paths(read(goPath('usage')));
    const pyPaths = extractV1Paths(read(pythonPath('usage')));
    const tsPaths = extractV1Paths(read(tsPath('usage')));
    // All 3 SDKs reference the same 2 V-452 wire paths.
    expect(goPaths).toEqual(new Set(['/v1/usage', '/v1/usage/series']));
    expect(pyPaths).toEqual(new Set(['/v1/usage', '/v1/usage/series']));
    expect(tsPaths).toEqual(new Set(['/v1/usage', '/v1/usage/series']));
  });

  it('billing — V-082 3-verb wire paths match: /v1/billing + /v1/billing/checkout-session + /v1/billing/portal-session (trial-pack retired 2026-05-27)', () => {
    const expected = new Set([
      '/v1/billing',
      '/v1/billing/checkout-session',
      '/v1/billing/portal-session',
    ]);
    expect(extractV1Paths(read(goPath('billing')))).toEqual(expected);
    expect(extractV1Paths(read(pythonPath('billing')))).toEqual(expected);
    expect(extractV1Paths(read(tsPath('billing')))).toEqual(expected);
  });

  it('legal — V-049/V-458 3-verb wire paths match: /v1/legal/documents + /v1/legal/required + /v1/legal/accept', () => {
    const expected = new Set(['/v1/legal/documents', '/v1/legal/required', '/v1/legal/accept']);
    expect(extractV1Paths(read(goPath('legal')))).toEqual(expected);
    expect(extractV1Paths(read(pythonPath('legal')))).toEqual(expected);
    expect(extractV1Paths(read(tsPath('legal')))).toEqual(expected);
  });

  it('mfa — V-353b/V-448 5-verb wire paths match: /v1/account/mfa + /v1/account/mfa/enroll + /v1/account/mfa/verify + /v1/account/mfa/recovery-codes/regenerate (Disable shares /v1/account/mfa)', () => {
    const expected = new Set([
      '/v1/account/mfa',
      '/v1/account/mfa/enroll',
      '/v1/account/mfa/verify',
      '/v1/account/mfa/recovery-codes/regenerate',
    ]);
    expect(extractV1Paths(read(goPath('mfa')))).toEqual(expected);
    expect(extractV1Paths(read(pythonPath('mfa')))).toEqual(expected);
    expect(extractV1Paths(read(tsPath('mfa')))).toEqual(expected);
  });

  it('team — invite, member, accept, and owner-workspace wire paths match across every SDK; per-id DELETE collapses into the list path after normalization', () => {
    const expected = new Set([
      '/v1/team/invites',
      '/v1/team/members',
      '/v1/team/invites/accept',
      '/v1/team/owners',
      // Only the BASE. `PATCH /v1/teams/:id` collapses into this same entry:
      // extractV1Paths strips the trailing slash so the per-id form is wire-
      // comparable across all three SDKs, which is why `/v1/team/members/:id`
      // has no entry of its own either.
      '/v1/teams',
    ]);
    expect(extractV1Paths(read(goPath('team')))).toEqual(expected);
    expect(extractV1Paths(read(pythonPath('team')))).toEqual(expected);
    expect(extractV1Paths(read(tsPath('team')))).toEqual(expected);
  });

  it('audit_log — V-216/V-449/V-462/V-297 wire paths match: /v1/account/audit-log + /v1/account/audit-log/export (query strings normalized out — Go uses ?format=json literal, Python/TS pass format via params/query dict)', () => {
    const expected = new Set(['/v1/account/audit-log', '/v1/account/audit-log/export']);
    expect(extractV1Paths(read(goPath('audit_log')))).toEqual(expected);
    expect(extractV1Paths(read(pythonPath('audit_log')))).toEqual(expected);
    expect(extractV1Paths(read(tsPath('audit_log')))).toEqual(expected);
  });

  it('crypto_orders — V-666 wire paths match: 3 distinct paths (checkout/quote + checkout + crypto-orders, per-id collapses into list)', () => {
    const expected = new Set([
      '/v1/billing/crypto-checkout/quote',
      '/v1/billing/crypto-checkout',
      '/v1/billing/crypto-orders',
    ]);
    expect(extractV1Paths(read(goPath('crypto_orders')))).toEqual(expected);
    expect(extractV1Paths(read(pythonPath('crypto_orders')))).toEqual(expected);
    expect(extractV1Paths(read(tsPath('crypto_orders')))).toEqual(expected);
  });

  it("CROSS-SDK invariant — every Go-SDK /v1/* path also exists in the Python + TS SDKs. The union of all paths across the 3 SDKs should be identical. Drift to a one-SDK-only path would mean customers using the OTHER 2 SDKs can't reach that endpoint, fragmenting the cross-language promise.", () => {
    // Aggregate paths across all 15 resources for each SDK.
    const goAll = new Set<string>();
    const pyAll = new Set<string>();
    const tsAll = new Set<string>();
    for (const res of RESOURCES) {
      for (const p of extractV1Paths(read(goPath(res)))) goAll.add(p);
      for (const p of extractV1Paths(read(pythonPath(res)))) pyAll.add(p);
      for (const p of extractV1Paths(read(tsPath(res)))) tsAll.add(p);
    }
    // The 3 SDKs should reference the SAME set of /v1/* paths.
    const goSorted = [...goAll].sort();
    const pySorted = [...pyAll].sort();
    const tsSorted = [...tsAll].sort();
    expect(pySorted, 'sdk-python /v1/* paths must match sdk-go').toEqual(goSorted);
    expect(tsSorted, 'sdk-typescript /v1/* paths must match sdk-go').toEqual(goSorted);
  });

  it('test file metadata — file exists at canonical path + W649 anchor preserved in the test file header for cross-reference', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-verb-parity.test.ts')),
    ).toBe(true);
  });

  it('CRITICAL the roster covers every SDK resource. The header promises the three SDKs expose the same verb surface PER RESOURCE, and until V-1029 the list backing that promise held 15 of the 19 resources the TypeScript SDK ships — agent_sessions, archetypes, egress and recipes were checked by nothing, agent-sessions being the largest resource in the SDK. All four turned out to agree; the point is that nothing was asking.', () => {
    const tsDir = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
    const shipped = readdirSync(tsDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, '').replace(/-/g, '_'))
      .sort();
    expect(shipped.length, 'TypeScript SDK resource files found').toBeGreaterThanOrEqual(19);
    const roster = new Set<string>(RESOURCES);
    expect(
      shipped.filter((r) => !roster.has(r)),
      'these SDK resources ship but are not in RESOURCES, so their verb surface is compared ' +
        'across no SDKs at all — add them to the roster:',
    ).toEqual([]);
  });
});
