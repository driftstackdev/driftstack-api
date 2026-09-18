// GET /v1/admin/agent-turns/summary — who may read it, and what it returns.
//
// The authz arms are the point. This endpoint is the only reader of the AI
// diagnostics table; it is aggregates-only and the table is content-free, but
// "how well does the product work" is still staff information.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { row } from '../unit/_helpers/agent-turn-telemetry-row.js';

let fx: TestAppFixture | null = null;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

const URL = '/v1/admin/agent-turns/summary';

describe('GET /v1/admin/agent-turns/summary — authorization', () => {
  it('CRITICAL refuses an unauthenticated caller with 401', async () => {
    fx = await buildTestApp({});
    const res = await fx.app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('completion_rate');
  });

  it('CRITICAL refuses an invalid key with 401', async () => {
    fx = await buildTestApp({});
    const res = await fx.app.inject({
      method: 'GET',
      url: URL,
      headers: { authorization: 'Bearer ds_live_not-a-real-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('CRITICAL refuses a valid ordinary customer key with 403 — and leaks no aggregate in the refusal', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    await fx.agentTurnTelemetryRepo.insert(row({ occurredAt: new Date() }));
    const res = await fx.app.inject({
      method: 'GET',
      url: URL,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('completion_rate');
    expect(res.body).not.toContain('by_outcome');
  });

  it('serves a staff key, uncached', async () => {
    fx = await buildTestApp({});
    const res = await fx.app.inject({
      method: 'GET',
      url: URL,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });
});

describe('GET /v1/admin/agent-turns/summary — the response', () => {
  it('an empty deployment answers with zero counts and NULL rates, not zeros', async () => {
    fx = await buildTestApp({});
    const res = await fx.app.inject({
      method: 'GET',
      url: URL,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<{
      window: { hours: number };
      retention_days: number;
      requests: { total: number };
      turns: { completion_rate: number | null };
      conflicts: { rate_409: number | null };
    }>();
    expect(body.window.hours).toBe(24);
    expect(body.retention_days).toBe(90);
    expect(body.requests.total).toBe(0);
    expect(body.turns.completion_rate).toBeNull();
    expect(body.conflicts.rate_409).toBeNull();
  });

  it('aggregates what real turns left behind, end to end through the message route', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const headers = { authorization: `Bearer ${fx.plaintext}` };
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers,
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    for (let i = 0; i < 2; i += 1) {
      const turn = await fx.app.inject({
        method: 'POST',
        url: `/v1/agent-sessions/${id}/message`,
        headers,
        payload: { user_message: 'open https://example.com and capture' },
      });
      expect(turn.statusCode).toBe(200);
    }
    const missing = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions/ags_00000000-0000-4000-8000-000000000000/message',
      headers,
      payload: { user_message: 'hello' },
    });
    expect(missing.statusCode).toBe(404);
    await fx.agentTurnTelemetry.flush();

    const res = await fx.app.inject({ method: 'GET', url: `${URL}?window_hours=1`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      window: { hours: number };
      requests: { total: number; by_outcome: Record<string, number> };
      turns: { ran: number; completed: number; completion_rate: number | null };
      durations_ms: { turn: { p50: number | null } };
    }>();
    expect(body.window.hours).toBe(1);
    expect(body.requests.total).toBe(3);
    expect(body.requests.by_outcome).toMatchObject({ completed: 2, rejected: 1, failed: 0 });
    expect(body.turns).toMatchObject({ ran: 2, completed: 2, completion_rate: 1 });
    expect(body.durations_ms.turn.p50).not.toBeNull();
  });

  it('refuses a window outside 1 hour … the retention window with 400, rather than answering for less history than the label says', async () => {
    fx = await buildTestApp({});
    const headers = { authorization: `Bearer ${fx.plaintext}` };
    for (const bad of ['0', '-5', '2161', '1.5', 'week', '']) {
      const res = await fx.app.inject({
        method: 'GET',
        url: `${URL}?window_hours=${encodeURIComponent(bad)}`,
        headers,
      });
      expect(res.statusCode, `window_hours=${bad}`).toBe(400);
    }
    const widest = await fx.app.inject({ method: 'GET', url: `${URL}?window_hours=2160`, headers });
    expect(widest.statusCode).toBe(200);
  });

  it('has no parameter that narrows it to a customer: unknown query keys do not change the answer', async () => {
    fx = await buildTestApp({});
    const headers = { authorization: `Bearer ${fx.plaintext}` };
    await fx.agentTurnTelemetryRepo.insert(row({ occurredAt: new Date() }));
    const plain = await fx.app.inject({ method: 'GET', url: URL, headers });
    const narrowed = await fx.app.inject({
      method: 'GET',
      url: `${URL}?account_id=${fx.accountId}&session_id=ags_x`,
      headers,
    });
    const strip = (b: string): unknown => {
      const parsed = JSON.parse(b) as { window: unknown };
      return { ...parsed, window: null };
    };
    expect(strip(narrowed.body)).toEqual(strip(plain.body));
    expect(plain.json<{ requests: { total: number } }>().requests.total).toBe(1);
  });
});
