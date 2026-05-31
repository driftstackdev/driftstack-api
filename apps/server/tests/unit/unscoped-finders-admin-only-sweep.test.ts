// Security drift-guard — the `*Unscoped` by-id finders must stay
// admin-only. Customer-facing by-id lookups are account-scoped at the repo
// layer (`findSession(id, accountId)`, `findApiKey(id, accountId)`, ...) so
// a non-owned id returns null -> 404 (no IDOR). The two deliberate escape
// hatches, `findSessionUnscoped(id)` + `findApiKeyUnscoped(id)`, skip that
// scoping and are meant to be reachable ONLY from the staff cross-account
// force-action route (`routes/admin-force-actions.ts`), which is
// double-gated by `driftstack_internal_admin`.
//
// This sweep pins that invariant: if a future change calls an `*Unscoped`
// finder from any other route/service, a non-owned id could be acted on
// without the account check — a customer-reachable IDOR. The guard fails
// the moment such a call appears anywhere in apps/server/src except the
// admin route.
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

describe('security: *Unscoped finders are admin-only (IDOR drift-guard)', () => {
  it('CRITICAL only admin-force-actions.ts calls findSessionUnscoped / findApiKeyUnscoped — any other caller is a customer-reachable IDOR (the unscoped finder skips the account check)', () => {
    const files = listFiles(resolve(REPO_ROOT, 'apps/server/src'), ['.ts']);
    const callers = new Set<string>();
    for (const f of files) {
      const body = read(f);
      if (CALL_PATTERNS.some((re) => re.test(body))) {
        callers.add(relative(REPO_ROOT, f).split('\\').join('/'));
      }
    }
    expect([...callers].sort()).toEqual([ALLOWED_CALLER]);
  });

  it('non-vacuous: admin-force-actions.ts still calls BOTH unscoped finders (so this guard tracks real usage, not a dead invariant)', () => {
    const adminBody = read(resolve(REPO_ROOT, ALLOWED_CALLER));
    expect(/\.findSessionUnscoped\(/.test(adminBody)).toBe(true);
    expect(/\.findApiKeyUnscoped\(/.test(adminBody)).toBe(true);
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
