// LK.2 — integration tests for the activation-gate-negative case of
// POST /v1/mac-nodes/register. When AppDeps lacks the Drizzle fleet-
// nodes repo OR the livekit-secret encryption key, the route is
// NOT registered. Customer (or anyone) hitting the path gets a 404.
//
// The wired case requires a real Postgres + drizzle fleet_nodes
// row — that lives in a separate test file that runs against the
// `pg`-backed test container. This file's scope is the negative gate.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('LK.2 POST /v1/mac-nodes/register activation gate', () => {
  it('route unregistered when drizzleFleetNodesRepo is absent → 404', async () => {
    // buildTestApp's default fixture is the in-memory fleet that
    // skips the Drizzle wiring — so the gate stays closed.
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        mac_node_id: '00000000-0000-4000-8000-000000000001',
        livekit: {
          api_key: 'APItest',
          api_secret: 'secrettest',
          ws_url: 'wss://mac-1.driftstack.test:8443',
        },
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('unauthenticated → 404 (route is unregistered, not auth-rejected)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/mac-nodes/register',
      payload: {
        mac_node_id: '00000000-0000-4000-8000-000000000001',
        livekit: {
          api_key: 'APItest',
          api_secret: 'secrettest',
          ws_url: 'wss://mac-1.driftstack.test:8443',
        },
      },
    });
    // Route unregistered → 404 fastify-default, NOT 401
    expect(res.statusCode).toBe(404);
  });

  it('GET on the path → 404 (no GET handler, route only accepts POST when wired)', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/mac-nodes/register',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
