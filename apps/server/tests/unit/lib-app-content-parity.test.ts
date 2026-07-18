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
//   • no-store onSend hook defaults Cache-Control no-store,private on
//     ALL of /v1 except /v1/status* + routes that set their own header.
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
    // W586 — the allow-list moved to lib/cors-allow.ts (single source, so the
    // SSE routes reflect the SAME origins). app.ts now delegates to it.
    expect(body).toMatch(
      /origin: deps\.permissiveCors === true \? true : corsOriginMatchers\(deps\)/,
    );
    // The localhost/tauri regexes + dashboard/extra spreads now live in
    // cors-allow.ts; pin them there so the matcher set can't silently shrink.
    const corsAllow = read(resolve(REPO_ROOT, 'apps/server/src/lib/cors-allow.ts'));
    expect(corsAllow).toMatch(/const LOCALHOST_RE = \/\^https\?:\\\/\\\/localhost\(:\\d\+\)\?\$\//);
    expect(corsAllow).toMatch(/const TAURI_LOCALHOST_RE = \/\^tauri:\\\/\\\/localhost\$\//);
    expect(corsAllow).toMatch(/const TAURI_HTTPS_RE = \/\^https\?:\\\/\\\/tauri\\\.localhost\$\//);
    expect(corsAllow).toMatch(/\.\.\.\(deps\.corsAllowedOrigins \?\? \[\]\),/);
    expect(corsAllow).toMatch(
      /\.\.\.\(deps\.dashboardOrigin !== undefined \? \[deps\.dashboardOrigin\] : \[\]\),/,
    );
    expect(body).toMatch(/credentials: true,/);
    expect(body).toMatch(/methods: \['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'\],/);
    // 2026-05-22 — allowedHeaders expanded to include idempotency-key,
    // x-byok-anthropic-api-key + x-driftstack-account. Without the
    // first, the browser blocked crypto-checkout preflight + the
    // POST never fired ("Failed to fetch" on /select-tier). Per-
    // header assertions so future additions don't require
    // rewriting the whole-block regex.
    expect(body).toMatch(/allowedHeaders: \[/);
    expect(body).toMatch(/'authorization',/);
    expect(body).toMatch(/'content-type',/);
    expect(body).toMatch(/'x-request-id',/);
    expect(body).toMatch(/'stripe-signature',/);
    expect(body).toMatch(/'x-nowpayments-sig',/);
    expect(body).toMatch(/'idempotency-key',/);
    expect(body).toMatch(/'x-byok-anthropic-api-key',/);
    expect(body).toMatch(/'x-driftstack-account',/);
    // Per-line pins (not one long \s*\n chain — W561 added the IETF names and
    // extending the chain past 5 groups risks the backtracking-hang lesson).
    expect(body).toMatch(/exposedHeaders: \[\s*\n?\s*'x-request-id',/);
    expect(body).toMatch(/'idempotent-replayed',/);
    expect(body).toMatch(/'x-ratelimit-bucket',/);
    expect(body).toMatch(/'x-ratelimit-limit',/);
    expect(body).toMatch(/'x-ratelimit-remaining',/);
    expect(body).toMatch(/'x-ratelimit-reset',/);
    // W561 — IETF draft names exposed too (ratelimit-reset = relative).
    expect(body).toMatch(/'ratelimit-limit',/);
    expect(body).toMatch(/'ratelimit-remaining',/);
    expect(body).toMatch(/'ratelimit-reset',/);
    expect(body).toMatch(/'retry-after',\s*\n?\s*\],/);
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
      /await app\.register\(rateLimitPlugin, \{\s*\n?\s*store: deps\.rateLimitStore,\s*\n?\s*\.\.\.\(deps\.metricsRegistry !== undefined \? \{ metrics: deps\.metricsRegistry \} : \{\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/registerErrorHandler\(app\);/);
  });

  it('no-store onSend hook: defaults Cache-Control no-store,private on ALL of /v1 EXCEPT /v1/status* and EXCEPT routes that set their own Cache-Control (preserves public status caching + SSE no-cache/no-transform). Discrete pins (the prior single mega-regex was a long \\s*\\n? chain).', () => {
    // Rationale block pinned (the broadening + the two carve-outs).
    expect(body).toMatch(
      /default Cache-Control:\s*\n?\s*\/\/ no-store, private on every caller-private \/v1 response/,
    );
    expect(body).toMatch(/now the default for ALL of \/v1/);
    expect(body).toMatch(/no-transform stops proxies buffering/);
    // The hook condition — discrete pins, not one backtracking chain.
    expect(body).toMatch(/app\.addHook\('onSend', \(req, reply, _payload, done\) => \{/);
    expect(body).toMatch(/req\.url\.startsWith\('\/v1\/'\)/);
    expect(body).toMatch(/!req\.url\.startsWith\('\/v1\/status'\)/);
    expect(body).toMatch(/reply\.getHeader\('cache-control'\) === undefined/);
    expect(body).toMatch(/void reply\.header\('cache-control', 'no-store, private'\);/);
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

  it('V-237 customer self-profile gate: sessionRepo + profilesRepo + authRepo + authCache + r2Public + mfaService passed to registerAccountMeRoutes (+ 2026-05-19 optional oauthLinksRepo conditional spread for the IDP-avatar fallback)', () => {
    expect(body).toMatch(/\/\/ V-237 — customer self-profile for tier-aware GUI enforcement\./);
    expect(body).toMatch(
      /if \(deps\.sessionRepo !== undefined && deps\.profilesRepo !== undefined\) \{\s*\n?\s*registerAccountMeRoutes\(app, \{\s*\n?\s*sessionRepo: deps\.sessionRepo,\s*\n?\s*profilesRepo: deps\.profilesRepo,\s*\n?\s*authRepo: deps\.authRepo,\s*\n?\s*authCache: deps\.authCache,\s*\n?\s*r2Public: deps\.r2Public \?\? null,\s*\n?\s*mfaService: deps\.mfaService \?\? null,[\s\S]*?\}\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /\.\.\.\(deps\.oauthLinksRepo !== undefined \? \{ oauthLinksRepo: deps\.oauthLinksRepo \} : \{\}\),/,
    );
  });

  it('Public probes pinned: /health + /healthz returning {ok:true}; V-195 /version exposes version + git_sha + started_at + node_version + driver (+playwright_browser when driverName=playwright)', () => {
    expect(body).toMatch(/app\.get\('\/health', \(\) => \(\{ ok: true \}\)\);/);
    expect(body).toMatch(/app\.get\('\/healthz', \(\) => \(\{ ok: true \}\)\);/);
    expect(body).toMatch(
      /\/\/ V-195 — public version endpoint for ops tooling\. Reports server\s*\n?\s*\/\/ version \(from the deploy-owned APP_VERSION or npm in development\),\s*\n?\s*\/\/ git sha \(from GIT_SHA env at deploy time, "unknown" otherwise\), and\s*\n?\s*\/\/ process start time\./,
    );
    expect(body).toMatch(
      /const buildVersion = process\.env\.APP_VERSION \?\? process\.env\.npm_package_version \?\? 'unknown';/,
    );
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
    // Hardening — the /ready catch logs the raw dependency error server-side
    // (reply.log.warn) but the PUBLIC (no-auth) response is sanitized to
    // { name, ok:false, latency_ms } only; the raw err.message is NOT echoed
    // (a dependency connection error can carry internal host:port — CWE-200).
    expect(body).toMatch(/reply\.log\.warn\(/);
    expect(body).toMatch(/'readiness check failed'/);
    expect(body).toMatch(
      /return \{ name: c\.name, ok: false, latency_ms: Date\.now\(\) - start \};/,
    );
    // Regression guard: the failure-path response must NOT echo the raw error.
    expect(body).not.toMatch(/latency_ms: Date\.now\(\) - start,\s*\n?\s*error:/);
  });

  it('/v1/whoami: requireAuth + rateLimit(global); returns account_id (acc_ prefix) + api_key_id (key_ prefix) + tier + scopes; unreachable account-missing branch throws', () => {
    expect(body).toMatch(
      /app\.get\('\/v1\/whoami', \{ preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \}, \(request\) => \{/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*account_id: `acc_\$\{ctx\.account\.id\}`,\s*\n?\s*api_key_id: `key_\$\{ctx\.apiKey\.id\}`,\s*\n?\s*tier: ctx\.account\.tier,\s*\n?\s*scopes: ctx\.apiKey\.scopes,\s*\n?\s*\};/,
    );
  });

  it('egress-safeguard boot warning truthfully disables direct create and points to saved-proxy agent sessions', () => {
    expect(body).toMatch(
      /const egressProxyRequired = deps\.sessionProxyRequired \?\? deps\.sessionEgressService !== undefined;/,
    );
    expect(body).toMatch(/if \(egressProxyRequired\) \{\s*\n?\s*app\.log\.warn\(/);
    expect(body).toMatch(/Direct session creation is DISABLED/);
    expect(body).toMatch(/POST \/v1\/sessions and POST \/v1\/profiles\/:id\/launch/);
    expect(body).toMatch(/POST \/v1\/agent-sessions with an owned saved proxy_id/);
    expect(body).toMatch(/do not send a.*raw proxy field/s);
    // the route registration consumes the shared const (not a re-computed inline)
    expect(body).toMatch(/registerSessionRoutes\(app, \{[\s\S]{0,160}?egressProxyRequired,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
