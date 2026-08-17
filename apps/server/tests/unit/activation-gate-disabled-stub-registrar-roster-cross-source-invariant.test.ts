// Cross-source invariant: every activation-gated feature ships a disabled-stub
// registrar, so the AppDeps-unset branch surfaces 503 FeatureUnavailable rather
// than a bare 404 — an SDK client must be able to tell "not enabled on this
// deployment" from "no such endpoint".
//
// The seven stubs, as `routes/` actually defines them: billing, session-proxy,
// agent-sessions, fleet-events, account-byok-anthropic, recipes, and
// internal-atlas-priority (DRIFTSTACK_FLEET_INTERNAL_TOKEN unset).
//
// This header used to name a different seven — it listed `saved-proxies`, which
// ships no registrar, and omitted internal-atlas-priority, which does. The hand
// roster below carried the same error with a different count: six entries, while
// the check titled "across all 7 features" looped over exactly those six. So the
// drift this file exists to catch had already happened here, and the atlas
// stub's 503-not-404 behaviour was never actually asserted.
//
// The roster is kept, because naming the expected members is what makes a
// removal deliberate. What is new is that it is no longer the only source: the
// stubs are also DISCOVERED from routes/, and the roster must cover what
// discovery finds. A list a human must remember to update cannot be the thing
// that enforces completeness.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const ROUTES = [
  { file: 'billing.ts', registrar: 'registerBillingDisabledRoutes' },
  { file: 'session-proxy.ts', registrar: 'registerSessionProxyDisabledRoutes' },
  { file: 'agent-sessions.ts', registrar: 'registerAgentSessionsDisabledRoutes' },
  { file: 'fleet-events.ts', registrar: 'registerFleetEventsDisabledRoutes' },
  {
    file: 'account-byok-anthropic.ts',
    registrar: 'registerAccountByokAnthropicDisabledRoutes',
  },
  { file: 'recipes.ts', registrar: 'registerRecipesDisabledRoutes' },
  {
    file: 'internal-atlas-priority.ts',
    registrar: 'registerInternalAtlasPriorityDisabledRoutes',
  },
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/**
 * Every disabled-stub registrar that actually exists, discovered rather than
 * listed.
 *
 * The hand roster above had drifted exactly the way its own header warns about:
 * it names six, `routes/` defines seven. `registerInternalAtlasPriorityDisabledRoutes`
 * (DRIFTSTACK_FLEET_INTERNAL_TOKEN unset) was added without a roster entry, so
 * the "every disabled-stub registrar throws FeatureUnavailableError" check —
 * whose own title said "all 7 features" — was iterating six of them. A roster
 * that must be edited by hand to stay complete cannot enforce completeness.
 */
const DISCOVERED: ReadonlyArray<{ file: string; registrar: string }> = readdirSync(
  resolve(REPO_ROOT, 'apps/server/src/routes'),
)
  .filter((f) => f.endsWith('.ts'))
  .flatMap((file) =>
    [
      ...read(resolve(REPO_ROOT, 'apps/server/src/routes', file)).matchAll(
        /export function (register\w*DisabledRoutes)\(/g,
      ),
    ].map((m) => ({ file, registrar: m[1] ?? '' })),
  );

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

  it('CRITICAL the discovery found the stubs, so the arms below are not iterating an empty list', () => {
    expect(
      DISCOVERED.length,
      'no disabled-stub registrars were discovered — the export convention changed and every ' +
        'discovery-driven check below now passes vacuously',
    ).toBeGreaterThanOrEqual(7);
  });

  it('CRITICAL the hand roster covers every registrar that exists', () => {
    // The drift this file was written to catch, applied to the file itself.
    const listed = new Set(ROUTES.map((r) => r.registrar));
    const missing = DISCOVERED.filter((d) => !listed.has(d.registrar)).map(
      (d) => `${d.file}: ${d.registrar}`,
    );
    expect(
      missing,
      'a disabled-stub registrar exists that the roster does not list, so the per-feature ' +
        'assertions silently skip it. Add it to ROUTES',
    ).toEqual([]);
  });

  it('CRITICAL every discovered stub is WIRED in app.ts, not merely defined', () => {
    // A stub that exists but is never called is the same customer-visible
    // outcome as having no stub at all: the unset branch registers nothing and
    // the route 404s instead of 503.
    const app = read(resolve(REPO_ROOT, 'apps/server/src/lib/app.ts'));
    const unwired = DISCOVERED.filter((d) => !app.includes(`${d.registrar}(app)`)).map(
      (d) => `${d.file}: ${d.registrar}`,
    );
    expect(
      unwired,
      'a disabled-stub registrar is defined but never called from app.ts, so the feature-unset ' +
        'branch registers nothing and the endpoints 404 rather than returning 503',
    ).toEqual([]);
  });

  it('Every disabled-stub registrar throws FeatureUnavailableError (NOT NotFoundError or generic 500) — pinned so the 503-not-404 customer-facing distinction stays consistent across every gated feature', () => {
    // Iterates the DISCOVERED set, not the hand roster: the title used to claim
    // "all 7 features" while looping over six.
    const wrong = DISCOVERED.filter((d) => {
      const src = read(resolve(REPO_ROOT, 'apps/server/src/routes', d.file));
      const body = src.slice(src.indexOf(`export function ${d.registrar}(`));
      const end = body.indexOf('\n}\n');
      return !/throw new FeatureUnavailableError/.test(end === -1 ? body : body.slice(0, end));
    }).map((d) => `${d.file}: ${d.registrar}`);
    expect(
      wrong,
      'a disabled-stub registrar does not throw FeatureUnavailableError, so an unwired feature ' +
        'reports 404 (endpoint does not exist) rather than 503 (not enabled here) and an SDK ' +
        'client treats it as nonexistent instead of not-yet-wired',
    ).toEqual([]);
  });
});
