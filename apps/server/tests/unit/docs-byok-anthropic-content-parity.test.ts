// Arc 6 docs.byok-anthropic — drift guard for the new
// /api/byok-anthropic docs page.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/byok-anthropic.md');

describe('Arc 6 docs.byok-anthropic content parity', () => {
  it('page exists at the expected path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const body = readFileSync(PAGE, 'utf8');

  it('frontmatter declares layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: BYOK Anthropic key/);
    expect(body).toMatch(/description: Bring-your-own/);
  });

  it('explains BYOK wins over bundled-LLM in resolution chain', () => {
    expect(body).toMatch(/BYOK always wins/);
    expect(body).toMatch(/Q4=A/);
    expect(body).toMatch(/no-BYOK fallback/);
  });

  it('documents all four customer endpoints', () => {
    expect(body).toMatch(/GET \/v1\/account\/me\/byok-anthropic-key\b/);
    expect(body).toMatch(/PUT \/v1\/account\/me\/byok-anthropic-key\b/);
    expect(body).toMatch(/DELETE \/v1\/account\/me\/byok-anthropic-key\b/);
    expect(body).toMatch(/POST \/v1\/account\/me\/byok-anthropic-key\/test\b/);
  });

  it('scope distinction documented: read scope for the GET metadata route; account_owner for write + test', () => {
    expect(body).toMatch(
      /the `read` scope is sufficient — the\s*\n?GET metadata route requires only authentication, not a write scope/,
    );
    expect(body).toMatch(/account_owner.*team members can USE/);
    // The corrected doc dropped the old account_holder read-scope framing.
    expect(body).not.toMatch(/account_holder scope is sufficient/);
  });

  it('explicitly states plaintext is NEVER echoed in responses', () => {
    expect(body).toMatch(/NEVER returned in any response/);
    expect(body).toMatch(/plaintext is NEVER echoed/);
  });

  it('test-endpoint response documented: { ok: true } / { ok: false, reason } + 400 on no-key', () => {
    // Matches the live route: returns ok:true or ok:false+reason (string,
    // not a stable enum); a missing key throws 400 Bad Request.
    expect(body).toMatch(/\{ "ok": true \}/);
    expect(body).toMatch(/"ok": false,\s*\n\s*"reason":/);
    expect(body).toMatch(/not a stable enum/);
    expect(body).toMatch(/`400 Bad Request`/);
  });

  it('encryption at rest documented: AES-256-GCM + MFA_ENCRYPTION_KEY + canonical blob shape', () => {
    expect(body).toMatch(/AES-256-GCM/);
    expect(body).toMatch(/MFA_ENCRYPTION_KEY/);
    expect(body).toMatch(/12-byte IV[\s\S]*?16-byte auth tag[\s\S]*?ciphertext/);
  });

  it('v2-#21 TTL + rotation reminder documented (60-day nag + 90-day gate)', () => {
    expect(body).toMatch(/60[\s\S]*?days the customer receives a one-time/);
    expect(body).toMatch(/90 days/);
    expect(body).toMatch(/sendByokAnthropicKeyRotationReminder/);
  });

  it('error table covers 400 / 401 / 403 / 502 / 503', () => {
    expect(body).toMatch(/\|\s*400\s*\| bad-request/);
    expect(body).toMatch(/\|\s*401\s*\| unauthorized/);
    expect(body).toMatch(/\|\s*403\s*\| forbidden/);
    expect(body).toMatch(/\|\s*502\s*\| byok-anthropic-required/);
    expect(body).toMatch(/\|\s*503\s*\| feature-unavailable/);
  });

  it('privacy section: V-494 secret filter + fixed no-inference, no-body server probe', () => {
    expect(body).toMatch(/V-494/);
    expect(body).toMatch(/fixed\s*\n?\s*Anthropic model-list endpoint/);
    expect(body).toMatch(/does not run inference, read or proxy\s*\n?\s*the response body/);
  });
});
