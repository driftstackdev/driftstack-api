// V-553.B-14 — unit tests for WebhooksService customer-facing CRUD
// + secret rotation paths (V-225 / V-326e5 / V-351 / V-359).
//
// Scope: create / get / update / delete / rotateSecret. The fan-out
// path (enqueueEvent) + admin requeue/replay surfaces are covered by
// the existing route-level integration tests; this suite pins the
// service-layer contract on the operations a customer can perform.

import { describe, expect, it, vi } from 'vitest';
import type { ApiKeyScope } from '@driftstack/api-types';
import {
  WebhooksService,
  type WebhookEndpointRow,
  type WebhookEventType,
  type WebhooksRepo,
  type EndpointDeliveryCounts,
} from '../../src/services/webhooks.js';
import type { AccountContext } from '../../src/services/auth.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';

function ctxWith(scopes: ApiKeyScope[], accountId = 'acc_1'): AccountContext {
  return {
    account: { id: accountId },
    apiKey: { id: 'key_1', scopes },
  } as unknown as AccountContext;
}

function baseRow(overrides: Partial<WebhookEndpointRow> = {}): WebhookEndpointRow {
  return {
    id: 'wh_1',
    accountId: 'acc_1',
    url: 'https://hooks.example/a',
    secret: 'whsec_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrefix: 'whsec_v1_aaaa',
    secretPrev: null,
    secretPrevExpiresAt: null,
    secretCreatedAt: new Date('2026-05-01Z'),
    lastReminderSentAt: null,
    // Arc 3 sub-slice 28.1 (v2-#28) server-initiated force-rotation
    // fields — null when no force-rotate in flight; suite doesn't
    // exercise the path but the row shape requires them.
    graceWindowEndsAt: null,
    forceRotatedAt: null,
    events: ['session.completed'],
    description: null,
    active: true,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    disabledAt: null,
    createdAt: new Date('2026-05-01Z'),
    updatedAt: new Date('2026-05-01Z'),
    ...overrides,
  };
}

function makeRepo(initial: WebhookEndpointRow[] = []): {
  repo: WebhooksRepo;
  rows: WebhookEndpointRow[];
} {
  const rows: WebhookEndpointRow[] = [...initial];
  const repo: WebhooksRepo = {
    insertEndpoint: (input) => {
      const row = baseRow({
        id: `wh_${(rows.length + 1).toString()}`,
        accountId: input.accountId,
        url: input.url,
        secret: input.secret,
        secretPrefix: input.secretPrefix,
        events: input.events,
        description: input.description,
      });
      rows.push(row);
      return Promise.resolve(row);
    },
    listEndpoints: (accountId) => Promise.resolve(rows.filter((r) => r.accountId === accountId)),
    findEndpoint: (id, accountId) =>
      Promise.resolve(rows.find((r) => r.id === id && r.accountId === accountId) ?? null),
    countActiveEndpoints: (accountId) =>
      Promise.resolve(
        rows.filter((r) => r.accountId === accountId && r.disabledAt === null).length,
      ),
    disableEndpoint: (id, at) => {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.disabledAt = at;
        row.active = false;
      }
      return Promise.resolve();
    },
    updateEndpoint: (input) => {
      const row = rows.find((r) => r.id === input.id && r.accountId === input.accountId);
      if (!row) return Promise.resolve(null);
      if (input.url !== undefined) row.url = input.url;
      if (input.events !== undefined) row.events = input.events;
      if (input.description !== undefined) row.description = input.description;
      if (input.active !== undefined) row.active = input.active;
      row.updatedAt = new Date();
      return Promise.resolve(row);
    },
    rotateSecret: ({ id, accountId, newSecret, newPrefix, graceExpiresAt, now }) => {
      const row = rows.find((r) => r.id === id && r.accountId === accountId);
      if (!row) return Promise.resolve(null);
      row.secretPrev = row.secret;
      row.secretPrevExpiresAt = graceExpiresAt;
      row.secret = newSecret;
      row.secretPrefix = newPrefix;
      row.updatedAt = now;
      return Promise.resolve(row);
    },
    deliveryCountsByEndpoint: () => Promise.resolve(new Map<string, EndpointDeliveryCounts>()),
    enqueueDelivery: () => Promise.resolve(),
    listEndpointsSubscribedTo: () => Promise.resolve([]),
    claim: () => Promise.resolve([]),
    findEndpointById: () => Promise.resolve(null),
    recordDelivered: () => Promise.resolve(),
    recordRetry: () => Promise.resolve(),
    recordDlq: () => Promise.resolve(),
    listDeliveriesForEndpoint: () => Promise.resolve({ items: [], nextCursor: null }),
    findDeliveryById: () => Promise.resolve(null),
    listDlqDeliveries: () => Promise.resolve({ items: [], nextCursor: null }),
    countDlqDeliveries: () => Promise.resolve(0),
    resetDeliveryToPending: () => Promise.resolve(null),
    // Arc 3 sub-slice 28.x (v2-#28) — server-initiated force-rotation
    // surface. Not exercised by the V-553.B-14 create/update suite;
    // no-op stubs to satisfy the WebhooksRepo interface.
    findEndpointsNeedingForceRotation: () => Promise.resolve([]),
    forceRotateSecret: () => Promise.resolve(null),
    clearStaleSecretPrev: () => Promise.resolve({ cleared: 0 }),
  };
  return { repo, rows };
}

