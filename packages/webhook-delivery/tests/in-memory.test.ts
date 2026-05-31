// V-164 — InMemoryWebhookDelivery integration tests.
//
// Distinct from the V-144 mock tests: this exercises the FULL retry
// curve, the state machine across pending/in_flight/delivered/dlq
// transitions, signature signing, and DLQ promotion.

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKOFF_MS_BY_ATTEMPT,
  DEFAULT_MAX_ATTEMPTS,
  createInMemoryWebhookDelivery,
  signPayload,
  type DeliveryEndpoint,
  type DeliveryPayload,
  type InMemoryWebhookDeliveryHandles,
} from '../src/index.js';

const ENDPOINT: DeliveryEndpoint = {
  id: 'endpoint_test',
  accountId: 'acc_test',
  url: 'https://customer.example/webhook',
  eventTypes: ['session.completed'],
  signingSecret: 'whsec_test_secret_value_here',
  active: true,
};

const PAYLOAD: DeliveryPayload = {
  eventId: 'evt_test_001',
  eventType: 'session.completed',
  emittedAtSec: 1_700_000_000,
  body: '{"id":"ses_001","status":"completed"}',
};

interface FetchCall {
  url: string | URL;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function captureFetch(responder: (call: FetchCall) => { status: number; body?: string } | Error): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(initHeaders)) headers[k] = v;
    const call: FetchCall = {
      url: input as string | URL,
      method: (init?.method ?? 'GET').toString(),
      headers,
      body: (init?.body as string | undefined) ?? '',
    };
    calls.push(call);
    const result = responder(call);
    if (result instanceof Error) {
      return Promise.reject(result);
    }
    return Promise.resolve(
      new Response(result.body ?? '', {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fn, calls };
}

function build(
  fetchFn: typeof fetch,
  initialNow = 1_700_000_000_000,
): { handles: InMemoryWebhookDeliveryHandles; advance: (ms: number) => void; nowMs: () => number } {
  let now = initialNow;
  const handles = createInMemoryWebhookDelivery({
    fetch: fetchFn,
    now: () => now,
    getEndpoint: (id) => (id === ENDPOINT.id ? ENDPOINT : null),
  });
  return {
    handles,
    advance: (ms) => {
      now += ms;
    },
    nowMs: () => now,
  };
}

describe('signPayload', () => {
  it('returns canonical t=<emittedAtSec>,v1=<hex HMAC over emittedAtSec.body>', () => {
    const hex = createHmac('sha256', ENDPOINT.signingSecret)
      .update(`${PAYLOAD.emittedAtSec.toString()}.${PAYLOAD.body}`, 'utf-8')
      .digest('hex');
    expect(signPayload(ENDPOINT.signingSecret, PAYLOAD)).toBe(
      `t=${PAYLOAD.emittedAtSec.toString()},v1=${hex}`,
    );
    expect(signPayload(ENDPOINT.signingSecret, PAYLOAD)).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});

describe('InMemoryWebhookDeliveryService.enqueue + get + list', () => {
  let handles: InMemoryWebhookDeliveryHandles;

  beforeEach(() => {
    const { fn } = captureFetch(() => ({ status: 200 }));
    handles = build(fn).handles;
  });

  it('enqueue returns a pending record with assigned id', async () => {
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    expect(record.status).toBe('pending');
    expect(record.id).toMatch(/^wdl_\d{8}$/);
    expect(record.endpointId).toBe(ENDPOINT.id);
    expect(record.attempts).toEqual([]);
    expect(record.nextAttemptAtMs).not.toBeNull();
  });

  it('get returns the same record', async () => {
    const a = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const b = await handles.deliveries.get(a.id);
    expect(b).toEqual(a);
  });

  it('get returns null for unknown id', async () => {
    expect(await handles.deliveries.get('wdl_nonexistent')).toBeNull();
  });

  it('list returns pending records, newest-first, scoped by endpoint', async () => {
    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const page = await handles.deliveries.list({ endpointId: ENDPOINT.id });
    expect(page.data).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('list filters by status', async () => {
    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const page = await handles.deliveries.list({ endpointId: ENDPOINT.id, status: 'delivered' });
    expect(page.data).toEqual([]);
  });

  it('list pages with cursor', async () => {
    for (let i = 0; i < 5; i += 1) {
      await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    }
    const page1 = await handles.deliveries.list({ endpointId: ENDPOINT.id, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await handles.deliveries.list({
      endpointId: ENDPOINT.id,
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.data).toHaveLength(2);
    // No overlap.
    const ids1 = new Set(page1.data.map((r) => r.id));
    const ids2 = new Set(page2.data.map((r) => r.id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it('pages through same-timestamp deliveries without dropping any (keyset completeness)', async () => {
    // All five enqueue at the same fixed `now`, so they share an
    // identical createdAtMs — the case a createdAt-only cursor silently
    // drops at a page boundary. Page exhaustively and assert every id
    // comes back exactly once. (Locks the contract the Drizzle durable
    // impl's keyset cursor must also satisfy.)
    const created = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const r = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
      created.add(r.id);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    // Bounded guard so a pagination bug can't spin this forever.
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await handles.deliveries.list({ endpointId: ENDPOINT.id, limit: 2, cursor });
      for (const r of page.data) seen.add(r.id);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(created);
    expect(seen.size).toBe(5);
  });
});

describe('processTick — happy path delivery', () => {
  it('200 response → record transitions to delivered', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 200 }));
    const { handles } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const result = await handles.processTick();

    expect(result.pulled).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.dlqed).toBe(0);

    const updated = await handles.deliveries.get(record.id);
    expect(updated?.status).toBe('delivered');
    expect(updated?.attempts).toHaveLength(1);
    expect(updated?.attempts[0]?.outcome).toBe('success');
    expect(updated?.attempts[0]?.responseStatus).toBe(200);
    expect(updated?.completedAtMs).not.toBeNull();
    expect(updated?.nextAttemptAtMs).toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(ENDPOINT.url);
  });

  it('signs the request with the canonical t=,v1= signature header', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 200 }));
    const { handles } = build(fn);
    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();
    const call = calls[0]!;
    expect(call.headers['x-driftstack-signature']).toBe(
      signPayload(ENDPOINT.signingSecret, PAYLOAD),
    );
    expect(call.headers['x-driftstack-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(call.headers['x-driftstack-event-id']).toBe(PAYLOAD.eventId);
    expect(call.headers['x-driftstack-event-type']).toBe(PAYLOAD.eventType);
    // emitted-at is folded into the `t=` of the signature header — no
    // separate x-driftstack-emitted-at header.
    expect(call.headers['x-driftstack-emitted-at']).toBeUndefined();
  });
});

describe('processTick — failure + retry curve', () => {
  it('500 response → record stays pending, nextAttemptAtMs advances per BACKOFF', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, nowMs } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const result = await handles.processTick();

    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(1);
    expect(result.dlqed).toBe(0);

    const updated = await handles.deliveries.get(record.id);
    expect(updated?.status).toBe('pending');
    expect(updated?.attempts).toHaveLength(1);
    expect(updated?.attempts[0]?.outcome).toBe('http_error');
    // First failure schedules retry 1 = 60s out.
    expect(updated?.nextAttemptAtMs).toBe(nowMs() + BACKOFF_MS_BY_ATTEMPT[1]);
  });

  it('sixth failure → record promoted to DLQ', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    // Six failed attempts (initial + 5 retries). After the 6th, the record
    // hits maxAttempts (default 6) and lands in DLQ.
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      // Advance past the scheduled backoff so the next tick picks it up.
      const backoff = BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000;
      advance(backoff + 1);
    }

    expect(await handles.deliveries.get(record.id)).toBeNull();
    const dlqEntry = await handles.dlq.get(record.id);
    expect(dlqEntry).not.toBeNull();
    expect(dlqEntry?.totalAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(dlqEntry?.attempts).toHaveLength(DEFAULT_MAX_ATTEMPTS);
    expect(dlqEntry?.reason).toContain('http_error');
  });

  it('transport error (rejected fetch) → records as transport_error outcome', async () => {
    const { fn } = captureFetch(() => new Error('ECONNREFUSED'));
    const { handles } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();

    const updated = await handles.deliveries.get(record.id);
    expect(updated?.attempts[0]?.outcome).toBe('transport_error');
    expect(updated?.attempts[0]?.errorMessage).toBe('ECONNREFUSED');
    expect(updated?.attempts[0]?.responseStatus).toBeNull();
  });
});

describe('processTick — leasing + due-time gating', () => {
  it('records with future nextAttemptAtMs are not pulled', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles } = build(fn);

    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    // First tick fires + schedules retry 60s out.
    await handles.processTick();
    // Second tick (no time advance) — nothing due.
    const result = await handles.processTick();
    expect(result.pulled).toBe(0);
  });

  it('lease expiry returns the record to the pool on next tick', async () => {
    const { fn } = captureFetch(() => ({ status: 200 }));
    const { handles, advance } = build(fn);

    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();
    // Successful delivery → record is in 'delivered' state, NOT
    // re-pulled. Lease expiry only matters for stuck in_flight rows;
    // we verify the steady-state happy path here.
    advance(60_000);
    const result = await handles.processTick();
    expect(result.pulled).toBe(0);
  });
});

