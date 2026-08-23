// V-553.B-20 — unit tests for ApiKeysService.
//
// Surface under test:
//   - create(): account_owner scope gate, legal acceptance block,
//     test vs live env prefix from tier, mint records audit
//   - list(): returns row set scoped by effectiveAccountId
//   - rotate(): scope gate, NotFound on missing, BadRequest on revoked,
//     sets old key's expiresAt, audit records both key ids
//   - revoke(): scope gate, NotFound on missing, idempotent on
//     already-revoked, fires webhook + audit on success

import { describe, expect, it } from 'vitest';
import type { ApiKeyScope, AccountTier } from '@driftstack/api-types';
import {
  ApiKeysService,
  type ApiKeysRepo,
  type CustomerAuditEmitter,
  type LegalAcceptanceGate,
  type NewApiKeyInput,
  type RevocationWebhookEmitter,
} from '../../src/services/api-keys.js';
import type { AccountContext, AccountRow, ApiKeyRow } from '../../src/services/auth.js';
import type { AuthCache } from '../../src/services/auth-cache.js';
import { ForbiddenError, LegalAcceptanceRequiredError } from '../../src/lib/errors.js';

function makeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acc_1',
    email: 'u@example.com',
    name: null,
    tier: 'solo_manual',
    status: 'active',
    timezone: null,
    avatarR2Key: null,
    slug: null,
    region: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeKey(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: 'k1',
    accountId: 'acc_1',
    name: 'caller',
    keyPrefix: 'ds_live_abc',
    keyHash: 'hash',
    scopes: ['account_owner'],
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    provenance: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function ctxWith(
  scopes: ApiKeyScope[],
  accountOverrides: Partial<AccountRow> = {},
): AccountContext {
  return {
    account: makeAccount(accountOverrides),
    apiKey: makeKey({ scopes }),
    rateLimitOverrides: {},
    teams: [],
  } as unknown as AccountContext;
}

/** C1 — a caller whose own key was minted by the cli-authorize device
 *  flow (provenance='cli_device'). Even with account_owner it must be
 *  barred from key mint/rotate/revoke at the service chokepoint. */
function deviceCtx(scopes: ApiKeyScope[]): AccountContext {
  return {
    account: makeAccount(),
    apiKey: makeKey({ scopes, provenance: 'cli_device' }),
    rateLimitOverrides: {},
    teams: [],
  } as unknown as AccountContext;
}

function makeRepo(initial: ApiKeyRow[] = []): {
  repo: ApiKeysRepo;
  state: {
    rows: ApiKeyRow[];
    revoked: Array<{ id: string; at: Date }>;
    expiresSet: Array<{ id: string; at: Date }>;
  };
} {
  const state = {
    rows: [...initial],
    revoked: [] as Array<{ id: string; at: Date }>,
    expiresSet: [] as Array<{ id: string; at: Date }>,
  };
  let counter = state.rows.length;
  const repo: ApiKeysRepo = {
    // V-727 — keys minted BY an account on other accounts. This fixture tracks
    // no minter, so nothing is ever attributed to one.
    listApiKeysMintedBy: () => Promise.resolve([]),
    insertApiKey: (input: NewApiKeyInput) => {
      counter += 1;
      const row: ApiKeyRow = {
        id: `k_new_${counter.toString()}`,
        accountId: input.accountId,
        name: input.name,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        scopes: input.scopes,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: input.expiresAt,
        provenance: input.provenance ?? null,
        createdAt: new Date(),
      };
      state.rows.push(row);
      return Promise.resolve(row);
    },
    listApiKeys: (accountId) =>
      Promise.resolve(state.rows.filter((r) => r.accountId === accountId)),
    findApiKey: (id, accountId) =>
      Promise.resolve(state.rows.find((r) => r.id === id && r.accountId === accountId) ?? null),
    findApiKeyUnscoped: (id) => Promise.resolve(state.rows.find((r) => r.id === id) ?? null),
    revokeApiKeyAtomic: (input) => {
      const r = state.rows.find(
        (row) =>
          row.id === input.id && (input.accountId === null || row.accountId === input.accountId),
      );
      if (!r) return Promise.resolve({ kind: 'not_found' });
      if (r.revokedAt !== null) {
        return Promise.resolve({ kind: 'already_revoked', key: { ...r } });
      }
      r.revokedAt = input.revokedAt;
      state.revoked.push({ id: input.id, at: input.revokedAt });
      return Promise.resolve({ kind: 'revoked', key: { ...r } });
    },
    setExpiresAt: (id, at) => {
      const r = state.rows.find((row) => row.id === id);
      if (r) r.expiresAt = at;
      state.expiresSet.push({ id, at });
      return Promise.resolve();
    },
    rotateApiKeyAtomic: (input) => {
      const oldKey = state.rows.find(
        (row) => row.id === input.oldKeyId && row.accountId === input.accountId,
      );
      if (!oldKey) return Promise.resolve({ kind: 'not_found' });
      if (oldKey.revokedAt !== null) return Promise.resolve({ kind: 'revoked' });
      if (oldKey.expiresAt !== null && oldKey.expiresAt <= input.now) {
        return Promise.resolve({ kind: 'expired' });
      }
      const candidateGraceEnd = new Date(input.now.getTime() + input.gracePeriodMs);
      const gracePeriodEndsAt =
        oldKey.expiresAt !== null && oldKey.expiresAt < candidateGraceEnd
          ? oldKey.expiresAt
          : candidateGraceEnd;
      const oldKeySnapshot: ApiKeyRow = { ...oldKey, scopes: [...oldKey.scopes] };
      counter += 1;
      const newRow: ApiKeyRow = {
        id: `k_new_${counter.toString()}`,
        accountId: oldKey.accountId,
        name: input.name ?? oldKey.name,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        scopes: oldKey.scopes,
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: oldKey.expiresAt,
        provenance: null,
        createdAt: new Date(),
      };
      state.rows.push(newRow);
      oldKey.expiresAt = gracePeriodEndsAt;
      state.expiresSet.push({ id: oldKey.id, at: gracePeriodEndsAt });
      return Promise.resolve({
        kind: 'rotated',
        oldKey: oldKeySnapshot,
        newRow,
        gracePeriodEndsAt,
      });
    },
    listAllApiKeys: () => Promise.resolve({ items: state.rows, nextCursor: null }),
  };
  return { repo, state };
}

/**
 * A Postgres unique-violation error shaped like what postgres-js throws
 * (SQLSTATE 23505 + constraint_name), so `isUniqueViolation(err,
 * 'api_keys_prefix_unique')` in the service accepts it. Models the
 * key_prefix birthday-collision on the `api_keys_prefix_unique` index.
 */
function prefixUniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint_name: 'api_keys_prefix_unique',
  });
}

