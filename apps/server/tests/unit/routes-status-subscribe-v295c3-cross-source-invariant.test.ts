// W1020 — routes/status-subscribe V-295c3 cross-source invariant.
// Three-hundred-forty-sixth in the drift-guard series. Pins the apps/
// server/src/routes/status-subscribe.ts public status-page email-
// subscription routes:
//
//   V-295c3 anchor — 'V-295c3 — public status-page email subscription
//   routes'.
//
//   3-endpoint inventory:
//     - POST /v1/status/subscribe — start double-opt-in.
//     - GET /v1/status/subscribe/confirm?token= — finish opt-in.
//     - GET /v1/status/subscribe/unsubscribe?token= — one-click
//       unsubscribe.
//
//   Unauth framing — 'All three routes are unauthenticated by design
//   (the status site is public; visitors don't have Driftstack
//   accounts). IP rate-limited via statusSubscribe config (3/min by
//   default)'.
//
//   subscribeGate = ipRateLimit(rateLimitStore, {bucketPrefix:'ip:
//     status-subscribe', ...AUTH_IP_LIMITS.statusSubscribe}).
//
//   SubscribeBodySchema — z.object({email: z.string().trim().email(
//     'Must be a valid email address.')}).
//
//   TokenQuerySchema — z.object({token: z.string().min(20, 'Missing
//     or malformed token.')}).
//
//   subscribe path returns 202 + 'Confirmation email sent. Click the
//     link to finish subscribing.' message.
//
//   confirm path returns 200 + 'Subscription confirmed. You will
//     receive incident notifications by email.' message.
//
//   unsubscribe path returns 200 + 'Unsubscribed.' message.
//
//   All 3 routes use ValidationError + flatten() on Zod fail.
//
// stays in lockstep across apps/server/src/routes/status-subscribe.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1020 routes/status-subscribe V-295c3 cross-source invariant', () => {
  it("CRITICAL V-295c3 anchor — 'V-295c3 — public status-page email subscription routes'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/V-295c3 — public status-page email subscription routes\./);
  });

  it("CRITICAL 3-endpoint inventory — 'POST /v1/status/subscribe — start double-opt-in + GET /v1/status/subscribe/confirm?token= — finish opt-in + GET /v1/status/subscribe/unsubscribe?token= — one-click unsubscribe'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/POST \/v1\/status\/subscribe\s+— start double-opt-in/);
    expect(p).toMatch(/GET\s+\/v1\/status\/subscribe\/confirm\?token=\s+— finish opt-in/);
    expect(p).toMatch(/GET\s+\/v1\/status\/subscribe\/unsubscribe\?token=— one-click unsubscribe/);
  });

  it("CRITICAL unauth framing — 'All three routes are unauthenticated by design (the status site is public; visitors don't have Driftstack accounts). IP rate-limited via statusSubscribe config (3/min by default)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/\/\/ All three routes are unauthenticated by design \(the status site is/);
    expect(p).toMatch(/\/\/ public; visitors don't have Driftstack accounts\)\. IP rate-limited/);
    expect(p).toMatch(/\/\/ via `statusSubscribe` config \(3\/min by default\)\./);
  });

  it("CRITICAL subscribeGate from ipRateLimit(rateLimitStore, {bucketPrefix:'ip:status-subscribe', ...AUTH_IP_LIMITS.statusSubscribe}).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/const subscribeGate = ipRateLimit\(rateLimitStore, \{/);
    expect(p).toMatch(/bucketPrefix: 'ip:status-subscribe',/);
    expect(p).toMatch(/\.\.\.AUTH_IP_LIMITS\.statusSubscribe,/);
  });

  it("CRITICAL SubscribeBodySchema — z.object({email: z.string().trim().email('Must be a valid email address.')}).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/const SubscribeBodySchema = z\.object\(\{/);
    expect(p).toMatch(
      /email: z\.string\(\)\.trim\(\)\.email\('Must be a valid email address\.'\),/,
    );
  });

  it("CRITICAL TokenQuerySchema — z.object({token: z.string().min(20, 'Missing or malformed token.')}).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/const TokenQuerySchema = z\.object\(\{/);
    expect(p).toMatch(/token: z\.string\(\)\.min\(20, 'Missing or malformed token\.'\),/);
  });

  it("CRITICAL subscribe returns 202 + 'Confirmation email sent. Click the link to finish subscribing.'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/app\.post\('\/v1\/status\/subscribe', \{ preHandler: \[subscribeGate\] \}/);
    expect(p).toMatch(/await service\.subscribe\(parsed\.data\.email, new Date\(\)\);/);
    expect(p).toMatch(/return reply\.code\(202\)\.send\(\{/);
    expect(p).toMatch(
      /message: 'Confirmation email sent\. Click the link to finish subscribing\.',/,
    );
  });

  it("CRITICAL confirm returns 200 + 'Subscription confirmed. You will receive incident notifications by email.'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/'\/v1\/status\/subscribe\/confirm',/);
    expect(p).toMatch(/await service\.confirm\(parsed\.data\.token, new Date\(\)\);/);
    expect(p).toMatch(
      /message: 'Subscription confirmed\. You will receive incident notifications by email\.',/,
    );
  });

  it("CRITICAL unsubscribe returns 200 + 'Unsubscribed.' + service.unsubscribe call.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    expect(p).toMatch(/'\/v1\/status\/subscribe\/unsubscribe',/);
    expect(p).toMatch(/await service\.unsubscribe\(parsed\.data\.token, new Date\(\)\);/);
    expect(p).toMatch(/return reply\.code\(200\)\.send\(\{ message: 'Unsubscribed\.' \}\);/);
  });

  it('CRITICAL all 3 routes use ValidationError + flatten() on Zod-parse-fail.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts'));
    const errors = p.match(/throw new ValidationError\(parsed\.error\.flatten\(\)\);/g) ?? [];
    expect(errors.length).toBe(3);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-status-subscribe-v295c3-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
