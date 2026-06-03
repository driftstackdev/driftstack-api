// W410.C — drift guard for apps/server/src/routes/_webhook-raw-body.ts.
// V-666 shared raw-body content-type parser for webhook routes.
// Stripe + NowPayments + future webhook routes need raw body for
// signature verification. Fastify only allows ONE content-type parser
// per content-type → all webhook routes share one parser keyed on URL.
// Drift here either breaks signature verification (raw body missing
// for legitimate webhook) or leaks the parser to non-webhook routes
// (memory/perf for normal JSON requests).
//
//   • V-666 framing pinned: shared raw-body parser; one parser per
//     content-type Fastify limitation; opt-in via URL allowlist.
//   • Idempotent registration: each route calls register; only first
//     call wires the parser; WeakSet<FastifyInstance> tracks state.
//   • MAX_BODY_BYTES = 1 MiB (1_048_576).
//   • RAW_BODY_URLS allowlist: ['/v1/webhooks/stripe',
//     '/v1/webhooks/nowpayments']; ReadonlySet (immutable).
//   • Raw-body path: stash text on req.rawBody, parse JSON ({} on empty),
//     done(null, parsed) — both raw + parsed available downstream.
//   • Non-webhook fall-through: standard JSON.parse, no raw stash.
//   • FastifyRequest.rawBody?: string declaration via module
//     augmentation (declare module 'fastify').

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

describe('W410.C apps/server/src/routes/_webhook-raw-body.ts content parity', () => {
  const body = read(LIB);

  it('V-666 framing pinned: shared raw-body parser; Fastify ONE-parser-per-content-type rule; URL allowlist opt-in', () => {
    expect(body).toMatch(/V-666 — shared raw-body content-type parser for webhook routes\./);
    expect(body).toMatch(
      /Multiple webhook routes \(Stripe \+ NowPayments \+ future\) need access\s*\n?\s*\/\/\s*to the raw request body for signature verification\. Fastify only\s*\n?\s*\/\/\s*allows ONE content-type parser per content-type, so all webhook\s*\n?\s*\/\/\s*routes share a single parser that opts into raw-body stashing for a\s*\n?\s*\/\/\s*known set of URLs\./,
    );
  });

  it('Idempotent registration framing pinned: WeakSet<FastifyInstance> tracks state; first call wires parser', () => {
    expect(body).toMatch(
      /Registration is idempotent: each route calls\s*\n?\s*\/\/\s*`registerWebhookRawBodyParser\(app\)` and only the first call actually\s*\n?\s*\/\/\s*registers the parser\. A WeakSet keyed on the FastifyInstance tracks\s*\n?\s*\/\/\s*the registration state\./,
    );
    expect(body).toMatch(/const REGISTERED = new WeakSet<FastifyInstance>\(\);/);
  });

  it('Module augmentation: FastifyRequest.rawBody?: string (declare module fastify)', () => {
    expect(body).toMatch(
      /declare module 'fastify' \{\s*\n?\s*interface FastifyRequest \{\s*\n?\s*rawBody\?: string;\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('MAX_BODY_BYTES = 1_048_576 (1 MiB)', () => {
    expect(body).toMatch(/const MAX_BODY_BYTES = 1_048_576;\s*\/\/\s*1 MiB/);
  });

  it("RAW_BODY_URLS allowlist: ReadonlySet of ['/v1/webhooks/stripe', '/v1/webhooks/nowpayments']", () => {
    expect(body).toMatch(
      /const RAW_BODY_URLS: ReadonlySet<string> = new Set\(\[\s*\n?\s*'\/v1\/webhooks\/stripe',\s*\n?\s*'\/v1\/webhooks\/nowpayments',\s*\n?\s*\]\);/,
    );
  });

  it('register function: early-return if already registered; addContentTypeParser application/json with parseAs string + bodyLimit MAX_BODY_BYTES', () => {
    expect(body).toMatch(
      /export function registerWebhookRawBodyParser\(app: FastifyInstance\): void \{\s*\n?\s*if \(REGISTERED\.has\(app\)\) return;\s*\n?\s*REGISTERED\.add\(app\);/,
    );
    expect(body).toMatch(
      /app\.addContentTypeParser\(\s*\n?\s*'application\/json',\s*\n?\s*\{ parseAs: 'string', bodyLimit: MAX_BODY_BYTES \},/,
    );
  });

  it('Raw-body path: req.routeOptions.url match → stash req.rawBody + JSON.parse (empty→{})', () => {
    expect(body).toMatch(/const url = req\.routeOptions\.url \?\? '';/);
    expect(body).toMatch(/if \(RAW_BODY_URLS\.has\(url\)\) \{/);
    expect(body).toMatch(/const text = typeof body === 'string' \? body : '';/);
    expect(body).toMatch(/req\.rawBody = text;/);
    expect(body).toMatch(
      /const parsed: unknown = text\.length === 0 \? \{\} : JSON\.parse\(text\);\s*\n?\s*done\(null, parsed\);/,
    );
  });

  it('Non-webhook fall-through: standard JSON.parse, no raw stash; empty body → {}', () => {
    expect(body).toMatch(/\/\/ Non-webhook routes: standard parse, no raw stash\./);
    expect(body).toMatch(
      /const parsed: unknown = typeof body === 'string' && body\.length > 0 \? JSON\.parse\(body\) : \{\};\s*\n?\s*done\(null, parsed\);/,
    );
  });

  it('Error path: malformed JSON → done(invalidJsonBody(), undefined) — a 400 client error, not a 500', () => {
    expect(body).toMatch(/\} catch \{\s*\n?\s*done\(invalidJsonBody\(\), undefined\);/);
    expect(body).toMatch(/e\.statusCode = 400;/);
  });

  it('imports: FastifyInstance + FastifyRequest types from fastify', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