function makeAudit(): { audit: AccountAuditService; calls: { action: string }[] } {
  const calls: { action: string }[] = [];
  const audit = {
    record: (args: { action: string }) => {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as AccountAuditService;
  return { audit, calls };
}

const BASE_CREATE = {
  url: 'https://hooks.example/inbound',
  events: ['session.completed' as WebhookEventType],
  description: null,
};

describe('V-553.B-14 WebhooksService.create', () => {
  it('requires admin scope on the calling key', async () => {
    const { repo } = makeRepo();
    const svc = new WebhooksService(repo);
    await expect(svc.create(ctxWith(['read']), BASE_CREATE)).rejects.toThrow(/admin/);
  });

  it('mints a plaintext secret + persists a row + records audit', async () => {
    const { repo, rows } = makeRepo();
    const { audit, calls } = makeAudit();
    const svc = new WebhooksService(repo, audit);
    const result = await svc.create(ctxWith(['admin']), BASE_CREATE);
    expect(result.plaintextSecret).toMatch(/^whsec_/);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://hooks.example/inbound');
    expect(rows[0]?.secret).toBe(result.plaintextSecret);
    expect(calls.map((c) => c.action)).toEqual(['webhook_endpoint.created']);
  });

  it('rejects empty events list', async () => {
    const { repo } = makeRepo();
    const svc = new WebhooksService(repo);
    await expect(svc.create(ctxWith(['admin']), { ...BASE_CREATE, events: [] })).rejects.toThrow(
      /events must contain/,
    );
  });

  it('rejects non-HTTPS URLs', async () => {
    const { repo } = makeRepo();
    const svc = new WebhooksService(repo);
    await expect(
      svc.create(ctxWith(['admin']), { ...BASE_CREATE, url: 'http://hooks.example' }),
    ).rejects.toThrow();
  });

  it('enforces the 10-endpoint-per-account cap', async () => {
    const existing: WebhookEndpointRow[] = Array.from({ length: 10 }, (_, i) =>
      baseRow({ id: `wh_${i.toString()}`, url: `https://hooks.example/${i.toString()}` }),
    );
    const { repo } = makeRepo(existing);
    const svc = new WebhooksService(repo);
    await expect(svc.create(ctxWith(['admin']), BASE_CREATE)).rejects.toThrow(/limit is 10/);
  });

  it('honours V-326e5 effectiveAccountId — writes to OWNER without requiring admin scope', async () => {
    const { repo, rows } = makeRepo();
    const svc = new WebhooksService(repo);
    // Caller has only account_owner; effectiveAccountId is OWNER's id.
    await svc.create(ctxWith(['account_owner'], 'acc_member'), BASE_CREATE, {
      effectiveAccountId: 'acc_owner',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe('acc_owner');
  });
});

describe('V-553.B-14 WebhooksService.get', () => {
  it('returns the row when account-scope matches', async () => {
    const row = baseRow();
    const { repo } = makeRepo([row]);
    const svc = new WebhooksService(repo);
    const result = await svc.get(ctxWith(['read']), 'wh_1');
    expect(result.id).toBe('wh_1');
  });

  it('throws NotFound when account-scope does not match', async () => {
    const row = baseRow({ accountId: 'acc_other' });
    const { repo } = makeRepo([row]);
    const svc = new WebhooksService(repo);
    await expect(svc.get(ctxWith(['read']), 'wh_1')).rejects.toThrow(/not found/);
  });
});

describe('V-553.B-14 WebhooksService.update', () => {
  it('requires admin scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.update(ctxWith(['read']), 'wh_1', { url: 'https://x.test' })).rejects.toThrow(
      /admin/,
    );
  });

  it('rejects updating a disabled endpoint', async () => {
    const row = baseRow({ disabledAt: new Date(), active: false });
    const { repo } = makeRepo([row]);
    const svc = new WebhooksService(repo);
    await expect(svc.update(ctxWith(['admin']), 'wh_1', { url: 'https://x.test' })).rejects.toThrow(
      /disabled endpoint/,
    );
  });

  it('patches the row + records audit on success', async () => {
    const { repo, rows } = makeRepo([baseRow()]);
    const { audit, calls } = makeAudit();
    const svc = new WebhooksService(repo, audit);
    const result = await svc.update(ctxWith(['admin']), 'wh_1', {
      url: 'https://hooks.example/v2',
      events: ['session.completed', 'session.failed'],
    });
    expect(result.url).toBe('https://hooks.example/v2');
    expect(rows[0]?.events).toEqual(['session.completed', 'session.failed']);
    expect(calls.map((c) => c.action)).toEqual(['webhook_endpoint.updated']);
  });

  it('rejects update that empties the events list', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.update(ctxWith(['admin']), 'wh_1', { events: [] })).rejects.toThrow(
      /events must contain/,
    );
  });
});

