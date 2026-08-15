// Worker tests against the in-memory repo + a fake fetch. Covers every
// state transition: 2xx → delivered, 4xx → retry, 5xx → retry, network
// error → retry, timeout → retry, max-attempts → DLQ, and auto-disable.

import { describe, expect, it, vi } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { WebhookDeliveryWorker } from '../../src/services/webhook-worker.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
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

/**
 * A registry wired as bootstrap wires it. `inc` throws on an unregistered
 * counter, so registering here is what makes the assertions below exercise the
 * real path rather than the throwing one.
 */
function registryOf(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.webhookDeliveryAttemptTotal, 'test', ['outcome']);
  m.registerCounter(METRIC_NAMES.webhookDeliveryTerminalTotal, 'test', ['terminal_state']);
  return m;
}

/** `metric{label}=value` for the two delivery counters. */
function deliverySamples(metrics: MetricsRegistry): string[] {
  return metrics
    .render()
    .split('\n')
    .filter(
      (l) =>
        l.startsWith(METRIC_NAMES.webhookDeliveryAttemptTotal) ||
        l.startsWith(METRIC_NAMES.webhookDeliveryTerminalTotal),
    )
    .map((l) => {
      const label = /\{([^}]*)\}/.exec(l)?.[1] ?? '';
      const value = l.trim().split(/\s+/).pop() ?? '?';
      const short = l.startsWith(METRIC_NAMES.webhookDeliveryAttemptTotal) ? 'attempt' : 'terminal';
      return `${short}{${label}}=${value}`;
    })
    .sort();
}

