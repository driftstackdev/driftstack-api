// Scope-disclosure invariant (A2, 2026-07-31).
//
// A customer minting a least-privilege key reads the OpenAPI spec to learn what
// authority an operation needs. If the spec is SILENT, they cannot know; if it
// is WRONG, they mint the wrong key and get a 403 they cannot explain. A3
// called exactly that a release blocker for the organization resource
// ("shipping the current diff would make the public spec contradict the route
// and tell least-privilege clients to mint the wrong authority") — silence
// across the rest of the surface is the same defect one step weaker.
//
// So: every customer-facing route that ENFORCES a scope must DISCLOSE it in its
// OpenAPI operation, and the disclosure must name the scope the route actually
// enforces — derived from `app.requireScope('…')` in the route source, never
// from the doc text.
//
// `/v1/admin/*` is excluded: it is staff-only, not published for customer
// key-minting, and most of it has no OpenAPI operation at all.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const OPENAPI = resolve(REPO_ROOT, 'apps/server/src/lib/openapi.ts');

type RouteKey = string; // `${method} ${path}`

/**
 * Scopes each route enforces, read from the route source. This is the source of
 * truth — the doc text is what we are checking AGAINST it.
 */
/**
 * Every `.ts` under `apps/server/src`, not just `src/routes`.
 *
 * Registration is not confined to that directory — `/v1/whoami` lives in
 * `lib/app.ts` — and a scan limited to `routes/` silently exempts anything
 * registered elsewhere. That is a FALSE NEGATIVE in a disclosure guard: the
 * route would enforce a gate nobody checked. No such route exists today (the
 * one outside `routes/` carries no scope and the `global` bucket), so this
 * closes a latent hole rather than a live one.
 */
function serverSourceFiles(): string[] {
  const out: string[] = [];
  const stack = [resolve(REPO_ROOT, 'apps/server/src')];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (entry.endsWith('.ts')) out.push(full);
    }
  }
  return out;
}

function enforcedScopes(): Map<RouteKey, string[]> {
  const out = new Map<RouteKey, string[]>();
  for (const file of serverSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const regs = [
      ...src.matchAll(/\bapp\.(get|post|put|patch|delete)\b[^(]*\(\s*['"`](\/v1\/[^'"`]+)['"`]/g),
    ];
    regs.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < regs.length ? regs[i + 1]!.index : Math.min(src.length, start + 2500);
      const window = src.slice(start, end);
      const scopes = [
        ...new Set([...window.matchAll(/requireScope\(\s*'([^']+)'/g)].map((s) => s[1]!)),
      ];
      if (scopes.length > 0) out.set(`${m[1]!} ${m[2]!}`, scopes.sort());
    });
  }
  return out;
}

/** Operation blocks keyed the same way, from the single registerRoute source. */
function documentedOperations(): Map<RouteKey, string> {
  const oa = readFileSync(OPENAPI, 'utf8');
  const out = new Map<RouteKey, string>();
  for (const m of oa.matchAll(/registerRoute\(\s*r,\s*\{([\s\S]*?)\n {2}\}\);/g)) {
    const block = m[1]!;
    const method = /method:\s*'(\w+)'/.exec(block);
    const path = /path:\s*'([^']+)'/.exec(block);
    if (method && path) out.set(`${method[1]!} ${path[1]!}`, block);
  }
  return out;
}

describe('OpenAPI discloses the scope every customer-facing route enforces', () => {
  const enforced = enforcedScopes();
  const documented = documentedOperations();

  it('both sides parsed (a broken parse would make the invariant vacuous)', () => {
    expect(enforced.size).toBeGreaterThan(100);
    expect(documented.size).toBeGreaterThan(150);
  });

  it('CRITICAL every customer-facing route that enforces a scope names that exact scope in its OpenAPI operation. Silence leaves a least-privilege customer guessing; a wrong name makes them mint the wrong key. The expected scope is read from `app.requireScope(...)` in the route source, so the docs can never define their own truth.', () => {
    const undisclosed: string[] = [];

    for (const [key, scopes] of [...enforced].sort()) {
      const [, path] = key.split(' ');
      if (path!.startsWith('/v1/admin')) continue;
      const block = documented.get(key);
      if (block === undefined) continue; // no published operation — nothing to disclose
      const discloses = scopes.some((scope) => new RegExp(`\`${scope}\``).test(block));
      if (!discloses) undisclosed.push(`${key}  enforces ${scopes.join(' + ')}`);
    }

    expect(
      undisclosed,
      'Route(s) enforce a scope their OpenAPI operation never states — add "(requires `<scope>`…)" to the summary:',
    ).toEqual([]);
  });

  it('CRITICAL a disclosure must not contradict enforcement: an operation may not name a DIFFERENT granular scope than the one its route enforces. This is the failure mode that sends a customer to mint the wrong authority.', () => {
    const granular = /`(read|write|admin):(sessions|profiles|webhooks|api-keys|billing|audit)`/g;
    const contradictions: string[] = [];

    for (const [key, scopes] of [...enforced].sort()) {
      const [, path] = key.split(' ');
      if (path!.startsWith('/v1/admin')) continue;
      const block = documented.get(key);
      if (block === undefined) continue;
      const summary = /summary: ('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/.exec(block)?.[1] ?? '';
      const named = [...summary.matchAll(granular)].map((m) => m[0].replaceAll('`', ''));
      const wrong = named.filter((n) => !scopes.includes(n));
      if (wrong.length > 0) {
        contradictions.push(
          `${key}  enforces ${scopes.join(' + ')} but summary names ${wrong.join(', ')}`,
        );
      }
    }

    expect(
      contradictions,
      'Operation summary names a granular scope its route does not enforce:',
    ).toEqual([]);
  });
});
