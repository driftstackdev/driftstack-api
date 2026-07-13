// W391.B — drift guard for apps/server/src/lib/sentry.ts.
// V-494 secret-scrubbing for Sentry events. The denylist here MUST
// stay in sync with `lib/logger.ts::redact.paths` (mirror-or-leak
// posture). Sentry's envelope is more varied than pino's
// dot-path-only redact, so we use case-insensitive bare-key matching
// + recursive in-place scrub. Sentry is fire-and-forget; never on the
// request critical path.
//
//   • EU-region DSN framing (.de. enforced by zod, not here).
//   • Fire-and-forget framing pinned ("never on the request critical
//     path", "captureException returns a Promise<void> we don't await").
//   • V-494 SENTRY_SENSITIVE_KEYS Set: lowercase-only entries +
//     case-insensitive `key.toLowerCase()` comparison.
//   • scrubInPlace: depth-cap (8) + mutates in place + handles arrays.
//   • scrubSentryEvent: walks event.request / extra / contexts /
//     breadcrumbs.
//   • beforeSend + beforeBreadcrumb wired in Sentry.init.
//   • initSentry null-config branch: returns no-op client with
//     isInitialized=false (logs the "not configured" warn).
//   • SentryBreadcrumb 4-field interface + 5-literal level union.
//   • wireSentryErrorHandler: onError hook with request-context
//     extras (request_id / method / url / route).
//   • wireSentryRequestBreadcrumbs: per-request startedAt Symbol +
//     onRequest/onResponse hooks emitting http.request/http.response.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/sentry.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W391.B apps/server/src/lib/sentry.ts content parity', () => {
  const body = read(LIB);

  it('EU-region DSN framing pinned (DSN must contain `.de.` so SDK posts to ingest.de.sentry.io)', () => {
    expect(body).toMatch(
      /EU-region DSN enforced by Zod\s*\n?\s*\/\/\s*\(docs\/deployment\/env-vars\.md validation checklist\) — DSN must\s*\n?\s*\/\/\s*contain `\.de\.` so the SDK posts to ingest\.de\.sentry\.io rather than\s*\n?\s*\/\/\s*the US default/,
    );
  });

  it('Fire-and-forget framing: Sentry never on request critical path; captureException not awaited', () => {
    expect(body).toMatch(
      /Fire-and-forget: Sentry is never on the request critical path\.\s*\n?\s*\/\/\s*`captureException` returns a Promise<void> from the SDK; we don't\s*\n?\s*\/\/\s*await it\. If Sentry is down, errors are dropped/,
    );
  });

  it('V-494 SENTRY_SENSITIVE_KEYS: lowercase-only entries + case-insensitive lookup framing', () => {
    expect(body).toMatch(
      /V-494 — sensitive-key denylist for Sentry event scrubbing\. Keep in\s*\n?\s*\/\/\s*sync with `lib\/logger\.ts::redact\.paths`\. Match is case-insensitive\s*\n?\s*\/\/\s*on the bare key name \(no path prefix\); Sentry events have many\s*\n?\s*\/\/\s*envelope shapes \(request\.data, breadcrumbs\[\*\]\.data, extra,\s*\n?\s*\/\/\s*contexts\.\*\) so substring\/key matching is more robust than dot-paths/,
    );
    expect(body).toMatch(
      /All entries lowercase — comparison is `key\.toLowerCase\(\)` so storing\s*\n?\s*\/\/\s*non-lowercase variants here is dead weight \(and a bug if the comparison\s*\n?\s*\/\/\s*ever drifts\)/,
    );
    expect(body).toMatch(/const SENTRY_SENSITIVE_KEYS = new Set<string>\(\[/);
  });

  it('SENTRY_SENSITIVE_KEYS entries: auth headers + password trio + code/recovery + apikey + secrets cluster', () => {
    expect(body).toMatch(/'authorization',/);
    expect(body).toMatch(/'cookie',/);
    expect(body).toMatch(/'set-cookie',/);
    expect(body).toMatch(/'stripe-signature',/);
    expect(body).toMatch(/'password',/);
    expect(body).toMatch(/'new_password',/);
    expect(body).toMatch(/'current_password',/);
    expect(body).toMatch(/'code',/);
    expect(body).toMatch(/'recovery_code',/);
    expect(body).toMatch(/'recovery_codes',/);
    expect(body).toMatch(/'challenge_token',/);
    expect(body).toMatch(/'challengetoken',/);
    expect(body).toMatch(/'apikey',/);
    expect(body).toMatch(/'api_key',/);
    expect(body).toMatch(/'plaintext',/);
    expect(body).toMatch(/'secret',/);
    expect(body).toMatch(/'signing_secret',/);
    expect(body).toMatch(/'webhook_secret',/);
    expect(body).toMatch(/'totp_secret',/);
    expect(body).toMatch(/'mfasecret',/);
    expect(body).toMatch(/'client_secret',/);
  });

  it('isSensitiveKey: SENTRY_SENSITIVE_KEYS.has(key.toLowerCase())', () => {
    expect(body).toMatch(
      /function isSensitiveKey\(key: string\): boolean \{\s*\n?\s*return SENTRY_SENSITIVE_KEYS\.has\(key\.toLowerCase\(\)\);\s*\n?\s*\}/,
    );
  });

  it('scrubInPlace: depth-cap (8) + array branch + Object.keys walk + replaces sensitive value with "[redacted]"', () => {
    expect(body).toMatch(
      /V-494 — recursively walk a Sentry event-shaped value and replace\s*\n?\s*\*\s*sensitive field values with `'\[redacted\]'`\. Mutates in place to\s*\n?\s*\*\s*avoid allocating a parallel object tree on every event\. Over-depth\s*\n?\s*\*\s*and cyclic subtrees are replaced with a fixed sentinel/,
    );
    expect(body).toMatch(
      /if \(depth >= MAX_SENTRY_SCRUB_DEPTH \|\| seen\.has\(value\)\) return REDACTED_SENTRY_STRUCTURE/,
    );
    expect(body).toMatch(/if \(value === null \|\| typeof value !== 'object'\) return value;/);
    expect(body).toMatch(
      /if \(Array\.isArray\(value\)\) \{[\s\S]*value\[index\] = scrubValue\(value\[index\], depth \+ 1, seen\);[\s\S]*return value;/,
    );
    expect(body).toMatch(
      /if \(isSensitiveKey\(key\)\) \{\s*\n?\s*obj\[key\] = '\[redacted\]';\s*\n?\s*\} else \{\s*\n?\s*obj\[key\] = scrubValue\(obj\[key\], depth \+ 1, seen\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(/scrubValue\(value, 0, new WeakSet<object>\(\)\);/);
  });

  it('scrubSentryEvent: sanitizes request URL/query_string then walks event.request / extra / contexts / breadcrumbs', () => {
    expect(body).toMatch(
      /function scrubSentryEvent\(event: Sentry\.ErrorEvent\): Sentry\.ErrorEvent \{/,
    );
    // V-494 follow-up — url/query_string token scrub (discrete pins; the body
    // grew so the old single-chain regex no longer matches).
    expect(body).toMatch(/event\.request\.url = redactUrlQueryTokens\(event\.request\.url\);/);
    expect(body).toMatch(
      /event\.request\.query_string = redactQueryString\(event\.request\.query_string\);/,
    );
    expect(body).toMatch(/scrubInPlace\(event\.request\);/);
    expect(body).toMatch(/scrubInPlace\(event\.extra\);/);
    expect(body).toMatch(/scrubInPlace\(event\.contexts\);/);
    expect(body).toMatch(/scrubInPlace\(event\.breadcrumbs\);/);
    expect(body).toMatch(/redactUrlQueryTokens\(request\.url\)/);
  });

  it('__test_scrubInPlace export: surfaced for unit-test redaction matrix (not public surface)', () => {
    expect(body).toMatch(
      /V-494 — exposed under a `__test_\*` name so the unit test in\s*\n?\s*\/\/\s*tests\/unit\/sentry-scrub\.test\.ts can pin the redaction matrix\.\s*\n?\s*\/\/\s*Not part of the public sentry-helper surface/,
    );
    expect(body).toMatch(/export \{ scrubInPlace as __test_scrubInPlace \};/);
  });

  it('SentryBreadcrumb: 4-field interface (category / message / data? / level?) + 5-literal level union', () => {
    expect(body).toMatch(/export interface SentryBreadcrumb \{/);
    expect(body).toMatch(/category: string;/);
    expect(body).toMatch(/message: string;/);
    expect(body).toMatch(/data\?: Record<string, unknown>;/);
    expect(body).toMatch(/level\?: 'debug' \| 'info' \| 'warning' \| 'error' \| 'fatal';/);
  });

  it('SentryClient interface: captureException + addBreadcrumb + flush + close + readonly isInitialized', () => {
    expect(body).toMatch(/export interface SentryClient \{/);
    expect(body).toMatch(
      /captureException\(err: unknown, context\?: Record<string, unknown>\): void;/,
    );
    expect(body).toMatch(/addBreadcrumb\(crumb: SentryBreadcrumb\): void;/);
    expect(body).toMatch(/flush\(timeoutMs\?: number\): Promise<boolean>;/);
    expect(body).toMatch(/close\(timeoutMs\?: number\): Promise<boolean>;/);
    expect(body).toMatch(/readonly isInitialized: boolean;/);
  });

  it('initSentry null-config branch: warn-log + no-op client (isInitialized=false)', () => {
    expect(body).toMatch(
      /if \(config === null\) \{\s*\n?\s*logger\.warn\(\s*\n?\s*\{ component: 'sentry' \},\s*\n?\s*'Sentry not configured — exception capture disabled\. Set SENTRY_DSN \+ SENTRY_ENVIRONMENT to enable\.',\s*\n?\s*\);/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*isInitialized: false,\s*\n?\s*captureException: \(\) => \{\},\s*\n?\s*addBreadcrumb: \(\) => \{\},\s*\n?\s*flush: \(\) => Promise\.resolve\(true\),\s*\n?\s*close: \(\) => Promise\.resolve\(true\),\s*\n?\s*\};/,
    );
  });

  it('Sentry.init: dsn + environment + tracesSampleRate + beforeSend=scrubSentryEvent + beforeBreadcrumb=scrubSentryBreadcrumb', () => {
    expect(body).toMatch(
      /Sentry\.init\(\{\s*\n?\s*dsn: config\.dsn,\s*\n?\s*environment: config\.environment,/,
    );
    expect(body).toMatch(/tracesSampleRate: config\.tracesSampleRate,/);
    expect(body).toMatch(/beforeSend: scrubSentryEvent,/);
    expect(body).toMatch(/beforeBreadcrumb: scrubSentryBreadcrumb,/);
  });

  it('flush + close: default 2000ms timeout', () => {
    expect(body).toMatch(/flush: \(timeoutMs = 2000\) => Sentry\.flush\(timeoutMs\),/);
    expect(body).toMatch(/close: \(timeoutMs = 2000\) => Sentry\.close\(timeoutMs\),/);
  });

  it('wireSentryErrorHandler: onError hook with request_id / method / url / route extras', () => {
    expect(body).toMatch(
      /export function wireSentryErrorHandler\(app: FastifyInstance, sentry: SentryClient\): void \{\s*\n?\s*app\.addHook\('onError', \(request, _reply, error, done\) => \{\s*\n?\s*sentry\.captureException\(error, \{\s*\n?\s*request_id: request\.id,\s*\n?\s*method: request\.method,\s*\n?\s*url: redactUrlQueryTokens\(request\.url\),\s*\n?\s*route: request\.routeOptions\?\.url,\s*\n?\s*\}\);/,
    );
  });

  it('wireSentryRequestBreadcrumbs: Symbol startedAt + http.request onRequest + http.response onResponse', () => {
    expect(body).toMatch(/const startedAtKey = Symbol\('sentryRequestStart'\);/);
    expect(body).toMatch(/category: 'http\.request',/);
    expect(body).toMatch(/category: 'http\.response',/);
    expect(body).toMatch(
      /level: reply\.statusCode >= 500 \? 'error' : reply\.statusCode >= 400 \? 'warning' : 'info',/,
    );
  });

  it('imports: @sentry/node (* as Sentry) + FastifyInstance + SentryConfig + Logger', () => {
    expect(body).toMatch(/import \* as Sentry from '@sentry\/node';/);
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import type \{ SentryConfig \} from '\.\/config\.js';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\/logger\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
