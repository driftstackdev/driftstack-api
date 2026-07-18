// W411.A — drift guard for apps/server/src/routes/status-subscribe.ts.
// V-295c3 public status-page email subscription routes. All three
// routes are unauthenticated by design (status site is public) and
// IP rate-limited via AUTH_IP_LIMITS.statusSubscribe (3/min default).
// Drift here either drops auth/rate-limit (subscribe-flooding vector)
// or breaks the 202/200 response codes the public status site polls.
//
//   • V-295c3 framing pinned: 3 routes (POST subscribe, GET confirm,
//     GET unsubscribe) — double-opt-in pattern.
//   • Auth posture pinned: unauthenticated by design (status site is
//     public; visitors don't have Driftstack accounts).
//   • Rate-limit posture pinned: IP rate-limited via
//     `statusSubscribe` config (3/min by default).
//   • SubscribeBodySchema: zod email trim + .email() validator with
//     "Must be a valid email address." copy.
//   • TokenQuerySchema: zod string min(20) with "Missing or malformed
//     token." copy.
//   • Wire route paths: /v1/status/subscribe (POST) +
//     /v1/status/subscribe/confirm (GET) +
//     /v1/status/subscribe/unsubscribe (GET).
//   • Reply codes: 202 (subscribe) + 200 (confirm) + 200 (unsubscribe).
//   • Reply copy pinned: "Confirmation email sent. Click the link to
//     finish subscribing.", "Subscription confirmed. You will receive
//     incident notifications by email.", "Unsubscribed."
//   • All routes share one IP rate-limit gate bucket
//     `ip:status-subscribe`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W411.A apps/server/src/routes/status-subscribe.ts content parity', () => {
  const body = read(LIB);
  const app = read(APP);

  it('V-295c3 framing pinned: 3 routes (POST subscribe + GET confirm + GET unsubscribe) with double-opt-in', () => {
    expect(body).toMatch(/V-295c3 — public status-page email subscription routes\./);
    expect(body).toMatch(/POST \/v1\/status\/subscribe\s+— start double-opt-in/);
    expect(body).toMatch(/GET\s+\/v1\/status\/subscribe\/confirm\?token=\s+— finish opt-in/);
    expect(body).toMatch(
      /GET\s+\/v1\/status\/subscribe\/unsubscribe\?token=— one-click unsubscribe/,
    );
  });

  it('Auth posture pinned: unauthenticated by design + IP rate-limited 3/min default via statusSubscribe config', () => {
    expect(body).toMatch(
      /All three routes are unauthenticated by design \(the status site is\s*\n?\s*\/\/\s*public; visitors don't have Driftstack accounts\)\. IP rate-limited\s*\n?\s*\/\/\s*via `statusSubscribe` config \(3\/min by default\)\./,
    );
  });

  it('SubscribeBodySchema: zod email trim + .email() + .max(254) with "Must be a valid email address." copy', () => {
    expect(body).toMatch(
      /const SubscribeBodySchema = z\.object\(\{\s*\n?\s*email: z\.string\(\)\.trim\(\)\.email\('Must be a valid email address\.'\)\.max\(254\),\s*\n?\s*\}\);/,
    );
  });

  it('TokenQuerySchema: zod string min(20) with "Missing or malformed token." copy', () => {
    expect(body).toMatch(
      /const TokenQuerySchema = z\.object\(\{\s*\n?\s*token: z\.string\(\)\.min\(20, 'Missing or malformed token\.'\),\s*\n?\s*\}\);/,
    );
  });

  it("ipRateLimit gate: bucketPrefix='ip:status-subscribe' + AUTH_IP_LIMITS.statusSubscribe spread", () => {
    expect(body).toMatch(
      /const subscribeGate = ipRateLimit\(rateLimitStore, \{\s*\n?\s*bucketPrefix: 'ip:status-subscribe',\s*\n?\s*\.\.\.AUTH_IP_LIMITS\.statusSubscribe,\s*\n?\s*\}\);/,
    );
  });

  it('POST /v1/status/subscribe: preHandler subscribeGate + service.subscribe(email, now) + 202 reply', () => {
    expect(body).toMatch(
      /app\.post\('\/v1\/status\/subscribe', \{ preHandler: \[subscribeGate\] \}, async \(request, reply\) => \{\s*\n?\s*const parsed = SubscribeBodySchema\.safeParse\(request\.body\);\s*\n?\s*if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);\s*\n?\s*await service\.subscribe\(parsed\.data\.email, new Date\(\)\);\s*\n?\s*return reply\.code\(202\)\.send\(\{\s*\n?\s*message: 'Confirmation email sent\. Click the link to finish subscribing\.',\s*\n?\s*\}\);/,
    );
  });

  it('GET /v1/status/subscribe/confirm: subscribeGate + TokenQuerySchema + service.confirm + 200 with confirmation copy', () => {
    expect(body).toMatch(
      /app\.get<\{ Querystring: \{ token: string \} \}>\(\s*\n?\s*'\/v1\/status\/subscribe\/confirm',\s*\n?\s*\{ preHandler: \[subscribeGate\] \},/,
    );
    expect(body).toMatch(/await service\.confirm\(parsed\.data\.token, new Date\(\)\);/);
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*\n?\s*message: 'Subscription confirmed\. You will receive incident notifications by email\.',\s*\n?\s*\}\);/,
    );
  });

  it('GET /v1/status/subscribe/unsubscribe: subscribeGate + TokenQuerySchema + service.unsubscribe + 200 "Unsubscribed."', () => {
    expect(body).toMatch(
      /app\.get<\{ Querystring: \{ token: string \} \}>\(\s*\n?\s*'\/v1\/status\/subscribe\/unsubscribe',\s*\n?\s*\{ preHandler: \[subscribeGate\] \},/,
    );
    expect(body).toMatch(/await service\.unsubscribe\(parsed\.data\.token, new Date\(\)\);/);
    expect(body).toMatch(/return reply\.code\(200\)\.send\(\{ message: 'Unsubscribed\.' \}\);/);
  });

  it('Token routes: parsed = TokenQuerySchema.safeParse(request.query ?? {}); ValidationError on failure', () => {
    expect(body).toMatch(/const parsed = TokenQuerySchema\.safeParse\(request\.query \?\? \{\}\);/);
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new ValidationError\(parsed\.error\.flatten\(\)\);/,
    );
  });

  it('all three status mutation responses inherit private no-store instead of the public-status cache policy', () => {
    expect(app).toMatch(/req\.url\.startsWith\('\/v1\/'\)/);
    expect(app).not.toMatch(/!req\.url\.startsWith\('\/v1\/status'\)/);
    expect(app).toMatch(/reply\.getHeader\('cache-control'\) === undefined/);
    expect(app).toMatch(/reply\.header\('cache-control', 'no-store, private'\)/);
    expect(app).toMatch(/subscribe\/confirm\/unsubscribe carry mailbox state and one-time tokens/);
  });

  it('imports: FastifyInstance + zod + StatusSubscribersService + RateLimitStore + AUTH_IP_LIMITS/ipRateLimit + ValidationError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import type \{ StatusSubscribersService \} from '\.\.\/services\/status-subscribers\.js';/,
    );
    expect(body).toMatch(/import type \{ RateLimitStore \} from '\.\.\/services\/rate-limit\.js';/);
    expect(body).toMatch(
      /import \{ AUTH_IP_LIMITS, ipRateLimit \} from '\.\.\/middleware\/ip-rate-limit\.js';/,
    );
    expect(body).toMatch(/import \{ ValidationError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('StatusSubscribeRoutesOptions: service + rateLimitStore deps', () => {
    expect(body).toMatch(
      /export interface StatusSubscribeRoutesOptions \{\s*\n?\s*service: StatusSubscribersService;\s*\n?\s*rateLimitStore: RateLimitStore;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