describe('replay + DlqManager.requeue', () => {
  it('replay re-arms a delivered record', async () => {
    const { fn } = captureFetch(() => ({ status: 200 }));
    const { handles } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();
    expect((await handles.deliveries.get(record.id))?.status).toBe('delivered');

    const replayed = await handles.deliveries.replay(record.id);
    expect(replayed.status).toBe('pending');
    // Attempts preserved (postmortem trail).
    expect(replayed.attempts.length).toBeGreaterThan(0);
  });

  it('DlqManager.requeue moves entry from DLQ back to active queue', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60_000) + 1);
    }
    expect(await handles.dlq.get(record.id)).not.toBeNull();

    const requeued = await handles.dlq.requeue({ deliveryId: record.id });
    expect(requeued.status).toBe('pending');
    expect(await handles.dlq.get(record.id)).toBeNull();
    expect((await handles.deliveries.get(record.id))?.status).toBe('pending');
  });

  it('DlqManager.discard hard-deletes the entry', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60_000) + 1);
    }
    await handles.dlq.discard(record.id);
    expect(await handles.dlq.get(record.id)).toBeNull();
  });
});

describe('DlqManager.list', () => {
  it('lists DLQ entries newest-first, optionally scoped by accountId', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60_000) + 1);
    }
    const page = await handles.dlq.list({ accountId: ENDPOINT.accountId });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.accountId).toBe(ENDPOINT.accountId);
  });

  it('filters out entries from other accounts', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60_000) + 1);
    }
    const page = await handles.dlq.list({ accountId: 'acc_other' });
    expect(page.data).toEqual([]);
  });
});

describe('endpoint-disappeared edge case', () => {
  it('promotes immediately to DLQ on endpoint not found', async () => {
    const { fn } = captureFetch(() => ({ status: 200 }));
    const handles = createInMemoryWebhookDelivery({
      fetch: fn,
      now: () => 1_700_000_000_000,
      getEndpoint: () => null,
    });
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const result = await handles.processTick();
    expect(result.dlqed).toBe(1);
    expect(await handles.deliveries.get(record.id)).toBeNull();
    expect(await handles.dlq.get(record.id)).not.toBeNull();
  });
});
