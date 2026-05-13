// W539.B — drift guard for /.prettierignore (workspace root).
// Pins Prettier's skip-set so the workspace `prettier --write .` script
// never touches generated artefacts. Drift here either reformats the
// Drizzle SQL migrations (would diff against drizzle-kit's exact
// generated output, breaking next-migration generation), reformats
// .astro/ generated route files (would cause every astro-build to
// produce a noisy diff), or accidentally reformats package-lock.json
// (would corrupt npm's deterministic ordering).
//
//   • Build artefact skips: node_modules + dist + build + coverage +
//     *.tsbuildinfo + package-lock.json + LICENSE.
//   • Drizzle generated artefacts: apps/server/src/db/migrations/.
//   • 5-Astro-app generated skips (matches the 5-Astro-app monorepo
//     inventory): marketing-site + customer-dashboard + admin-panel +
//     docs + status-site, each .astro/ + dist/ ignored.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.prettierignore');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W539.B /.prettierignore content parity', () => {
  const body = read(LIB);

  it("Build-artefact + lockfile + LICENSE skip framing pinned: 'node_modules/' + 'dist/' + 'build/' + 'coverage/' + '*.tsbuildinfo' + 'package-lock.json' + 'LICENSE' — pinned so the standard-Node-build-artefact + npm-deterministic-lockfile + MIT-LICENSE-original-formatting skip commitment survives (drift to formatting package-lock.json would re-order keys and corrupt npm's resolution; drift to formatting LICENSE would mutate the canonical MIT text)", () => {
    expect(body).toMatch(/^node_modules\/$/m);
    expect(body).toMatch(/^dist\/$/m);
    expect(body).toMatch(/^build\/$/m);
    expect(body).toMatch(/^coverage\/$/m);
    expect(body).toMatch(/^\*\.tsbuildinfo$/m);
    expect(body).toMatch(/^package-lock\.json$/m);
    expect(body).toMatch(/^LICENSE$/m);
  });

  it("Drizzle-generated-SQL skip framing pinned: '# Drizzle generated artifacts' + 'apps/server/src/db/migrations/' — pinned so the drizzle-kit-generated-SQL-not-reformatted commitment survives (drift to formatting the migration SQL would diff against drizzle-kit's exact generated output, breaking the next migration-generation cycle's diff detection)", () => {
    expect(body).toMatch(/# Drizzle generated artifacts/);
    expect(body).toMatch(/^apps\/server\/src\/db\/migrations\/$/m);
  });

  it("5-Astro-app generated skip framing pinned: '# Astro generated artifacts' + 'apps/marketing-site/.astro/' + 'apps/marketing-site/dist/' + 'apps/customer-dashboard/.astro/' + 'apps/customer-dashboard/dist/' + 'apps/admin-panel/.astro/' + 'apps/admin-panel/dist/' + 'apps/docs/.astro/' + 'apps/docs/dist/' + 'apps/status-site/.astro/' + 'apps/status-site/dist/' (exact 5-Astro-app inventory) — pinned so the every-Astro-app-.astro+dist-skipped commitment survives (drift to dropping any one app would mean astro-build output gets reformatted, producing a noisy diff on every build; drift to adding a 6th app's path implies a new Astro app exists that the monorepo inventory parity tests haven't caught)", () => {
    expect(body).toMatch(/# Astro generated artifacts/);
    expect(body).toMatch(/^apps\/marketing-site\/\.astro\/$/m);
    expect(body).toMatch(/^apps\/marketing-site\/dist\/$/m);
    expect(body).toMatch(/^apps\/customer-dashboard\/\.astro\/$/m);
    expect(body).toMatch(/^apps\/customer-dashboard\/dist\/$/m);
    expect(body).toMatch(/^apps\/admin-panel\/\.astro\/$/m);
    expect(body).toMatch(/^apps\/admin-panel\/dist\/$/m);
    expect(body).toMatch(/^apps\/docs\/\.astro\/$/m);
    expect(body).toMatch(/^apps\/docs\/dist\/$/m);
    expect(body).toMatch(/^apps\/status-site\/\.astro\/$/m);
    expect(body).toMatch(/^apps\/status-site\/dist\/$/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
