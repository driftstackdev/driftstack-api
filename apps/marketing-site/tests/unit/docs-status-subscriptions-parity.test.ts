// W354.C — drift guard for /docs/status-subscriptions. The public
// reference for the V-295c3 status-page email subscription flow.
//
// Pinned:
//   • POST /v1/status/subscribe + GET /v1/status/subscribe/confirm
//     + GET /v1/status/subscribe/unsubscribe — all three are
//     registered on the server (status-subscribe.ts).
//   • 24-hour confirmation TTL ↔ CONFIRM_TOKEN_TTL_MS in
//     services/status-subscribers.ts (24 * 60 * 60 * 1000).
//   • 3 requests/minute rate-limit ↔
//     AUTH_IP_LIMITS.statusSubscribe.capacity in
//     middleware/ip-rate-limit.ts.
//   • Shape-stable response posture (no account-existence leak via
//     the response).
//   • Unsubscribe tokens never expire claim — pin so a future change
//     to add expiry forces a doc update.
//   • "No marketing email to subscribers. Period." promise pinned.
//   • Cross-links to /docs/incident-policy + /docs/sla-policy +
//     /api-reference resolve.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/status-subscriptions.astro');
const ROUTE = resolve(REPO_ROOT, 'apps/server/src/routes/status-subscribe.ts');
const SERVICE = resolve(REPO_ROOT, 'apps/server/src/services/status-subscribers.ts');
const RATE_LIMIT = resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W354.C /docs/status-subscriptions parity', () => {
  const body = read(PAGE);
  const route = read(ROUTE);
  const service = read(SERVICE);
  const rateLimit = read(RATE_LIMIT);

  it('three endpoints cited on the page are all registered server-side', () => {
    for (const path of [
      '/v1/status/subscribe',
      '/v1/status/subscribe/confirm',
      '/v1/status/subscribe/unsubscribe',
    ]) {
      expect(body, `missing page citation: ${path}`).toContain(path);
      expect(route, `missing route registration: ${path}`).toContain(`'${path}'`);
    }
  });

  it('24-hour confirmation TTL on the page matches CONFIRM_TOKEN_TTL_MS = 24h', () => {
    expect(body).toMatch(/<strong>24 hours<\/strong>/);
    expect(service).toMatch(/CONFIRM_TOKEN_TTL_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  it('3 requests/minute IP rate-limit matches statusSubscribe bucket', () => {
    expect(body).toMatch(/3\s*requests\/minute/);
    expect(rateLimit).toMatch(
      /statusSubscribe:\s*\{\s*capacity:\s*3,\s*refillPerSecond:\s*3\s*\/\s*60\s*\}/,
    );
  });

  it("subscribe response cites 202 Accepted (the spec'd acknowledge code)", () => {
    expect(body).toMatch(/<code>202 Accepted<\/code>/);
  });

  it('shape-stable response posture pinned (no account-existence leak)', () => {
    expect(body).toMatch(
      /deliberately return the\s*same shape whether or not the email was already subscribed/,
    );
  });

  it('unsubscribe-tokens-never-expire claim pinned (a future expiry change forces a doc update)', () => {
    expect(body).toMatch(/Unsubscribe tokens never expire/);
  });

  it('"no marketing email" promise (Period.) stays pinned — no soft-walkback', () => {
    expect(body).toMatch(/do not send marketing email to status subscribers/i);
    expect(body).toMatch(/Period\./);
  });

  it('rate-limit endpoints share the same bucket (confirm + unsubscribe inherit subscribe)', () => {
    expect(body).toMatch(/Confirmation\s*and unsubscribe inherit the same bucket/);
  });

  it('cross-links to /docs/incident-policy + /docs/sla-policy + /api-reference resolve', () => {
    expect(body).toContain('/docs/incident-policy');
    expect(body).toContain('/docs/sla-policy');
    expect(body).toContain('/api-reference');
    for (const path of [
      'apps/marketing-site/src/pages/docs/incident-policy.astro',
      'apps/marketing-site/src/pages/docs/sla-policy.astro',
    ]) {
      expect(existsSync(resolve(REPO_ROOT, path)), `missing file: ${path}`).toBe(true);
    }
  });

  it('subscribe endpoints are unauthenticated (public ingress)', () => {
    expect(body).toMatch(/None of these\s*endpoints require authentication/);
  });
});
