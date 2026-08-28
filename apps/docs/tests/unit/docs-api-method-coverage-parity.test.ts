// W284.C — drift guard for apps/docs API page coverage. Each
// docs/api/<resource>.md must enumerate every HTTP method exposed
// by the live route file. Catches the regression class where a new
// route is added on the server but the docs page never gets the
// matching section.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Each entry: doc page + the routes file that defines the surface.
// We assert each HTTP verb registered in the routes file appears
// somewhere in the doc page (e.g. as a `### POST` heading or the
// inline `POST /v1/...` shorthand).
const PAIRS: { docPage: string; route: string }[] = [
  { docPage: 'apps/docs/src/pages/api/sessions.md', route: 'apps/server/src/routes/sessions.ts' },
  { docPage: 'apps/docs/src/pages/api/profiles.md', route: 'apps/server/src/routes/profiles.ts' },
  {
    docPage: 'apps/docs/src/pages/api/profile-snapshots.md',
    route: 'apps/server/src/routes/profile-snapshots.ts',
  },
  { docPage: 'apps/docs/src/pages/api/team.md', route: 'apps/server/src/routes/team.ts' },
];

const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('W284.C apps/docs API page method-coverage parity', () => {
  for (const { docPage, route } of PAIRS) {
    it(`${docPage}: every verb registered on ${route} appears in the doc`, () => {
      const docPath = resolve(REPO_ROOT, docPage);
      const routePath = resolve(REPO_ROOT, route);
      for (const [what, p] of [
        ['doc page', docPath],
        ['routes file', routePath],
      ] as const) {
        if (!existsSync(p)) {
          throw new Error(
            `${what} ${p} is missing: a retired pair must be removed from PAIRS, not skipped — skipping is exactly how a docs sweep goes quiet when a routes file is retired, as routes/saved-proxies.ts was`,
          );
        }
      }

      const doc = read(docPath).toLowerCase();
      const routeSrc = read(routePath);

      const usedVerbs = new Set<string>();
      for (const v of VERBS) {
        // Fastify route registrations: app.get(... | app.post(... | route({ method: 'POST' }).
        const re1 = new RegExp(`\\bapp\\.${v}\\s*\\(`);
        const re2 = new RegExp(`method:\\s*['"]${v}['"]`, 'i');
        if (re1.test(routeSrc) || re2.test(routeSrc)) {
          usedVerbs.add(v);
        }
      }

      const missing: string[] = [];
      for (const v of usedVerbs) {
        const upper = v.toUpperCase();
        // doc may mention the verb as a heading or shorthand.
        if (!new RegExp(`\\b${v}\\b`).test(doc)) {
          missing.push(upper);
        }
      }
      expect(missing).toEqual([]);
    });
  }
});
