// AI-CHAT BYOK Anthropic — integration tests for the activation-
// gate-negative case of the 4-verb /v1/account/me/byok-anthropic-key
// surface. When AppDeps lacks the byokAnthropicService (typical pre-
// MFA_ENCRYPTION_KEY posture), the disabled-stub registrar surfaces
// 503 FeatureUnavailable on all 4 verbs.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('AI-CHAT BYOK Anthropic /v1/account/me/byok-anthropic-key activation gate', () => {
  it('GET → 503 when byokAnthropicService unwired', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('PUT → 503 when byokAnthropicService unwired', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: 'sk-ant-api03-fake' },
    });
    expect(res.statusCode).toBe(503);
  });

  it('DELETE → 503 when byokAnthropicService unwired', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('POST /test → 503 when byokAnthropicService unwired', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('disabled-stub detail points at customer-facing docs URL + omits internal jargon', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').toMatch(
      /BYOK Anthropic key management is unavailable on this deployment/,
    );
    expect(body.detail ?? '').toMatch(
      /See https:\/\/docs\.driftstack\.dev\/api\/byok-anthropic\/ for the supported key-management flow\./,
    );
    expect(body.detail ?? '').not.toMatch(/V-\d{3}|planning file|handoff/);
  });
});
