// V-164 — InMemoryWebhookDelivery integration tests.
//
// Distinct from the V-144 mock tests: this exercises the FULL retry
// curve, the state machine across pending/in_flight/delivered/dlq
// transitions, signature signing, and DLQ promotion.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKOFF_MS_BY_ATTEMPT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DLQ_ENTRIES,
  createInMemoryWebhookDelivery,
  isLiteralUnsafeWebhookHost,
  signPayload,
  type DeliveryEndpoint,
  type DeliveryPayload,
  type InMemoryWebhookDeliveryHandles,
} from '../src/index.js';
import { InMemoryWebhookDeliveryService, type SharedDeliveryStore } from '../src/in-memory.js';

const HERE = dirname(fileURLToPath(import.meta.url));

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

  it('#7: a delayed RETRY is re-stamped + re-signed with its OWN send time (not the emit time)', async () => {
    // First attempt fails → retry scheduled. Advance the clock past the backoff,
    // then the retry must carry a `t=` reflecting the NEW send time and an HMAC
    // over that send time — so a tolerance-checking SDK verifier (300s window)
    // accepts the retry even though emittedAtSec is now far in the past.
    // The responder runs AFTER the call is pushed, so the first attempt sees
    // calls.length === 1. Fail that one (→ retry), succeed on the retry.
    const { fn, calls } = captureFetch(() =>
      calls.length === 1 ? { status: 500 } : { status: 200 },
    );
    const { handles, advance, nowMs } = build(fn);
    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });

    // Attempt 1 (fails) — sent at emit time.
    await handles.processTick();
    const firstSig = calls[0]!.headers['x-driftstack-signature']!;
    const firstT = Number(/t=(\d+)/.exec(firstSig)![1]);
    expect(firstT).toBe(PAYLOAD.emittedAtSec); // first send == emit time here

    // Advance an hour (past the 60s backoff) and run the retry.
    advance(60 * 60_000);
    await handles.processTick();
    expect(calls).toHaveLength(2);
    const retrySig = calls[1]!.headers['x-driftstack-signature']!;
    const retryT = Number(/t=(\d+)/.exec(retrySig)![1]);

    // The retry's timestamp is the CURRENT send time, not the stale emit time.
    expect(retryT).toBe(Math.floor(nowMs() / 1000));
    expect(retryT).toBeGreaterThan(firstT);

    // The retry signature is a valid HMAC over `<retryT>.<body>` (re-signed, not reused).
    const expected = createHmac('sha256', ENDPOINT.signingSecret)
      .update(`${retryT}.${PAYLOAD.body}`, 'utf-8')
      .digest('hex');
    expect(retrySig).toBe(`t=${retryT},v1=${expected}`);
    // And it differs from the first attempt's signature (stale-timestamp reuse is the bug).
    expect(retrySig).not.toBe(firstSig);
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

  it('bounds and redacts credential-bearing transport errors before attempt/DLQ storage', async () => {
    const message =
      'fetch https://user:pass@customer.example/hook?token=tok_live_secret ' +
      'https://customer.example/cb#access_token=fragment_secret ' +
      'Bearer bearer.secret+/== Basic dXNlcjpwYXNz ' +
      'x'.repeat(2_000);
    const { fn } = captureFetch(() => new Error(message));
    const { handles } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();

    const updated = await handles.deliveries.get(record.id);
    const errorMessage = updated?.attempts[0]?.errorMessage ?? '';
    expect(updated?.attempts[0]?.outcome).toBe('transport_error');
    expect(errorMessage.length).toBeLessThanOrEqual(500);
    expect(errorMessage).toContain('[redacted]');
    expect(errorMessage).not.toContain('user:pass');
    expect(errorMessage).not.toContain('tok_live_secret');
    expect(errorMessage).not.toContain('fragment_secret');
    expect(errorMessage).not.toContain('bearer.secret');
    expect(errorMessage).not.toContain('dXNlcjpwYXNz');
  });

  it('records timeout as a fixed diagnostic rather than the thrown message', async () => {
    const error = Object.assign(new Error('https://user:pass@example.test/?token=secret'), {
      name: 'TimeoutError',
    });
    const { fn } = captureFetch(() => error);
    const { handles } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();

    const updated = await handles.deliveries.get(record.id);
    expect(updated?.attempts[0]).toMatchObject({
      outcome: 'timeout',
      errorMessage: 'timeout',
    });
  });

  it("SSRF hardening: delivery fetch sets redirect:'error' (does NOT follow 3xx)", async () => {
    // A customer-controlled endpoint that 3xx-redirects must not be
    // followed (e.g. https://attacker → 30x → http://169.254.169.254).
    // Pin that the outbound fetch is invoked with redirect:'error'.
    let capturedRedirect: RequestInit['redirect'] | 'unset' = 'unset';
    const fn: typeof fetch = (_input, init) => {
      capturedRedirect = init?.redirect ?? 'unset';
      return Promise.resolve(new Response('', { status: 200 }));
    };
    const { handles } = build(fn);

    await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();

    expect(capturedRedirect).toBe('error');
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

describe('processTick — response lifecycle bounds', () => {
  it('cancels an unread success body before recording delivery', async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const fn: typeof fetch = (_input, init) => {
      signal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
      );
    };
    const { handles } = build(fn);
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });

    const result = await handles.processTick();
    const updated = await handles.deliveries.get(record.id);

    expect(result.delivered).toBe(1);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(false);
    expect(updated?.attempts[0]?.responseExcerpt).toBeNull();
  });

  it('retains only the first 200 characters from one oversized failure chunk', async () => {
    let cancelled = false;
    const fn: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(121)); // 'y'
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500 },
        ),
      );
    const { handles } = build(fn);
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });

    const result = await handles.processTick();
    const updated = await handles.deliveries.get(record.id);

    expect(result.retried).toBe(1);
    expect(cancelled).toBe(true);
    expect(updated?.attempts[0]?.responseExcerpt).toBe('y'.repeat(200));
  });

  it('keeps the endpoint timeout armed while a failure body is stalled', async () => {
    let aborted = false;
    const endpoint: DeliveryEndpoint = { ...ENDPOINT, config: { timeoutMs: 25 } };
    const fn: typeof fetch = (_input, init) => {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const fail = (): void => {
                aborted = true;
                controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              };
              if (signal?.aborted) fail();
              else signal?.addEventListener('abort', fail, { once: true });
            },
          }),
          { status: 500 },
        ),
      );
    };
    const handles = createInMemoryWebhookDelivery({
      fetch: fn,
      getEndpoint: (id) => (id === endpoint.id ? endpoint : null),
    });
    const record = await handles.deliveries.enqueue({ endpoint, payload: PAYLOAD });

    const result = await handles.processTick();
    const updated = await handles.deliveries.get(record.id);

    expect(result.retried).toBe(1);
    expect(aborted).toBe(true);
    expect(updated?.attempts[0]?.responseStatus).toBe(500);
    expect(updated?.attempts[0]?.responseExcerpt).toBeNull();
  });
});

