// Cross-source invariant — activation-gate pattern is now used 9 times
// (billing / session-proxy / agent-sessions / fleet-events / byok-anthropic /
// recipes / internal-atlas-priority, and V-1756's account-mfa / auth-cli)
// and the pattern is structurally identical across all 9.
// NOTE: this header used to name `saved-proxies`, which ships no registrar.
//
//   1. Each route file exports BOTH `registerXxxRoutes(app, deps)`
//      AND `registerXxxDisabledRoutes(app)`.
//   2. The disabled variant throws `FeatureUnavailableError`
//      (problem-type FeatureUnavailable; HTTP 503).
//   3. `app.ts` wires them in an `if (deps.xxxService !== undefined)`
//      / else block — the real registration is gated on the AppDeps
//      service being defined.
//
// This invariant matters because:
// - Drift on (1) means a feature gets stuck unable to register its
//   disabled-stub variant — the dashboard / SDK would see 404 instead
//   of 503 + machine-readable problem-type.
// - Drift on (2) (e.g. using a 404 NotFoundError instead) breaks the
//   client-side activation-detection pattern (Wave 1119 / Slice 1119.2
//   dashboard leg + the matching EGRESS dashboard leg).
// - Drift on (3) — forgetting the else clause — leaves routes
//   unregistered when the service is absent, which silently 404s.

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

interface GatedFeature {
  /** Display name for assertion messages. */
  name: string;
  /** Route file that exports the wired + disabled registrar pair. */
  routesFile: string;
  /** Wired registrar fn name. */
  wiredFn: string;
  /** Disabled-stub registrar fn name. */
  disabledFn: string;
  /** AppDeps field name the gate keys on. */
  depsField: string;
}

const FEATURES: GatedFeature[] = [
  {
    name: 'billing',
    routesFile: 'apps/server/src/routes/billing.ts',
    wiredFn: 'registerBillingRoutes',
    disabledFn: 'registerBillingDisabledRoutes',
    depsField: 'billingService',
  },
  {
    name: 'session-proxy (EGRESS per-session)',
    routesFile: 'apps/server/src/routes/session-proxy.ts',
    wiredFn: 'registerSessionProxyRoutes',
    disabledFn: 'registerSessionProxyDisabledRoutes',
    depsField: 'sessionEgressService',
  },
  {
    name: 'agent-sessions (AI chat)',
    routesFile: 'apps/server/src/routes/agent-sessions.ts',
    wiredFn: 'registerAgentSessionsRoutes',
    disabledFn: 'registerAgentSessionsDisabledRoutes',
    depsField: 'agentRuntime',
  },
  {
    name: 'fleet-events (V-820)',
    routesFile: 'apps/server/src/routes/fleet-events.ts',
    wiredFn: 'registerFleetEventsRoutes',
    disabledFn: 'registerFleetEventsDisabledRoutes',
    depsField: 'fleetNodeAuth',
  },
  {
    name: 'byok-anthropic (AI-CHAT customer key storage)',
    routesFile: 'apps/server/src/routes/account-byok-anthropic.ts',
    wiredFn: 'registerAccountByokAnthropicRoutes',
    disabledFn: 'registerAccountByokAnthropicDisabledRoutes',
    depsField: 'byokAnthropicService',
  },
  {
    // The seventh gate, and the one that exposed this roster as hand-maintained:
    // it shipped without an entry here OR in the sibling disabled-stub roster, so
    // neither its 503-not-404 behaviour nor its wiring was ever asserted.
    name: 'internal-atlas-priority (DRIFTSTACK_FLEET_INTERNAL_TOKEN)',
    routesFile: 'apps/server/src/routes/internal-atlas-priority.ts',
    wiredFn: 'registerInternalAtlasPriorityRoutes',
    disabledFn: 'registerInternalAtlasPriorityDisabledRoutes',
    depsField: 'atlasPriorityEventsRepo',
  },
  {
    name: 'recipes (AI-B4 write-only recipe library)',
    routesFile: 'apps/server/src/routes/recipes.ts',
    wiredFn: 'registerRecipesRoutes',
    disabledFn: 'registerRecipesDisabledRoutes',
    depsField: 'recipesRepo',
  },
  // V-1756 — these two were activation-gated with NO disabled stub and no FEATURES
  // entry, so they 404'd instead of 503-ing and nothing here checked them. They were
  // unreachable by this file's own census because it enumerates features that already
  // ship a stub; a gate with none cannot appear.
  {
    name: 'account-mfa',
    routesFile: 'apps/server/src/routes/account-mfa.ts',
    wiredFn: 'registerAccountMfaRoutes',
    disabledFn: 'registerAccountMfaDisabledRoutes',
    depsField: 'mfaService',
  },
  {
    name: 'auth-cli (CLI device authorization)',
    routesFile: 'apps/server/src/routes/auth-cli.ts',
    wiredFn: 'registerAuthCliRoutes',
    disabledFn: 'registerAuthCliDisabledRoutes',
    depsField: 'cliAuthorizeService',
  },
];

const APP_TS = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

