// W301.B — drift guard for /docs/api-quickstart curl examples.
// Every /v1/... endpoint cited in a curl example must correspond
// to a live route registration on the server. Catches drift where
// the quickstart demonstrates a renamed or unimplemented endpoint.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-quickstart.astro');
const ROUTES = resolve(REPO_ROOT, 'apps/server/src/routes');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Collect every literal `/v1/<path>` registered in any routes file.
const routeFiles = walk(ROUTES).filter((f) => /\.ts$/.test(f));
const liveRoutes = new Set<string>();
for (const f of routeFiles) {
  const body = read(f);
  for (const m of body.matchAll(/['"`](\/v1\/[a-z0-9/_:-]+)['"`]/g)) {
    liveRoutes.add(m[1]!);
  }
  // Capture inline app.<verb>('/v1/...') calls too.
  for (const m of body.matchAll(/app\.\w+\(['"`](\/v1\/[a-z0-9/_:-]+)['"`]/g)) {
    liveRoutes.add(m[1]!);
  }
}

function normaliseCitedPath(raw: string): string {
  // Map cited literal IDs in URLs to the route's `:param` shape.
  // e.g. `/v1/sessions/ses_.../navigate` → `/v1/sessions/:id/navigate`
  return (
    raw
      .replace(/\/(ses|prof|psnap|whk|wdl|ord|acc|key|inv|mem)_[^/]+/g, '/:id')
      // Also handle bare `<id>` placeholders.
      .replace(/\/<[^/>]+>/g, '/:id')
      .replace(/\/:id\/:id/g, '/:id')
  ); // dedupe duplicate :id from cascading replaces
}

describe('W301.B /docs/api-quickstart ↔ live route parity', () => {
  const body = read(PAGE);

  it('every /v1/... endpoint in a curl example resolves to a live route registration', () => {
    const cited = [...body.matchAll(/api\.driftstack\.dev(\/v1\/[a-z0-9/_…-]+)/g)].map((m) =>
      m[1]!.replace(/…/g, '_uuid'),
    );

    const offenders: { cited: string; normalised: string }[] = [];
    for (const c of cited) {
      const norm = normaliseCitedPath(c);
      // Strip a leading slash + handle both the normalised and the
      // raw forms — accept either.
      const candidates = [norm, c, c.replace(/\/_uuid/g, '/:id')];
      if (!candidates.some((p) => liveRoutes.has(p))) {
        offenders.push({ cited: c, normalised: norm });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('quickstart shows the `ses_` id prefix (canonical session id format)', () => {
    expect(body).toMatch(/ses_[^/<\s]+/);
  });
});
