// The three SDKs expose the SAME resource methods.
//
// Forty cross-sdk parity guards exist and every one is hand-scoped to a
// feature — account-me, api-keys lifecycle, auth flow, enum rosters. None pins
// the SURFACE itself, so a method added to one SDK and forgotten in the other
// two, or renamed in one, passes everything.
//
// That is not hypothetical: `usage.currentPeriod` was found by hand after
// Python named it `current_period` and Go `CurrentPeriod` while TypeScript had
// only `current`, so a customer porting between SDKs hit a silent rename on the
// same endpoint. This is the guard that would have caught it.
//
// Naming is normalised to lowercase letters, because each language uses its own
// idiom for the same method: `currentPeriod` / `current_period` /
// `CurrentPeriod` are one method, not three.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** `currentPeriod` / `current_period` / `CurrentPeriod` → `currentperiod`. */
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Methods that exist in ONE SDK on purpose, with the reason.
 *
 * Every entry must be a language-idiom convenience whose canonical name is
 * present in all three — never a capability one SDK has and the others lack.
 *
 * V-955 — that rule used to be prose plus a hard-coded check of ONE entry.
 * `usage.current` had `expect(ts.usage).toContain('currentperiod')` and the same
 * for Python and Go; `cryptoorders.listall` claimed to be sugar over a shared
 * `iterate` and nothing asserted `iterate` existed anywhere. Both claims happen to
 * be true today — this is a latent hole, not a live one — but an entry excusing a
 * genuine capability gap would have read exactly like these two.
 *
 * So the canonical name is now DATA rather than prose, and the arm below requires
 * it in all three SDKs for every entry. A new exemption cannot be added without
 * naming the method that makes it a convenience rather than a gap.
 */
interface IntentionalExtra {
  /** The method all three SDKs must expose, of which this entry is sugar. */
  readonly canonical: string;
  readonly reason: string;
}

const INTENTIONAL_EXTRAS: Record<string, Record<string, IntentionalExtra>> = {
  usage: {
    current: {
      canonical: 'currentPeriod',
      reason:
        'TypeScript-only shorthand; delegates to currentPeriod, which all three expose. Kept for back-compat.',
    },
  },
  cryptoorders: {
    listall: {
      canonical: 'iterate',
      reason:
        'TypeScript-only async-generator sugar over the shared `iterate` paginator, which all three expose.',
    },
  },
};

function tsSurface(): Record<string, Set<string>> {
  const dir = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources');
  const out: Record<string, Set<string>> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.startsWith('_')) continue;
    const src = readFileSync(resolve(dir, file), 'utf8');
    const methods = new Set(
      [...src.matchAll(/^ {2}(?:async )?([a-zA-Z][A-Za-z0-9_]*)\s*[(<]/gm)]
        .map((m) => norm(m[1]!))
        .filter((m) => m !== 'constructor'),
    );
    if (methods.size > 0) out[norm(file.replace(/\.ts$/, ''))] = methods;
  }
  return out;
}

function pySurface(): Record<string, Set<string>> {
  const dir = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources');
  const out: Record<string, Set<string>> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.py') || file.startsWith('_')) continue;
    const src = readFileSync(resolve(dir, file), 'utf8');
    const methods = new Set(
      [...src.matchAll(/^ {4}(?:async )?def ([a-z][a-z0-9_]*)\s*\(/gm)]
        .map((m) => m[1]!)
        .filter((m) => !m.startsWith('_'))
        .map(norm),
    );
    if (methods.size > 0) out[norm(file.replace(/\.py$/, ''))] = methods;
  }
  return out;
}

function goSurface(): Record<string, Set<string>> {
  const dir = resolve(REPO_ROOT, 'packages/sdk-go');
  const out: Record<string, Set<string>> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
    const src = readFileSync(resolve(dir, file), 'utf8');
    for (const m of src.matchAll(/func \(\w+ \*?(\w*(?:Resource|Service))\) ([A-Z]\w*)\(/g)) {
      const key = norm(m[1]!.replace(/(Resource|Service)$/, ''));
      (out[key] ??= new Set()).add(norm(m[2]!));
    }
  }
  return out;
}

