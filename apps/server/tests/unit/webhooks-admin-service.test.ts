// Behavioral unit tests for WebhooksAdminService — the admin-only DLQ
// ops surface (GET delivery, replay, requeue-from-DLQ, discard-from-DLQ)
// behind /v1/admin/webhook-deliveries|webhook-dlq.
//
// Closes a real coverage gap: discardFromDlq is a DESTRUCTIVE hard-delete
// and had zero behavioral coverage (the stub comment in
// webhooks-service.test.ts referenced a "services-webhooks-discard" file
// that never existed). The highest-value case here is the documented
// race-safety contract — the repo DELETE is status-matched (id AND
// status='dlq'), so if a concurrent requeue flips the row to 'pending'
// between the service's findDeliveryById check and the delete, the delete
// matches 0 rows and the service surfaces NotFound rather than
// hard-deleting a now-active delivery. (The repo-side AND status='dlq'
// clause itself is pinned by db-webhooks-repo-content-parity.)

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import {
  WebhooksAdminService,
  type WebhookDeliveryRow,
  type WebhooksRepo,
} from '../../src/services/webhooks.js';
import type { AccountContext } from '../../src/services/auth.js';
import { ConflictError, NotFoundError, ForbiddenError } from '../../src/lib/errors.js';

function ctxWith(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: { id: 'acc_admin' },
    apiKey: { id: 'key_admin', scopes },
  } as unknown as AccountContext;
}
const ADMIN = ctxWith(['driftstack_internal_admin']);

function deliveryRow(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: 'd-1',
    webhookId: 'wh-1',
    eventId: 'evt_1',
    eventType: 'session.completed',
    payload: {},
    status: 'dlq',
    attempts: 5,
    nextAttemptAt: new Date('2026-05-22Z'),
    lastResponseStatus: 500,
    lastResponseExcerpt: 'upstream 500',
    lastError: 'max attempts',
    deliveredAt: null,
    createdAt: new Date('2026-05-20Z'),
    updatedAt: new Date('2026-05-22Z'),
    ...overrides,
  };
}

// Minimal WebhooksRepo with STATEFUL delivery handling. deleteDelivery
// faithfully models the production status-matched DELETE (only removes a
// row whose CURRENT status is 'dlq'); resetDeliveryToPending updates by
// id regardless of status (mirrors the real repo). Endpoint methods are
// no-op stubs — this suite only exercises the delivery/DLQ surface.
function makeRepo(rows: WebhookDeliveryRow[] = []): {
  repo: WebhooksRepo;
  rows: WebhookDeliveryRow[];
} {
  const store: WebhookDeliveryRow[] = [...rows];
  const repo = {
    // Returns a COPY (the real repo maps each DB row to a fresh object via
    // toDeliveryRow), so a caller holding the result sees a point-in-time
    // snapshot — not the live store row.
    findDeliveryById: (id: string) => {
      const row = store.find((r) => r.id === id);
      return Promise.resolve(row ? { ...row } : null);
    },
    resetDeliveryToPending: (id: string, at: Date) => {
      const row = store.find((r) => r.id === id);
      if (!row) return Promise.resolve(null);
      row.status = 'pending';
      row.attempts = 0;
      row.nextAttemptAt = at;
      row.updatedAt = at;
      return Promise.resolve({ ...row });
    },
    deleteDelivery: (id: string) => {
      // Status-matched: DELETE WHERE id AND status='dlq'.
      const idx = store.findIndex((r) => r.id === id && r.status === 'dlq');
      if (idx === -1) return Promise.resolve(false);
      store.splice(idx, 1);
      return Promise.resolve(true);
    },
    listDlqDeliveries: () => Promise.resolve({ items: [], nextCursor: null }),
    countDlqDeliveries: () => Promise.resolve(0),
    // Unused-by-this-suite endpoint/delivery methods — stubs to satisfy WebhooksRepo.
    insertEndpoint: () => Promise.reject(new Error('unused')),
    listEndpoints: () => Promise.resolve([]),
    findEndpoint: () => Promise.resolve(null),
    countActiveEndpoints: () => Promise.resolve(0),
    disableEndpoint: () => Promise.resolve(),
    updateEndpoint: () => Promise.resolve(null),
    rotateSecret: () => Promise.resolve(null),
    deliveryCountsByEndpoint: () => Promise.resolve(new Map()),
    enqueueDelivery: () => Promise.resolve(randomUUID()),
    listEndpointsSubscribedTo: () => Promise.resolve([]),
    claim: () => Promise.resolve([]),
    findEndpointById: () => Promise.resolve(null),
    recordDelivered: () => Promise.resolve(),
    recordRetry: () => Promise.resolve(),
    recordDlq: () => Promise.resolve(),
    listDeliveriesForEndpoint: () => Promise.resolve({ items: [], nextCursor: null }),
    findEndpointsNeedingForceRotation: () => Promise.resolve([]),
    forceRotateSecret: () => Promise.resolve(null),
    clearStaleSecretPrev: () => Promise.resolve({ cleared: 0 }),
  } as unknown as WebhooksRepo;
  return { repo, rows: store };
}

