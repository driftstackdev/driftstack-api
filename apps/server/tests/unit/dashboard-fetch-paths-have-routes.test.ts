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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DASH_SRC = resolve(REPO_ROOT, 'apps/customer-dashboard/src');
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

  // Distinct /v1/ paths the dashboard references, trailing slash stripped (the
  // dashboard builds `/v1/api-keys/` + id; the base path is what must exist).
  // Require a quote/backtick immediately before `/v1/` so we only capture
  // actual API-call path literals — NOT `/v1/` substrings inside an external
  // URL (e.g. api.qrserver.com/v1/create-qr-code) or a prose comment mentioning
  // a planned endpoint. Strip the leading quote + trailing slash.
  const dashPaths = new Set<string>();
  for (const f of walk(DASH_SRC, /\.(astro|ts|tsx|js)$/)) {
    const body = readFileSync(f, 'utf8');
    for (const m of body.matchAll(/['"`]\/v1\/[a-zA-Z0-9/_-]+/g)) {
      dashPaths.add(m[0].slice(1).replace(/\/+$/, ''));
    }
  }

  it('finds dashboard fetch paths to check', () => {
    expect(dashPaths.size).toBeGreaterThan(20);
  });

  it('every dashboard /v1/ fetch path exists in the server route source', () => {
    const missing = [...dashPaths].filter((p) => !routeSrc.includes(p)).sort();
    expect(
      missing,
      `dashboard fetches these paths but they have no server route (404 — broken action):\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
