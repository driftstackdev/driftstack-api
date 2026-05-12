// W306.B — drift guard for the customer-dashboard /webhooks page
// narrative around signing secrets. The page promises:
//   • HMAC-SHA256-signed delivery
//   • 5-minute timestamp tolerance
//   • verify-with-SDK story (verifyWebhookSignature)
//   • show-once handoff for new signing secrets
// These claims must match the live SDK implementation in
// packages/sdk-typescript/src/webhook-signature.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/webhooks.astro');
const SDK = resolve(REPO_ROOT, 'packages/sdk-typescript/src/webhook-signature.ts');
const SDK_INDEX = resolve(REPO_ROOT, 'packages/sdk-typescript/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W306.B /webhooks signing-secret narrative parity', () => {
  const page = read(PAGE);
  const sdk = read(SDK);
  const sdkIndex = read(SDK_INDEX);

  it('page claims HMAC-SHA256-signed delivery', () => {
    expect(page).toMatch(/HMAC[- ]SHA[- ]?256/i);
  });

  it('page claims 5-minute timestamp tolerance', () => {
    expect(page).toMatch(/5[- ]minute\s+timestamp\s+tolerance/i);
  });

  it('SDK default tolerance is 300 seconds (matches 5-minute claim)', () => {
    expect(sdk).toMatch(/DEFAULT_TOLERANCE_SEC\s*=\s*300/);
  });

  it('SDK uses HMAC + SHA-256 via Web Crypto subtle', () => {
    expect(sdk).toMatch(/name:\s*['"]HMAC['"]/);
    expect(sdk).toMatch(/hash:\s*['"]SHA-256['"]/);
  });

  it('SDK index re-exports verifyWebhookSignature so the page narrative can point to it', () => {
    expect(sdkIndex).toMatch(/verifyWebhookSignature/);
  });

  it('page says the secret is shown once and tells the user to copy it now', () => {
    // The handoff is critical — the dashboard never displays the raw
    // secret again after first reveal.
    expect(page).toMatch(/Copy this signing secret now/i);
    expect(page).toMatch(/won't be shown again|will not be shown again/i);
  });

  it('page mentions a rotation grace window (matches SDK headerPrev support)', () => {
    expect(page).toMatch(/rotat/i);
    expect(sdk).toMatch(/headerPrev/);
  });
});
