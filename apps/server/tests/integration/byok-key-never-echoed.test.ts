// The customer's Anthropic key is never echoed by ANY BYOK route.
//
// `api/byok-anthropic.md` makes unusually absolute promises, and they are the
// customer's own paid third-party credential:
//
//   "NEVER returned in any response — even after a successful PUT."
//   "The plaintext is NEVER echoed."
//   "The test response NEVER echoes any part of the key."
//
// What existed: one assertion, `not.toContain('sk-ant')`, on the GET metadata.
// It covers neither the PUT response the doc calls out by name, nor the /test
// route the doc calls out by name — and matching the PREFIX means a response
// echoing the key's tail would pass while leaking the secret part. The prefix
// `sk-ant-api03-` is public knowledge; the entropy after it is the secret.
//
// This asserts against a marker unique to the key body, across every route,
// including the DELETE and the error paths.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/**
 * The secret half carries a distinctive marker. Asserting on THIS rather than
 * on `sk-ant` is the point: the prefix is public, so a response that echoed
 * everything after it would satisfy a prefix check while leaking the key.
 */
const KEY_MARKER = 'zq7marker4secret9body';
const VALID_KEY = `sk-ant-api03-${KEY_MARKER}aaaaaaaaaa`;

function assertNoLeak(label: string, body: string): void {
  expect(body, `${label} echoed the key body`).not.toContain(KEY_MARKER);
  expect(body, `${label} echoed the whole key`).not.toContain(VALID_KEY);
}

describe('BYOK Anthropic key is never echoed by any route', () => {
  it('CRITICAL no BYOK route echoes the key — PUT, GET, /test or DELETE. The docs promise "NEVER returned in any response — even after a successful PUT" and "the test response NEVER echoes any part of the key"; only the GET metadata was ever checked, and only against the public `sk-ant` prefix.', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });
    const auth = { authorization: `Bearer ${fx.plaintext}` };

    const put = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: auth,
      payload: { api_key: VALID_KEY },
    });
    expect(put.statusCode, `PUT returned ${put.statusCode}: ${put.body.slice(0, 160)}`).toBe(200);
    assertNoLeak('PUT response', put.body);

    const get = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/byok-anthropic-key',
      headers: auth,
    });
    expect(get.statusCode).toBe(200);
    assertNoLeak('GET response', get.body);
    // The metadata must still confirm a key IS set, or the assertions above
    // would hold trivially against an empty account.
    expect(get.body).toContain('has_key');
    expect(get.json<{ has_key: boolean }>().has_key).toBe(true);

    const test = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/me/byok-anthropic-key/test',
      headers: auth,
      payload: {},
    });
    assertNoLeak('POST /test response', test.body);

    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/me/byok-anthropic-key',
      headers: auth,
      payload: {},
    });
    assertNoLeak('DELETE response', del.body);
  });

  it('CRITICAL a rejected key is not echoed back in the validation error either. A 400 that quotes the offending value is the classic way a secret reaches a log aggregator, and the reflected value is attacker-influenced.', async () => {
    fx = await buildTestApp({ enableByokAnthropic: true });

    const res = await fx.app.inject({
      method: 'PUT',
      url: '/v1/account/me/byok-anthropic-key',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      // Wrong prefix, so it is refused — but it still carries the marker.
      payload: { api_key: `sk-wrong-${KEY_MARKER}` },
    });

    expect(res.statusCode).toBe(400);
    assertNoLeak('validation error', res.body);
  });
});
