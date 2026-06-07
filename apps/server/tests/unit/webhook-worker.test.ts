// Worker tests against the in-memory repo + a fake fetch. Covers every
// state transition: 2xx → delivered, 4xx → retry, 5xx → retry, network
// error → retry, timeout → retry, max-attempts → DLQ, and auto-disable.

import { describe, expect, it, vi } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { WebhookDeliveryWorker } from '../../src/services/webhook-worker.js';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';
import type { WebhookEndpointRow } from '../../src/services/webhooks.js';

function fakeFetch(spec: { status?: number; throwError?: Error }): typeof fetch {
  return vi.fn(async () => {
    await Promise.resolve();
    if (spec.throwError) throw spec.throwError;
    return new Response(spec.status === 204 ? null : 'ok', { status: spec.status ?? 200 });
  });
}

const NOW = new Date('2026-05-02T12:00:00Z');
const constNow = (): Date => NOW;

async function setupRepoWithEndpoint(): Promise<{
  repo: InMemoryWebhooksRepo;
  endpoint: WebhookEndpointRow;
}> {
  const repo = new InMemoryWebhooksRepo();
  const endpoint = await repo.insertEndpoint({
    accountId: 'acc-1',
    url: 'https://customer.test/hook',
    secret: 'whsec_test_test_test_test_test_test_te',
    secretPrefix: 'whsec_test_t',
    events: ['session.completed'],
    description: null,
  });
  await repo.enqueueDelivery({
    webhookId: endpoint.id,
    eventId: '11111111-2222-3333-4444-555555555555',
    eventType: 'session.completed',
    payload: { id: '11111111-2222-3333-4444-555555555555', type: 'session.completed', data: {} },
    // Set to NOW so the claim (which uses constNow) finds it eligible.
    nextAttemptAt: NOW,
  });
  return { repo, endpoint };
}

