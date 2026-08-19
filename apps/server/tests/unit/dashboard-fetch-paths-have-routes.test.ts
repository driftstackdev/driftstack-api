// W481 — guard: every /v1/ API path the customer-dashboard fetches must exist
// as a server route.
//
// A dashboard action that POSTs to a renamed/removed endpoint 404s silently —
// the same frontend↔backend-wiring class as the W472 team-accept bug (a
// referenced endpoint with no implementation), but for fetch() actions rather
// than page links. Nothing else cross-checks the dashboard's client fetch paths
// against the route table. This pins them: extract every distinct `/v1/...`
// path the dashboard references and assert each appears in the route source.
//
// Robust by design: routes are registered with multi-line `app.post(\n
// '/path', ...)` calls + prefixes, so an `app.METHOD(...)` regex false-negatives
// (learned W476/W481). We assert plain substring presence in the concatenated
// route source — a path that exists nowhere in routes/ has zero occurrences.
//
// V-989 — that reasoning was sound and its conclusion is now obsolete. The
// false-negative it avoids comes from a regex that stops at `app.post(`; one
// that allows an optional type argument and whitespace before the quoted path
// reads all 209 registrations, the multi-line and `app.post<{ Params: … }>(`
// forms included. So the anchor is available, and substring presence costs more
// than it saves: a path named in a COMMENT, in an error message, or in a policy
// roster inside routes/ satisfies `.includes()` while no route serves it — the
// same defect V-987/V-988 found in all three SDK path guards.
//
// The check keeps PREFIX semantics, which is the part that genuinely needs care:
// the apps build `/v1/api-keys/` + id, so the referenced base must match a
// registration or be a parent of one, not equal it. Measured before the change —
// 51 customer-dashboard paths and 20 admin-panel paths, every one resolving
// under both the old rule and the new one, so this is a latent hole closed at
// zero cost rather than a live break repaired.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DASH_SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');
const ADMIN_SRC = resolve(REPO_ROOT, 'apps/admin-panel/src');
const ROUTES_DIR = resolve(REPO_ROOT, 'apps/server/src/routes');

function walk(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, re));
    else if (re.test(name)) out.push(p);
  }
  return out;
}

describe('W481 dashboard fetch paths resolve to server routes (frontend↔backend wiring)', () => {
  // Concatenated route source — the authoritative registration surface.
  const routeSrc = walk(ROUTES_DIR, /\.ts$/)
    .filter((f) => !/\.test\.ts$/.test(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  /** Paths the server REGISTERS, param names erased so `:id` and `:keyId` compare equal. */
  const registered = new Set(
    [
      ...routeSrc.matchAll(
        /app\.(?:get|post|put|patch|delete)\s*(?:<[^(]*>)?\s*\(\s*['"`](\/v1\/[^'"`]*)['"`]/g,
      ),
    ].map((m) => (m[1] ?? '').replace(/:[A-Za-z_]+/g, ':p').replace(/\/+$/, '')),
  );

  /**
   * A referenced base path is served when it IS a registration or is a parent of
   * one — `/v1/api-keys` is served by `/v1/api-keys/:p/rotate`, because the app
   * appends the id itself.
   */
  function servedBy(p: string): boolean {
    const n = p.replace(/:[A-Za-z_]+/g, ':p').replace(/\/+$/, '');
    for (const r of registered) {
      if (r === n || r.startsWith(`${n}/`)) return true;
    }
    return false;
  }

  // Distinct /v1/ paths an app references, trailing slash stripped (apps build
  // `/v1/api-keys/` + id; the base path is what must exist). Require a quote/
  // backtick immediately before `/v1/` so we only capture actual API-call path
  // literals — NOT `/v1/` substrings inside an external URL (e.g.
  // api.qrserver.com/v1/create-qr-code) or a prose comment mentioning a planned
  // endpoint.
  function fetchPaths(srcDir: string): Set<string> {
    const paths = new Set<string>();
    for (const f of walk(srcDir, /\.(astro|ts|tsx|js)$/)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`]\/v1\/[a-zA-Z0-9/_-]+/g)) {
        paths.add(m[0].slice(1).replace(/\/+$/, ''));
      }
    }
    return paths;
  }

  // W481 customer-dashboard + W482 admin-panel — both are client-fetch apps
  // whose actions 404 silently if an endpoint is renamed/removed.
  const APPS = [
    { name: 'customer-dashboard', src: DASH_SRC, min: 20 },
    { name: 'admin-panel', src: ADMIN_SRC, min: 5 },
  ];

  for (const { name, src, min } of APPS) {
    const paths = fetchPaths(src);
    it(`${name}: finds fetch paths to check (>=${min})`, () => {
      expect(paths.size).toBeGreaterThanOrEqual(min);
    });
    it(`${name}: every /v1/ fetch path is served by a registered route`, () => {
      const missing = [...paths].filter((p) => !servedBy(p)).sort();
      expect(
        missing,
        `${name} fetches these paths but they have no server route (404 — broken action):\n${missing.join('\n')}`,
      ).toEqual([]);
    });
  }
});
