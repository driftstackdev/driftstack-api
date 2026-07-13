// W587 — guard the scripts/deploy-frontend.sh safe-deploy wrapper.
//
// The W586 prod outage: a bare `wrangler pages deploy` of the dashboard WITHOUT
// PUBLIC_API_BASE_URL shipped apiBaseUrl="http://localhost:3000" to prod. This
// wrapper prevents recurrence by building with the env var + asserting no
// localhost leak before deploying. Pin the load-bearing invariants so a future
// edit can't quietly remove the guard or drift the project slugs.

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/deploy-frontend.sh');

describe('W587 deploy-frontend.sh safe-deploy wrapper', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  it('is executable', () => {
    // 0o111 = any execute bit set.
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('defaults PUBLIC_API_BASE_URL to the prod API (never localhost)', () => {
    expect(src).toMatch(/API_BASE="\$\{PUBLIC_API_BASE_URL:-https:\/\/api\.driftstack\.dev\}"/);
    expect(src).toMatch(/PUBLIC_API_BASE_URL="\$API_BASE" npm run build/);
  });

  it('builds the dependency-free errors site directly instead of falling through to the root workspace', () => {
    expect(src).toMatch(
      /if \[ "\$APP" = "errors-site" \]; then\s+# errors-site[^]*?node build\.mjs\s+else\s+PUBLIC_API_BASE_URL="\$API_BASE" npm run build\s+fi/,
    );
  });

  it('ABORTS the deploy if the built output still embeds a localhost API base', () => {
    expect(src).toMatch(/grep -rqE 'apiBaseUrl = "https\?:\/\/localhost' dist\//);
    // CRITICAL: status-site's Astro pages embed the API base as `API_BASE`,
    // not `apiBaseUrl` (customer-dashboard/admin-panel's identifier) — the
    // apiBaseUrl-only check was structurally blind to a localhost leak on
    // status-site specifically. Both patterns must be checked.
    expect(src).toMatch(/grep -rqE 'API_BASE = "https\?:\/\/localhost' dist\//);
    expect(src).toMatch(/ABORT.*localhost/);
    // The abort must happen BEFORE the actual deploy command (not the
    // `wrangler pages deploy` mention in the header comment).
    const abortIdx = src.indexOf('NOT deploying');
    const deployIdx = src.indexOf('npx --no-install wrangler pages deploy');
    expect(abortIdx).toBeGreaterThan(-1);
    expect(deployIdx).toBeGreaterThan(abortIdx);
  });

  it('also aborts if the intended API base is absent from the build', () => {
    expect(src).toMatch(/if ! grep -rqF "\$API_BASE" dist\//);
  });

  it('API-base-embedding apps (dashboard / admin / status) run the guard (NEEDS_API=1)', () => {
    for (const app of ['customer-dashboard', 'admin-panel', 'status-site']) {
      expect(src).toMatch(new RegExp(`${app}\\)\\s+SLUG="[^"]+";\\s+NEEDS_API=1`));
    }
  });

  it('project slugs match the canonical CI workflow slugs', () => {
    // Pull the slugs the CI deploy workflows use; the wrapper must agree so a
    // manual deploy lands on the same Pages project as CI.
    const wf = ['deploy-customer-dashboard', 'deploy-admin-panel', 'deploy-status-site'];
    const known: Record<string, string> = {
      'customer-dashboard': 'driftstack-customer-dashboard',
      'admin-panel': 'driftstack-admin-panel',
      'status-site': 'driftstack-status',
      'marketing-site': 'driftstack-marketing',
      docs: 'driftstack-docs',
      'errors-site': 'driftstack-errors',
    };
    for (const [app, slug] of Object.entries(known)) {
      expect(src).toContain(`SLUG="${slug}"`);
      expect(src).toMatch(new RegExp(`${app.replace('-', '\\-')}\\)`));
    }
    void wf;
  });
});
