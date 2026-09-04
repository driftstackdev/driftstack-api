// W291.A — drift guard for sub-processors.md cross-links into the
// docs/ directory. Each `/docs/<slug>` reference must resolve to a
// real .astro file under apps/marketing-site/src/pages/docs/.
// Catches drift where a docs page is renamed but a legal cross-
// reference survives.
//
// S47 2026-07-07 (founder-approved: mirror deprecation): a /docs/*
// link ALSO resolves if it has a 301 rule in public/_redirects (the
// superseded mirror pages now redirect to docs.driftstack.io, so
// such links are live, not dead). sub-processors.md itself is in the
// concurrent S43 session's lane — updating its /docs/data-residency
// link text to the docs successor is deferred to that session via
// the orchestrator; when it lands, the redirect fallback here simply
// stops being exercised.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SUB_PROCESSORS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/legal/sub-processors.md');
const DOCS = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs');
const REDIRECTS = resolve(REPO_ROOT, 'apps/marketing-site/public/_redirects');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// S47: routes with a 301 rule in public/_redirects resolve too.
function redirectedRoutes(): Set<string> {
  return new Set(
    read(REDIRECTS)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/))
      .filter((t) => t[2] === '301')
      .map((t) => t[0]!),
  );
}

describe('W291.A sub-processors.md → /docs/* cross-link integrity', () => {
  it('every /docs/<slug> link in sub-processors resolves to a real page or an S47 301 redirect', () => {
    const body = read(SUB_PROCESSORS);
    const redirected = redirectedRoutes();
    const offenders: string[] = [];
    const matches = [...body.matchAll(/\[[^\]]+\]\((\/docs\/[a-z0-9-]+)\)/g)];
    for (const m of matches) {
      const slug = m[1]!.replace(/^\/docs\//, '');
      if (
        !existsSync(resolve(DOCS, slug + '.astro')) &&
        !existsSync(resolve(DOCS, slug, 'index.astro')) &&
        !redirected.has(m[1]!)
      ) {
        offenders.push(m[1]!);
      }
    }
    expect(offenders).toEqual([]);
  });
});