describe('WebhookDeliveryWorker delivery counters', () => {
  it('CRITICAL a successful tick increments BOTH counters. They were registered at boot and emitted only from DurableWebhookWorker, which is wired nowhere — so in production they could never increment, and a dashboard showed a flat zero indistinguishable from "no webhooks configured".', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const metrics = registryOf();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
      metrics,
    });

    await worker.tickOnce();

    expect(deliverySamples(metrics)).toEqual([
      'attempt{outcome="success"}=1',
      'terminal{terminal_state="delivered"}=1',
    ]);
  });

  it('CRITICAL a failing delivery that will be RETRIED counts an attempt but no terminal. Counting a retry as terminal would make the DLQ rate read high while nothing had actually been given up on.', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const metrics = registryOf();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 500 }),
      now: constNow,
      metrics,
    });

    await worker.tickOnce();

    expect(deliverySamples(metrics)).toEqual(['attempt{outcome="http_error"}=1']);
  });

  it('CRITICAL the worker runs without a metrics registry. Observability must never be load-bearing for the delivery it observes.', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
    });

    await expect(worker.tickOnce()).resolves.toMatchObject({ claimed: 1 });
  });
});

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

  it('cancels an unread 2xx body before recording delivery success', async () => {
    const { repo } = await setupRepoWithEndpoint();
    let cancelled = false;
    let signalAtCancel: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      signalAtCancel = init.signal ?? undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            // Never enqueue or close: this models success headers followed by
            // an endless body. Cancellation must finish the delivery promptly.
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });

    const { outcomes } = await worker.tickOnce();

    expect(outcomes[0]?.kind).toBe('delivered');
    expect(cancelled).toBe(true);
    expect(signalAtCancel?.aborted).toBe(false);
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

  it('redacts and bounds credentials embedded in a persisted transport error', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const secretMessage =
      'fetch https://alice:password123@customer.test/hook?token=query-secret ' +
      'Bearer bearer-secret-value Basic YWxhZGRpbjpvcGVuc2VzYW1l ' +
      'x'.repeat(2_000);
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ throwError: new Error(secretMessage) }),
      now: constNow,
    });

    await worker.tickOnce();

    const lastError = repo.getAllDeliveries()[0]?.lastError ?? '';
    expect(lastError.length).toBeLessThanOrEqual(500);
    expect(lastError).toContain('[redacted]');
    expect(lastError).not.toContain('password123');
    expect(lastError).not.toContain('query-secret');
    expect(lastError).not.toContain('bearer-secret-value');
    expect(lastError).not.toContain('YWxhZGRpbjpvcGVuc2VzYW1l');
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

  it('copies only the bounded prefix when one decoded response chunk exceeds the entire cap', async () => {
    const { repo } = await setupRepoWithEndpoint();
    let cancelled = false;
    const oversizedChunkStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(121)); // 'y'
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(oversizedChunkStream, { status: 500 })),
    ) as unknown as typeof fetch;
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });

    const { outcomes } = await worker.tickOnce();

    expect(outcomes[0]?.kind).toBe('retry');
    expect(cancelled).toBe(true);
    expect(repo.getAllDeliveries()[0]?.lastResponseExcerpt).toBe('y'.repeat(4096));
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

  it('#6: a RETRY that crosses the 50-consecutive-failure threshold auto-disables the endpoint', async () => {
    // Regression for the auto-disable check only running on the DLQ branch: an
    // endpoint that keeps failing — each delivery scheduling a RETRY (not DLQ) —
    // must still be disabled once consecutiveFailures crosses 50. Seed the
    // endpoint to 49 consecutive failures (via recordRetry on a throwaway
    // delivery), then run ONE more failing tick on a fresh delivery: the retry
    // bumps to 50 and the endpoint must be disabled on the retry path.
    const { repo, endpoint } = await setupRepoWithEndpoint();
    const seedId = repo.getAllDeliveries()[0]?.id ?? '';
    for (let i = 0; i < 49; i += 1) {
      await repo.recordRetry(seedId, {
        responseStatus: 500,
        responseExcerpt: null,
        lastError: null,
        attempts: 1, // stays well under MAX so it never DLQs while seeding
        nextAttemptAt: new Date(NOW.getTime() + 60 * 60_000), // not claim-eligible
      });
    }
    // A FRESH delivery (attempts=0) that fails → retry (nextAttemptIndex=1 < MAX).
    await repo.enqueueDelivery({
      webhookId: endpoint.id,
      eventId: '22222222-3333-4444-5555-666666666666',
      eventType: 'session.completed',
      payload: { id: '22222222-3333-4444-5555-666666666666', type: 'session.completed', data: {} },
      nextAttemptAt: NOW,
    });

    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 500 }),
      now: constNow,
    });
    const { outcomes } = await worker.tickOnce();
    // The fresh delivery RETRIED (it did not DLQ) …
    expect(outcomes.some((o) => o.kind === 'retry')).toBe(true);
    // … and the 50th consecutive failure disabled the endpoint on the retry path.
    const after = await repo.findEndpointById(endpoint.id);
    expect(after?.disabledAt).not.toBeNull();
    expect(after?.active).toBe(false);
  });

  it('two same-endpoint failures in ONE batch cross the threshold off the LIVE counter (not the stale claim-time snapshot) → endpoint disabled', async () => {
    // Regression for the stale-snapshot double-count: deliver() captures
    // endpoint.consecutiveFailures once at claim time, and a batch runs its
    // deliveries concurrently via Promise.all. When two+ deliveries for the
    // SAME endpoint fail in one batch, the OLD auto-disable check evaluated
    // `snapshot + 1 >= 50` against the IDENTICAL pre-batch snapshot for every
    // delivery — so with the count seeded to 48, both reads computed 49 (< 50)
    // and the endpoint was NEVER disabled even though the real counter climbed
    // 48 → 49 → 50. The fix re-reads the CURRENT consecutiveFailures after each
    // record* increment commits, so the second failure observes 50 and disables.
    const { repo, endpoint } = await setupRepoWithEndpoint();
    // Seed the endpoint to 48 consecutive failures via a throwaway delivery
    // that is NOT claim-eligible (nextAttemptAt in the future).
    const seedId = repo.getAllDeliveries()[0]?.id ?? '';
    for (let i = 0; i < 48; i += 1) {
      await repo.recordRetry(seedId, {
        responseStatus: 500,
        responseExcerpt: null,
        lastError: null,
        attempts: 1,
        nextAttemptAt: new Date(NOW.getTime() + 60 * 60_000),
      });
    }
    // Two FRESH deliveries (attempts=0) for the SAME endpoint, both claim-
    // eligible at NOW → claimed together + run concurrently via Promise.all.
    for (const eventId of [
      '44444444-5555-6666-7777-888888888888',
      '55555555-6666-7777-8888-999999999999',
    ]) {
      await repo.enqueueDelivery({
        webhookId: endpoint.id,
        eventId,
        eventType: 'session.completed',
        payload: { id: eventId, type: 'session.completed', data: {} },
        nextAttemptAt: NOW,
      });
    }

    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 500 }),
      now: constNow,
    });
    const { claimed, outcomes } = await worker.tickOnce();
    // Both fresh deliveries were claimed in one batch and retried.
    expect(claimed).toBe(2);
    expect(outcomes.every((o) => o.kind === 'retry')).toBe(true);
    // The two increments pushed the live counter 48 → 49 → 50: the endpoint
    // MUST be disabled (pre-fix it stays enabled — both checks saw 48+1=49).
    const after = await repo.findEndpointById(endpoint.id);
    expect(after?.consecutiveFailures).toBe(50);
    expect(after?.disabledAt).not.toBeNull();
    expect(after?.active).toBe(false);
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

