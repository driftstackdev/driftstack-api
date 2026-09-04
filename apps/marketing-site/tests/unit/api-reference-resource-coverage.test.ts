// W310.B — drift guard for /api-reference resource coverage. The
// page is the canonical "what does the API expose" overview on the
// marketing site. Asserts each top-level resource group is present
// and that every cited /v1/... endpoint is registered on the server.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/api-reference.astro');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');
const ARCHETYPES_DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/archetypes.md');

const REQUIRED_GROUPS = [
  'Sessions',
  'Archetypes',
  'Agent sessions',
  'Recipes',
  'Profiles',
  'API keys',
  'Webhooks',
  'Account',
  'Team',
  'Auth flows',
  'Status',
  'Billing',
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) throw new Error(`missing ${dir}`);
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Normalise any `:<paramName>` placeholder to `:id` so the page's
// readability-driven `:id` matches the route file's semantic param
// names (`:order_id`, `:deliveryId`, etc.).
function canonical(p: string): string {
  return p.replace(/:[a-zA-Z_][a-zA-Z_0-9]*/g, ':id').replace(/\/$/, '');
}

const liveRoutes = new Set<string>();
for (const f of walk(ROUTES).filter((p) => /\.ts$/.test(p))) {
  const body = read(f);
  for (const m of body.matchAll(/['"`](\/v1\/[a-zA-Z0-9/:_.-]+)['"`]/g)) {
    liveRoutes.add(canonical(m[1]!));
  }
}

function normalisePath(raw: string): string {
  return canonical(raw);
}

describe('W310.B /api-reference ↔ live route parity', () => {
  const body = read(PAGE);

  it('covers all required resource groups', () => {
    const missing = REQUIRED_GROUPS.filter((g) => !body.includes(g));
    expect(missing).toEqual([]);
  });

  it('every cited /v1/... endpoint resolves to a live registration', () => {
    const cited = [...body.matchAll(/<li>\s*[A-Z]+\s+(\/v1\/[a-z0-9/:_.-]+)/g)]
      .map((m) => normalisePath(m[1]!))
      // The reference page sometimes lists *.txt/*.pdf variants — strip
      // those to canonical path form (the route registers a single :id
      // path that handles both via content-type negotiation).
      .filter((p) => !/\.(txt|pdf)$/.test(p));

    expect(cited.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const p of cited) {
      if (!liveRoutes.has(p) && !liveRoutes.has(p + '/')) {
        offenders.push(p);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('covers the shipped discovery and saved-recipe management surface without inventing execution routes', () => {
    for (const endpoint of [
      'GET /v1/archetypes',
      'GET /v1/agent-sessions',
      'GET /v1/agent-sessions/:id/recipe-suggestion',
      'POST /v1/recipes',
      'GET /v1/recipes',
      'GET /v1/recipes/:id',
      'DELETE /v1/recipes/:id',
    ]) {
      expect(body).toContain(`<li>${endpoint}</li>`);
    }
    expect(body).not.toMatch(/\/v1\/recipes\/:id\/(?:execute|replay)/);
  });

  it('links the canonical archetype catalog and create-payload generator reference', () => {
    expect(existsSync(ARCHETYPES_DOC)).toBe(true);
    expect(body).toContain('https://docs.driftstack.io/api/archetypes/');
    const reference = read(ARCHETYPES_DOC);
    expect(reference).toContain('## Generate a create payload from the live catalog');
    expect(reference).toContain('async function archetypeCreatePayload');
  });
});