describe('WebhookDeliveryWorker.tickOnce', () => {
  it('claims one delivery, posts it, marks delivered on 2xx', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
    });
    const { claimed, outcomes } = await worker.tickOnce();
    expect(claimed).toBe(1);
    expect(outcomes[0]?.kind).toBe('delivered');
    const deliveries = repo.getAllDeliveries();
    expect(deliveries[0]?.status).toBe('delivered');
    expect(deliveries[0]?.lastResponseStatus).toBe(200);
  });

  it('5xx response → retry with attempts=1 and a future nextAttemptAt', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 500 }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('retry');
    const d = repo.getAllDeliveries()[0];
    expect(d?.status).toBe('pending');
    expect(d?.attempts).toBe(1);
    expect(d?.nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('4xx response → retry (uniform retry policy across all non-2xx)', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 422 }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('retry');
  });

  it('network error → retry, lastError populated', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ throwError: new Error('ECONNREFUSED') }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('retry');
    expect(repo.getAllDeliveries()[0]?.lastError).toBe('ECONNREFUSED');
  });

  it('AbortError → retry with lastError "timeout"', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ throwError: abortErr }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('retry');
    expect(repo.getAllDeliveries()[0]?.lastError).toBe('timeout');
  });

  it('stalled response body is bounded by the delivery abort timer (fetch-body-read-timeout class)', async () => {
    // A misbehaving / malicious endpoint can return response HEADERS (non-2xx)
    // then stall the BODY indefinitely. The failure-excerpt read must be bounded
    // by the same AbortController that bounds the fetch — when the read happened
    // in handleOutcome (after the finally cleared the timer) it was bounded only
    // by undici's ~300s default, hanging a delivery slot. Regression guard: the
    // read now happens inside the try, while the abort timer is still live.
    const { repo } = await setupRepoWithEndpoint();
    let textCalled = false;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal;
      return Promise.resolve({
        ok: false,
        status: 500,
        // Body only ever settles via abort — never resolves on its own.
        text: () =>
          new Promise<string>((_resolve, reject) => {
            textCalled = true;
            const onAbort = (): void =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
      deliveryTimeoutMs: 30, // aborts well within vitest's default 5s timeout
    });
    // Pre-fix this hangs forever (timer already cleared → abort never fires)
    // and the test times out; post-fix it resolves to a normal retry.
    const { outcomes } = await worker.tickOnce();
    expect(textCalled).toBe(true);
    expect(outcomes[0]?.kind).toBe('retry');
    // The aborted read yields a null excerpt; the delivery is still recorded.
    const d = repo.getAllDeliveries()[0];
    expect(d?.status).toBe('pending');
    expect(d?.attempts).toBe(1);
  });

  it('caps the failure-response read by SIZE (huge body / decompression-bomb defense) — reads ≤ a bounded prefix, cancels the stream, excerpt ≤ 4096 chars', async () => {
    // A misbehaving / malicious endpoint returns a non-2xx then streams an
    // enormous body. readExcerpt must read only a bounded prefix and cancel —
    // NOT buffer the whole thing (the undici decompression-bomb / unbounded-read
    // risk on the untrusted outbound path). We assert via a tracked stream.
    const { repo } = await setupRepoWithEndpoint();
    let bytesPulled = 0;
    let cancelled = false;
    const hugeStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bytesPulled += 8192;
        controller.enqueue(new Uint8Array(8192).fill(120)); // 'x'
        // Safety valve so a regression (reading everything) can't truly hang.
        if (bytesPulled > 5 * 1024 * 1024) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(hugeStream, { status: 500 })),
    ) as unknown as typeof fetch;

    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();

    expect(outcomes[0]?.kind).toBe('retry');
    expect(cancelled).toBe(true); // stream stopped early, not drained
    expect(bytesPulled).toBeLessThan(256 * 1024); // bounded read, NOT the 5 MiB
    const d = repo.getAllDeliveries()[0];
    expect((d?.lastResponseExcerpt ?? '').length).toBeLessThanOrEqual(4096);
  });

  it('after MAX attempts, transitions to DLQ', async () => {
    const { repo, endpoint } = await setupRepoWithEndpoint();
    // Fast-forward attempts to 5 (next failure → 6, which is >= MAX_ATTEMPTS = 6).
    const dlist = repo.getAllDeliveries();
    expect(dlist[0]).toBeDefined();
    const id = dlist[0]?.id ?? '';
    await repo.recordRetry(id, {
      responseStatus: 500,
      responseExcerpt: null,
      lastError: null,
      attempts: 5,
      nextAttemptAt: new Date(NOW.getTime() - 1000), // claim-eligible
    });

    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 500 }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('dlq');
    expect(repo.getAllDeliveries()[0]?.status).toBe('dlq');
    // Endpoint not auto-disabled yet (consecutive_failures = 1, < 50).
    expect(endpoint.disabledAt).toBeNull();
  });

  it('the 5th retry (attempts=4 → 5) is scheduled, not DLQd, with the 60-min backoff', async () => {
    // Regression guard for the off-by-one that capped delivery at 4
    // retries: with attempts=4 the next index is 5 (< MAX_ATTEMPTS=6),
    // so the worker must RETRY using BACKOFF_MS_BY_ATTEMPT[5] = 60 min,
    // not promote to DLQ. This is the previously-unreachable 5th retry.
    const { repo } = await setupRepoWithEndpoint();
    const id = repo.getAllDeliveries()[0]?.id ?? '';
    await repo.recordRetry(id, {
      responseStatus: 500,
      responseExcerpt: null,
      lastError: null,
      attempts: 4,
      nextAttemptAt: new Date(NOW.getTime() - 1000),
    });

    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 500 }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('retry');
    const d = repo.getAllDeliveries()[0];
    expect(d?.status).toBe('pending');
    expect(d?.attempts).toBe(5);
    // Next attempt ~60 min out (backoff[5]), plus up to 15% jitter.
    const delayMs = (d?.nextAttemptAt.getTime() ?? 0) - NOW.getTime();
    expect(delayMs).toBeGreaterThanOrEqual(60 * 60_000);
    expect(delayMs).toBeLessThanOrEqual(60 * 60_000 * 1.15 + 1);
  });

  it('endpoint missing/disabled → DLQ', async () => {
    const repo = new InMemoryWebhooksRepo();
    // Enqueue a delivery referencing an endpoint that doesn't exist.
    await repo.enqueueDelivery({
      webhookId: 'whk_orphan',
      eventId: '11111111-2222-3333-4444-555555555555',
      eventType: 'session.completed',
      payload: {},
      nextAttemptAt: NOW,
    });
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    expect(outcomes[0]?.kind).toBe('dlq');
  });

  it('idle batch (claim returns 0) yields zero outcomes', async () => {
    const repo = new InMemoryWebhooksRepo();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
    });
    const { claimed, outcomes } = await worker.tickOnce();
    expect(claimed).toBe(0);
    expect(outcomes).toEqual([]);
  });

  it('signature is included on delivery POST', async () => {
    const { repo } = await setupRepoWithEndpoint();
    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      captured = init;
      await Promise.resolve();
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });
    await worker.tickOnce();
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.['x-driftstack-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers?.['x-driftstack-event-id']).toBe('11111111-2222-3333-4444-555555555555');
    expect(headers?.['x-driftstack-event-type']).toBe('session.completed');
  });

  // v2-#20 — dual-sign during rotation grace window. Pre-v2-#20 the
  // worker emitted only the current secret signature even when an
  // endpoint had a live rotation (secretPrev + secretPrevExpiresAt in
  // the future). Customers verifying with the prior secret got 401-
  // shaped errors during the grace period, defeating the whole point
  // of dual-signing. The fix in webhook-worker.ts now reads
  // endpoint.secretPrev + secretPrevExpiresAt and passes secretPrev to
  // signWebhookPayload only while the grace window is active.
  it('v2-#20 dual-signs deliveries during the rotation grace window (two v1=… entries when secretPrev is set and secretPrevExpiresAt > now)', async () => {
    const { repo, endpoint } = await setupRepoWithEndpoint();
    await repo.rotateSecret({
      id: endpoint.id,
      accountId: endpoint.accountId,
      newSecret: 'whsec_new_new_new_new_new_new_new_new__',
      newPrefix: 'whsec_new_n',
      graceExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      now: NOW,
    });
    // Re-enqueue a delivery on the rotated endpoint.
    await repo.enqueueDelivery({
      webhookId: endpoint.id,
      eventId: '22222222-3333-4444-5555-666666666666',
      eventType: 'session.completed',
      payload: { id: '22222222-3333-4444-5555-666666666666', type: 'session.completed', data: {} },
      nextAttemptAt: NOW,
    });

    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      captured = init;
      await Promise.resolve();
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });
    await worker.tickOnce();
    const headers = captured?.headers as Record<string, string> | undefined;
    // Two v1=<hex> entries — one for the current secret, one for the
    // prev secret carried during the dual-sign window.
    expect(headers?.['x-driftstack-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  });

  // Arc 3 sub-slice 28.3 (v2-#28) — server-initiated force-rotation
  // sets BOTH secret_prev_expires_at AND grace_window_ends_at to the
  // same 7-day deadline, so the existing v2-#20 worker dual-sign path
  // honours the longer 7-day window automatically. This test pins
  // that contract: after forceRotateSecret, deliveries during the
  // 7-day window MUST carry two v1=… signatures.
  it('v2-#28 sub-slice 28.3 dual-signs during the server-initiated 7-day grace window (no separate worker path required)', async () => {
    const { repo, endpoint } = await setupRepoWithEndpoint();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    await repo.forceRotateSecret({
      id: endpoint.id,
      newSecret: 'whsec_force_force_force_force_force_force__',
      newPrefix: 'whsec_force',
      graceWindowEndsAt: new Date(NOW.getTime() + sevenDays),
      now: NOW,
    });
    await repo.enqueueDelivery({
      webhookId: endpoint.id,
      eventId: '99999999-aaaa-bbbb-cccc-ddddddddeeee',
      eventType: 'session.completed',
      payload: { id: '99999999-aaaa-bbbb-cccc-ddddddddeeee', type: 'session.completed', data: {} },
      nextAttemptAt: NOW,
    });

    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      captured = init;
      await Promise.resolve();
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });
    await worker.tickOnce();
    const headers = captured?.headers as Record<string, string> | undefined;
    expect(headers?.['x-driftstack-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  });

  it('v2-#20 stops dual-signing past secretPrevExpiresAt — even with a stale secretPrev still in the row, the prev signature drops once the grace window closes', async () => {
    const { repo, endpoint } = await setupRepoWithEndpoint();
    // Rotate with a grace that ALREADY EXPIRED relative to constNow.
    // The row still carries secretPrev (no separate cleanup task yet);
    // the worker must enforce the cutoff at signing time, not assume
    // the row is null'd out.
    await repo.rotateSecret({
      id: endpoint.id,
      accountId: endpoint.accountId,
      newSecret: 'whsec_new2_new2_new2_new2_new2_new2_n_',
      newPrefix: 'whsec_new2_',
      graceExpiresAt: new Date(NOW.getTime() - 60 * 1000),
      now: NOW,
    });
    await repo.enqueueDelivery({
      webhookId: endpoint.id,
      eventId: '33333333-4444-5555-6666-777777777777',
      eventType: 'session.completed',
      payload: { id: '33333333-4444-5555-6666-777777777777', type: 'session.completed', data: {} },
      nextAttemptAt: NOW,
    });

    let captured: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      captured = init;
      await Promise.resolve();
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });
    await worker.tickOnce();
    const headers = captured?.headers as Record<string, string> | undefined;
    // Single v1=… entry — past the grace window, prev signature drops.
    expect(headers?.['x-driftstack-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});
