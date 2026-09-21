// ⛔ THE WEBHOOK PAYLOAD IS A STORED ROW, SO "MAP ON THE WAY OUT" HAS TO MEAN
// THE WAY OUT OF THE WORKER — not the way out of the enqueue call.
//
// `egress_capabilities.warnings` is mapped from the internal vocabulary onto
// the closed public one by `customerSafeEgressWarnings`, and the claim that
// covers OLD DATA is that the mapping is a READ: a row written a year ago maps
// the same as one written this second. That claim holds for
// `sessions.egress_capabilities`, which is read on every response.
//
// It does NOT hold for `webhook_deliveries.payload`. That column holds a
// SERIALIZED COPY of the event, written at enqueue time, and
// `WebhookDeliveryWorker.deliverInner` sends it with
// `JSON.stringify(delivery.payload)` — verbatim, whatever is in it. So every
// `session.egress_capability_changed` row enqueued before the mapping landed
// still carries the INTERNAL list, including the device-supplied
// `safeguard_failed:<layer>` open string, and three paths re-send it:
//
//   • `POST /v1/webhook-deliveries/:id/replay` — the CUSTOMER's own
//     self-service replay, which resets any of their retained deliveries to
//     pending and hands it straight back to this worker;
//   • `POST /v1/admin/webhook-deliveries/:id/replay` — an operator replaying a
//     customer's delivery, which posts to the CUSTOMER's endpoint;
//   • ordinary retry of a row that was pending or failed when the mapping
//     deployed.
//
// It is also the standing guard for a SECOND enqueue path: the mapping today
// lives in `SessionsService.ingestEgressCapabilityReport`, so a future caller
// that enqueues this event without mapping would publish the internal list, and
// nothing between it and the customer would notice. This test watches the last
// hop, where every one of those cases has to pass.

import { describe, expect, it, vi } from 'vitest';

import { createTestLogger } from '../../src/lib/logger.js';
import { WebhookDeliveryWorker } from '../../src/services/webhook-worker.js';
import { PUBLIC_EGRESS_WARNINGS } from '../../src/services/customer-safe-egress-warnings.js';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';

const NOW = new Date('2026-09-21T12:00:00Z');
const constNow = (): Date => NOW;

/**
 * The internal list exactly as `deriveWarnings` builds it, plus the two things
 * the mapping exists to stop: a hostile device-supplied layer and a code nobody
 * has classified. This is the shape a pre-change row holds.
 */
const STORED_INTERNAL_WARNINGS = [
  'udp_unsupported_by_proxy',
  'h3_interpose_unavailable',
  'safeguards_unreported',
  'safeguard_failed:screen_recording',
  'safeguard_failed:../../x <script>relay-07.fleet.internal:1080',
  'safeguard_missing:webkit_gate',
  'safeguards_expectation_unreported',
  'streaming_failed',
  'dead_proxy',
  'a_code_nobody_has_classified',
];

/** Fragments that must not appear anywhere in the outbound body. Each names an
 *  internal mechanism, a device-chosen string, or an unclassified code. */
const INTERNAL_FRAGMENTS = [
  'h3_interpose_unavailable',
  'interpose',
  'safeguards_unreported',
  'safeguards_expectation_unreported',
  'safeguard_missing',
  'screen_recording',
  'webkit_gate',
  'network_firewall',
  'per_spawn_verification',
  'fleet.internal',
  '<script>',
  'a_code_nobody_has_classified',
];

function capturingFetch(): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  // The body is what this file is about, so it is captured here rather than
  // asserted on a mock's recorded call args: `fetch` is called with a
  // RequestInit, and reading `.body` back off a stored reference is one
  // indirection further from what actually went on the wire.
  const fetchImpl: typeof fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    await Promise.resolve();
    bodies.push(typeof init?.body === 'string' ? init.body : String(init?.body));
    return new Response('ok', { status: 200 });
  });
  return { fetch: fetchImpl, bodies };
}

async function deliverStoredPayload(payload: Record<string, unknown>): Promise<string> {
  const repo = new InMemoryWebhooksRepo();
  const endpoint = await repo.insertEndpoint({
    accountId: 'acc-1',
    url: 'https://customer.test/hook',
    secret: 'whsec_testaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrefix: 'whsec_test_t',
    events: ['session.egress_capability_changed'],
    description: null,
  });
  await repo.enqueueDelivery({
    webhookId: endpoint.id,
    eventId: '11111111-2222-3333-4444-555555555555',
    eventType: 'session.egress_capability_changed',
    payload,
    nextAttemptAt: NOW,
  });
  const { fetch: fetchImpl, bodies } = capturingFetch();
  const worker = new WebhookDeliveryWorker({
    repo,
    logger: createTestLogger(),
    fetch: fetchImpl,
    now: constNow,
  });
  await worker.tickOnce();
  expect(bodies).toHaveLength(1);
  return bodies[0] as string;
}

