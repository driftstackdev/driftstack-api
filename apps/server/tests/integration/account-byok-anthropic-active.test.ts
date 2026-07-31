// Integration coverage for the ACTIVE byok-anthropic storage routes
// (GET/PUT/DELETE) — the activation-gate test only covers the 503
// disabled-stub path. These exercise the wired route → BYOKAnthropicService
// → repo chain: metadata read, set/rotate (with sk-ant prefix validation),
// the account.byok_anthropic_key_set audit emit, and clear.
//
// The /test connection-check leg calls Anthropic, so it stays out of
// scope here (needs a fake client); this covers the storage surface.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

interface MetaResponse {
  has_key: boolean;
  set_at: string | null;
  last_used_at: string | null;
}

const VALID_KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('byok-anthropic active storage routes (GET/PUT/DELETE)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('GET returns the no-key default before any key is set', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MetaResponse>()).toEqual({
      has_key: false,
      set_at: null,
      last_used_at: null,
    });
  });

  it('PUT a valid key returns set_at + GET then reports has_key:true', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: VALID_KEY },
    });
    expect(put.statusCode).toBe(200);
    expect(typeof put.json<{ set_at: string }>().set_at).toBe('string');

    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const meta = get.json<MetaResponse>();
    expect(meta.has_key).toBe(true);
    expect(meta.set_at).not.toBeNull();
    // The raw key is NEVER echoed back — only metadata.
    //
    // Asserted against the KEY, not against 'sk-ant'. The prefix
    // `sk-ant-api03-` is public — it is in Anthropic's own docs — so a
    // response echoing everything after it would satisfy a prefix check while
    // leaking the entire secret. The entropy is what must be absent.
    expect(JSON.stringify(meta)).not.toContain(VALID_KEY);
  });

  it('PUT emits an account.byok_anthropic_key_set audit row', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: VALID_KEY },
    });
    const rows = fx.accountAuditRepo
      .getAll()
      .filter((r) => r.action === 'account.byok_anthropic_key_set');
    expect(rows.length).toBe(1);
  });

  it('PUT with an empty body is rejected with 400', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.BadRequest);
  });

  it('PUT a key without the sk-ant prefix is rejected with 400', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: 'not-an-anthropic-key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.BadRequest);
  });

  it('DELETE clears the key (GET then reports has_key:false); idempotent', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { api_key: VALID_KEY },
    });

    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del.statusCode).toBe(204);

    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(get.json<MetaResponse>().has_key).toBe(false);

    // Second DELETE is idempotent — clearing a non-existent key still 204s.
    const del2 = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del2.statusCode).toBe(204);
  });
});