describe('WebhooksAdminService.getDelivery', () => {
  it('returns the row by bare uuid', async () => {
    const { repo } = makeRepo([deliveryRow()]);
    const svc = new WebhooksAdminService(repo);
    const row = await svc.getDelivery(ADMIN, 'd-1');
    expect(row.id).toBe('d-1');
  });

  it('throws NotFound on unknown id', async () => {
    const svc = new WebhooksAdminService(makeRepo().repo);
    await expect(svc.getDelivery(ADMIN, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requires driftstack_internal_admin scope', async () => {
    const svc = new WebhooksAdminService(makeRepo([deliveryRow()]).repo);
    await expect(svc.getDelivery(ctxWith(['account_owner']), 'd-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('WebhooksAdminService.replayDelivery', () => {
  it('resets ANY status back to pending', async () => {
    const { repo, rows } = makeRepo([deliveryRow({ status: 'failed' })]);
    const svc = new WebhooksAdminService(repo);
    const updated = await svc.replayDelivery(ADMIN, 'd-1');
    expect(updated.status).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
  });

  it('throws NotFound on unknown id', async () => {
    const svc = new WebhooksAdminService(makeRepo().repo);
    await expect(svc.replayDelivery(ADMIN, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('WebhooksAdminService.requeueFromDlq', () => {
  it('resets a DLQ row to pending', async () => {
    const { repo, rows } = makeRepo([deliveryRow({ status: 'dlq' })]);
    const svc = new WebhooksAdminService(repo);
    const updated = await svc.requeueFromDlq(ADMIN, 'd-1');
    expect(updated.status).toBe('pending');
    expect(rows[0]?.status).toBe('pending');
  });

  it('rejects a non-DLQ row with ConflictError (points at the replay route)', async () => {
    const svc = new WebhooksAdminService(makeRepo([deliveryRow({ status: 'pending' })]).repo);
    await expect(svc.requeueFromDlq(ADMIN, 'd-1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws NotFound on unknown id', async () => {
    const svc = new WebhooksAdminService(makeRepo().repo);
    await expect(svc.requeueFromDlq(ADMIN, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  // The SYMMETRIC race for requeue. `discardFromDlq` has this arm (above);
  // `requeueFromDlq` did not, though it has the same read-then-act shape and the
  // same window. Here a concurrent `discardFromDlq` hard-deletes the row after the
  // service has read status='dlq' but before the reset runs, so
  // `resetDeliveryToPending` matches 0 rows and returns null.
  //
  // The source guards that with `throw new NotFoundError('… disappeared mid-requeue')`
  // under a comment claiming `updated` is "guaranteed non-null because we just found
  // the row above". It is not guaranteed — finding the row does not make the reset
  // succeed — and this arm is the counterexample. Without the guard the method
  // returns null where its signature promises a row.
  it('surfaces NotFound when the row is discarded between the DLQ check and the reset', async () => {
    const store = makeRepo([deliveryRow({ status: 'dlq' })]);
    const svc = new WebhooksAdminService(store.repo);
    const realFind = store.repo.findDeliveryById.bind(store.repo);
    store.repo.findDeliveryById = (id: string) => {
      const snapshot = realFind(id); // a COPY, so it survives the delete below
      const at = store.rows.findIndex((r) => r.id === id);
      if (at >= 0) store.rows.splice(at, 1); // concurrent discard wins the race
      return snapshot; // service still sees the stale dlq snapshot
    };
    await expect(svc.requeueFromDlq(ADMIN, 'd-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(store.rows, 'the row stays gone — requeue must not resurrect it').toHaveLength(0);
  });
});

describe('WebhooksAdminService.discardFromDlq', () => {
  it('hard-deletes a DLQ row and returns its id', async () => {
    const { repo, rows } = makeRepo([deliveryRow({ status: 'dlq' })]);
    const svc = new WebhooksAdminService(repo);
    const result = await svc.discardFromDlq(ADMIN, 'd-1');
    expect(result).toEqual({ discarded_id: 'd-1' });
    expect(rows).toHaveLength(0);
  });

  it('rejects a non-DLQ row with ConflictError (cannot discard an active delivery)', async () => {
    const { repo, rows } = makeRepo([deliveryRow({ status: 'in_flight' })]);
    const svc = new WebhooksAdminService(repo);
    await expect(svc.discardFromDlq(ADMIN, 'd-1')).rejects.toBeInstanceOf(ConflictError);
    expect(rows).toHaveLength(1); // not deleted
  });

  it('throws NotFound on unknown id', async () => {
    const svc = new WebhooksAdminService(makeRepo().repo);
    await expect(svc.discardFromDlq(ADMIN, 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  // The race-safety contract: the service reads status='dlq', then a
  // concurrent requeue flips the row to 'pending' before the delete runs.
  // The status-matched repo DELETE matches 0 rows → returns false → the
  // service surfaces NotFound ("disappeared mid-discard") instead of
  // hard-deleting the now-active delivery.
  it('surfaces NotFound (not a silent delete) when the row leaves DLQ between check and delete', async () => {
    const store = makeRepo([deliveryRow({ status: 'dlq' })]);
    const svc = new WebhooksAdminService(store.repo);
    // Simulate the concurrent requeue landing in the TOCTOU window by
    // flipping the row to pending right after the service's read would see dlq.
    const realFind = store.repo.findDeliveryById.bind(store.repo);
    store.repo.findDeliveryById = (id: string) => {
      const snapshot = realFind(id);
      const live = store.rows.find((r) => r.id === id);
      if (live) live.status = 'pending'; // concurrent requeue wins the race
      return snapshot; // service still sees the stale dlq snapshot
    };
    await expect(svc.discardFromDlq(ADMIN, 'd-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(store.rows).toHaveLength(1); // active delivery preserved, NOT hard-deleted
    expect(store.rows[0]?.status).toBe('pending');
  });

  it('requires driftstack_internal_admin scope', async () => {
    const svc = new WebhooksAdminService(makeRepo([deliveryRow()]).repo);
    await expect(svc.discardFromDlq(ctxWith(['account_owner']), 'd-1')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