describe('the three SDKs expose the same resource surface', () => {
  const ts = tsSurface();
  const py = pySurface();
  const go = goSurface();

  it('CRITICAL every extractor found a real surface. A regex that silently matches nothing would make every comparison below trivially true — the exact vacuous pass these guards exist to prevent.', () => {
    expect(Object.keys(ts).length, 'TypeScript surface').toBeGreaterThan(10);
    expect(Object.keys(py).length, 'Python surface').toBeGreaterThan(10);
    expect(Object.keys(go).length, 'Go surface').toBeGreaterThan(10);
    // A known method in each, so a regex that matches declarations but drops
    // names cannot pass either.
    expect(ts.usage).toContain('currentperiod');
    expect(py.usage).toContain('currentperiod');
    expect(go.usage).toContain('currentperiod');
  });

  it('CRITICAL the three SDKs cover the same RESOURCES. A resource added to one and forgotten in the others is a customer discovering the feature does not exist in their language.', () => {
    const names = (o: Record<string, Set<string>>): string[] => Object.keys(o).sort();
    expect(names(py), 'Python vs TypeScript resources').toEqual(names(ts));
    expect(names(go), 'Go vs TypeScript resources').toEqual(names(ts));
  });

  it('CRITICAL the three SDKs expose the same METHODS per resource, modulo language idiom. A rename in one SDK is a silent porting break — exactly how usage.currentPeriod diverged.', () => {
    const divergences: string[] = [];
    for (const resource of Object.keys(ts).sort()) {
      const allowed = new Set(Object.keys(INTENTIONAL_EXTRAS[resource] ?? {}));
      const t = new Set([...(ts[resource] ?? [])].filter((m) => !allowed.has(m)));
      const p = new Set([...(py[resource] ?? [])].filter((m) => !allowed.has(m)));
      const g = new Set([...(go[resource] ?? [])].filter((m) => !allowed.has(m)));
      for (const [label, other] of [
        ['python', p],
        ['go', g],
      ] as const) {
        const missing = [...t].filter((m) => !other.has(m));
        const extra = [...other].filter((m) => !t.has(m));
        if (missing.length > 0)
          divergences.push(`${resource}: missing from ${label}: ${missing.sort().join(', ')}`);
        if (extra.length > 0)
          divergences.push(`${resource}: only in ${label}: ${extra.sort().join(', ')}`);
      }
    }
    expect(divergences.sort(), 'SDK method surfaces have diverged:').toEqual([]);
  });

  it('every intentional single-SDK extra names a method that still exists, so the allowlist cannot outlive what it excuses', () => {
    const stale: string[] = [];
    for (const [resource, extras] of Object.entries(INTENTIONAL_EXTRAS)) {
      for (const method of Object.keys(extras)) {
        if (!(ts[resource]?.has(method) ?? false)) stale.push(`${resource}.${method}`);
      }
    }
    expect(stale, 'allowlisted extra(s) that no longer exist:').toEqual([]);
  });

  it('CRITICAL every intentional extra is sugar over a method ALL THREE SDKs expose. That is the entire difference between a language idiom and a capability one SDK has and the others lack — and it was prose plus a hard-coded check of one of the two entries, so an exemption hiding a real gap would have read exactly like the ones already here.', () => {
    const unbacked: string[] = [];
    for (const [resource, extras] of Object.entries(INTENTIONAL_EXTRAS)) {
      for (const [method, extra] of Object.entries(extras)) {
        const canonical = norm(extra.canonical);
        const absent = (
          [
            ['TypeScript', ts],
            ['Python', py],
            ['Go', go],
          ] as const
        )
          .filter(([, surface]) => !(surface[resource]?.has(canonical) ?? false))
          .map(([label]) => label);
        if (absent.length > 0) {
          unbacked.push(
            `${resource}.${method} claims to be sugar over ${extra.canonical}, which ${absent.join(' and ')} ${absent.length === 1 ? 'does' : 'do'} not expose`,
          );
        }
      }
    }
    expect(
      unbacked,
      'these exemptions excuse a single-SDK method whose canonical form is NOT available everywhere, ' +
        'so they are covering a capability gap rather than a naming idiom:',
    ).toEqual([]);
  });
});
