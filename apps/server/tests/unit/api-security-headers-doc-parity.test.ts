// W244.D — drift-guard for /docs/api-security-headers. Pins the
// HSTS posture, CORS method list, allowed headers, exposed headers,
// and preflight max-age to the live helmet/cors config in app.ts.
// The previous revision asserted PATCH/DELETE only (missed PUT),
// an Idempotency-Key allowed header (we don't accept it), and a
// max-age of 300 (we use 600).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'api-security-headers.astro',
);
const APP_PATH = join(REPO, 'apps', 'server', 'src', 'lib', 'app.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W244.D api-security-headers doc parity', () => {
  const doc = read(DOC_PATH);
  const app = read(APP_PATH);

  it('HSTS posture matches the helmet config', () => {
    // Live: maxAge 63072000, includeSubDomains, preload.
    expect(app).toMatch(/maxAge:\s*63_?072_?000/);
    expect(app).toMatch(/includeSubDomains:\s*true/);
    expect(app).toMatch(/preload:\s*true/);
    // Doc.
    expect(doc).toMatch(/max-age=63072000;\s*includeSubDomains;\s*preload/);
  });

  it('CORS method list includes every method the server allows', () => {
    expect(app).toMatch(
      /methods:\s*\['GET',\s*'POST',\s*'PUT',\s*'PATCH',\s*'DELETE',\s*'OPTIONS'\]/,
    );
    expect(doc).toMatch(/GET,\s*POST,\s*PUT,\s*PATCH,\s*DELETE,\s*OPTIONS/);
  });

  it('CORS allowed headers match the server allow-list', () => {
    for (const h of [
      'authorization',
      'content-type',
      'x-request-id',
      'stripe-signature',
      'x-nowpayments-sig',
    ]) {
      expect(doc).toContain(h);
    }
    // Forbidden: the prior revision listed Idempotency-Key (server does not accept it as a CORS header).
    expect(doc).not.toMatch(/Idempotency-Key/);
  });

  it('preflight max-age is 600s (10 minutes), not 300s', () => {
    expect(app).toMatch(/maxAge:\s*600/);
    expect(doc).toMatch(/Access-Control-Max-Age:\s*600/);
    expect(doc).not.toMatch(/Access-Control-Max-Age:\s*300/);
  });

  it('Cross-Origin-Resource-Policy reflects the cross-origin posture', () => {
    expect(app).toMatch(/crossOriginResourcePolicy:\s*\{\s*policy:\s*'cross-origin'/);
    expect(doc).toMatch(/Cross-Origin-Resource-Policy:\s*cross-origin/);
  });

  it('exposed headers include the rate-limit headers documented at /docs/rate-limits', () => {
    expect(app).toMatch(/x-ratelimit-bucket/);
    expect(app).toMatch(/x-ratelimit-limit/);
    expect(doc).toMatch(/x-ratelimit-bucket/);
    expect(doc).toMatch(/x-ratelimit-limit/);
  });

  it('exposes the crypto-checkout replay marker to cross-origin GUI clients', () => {
    expect(app).toMatch(/'idempotent-replayed',/);
    expect(doc).toMatch(/Access-Control-Expose-Headers:[^\n]*idempotent-replayed/);
  });
});
