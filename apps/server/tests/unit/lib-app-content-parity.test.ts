// W430.A — drift guard for apps/server/src/lib/app.ts.
// The Fastify app builder — composes every plugin, route, hook,
// and probe endpoint. Drift here either drops a security header
// (CORS / Helmet / no-store), breaks a public probe (/health /
// /ready / /version), or accidentally widens the conditional-
// registration gates (a route registers when it shouldn't).
//
//   • Pure-factory framing pinned.
//   • V-664 Helmet posture pinned: CSP off for JSON; CORP cross-
//     origin; COEP off; HSTS 2y+subdomains+preload.
//   • V-664.B CORS posture pinned: permissive vs allow-list +
//     localhost regex; credentials true; explicit methods +
//     allowedHeaders + exposedHeaders incl. W199 RateLimit set;
//     preflight maxAge 600.
//   • V-666.BS/BT/BW no-store onSend hook covers /v1/account/* +
//     /v1/admin/* + /v1/billing/* + /v1/billing exact.
//   • Public probes: /health (+/healthz), /version (V-195 +
//     V-337), /ready (Promise.all + per-check timeout 1500ms).
//   • Auth-flow / MFA / CLI-authorize / Stripe / NowPayments /
//     OAuth / Cost / Profiles / Billing / Force-actions
//     conditional gates pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W430.A apps/server/src/lib/app.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: pure factory; takes deps, returns FastifyInstance; tests use in-memory adapters; prod wires Drizzle + ioredis', () => {
    expect(body).toMatch(/\/\/ Fastify app builder\./);
    expect(body).toMatch(
      /\/\/ Pure factory: takes its dependencies as arguments, returns a configured\s*\n?\s*\/\/ `FastifyInstance`\. Tests build the app with in-memory adapters; production\s*\n?\s*\/\/ wires the same builder to Drizzle \+ ioredis\./,
    );
  });

  it('ReadinessCheck interface pinned: name + async fn + optional timeoutMs (default 1500); runWithTimeout helper races setTimeout reject', () => {
    expect(body).toMatch(
      /export interface ReadinessCheck \{\s*\n?\s*\/\*\* Display name surfaced in the \/ready response \(e\.g\. "postgres", "redis", "r2"\)\. \*\/\s*\n?\s*name: string;\s*\n?\s*\/\*\* Async probe — throws or rejects on failure, resolves on success\. \*\/\s*\n?\s*fn: \(\) => Promise<unknown>;\s*\n?\s*\/\*\* Per-check timeout in ms\. Default 1500\. \*\/\s*\n?\s*timeoutMs\?: number;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async function runWithTimeout<T>\(p: Promise<T>, timeoutMs: number\): Promise<T> \{[\s\S]+?Promise\.race<T>\(\[[\s\S]+?reject\(new Error\(`timeout after \$\{timeoutMs\}ms`\)\), timeoutMs\)/,
    );
  });

  it('buildApp signature: async (deps: AppDeps) => Promise<FastifyInstance>; genReqId honors x-request-id (string, 1..128 chars) else randomUUID', () => {
    expect(body).toMatch(
      /export async function buildApp\(deps: AppDeps\): Promise<FastifyInstance> \{/,
    );
    expect(body).toMatch(
      /genReqId: \(req\) => \{\s*\n?\s*const inbound = req\.headers\['x-request-id'\];\s*\n?\s*if \(typeof inbound === 'string' && inbound\.length > 0 && inbound\.length <= 128\) \{\s*\n?\s*return inbound;\s*\n?\s*\}\s*\n?\s*return randomUUID\(\);\s*\n?\s*\},/,
    );
  });

  it('V-664 Helmet posture pinned: CSP false (JSON-only); CORP cross-origin (SDK preflights); COEP false; HSTS maxAge 63_072_000 (2y) + includeSubDomains + preload; rationale comments', () => {
    expect(body).toMatch(
      /\/\/ V-664 — security headers\. Helmet defaults are tuned for HTML\s*\n?\s*\/\/ surfaces; for a JSON API some defaults are wrong/,
    );
    expect(body).toMatch(/contentSecurityPolicy: false,/);
    expect(body).toMatch(/crossOriginResourcePolicy: \{ policy: 'cross-origin' \},/);
    expect(body).toMatch(/crossOriginEmbedderPolicy: false,/);
    expect(body).toMatch(
      /strictTransportSecurity: \{\s*\n?\s*maxAge: 63_072_000,\s*\n?\s*includeSubDomains: true,\s*\n?\s*preload: true,\s*\n?\s*\},/,
    );
  });

  it('V-664.B CORS posture pinned: permissive=true OR [localhost regex, ...corsAllowedOrigins]; credentials true; explicit methods + headers + exposed RateLimit set (W199); maxAge 600', () => {
    expect(body).toMatch(
      /\/\/ V-664\.B — CORS hardening\. Pins methods, allowed headers, and\s*\n?\s*\/\/ preflight cache window explicitly/,
    );
    expect(body).toMatch(
      /\/\/ `credentials: true` is required by the customer dashboard's\s*\n?\s*\/\/ cookie-based session \(Article-13 auth\), NOT by the SDK \(which\s*\n?\s*\/\/ sends Authorization: Bearer \.\.\.\)/,
    );
    expect(body).toMatch(
      /origin:\s*\n?\s*deps\.permissiveCors === true\s*\n?\s*\? true\s*\n?\s*: \[\/\^https\?:\\\/\\\/localhost\(:\\d\+\)\?\$\/, \.\.\.\(deps\.corsAllowedOrigins \?\? \[\]\)\],/,
    );
    expect(body).toMatch(/credentials: true,/);
    expect(body).toMatch(/methods: \['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'\],/);
    expect(body).toMatch(
      /allowedHeaders: \[\s*\n?\s*'authorization',\s*\n?\s*'content-type',\s*\n?\s*'x-request-id',\s*\n?\s*'stripe-signature',\s*\n?\s*'x-nowpayments-sig',\s*\n?\s*\],/,
    );
    expect(body).toMatch(
      /exposedHeaders: \[\s*\n?\s*'x-request-id',\s*\n?\s*\/\/ W199 — full RateLimit-header set documented at \/docs\/rate-limits\.\s*\n?\s*'x-ratelimit-bucket',\s*\n?\s*'x-ratelimit-limit',\s*\n?\s*'x-ratelimit-remaining',\s*\n?\s*'x-ratelimit-reset',\s*\n?\s*'retry-after',\s*\n?\s*\],/,
    );
    expect(body).toMatch(/maxAge: 600,/);
  });

  it('Auth + rate-limit plugins ordered correctly + Sentry hooks installed BEFORE auth/rate-limit (V-117 framing pinned)', () => {
    expect(body).toMatch(
      /\/\/ V-117: install Sentry hooks BEFORE auth\/rate-limit so breadcrumbs\s*\n?\s*\/\/ capture every request — including ones that fail at the auth or\s*\n?\s*\/\/ rate-limit gate\./,
    );
    expect(body).toMatch(
      /if \(deps\.sentry !== undefined\) \{\s*\n?\s*wireSentryRequestBreadcrumbs\(app, deps\.sentry\);\s*\n?\s*wireSentryErrorHandler\(app, deps\.sentry\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /await app\.register\(authPlugin, \{\s*\n?\s*authRepo: deps\.authRepo,\s*\n?\s*authCache: deps\.authCache,\s*\n?\s*authCoalescer: deps\.authCoalescer,/,
    );
    expect(body).toMatch(
      /await app\.register\(rateLimitPlugin, \{ store: deps\.rateLimitStore \}\);/,
    );
    expect(body).toMatch(/registerErrorHandler\(app\);/);
  });

  it('V-666.BS/BT/BW no-store onSend hook: stamps Cache-Control no-store,private on /v1/account/* + /v1/admin/* + /v1/billing/* + /v1/billing exact; rationale block pinned', () => {
    expect(body).toMatch(
      /\/\/ V-666\.BS — stamp Cache-Control: no-store, private on every\s*\n?\s*\/\/ \/v1\/account\/\* response/,
    );
    expect(body).toMatch(
      /\/\/ V-666\.BT — same rationale broadened to every \/v1\/admin\/\* route\./,
    );
    expect(body).toMatch(/\/\/ V-666\.BW — broadened again to cover \/v1\/billing\/\*\./);
    expect(body).toMatch(
      /app\.addHook\('onSend', \(req, reply, _payload, done\) => \{\s*\n?\s*if \(\s*\n?\s*req\.url\.startsWith\('\/v1\/account\/'\) \|\|\s*\n?\s*req\.url\.startsWith\('\/v1\/admin\/'\) \|\|\s*\n?\s*req\.url\.startsWith\('\/v1\/billing\/'\) \|\|\s*\n?\s*req\.url === '\/v1\/billing'\s*\n?\s*\) \{\s*\n?\s*void reply\.header\('cache-control', 'no-store, private'\);\s*\n?\s*\}\s*\n?\s*done\(\);\s*\n?\s*\}\);/,
    );
  });

  it('Conditional service gates pinned: incidentsService + statusSubscribersService + incidentEventBus+slaReportingService + teamMembersService + authFlowsService + cliAuthorizeService + stripe (service+secret) + NowPayments (secret>0) + cryptoOrdersService + oauthStore + costMonitoringService + profilesService (+profileSnapshotsService) + billingService + force-action triple (sessionRepo+apiKeysRepo+driver)', () => {
    expect(body).toMatch(/if \(deps\.incidentsService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.statusSubscribersService !== undefined\) \{/);
    expect(body).toMatch(
      /if \(deps\.incidentEventBus !== undefined && deps\.slaReportingService !== undefined\) \{/,
    );
    expect(body).toMatch(/if \(deps\.teamMembersService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.authFlowsService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.mfaService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.cliAuthorizeService !== undefined\) \{/);
    expect(body).toMatch(
      /if \(deps\.stripeWebhooksService !== undefined && deps\.stripeWebhookSigningSecret !== undefined\) \{/,
    );
    expect(body).toMatch(
      /if \(deps\.nowpaymentsIpnSecret !== undefined && deps\.nowpaymentsIpnSecret\.length > 0\) \{/,
    );
    expect(body).toMatch(/if \(deps\.cryptoOrdersService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.oauthStore !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.costMonitoringService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.profilesService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.profileSnapshotsService !== undefined\) \{/);
    expect(body).toMatch(/if \(deps\.billingService !== undefined\) \{/);
    expect(body).toMatch(
      /if \(\s*\n?\s*deps\.sessionRepo !== undefined &&\s*\n?\s*deps\.apiKeysRepo !== undefined &&\s*\n?\s*deps\.driver !== undefined\s*\n?\s*\) \{/,
    );
  });

  it('V-237 customer self-profile gate: sessionRepo + profilesRepo + authRepo + authCache + r2Public + mfaService passed to registerAccountMeRoutes', () => {
    expect(body).toMatch(/\/\/ V-237 — customer self-profile for tier-aware GUI enforcement\./);
    expect(body).toMatch(
      /if \(deps\.sessionRepo !== undefined && deps\.profilesRepo !== undefined\) \{\s*\n?\s*registerAccountMeRoutes\(app, \{\s*\n?\s*sessionRepo: deps\.sessionRepo,\s*\n?\s*profilesRepo: deps\.profilesRepo,\s*\n?\s*authRepo: deps\.authRepo,\s*\n?\s*authCache: deps\.authCache,\s*\n?\s*r2Public: deps\.r2Public \?\? null,\s*\n?\s*mfaService: deps\.mfaService \?\? null,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('Public probes pinned: /health + /healthz returning {ok:true}; V-195 /version exposes version + git_sha + started_at + node_version + driver (+playwright_browser when driverName=playwright)', () => {
    expect(body).toMatch(/app\.get\('\/health', \(\) => \(\{ ok: true \}\)\);/);
    expect(body).toMatch(/app\.get\('\/healthz', \(\) => \(\{ ok: true \}\)\);/);
    expect(body).toMatch(
      /\/\/ V-195 — public version endpoint for ops tooling\. Reports server\s*\n?\s*\/\/ version \(from package\.json env\), git sha \(from GIT_SHA env at\s*\n?\s*\/\/ deploy time, "unknown" otherwise\), and process start time\./,
    );
    expect(body).toMatch(/const buildVersion = process\.env\.npm_package_version \?\? '0\.0\.0';/);
    expect(body).toMatch(/const gitSha = process\.env\.GIT_SHA \?\? 'unknown';/);
    expect(body).toMatch(
      /app\.get\('\/version', \(\) => \(\{\s*\n?\s*version: buildVersion,\s*\n?\s*git_sha: gitSha,\s*\n?\s*started_at: startedAt,\s*\n?\s*node_version: process\.version,/,
    );
    expect(body).toMatch(/driver: deps\.driverName \?\? 'mock',/);
    expect(body).toMatch(
      /\.\.\.\(deps\.driverName === 'playwright' && deps\.playwrightBrowser !== undefined\s*\n?\s*\? \{ playwright_browser: deps\.playwrightBrowser \}\s*\n?\s*: \{\}\),/,
    );
  });

  it('/ready endpoint: public no-auth; runs each readinessCheck via runWithTimeout(default 1500); 200 all-ok / 503 any-fail; returns {ready, checks[]}', () => {
    expect(body).toMatch(
      /\/\/ Readiness endpoint — public, no auth, no rate limit\. Returns 200\s*\n?\s*\/\/ only when the dependencies the server needs to serve traffic are\s*\n?\s*\/\/ reachable\./,
    );
    expect(body).toMatch(
      /app\.get\('\/ready', async \(_request, reply\) => \{\s*\n?\s*const checks = deps\.readinessChecks \?\? \[\];\s*\n?\s*const results = await Promise\.all\(/,
    );
    expect(body).toMatch(
      /await runWithTimeout\(c\.fn\(\), c\.timeoutMs \?\? 1500\);\s*\n?\s*return \{ name: c\.name, ok: true, latency_ms: Date\.now\(\) - start \};/,
    );
    expect(body).toMatch(
      /return reply\.code\(allReady \? 200 : 503\)\.send\(\{\s*\n?\s*ready: allReady,\s*\n?\s*checks: results,\s*\n?\s*\}\);/,
    );
  });

  it('/v1/whoami: requireAuth + rateLimit(global); returns account_id (acc_ prefix) + api_key_id (key_ prefix) + tier + scopes; unreachable account-missing branch throws', () => {
    expect(body).toMatch(
      /app\.get\('\/v1\/whoami', \{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \}, \(request\) => \{/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*account_id: `acc_\$\{ctx\.account\.id\}`,\s*\n?\s*api_key_id: `key_\$\{ctx\.apiKey\.id\}`,\s*\n?\s*tier: ctx\.account\.tier,\s*\n?\s*scopes: ctx\.apiKey\.scopes,\s*\n?\s*\};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