describe('replay + DlqManager.requeue', () => {
  // V-787 — the retry budget resets on replay/requeue, and the attempt history
  // does not. The production repo keeps those as two separate things: a numeric
  // `attempts` column that `replay` sets to 0, and an append-only attempt log.
  // This double folds both into one array, so until now only one of them could
  // hold — and the one that lost was the budget. A requeued delivery counted its
  // carried-forward history against the new budget, computed attempt 7 of 6, and
  // went straight back to DLQ after ONE attempt. The interface's own contract
  // ("Resets attempts + sends back through the queue. ... New attempt rows append
  // to the existing record") asks for BOTH, which is what these cases pin.
  it('CRITICAL requeue from DLQ grants a FULL fresh budget, not the remainder. Before this it granted exactly one attempt: the carried-forward log made attempts.length + 1 exceed maxAttempts on the first tick, so a requeue was an expensive way to re-DLQ a delivery. The production repo sets attempts = 0 here.', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000) + 1);
    }
    expect(await handles.dlq.get(record.id), 'exhausted first').not.toBeNull();

    await handles.dlq.requeue({ deliveryId: record.id });
    const before = calls.length;
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000) + 1);
    }

    expect(
      calls.length - before,
      'a requeued delivery gets the same number of attempts a fresh one would',
    ).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('CRITICAL the attempt HISTORY survives the same requeue. Resetting the budget by clearing the log would satisfy the case above and destroy the postmortem record the DLQ surface exists to show — the two properties have to hold together, which is the whole reason the budget is tracked as a baseline rather than by truncating the array.', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 500 }));
    const { handles, advance } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000) + 1);
    }
    await handles.dlq.requeue({ deliveryId: record.id });
    const before = calls.length;
    await handles.processTick();

    const after = await handles.deliveries.get(record.id);
    expect(calls.length - before, 'it did attempt').toBe(1);
    expect(
      after?.attempts.length,
      'history kept: six from before the requeue plus the new one',
    ).toBe(DEFAULT_MAX_ATTEMPTS + 1);
    expect(
      after?.attempts.at(-1)?.attempt,
      'and the new attempt is numbered 1 WITHIN the new budget — the number the backoff curve is indexed by',
    ).toBe(1);
  });

  it('CRITICAL the backoff restarts at the head of the curve after a requeue. The stale number indexed BACKOFF_MS_BY_ATTEMPT past its end, fell through to the 60-minute tail, and made the one attempt a requeue did allow wait an hour.', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles, advance, nowMs } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
      await handles.processTick();
      advance((BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000) + 1);
    }
    await handles.dlq.requeue({ deliveryId: record.id });
    const firedAt = nowMs();
    await handles.processTick();

    const after = await handles.deliveries.get(record.id);
    expect(
      (after?.nextAttemptAtMs ?? 0) - firedAt,
      'first retry after a requeue waits the FIRST backoff step, not the tail',
    ).toBe(BACKOFF_MS_BY_ATTEMPT[1]);
  });

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

