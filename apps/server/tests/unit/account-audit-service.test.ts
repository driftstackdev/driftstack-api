// V-553.B-16 — unit tests for AccountAuditService (V-216).
//
// Surface under test:
//   - list(): scope gate, repo pass-through, V-330b effectiveAccountId
//     redirects to OWNER but scope is still checked on caller
//   - record(): no-scope check (service-internal); forwards verbatim

import { describe, expect, it } from 'vitest';
import type { AccountAuditAction, AccountAuditActorType, ApiKeyScope } from '@driftstack/api-types';
import {
  AccountAuditService,
  type AccountAuditEntryRow,
  type AccountAuditRepo,
  type ListAccountAuditOpts,
  type ListAccountAuditPage,
  type RecordAccountAuditInput,
} from '../../src/services/account-audit.js';
import type { AccountContext } from '../../src/services/auth.js';

function ctxWith(scopes: ApiKeyScope[], accountId = 'acc_caller'): AccountContext {
  return {
    account: { id: accountId },
    apiKey: { id: 'key_1', scopes },
  } as unknown as AccountContext;
}

function makeRepo(): {
  repo: AccountAuditRepo;
  state: {
    rows: AccountAuditEntryRow[];
    listCalls: Array<{ accountId: string; opts: ListAccountAuditOpts }>;
  };
} {
  const state = {
    rows: [] as AccountAuditEntryRow[],
    listCalls: [] as Array<{ accountId: string; opts: ListAccountAuditOpts }>,
  };
  let counter = 0;
  const repo: AccountAuditRepo = {
    insert: (input: RecordAccountAuditInput) => {
      counter += 1;
      const row: AccountAuditEntryRow = {
        id: `aud_${counter.toString()}`,
        accountId: input.accountId,
        actorType: input.actorType,
        actorAccountId: input.actorAccountId ?? null,
        actorKeyId: input.actorKeyId ?? null,
        action: input.action,
        targetResourceId: input.targetResourceId ?? null,
        payload: input.payload ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        timestamp: new Date(),
      };
      state.rows.push(row);
      return Promise.resolve(row);
    },
    list: (accountId, opts) => {
      state.listCalls.push({ accountId, opts });
      const items = state.rows.filter((r) => r.accountId === accountId).slice(0, opts.limit);
      const page: ListAccountAuditPage = { items, nextCursor: null };
      return Promise.resolve(page);
    },
    countActionsSince: (accountId, action, since) => {
      const n = state.rows.filter(
        (r) => r.accountId === accountId && r.action === action && r.timestamp >= since,
      ).length;
      return Promise.resolve(n);
    },
  };
  return { repo, state };
}

const SAMPLE_ACTION: AccountAuditAction = 'api_key.created' as AccountAuditAction;
const CUSTOMER_ACTOR: AccountAuditActorType = 'customer';

describe('V-553.B-16 AccountAuditService.list', () => {
  it('rejects callers missing the account_owner scope', async () => {
    const { repo } = makeRepo();
    const svc = new AccountAuditService(repo);
    await expect(svc.list(ctxWith(['read']), { limit: 10 })).rejects.toThrow(/account_owner/);
  });

  it('passes opts through to the repo and scopes to the caller account by default', async () => {
    const { repo, state } = makeRepo();
    const svc = new AccountAuditService(repo);
    await svc.list(ctxWith(['account_owner'], 'acc_self'), {
      limit: 25,
      action: SAMPLE_ACTION,
    });
    expect(state.listCalls).toHaveLength(1);
    expect(state.listCalls[0]?.accountId).toBe('acc_self');
    expect(state.listCalls[0]?.opts.limit).toBe(25);
    expect(state.listCalls[0]?.opts.action).toBe(SAMPLE_ACTION);
  });

  it('V-330b effectiveAccountId redirects the lookup to the OWNER but keeps the caller scope check', async () => {
    const { repo, state } = makeRepo();
    const svc = new AccountAuditService(repo);
    await svc.list(ctxWith(['account_owner'], 'acc_member'), {
      limit: 10,
      effectiveAccountId: 'acc_owner',
    });
    expect(state.listCalls[0]?.accountId).toBe('acc_owner');
  });

  it('V-330b — a caller without account_owner is still rejected even when effectiveAccountId is set', async () => {
    const { repo } = makeRepo();
    const svc = new AccountAuditService(repo);
    await expect(
      svc.list(ctxWith(['read'], 'acc_member'), {
        limit: 10,
        effectiveAccountId: 'acc_owner',
      }),
    ).rejects.toThrow(/account_owner/);
  });

  it('forwards V-484 advanced filters (from/to/actorType/targetResourceId) verbatim', async () => {
    const { repo, state } = makeRepo();
    const svc = new AccountAuditService(repo);
    const from = new Date('2026-05-01Z');
    const to = new Date('2026-05-31Z');
    await svc.list(ctxWith(['account_owner']), {
      limit: 50,
      from,
      to,
      actorType: 'system',
      targetResourceId: 'webhook_endpoint_wh_1',
    });
    const opts = state.listCalls[0]?.opts;
    expect(opts?.from).toEqual(from);
    expect(opts?.to).toEqual(to);
    expect(opts?.actorType).toBe('system');
    expect(opts?.targetResourceId).toBe('webhook_endpoint_wh_1');
  });
});

