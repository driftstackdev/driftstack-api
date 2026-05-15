// W1016 — routes/_webhook-raw-body V-666 cross-source invariant.
// Three-hundred-forty-second in the drift-guard series. Pins the
// apps/server/src/routes/_webhook-raw-body.ts shared raw-body parser:
//
//   V-666 anchor — 'V-666 — shared raw-body content-type parser for
//   webhook routes'.
//
//   Multi-route framing — 'Multiple webhook routes (Stripe +
//   NowPayments + future) need access to the raw request body for
//   signature verification. Fastify only allows ONE content-type
//   parser per content-type, so all webhook routes share a single
//   parser that opts into raw-body stashing for a known set of URLs'.
//
//   Idempotency framing — 'Registration is idempotent: each route
//   calls registerWebhookRawBodyParser(app) and only the first call
//   actually registers the parser. A WeakSet keyed on the
//   FastifyInstance tracks the registration state'.
//
//   MAX_BODY_BYTES = 1_048_576 (1 MiB).
//
//   RAW_BODY_URLS ReadonlySet — 2 entries: '/v1/webhooks/stripe' +
//     '/v1/webhooks/nowpayments'.
//
//   REGISTERED = WeakSet<FastifyInstance>().
//
//   addContentTypeParser bound to 'application/json' with parseAs:
//     'string' + bodyLimit MAX_BODY_BYTES.
//
//   Allowlisted URLs: stash text in req.rawBody, then JSON.parse +
//     empty-body-as-{} fallback.
//
//   Non-allowlisted: standard parse without raw stash.
//
//   FastifyRequest.rawBody type augmentation — 'rawBody?: string'.
//
// stays in lockstep across apps/server/src/routes/_webhook-raw-body.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1016 routes/_webhook-raw-body V-666 cross-source invariant', () => {
  it("CRITICAL V-666 anchor — 'V-666 — shared raw-body content-type parser for webhook routes'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/V-666 — shared raw-body content-type parser for webhook routes\./);
  });

  it("CRITICAL multi-route framing — 'Multiple webhook routes (Stripe + NowPayments + future) need access to the raw request body for signature verification. Fastify only allows ONE content-type parser per content-type, so all webhook routes share a single parser that opts into raw-body stashing for a known set of URLs'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/Multiple webhook routes \(Stripe \+ NowPayments \+ future\) need access/);
    expect(p).toMatch(/to the raw request body for signature verification\. Fastify only/);
    expect(p).toMatch(/allows ONE content-type parser per content-type, so all webhook/);
    expect(p).toMatch(/routes share a single parser that opts into raw-body stashing for a/);
    expect(p).toMatch(/known set of URLs\./);
  });

  it("CRITICAL idempotency framing + WeakSet — 'Registration is idempotent: each route calls registerWebhookRawBodyParser(app) and only the first call actually registers the parser. A WeakSet keyed on the FastifyInstance tracks the registration state'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/Registration is idempotent: each route calls/);
    expect(p).toMatch(/`registerWebhookRawBodyParser\(app\)` and only the first call actually/);
    expect(p).toMatch(/registers the parser\. A WeakSet keyed on the FastifyInstance tracks/);
    expect(p).toMatch(/the registration state\./);
    expect(p).toMatch(/const REGISTERED = new WeakSet<FastifyInstance>\(\);/);
    expect(p).toMatch(/if \(REGISTERED\.has\(app\)\) return;/);
    expect(p).toMatch(/REGISTERED\.add\(app\);/);
  });

  it('CRITICAL MAX_BODY_BYTES = 1_048_576 (1 MiB).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/const MAX_BODY_BYTES = 1_048_576; \/\/ 1 MiB/);
  });

  it("CRITICAL RAW_BODY_URLS ReadonlySet — 2 entries '/v1/webhooks/stripe' + '/v1/webhooks/nowpayments'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/const RAW_BODY_URLS: ReadonlySet<string> = new Set\(\[/);
    expect(p).toMatch(/'\/v1\/webhooks\/stripe',/);
    expect(p).toMatch(/'\/v1\/webhooks\/nowpayments',/);
  });

  it("CRITICAL addContentTypeParser 'application/json' + parseAs:'string' + bodyLimit MAX_BODY_BYTES.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/app\.addContentTypeParser\(/);
    expect(p).toMatch(/'application\/json',/);
    expect(p).toMatch(/\{ parseAs: 'string', bodyLimit: MAX_BODY_BYTES \},/);
  });

  it('CRITICAL allowlisted branch stashes req.rawBody = text + JSON.parse(text) with empty-as-{} fallback.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/const url = req\.routeOptions\.url \?\? '';/);
    expect(p).toMatch(/if \(RAW_BODY_URLS\.has\(url\)\) \{/);
    expect(p).toMatch(/const text = typeof body === 'string' \? body : '';/);
    expect(p).toMatch(/req\.rawBody = text;/);
    expect(p).toMatch(/const parsed: unknown = text\.length === 0 \? \{\} : JSON\.parse\(text\);/);
  });

  it("CRITICAL non-allowlisted branch — 'Non-webhook routes: standard parse, no raw stash'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/\/\/ Non-webhook routes: standard parse, no raw stash\./);
    expect(p).toMatch(
      /const parsed: unknown = typeof body === 'string' && body\.length > 0 \? JSON\.parse\(body\) : \{\};/,
    );
  });

  it("CRITICAL FastifyRequest.rawBody type augmentation — 'rawBody?: string'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts'));
    expect(p).toMatch(/declare module 'fastify' \{/);
    expect(p).toMatch(/interface FastifyRequest \{/);
    expect(p).toMatch(/rawBody\?: string;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-webhook-raw-body-v666-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
