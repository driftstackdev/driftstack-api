// V-553.B-14 — unit tests for WebhooksService customer-facing CRUD
// + secret rotation paths (V-225 / V-326e5 / V-351 / V-359).
//
// Scope: create / get / update / delete / rotateSecret. The fan-out
// path (enqueueEvent) + admin requeue/replay surfaces are covered by
// the existing route-level integration tests; this suite pins the
// service-layer contract on the operations a customer can perform.

import { randomUUID } from 'node:crypto';
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
    insertEndpointIfUnderLimit: (input, limit) => {
      const active = rows.filter(
        (r) => r.accountId === input.accountId && r.disabledAt === null,
      ).length;
      if (active >= limit) return Promise.resolve(null);
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
    // Webhooks audit #4 — only a paused → active transition is a cap decision.
    updateEndpointIfUnderLimit: async (input, limit) => {
      const row = rows.find((r) => r.id === input.id && r.accountId === input.accountId);
      if (!row || row.disabledAt !== null) return { row: null, overLimit: false };
      if (input.active === true && !row.active) {
        const others = rows.filter(
          (r) => r.accountId === input.accountId && r.disabledAt === null && r.id !== input.id,
        ).length;
        if (others >= limit) return { row: null, overLimit: true };
      }
      return { row: await repo.updateEndpoint(input), overLimit: false };
    },
    rotateSecret: ({ id, accountId, newSecret, newPrefix, graceExpiresAt, now }) => {
      const row = rows.find((r) => r.id === id && r.accountId === accountId);
      if (!row) return Promise.resolve(null);
      // Mirrors the real DrizzleWebhooksRepo CASEs: inside a live grace window
      // the prev slot (the secret the customer runs) is KEPT, and a customer
      // window keeps its expiry too (webhooks audit #7 — this used to be the
      // V-359.G no-op that the service turned into a 409).
      const liveGrace =
        row.secretPrev !== null &&
        row.secretPrevExpiresAt !== null &&
        row.secretPrevExpiresAt.getTime() > now.getTime();
      if (!liveGrace) row.secretPrev = row.secret;
      if (!liveGrace || row.forceRotatedAt !== null) row.secretPrevExpiresAt = graceExpiresAt;
      row.secret = newSecret;
      row.secretPrefix = newPrefix;
      row.forceRotatedAt = null;
      row.graceWindowEndsAt = null;
      row.updatedAt = now;
      return Promise.resolve(row);
    },
    deliveryCountsByEndpoint: () => Promise.resolve(new Map<string, EndpointDeliveryCounts>()),
    enqueueDelivery: () => Promise.resolve(randomUUID()),
    // Through `repo.enqueueDelivery`, so an arm that swaps that in sees each row.
    enqueueDeliveries: async (inputs) => {
      const ids: string[] = [];
      for (const input of inputs) ids.push(await repo.enqueueDelivery(input));
      return ids;
    },
    listEndpointsSubscribedTo: () => Promise.resolve([]),
    claim: () => Promise.resolve([]),
    recordDeferred: () => Promise.resolve(),
    findEndpointById: () => Promise.resolve(null),
    recordDelivered: () => Promise.resolve(),
    recordRetry: () => Promise.resolve(),
    recordDlq: () => Promise.resolve(),
    listDeliveriesForEndpoint: () => Promise.resolve({ items: [], nextCursor: null }),
    findDeliveryById: () => Promise.resolve(null),
    listDlqDeliveries: () => Promise.resolve({ items: [], nextCursor: null }),
    countDlqDeliveries: () => Promise.resolve(0),
    resetDeliveryToPending: () => Promise.resolve(null),
    // 2026-05-22 — DLQ hard-delete (admin discard). No-op stub for the
    // create/update suite; the dedicated discardFromDlq tests in
    // webhooks-admin-service.test.ts cover the contract (incl. race-safety).
    deleteDelivery: () => Promise.resolve(false),
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
  it('requires account_owner scope on the calling key (V-174 — admin still satisfies via alias)', async () => {
    const { repo } = makeRepo();
    const svc = new WebhooksService(repo);
    await expect(svc.create(ctxWith(['read']), BASE_CREATE)).rejects.toThrow(/account_owner/);
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
    await expect(svc.create(ctxWith(['admin']), BASE_CREATE)).rejects.toThrow(
      /already has 10 webhook endpoints/,
    );
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

describe('WebhooksService.enqueueEvent closed session-failure metadata', () => {
  it('projects session.failed before persistence and leaves unrelated event data unchanged', async () => {
    const endpoint = baseRow({
      events: ['session.failed', 'session.completed'],
    });
    const { repo } = makeRepo([endpoint]);
    const enqueued: Parameters<WebhooksRepo['enqueueDelivery']>[0][] = [];
    repo.listEndpointsSubscribedTo = () => Promise.resolve([endpoint]);
    repo.enqueueDelivery = (input) => {
      enqueued.push(input);
      return Promise.resolve(randomUUID());
    };
    const service = new WebhooksService(repo);
    const sentinel = 'PRIVATE_WEBHOOK_FAILURE_2dd8a1';

    await expect(
      service.enqueueEvent('acc_1', 'session.failed', {
        session_id: 'ses_00000000-0000-4000-8000-000000000001',
        duration_ms: 88,
        operation: 'navigate',
        error_name: 'DriverError',
        error_message: sentinel,
        nested: { secret: sentinel },
      }),
    ).resolves.toBe(1);
    expect(enqueued[0]).toMatchObject({
      webhookId: endpoint.id,
      eventType: 'session.failed',
      payload: {
        type: 'session.failed',
        data: {
          session_id: 'ses_00000000-0000-4000-8000-000000000001',
          duration_ms: 88,
          operation: 'navigate',
          error_name: 'DriverError',
          error_message: 'The browser operation failed.',
        },
      },
    });
    expect(JSON.stringify(enqueued[0])).not.toContain(sentinel);

    const completedData = { output: sentinel };
    await expect(service.enqueueEvent('acc_1', 'session.completed', completedData)).resolves.toBe(
      1,
    );
    expect(enqueued[1]).toMatchObject({
      webhookId: endpoint.id,
      eventType: 'session.completed',
      payload: { type: 'session.completed', data: completedData },
    });
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

  // V-553.B-21 — read:webhooks was completely unchecked (any authenticated
  // key, regardless of scope, could read a single endpoint's URL +
  // secretPrefix + delivery config). 'gui_control' is a real, narrow scope
  // that satisfies neither bare 'read' nor the broad-satisfies-granular
  // rule, so it must not be able to read webhook endpoints.
  it('rejects callers without read:webhooks (or a satisfying broad scope)', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.get(ctxWith(['gui_control']), 'wh_1')).rejects.toThrow(/read:webhooks/);
  });

  it('allows a caller holding the granular read:webhooks scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const result = await svc.get(ctxWith(['read:webhooks']), 'wh_1');
    expect(result.id).toBe('wh_1');
  });

  it('still allows an account_owner caller (broad-satisfies-granular, no regression)', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const result = await svc.get(ctxWith(['account_owner']), 'wh_1');
    expect(result.id).toBe('wh_1');
  });
});

describe('V-553.B-21 WebhooksService.list', () => {
  it('rejects callers without read:webhooks (or a satisfying broad scope)', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.list(ctxWith(['gui_control']))).rejects.toThrow(/read:webhooks/);
  });

  it('allows a caller holding the granular read:webhooks scope + scopes rows to the caller account', async () => {
    const { repo } = makeRepo([
      baseRow({ id: 'wh_1', accountId: 'acc_1' }),
      baseRow({ id: 'wh_2', accountId: 'acc_other' }),
    ]);
    const svc = new WebhooksService(repo);
    const rows = await svc.list(ctxWith(['read:webhooks']));
    expect(rows.map((r) => r.id)).toEqual(['wh_1']);
  });

  it('still allows an account_owner caller (broad-satisfies-granular, no regression)', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const rows = await svc.list(ctxWith(['account_owner']));
    expect(rows).toHaveLength(1);
  });
});