describe('V-553.B-16 AccountAuditService.record', () => {
  it('is service-internal — does NOT require any AccountContext / scope', async () => {
    const { repo, state } = makeRepo();
    const svc = new AccountAuditService(repo);
    // The fact that this call accepts only a RecordAccountAuditInput
    // (no ctx) is the contract — callers (api-keys, sessions, etc.)
    // record off the auth-cache pipeline without a fresh scope read.
    const written = await svc.record({
      accountId: 'acc_1',
      actorType: CUSTOMER_ACTOR,
      actorAccountId: 'acc_1',
      actorKeyId: 'key_1',
      action: SAMPLE_ACTION,
      targetResourceId: 'api_key_key_1',
      payload: { source: 'dashboard' },
    });
    expect(written.id).toMatch(/^aud_/);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.action).toBe(SAMPLE_ACTION);
  });

  it('preserves the supplied payload + ip + userAgent on the row', async () => {
    const { repo, state } = makeRepo();
    const svc = new AccountAuditService(repo);
    await svc.record({
      accountId: 'acc_1',
      actorType: CUSTOMER_ACTOR,
      action: SAMPLE_ACTION,
      payload: { hello: 'world' },
      ipAddress: '203.0.113.42',
      userAgent: 'Test/1.0',
    });
    const row = state.rows[0];
    expect(row?.payload).toEqual({ hello: 'world' });
    expect(row?.ipAddress).toBe('203.0.113.42');
    expect(row?.userAgent).toBe('Test/1.0');
  });

  it('defaults missing optional fields to null on the row', async () => {
    const { repo, state } = makeRepo();
    const svc = new AccountAuditService(repo);
    await svc.record({
      accountId: 'acc_1',
      actorType: 'system',
      action: SAMPLE_ACTION,
    });
    const row = state.rows[0];
    expect(row?.actorAccountId).toBeNull();
    expect(row?.actorKeyId).toBeNull();
    expect(row?.targetResourceId).toBeNull();
    expect(row?.payload).toBeNull();
    expect(row?.ipAddress).toBeNull();
    expect(row?.userAgent).toBeNull();
  });
});

describe('AccountAuditService — 2026-05-20 high-severity notification republish', () => {
  function makeBusSpy(): {
    bus: {
      publish: (event: unknown) => void;
      subscribe: (accountId: string, handler: (event: unknown) => void) => () => void;
      subscriberCount: (accountId: string) => number;
    };
    captured: Array<{ kind: string; [k: string]: unknown }>;
  } {
    const captured: Array<{ kind: string; [k: string]: unknown }> = [];
    return {
      bus: {
        publish: (e: unknown) => captured.push(e as { kind: string }),
        subscribe: () => () => undefined,
        subscriberCount: () => 0,
      },
      captured,
    };
  }

  it('republishes api_key.revoked as audit.high_severity on the bus alongside the audit-log insert', async () => {
    const { repo } = makeRepo();
    const { bus, captured } = makeBusSpy();
    const svc = new AccountAuditService(
      repo,
      undefined,
      bus as unknown as ConstructorParameters<typeof AccountAuditService>[2] extends infer T
        ? T
        : never,
    );
    await svc.record({
      accountId: 'acc_1',
      actorType: CUSTOMER_ACTOR,
      action: 'api_key.revoked',
      targetResourceId: 'key_xyz',
    });
    expect(captured).toHaveLength(1);
    const evt = captured[0];
    expect(evt?.kind).toBe('audit.high_severity');
    expect(evt?.accountId).toBe('acc_1');
    expect(evt?.action).toBe('api_key.revoked');
    expect(evt?.actorType).toBe('customer');
    expect(evt?.targetResourceId).toBe('key_xyz');
    expect(typeof evt?.at).toBe('string');
  });

  it('does NOT republish low-severity actions like account.login', async () => {
    const { repo } = makeRepo();
    const { bus, captured } = makeBusSpy();
    const svc = new AccountAuditService(
      repo,
      undefined,
      bus as unknown as ConstructorParameters<typeof AccountAuditService>[2] extends infer T
        ? T
        : never,
    );
    await svc.record({
      accountId: 'acc_1',
      actorType: CUSTOMER_ACTOR,
      action: 'account.login',
    });
    expect(captured).toHaveLength(0);
  });

  it("maps server actorType 'staff' → notification 'admin'", async () => {
    const { repo } = makeRepo();
    const { bus, captured } = makeBusSpy();
    const svc = new AccountAuditService(
      repo,
      undefined,
      bus as unknown as ConstructorParameters<typeof AccountAuditService>[2] extends infer T
        ? T
        : never,
    );
    await svc.record({
      accountId: 'acc_1',
      actorType: 'staff',
      action: 'team.member_removed',
      targetResourceId: 'membership_42',
    });
    expect(captured[0]?.actorType).toBe('admin');
  });

  it('bus publish failure NEVER breaks the audit-log insert path', async () => {
    const { repo, state } = makeRepo();
    const throwingBus = {
      publish: () => {
        throw new Error('bus offline');
      },
      subscribe: () => () => undefined,
      subscriberCount: () => 0,
    };
    const svc = new AccountAuditService(
      repo,
      undefined,
      throwingBus as unknown as ConstructorParameters<typeof AccountAuditService>[2] extends infer T
        ? T
        : never,
    );
    const written = await svc.record({
      accountId: 'acc_1',
      actorType: CUSTOMER_ACTOR,
      action: 'api_key.revoked',
    });
    // Insert still landed; the row is in the repo.
    expect(written.id).toMatch(/^aud_/);
    expect(state.rows).toHaveLength(1);
  });
});