function storedEgressPayload(warnings: readonly string[]): Record<string, unknown> {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    type: 'session.egress_capability_changed',
    created_at: '2026-05-01T00:00:00.000Z',
    data: {
      session_id: 'ses_11111111-2222-3333-4444-555555555555',
      egress_capabilities: {
        udp_associate: false,
        quic_route: 'disabled',
        dns_remote_resolve: false,
        warnings: [...warnings],
      },
    },
  };
}

describe('a replayed egress delivery cannot re-send the internal vocabulary', () => {
  it('CRITICAL a delivery row persisted with the INTERNAL warning list goes out mapped. The customer replay route re-fires any retained delivery, so an un-mapped stored payload is a leak the customer can trigger themselves, indefinitely.', async () => {
    const body = await deliverStoredPayload(storedEgressPayload(STORED_INTERNAL_WARNINGS));

    for (const fragment of INTERNAL_FRAGMENTS) {
      expect(body, `outbound webhook body leaked ${fragment}`).not.toContain(fragment);
    }
  });

  it('CRITICAL the mapped list is the closed public vocabulary and nothing else — the containment invariant, asserted over what actually went on the wire rather than over the mapper.', async () => {
    const body = await deliverStoredPayload(storedEgressPayload(STORED_INTERNAL_WARNINGS));
    const sent = JSON.parse(body) as {
      data: { egress_capabilities: { warnings: string[] } };
    };

    expect(sent.data.egress_capabilities.warnings).toEqual([
      'udp_unsupported_by_proxy',
      'quic_unavailable',
      'safeguards_unverified',
      'safeguard_failed:live_view_capture',
      'safeguard_failed',
      'streaming_failed',
      'dead_proxy',
    ]);
    for (const code of sent.data.egress_capabilities.warnings) {
      expect(PUBLIC_EGRESS_WARNINGS).toContain(code);
    }
  });

  it('carries the rest of the payload through untouched — the mapping is scoped to `warnings`, so a fix here must not quietly reshape the event a customer parses.', async () => {
    const body = await deliverStoredPayload(storedEgressPayload(['dead_proxy']));
    const sent = JSON.parse(body) as Record<string, unknown>;

    expect(sent).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      type: 'session.egress_capability_changed',
      created_at: '2026-05-01T00:00:00.000Z',
      data: {
        session_id: 'ses_11111111-2222-3333-4444-555555555555',
        egress_capabilities: {
          udp_associate: false,
          quic_route: 'disabled',
          dns_remote_resolve: false,
          warnings: ['dead_proxy'],
        },
      },
    });
  });

  it('TOTAL over a malformed stored payload — a row whose `data` is missing, null, or not an object still delivers, because a projection that throws here strands a delivery in flight.', async () => {
    for (const payload of [
      { id: 'e1', type: 'session.egress_capability_changed', created_at: 'x' },
      { id: 'e1', type: 'session.egress_capability_changed', data: null },
      { id: 'e1', type: 'session.egress_capability_changed', data: 'not-an-object' },
      {
        id: 'e1',
        type: 'session.egress_capability_changed',
        data: { session_id: 's', egress_capabilities: null },
      },
      {
        id: 'e1',
        type: 'session.egress_capability_changed',
        data: { session_id: 's', egress_capabilities: { warnings: 'not-an-array' } },
      },
    ] as Record<string, unknown>[]) {
      const body = await deliverStoredPayload(payload);
      expect(() => JSON.parse(body) as unknown).not.toThrow();
    }
  });

  it('leaves an unrelated event type byte-identical — the projection keys off the event type, so `session.completed` must be untouched even when its data happens to carry a `warnings` key.', async () => {
    const payload = {
      id: 'e2',
      type: 'session.completed',
      created_at: '2026-05-01T00:00:00.000Z',
      data: { session_id: 'ses_x', egress_capabilities: { warnings: ['anything_at_all'] } },
    };
    const repo = new InMemoryWebhooksRepo();
    const endpoint = await repo.insertEndpoint({
      accountId: 'acc-1',
      url: 'https://customer.test/hook',
      secret: 'whsec_testaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretPrefix: 'whsec_test_t',
      events: ['session.completed'],
      description: null,
    });
    await repo.enqueueDelivery({
      webhookId: endpoint.id,
      eventId: '22222222-2222-3333-4444-555555555555',
      eventType: 'session.completed',
      payload,
      nextAttemptAt: NOW,
    });
    const { fetch: fetchImpl, bodies } = capturingFetch();
    const worker = new WebhookDeliveryWorker({
      repo,
      logger: createTestLogger(),
      fetch: fetchImpl,
      now: constNow,
    });
    await worker.tickOnce();

    expect(bodies[0]).toBe(JSON.stringify(payload));
  });
});
