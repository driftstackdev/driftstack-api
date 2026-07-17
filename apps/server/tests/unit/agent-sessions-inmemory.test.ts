// AI-A — unit tests for InMemoryAgentSessionsRepo.
//
// Covers the contract for follow-up Drizzle impl (AI-A.c): create
// mints id + zeros transcript + sets tokenBudgetRemaining =
// tokenBudgetTotal; appendTranscript is append-only + bumps updatedAt;
// debitTokens floors at 0 (no negative budget); closeWithReason sets
// status + reason; get/listByAccount; rejection on unknown id.

import { describe, expect, it } from 'vitest';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';

function fixed(date: string): () => Date {
  return () => new Date(date);
}

describe('AI-A InMemoryAgentSessionsRepo', () => {
  it('create: mints `agt_inmem_<counter>` id, transcript empty, budget remaining = total, status active, no closedReason', async () => {
    const repo = new InMemoryAgentSessionsRepo(fixed('2026-05-16T00:00:00Z'));
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 10_000 });
    expect(rec.id).toBe('agt_inmem_00000001');
    expect(rec.accountId).toBe('acc_1');
    expect(rec.transcript).toEqual([]);
    expect(rec.tokenBudgetTotal).toBe(10_000);
    expect(rec.tokenBudgetRemaining).toBe(10_000);
    expect(rec.status).toBe('active');
    expect(rec.closedReason).toBeNull();
    expect(rec.driftstackSessionId).toBeNull();
  });

  it('create: monotonic counter (00000001, 00000002, …)', async () => {
    const repo = new InMemoryAgentSessionsRepo(fixed('2026-05-16T00:00:00Z'));
    const a = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    const b = await repo.create({ accountId: 'acc_2', tokenBudgetTotal: 1 });
    expect(a.id).toBe('agt_inmem_00000001');
    expect(b.id).toBe('agt_inmem_00000002');
  });

  it('create: pre-attached driftstackSessionId is preserved on the record', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      driftstackSessionId: 'ses_xyz',
    });
    expect(rec.driftstackSessionId).toBe('ses_xyz');
  });

  it('get: returns null for unknown id (does NOT throw)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    expect(await repo.get('agt_inmem_99999999')).toBeNull();
  });

  it('listByAccount: filters by accountId; returns empty array for accounts with no agent sessions', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    await repo.create({ accountId: 'acc_2', tokenBudgetTotal: 1 });
    const acc1 = await repo.listByAccount('acc_1');
    const acc2 = await repo.listByAccount('acc_2');
    const acc3 = await repo.listByAccount('acc_3');
    expect(acc1).toHaveLength(2);
    expect(acc2).toHaveLength(1);
    expect(acc3).toEqual([]);
  });

  it('listByAccount: most-recent first (createdAt desc) + honors the optional limit (DB-paging parity)', async () => {
    let now = new Date('2026-06-22T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const a = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    now = new Date('2026-06-22T00:01:00Z');
    const b = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    now = new Date('2026-06-22T00:02:00Z');
    const c = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1 });
    // Unlimited → all three, newest first (matches the Drizzle ORDER BY desc so
    // the route renders the same page against either backend).
    const all = await repo.listByAccount('acc_1');
    expect(all.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    // limit caps to the N most-recent (the route passes { limit: 100 } so a busy
    // account's full history is never pulled into memory).
    const top2 = await repo.listByAccount('acc_1', { limit: 2 });
    expect(top2.map((r) => r.id)).toEqual([c.id, b.id]);
  });

  it('appendTranscript: append-only, ordered, bumps updatedAt; previous transcript array is NOT mutated', async () => {
    let now = new Date('2026-05-16T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const initial = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });

    now = new Date('2026-05-16T00:01:00Z');
    const r1 = await repo.appendTranscript(initial.id, {
      at: '2026-05-16T00:01:00Z',
      role: 'user',
      body: 'hi',
    });
    expect(r1.transcript).toHaveLength(1);
    expect(r1.transcript[0]?.body).toBe('hi');
    expect(r1.updatedAt.toISOString()).toBe('2026-05-16T00:01:00.000Z');

    now = new Date('2026-05-16T00:02:00Z');
    const r2 = await repo.appendTranscript(initial.id, {
      at: '2026-05-16T00:02:00Z',
      role: 'agent',
      body: 'plan',
    });
    expect(r2.transcript).toHaveLength(2);
    expect(r2.transcript[1]?.role).toBe('agent');

    // Initial record's transcript ref must NOT have been mutated.
    expect(initial.transcript).toHaveLength(0);
  });

  it('appendTranscript: rejects on unknown id (NOT a no-op — callers need to know)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(
      repo.appendTranscript('agt_inmem_99999999', { at: 'x', role: 'user', body: 'x' }),
    ).rejects.toThrow(/AgentSession .* not found/);
  });

  it('active-only transcript/debit mutations succeed while active, then return null without changing the close winner', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });

    const appended = await repo.appendTranscriptIfActive(created.id, {
      at: 'active',
      role: 'user',
      body: 'accepted before close',
    });
    expect(appended?.transcript.map((entry) => entry.body)).toEqual(['accepted before close']);
    expect((await repo.debitTokensIfActive(created.id, 25))?.tokenBudgetRemaining).toBe(75);

    const closed = await repo.closeWithReason(created.id, 'customer-closed');
    await expect(
      repo.appendTranscriptIfActive(created.id, {
        at: 'late',
        role: 'agent',
        body: 'must not land',
      }),
    ).resolves.toBeNull();
    await expect(repo.debitTokensIfActive(created.id, 50)).resolves.toBeNull();
    await expect(
      repo.appendTranscriptIfActive('agt_inmem_99999999', {
        at: 'missing',
        role: 'user',
        body: 'missing',
      }),
    ).resolves.toBeNull();
    await expect(repo.debitTokensIfActive('agt_inmem_99999999', 1)).resolves.toBeNull();
    expect(await repo.get(created.id)).toEqual(closed);
  });

  it('authority revision is monotonic only for semantic status/mode/pair changes and fences value-equivalent ABA writes', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const created = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(await repo.getAuthoritySnapshot(created.id)).toEqual({
      status: 'active',
      mode: 'ai',
      pairModeState: null,
      revision: 0,
    });

    await repo.appendTranscriptIfAuthorityRevision(created.id, 0, {
      at: 'r0',
      role: 'user',
      body: 'exact revision accepted',
    });
    await repo.debitTokensIfActive(created.id, 10);
    await repo.setNodeId(created.id, 'node-a');
    await repo.setGuiControlKeyIfActive({
      id: created.id,
      ciphertext: Buffer.from('ciphertext'),
      expiresAt: null,
    });
    await repo.setMode(created.id, 'ai', null); // exact no-op
    expect((await repo.getAuthoritySnapshot(created.id))?.revision).toBe(0);

    await repo.setMode(created.id, 'manual', null);
    expect((await repo.getAuthoritySnapshot(created.id))?.revision).toBe(1);
    await repo.setMode(created.id, 'ai', null);
    expect(await repo.getAuthoritySnapshot(created.id)).toEqual({
      status: 'active',
      mode: 'ai',
      pairModeState: null,
      revision: 2,
    });

    // The value tuple is back to its original shape, but the stale epoch can
    // neither publish a transcript suffix nor close the human successor.
    await expect(
      repo.appendTranscriptIfAuthorityRevision(created.id, 0, {
        at: 'stale',
        role: 'agent',
        body: 'must not land',
      }),
    ).resolves.toBeNull();
    await expect(
      repo.closeWithReasonIfAuthorityRevision(created.id, 0, 'stale-budget-close'),
    ).resolves.toBeNull();

    await expect(
      repo.appendTranscriptIfAuthorityRevision(created.id, 2, {
        at: 'r2',
        role: 'agent',
        body: 'current epoch accepted',
      }),
    ).resolves.toMatchObject({ status: 'active' });
    const closed = await repo.closeWithReasonIfAuthorityRevision(
      created.id,
      2,
      'current-owner-close',
    );
    expect(closed).toMatchObject({ status: 'closed', closedReason: 'current-owner-close' });
    expect((await repo.getAuthoritySnapshot(created.id))?.revision).toBe(3);
  });

  it('every in-memory bulk terminal transition advances the same authority epoch exactly once', async () => {
    let now = new Date('2026-07-17T00:00:00.000Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const nodeClosed = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    const orphaned = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(nodeClosed.id, 'node-a');
    expect(await repo.closeActiveByNode('node-a', 'worker-disconnected')).toBe(1);
    expect((await repo.getAuthoritySnapshot(nodeClosed.id))?.revision).toBe(1);

    now = new Date('2026-07-17T01:00:00.000Z');
    expect(await repo.reapOrphanedActiveBefore(now)).toBe(1);
    expect((await repo.getAuthoritySnapshot(orphaned.id))?.revision).toBe(1);
    expect(await repo.reapOrphanedActiveBefore(now)).toBe(0);
    expect((await repo.getAuthoritySnapshot(orphaned.id))?.revision).toBe(1);
  });

  it('debitTokens: subtracts from remaining + floors at 0 (no negative budget)', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const r0 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 1000 });
    const r1 = await repo.debitTokens(r0.id, 300);
    expect(r1.tokenBudgetRemaining).toBe(700);
    const r2 = await repo.debitTokens(r0.id, 600);
    expect(r2.tokenBudgetRemaining).toBe(100);
    // Over-debit floors at 0, not negative.
    const r3 = await repo.debitTokens(r0.id, 999);
    expect(r3.tokenBudgetRemaining).toBe(0);
  });

  it('debitTokens: rejects on unknown id', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(repo.debitTokens('agt_inmem_99999999', 10)).rejects.toThrow();
  });

  it('closeWithReason: sets status closed + closedReason + bumps updatedAt; preserves transcript + remaining budget snapshot', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const r0 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.appendTranscript(r0.id, { at: 'x', role: 'user', body: 'hi' });
    await repo.debitTokens(r0.id, 25);
    const closed = await repo.closeWithReason(r0.id, 'customer-closed');
    expect(closed.status).toBe('closed');
    expect(closed.closedReason).toBe('customer-closed');
    expect(closed.transcript).toHaveLength(1);
    expect(closed.tokenBudgetRemaining).toBe(75);
  });

  it('closeWithReason: rejects on unknown id', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(repo.closeWithReason('agt_inmem_99999999', 'x')).rejects.toThrow();
  });

  // v2-#19 — Stripe-pattern idempotency-key + closedAt hardening.
  it('v2-#19 create: idempotencyKey + createdByUserId default to NULL on the record when caller omits them; closedAt is NULL while active', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(rec.idempotencyKey).toBeNull();
    expect(rec.createdByUserId).toBeNull();
    expect(rec.closedAt).toBeNull();
  });

  it('v2-#19 create: idempotencyKey + createdByUserId persist when supplied; round-trip via findByIdempotencyKey and listByAccount', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      idempotencyKey: 'idem-abc',
      createdByUserId: 'usr_team_member_1',
    });
    expect(rec.idempotencyKey).toBe('idem-abc');
    expect(rec.createdByUserId).toBe('usr_team_member_1');
    const looked = await repo.findByIdempotencyKey('acc_1', 'idem-abc');
    expect(looked?.id).toBe(rec.id);
  });

  it('v2-#19 findByIdempotencyKey: scoped per-account — customer A "key=foo" does NOT collide with customer B "key=foo"', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const a = await repo.create({
      accountId: 'acc_A',
      tokenBudgetTotal: 1,
      idempotencyKey: 'shared',
    });
    const b = await repo.create({
      accountId: 'acc_B',
      tokenBudgetTotal: 1,
      idempotencyKey: 'shared',
    });
    expect(a.id).not.toBe(b.id);
    expect((await repo.findByIdempotencyKey('acc_A', 'shared'))?.id).toBe(a.id);
    expect((await repo.findByIdempotencyKey('acc_B', 'shared'))?.id).toBe(b.id);
    expect(await repo.findByIdempotencyKey('acc_C', 'shared')).toBeNull();
    expect(await repo.findByIdempotencyKey('acc_A', 'other')).toBeNull();
  });

  // Arc 2 sub-slice 8.2 (v2-#8) — mode + pair-mode-state plumbing.
  it("v2-#8 sub-slice 8.2 create defaults mode='ai' + pairModeState=null + guiControlKeyExpiresAt=null", async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(rec.mode).toBe('ai');
    expect(rec.pairModeState).toBeNull();
    expect(rec.guiControlKeyExpiresAt).toBeNull();
  });

  it("v2-#8 sub-slice 8.2 create with mode='manual' or 'pair' round-trips on the record", async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const manual = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      mode: 'manual',
    });
    expect(manual.mode).toBe('manual');
    const pair = await repo.create({
      accountId: 'acc_2',
      tokenBudgetTotal: 100,
      mode: 'pair',
    });
    expect(pair.mode).toBe('pair');
  });

  it('v2-#8 sub-slice 8.2 setPairModeState round-trips arbitrary JSON; bumps updatedAt; rejects on unknown id', async () => {
    let now = new Date('2026-05-18T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      mode: 'pair',
    });
    expect(rec.pairModeState).toBeNull();
    now = new Date('2026-05-18T00:05:00Z');
    const updated = await repo.setPairModeState(rec.id, { kind: 'takeover-pending', by: 'cli_a' });
    expect(updated.pairModeState).toEqual({ kind: 'takeover-pending', by: 'cli_a' });
    expect(updated.updatedAt.toISOString()).toBe('2026-05-18T00:05:00.000Z');
    // null clears.
    const cleared = await repo.setPairModeState(rec.id, null);
    expect(cleared.pairModeState).toBeNull();
    await expect(repo.setPairModeState('agt_inmem_99999999', { x: 1 })).rejects.toThrow(
      /AgentSession .* not found/,
    );
  });

  it('compareAndSetPairModeState commits only the exact active pair state and never overwrites mode/state winners', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      mode: 'pair',
    });
    const expected = rec.pairModeState;
    const pending = {
      kind: 'takeover-pending',
      requestedByClientId: 'cli_a',
      requestedAt: '2026-07-13T12:00:00.000Z',
    };
    const committed = await repo.compareAndSetPairModeState(rec.id, expected, pending);
    expect(committed?.pairModeState).toEqual(pending);

    // A delayed writer carrying the old snapshot cannot replace the winner.
    await expect(
      repo.compareAndSetPairModeState(rec.id, expected, {
        ...pending,
        requestedByClientId: 'cli_b',
      }),
    ).resolves.toBeNull();
    expect((await repo.get(rec.id))?.pairModeState).toEqual(pending);

    // A concurrent top-level mode change clears pair state and permanently
    // disqualifies the stale pair transition in the same atomic predicate.
    await repo.setMode(rec.id, 'manual', null);
    await expect(
      repo.compareAndSetPairModeState(rec.id, pending, { kind: 'ai-driving' }),
    ).resolves.toBeNull();
    expect(await repo.get(rec.id)).toMatchObject({ mode: 'manual', pairModeState: null });

    const closed = await repo.create({
      accountId: 'acc_2',
      tokenBudgetTotal: 100,
      mode: 'pair',
    });
    await repo.closeWithReason(closed.id, 'done');
    await expect(
      repo.compareAndSetPairModeState(closed.id, closed.pairModeState, pending),
    ).resolves.toBeNull();
    await expect(repo.compareAndSetPairModeState('agt_missing', null, pending)).resolves.toBeNull();
  });

  it('Slice 3 (Wave 29-NNN ARC 3) setMode: ai → pair sets pair_mode_state to initial state; pair → manual clears it; idempotent same-target preserves state; bumps updatedAt; rejects on unknown id', async () => {
    let now = new Date('2026-05-19T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(rec.mode).toBe('ai');
    expect(rec.pairModeState).toBeNull();

    // ai → pair: initial pair_mode_state.
    now = new Date('2026-05-19T00:05:00Z');
    const toPair = await repo.setMode(rec.id, 'pair', { kind: 'ai-driving' });
    expect(toPair.mode).toBe('pair');
    expect(toPair.pairModeState).toEqual({ kind: 'ai-driving' });
    expect(toPair.updatedAt.toISOString()).toBe('2026-05-19T00:05:00.000Z');

    // pair → manual: clears state.
    now = new Date('2026-05-19T00:10:00Z');
    const toManual = await repo.setMode(rec.id, 'manual', null);
    expect(toManual.mode).toBe('manual');
    expect(toManual.pairModeState).toBeNull();
    expect(toManual.updatedAt.toISOString()).toBe('2026-05-19T00:10:00.000Z');

    // manual → pair: re-initializes.
    now = new Date('2026-05-19T00:15:00Z');
    const reToPair = await repo.setMode(rec.id, 'pair', { kind: 'ai-driving' });
    expect(reToPair.mode).toBe('pair');
    expect(reToPair.pairModeState).toEqual({ kind: 'ai-driving' });

    // unknown id rejects.
    await expect(repo.setMode('agt_inmem_99999999', 'ai', null)).rejects.toThrow(
      /AgentSession .* not found/,
    );
  });

  it('Slice 3 setMode pair → ai: clears non-trivial pair_mode_state (caller controls state argument; a route layer transitioning OUT of pair MUST pass null)', async () => {
    const repo = new InMemoryAgentSessionsRepo(() => new Date('2026-05-19T00:00:00Z'));
    const rec = await repo.create({
      accountId: 'acc_1',
      tokenBudgetTotal: 100,
      mode: 'pair',
    });
    // Seed mid-takeover state.
    await repo.setPairModeState(rec.id, {
      kind: 'takeover-pending',
      requestedByClientId: 'cli_a',
      requestedAt: '2026-05-19T00:01:00Z',
    });
    // setMode to ai with null state clears.
    const cleared = await repo.setMode(rec.id, 'ai', null);
    expect(cleared.mode).toBe('ai');
    expect(cleared.pairModeState).toBeNull();
  });

  it('Slice 3 setMode idempotent ai → ai: returns a row with mode unchanged + pair_mode_state echoed', async () => {
    const repo = new InMemoryAgentSessionsRepo(() => new Date('2026-05-19T00:00:00Z'));
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    const same = await repo.setMode(rec.id, 'ai', null);
    expect(same.mode).toBe('ai');
    expect(same.pairModeState).toBeNull();
  });

  it('active-only GUI-key/mode setters preserve a close winner while unconditional fixture setters remain compatible', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    const firstKey = Buffer.from('active-key');
    await expect(
      repo.setGuiControlKeyIfActive({
        id: rec.id,
        ciphertext: firstKey,
        expiresAt: new Date('2026-07-16T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ guiControlKeyCiphertext: firstKey });
    await expect(
      repo.setModeIfActive(rec.id, 'pair', { kind: 'ai-driving' }),
    ).resolves.toMatchObject({ mode: 'pair', pairModeState: { kind: 'ai-driving' } });

    const closed = await repo.closeWithReason(rec.id, 'customer-closed');
    await expect(
      repo.setGuiControlKeyIfActive({
        id: rec.id,
        ciphertext: Buffer.from('late-key'),
        expiresAt: new Date('2026-07-17T00:00:00.000Z'),
      }),
    ).resolves.toBeNull();
    await expect(repo.setModeIfActive(rec.id, 'manual', null)).resolves.toBeNull();
    await expect(
      repo.setGuiControlKeyIfActive({
        id: 'agt_missing',
        ciphertext: Buffer.from('missing'),
        expiresAt: null,
      }),
    ).resolves.toBeNull();
    await expect(repo.setModeIfActive('agt_missing', 'manual', null)).resolves.toBeNull();
    expect(await repo.get(rec.id)).toEqual(closed);

    // Deliberately preserve the unconditional setters for direct fixture setup.
    const fixtureKey = Buffer.from('fixture-key');
    await repo.setGuiControlKey({ id: rec.id, ciphertext: fixtureKey, expiresAt: null });
    await repo.setMode(rec.id, 'manual', null);
    expect(await repo.get(rec.id)).toMatchObject({
      status: 'closed',
      closedReason: 'customer-closed',
      guiControlKeyCiphertext: fixtureKey,
      mode: 'manual',
      pairModeState: null,
    });
  });

  it('v2-#19 closeWithReason: first close owns timestamp AND reason; re-close is an idempotent read', async () => {
    let now = new Date('2026-05-16T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const r0 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(r0.closedAt).toBeNull();

    now = new Date('2026-05-16T00:10:00Z');
    const first = await repo.closeWithReason(r0.id, 'customer-closed');
    expect(first.closedAt?.toISOString()).toBe('2026-05-16T00:10:00.000Z');

    now = new Date('2026-05-16T00:20:00Z');
    const reClosed = await repo.closeWithReason(r0.id, 'budget-exhausted');
    expect(reClosed.closedReason).toBe('customer-closed');
    expect(reClosed.closedAt?.toISOString()).toBe('2026-05-16T00:10:00.000Z');
    expect(reClosed.updatedAt.toISOString()).toBe('2026-05-16T00:10:00.000Z');
    expect(await repo.get(r0.id)).toEqual(first);
  });

  it('closeWithReason Promise.all contenders return the same first-winner row', async () => {
    const repo = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:10:00Z'));
    const created = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });

    const [first, sibling] = await Promise.all([
      repo.closeWithReason(created.id, 'customer-closed'),
      repo.closeWithReason(created.id, 'budget-exhausted'),
    ]);

    expect(first.closedReason).toBe('customer-closed');
    expect(sibling).toEqual(first);
    expect(await repo.get(created.id)).toEqual(first);
  });

  it('closeWithReasonOutcome elects exactly one side-effect owner across five contenders', async () => {
    const repo = new InMemoryAgentSessionsRepo(() => new Date('2026-05-16T00:10:00Z'));
    const created = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        repo.closeWithReasonOutcome(created.id, `contender-${index}`),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'closed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'already_closed')).toHaveLength(4);
    expect(outcomes.map((outcome) => outcome.session)).toEqual(
      Array.from({ length: 5 }, () => outcomes[0]!.session),
    );
    expect(await repo.get(created.id)).toEqual(outcomes[0]!.session);
  });

  // ─── Worker-disconnect fix (2026-06-19, migration 0086) ─────────────

  it('0086 setNodeId: persists node_id + bumps updatedAt; create() leaves node_id null', async () => {
    let now = new Date('2026-06-19T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    expect(rec.nodeId).toBeNull();
    now = new Date('2026-06-19T00:05:00Z');
    const updated = await repo.setNodeId(rec.id, 'mac-macstadium-us-001');
    expect(updated!.nodeId).toBe('mac-macstadium-us-001');
    expect(updated!.updatedAt.toISOString()).toBe('2026-06-19T00:05:00.000Z');
    expect((await repo.get(rec.id))!.nodeId).toBe('mac-macstadium-us-001');
  });

  it('0086 setNodeId: an unknown id is a no-op returning null — never throws', async () => {
    const repo = new InMemoryAgentSessionsRepo();
    await expect(repo.setNodeId('agt_does_not_exist', 'node-x')).resolves.toBeNull();
  });

  it('0086 setNodeId: a close winner makes the active-only ownership claim return null without mutating terminal fields', async () => {
    let now = new Date('2026-06-19T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);
    const rec = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    now = new Date('2026-06-19T00:05:00Z');
    const closed = await repo.closeWithReason(rec.id, 'customer-closed');

    now = new Date('2026-06-19T00:10:00Z');
    await expect(repo.setNodeId(rec.id, 'node-too-late')).resolves.toBeNull();

    const after = await repo.get(rec.id);
    expect(after).toEqual(closed);
    expect(after).toMatchObject({
      status: 'closed',
      closedReason: 'customer-closed',
      nodeId: null,
    });
  });

  it('0086 closeActiveByNode: closes ONLY this node’s active sessions; another node’s, an already-closed one, and a never-dispatched (null node_id) one are untouched', async () => {
    let now = new Date('2026-06-19T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);

    // (1) two active sessions on node-A → both must close.
    const a1 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    const a2 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(a1.id, 'node-A');
    await repo.setNodeId(a2.id, 'node-A');

    // (2) an active session on node-B → must survive (another node).
    const b1 = await repo.create({ accountId: 'acc_2', tokenBudgetTotal: 100 });
    await repo.setNodeId(b1.id, 'node-B');

    // (3) an ALREADY-closed session on node-A → must keep its original reason.
    const closedOnA = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(closedOnA.id, 'node-A');
    await repo.closeWithReason(closedOnA.id, 'customer-closed');

    // (4) a never-dispatched active session (node_id null) → must survive.
    const undispatched = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });

    now = new Date('2026-06-19T00:10:00Z');
    const closed = await repo.closeActiveByNode('node-A', 'worker-disconnected');
    expect(closed).toBe(2);

    const a1After = await repo.get(a1.id);
    expect(a1After!.status).toBe('closed');
    expect(a1After!.closedReason).toBe('worker-disconnected');
    expect(a1After!.closedAt?.toISOString()).toBe('2026-06-19T00:10:00.000Z');
    expect((await repo.get(a2.id))!.status).toBe('closed');

    // node-B untouched.
    expect((await repo.get(b1.id))!.status).toBe('active');
    expect((await repo.get(b1.id))!.closedReason).toBeNull();

    // already-closed row keeps its original reason (not re-stamped).
    const closedAfter = await repo.get(closedOnA.id);
    expect(closedAfter!.closedReason).toBe('customer-closed');

    // never-dispatched row untouched (null node_id never matches).
    expect((await repo.get(undispatched.id))!.status).toBe('active');

    // Idempotent — a second close on the same node closes nothing new.
    expect(await repo.closeActiveByNode('node-A', 'worker-disconnected')).toBe(0);
  });

  it('W2813 closeActiveByNodeExcept: closes this node’s active sessions EXCEPT the reaffirmed ids; another node + a kept id survive; empty keep-set == closeActiveByNode', async () => {
    let now = new Date('2026-06-23T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);

    // node-A: three active sessions — a1/a2 orphaned by the restart, aKeep reaffirmed.
    const a1 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    const a2 = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    const aKeep = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(a1.id, 'node-A');
    await repo.setNodeId(a2.id, 'node-A');
    await repo.setNodeId(aKeep.id, 'node-A');

    // node-B active session — another node, must survive.
    const b1 = await repo.create({ accountId: 'acc_2', tokenBudgetTotal: 100 });
    await repo.setNodeId(b1.id, 'node-B');

    now = new Date('2026-06-23T00:05:00Z');
    const closed = await repo.closeActiveByNodeExcept('node-A', [aKeep.id], 'worker-restarted');
    expect(closed).toBe(2);

    expect((await repo.get(a1.id))!.status).toBe('closed');
    expect((await repo.get(a1.id))!.closedReason).toBe('worker-restarted');
    expect((await repo.get(a2.id))!.status).toBe('closed');
    // Reaffirmed session NOT swept — the new boot still has it.
    expect((await repo.get(aKeep.id))!.status).toBe('active');
    // Another node untouched.
    expect((await repo.get(b1.id))!.status).toBe('active');

    // Empty keep-set behaves exactly like closeActiveByNode (sweeps the rest).
    const rest = await repo.closeActiveByNodeExcept('node-A', [], 'worker-restarted');
    expect(rest).toBe(1); // only aKeep was left active on node-A
    expect((await repo.get(aKeep.id))!.status).toBe('closed');
  });

  it('W2820 closeActiveByNodeExcept minIdleMs: spares a RECENTLY-touched session (a just-dispatched new-boot session) even when absent from keepIds', async () => {
    let now = new Date('2026-06-23T00:00:00Z');
    const repo = new InMemoryAgentSessionsRepo(() => now);

    // An OLD orphan on node-A (assigned long ago, untouched since).
    const old = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(old.id, 'node-A'); // updatedAt = 00:00:00

    // 40s later a NEW session is dispatched to the same node (setNodeId bumps updatedAt).
    now = new Date('2026-06-23T00:00:40Z');
    const fresh = await repo.create({ accountId: 'acc_1', tokenBudgetTotal: 100 });
    await repo.setNodeId(fresh.id, 'node-A'); // updatedAt = 00:00:40

    // Restart sweep at 00:00:41 with a 30s recency window, empty keepIds (the fresh
    // session hasn't been reaffirmed yet — the exact W2820 race).
    now = new Date('2026-06-23T00:00:41Z');
    const closed = await repo.closeActiveByNodeExcept('node-A', [], 'worker-restarted', {
      minIdleMs: 30_000,
    });

    // Only the OLD orphan (idle 41s > 30s) is swept; the FRESH session (idle 1s) is spared.
    expect(closed).toBe(1);
    expect((await repo.get(old.id))!.status).toBe('closed');
    expect((await repo.get(fresh.id))!.status).toBe('active'); // NOT a false close
  });
});