describe('activation-gate pattern cross-source invariant', () => {
  const appBody = read(APP_TS);

  for (const f of FEATURES) {
    describe(f.name, () => {
      const routeBody = read(resolve(REPO_ROOT, f.routesFile));

      it('routes file exists at the canonical path', () => {
        expect(existsSync(resolve(REPO_ROOT, f.routesFile))).toBe(true);
      });

      it(`exports the wired registrar \`${f.wiredFn}\``, () => {
        // `async` tolerated: a WS-route registrar (fleet-events) awaits its
        // plugin registration, so it's `export async function`.
        expect(routeBody).toMatch(new RegExp(`export (async )?function ${f.wiredFn}\\(`));
      });

      it(`exports the disabled-stub registrar \`${f.disabledFn}\``, () => {
        expect(routeBody).toMatch(new RegExp(`export function ${f.disabledFn}\\(`));
      });

      it(`disabled registrar throws FeatureUnavailableError (problem-type 503)`, () => {
        // The disabled fn body MUST reference FeatureUnavailableError;
        // pattern stays valid even if the throw site is wrapped in a
        // helper inside the function (e.g. `const stub = () => { throw new FeatureUnavailableError(...); }`).
        const fnIdx = routeBody.indexOf(`export function ${f.disabledFn}`);
        expect(fnIdx).toBeGreaterThan(-1);
        const tail = routeBody.slice(fnIdx);
        expect(tail).toMatch(/FeatureUnavailableError/);
      });

      it(`disabled registrar passes a non-empty detail string to FeatureUnavailableError — the 503 body's \`detail\` field powers the dashboard's user-facing message; empty detail would surface as a blank toast`, () => {
        const fnIdx = routeBody.indexOf(`export function ${f.disabledFn}`);
        expect(fnIdx).toBeGreaterThan(-1);
        const tail = routeBody.slice(fnIdx);
        // Find the FeatureUnavailableError instantiation + capture its
        // first arg. Two common shapes — a literal string or a variable
        // initialized earlier in the function (e.g. `const detail =
        // '...'; ... throw new FeatureUnavailableError(detail)`). Both
        // shapes need the string to be non-empty.
        const literalArg = tail.match(/new FeatureUnavailableError\(\s*'([^']{8,})'/);
        const literalArgDouble = tail.match(/new FeatureUnavailableError\(\s*"([^"]{8,})"/);
        const literalArgTemplate = tail.match(/new FeatureUnavailableError\(\s*`([^`]{8,})`/);
        const variableArg = tail.match(/new FeatureUnavailableError\(\s*(\w+)\s*\)/);
        const hasLiteralDetail = !!(literalArg || literalArgDouble || literalArgTemplate);
        if (hasLiteralDetail) return; // literal string ≥8 chars present
        // Variable arg path — track back to the const declaration and
        // verify it points at a non-empty string. ≥8 chars to filter
        // out placeholders.
        expect(variableArg, 'no FeatureUnavailableError(...) call found').not.toBeNull();
        const varName = variableArg![1];
        const detailDecl = tail.match(
          new RegExp(`const ${varName!}\\s*=\\s*['"\`]([^'"\`]{8,})['"\`]`),
        );
        // Concat shape: `const detail = 'foo' + 'bar';` — flatten and
        // require the concatenated length to be ≥8 chars.
        const detailConcat = tail.match(new RegExp(`const ${varName!}\\s*=([^;]{8,});`));
        expect(
          detailDecl || detailConcat,
          `detail variable \`${varName}\` not declared with a non-empty string`,
        ).toBeTruthy();
      });

      it(`app.ts wires both registrars under an \`if (deps.${f.depsField}\` activation gate`, () => {
        // Allow either == or !== form so the test doesn't pin the
        // exact polarity (some gates negate, some don't).
        expect(appBody).toMatch(new RegExp(`deps\\.${f.depsField}`));
        // Both registrars must be CALLED from app.ts — matching the bare name
        // was satisfied by the import line alone, so renaming a call site left
        // this green while the feature was no longer wired at all. Verified by
        // mutation: renaming `registerInternalAtlasPriorityRoutes(app, {` did
        // not fail this arm until it required the call shape.
        expect(
          appBody,
          `${f.wiredFn} is imported but never called — the feature's live routes are not wired`,
        ).toContain(`${f.wiredFn}(app`);
        expect(
          appBody,
          `${f.disabledFn} is imported but never called — the unset branch registers nothing and ` +
            'the endpoints 404 rather than returning 503',
        ).toContain(`${f.disabledFn}(app`);
      });
    });
  }

  it('CRITICAL FEATURES covers every activation-gated feature that exists', () => {
    // This roster listed six while routes/ defined seven. The seventh
    // (internal-atlas-priority) shipped with no entry here and none in the
    // sibling disabled-stub roster, so nothing asserted its wiring or its
    // 503-not-404 behaviour. A list maintained by hand cannot notice the entry
    // nobody added — so the population is discovered, and the roster must cover
    // what discovery finds.
    const discovered = readdirSync(resolve(REPO_ROOT, 'apps/server/src/routes'))
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => [
        ...read(resolve(REPO_ROOT, 'apps/server/src/routes', f)).matchAll(
          /export function (register\w*DisabledRoutes)\(/g,
        ),
      ])
      .map((m) => m[1] ?? '');
    expect(
      discovered.length,
      'no gated features discovered — the convention changed',
    ).toBeGreaterThanOrEqual(7);
    const listed = new Set(FEATURES.map((f) => f.disabledFn));
    expect(
      discovered.filter((d) => !listed.has(d)),
      'an activation-gated feature ships a disabled stub but has no FEATURES entry, so its ' +
        'wired/disabled registrars and deps gate are never checked — the gap this roster already ' +
        'had once',
    ).toEqual([]);
  });

  it('FeatureUnavailableError is in errors.ts (the problem-type the pattern depends on)', () => {
    const errorsBody = read(resolve(REPO_ROOT, 'apps/server/src/lib/errors.ts'));
    expect(errorsBody).toMatch(/export class FeatureUnavailableError extends ApiError/);
    // The class MUST use HTTP 503 — the dashboard activation-detection
    // pattern (Wave 1119 / Slice 1119.2 + EGRESS + AI-D) keys on 503.
    expect(errorsBody).toMatch(/FeatureUnavailableError[\s\S]{0,300}status: 503/);
  });
});