/**
 * Build a repo whose insert/atomic-rotate path throws a `key_prefix` 23505
 * on its first `failTimes` calls, then succeeds. Records how many write calls
 * were made so tests can assert the retry loop actually re-minted.
 */
function makeRepoWithInsertFailures(
  failTimes: number,
  initial: ApiKeyRow[] = [],
): {
  repo: ApiKeysRepo;
  state: { insertCalls: number };
} {
  const { repo: base } = makeRepo(initial);
  const state = { insertCalls: 0 };
  const repo: ApiKeysRepo = {
    ...base,
    insertApiKey: (input: NewApiKeyInput) => {
      state.insertCalls += 1;
      if (state.insertCalls <= failTimes) {
        return Promise.reject(prefixUniqueViolation());
      }
      return base.insertApiKey(input);
    },
    rotateApiKeyAtomic: (input) => {
      state.insertCalls += 1;
      if (state.insertCalls <= failTimes) {
        return Promise.reject(prefixUniqueViolation());
      }
      return base.rotateApiKeyAtomic(input);
    },
  };
  return { repo, state };
}

function makeAudit(): {
  audit: CustomerAuditEmitter;
  calls: Array<{ action: string; accountId: string; targetResourceId?: string | null }>;
} {
  const calls: Array<{ action: string; accountId: string; targetResourceId?: string | null }> = [];
  const audit: CustomerAuditEmitter = {
    record: (args) => {
      calls.push({
        action: args.action,
        accountId: args.accountId,
        targetResourceId: args.targetResourceId ?? null,
      });
      return Promise.resolve();
    },
  };
  return { audit, calls };
}

