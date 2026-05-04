import { describe, expect, it } from 'vitest';
import {
  MockDlqManager,
  MockWebhookDeliveryService,
  type DeliveryEndpoint,
  type DeliveryPayload,
  type DlqEntry,
} from '../src/index.js';

const ENDPOINT: DeliveryEndpoint = {
  id: 'whk_test_endpoint',
  accountId: 'acc_test',
  url: 'https://hooks.example.test/driftstack',
  eventTypes: ['session.completed'],
  signingSecret: 'whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  active: true,
};

const PAYLOAD: DeliveryPayload = {
  eventId: '00000000-0000-0000-0000-000000000001',
  eventType: 'session.completed',
  emittedAtSec: 1714867200,
  body: '{"event":"session.completed","data":{}}',
};

describe('MockWebhookDeliveryService', () => {
  it('enqueue resolves to a delivered record on the first attempt', async () => {
    const service = new MockWebhookDeliveryService();
    const record = await service.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    expect(record.id).toMatch(/^mock_del_/);
    expect(record.status).toBe('delivered');
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]?.outcome).toBe('success');
    expect(record.attempts[0]?.responseStatus).toBe(200);
    expect(record.nextAttemptAtMs).toBeNull();
    expect(record.completedAtMs).not.toBeNull();
  });

  it('get returns the previously-enqueued record', async () => {
    const service = new MockWebhookDeliveryService();
    const enqueued = await service.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const retrieved = await service.get(enqueued.id);
    expect(retrieved).toEqual(enqueued);
  });

  it('get returns null for unknown id', async () => {
    const service = new MockWebhookDeliveryService();
    expect(await service.get('mock_del_nonexistent')).toBeNull();
  });

  it('list filters by endpointId + status', async () => {
    const service = new MockWebhookDeliveryService();
    await service.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    await service.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });

    const all = await service.list({ endpointId: ENDPOINT.id });
    expect(all.data).toHaveLength(2);

    const delivered = await service.list({ endpointId: ENDPOINT.id, status: 'delivered' });
    expect(delivered.data).toHaveLength(2);

    const pending = await service.list({ endpointId: ENDPOINT.id, status: 'pending' });
    expect(pending.data).toHaveLength(0);
  });

  it('list scopes to the queried endpoint', async () => {
    const service = new MockWebhookDeliveryService();
    await service.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });

    const otherEndpoint = { ...ENDPOINT, id: 'whk_other' };
    const otherList = await service.list({ endpointId: otherEndpoint.id });
    expect(otherList.data).toHaveLength(0);
  });

  it('replay appends a new attempt to an existing record', async () => {
    const service = new MockWebhookDeliveryService();
    const enqueued = await service.enqueue({ endpoint: ENDPOINT, payload: PAYLOAD });
    const replayed = await service.replay(enqueued.id);
    expect(replayed.attempts).toHaveLength(2);
    expect(replayed.attempts[1]?.attempt).toBe(2);
    expect(replayed.status).toBe('delivered');
  });

  it('replay rejects unknown id', async () => {
    const service = new MockWebhookDeliveryService();
    await expect(service.replay('mock_del_does_not_exist')).rejects.toThrow('not found');
  });
});

describe('MockDlqManager', () => {
  function sampleDlqEntry(deliveryId: string): DlqEntry {
    return {
      deliveryId,
      endpointId: ENDPOINT.id,
      accountId: ENDPOINT.accountId,
      payload: PAYLOAD,
      totalAttempts: 5,
      attempts: [
        {
          attempt: 5,
          completedAtMs: 1714867500000,
          responseStatus: null,
          responseExcerpt: null,
          durationMs: 10000,
          outcome: 'transport_error',
          errorMessage: 'ECONNREFUSED',
        },
      ],
      enteredDlqAtMs: 1714867500000,
      reason: '5× transport_error: ECONNREFUSED',
    };
  }

  it('list returns seeded entries; filters by accountId', async () => {
    const dlq = new MockDlqManager();
    dlq.seedEntry(sampleDlqEntry('mock_del_dlq_1'));
    dlq.seedEntry({ ...sampleDlqEntry('mock_del_dlq_2'), accountId: 'acc_other' });

    const all = await dlq.list({});
    expect(all.data).toHaveLength(2);

    const scoped = await dlq.list({ accountId: ENDPOINT.accountId });
    expect(scoped.data).toHaveLength(1);
    expect(scoped.data[0]?.deliveryId).toBe('mock_del_dlq_1');
  });

  it('get returns seeded entry by id', async () => {
    const dlq = new MockDlqManager();
    const entry = sampleDlqEntry('mock_del_dlq_get');
    dlq.seedEntry(entry);
    expect(await dlq.get('mock_del_dlq_get')).toEqual(entry);
    expect(await dlq.get('mock_del_dlq_unknown')).toBeNull();
  });

  it('requeue removes from DLQ + returns a pending DeliveryRecord', async () => {
    const dlq = new MockDlqManager();
    dlq.seedEntry(sampleDlqEntry('mock_del_requeue'));
    const requeued = await dlq.requeue({
      deliveryId: 'mock_del_requeue',
      reason: 'endpoint back online',
    });
    expect(requeued.status).toBe('pending');
    expect(requeued.attempts).toHaveLength(1); // attempt log preserved
    expect(await dlq.get('mock_del_requeue')).toBeNull(); // removed from DLQ
  });

  it('requeue rejects unknown id', async () => {
    const dlq = new MockDlqManager();
    await expect(dlq.requeue({ deliveryId: 'nope' })).rejects.toThrow('not found');
  });

  it('discard hard-deletes the entry', async () => {
    const dlq = new MockDlqManager();
    dlq.seedEntry(sampleDlqEntry('mock_del_discard'));
    await dlq.discard('mock_del_discard');
    expect(await dlq.get('mock_del_discard')).toBeNull();
  });

  it('discard on unknown id is a no-op (idempotent)', async () => {
    const dlq = new MockDlqManager();
    await expect(dlq.discard('nonexistent')).resolves.toBeUndefined();
  });
});
