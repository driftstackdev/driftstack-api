// Finding #12 — end-to-end signature bridge for the V-173 durable
// webhook delivery path.
//
// ROOT-CAUSE GAP this test closes: no test ever fed a header EMITTED by
// the durable dispatcher into the SDK's verifyWebhookSignature. The
// durable path historically signed BARE HEX into `x-driftstack-signature`
// (+ a bare-hex `x-driftstack-signature-prev` + `x-driftstack-emitted-at`),
// which the SDK verifier — which parses `t=…,v1=…` from the SINGLE
// `x-driftstack-signature` header — silently rejects. Production cuts
// over to this durable impl as the FORWARD path, so the divergence would
// have broken every customer's signature verification on cutover.
//
// This test drives the real DurableWebhookWorker.deliver() through a
// captured fetch, then verifies the captured header with the customer-
// facing SDK verifier. It MUST stay green: it is the contract that the
// emitted header is SDK-verifiable.

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyWebhookSignature } from '@driftstack/sdk';
import { DurableWebhookWorker } from '../../src/services/durable-webhook-delivery.js';
import type { Database } from '../../src/db/client.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Minimal duck-typed Database covering only what processTick + deliver
 *  touch: the atomic claim txn, the claimed-rows join select, the
 *  attempt insert, and the terminal update. Returns one claimed delivery
 *  bound to `endpoint`. */
function makeMockDb(
  delivery: Record<string, unknown>,
  endpoint: Record<string, unknown>,
  attemptRows: unknown[] = [],
): Database {
  const claimed = [{ delivery, endpoint }];
  const tx = {
    execute: () => Promise.resolve({ rows: [{ id: delivery.id as string }] }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  };
  const db = {
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    // claimed-rows join select: select(...).from(...).innerJoin(...).where(...)
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(claimed),
        }),
      }),
    }),
    insert: () => ({
      values: (value: unknown) => {
        attemptRows.push(value);
        return Promise.resolve(undefined);
      },
    }),
    // Terminal/retry UPDATEs are now fenced on status=in_flight and call
    // .returning(...); a 1-row result means the fence matched (the no-op
    // early-return path is exercised by the integration suite). The claim-flip
    // UPDATE inside the txn (above) still resolves to a bare Promise — it has
    // no .returning().
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: delivery.id }]) }) }),
    }),
  };
  return { db } as unknown as Database;
}

