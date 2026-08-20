// V-1200 — no authorization gate rests on the legacy `'admin'` scope.
//
// THE INCIDENT. The V-174 split replaced the single `admin` scope with `account_owner`
// (customer) and `driftstack_internal_admin` (staff). The alias runs ONE WAY: a key that
// literally carries `admin` satisfies a requirement for either new scope. The reverse is false.
// Post-V-174 sessions carry `['read','write','account_owner']`, plus
// `driftstack_internal_admin` for staff — and no legacy `admin`.
//
// So a gate written as `requireScope('admin')` or `throwIfMissingScope(ctx, 'admin')` is
// satisfied ONLY by an old API key minted before the split. Every real session 403s. On
// 2026-05-26 this was live in roughly eight places at once — customer webhook create / update /
// rotate / delete / sendTest, the staff DLQ operations, and rate-limit-override set / clear —
// where staff sessions passed the route's `driftstack_internal_admin` gate and were then
// rejected by the service beneath it.
//
// WHY IT NEEDED A SWEEP RATHER THAN MORE PER-SERVICE ARMS. The repo already pins the scope for
// individual services — `admin-accounts-service.test.ts` asserts every public method requires
// `driftstack_internal_admin`, and several cross-source invariants pin their own routes. What
// none of them can do is notice the gate in a service written next month. The failure is a
// CLASS, it recurred across eight sites in one incident, and it fails CLOSED and silently: the
// route admits the caller, the service refuses, and the customer sees a 403 with no defect
// anywhere in the logs.
//
// WHY THE TESTS DID NOT CATCH IT. `build-test-app.ts` defaults its fixture scopes to
// `['read','write','admin']`, which satisfies a literal `admin` requirement. Every admin test
// passed. The scope that no longer exists in production was the one the fixtures handed out.
//
// WHAT THIS DOES NOT MATCH, deliberately: `scopes.includes('admin')` inside the alias predicate
// in `services/auth.ts` (that IS the alias, and it must keep naming the legacy scope), the team
// role union `role: 'member' | 'admin'`, and the granular `verb === 'admin'` namespace. Only the
// two gate call shapes are offenders.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** The two shapes that actually gate a request on a scope string. */
const GATES = [
  { label: "requireScope('admin')", re: /requireScope\(\s*'admin'\s*\)/g },
  {
    label: "throwIfMissingScope(…, 'admin')",
    re: /throwIfMissingScope\(\s*[^,)]+,\s*'admin'\s*\)/g,
  },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function sourceRoots(): string[] {
  const roots = [resolve(REPO_ROOT, 'apps/server/src')];
  const pkgDir = resolve(REPO_ROOT, 'packages');
  try {
    for (const pkg of readdirSync(pkgDir)) {
      const src = resolve(pkgDir, pkg, 'src');
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        /* package without a src/ — nothing to scan */
      }
    }
  } catch {
    /* no packages/ — the server root above still gets scanned */
  }
  return roots;
}

describe('V-1200 no gate rests on the legacy admin scope', () => {
  const files = sourceRoots().flatMap((r) => walk(r));

  it('CRITICAL the sweep actually reached the source it claims to cover. A walk that silently returned nothing would report a clean repo forever, which is the failure mode this whole file exists to prevent in the code it scans.', () => {
    expect(files.length, 'the source walk found no TypeScript files at all').toBeGreaterThan(200);
    expect(
      files.some((f) => f.endsWith('/services/auth.ts')),
      'services/auth.ts was not scanned, so the walk is not covering the service layer',
    ).toBe(true);
  });

  it('CRITICAL the offender patterns still match the shape they are written for. A guard whose regex has quietly stopped matching reports every sweep clean, and this one is the only repo-wide check for a class that was live in eight places at once.', () => {
    const positives = [
      "  preHandler: [app.requireScope('admin')],",
      "  throwIfMissingScope(ctx, 'admin');",
    ];
    for (const [i, sample] of positives.entries()) {
      const gate = GATES[i];
      expect(gate, `no gate pattern at index ${i}`).toBeDefined();
      expect(
        new RegExp(gate?.re.source ?? '$^').test(sample),
        `the ${gate?.label} pattern no longer matches ${sample.trim()}`,
      ).toBe(true);
    }

    // And it must NOT claim the alias predicate, which legitimately names the legacy scope.
    for (const gate of GATES) {
      expect(
        new RegExp(gate.re.source).test(
          "if (required === 'account_owner' && scopes.includes('admin')) {",
        ),
        `the ${gate.label} pattern matches the V-174 alias predicate, which must keep naming 'admin'`,
      ).toBe(false);
    }
  });

  it('CRITICAL no source file gates on the legacy admin scope. Post-V-174 sessions carry account_owner / driftstack_internal_admin and never legacy admin, so such a gate 403s every real caller while passing the fixtures, which still hand out the retired scope.', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const gate of GATES) {
        for (const _m of src.matchAll(new RegExp(gate.re.source, 'g'))) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)} — ${gate.label}`);
        }
      }
    }

    expect(
      offenders,
      'these gate on the retired `admin` scope. The V-174 alias runs one way — a legacy `admin` ' +
        'key satisfies account_owner / driftstack_internal_admin, never the reverse — so real ' +
        'sessions are refused beneath a route that already admitted them. Pick the audience: ' +
        'customer self-account => account_owner, staff / cross-account => driftstack_internal_admin',
    ).toEqual([]);
  });
});
