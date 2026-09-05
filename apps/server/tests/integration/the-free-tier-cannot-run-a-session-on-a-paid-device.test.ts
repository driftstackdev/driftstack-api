// P-15 (2026-09-05) — the device entitlement at the SESSION door.
//
// Found by the adversarial review of the per-tier profile default: POST /v1/sessions
// defaulted an omitted archetype to the iPhone 17 launch archetype on every tier and
// never judged the device against the tier at all, so a free account could run a
// session on any paid device — by naming it, or by naming nothing. A session is where
// a device is actually USED, which makes this door matter more than the profile one.
//
// Real requests, free vs paid. Profile-bound sessions inherit the profile's device,
// which was judged when the profile was minted, and are not re-judged here.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { ARCHETYPE_REGISTRY, LOCKED_ARCHETYPE_ID } from '@driftstack/api-types';

const IPHONE_17 = LOCKED_ARCHETYPE_ID;

describe('the free tier cannot run a session on a paid device', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('CRITICAL a free account that names NO device gets a session on an entitled one, not the iPhone 17', async () => {
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(201);
    const archetype = (JSON.parse(res.body) as { archetype: string }).archetype;
    expect(archetype).not.toBe(IPHONE_17);
    expect(ARCHETYPE_REGISTRY.find((a) => a.id === archetype)?.device).toBe('iPhone 13');
  });

  it('CRITICAL a free account that NAMES the iPhone 17 is refused (403), the same answer create gives', async () => {
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { archetype: IPHONE_17 },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('iPhone 13');
  });

  it('POSITIVE CONTROL a free account naming an entitled device gets it', async () => {
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { archetype: 'iphone13_ios18_6_safari18_6' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((JSON.parse(res.body) as { archetype: string }).archetype).toBe(
      'iphone13_ios18_6_safari18_6',
    );
  });

  it('a PAID account that names no device still gets the launch default', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((JSON.parse(res.body) as { archetype: string }).archetype).toBe(IPHONE_17);
  });
});