describe('V-553.B-14 WebhooksService.update', () => {
  it('requires account_owner scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.update(ctxWith(['read']), 'wh_1', { url: 'https://x.test' })).rejects.toThrow(
      /account_owner/,
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
  it('requires account_owner scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.delete(ctxWith(['write']), 'wh_1')).rejects.toThrow(/account_owner/);
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
  it('requires account_owner scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.rotateSecret(ctxWith(['read']), 'wh_1')).rejects.toThrow(/account_owner/);
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

  // Webhooks audit #7 (2026-09-24) — a second rotation inside a live grace
  // window used to be a repo-level no-op (V-359.G) that this service turned
  // into a 409, so a customer who lost the new secret could not get another
  // for up to 24 hours. It now replaces only the current secret and keeps the
  // original one, and its expiry, in the grace slot.
  it('a second rotation inside the still-active grace window replaces only the current secret and keeps the original as the previous one', async () => {
    const original = 'whsec_v1_ORIGORIGORIGORIGORIGORIGORIGORIG';
    const { repo, rows } = makeRepo([baseRow({ secret: original })]);
    const { audit, calls } = makeAudit();
    const svc = new WebhooksService(repo, audit);

    const first = await svc.rotateSecret(ctxWith(['admin']), 'wh_1');
    const firstExpiry = rows[0]?.secretPrevExpiresAt?.getTime();
    const second = await svc.rotateSecret(ctxWith(['admin']), 'wh_1');

    expect(second.plaintextSecret).not.toBe(first.plaintextSecret);
    expect(rows[0]?.secret).toBe(second.plaintextSecret);
    expect(rows[0]?.secretPrev).toBe(original);
    expect(rows[0]?.secretPrevExpiresAt?.getTime()).toBe(firstExpiry);
    expect(calls.map((c) => c.action)).toEqual([
      'webhook_endpoint.secret_rotated',
      'webhook_endpoint.secret_rotated',
    ]);
  });

  // The fabricated-secret hazard V-359.G's 409 used to guard, kept on its own:
  // the service must never hand back a plaintext the row does not carry — the
  // customer would install a secret nothing verifies against. A repo that
  // returns the row WITHOUT the new secret (a defect, since the rotation is now
  // unconditional on a live endpoint) is refused, and nothing is audited.
  it('throws instead of returning a fabricated secret when the repo hands back a row without the new secret', async () => {
    const { repo, rows } = makeRepo([baseRow()]);
    const { audit, calls } = makeAudit();
    repo.rotateSecret = () => Promise.resolve({ ...rows[0]! });
    const svc = new WebhooksService(repo, audit);

    await expect(svc.rotateSecret(ctxWith(['admin']), 'wh_1')).rejects.toThrow(/new secret/);
    expect(calls).toEqual([]);
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

  // V-553.B-21 — listWithCounts backs GET /v1/webhooks (the dashboard's
  // main webhooks page) and had ZERO scope check, unlike every sibling
  // CRUD method on this service. 'gui_control' satisfies neither bare
  // 'read' nor the broad-satisfies-granular rule.
  it('rejects callers without read:webhooks (or a satisfying broad scope)', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(svc.listWithCounts(ctxWith(['gui_control']))).rejects.toThrow(/read:webhooks/);
  });

  it('allows a caller holding the granular read:webhooks scope', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const result = await svc.listWithCounts(ctxWith(['read:webhooks']));
    expect(result).toHaveLength(1);
  });

  it('still allows an account_owner caller (broad-satisfies-granular, no regression)', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const result = await svc.listWithCounts(ctxWith(['account_owner']));
    expect(result).toHaveLength(1);
  });
});

// V-1858 — the two customer webhook gates whose only witness was a source-text pin.
//
// `services/webhooks.ts` carries 10 CUSTOMER scope gates and NOT ONE webhook route
// carries `requireScope` — every one is `preHandler: [requireAuth, rateLimit]` — so
// the service gate is the ONLY authorization on these paths, and they are correctly
// absent from the route-level refusal roster because there is no route gate to
// enumerate.
//
// MEASURED before writing: weakening all 10 to a scope every fixture holds failed 34
// tests across 6 files — but for `listDeliveries` and `replayDeliveryAsCustomer` the
// ONLY failures were source-text pins (`docs-reference-scopes-content-parity` matches
// the gate's text, `services-webhooks-content-parity` matches the replay body). Eight
// of the ten already have a rejects/allows pair in this file; these two did not.
//
// `webhooks-customer-replay-fenced-delivery` does drive the replay method, but for
// FENCE semantics with a scope-rich context, so it cannot see the gate — the mutation
// left it green.
//
// 'gui_control' is the narrow scope this file already uses for exactly this: it is
// real, satisfies neither bare 'read' nor the broad-satisfies-granular rule, and so
// must not reach a webhook surface.
describe('V-1858 WebhooksService.listDeliveries + replayDeliveryAsCustomer scope gates', () => {
  it('CRITICAL listDeliveries rejects a caller without read:webhooks. No route above it checks scope, so this gate is the whole authorization on GET /v1/webhooks/:id/deliveries — a delivery list carries request/response metadata for every event the endpoint received.', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(
      svc.listDeliveries(ctxWith(['gui_control']), 'wh_1', { limit: 10 }),
    ).rejects.toThrow(/read:webhooks/);
  });

  it('allows a caller holding the granular read:webhooks scope — without this the refusal above is satisfied by a method that rejects everyone', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const page = await svc.listDeliveries(ctxWith(['read:webhooks']), 'wh_1', { limit: 10 });
    expect(page.items).toEqual([]);
  });

  it('CRITICAL replayDeliveryAsCustomer rejects a caller without account_owner. Replay re-sends a stored delivery to the endpoint URL, so a read-only key reaching it turns a read credential into an outbound-send credential.', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    await expect(
      svc.replayDeliveryAsCustomer(ctxWith(['read', 'read:webhooks']), 'wdl_1', {}),
    ).rejects.toThrow(/account_owner/);
  });

  it('an account_owner caller gets PAST the scope gate — it may then fail on the delivery lookup, which is the point: the refusal above is the scope and not the fixture', async () => {
    const { repo } = makeRepo([baseRow()]);
    const svc = new WebhooksService(repo);
    const err: unknown = await svc
      .replayDeliveryAsCustomer(ctxWith(['account_owner']), 'wdl_1', {})
      .then(() => null)
      .catch((e: unknown) => e);
    expect(String(err), 'a properly-scoped caller was still refused on scope').not.toMatch(
      /account_owner/,
    );
  });
});
