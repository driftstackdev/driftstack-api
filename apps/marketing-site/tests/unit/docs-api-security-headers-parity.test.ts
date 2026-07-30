// W351.C — drift guard for /docs/api-security-headers. Security
// reviewers and integrators rely on this page; if the server flips
// a helmet setting without updating the doc, reviewers see a
// posture claim that doesn't match production traffic.
//
// Source-of-truth: apps/server/src/lib/app.ts (helmet + cors
// registrations). The page mirrors the chosen policy.
//
// Pinned:
//   • HSTS max-age (63072000 = 2 years) + includeSubDomains + preload
//   • CSP disabled (contentSecurityPolicy: false) — page claim
//     "Driftstack serves no HTML"
//   • CORP cross-origin (vs helmet default same-origin)
//   • COEP disabled
//   • CORS methods + allowed headers + exposed headers + maxAge=600
//   • Cache-Control posture: `no-store, private` is the DEFAULT for all of
//     /v1/* (c86c7b793 broadened it from the account/admin/billing prefixes);
//     the authenticated transcript + notification SSE add no-cache and
//     no-transform; status mailbox mutations stay private; /v1/status public
//     reads use public, max-age=30
//   • Default helmet headers we keep (nosniff, SAMEORIGIN,
//     Referrer-Policy: no-referrer, X-DNS-Prefetch-Control: off)
//   • Vulnerability-disclosure cross-link + security@driftstack.dev

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/api-security-headers.astro');
const APP = resolve(REPO_ROOT, 'apps/server/src/lib/app.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W351.C /docs/api-security-headers parity', () => {
  const body = read(PAGE);
  const app = read(APP);

  it('HSTS claim (max-age=63072000; includeSubDomains; preload) matches server config', () => {
    expect(body).toContain('max-age=63072000; includeSubDomains; preload');
    expect(app).toMatch(/maxAge:\s*63_072_000/);
    expect(app).toMatch(/includeSubDomains:\s*true/);
    expect(app).toMatch(/preload:\s*true/);
  });

  it('CSP-disabled claim matches helmet config (contentSecurityPolicy: false)', () => {
    expect(body).toMatch(/Content-Security-Policy.*Driftstack serves\s*no HTML/);
    expect(app).toMatch(/contentSecurityPolicy:\s*false/);
  });

  it('CORP cross-origin claim matches helmet config', () => {
    expect(body).toMatch(/Cross-Origin-Resource-Policy:\s*cross-origin/);
    expect(app).toMatch(/crossOriginResourcePolicy:\s*\{\s*policy:\s*'cross-origin'\s*\}/);
  });

  it('COEP-disabled claim matches helmet config (crossOriginEmbedderPolicy: false)', () => {
    expect(body).toMatch(/Cross-Origin-Embedder-Policy/);
    expect(app).toMatch(/crossOriginEmbedderPolicy:\s*false/);
  });

  it('CORS methods list matches server config', () => {
    expect(body).toContain('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(app).toMatch(
      /methods:\s*\['GET',\s*'POST',\s*'PUT',\s*'PATCH',\s*'DELETE',\s*'OPTIONS'\]/,
    );
  });

  it('CORS allowed-headers list matches server config', () => {
    // The page claims: authorization, content-type, x-request-id,
    // stripe-signature, x-nowpayments-sig. Each must appear in the
    // server's allowedHeaders.
    for (const h of [
      'authorization',
      'content-type',
      'x-request-id',
      'stripe-signature',
      'x-nowpayments-sig',
    ]) {
      expect(body).toContain(h);
      expect(app).toContain(`'${h}'`);
    }
  });

  it('CORS exposed-headers list matches server config (rate-limit set)', () => {
    for (const h of [
      'x-request-id',
      'x-ratelimit-bucket',
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
      'retry-after',
    ]) {
      expect(body).toContain(h);
      expect(app).toContain(`'${h}'`);
    }
  });

  it('preflight Access-Control-Max-Age=600 (10 min) matches server config', () => {
    expect(body).toContain('Access-Control-Max-Age: 600');
    expect(app).toMatch(/maxAge:\s*600/);
  });

  it('Cache-Control posture pinned: /v1/* private default, private SSE, public status', () => {
    // c86c7b793 broadened the server default from the /v1/account, /v1/admin
    // and /v1/billing prefixes to EVERY /v1 response, so the page now makes
    // the stronger (and true) claim. Pin the page row against the onSend hook
    // that actually produces it, so narrowing the hook turns this red.
    expect(body).toMatch(
      /<code>\/v1\/\*<\/code> \(caller-private default\)[\s\S]{0,200}no-store, private/,
    );
    expect(app).toMatch(/req\.url\.startsWith\('\/v1\/'\)[\s\S]{0,200}'no-store, private'/);
    expect(body).toMatch(
      /\/v1\/agent-sessions\/&#123;id&#125;\/transcript[\s\S]{0,200}no-cache, no-store, private, no-transform/,
    );
    expect(body).toMatch(
      /\/v1\/account\/me\/notifications[\s\S]{0,200}no-cache, no-store, private, no-transform/,
    );
    expect(body).toMatch(/\/v1\/status\/subscribe\*[\s\S]{0,200}no-store, private/);
    expect(body).toMatch(/\/v1\/status[\s\S]{0,200}public, max-age=30/);
    expect(body).toMatch(/\/v1\/status\/stream[\s\S]{0,200}no-cache, no-transform/);
  });

  it('default-retained helmet headers claim stays pinned (nosniff, SAMEORIGIN, Referrer-Policy, DNS-Prefetch)', () => {
    expect(body).toContain('X-Content-Type-Options');
    expect(body).toContain('nosniff');
    expect(body).toContain('X-Frame-Options');
    expect(body).toContain('SAMEORIGIN');
    expect(body).toContain('Referrer-Policy');
    expect(body).toContain('no-referrer');
    expect(body).toContain('X-DNS-Prefetch-Control');
    // The server keeps these as helmet defaults — pin the comment
    // in app.ts so a future override needs a doc + comment update.
    expect(app).toMatch(/X-Content-Type-Options:\s*nosniff/);
    expect(app).toMatch(/X-Frame-Options:\s*SAMEORIGIN/);
    expect(app).toMatch(/Referrer-Policy:\s*no-referrer/);
    expect(app).toMatch(/X-DNS-Prefetch-Control:\s*off/);
  });

  it('reporting + vulnerability-disclosure cross-references pinned', () => {
    expect(body).toContain('security@driftstack.dev');
    expect(body).toContain('/.well-known/security.txt');
    expect(body).toContain('/legal/vulnerability-disclosure');
  });
});