function makeWebhooks(): {
  webhooks: RevocationWebhookEmitter;
  calls: Array<{ accountId: string; eventType: string; data: Record<string, unknown> }>;
} {
  const calls: Array<{ accountId: string; eventType: string; data: Record<string, unknown> }> = [];
  const webhooks: RevocationWebhookEmitter = {
    enqueueEvent: (accountId, eventType, data) => {
      calls.push({ accountId, eventType, data });
      return Promise.resolve(1);
    },
  };
  return { webhooks, calls };
}

function makeLegalGate(
  pending: Array<{ documentKey: string; currentVersion: string }> = [],
): LegalAcceptanceGate {
  return {
    required: () => Promise.resolve(pending),
  };
}

describe('V-553.B-20 ApiKeysService.create', () => {
  it('rejects callers without account_owner scope', async () => {
    const { repo } = makeRepo();
    const svc = new ApiKeysService(repo);
    await expect(
      svc.create(ctxWith(['read']), { name: 'mine', scopes: ['read'], expiresAt: null }),
    ).rejects.toThrow(/account_owner/);
  });

  // Privilege de-escalation (V-174): a caller may not grant an elevated
  // scope it does not itself hold. Without this, an account_owner
  // dashboard session could mint a driftstack_internal_admin / legacy
  // 'admin' key that satisfies the /v1/admin/* route guards
  // (cross-account escalation). Customer-level scopes stay grantable.
  it('rejects an account_owner caller granting driftstack_internal_admin', async () => {
    const { repo } = makeRepo();
    const svc = new ApiKeysService(repo);
    await expect(
      svc.create(ctxWith(['read', 'write', 'account_owner']), {
        name: 'escalate',
        scopes: ['driftstack_internal_admin'],
        expiresAt: null,
      }),
    ).rejects.toThrow(
      /driftstack_internal_admin.*does not hold|does not hold.*driftstack_internal_admin/,
    );
  });

  it('rejects an account_owner caller granting legacy admin', async () => {
    const { repo } = makeRepo();
    const svc = new ApiKeysService(repo);
    await expect(
      svc.create(ctxWith(['read', 'write', 'account_owner']), {
        name: 'escalate',
        scopes: ['admin'],
        expiresAt: null,
      }),
    ).rejects.toThrow(/does not hold/);
  });

  it('allows a caller that holds driftstack_internal_admin to grant it (staff minting a staff key)', async () => {
    const { repo, state } = makeRepo();
    const svc = new ApiKeysService(repo);
    const result = await svc.create(
      ctxWith(['read', 'write', 'account_owner', 'driftstack_internal_admin'], {
        tier: 'solo_manual',
      }),
      { name: 'staff-key', scopes: ['driftstack_internal_admin'], expiresAt: null },
    );
    expect(result.plaintext).toMatch(/^ds_(live|test)_/);
    expect(state.rows.at(-1)?.scopes).toEqual(['driftstack_internal_admin']);
  });

  it('still lets an account_owner caller grant customer-level scopes (no regression)', async () => {
    const { repo, state } = makeRepo();
    const svc = new ApiKeysService(repo);
    await svc.create(ctxWith(['read', 'write', 'account_owner'], { tier: 'solo_manual' }), {
      name: 'app-key',
      scopes: ['read', 'write', 'write:sessions', 'account_owner'],
      expiresAt: null,
    });
    expect(state.rows.at(-1)?.scopes).toEqual(['read', 'write', 'write:sessions', 'account_owner']);
  });

  it('blocks on pending legal acceptances', async () => {
    const { repo } = makeRepo();
    const gate = makeLegalGate([{ documentKey: 'tos', currentVersion: '2026-05-01' }]);
    const svc = new ApiKeysService(repo, null, null, gate);
    await expect(
      svc.create(ctxWith(['account_owner']), { name: 'mine', scopes: ['read'], expiresAt: null }),
    ).rejects.toThrow(LegalAcceptanceRequiredError);
  });

  it('mints a live key + records audit for non-trial tier', async () => {
    const { repo, state } = makeRepo();
    const { audit, calls } = makeAudit();
    const svc = new ApiKeysService(repo, null, null, null, audit);
    const result = await svc.create(ctxWith(['account_owner'], { tier: 'solo_manual' }), {
      name: 'mine',
      scopes: ['read'],
      expiresAt: null,
    });
    expect(result.plaintext).toMatch(/^ds_live_/);
    expect(state.rows).toHaveLength(1);
    expect(calls[0]?.action).toBe('api_key.minted');
    expect(calls[0]?.accountId).toBe('acc_1');
  });

  it('rejects an ordinary Free-tier key before legal or repository side effects', async () => {
    const { repo, state } = makeRepo();
    let legalChecks = 0;
    const legalGate: LegalAcceptanceGate = {
      required: () => {
        legalChecks += 1;
        return Promise.resolve([]);
      },
    };
    const svc = new ApiKeysService(repo, null, null, legalGate);

    await expect(
      svc.create(ctxWith(['account_owner'], { tier: 'free' }), {
        name: 'mine',
        scopes: ['read'],
        expiresAt: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(legalChecks).toBe(0);
    expect(state.rows).toHaveLength(0);
  });

  it('preserves Free desktop provisioning with a restricted ds_test_ device credential', async () => {
    const { repo, state } = makeRepo();
    const svc = new ApiKeysService(repo);
    const result = await svc.create(ctxWith(['account_owner'], { tier: 'free' }), {
      name: 'Desktop client',
      scopes: ['account_owner'],
      expiresAt: null,
      provenance: 'cli_device',
    });
    expect(result.plaintext).toMatch(/^ds_test_/);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.provenance).toBe('cli_device');
  });

  it('honours effectiveAccountId + effectiveTier (V-326e6 team-scoped mint)', async () => {
    const { repo, state } = makeRepo();
    const svc = new ApiKeysService(repo);
    const result = await svc.create(
      ctxWith(['account_owner'], { id: 'acc_member', tier: 'free' }),
      { name: 'team-key', scopes: ['read'], expiresAt: null },
      { effectiveAccountId: 'acc_owner', effectiveTier: 'api_starter' as AccountTier },
    );
    expect(result.row.accountId).toBe('acc_owner');
    expect(result.plaintext).toMatch(/^ds_live_/);
    expect(state.rows[0]?.accountId).toBe('acc_owner');
  });

  // key_prefix has a UNIQUE index; a rare (~40-bit birthday-bound) prefix
  // collision throws SQLSTATE 23505 on insert. The mint must regenerate a
  // fresh key and retry (bounded) rather than surface an opaque 500.
  it('regenerates the key and retries on a key_prefix 23505, returning a key (no 500)', async () => {
    const { repo, state } = makeRepoWithInsertFailures(1); // first insert collides, second succeeds
    const svc = new ApiKeysService(repo);
    const result = await svc.create(ctxWith(['account_owner'], { tier: 'solo_manual' }), {
      name: 'mine',
      scopes: ['read'],
      expiresAt: null,
    });
    expect(result.plaintext).toMatch(/^ds_live_/);
    expect(result.row.keyPrefix).toMatch(/^ds_live_/);
    expect(state.insertCalls).toBe(2); // proves the collision was retried, not surfaced
  });

  it('rethrows the 23505 after exhausting the retry bound when every insert collides', async () => {
    const { repo, state } = makeRepoWithInsertFailures(Number.POSITIVE_INFINITY);
    const svc = new ApiKeysService(repo);
    await expect(
      svc.create(ctxWith(['account_owner'], { tier: 'solo_manual' }), {
        name: 'mine',
        scopes: ['read'],
        expiresAt: null,
      }),
    ).rejects.toMatchObject({ code: '23505' });
    // Bounded — it does not loop forever (MAX_KEY_MINT_ATTEMPTS = 3).
    expect(state.insertCalls).toBe(3);
  });
});

describe('V-553.B-20 ApiKeysService.list', () => {
  it('rejects callers without read:api-keys (or a satisfying broad scope)', async () => {
    const { repo } = makeRepo([makeKey({ id: 'a1', accountId: 'acc_1' })]);
    const svc = new ApiKeysService(repo);
    // 'gui_control' is a real, narrow scope that satisfies neither the
    // bare 'read' nor 'account_owner' broad-satisfies-granular rule, so
    // it must not be able to read the account's api-keys list.
    await expect(svc.list(ctxWith(['gui_control']))).rejects.toThrow(/read:api-keys/);
  });

  it('allows a caller holding the granular read:api-keys scope', async () => {
    const { repo } = makeRepo([makeKey({ id: 'a1', accountId: 'acc_1' })]);
    const svc = new ApiKeysService(repo);
    const rows = await svc.list(ctxWith(['read:api-keys']));
    expect(rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('returns rows scoped to the caller account', async () => {
    const { repo } = makeRepo([
      makeKey({ id: 'a1', accountId: 'acc_1' }),
      makeKey({ id: 'a2', accountId: 'acc_other' }),
    ]);
    const svc = new ApiKeysService(repo);
    const rows = await svc.list(ctxWith(['read']));
    expect(rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('honours effectiveAccountId redirection', async () => {
    const { repo } = makeRepo([
      makeKey({ id: 'a1', accountId: 'acc_member' }),
      makeKey({ id: 'a2', accountId: 'acc_owner' }),
    ]);
    const svc = new ApiKeysService(repo);
    const rows = await svc.list(ctxWith(['read'], { id: 'acc_member' }), {
      effectiveAccountId: 'acc_owner',
    });
    expect(rows.map((r) => r.id)).toEqual(['a2']);
  });
});

describe('V-553.B-20 ApiKeysService.rotate', () => {
  it('rejects Free-tier rotation before generating or writing a successor', async () => {
    const { repo, state } = makeRepo([makeKey({ id: 'k_old', accountId: 'acc_1' })]);
    const svc = new ApiKeysService(repo);

    await expect(
      svc.rotate(ctxWith(['account_owner'], { tier: 'free' }), 'k_old'),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(state.rows).toHaveLength(1);
    expect(state.expiresSet).toHaveLength(0);
  });

  it('throws NotFound when the key does not exist', async () => {
    const { repo } = makeRepo();
    const svc = new ApiKeysService(repo);
    await expect(svc.rotate(ctxWith(['account_owner']), 'k_missing')).rejects.toThrow(/not found/);
  });

  it('throws BadRequest when rotating a revoked key', async () => {
    const { repo } = makeRepo([
      makeKey({ id: 'k_old', accountId: 'acc_1', revokedAt: new Date('2026-01-01Z') }),
    ]);
    const svc = new ApiKeysService(repo);
    await expect(svc.rotate(ctxWith(['account_owner']), 'k_old')).rejects.toThrow(/revoked/);
  });

  it('throws BadRequest when rotating an expired key (would otherwise mint a born-dead key)', async () => {
    const { repo } = makeRepo([
      makeKey({ id: 'k_old', accountId: 'acc_1', expiresAt: new Date('2020-01-01Z') }),
    ]);
    const svc = new ApiKeysService(repo);
    await expect(svc.rotate(ctxWith(['account_owner']), 'k_old')).rejects.toThrow(/expired/);
  });

  it('does not mint a successor when revoke wins before the atomic authority check', async () => {
    const { repo: base, state } = makeRepo([makeKey({ id: 'k_old', accountId: 'acc_1' })]);
    const revokeWonAt = new Date('2026-07-13T12:00:00.000Z');
    const repo: ApiKeysRepo = {
      ...base,
      rotateApiKeyAtomic: async (input) => {
        await base.revokeApiKeyAtomic({
          id: input.oldKeyId,
          accountId: input.accountId,
          revokedAt: revokeWonAt,
        });
        return base.rotateApiKeyAtomic(input);
      },
    };
    const svc = new ApiKeysService(repo);

    await expect(svc.rotate(ctxWith(['account_owner']), 'k_old')).rejects.toThrow(/revoked/);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.id).toBe('k_old');
    expect(state.rows[0]?.revokedAt).toEqual(revokeWonAt);
  });

  it('mints a new row, sets old key expiry, audits both ids', async () => {
    const { repo, state } = makeRepo([makeKey({ id: 'k_old', accountId: 'acc_1' })]);
    const { audit, calls } = makeAudit();
    const svc = new ApiKeysService(repo, null, null, null, audit);
    const result = await svc.rotate(ctxWith(['account_owner']), 'k_old');
    expect(result.newRow.id).not.toBe('k_old');
    expect(result.gracePeriodEndsAt).toBeInstanceOf(Date);
    expect(state.expiresSet).toHaveLength(1);
    expect(state.expiresSet[0]?.id).toBe('k_old');
    expect(calls[0]?.action).toBe('api_key.rotated');
    expect(calls[0]?.targetResourceId).toBe('key_k_old');
  });

  it('rejects rotation by callers without account_owner scope', async () => {
    const { repo } = makeRepo([makeKey({ id: 'k_old' })]);
    const svc = new ApiKeysService(repo);
    await expect(svc.rotate(ctxWith(['read']), 'k_old')).rejects.toThrow(/account_owner/);
  });

  // Same key_prefix 23505 birthday-collision guard as create() — rotation
  // mints a brand-new key row, so it must regenerate + retry too.
  it('regenerates the new key and retries on a key_prefix 23505 during rotation', async () => {
    const { repo, state } = makeRepoWithInsertFailures(1, [
      makeKey({ id: 'k_old', accountId: 'acc_1' }),
    ]);
    const svc = new ApiKeysService(repo);
    const result = await svc.rotate(ctxWith(['account_owner']), 'k_old');
    expect(result.newRow.id).not.toBe('k_old');
    expect(result.plaintext).toMatch(/^ds_(live|test)_/);
    expect(state.insertCalls).toBe(2); // first insert collided, second minted
  });
});

describe('V-553.B-20 ApiKeysService.revoke', () => {
  it('rejects callers without account_owner scope', async () => {
    const { repo } = makeRepo([makeKey({ id: 'k_x' })]);
    const svc = new ApiKeysService(repo);
    await expect(svc.revoke(ctxWith(['read']), 'k_x')).rejects.toThrow(/account_owner/);
  });

  it('throws NotFound for unknown id', async () => {
    const { repo } = makeRepo();
    const svc = new ApiKeysService(repo);
    await expect(svc.revoke(ctxWith(['account_owner']), 'k_missing')).rejects.toThrow(/not found/);
  });

  it('is idempotent on an already-revoked key (no extra webhook / audit)', async () => {
    const { repo } = makeRepo([
      makeKey({ id: 'k_x', accountId: 'acc_1', revokedAt: new Date('2026-01-01Z') }),
    ]);
    const { webhooks, calls: hookCalls } = makeWebhooks();
    const { audit, calls: auditCalls } = makeAudit();
    const svc = new ApiKeysService(repo, null, webhooks, null, audit);
    await svc.revoke(ctxWith(['account_owner']), 'k_x');
    expect(hookCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('marks the key revoked, fires webhook + audit on success', async () => {
    const { repo, state } = makeRepo([makeKey({ id: 'k_x', accountId: 'acc_1' })]);
    const { webhooks, calls: hookCalls } = makeWebhooks();
    const { audit, calls: auditCalls } = makeAudit();
    const svc = new ApiKeysService(repo, null, webhooks, null, audit);
    await svc.revoke(ctxWith(['account_owner']), 'k_x');
    expect(state.revoked).toHaveLength(1);
    expect(state.revoked[0]?.id).toBe('k_x');
    expect(hookCalls[0]?.eventType).toBe('api_key.revoked');
    expect(auditCalls[0]?.action).toBe('api_key.revoked');
    expect(auditCalls[0]?.targetResourceId).toBe('key_k_x');
  });

  // V-1385 — a repo-contract invariant, and the only one of its kind whose violation is
  // SILENT. `revokeApiKeyAtomic` returning a revoked outcome whose row has no `revokedAt`
  // is impossible from the real repo, but the value it guards feeds
  // `revoked_at: revokedAt.toISOString()` on the customer-facing `api_key.revoked`
  // webhook — inside a `try { … } catch {}` that swallows. Without the guard a null would
  // throw there and be eaten, so the revoke would still succeed and the customer's
  // integration would simply never be told the key was revoked. The guard turns a
  // security-relevant notification going missing into a loud failure.
  it('CRITICAL a revoked row with no revokedAt is REFUSED rather than degrading into a missing webhook. The webhook emit is wrapped in a swallowing catch, so a null here does not surface as an error — it surfaces as api_key.revoked never arriving, which is the kind of failure nobody reports.', async () => {
    const { repo } = makeRepo([makeKey({ id: 'k_x', accountId: 'acc_1' })]);
    const lying: ApiKeysRepo = {
      ...repo,
      revokeApiKeyAtomic: (input) =>
        Promise.resolve({
          kind: 'revoked',
          key: { ...makeKey({ id: input.id, accountId: 'acc_1' }), revokedAt: null },
        }),
    };
    const { webhooks, calls: hookCalls } = makeWebhooks();
    const { audit, calls: auditCalls } = makeAudit();
    const svc = new ApiKeysService(lying, null, webhooks, null, audit);

    await expect(svc.revoke(ctxWith(['account_owner']), 'k_x')).rejects.toThrow(
      /revoked row without revokedAt/,
    );
    expect(hookCalls, 'and nothing was emitted on the way out').toHaveLength(0);
    expect(auditCalls, 'nor written to the audit log').toHaveLength(0);
  });

  it('emits cache invalidation, webhook, and audit exactly once across concurrent first revokes', async () => {
    const { repo, state } = makeRepo([makeKey({ id: 'k_x', accountId: 'acc_1' })]);
    const { webhooks, calls: hookCalls } = makeWebhooks();
    const { audit, calls: auditCalls } = makeAudit();
    const invalidated: string[] = [];
    const authCache: AuthCache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      invalidateKey: (id) => {
        invalidated.push(id);
        return Promise.resolve();
      },
      invalidateAccount: () => Promise.resolve(),
    };
    const svc = new ApiKeysService(repo, authCache, webhooks, null, audit);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => svc.revoke(ctxWith(['account_owner']), 'k_x')),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(state.revoked).toHaveLength(1);
    expect(invalidated).toEqual(['k_x']);
    expect(hookCalls).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    expect(state.rows[0]?.revokedAt).toEqual(state.revoked[0]?.at);
  });

  it('keeps customer revocation account-scoped at the atomic repository boundary', async () => {
    const { repo, state } = makeRepo([makeKey({ id: 'k_x', accountId: 'acc_other' })]);
    const svc = new ApiKeysService(repo);

    await expect(svc.revoke(ctxWith(['account_owner']), 'k_x')).rejects.toThrow(/not found/);
    expect(state.revoked).toHaveLength(0);
    expect(state.rows[0]?.revokedAt).toBeNull();
  });
});

describe('C1 — device-provisioned caller barred from key operations (service chokepoint)', () => {
  it('create() rejects a cli_device caller even holding account_owner', async () => {
    const { repo } = makeRepo();
    const svc = new ApiKeysService(repo);
    await expect(
      svc.create(deviceCtx(['account_owner']), { name: 'x', scopes: ['read'], expiresAt: null }),
    ).rejects.toThrow(/[Dd]evice-provisioned/);
  });

  it('rotate() rejects a cli_device caller', async () => {
    const { repo } = makeRepo([makeKey({ id: 'k_old', accountId: 'acc_1' })]);
    const svc = new ApiKeysService(repo);
    await expect(svc.rotate(deviceCtx(['account_owner']), 'k_old')).rejects.toThrow(
      /[Dd]evice-provisioned/,
    );
  });

  it('revoke() rejects a cli_device caller', async () => {
    const { repo } = makeRepo([makeKey({ id: 'k_x', accountId: 'acc_1' })]);
    const svc = new ApiKeysService(repo);
    await expect(svc.revoke(deviceCtx(['account_owner']), 'k_x')).rejects.toThrow(
      /[Dd]evice-provisioned/,
    );
  });
});