function captureFetch(): { fn: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn = ((input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(initHeaders)) headers[k] = v;
    calls.push({
      url: String(input),
      method: (init?.method ?? 'GET').toString(),
      headers,
      body: (init?.body as string | undefined) ?? '',
    });
    return Promise.resolve(new Response('', { status: 200 }));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const SECRET = 'whsec_' + 'curr_secret_value_here';
const PREV_SECRET = 'whsec_' + 'prev_secret_value_here';
const BODY = JSON.stringify({ id: 'ses_001', event: 'session.completed' });
const EMITTED_AT_SEC = Math.floor(Date.UTC(2026, 4, 28, 12, 0, 0) / 1000);

function baseDelivery() {
  return {
    id: 'wd_1111',
    eventId: 'evt_abc',
    eventType: 'session.completed',
    attempts: 0,
    payload: { body: BODY, emittedAtSec: EMITTED_AT_SEC },
  };
}

function baseEndpoint(over: Record<string, unknown> = {}) {
  return {
    id: 'we_1111',
    url: 'https://customer.example/webhook',
    secret: SECRET,
    secretPrev: null,
    secretPrevExpiresAt: null,
    ...over,
  };
}

/** Run one deliver() tick and return the captured outbound request.
 *  The durable sender re-signs at ATTEMPT TIME (signWebhookPayload uses
 *  `Date.now()`, matching the live worker), so we pin the wall clock to
 *  EMITTED_AT_SEC for this single delivery — the signed `t` then equals
 *  EMITTED_AT_SEC and the SDK verifications (which use the same nowMs)
 *  stay inside the ±300s window. */
async function deliverAndCapture(endpoint: Record<string, unknown>): Promise<CapturedRequest> {
  const { fn, calls } = captureFetch();
  const db = makeMockDb(baseDelivery(), endpoint);
  vi.useFakeTimers();
  vi.setSystemTime(EMITTED_AT_SEC * 1000);
  try {
    const worker = new DurableWebhookWorker(db, fn, () => EMITTED_AT_SEC * 1000);
    await worker.processTick();
  } finally {
    vi.useRealTimers();
  }
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('finding #12 — durable webhook header is SDK-verifiable', () => {
  it('emits a single canonical x-driftstack-signature (t=,v1=) the SDK verifier accepts', async () => {
    const req = await deliverAndCapture(baseEndpoint());
    const header = req.headers['x-driftstack-signature'];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const ok = await verifyWebhookSignature({
      body: BODY,
      header,
      secret: SECRET,
      nowMs: EMITTED_AT_SEC * 1000,
    });
    expect(ok).toBe(true);
  });

  it('SDK rejects a tampered body against the emitted header', async () => {
    const req = await deliverAndCapture(baseEndpoint());
    const ok = await verifyWebhookSignature({
      body: BODY + 'tampered',
      header: req.headers['x-driftstack-signature'],
      secret: SECRET,
      nowMs: EMITTED_AT_SEC * 1000,
    });
    expect(ok).toBe(false);
  });

  it('drops the divergent x-driftstack-emitted-at and x-driftstack-signature-prev headers', async () => {
    const req = await deliverAndCapture(baseEndpoint());
    expect(req.headers['x-driftstack-emitted-at']).toBeUndefined();
    expect(req.headers['x-driftstack-signature-prev']).toBeUndefined();
    // The canonical event metadata headers stay.
    expect(req.headers['x-driftstack-event-id']).toBe('evt_abc');
    expect(req.headers['x-driftstack-event-type']).toBe('session.completed');
    expect(req.headers['content-type']).toBe('application/json');
  });

  it('during rotation grace the single header carries dual v1= so SDK accepts BOTH secrets', async () => {
    const req = await deliverAndCapture(
      baseEndpoint({
        secretPrev: PREV_SECRET,
        // grace window open: expiry far in the future relative to `now`.
        secretPrevExpiresAt: new Date(EMITTED_AT_SEC * 1000 + 24 * 60 * 60 * 1000),
      }),
    );
    const header = req.headers['x-driftstack-signature'];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
    expect(req.headers['x-driftstack-signature-prev']).toBeUndefined();

    const nowMs = EMITTED_AT_SEC * 1000;
    expect(await verifyWebhookSignature({ body: BODY, header, secret: SECRET, nowMs })).toBe(true);
    expect(await verifyWebhookSignature({ body: BODY, header, secret: PREV_SECRET, nowMs })).toBe(
      true,
    );
  });

  it('an expired grace window does NOT add the prev v1= entry', async () => {
    const req = await deliverAndCapture(
      baseEndpoint({
        secretPrev: PREV_SECRET,
        // grace expired before `now`.
        secretPrevExpiresAt: new Date(EMITTED_AT_SEC * 1000 - 1000),
      }),
    );
    const header = req.headers['x-driftstack-signature'];
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    const nowMs = EMITTED_AT_SEC * 1000;
    expect(await verifyWebhookSignature({ body: BODY, header, secret: SECRET, nowMs })).toBe(true);
    expect(await verifyWebhookSignature({ body: BODY, header, secret: PREV_SECRET, nowMs })).toBe(
      false,
    );
  });

  it('signed string is <attempt-time-sec>.<body> (timestamp = now, NOT a pinned emit time) — a delayed/retried delivery re-signs with the attempt clock so |now - t| stays inside the SDK ±300s window', async () => {
    // The wall clock is pinned to EMITTED_AT_SEC for this delivery, so the
    // attempt-time `t` resolves to EMITTED_AT_SEC here. The signer takes the
    // timestamp from Date.now() (no emittedAtSec override) — matching the
    // live worker — which is what keeps retried deliveries verifiable.
    const req = await deliverAndCapture(baseEndpoint());
    const header = req.headers['x-driftstack-signature']!;
    const t = Number(/^t=(\d+),/.exec(header)![1]!);
    expect(t).toBe(EMITTED_AT_SEC);
    const v1 = /v1=([0-9a-f]{64})/.exec(header)![1]!;
    const expected = createHmac('sha256', SECRET).update(`${EMITTED_AT_SEC}.${BODY}`).digest('hex');
    expect(v1).toBe(expected);
  });
});

describe('durable webhook response lifecycle', () => {
  it('cancels an unread success body before finalizing delivery', async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const fetchFn: typeof fetch = (_input, init) => {
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
    const worker = new DurableWebhookWorker(
      makeMockDb(baseDelivery(), baseEndpoint()),
      fetchFn,
      () => EMITTED_AT_SEC * 1000,
    );

    const result = await worker.processTick();

    expect(result.delivered).toBe(1);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(false);
  });

  it('retains only a 200-character excerpt from one oversized failure chunk', async () => {
    let cancelled = false;
    const attemptRows: unknown[] = [];
    const fetchFn: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(122)); // 'z'
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 500 },
        ),
      );
    const worker = new DurableWebhookWorker(
      makeMockDb(baseDelivery(), baseEndpoint(), attemptRows),
      fetchFn,
      () => EMITTED_AT_SEC * 1000,
    );

    const result = await worker.processTick();

    expect(result.retried).toBe(1);
    expect(cancelled).toBe(true);
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]).toMatchObject({
      responseStatus: 500,
      responseExcerpt: 'z'.repeat(200),
      outcome: 'http_error',
    });
  });
});
