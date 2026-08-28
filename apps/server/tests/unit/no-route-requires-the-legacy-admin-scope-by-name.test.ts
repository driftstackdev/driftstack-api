// No route or service may REQUIRE the legacy `admin` scope by its literal name.
//
// V-174 turned `admin` into a compatibility alias: an old `admin` key still
// satisfies `account_owner` and the granular `admin:*` verbs, but the alias runs
// one way only. A requirement written as the literal — `requireScope('admin')`,
// `throwIfMissingScope(ctx, 'admin')` — is satisfied by NOTHING a real credential
// carries today: a customer dashboard session holds `account_owner`, a staff SSO
// session holds `driftstack_internal_admin`, and neither is `admin`. The route
// is unreachable for every live caller and green in every test, because the
// integration app helper used to default keys to `['read','write','admin']`,
// which satisfied the literal. Both halves are pinned here: the source carries
// no literal requirement, and the helper's default carries no `admin`.
//
// The bare token `'admin'` is not the key — it also names the team role enum
// and the OpenAPI tag — so the matcher is the REQUIREMENT shape, and the alias
// predicate itself (`scopesSatisfy` / `requireScope` implementations, which must
// mention the legacy value to alias it) is excluded by path, not by pattern.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', '..');
const SRC = resolve(SERVER, 'src');
const TEST_APP_HELPER = resolve(SERVER, 'tests', 'integration', '_helpers', 'build-test-app.ts');

/** The two implementations of the scope predicate — the only places the legacy value belongs. */
const PREDICATE_IMPLS = new Set(['lib/errors-helpers.ts', 'services/auth.ts']);

/**
 * A requirement of the literal legacy scope, in every shape the codebase uses to
 * demand a scope: the Fastify pre-handler factory, the throwing helper, and the
 * two boolean helpers. `'admin'` alone is not matched — `'admin:billing'` is a
 * real granular scope, so the closing quote must follow immediately.
 */
const LITERAL_ADMIN_REQUIREMENT =
  /\b(?:requireScope|throwIfMissingScope|hasScope|scopesSatisfy)\(\s*(?:[^()]*?,\s*)?'admin'\s*\)/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    // No existsSync guard: a moved src tree must throw here, not scan nothing.
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isProseLine(src: string, idx: number): boolean {
  const start = src.lastIndexOf('\n', idx - 1) + 1;
  const end = src.indexOf('\n', idx);
  return /^\s*(\*|\/\/)/.test(src.slice(start, end === -1 ? src.length : end));
}

function scan(): { offenders: string[]; filesScanned: number; requirementSites: number } {
  const offenders: string[] = [];
  let filesScanned = 0;
  let requirementSites = 0;
  for (const file of sourceFiles(SRC)) {
    const rel = file.slice(SRC.length + 1);
    filesScanned += 1;
    const src = readFileSync(file, 'utf8');
    // Non-vacuity: count every scope requirement of any value, so a matcher
    // that stopped seeing requirements altogether cannot pass by silence.
    requirementSites += (src.match(/\b(?:requireScope|throwIfMissingScope)\(/g) ?? []).length;
    if (PREDICATE_IMPLS.has(rel)) continue;
    for (const m of src.matchAll(LITERAL_ADMIN_REQUIREMENT)) {
      if (m.index === undefined || isProseLine(src, m.index)) continue;
      offenders.push(`${rel}:${src.slice(0, m.index).split('\n').length.toString()} ${m[0]}`);
    }
  }
  return { offenders, filesScanned, requirementSites };
}

describe('no route or service requires the legacy `admin` scope by its literal name', () => {
  it('CRITICAL the source carries no literal `admin` requirement outside the alias predicate', () => {
    const { offenders, filesScanned, requirementSites } = scan();
    expect(filesScanned).toBeGreaterThan(300);
    // Measured 2026-08-28: 66 + 30 + … well over 150 requirement sites.
    expect(requirementSites).toBeGreaterThan(150);
    expect(
      offenders,
      `literal 'admin' scope requirements:\n  ${offenders.join('\n  ')}\n` +
        `Only a legacy 'admin' key satisfies these — a dashboard session (account_owner) and a staff SSO session ` +
        `(driftstack_internal_admin) both get 403 — so the route is unreachable for every live credential. ` +
        `Require 'account_owner' or 'driftstack_internal_admin' (V-174).`,
    ).toEqual([]);
  });

  it('CRITICAL the integration app helper does not default keys to the legacy scope, which is what masked the literal', () => {
    const helper = readFileSync(TEST_APP_HELPER, 'utf8');
    const defaults = [...helper.matchAll(/scopes:\s*opts\.scopes\s*\?\?\s*\[([^\]]*)\]/g)].map(
      (m) => m[1] ?? '',
    );
    expect(
      defaults.length,
      'the helper no longer spells a scopes default this way — re-anchor',
    ).toBeGreaterThan(0);
    for (const d of defaults) {
      expect(
        d,
        `a default scope set carrying 'admin' would satisfy a literal requirement and hide it: [${d.trim()}]`,
      ).not.toMatch(/'admin'/);
    }
  });

  it('the matcher fires on every requirement shape and not on the granular scopes or the bare token', () => {
    const fires = (s: string): boolean => new RegExp(LITERAL_ADMIN_REQUIREMENT.source).test(s);
    expect(fires("app.requireScope('admin')")).toBe(true);
    expect(fires("throwIfMissingScope(ctx, 'admin')")).toBe(true);
    expect(fires("hasScope(request.account, 'admin')")).toBe(true);
    expect(fires("scopesSatisfy(scopes, 'admin')")).toBe(true);
    expect(fires("requireScope( 'admin' )")).toBe(true);
    expect(fires("requireScope('admin:billing')")).toBe(false);
    expect(fires("requireScope('driftstack_internal_admin')")).toBe(false);
    expect(fires("role: z.enum(['member', 'admin'])")).toBe(false);
    expect(fires("tags: ['admin']")).toBe(false);
    expect(fires("scopes.includes('admin')")).toBe(false);
  });
});