describe('V-553.B-14 WebhooksService.delete', () => {
  it('requires admin scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.delete(ctxWith(['write']), 'wh_1')).rejects.toThrow(/admin/);
  });

  it('soft-deletes by setting disabledAt + records audit', async () => {
    const { repo, rows } = makeRepo([baseRow()]);
    const { audit, calls } = makeAudit();
    const svc = new WebhooksService(repo, audit);
    await svc.delete(ctxWith(['admin']), 'wh_1');
    expect(rows[0]?.disabledAt).not.toBeNull();
    expect(rows[0]?.active).toBe(false);
    expect(calls.map((c) => c.action)).toEqual(['webhook_endpoint.deleted']);
  });

  it('is idempotent on already-disabled endpoints (no extra audit)', async () => {
    const { repo } = makeRepo([baseRow({ disabledAt: new Date(), active: false })]);
    const { audit, calls } = makeAudit();
    const svc = new WebhooksService(repo, audit);
    await svc.delete(ctxWith(['admin']), 'wh_1');
    expect(calls).toEqual([]);
  });

  it('throws NotFound on unknown id', async () => {
    const { repo } = makeRepo();
    const svc = new WebhooksService(repo);
    await expect(svc.delete(ctxWith(['admin']), 'wh_missing')).rejects.toThrow(/not found/);
  });
});

describe('V-553.B-14 WebhooksService.rotateSecret', () => {
  it('requires admin scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.rotateSecret(ctxWith(['read']), 'wh_1')).rejects.toThrow(/admin/);
  });

  it('rejects rotation on a disabled endpoint', async () => {
    const { repo } = makeRepo([baseRow({ disabledAt: new Date(), active: false })]);
    const svc = new WebhooksService(repo);
    await expect(svc.rotateSecret(ctxWith(['admin']), 'wh_1')).rejects.toThrow(/disabled endpoint/);
  });

  it('sets secretPrev to the OLD secret + writes the new plaintext + records audit', async () => {
    const oldSecret = 'whsec_v1_OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOL';
    const { repo, rows } = makeRepo([
      baseRow({ secret: oldSecret, secretPrefix: 'whsec_v1_OLDO' }),
    ]);
    const { audit, calls } = makeAudit();
    const svc = new WebhooksService(repo, audit);
    const result = await svc.rotateSecret(ctxWith(['admin']), 'wh_1');
    expect(result.plaintextSecret).toMatch(/^whsec_/);
    expect(result.plaintextSecret).not.toBe(oldSecret);
    expect(rows[0]?.secretPrev).toBe(oldSecret);
    expect(rows[0]?.secretPrevExpiresAt).not.toBeNull();
    expect(rows[0]?.secret).toBe(result.plaintextSecret);
    expect(calls.map((c) => c.action)).toEqual(['webhook_endpoint.secret_rotated']);
  });

  it('honours custom graceMs override (1h instead of 24h default)', async () => {
    const { repo, rows } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const before = Date.now();
    await svc.rotateSecret(ctxWith(['admin']), 'wh_1', { graceMs: 60 * 60 * 1000 });
    const expiresAt = rows[0]?.secretPrevExpiresAt;
    if (!expiresAt) throw new Error('missing expiry');
    // ~1 hour window, allow ±5 seconds of jitter for execution.
    const diff = expiresAt.getTime() - before;
    expect(diff).toBeGreaterThan(59 * 60 * 1000);
    expect(diff).toBeLessThan(61 * 60 * 1000);
  });
});

describe('V-553.B-14 WebhooksService.listWithCounts', () => {
  it('returns endpoints zipped with their delivery counts (zeros when none)', async () => {
    const rows: WebhookEndpointRow[] = [
      baseRow({ id: 'wh_1', url: 'https://a.test' }),
      baseRow({ id: 'wh_2', url: 'https://b.test' }),
    ];
    const { repo } = makeRepo(rows);
    // Override deliveryCountsByEndpoint to seed counts for wh_1.
    const countsMap = new Map<string, EndpointDeliveryCounts>([
      ['wh_1', { delivered: 5, failed: 1, dlq: 0 }],
    ]);
    (
      repo as unknown as { deliveryCountsByEndpoint: () => Promise<typeof countsMap> }
    ).deliveryCountsByEndpoint = vi.fn(() => Promise.resolve(countsMap));
    const svc = new WebhooksService(repo);
    const result = await svc.listWithCounts(ctxWith(['read']));
    expect(result).toHaveLength(2);
    expect(result[0]?.counts).toEqual({ delivered: 5, failed: 1, dlq: 0 });
    expect(result[1]?.counts).toEqual({ delivered: 0, failed: 0, dlq: 0 });
  });
});