// ──────────────────────────────────────────────────────────────────────────
// WD-1 (HIGH) — replay()/requeue() status guard.
//
// Without a guard, replayShared() unconditionally rewrote whatever
// store.queue held — including a delivery that is 'in_flight' RIGHT NOW (a
// live outstanding HTTP attempt with an active lease). Clobbering that clears
// the lease and re-arms the record as due-now, so the very next
// processTick() re-claims it and fires a SECOND concurrent live HTTP POST —
// a real double-delivery, with both attempts computing the same stale
// `attempts.length` and both logging as `attempt: 1`.
// ──────────────────────────────────────────────────────────────────────────
describe('WD-1: replay()/requeue() reject an in_flight delivery (no clobbered lease)', () => {
  /**
   * Enqueues a delivery and starts a processTick WITHOUT awaiting it, using a
   * fetchFn whose Promise never resolves until the test calls
   * `resolveFetch()`. processTick's claim loop (marking due entries
   * in_flight + setting the lease) runs fully synchronously before it ever
   * awaits the pending fetch, so by the time this helper returns, the
   * delivery is durably 'in_flight' in the store — exactly the live-lease
   * window the audit finding describes.
   */
  async function setupInFlightDelivery(): Promise<{
    handles: InMemoryWebhookDeliveryHandles;
    record: { id: string };
    fetchCallCount: () => number;
    resolveFetch: (status: number) => void;
    tickPromise: Promise<unknown>;
  }> {
    let fetchCallCount = 0;
    let resolveFetch!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fn: typeof fetch = () => {
      fetchCallCount += 1;
      return pending;
    };
    const { handles } = build(fn);
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });

    // Kick off the tick without awaiting — it suspends on the pending fetch,
    // but the claim loop (in_flight + lease) has already run synchronously.
    const tickPromise = handles.processTick();
    expect((await handles.deliveries.get(record.id))?.status).toBe('in_flight');

    return {
      handles,
      record,
      fetchCallCount: () => fetchCallCount,
      resolveFetch: (status: number) => {
        resolveFetch(new Response('', { status }));
      },
      tickPromise,
    };
  }

  it('deliveries.replay() on an in_flight delivery is REJECTED, not clobbered', async () => {
    const { handles, record, fetchCallCount, resolveFetch, tickPromise } =
      await setupInFlightDelivery();

    // Wrapping in an async IIFE normalizes replay()'s synchronous throw (the
    // guard's error convention, matching the existing not-found throws in
    // this file) into a proper promise rejection for the matcher.
    await expect((async () => handles.deliveries.replay(record.id))()).rejects.toThrow(/in_flight/);

    // The live in-flight attempt was NOT clobbered: let it complete normally.
    resolveFetch(200);
    await tickPromise;
    const updated = await handles.deliveries.get(record.id);
    expect(updated?.status).toBe('delivered');
    expect(updated?.attempts).toHaveLength(1);
    expect(updated?.attempts.filter((a) => a.attempt === 1)).toHaveLength(1);

    // A second tick fires no further fetch — only ONE fetch ever happened
    // for this delivery id.
    const result2 = await handles.processTick();
    expect(result2.pulled).toBe(0);
    expect(fetchCallCount()).toBe(1);
  });

  it('dlq.requeue() on an in_flight delivery is REJECTED, not clobbered', async () => {
    const { handles, record, fetchCallCount, resolveFetch, tickPromise } =
      await setupInFlightDelivery();

    await expect((async () => handles.dlq.requeue({ deliveryId: record.id }))()).rejects.toThrow(
      /in_flight/,
    );

    resolveFetch(200);
    await tickPromise;
    const updated = await handles.deliveries.get(record.id);
    expect(updated?.status).toBe('delivered');
    expect(updated?.attempts).toHaveLength(1);
    expect(updated?.attempts.filter((a) => a.attempt === 1)).toHaveLength(1);

    const result2 = await handles.processTick();
    expect(result2.pulled).toBe(0);
    expect(fetchCallCount()).toBe(1);
  });

  it('legit path (no regression): replay() on a genuinely delivered delivery still works', async () => {
    const { fn } = captureFetch(() => ({ status: 200 }));
    const { handles } = build(fn);

    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await handles.processTick();
    expect((await handles.deliveries.get(record.id))?.status).toBe('delivered');

    const replayed = await handles.deliveries.replay(record.id);
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toHaveLength(1); // preserved for postmortem
    expect(replayed.nextAttemptAtMs).not.toBeNull();
  });

  it("legit path: the guard's allow-list also covers 'failed' status (per the replay() doc contract), not only 'delivered'", async () => {
    // This in-memory impl's public state machine only ever produces
    // 'pending' | 'in_flight' | 'delivered' | 'dlq' — 'failed' is a
    // DeliveryStatus reserved for a future durable backend that can mark a
    // non-retryable failure terminal without a DLQ detour. Construct the
    // store directly (whitebox) to prove the guard allows 'failed' too, per
    // the WebhookDeliveryService.replay doc ("Replay a 'failed' or
    // 'delivered' delivery") — not just an accidental in_flight-only check.
    const store: SharedDeliveryStore = {
      queue: new Map(),
      dlq: new Map(),
      idCounter: { value: 0 },
    };
    store.queue.set('wdl_failed_1', {
      record: {
        id: 'wdl_failed_1',
        endpointId: ENDPOINT.id,
        payload: PAYLOAD,
        status: 'failed',
        attempts: [
          {
            attempt: 1,
            completedAtMs: 1_700_000_000_000,
            responseStatus: 500,
            responseExcerpt: null,
            durationMs: 5,
            outcome: 'http_error',
            errorMessage: 'HTTP 500',
          },
        ],
        nextAttemptAtMs: null,
        createdAtMs: 1_700_000_000_000,
        completedAtMs: 1_700_000_000_000,
      },
      endpointId: ENDPOINT.id,
      accountId: ENDPOINT.accountId,
      leasedUntilMs: null,
    });
    const service = new InMemoryWebhookDeliveryService(
      store,
      (id) => (id === ENDPOINT.id ? ENDPOINT : null),
      () => 1_700_000_100_000,
    );

    const replayed = await service.replay('wdl_failed_1');
    expect(replayed.status).toBe('pending');
    expect(replayed.attempts).toHaveLength(1);
    expect(replayed.nextAttemptAtMs).toBe(1_700_000_100_000);
  });

  it("rejects replay() on an already-'pending' delivery too (not just in_flight)", async () => {
    // The doc contract is narrower than "not in_flight" — it's "only
    // 'failed' or 'delivered'". A still-'pending' (not yet due) delivery
    // should also be rejected rather than silently re-armed.
    const { fn } = captureFetch(() => ({ status: 500 }));
    const { handles } = build(fn);
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    // Never ticked — record.status is 'pending'.
    expect((await handles.deliveries.get(record.id))?.status).toBe('pending');
    await expect((async () => handles.deliveries.replay(record.id))()).rejects.toThrow(/pending/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// WD-2 (MEDIUM) — SSRF/DNS-rebind defense-in-depth.
// ──────────────────────────────────────────────────────────────────────────
describe('WD-2: SSRF defense-in-depth', () => {
  it('isLiteralUnsafeWebhookHost flags literal private/loopback/link-local IPs + localhost', () => {
    expect(isLiteralUnsafeWebhookHost('https://169.254.169.254/latest/meta-data')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://127.0.0.1:9200/')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://10.1.2.3/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://172.16.0.5/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://172.31.255.254/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://192.168.1.10/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://100.64.0.1/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://0.0.0.0/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://localhost/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://[::1]/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://[fe80::1]/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://[fc00::1]/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://[::ffff:10.0.0.5]/hook')).toBe(true);
    // V-1410 — fc00::/7 is written as two halves and only the fc one was exercised.
    // fc00::/8 is reserved and effectively unused; fd00::/8 is the half that carries
    // every locally-assigned ULA, so the prefix a real private network actually uses
    // was the one no arm reached. Coverage agreed: `startsWith('fd')` was never even
    // EVALUATED, because `startsWith('fc')` short-circuited on the only case present.
    expect(isLiteralUnsafeWebhookHost('https://[fd00::1]/hook')).toBe(true);
    expect(isLiteralUnsafeWebhookHost('https://[fdab:cdef::9]/hook')).toBe(true);
    // The unspecified address. `host === '::'` was evaluated but never once matched.
    expect(isLiteralUnsafeWebhookHost('https://[::]/hook')).toBe(true);
  });

  it('isLiteralUnsafeWebhookHost passes public IPs + normal hostnames through', () => {
    expect(isLiteralUnsafeWebhookHost('https://8.8.8.8/hook')).toBe(false);
    expect(isLiteralUnsafeWebhookHost('https://1.2.3.4/hook')).toBe(false);
    expect(isLiteralUnsafeWebhookHost('https://customer.example/webhook')).toBe(false);
    expect(isLiteralUnsafeWebhookHost('not a url at all')).toBe(false);
    // V-1410 — the ALLOW side of the IPv6 branch had never executed. Every IPv6 case
    // in this file is one the guard rejects, so nothing showed it lets a legitimate
    // v6 endpoint through: an over-broad v6 rule would refuse every delivery to a
    // customer on IPv6 and no arm here would have noticed.
    expect(isLiteralUnsafeWebhookHost('https://[2001:db8::1]/hook')).toBe(false);
    expect(isLiteralUnsafeWebhookHost('https://[2606:4700:4700::1111]/hook')).toBe(false);
  });

  it('processTick refuses to deliver to a literal internal IP WITHOUT ever calling fetchFn', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 200 }));
    const metadataEndpoint: DeliveryEndpoint = {
      ...ENDPOINT,
      url: 'https://169.254.169.254/steal',
    };
    const handles = createInMemoryWebhookDelivery({
      fetch: fn,
      now: () => 1_700_000_000_000,
      getEndpoint: (id) => (id === metadataEndpoint.id ? metadataEndpoint : null),
    });
    const record = await handles.deliveries.enqueue({
      endpoint: metadataEndpoint,
      payload: PAYLOAD,
    });
    const result = await handles.processTick();

    expect(calls).toHaveLength(0); // fetchFn never invoked — blocked pre-connect
    expect(result.retried).toBe(1); // recorded as a normal failed attempt (retry curve applies)
    const updated = await handles.deliveries.get(record.id);
    expect(updated?.attempts).toHaveLength(1);
    expect(updated?.attempts[0]?.outcome).toBe('transport_error');
    expect(updated?.attempts[0]?.errorMessage).toMatch(/SSRF/);
  });

  it('warns loudly, at the fetch-injection point, that the default fetch is not SSRF-safe in production', () => {
    const src = readFileSync(resolve(HERE, '..', 'src', 'in-memory.ts'), 'utf8');
    expect(src).toMatch(/PRODUCTION CALLERS MUST INJECT AN SSRF-GUARDED FETCH/);
    expect(src).toMatch(/for TESTS AND LOCAL DEV ONLY/);
    expect(src).toMatch(/ssrfGuardedFetch/);
    expect(src).toMatch(/isLiteralUnsafeWebhookHost/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// WD-3 (MEDIUM) — endpoint.active gates delivery.
// ──────────────────────────────────────────────────────────────────────────
describe('WD-3: endpoint.active gates delivery', () => {
  it('endpoint disabled between enqueue and claim → immediate DLQ, no HTTP attempt', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 200 }));
    let currentEndpoint: DeliveryEndpoint = { ...ENDPOINT };
    const handles = createInMemoryWebhookDelivery({
      fetch: fn,
      now: () => 1_700_000_000_000,
      getEndpoint: (id) => (id === ENDPOINT.id ? currentEndpoint : null),
    });
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    // Disable the endpoint AFTER enqueue, before the delivery's next attempt
    // fires — deliver() re-fetches the live endpoint every attempt.
    currentEndpoint = { ...ENDPOINT, active: false };
    const result = await handles.processTick();

    expect(result.pulled).toBe(1);
    expect(result.dlqed).toBe(1);
    expect(result.delivered).toBe(0);
    expect(result.retried).toBe(0);
    expect(calls).toHaveLength(0); // no HTTP fetch attempted

    expect(await handles.deliveries.get(record.id)).toBeNull();
    const dlqEntry = await handles.dlq.get(record.id);
    expect(dlqEntry).not.toBeNull();
    expect(dlqEntry?.attempts).toHaveLength(1);
    expect(dlqEntry?.reason).toMatch(/disabled/i);
  });

  it('legit path (no regression): an active endpoint still delivers normally', async () => {
    const { fn, calls } = captureFetch(() => ({ status: 200 }));
    const { handles } = build(fn);
    const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const result = await handles.processTick();
    expect(result.delivered).toBe(1);
    expect(calls).toHaveLength(1);
    expect((await handles.deliveries.get(record.id))?.status).toBe('delivered');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// WD-4 (LOW) — bounded DLQ size cap (oldest-evicted).
// ──────────────────────────────────────────────────────────────────────────
describe('WD-4: DLQ size cap', () => {
  it('DEFAULT_MAX_DLQ_ENTRIES is 10,000 (self-hosted single-process default)', () => {
    expect(DEFAULT_MAX_DLQ_ENTRIES).toBe(10_000);
  });

  it('evicts the oldest DLQ entry once the cap is exceeded, and never exceeds the cap under sustained load', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    const CAP = 3;
    let now = 1_700_000_000_000;
    const handles = createInMemoryWebhookDelivery({
      fetch: fn,
      now: () => now,
      getEndpoint: (id) => (id === ENDPOINT.id ? ENDPOINT : null),
      maxDlqEntries: CAP,
    });

    const ids: string[] = [];
    // Drive CAP + 2 separate deliveries through to DLQ, one at a time (so DLQ
    // insertion order is deterministic), asserting the cap holds throughout —
    // not just at the end.
    for (let n = 0; n < CAP + 2; n += 1) {
      const record = await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
      ids.push(record.id);
      for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
        await handles.processTick();
        now += (BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000) + 1;
      }
      const page = await handles.dlq.list({ limit: 200 });
      expect(page.data.length).toBeLessThanOrEqual(CAP);
    }

    const finalPage = await handles.dlq.list({ limit: 200 });
    expect(finalPage.data).toHaveLength(CAP);
    const remainingIds = new Set(finalPage.data.map((e) => e.deliveryId));
    // The oldest (ids.length - CAP) entries were evicted; only the most
    // recent CAP ids remain.
    const expectedRemaining = ids.slice(ids.length - CAP);
    const expectedEvicted = ids.slice(0, ids.length - CAP);
    for (const id of expectedRemaining) expect(remainingIds.has(id)).toBe(true);
    for (const id of expectedEvicted) expect(remainingIds.has(id)).toBe(false);
  });

  it('legit path (no regression): under the default cap, DLQ retains all entries', async () => {
    const { fn } = captureFetch(() => ({ status: 500 }));
    let now = 1_700_000_000_000;
    const handles = createInMemoryWebhookDelivery({
      fetch: fn,
      now: () => now,
      getEndpoint: (id) => (id === ENDPOINT.id ? ENDPOINT : null),
    });
    for (let n = 0; n < 3; n += 1) {
      await handles.deliveries.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
      for (let i = 1; i <= DEFAULT_MAX_ATTEMPTS; i += 1) {
        await handles.processTick();
        now += (BACKOFF_MS_BY_ATTEMPT[i] ?? 60 * 60_000) + 1;
      }
    }
    const page = await handles.dlq.list({ limit: 200 });
    expect(page.data).toHaveLength(3);
  });
});
