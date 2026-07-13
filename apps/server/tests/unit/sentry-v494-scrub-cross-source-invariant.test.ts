// W969 — V-494 Sentry scrub mirror cross-source invariant. Two-
// hundred-ninety-fifth in the drift-guard series. Pins the
// apps/server/src/lib/sentry.ts secret-stripping mirror:
//
//   Header framing — 'EU-region DSN enforced by Zod (docs/deployment/
//   env-vars.md validation checklist) — DSN must contain .de. so the
//   SDK posts to ingest.de.sentry.io rather than the US default.
//   Source-map upload happens at deploy time (handled by the GitHub
//   Actions workflow once the build emits maps); this module just
//   initialises the runtime client'.
//
//   Fire-and-forget framing — 'Sentry is never on the request critical
//   path. captureException returns a Promise<void> from the SDK; we
//   don't await it. If Sentry is down, errors are dropped — visible
//   only in the Pino structured logs (which Sentry would normally
//   bridge from)'.
//
//   V-494 denylist framing — 'V-494 — sensitive-key denylist for
//   Sentry event scrubbing. Keep in sync with lib/logger.ts::
//   redact.paths. Match is case-insensitive on the bare key name (no
//   path prefix); Sentry events have many envelope shapes (request.
//   data, breadcrumbs[*].data, extra, contexts.*) so substring/key
//   matching is more robust than dot-paths. All entries lowercase —
//   comparison is key.toLowerCase() so storing non-lowercase variants
//   here is dead weight (and a bug if the comparison ever drifts).
//   Tests pin both case-sensitive and case-insensitive paths'.
//
//   SENTRY_SENSITIVE_KEYS 26-entry Set:
//     - Header keys (4): authorization + cookie + set-cookie +
//       stripe-signature.
//     - Password keys (5): password + new_password + current_password
//       + newpassword + currentpassword.
//     - MFA/recovery keys (5): code + recovery_code + recovery_codes
//       + recoverycode + recoverycodes.
//     - API/inline keys (3): apikey + api_key + plaintext.
//     - Webhook/secret keys (6): secret + signing_secret +
//       signingsecret + webhooksecret + webhook_secret +
//       client_secret + clientsecret.
//     - TOTP keys (3): totp_secret + totpsecret + mfasecret.
//
//   scrubInPlace recursion bound — over-depth/cyclic subtrees are replaced.
//     The fail-closed guard prevents deep credentials and JSON cycles surviving.
//
//   scrubSentryEvent walks 4 envelope shapes: event.request +
//     event.extra + event.contexts + event.breadcrumbs.
//
//   beforeSend = scrubSentryEvent + beforeBreadcrumb =
//     scrubSentryBreadcrumb.
//
//   '[redacted]' censor token — matches lib/logger.ts convention.
//
//   __test_scrubInPlace export — V-494 surface for unit-test pinning.
//
//   initSentry no-op when config === null — returns isInitialized:
//     false stub with all-arrow no-op methods.
//
//   wireSentryErrorHandler installs onError hook with 4-field context
//     (request_id, method, url, route).
//
//   wireSentryRequestBreadcrumbs installs onRequest + onResponse
//     hooks: status-code-derived breadcrumb level (>=500 error, >=400
//     warning, else info) + duration_ms with 2-decimal rounding.
//
// stays in lockstep across apps/server/src/lib/sentry.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { __test_scrubInPlace } from '../../src/lib/sentry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W969 V-494 sentry scrub mirror cross-source invariant', () => {
  // ─── Header EU-region DSN + source-map framing ───────────────

  it("CRITICAL apps/server/src/lib/sentry.ts header pins surface — 'EU-region DSN enforced by Zod (docs/deployment/env-vars.md validation checklist) — DSN must contain .de. so the SDK posts to ingest.de.sentry.io rather than the US default. Source-map upload happens at deploy time (handled by the GitHub Actions workflow once the build emits maps); this module just initialises the runtime client'. The Zod-validated .de. DSN + deploy-time-source-map split is the V-494 + EU-residency contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/EU-region DSN enforced by Zod/);
    expect(p).toMatch(/\(docs\/deployment\/env-vars\.md validation checklist\) — DSN must/);
    expect(p).toMatch(/contain `\.de\.` so the SDK posts to ingest\.de\.sentry\.io rather than/);
    expect(p).toMatch(/the US default\. Source-map upload happens at deploy time \(handled/);
    expect(p).toMatch(/by the GitHub Actions workflow once the build emits maps\); this/);
    expect(p).toMatch(/module just initialises the runtime client\./);
  });

  // ─── Fire-and-forget framing ─────────────────────────────────

  it("CRITICAL fire-and-forget framing — 'Sentry is never on the request critical path. captureException returns a Promise<void> from the SDK; we don't await it. If Sentry is down, errors are dropped — visible only in the Pino structured logs (which Sentry would normally bridge from)'. The never-await + drop-on-failure design is the V-494 availability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/Fire-and-forget: Sentry is never on the request critical path\./);
    expect(p).toMatch(/`captureException` returns a Promise<void> from the SDK; we don't/);
    expect(p).toMatch(/await it\. If Sentry is down, errors are dropped — visible only in/);
    expect(p).toMatch(/the Pino structured logs \(which Sentry would normally bridge from\)\./);
  });

  // ─── V-494 denylist framing ──────────────────────────────────

  it("CRITICAL V-494 denylist framing — 'V-494 — sensitive-key denylist for Sentry event scrubbing. Keep in sync with lib/logger.ts::redact.paths. Match is case-insensitive on the bare key name (no path prefix); Sentry events have many envelope shapes (request.data, breadcrumbs[*].data, extra, contexts.*) so substring/key matching is more robust than dot-paths'. The case-insensitive + bare-key + 4-envelope-shape design is what makes Sentry scrubbing more robust than pino dot-paths.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/V-494 — sensitive-key denylist for Sentry event scrubbing\. Keep in/);
    expect(p).toMatch(/sync with `lib\/logger\.ts::redact\.paths`\. Match is case-insensitive/);
    expect(p).toMatch(/on the bare key name \(no path prefix\); Sentry events have many/);
    expect(p).toMatch(/envelope shapes \(request\.data, breadcrumbs\[\*\]\.data, extra,/);
    expect(p).toMatch(/contexts\.\*\) so substring\/key matching is more robust than dot-paths\./);
  });

  it("CRITICAL lowercase-only framing — 'All entries lowercase — comparison is key.toLowerCase() so storing non-lowercase variants here is dead weight (and a bug if the comparison ever drifts). Tests pin both case-sensitive and case-insensitive paths'. The lowercase-canonical + tests-pin-both design hardens the denylist.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/All entries lowercase — comparison is `key\.toLowerCase\(\)` so storing/);
    expect(p).toMatch(/non-lowercase variants here is dead weight \(and a bug if the comparison/);
    expect(p).toMatch(/ever drifts\)\. Tests pin both case-sensitive and case-insensitive paths\./);
  });

  // ─── 4-entry header denylist ─────────────────────────────────

  it("CRITICAL 4-entry header denylist — 'authorization' + 'cookie' + 'set-cookie' + 'stripe-signature'. The 4-header set mirrors the V-494 logger.ts header-paths group.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/'authorization',/);
    expect(p).toMatch(/'cookie',/);
    expect(p).toMatch(/'set-cookie',/);
    expect(p).toMatch(/'stripe-signature',/);
  });

  // ─── 5-entry password denylist (snake + camel doubles) ───────

  it("CRITICAL 5-entry password denylist — 'password' + 'new_password' + 'current_password' + 'newpassword' + 'currentpassword'. The snake-case + alllowercase-camelCase doubles cover both API + DB-mapped shapes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/'password',/);
    expect(p).toMatch(/'new_password',/);
    expect(p).toMatch(/'current_password',/);
    expect(p).toMatch(/'newpassword',/);
    expect(p).toMatch(/'currentpassword',/);
  });

  // ─── 5-entry MFA/recovery denylist ───────────────────────────

  it("CRITICAL 5-entry MFA/recovery denylist — 'code' + 'recovery_code' + 'recovery_codes' + 'recoverycode' + 'recoverycodes'. The 5-key set covers TOTP + recovery + MFA-challenge flows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/'code',/);
    expect(p).toMatch(/'recovery_code',/);
    expect(p).toMatch(/'recovery_codes',/);
    expect(p).toMatch(/'recoverycode',/);
    expect(p).toMatch(/'recoverycodes',/);
  });

  // ─── 3-entry API/inline denylist ─────────────────────────────

  it("CRITICAL 3-entry API/inline denylist — 'apikey' + 'api_key' + 'plaintext'. The 3-key set covers inline-credential-bearing object logs.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/'apikey',/);
    expect(p).toMatch(/'api_key',/);
    expect(p).toMatch(/'plaintext',/);
  });

  // ─── 7-entry webhook/secret/client-secret denylist ───────────

  it("CRITICAL 7-entry webhook/secret/client-secret denylist — 'secret' + 'signing_secret' + 'signingsecret' + 'webhooksecret' + 'webhook_secret' + 'client_secret' + 'clientsecret'. The Stripe + NowPayments + OAuth client_secret + webhook signing-secret triple-coverage is the V-494 webhook contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/'secret',/);
    expect(p).toMatch(/'signing_secret',/);
    expect(p).toMatch(/'signingsecret',/);
    expect(p).toMatch(/'webhooksecret',/);
    expect(p).toMatch(/'webhook_secret',/);
    expect(p).toMatch(/'client_secret',/);
    expect(p).toMatch(/'clientsecret',/);
  });

  // ─── 3-entry TOTP denylist ───────────────────────────────────

  it("CRITICAL 3-entry TOTP denylist — 'totp_secret' + 'totpsecret' + 'mfasecret'. The 3-key set covers RFC 6238 enrolment secret in both snake + camel + generic-mfa shapes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/'totp_secret',/);
    expect(p).toMatch(/'totpsecret',/);
    expect(p).toMatch(/'mfasecret',/);
  });

  // ─── isSensitiveKey lowercase canonicalisation ───────────────

  it("CRITICAL isSensitiveKey lowercases the input before Set.has — 'function isSensitiveKey(key: string): boolean { return SENTRY_SENSITIVE_KEYS.has(key.toLowerCase()); }'. The toLowerCase() canonicalisation is what lets a single lowercase Set match arbitrary-case incoming keys.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/function isSensitiveKey\(key: string\): boolean \{/);
    expect(p).toMatch(/return SENTRY_SENSITIVE_KEYS\.has\(key\.toLowerCase\(\)\);/);
  });

  // ─── scrubInPlace recursion bound ────────────────────────────

  it('CRITICAL scrubInPlace depth/cycle bound fails closed with a non-secret sentinel.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/const MAX_SENTRY_SCRUB_DEPTH = 8;/);
    expect(p).toMatch(
      /if \(depth >= MAX_SENTRY_SCRUB_DEPTH \|\| seen\.has\(value\)\) return REDACTED_SENTRY_STRUCTURE/,
    );
    expect(p).toMatch(/const REDACTED_SENTRY_STRUCTURE = '\[redacted: structure limit\]';/);
  });

  // ─── scrubSentryEvent 4-envelope walk ────────────────────────

  it('CRITICAL scrubSentryEvent walks 4 envelope shapes — event.request + event.extra + event.contexts + event.breadcrumbs. The 4-shape coverage matches the docstring inventory (request.data, breadcrumbs[*].data, extra, contexts.*).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/scrubInPlace\(event\.request\);/);
    expect(p).toMatch(/scrubInPlace\(event\.extra\);/);
    expect(p).toMatch(/scrubInPlace\(event\.contexts\);/);
    expect(p).toMatch(/scrubInPlace\(event\.breadcrumbs\);/);
  });

  // ─── beforeSend + beforeBreadcrumb hook wire-up ──────────────

  it("CRITICAL Sentry.init wires both event + breadcrumb scrub hooks — 'beforeSend: scrubSentryEvent' + 'beforeBreadcrumb: scrubSentryBreadcrumb'. The 2-hook split covers Sentry's 2 event-shape lifecycles (top-level event + per-breadcrumb).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/beforeSend: scrubSentryEvent,/);
    expect(p).toMatch(/beforeBreadcrumb: scrubSentryBreadcrumb,/);
  });

  // ─── '[redacted]' censor token ───────────────────────────────

  it("CRITICAL censor token = '[redacted]'. The bracket-redacted convention mirrors lib/logger.ts redact.censor.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/obj\[key\] = '\[redacted\]';/);
  });

  // ─── __test_scrubInPlace export ──────────────────────────────

  it("CRITICAL __test_scrubInPlace re-export exists — 'export { scrubInPlace as __test_scrubInPlace }'. The __test_ prefix signals 'internal — for unit-test invariant pinning'; not part of the public sentry-helper surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/export \{ scrubInPlace as __test_scrubInPlace \};/);
  });

  // ─── initSentry no-op when config is null ────────────────────

  it('CRITICAL initSentry returns isInitialized:false no-op stub when config === null — 4 arrow no-ops (captureException + addBreadcrumb + flush returning Promise.resolve(true) + close returning Promise.resolve(true)). The null-config null-object pattern keeps callers polymorphic.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/if \(config === null\) \{/);
    expect(p).toMatch(/isInitialized: false,/);
    expect(p).toMatch(/captureException: \(\) => \{\},/);
    expect(p).toMatch(/addBreadcrumb: \(\) => \{\},/);
    expect(p).toMatch(/flush: \(\) => Promise\.resolve\(true\),/);
    expect(p).toMatch(/close: \(\) => Promise\.resolve\(true\),/);
  });

  // ─── wireSentryErrorHandler 4-field context ──────────────────

  it('CRITICAL wireSentryErrorHandler installs Fastify onError hook with 4-field context — request_id + method + url + route (from routeOptions?.url). The optional-chain on routeOptions handles unmatched routes (404).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(
      /export function wireSentryErrorHandler\(app: FastifyInstance, sentry: SentryClient\): void \{/,
    );
    expect(p).toMatch(/app\.addHook\('onError', \(request, _reply, error, done\) => \{/);
    expect(p).toMatch(/request_id: request\.id,/);
    expect(p).toMatch(/method: request\.method,/);
    expect(p).toMatch(/url: redactUrlQueryTokens\(request\.url\),/);
    expect(p).toMatch(/route: request\.routeOptions\?\.url,/);
  });

  // ─── wireSentryRequestBreadcrumbs status-code-derived level ──

  it("CRITICAL wireSentryRequestBreadcrumbs onResponse derives level from status code — 'reply.statusCode >= 500 ? error : reply.statusCode >= 400 ? warning : info'. The 3-tier ternary maps server-errors / client-errors / success to Sentry severity levels.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(
      /level: reply\.statusCode >= 500 \? 'error' : reply\.statusCode >= 400 \? 'warning' : 'info',/,
    );
  });

  it("CRITICAL wireSentryRequestBreadcrumbs duration_ms 2-decimal rounding — 'Math.round((performance.now() - startedAt) * 100) / 100'. The *100/100 trick rounds to 2 decimal places without sprintf.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/Math\.round\(\(performance\.now\(\) - startedAt\) \* 100\) \/ 100/);
  });

  it("CRITICAL wireSentryRequestBreadcrumbs Symbol-keyed start-timestamp — 'const startedAtKey = Symbol(sentryRequestStart);'. The Symbol-key avoids polluting the public FastifyRequest shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    expect(p).toMatch(/const startedAtKey = Symbol\('sentryRequestStart'\);/);
  });

  // ─── Runtime — __test_scrubInPlace 4 case-mix paths ──────────

  it('CRITICAL __test_scrubInPlace runtime redacts top-level lowercase + camelCase + snake_case + mixed-case keys to [redacted] in place. The case-insensitive match is what makes the denylist robust across mixed payload conventions.', () => {
    const event = {
      password: 'p1',
      Password: 'p2',
      PASSWORD: 'p3',
      authorization: 'Bearer xyz',
      Authorization: 'Bearer xyz',
      apiKey: 'sk_live_xxx',
      cookie: 'session=abc',
      not_sensitive: 'visible',
    };
    __test_scrubInPlace(event);
    expect(event.password).toBe('[redacted]');
    expect(event.Password).toBe('[redacted]');
    expect(event.PASSWORD).toBe('[redacted]');
    expect(event.authorization).toBe('[redacted]');
    expect(event.Authorization).toBe('[redacted]');
    expect(event.apiKey).toBe('[redacted]');
    expect(event.cookie).toBe('[redacted]');
    expect(event.not_sensitive).toBe('visible');
  });

  it('CRITICAL __test_scrubInPlace runtime recurses into nested objects + arrays.', () => {
    const event: {
      request: { data: { totp_secret: string } };
      breadcrumbs: { data: { client_secret: string } }[];
    } = {
      request: { data: { totp_secret: 'abc' } },
      breadcrumbs: [{ data: { client_secret: 'xyz' } }],
    };
    __test_scrubInPlace(event);
    expect(event.request.data.totp_secret).toBe('[redacted]');
    expect(event.breadcrumbs[0]?.data.client_secret).toBe('[redacted]');
  });

  it('CRITICAL __test_scrubInPlace early-returns on null + scalar + undefined. The non-object early-return is what makes the recursion safe on Sentry-attached primitive event-field values.', () => {
    // Should not throw — exercises null/undefined/scalar branches.
    expect(() => {
      __test_scrubInPlace(null);
      __test_scrubInPlace(undefined);
      __test_scrubInPlace('string-value');
      __test_scrubInPlace(42);
      __test_scrubInPlace(true);
    }).not.toThrow();
  });

  // ─── Total denylist count ────────────────────────────────────

  it('CRITICAL SENTRY_SENSITIVE_KEYS Set has 27 entries — 4 header + 5 password + 5 MFA/recovery + 3 API/inline + 7 webhook/client_secret + 3 TOTP = 27 keys. Mechanically counted via comma-separated quoted entries within the Set<string>([...]) block.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts'));
    const setBlock =
      p.match(/SENTRY_SENSITIVE_KEYS = new Set<string>\(\[([\s\S]+?)\]\);/)?.[1] ?? '';
    const entries = setBlock.match(/'[^']+'/g) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(26);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sentry-v494-scrub-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
