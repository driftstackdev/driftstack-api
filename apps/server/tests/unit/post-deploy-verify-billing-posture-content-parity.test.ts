import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/post-deploy-verify.mjs');

describe('post-deploy billing posture content parity', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const check = source.match(
    /async function checkBillingPosture\(\) \{([\s\S]*?)\n\}\n\nasync function checkByokAnthropicGateStub/,
  )?.[1];

  it('runs the posture-aware check instead of a disabled-only Stripe assertion', () => {
    expect(source).toMatch(/const checks = \[[\s\S]*?\bcheckBillingPosture,/);
    expect(source).not.toContain('checkBillingGateStub');
    expect(check).toBeDefined();
  });

  it('accepts only typed active 401 or typed disabled 503 responses', () => {
    expect(check).toContain('got.status === 401');
    expect(check).toContain('got.body?.type !== UNAUTHORIZED_TYPE');
    expect(check).toContain('got.status === 503');
    expect(check).toContain('got.body?.type !== FEATURE_UNAVAILABLE_TYPE');
    expect(check).toContain("typeof got.body?.detail !== 'string'");
    expect(check).toContain('expected typed 503 (disabled) or typed 401 (active)');
  });

  it('posts an empty JSON checkout body through the retrying JSON reader', () => {
    expect(check).toContain('fetchJsonWithRetry(`${baseUrl}/v1/billing/checkout-session`, {');
    expect(check).toContain("method: 'POST'");
    expect(check).toContain("headers: { 'content-type': 'application/json' }");
    expect(check).toContain('body: JSON.stringify({})');
  });
});