describe('WebhookDeliveryWorker per-delivery error boundary (V-781)', () => {
  /**
   * A repo whose endpoint lookup throws — the realistic shape is a stored secret that will not
   * decrypt under this process's key, which `toEndpointRow` raises on. This is the FIRST await
   * in the delivery path, before any record* write, so before the boundary the row stayed
   * in_flight with `attempts` unchanged and could never age into the DLQ.
   */
  function repoThatThrowsOnEndpointLookup(repo: InMemoryWebhooksRepo): InMemoryWebhooksRepo {
    const proxied = Object.create(repo) as InMemoryWebhooksRepo;
    proxied.findEndpointById = () =>
      Promise.reject(new Error('webhook secret could not be decrypted'));
    return proxied;
  }

  it('CRITICAL a delivery that throws before any write still consumes an attempt — `attempts` is written only by recordRetry, so without this the row could never reach MAX_ATTEMPTS, never reach the DLQ, and the stale-reclaim would re-claim it forever', async () => {
    const { repo } = await setupRepoWithEndpoint();
    const worker = new WebhookDeliveryWorker({
      repo: repoThatThrowsOnEndpointLookup(repo),
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
      metrics: registryOf(),
    });

    const result = await worker.tickOnce();

    expect(result.claimed).toBe(1);
    expect(result.outcomes[0]?.kind, 'the budget applies, so it is an ordinary retry').toBe(
      'retry',
    );
    const row = await repo.findDeliveryById(result.outcomes[0]!.delivery.id);
    expect(row?.attempts, 'the attempt was consumed rather than frozen').toBe(1);
    expect(row?.status, 'and it is no longer stuck in_flight').not.toBe('in_flight');
  });

  it("CRITICAL one throwing delivery does not discard the rest of the batch — Promise.all rejected the whole tick, so a single undeliverable row silently degraded OTHER tenants' webhooks and skipped the metrics that would have shown it", async () => {
    const { repo, endpoint } = await setupRepoWithEndpoint();
    // A second, healthy delivery on the same endpoint, claimed in the same batch.
    await repo.enqueueDelivery({
      webhookId: endpoint.id,
      eventId: '99999999-8888-7777-6666-555555555555',
      eventType: 'session.completed',
      payload: { id: '99999999-8888-7777-6666-555555555555', type: 'session.completed', data: {} },
      nextAttemptAt: NOW,
    });

    // Throw for the FIRST lookup only; the second delivery must still be processed.
    let calls = 0;
    const realLookup = repo.findEndpointById.bind(repo);
    const proxied = Object.create(repo) as InMemoryWebhooksRepo;
    proxied.findEndpointById = (id: string) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('secret could not be decrypted'));
      return realLookup(id);
    };

    const metrics = registryOf();
    const worker = new WebhookDeliveryWorker({
      repo: proxied,
      logger: createTestLogger(),
      fetch: fakeFetch({ status: 200 }),
      now: constNow,
      metrics,
    });

    const result = await worker.tickOnce();

    expect(result.claimed).toBe(2);
    expect(result.outcomes, 'both deliveries reported an outcome').toHaveLength(2);
    expect(
      result.outcomes.some((o) => o.kind === 'delivered'),
      'the healthy delivery still went out',
    ).toBe(true);
    // And the metrics were emitted rather than skipped by a rejected Promise.all.
    expect(deliverySamples(metrics).length).toBeGreaterThan(0);
  });
});
