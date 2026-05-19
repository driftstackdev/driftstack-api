// Cross-source invariant: the activation-gate pattern has a fixed
// roster of disabled-stub registrars across routes/*. The 7
// gated features (billing + session-proxy + saved-proxies +
// agent-sessions + fleet-events + byok-anthropic + recipes) MUST
// each ship a disabled-stub registrar so the AppDeps-unset branch
// surfaces 503 FeatureUnavailable instead of bare 404. Drift on the
// roster (e.g. adding a new gated feature but forgetting the
// disabled-stub) would silently 404 instead of 503 → SDK clients
// would treat the feature as nonexistent rather than not-yet-wired.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const ROUTES = [
  { file: 'billing.ts', registrar: 'registerBillingDisabledRoutes' },
  { file: 'session-proxy.ts', registrar: 'registerSessionProxyDisabledRoutes' },
  { file: 'saved-proxies.ts', registrar: 'registerSavedProxiesDisabledRoutes' },
  { file: 'agent-sessions.ts', registrar: 'registerAgentSessionsDisabledRoutes' },
  { file: 'fleet-events.ts', registrar: 'registerFleetEventsDisabledRoutes' },
  {
    file: 'account-byok-anthropic.ts',
    registrar: 'registerAccountByokAnthropicDisabledRoutes',
  },
  { file: 'recipes.ts', registrar: 'registerRecipesDisabledRoutes' },
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('Activation-gate disabled-stub registrar roster cross-source invariant', () => {
  it.each(ROUTES)('%s exports the disabled-stub registrar %s', ({ file, registrar }) => {
    const src = read(resolve(REPO_ROOT, 'apps/server/src/routes', file));
    const re = new RegExp(`export function ${registrar}\\(app: FastifyInstance\\): void \\{`);
    expect(src).toMatch(re);
  });

  it("routes/account-byok-anthropic header claims '6th gated feature' + lists the 5 prior features (billing / session-proxy / saved-proxies / agent-sessions / fleet-events) — pinned so the historical-count claim stays accurate to its commit-time position (recipes was added later; the comment is correct as-of-when-written, not as-of-now)", () => {
    const byokSrc = read(resolve(REPO_ROOT, 'apps/server/src/routes/account-byok-anthropic.ts'));
    expect(byokSrc).toMatch(
      /Activation-gate pattern \(6th gated feature; matches billing \/\s*\n?\s*\/\/ session-proxy \/ saved-proxies \/ agent-sessions \/ fleet-events\)/,
    );
  });

  it('routes/recipes header lists 3 prior gated-feature patterns (agent-sessions / billing / session-egress) — pinned so the same-activation-gate-pattern reference stays documented', () => {
    const recipesSrc = read(resolve(REPO_ROOT, 'apps/server/src/routes/recipes.ts'));
    expect(recipesSrc).toMatch(
      /Same activation-gate pattern as agent-sessions \/ billing \/\s*\n?\s*\/\/ session-egress\./,
    );
  });

  it('Every disabled-stub registrar throws FeatureUnavailableError (NOT NotFoundError or generic 500) — pinned so the 503-not-404 customer-facing distinction stays consistent across all 7 features', () => {
    for (const { file } of ROUTES) {
      const src = read(resolve(REPO_ROOT, 'apps/server/src/routes', file));
      expect(src).toMatch(/throw new FeatureUnavailableError/);
    }
  });
});
