// W461.B — drift guard for apps/server/src/routes/_webhook-raw-body.ts.
// V-666 shared raw-body content-type parser. Drift here either
// drops the URL-allowlist guard (raw body gets stashed on EVERY
// JSON request, leaking memory + slowing every non-webhook
// endpoint) or breaks the idempotent registration (re-registering
// the parser throws FST_ERR_CTP_ALREADY_PRESENT on subsequent
// calls and the app fails to boot).
//
//   • V-666 framing pinned: 'shared raw-body content-type parser
//     for webhook routes' + 'Multiple webhook routes (Stripe +
//     NowPayments + future) need access to the raw request body
//     for signature verification.'
//   • Single-parser-per-content-type framing pinned: 'Fastify only
//     allows ONE content-type parser per content-type, so all
//     webhook routes share a single parser that opts into raw-body
//     stashing for a known set of URLs.'
//   • Idempotent-registration framing pinned: 'each route calls
//     registerWebhookRawBodyParser(app) and only the first call
//     actually registers the parser. A WeakSet keyed on the
//     FastifyInstance tracks the registration state.'
//   • FastifyRequest module augmentation: rawBody?: string.
//   • MAX_BODY_BYTES = 1_048_576 (1 MiB).
//   • RAW_BODY_URLS allowlist: /v1/webhooks/stripe +
//     /v1/webhooks/nowpayments.
//   • REGISTERED = new WeakSet<FastifyInstance>() idempotency guard.
//   • registerWebhookRawBodyParser: early-return if REGISTERED.has;
//     addContentTypeParser('application/json', {parseAs:'string',
//     bodyLimit: MAX_BODY_BYTES}); URL-allowlist branch sets
//     req.rawBody = text + JSON.parse OR empty-string→{} fallback;
//     non-webhook branch parses without stashing.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/_webhook-raw-body.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W461.B apps/server/src/routes/_webhook-raw-body.ts content parity', () => {
  const body = read(LIB);

  it("V-666 framing pinned: 'V-666 — shared raw-body content-type parser for webhook routes.' + 'Multiple webhook routes (Stripe + NowPayments + future) need access to the raw request body for signature verification.'", () => {
    expect(body).toMatch(/\/\/ V-666 — shared raw-body content-type parser for webhook routes\./);
    expect(body).toMatch(
      /\/\/ Multiple webhook routes \(Stripe \+ NowPayments \+ future\) need access\s*\/\/ to the raw request body for signature verification\./,
    );
  });

  it("Single-parser-per-content-type framing pinned: 'Fastify only allows ONE content-type parser per content-type, so all webhook routes share a single parser that opts into raw-body stashing for a known set of URLs.'", () => {
    expect(body).toMatch(
      /Fastify only\s*\/\/ allows ONE content-type parser per content-type, so all webhook\s*\/\/ routes share a single parser that opts into raw-body stashing for a\s*\/\/ known set of URLs\./,
    );
  });

  it("Idempotent-registration framing pinned: 'Registration is idempotent: each route calls registerWebhookRawBodyParser(app) and only the first call actually registers the parser. A WeakSet keyed on the FastifyInstance tracks the registration state.'", () => {
    expect(body).toMatch(
      /\/\/ Registration is idempotent: each route calls\s*\/\/ `registerWebhookRawBodyParser\(app\)` and only the first call actually\s*\/\/ registers the parser\. A WeakSet keyed on the FastifyInstance tracks\s*\/\/ the registration state\./,
    );
  });

  it("FastifyRequest module augmentation: declare module 'fastify' { interface FastifyRequest { rawBody?: string; } }", () => {
    expect(body).toMatch(
      /declare module 'fastify' \{\s*interface FastifyRequest \{\s*rawBody\?: string;\s*\}\s*\}/,
    );
  });

  it('Constants: MAX_BODY_BYTES = 1_048_576 (1 MiB) + RAW_BODY_URLS allowlist (/v1/webhooks/stripe + /v1/webhooks/nowpayments) + REGISTERED = new WeakSet<FastifyInstance>()', () => {
    expect(body).toMatch(/const MAX_BODY_BYTES = 1_048_576; \/\/ 1 MiB/);
    expect(body).toMatch(
      /const RAW_BODY_URLS: ReadonlySet<string> = new Set\(\[\s*'\/v1\/webhooks\/stripe',\s*'\/v1\/webhooks\/nowpayments',\s*\]\);/,
    );
    expect(body).toMatch(/const REGISTERED = new WeakSet<FastifyInstance>\(\);/);
  });

  it("registerWebhookRawBodyParser: early-return guard if REGISTERED.has(app); REGISTERED.add(app); app.addContentTypeParser('application/json', {parseAs:'string', bodyLimit:MAX_BODY_BYTES})", () => {
    expect(body).toMatch(
      /export function registerWebhookRawBodyParser\(app: FastifyInstance\): void \{\s*if \(REGISTERED\.has\(app\)\) return;\s*REGISTERED\.add\(app\);\s*app\.addContentTypeParser\(\s*'application\/json',\s*\{ parseAs: 'string', bodyLimit: MAX_BODY_BYTES \},/,
    );
  });

  it("URL-allowlist branch: req.routeOptions.url ?? '' lookup; RAW_BODY_URLS.has(url) → req.rawBody = text + JSON.parse OR empty-string→{} fallback + done(null, parsed); malformed JSON → done(invalidJsonBody(), undefined) (400, not 500)", () => {
    expect(body).toMatch(
      /\(req: FastifyRequest, body, done\) => \{\s*const url = req\.routeOptions\.url \?\? '';\s*if \(RAW_BODY_URLS\.has\(url\)\) \{\s*const text = typeof body === 'string' \? body : '';\s*req\.rawBody = text;\s*try \{\s*const parsed: unknown = text\.length === 0 \? \{\} : JSON\.parse\(text\);\s*done\(null, parsed\);\s*\} catch \{\s*done\(invalidJsonBody\(\), undefined\);\s*\}\s*return;\s*\}/,
    );
  });

  it("Non-webhook branch framing pinned: 'Non-webhook routes: standard parse, no raw stash.' + standard JSON.parse + empty-string→{} fallback + matching catch → done(invalidJsonBody(), undefined) (400)", () => {
    expect(body).toMatch(
      /\/\/ Non-webhook routes: standard parse, no raw stash\.\s*try \{\s*const parsed: unknown = typeof body === 'string' && body\.length > 0 \? JSON\.parse\(body\) : \{\};\s*done\(null, parsed\);\s*\} catch \{\s*done\(invalidJsonBody\(\), undefined\);\s*\}/,
    );
  });

  it('malformed JSON is a 400 client error, not 500: invalidJsonBody() sets statusCode 400 + a generic non-echoing message', () => {
    expect(body).toMatch(
      /function invalidJsonBody\(\): Error & \{ statusCode: number \} \{\s*const e = new Error\('Invalid JSON in request body\.'\) as Error & \{ statusCode: number \};\s*e\.statusCode = 400;\s*return e;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
