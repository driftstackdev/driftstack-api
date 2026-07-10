// V-090: unit tests for SessionsService.runWithFailureCapture.
//
// Driver throws → session marked 'errored' + destroyedAt set + 'errored'
// session_event recorded + session.failed webhook fired. Subsequent
// operations on the same session 410 SessionDestroyed (founder-approved
// semantic).

import { describe, expect, it } from 'vitest';
import { SessionsService } from '../../src/services/sessions.js';
import { ConcurrencyLimitError } from '../../src/lib/errors.js';
import type {
  SessionRepo,
  SessionRecord,
  SessionEventInput,
  NewSessionInput,
} from '../../src/services/sessions.js';
import type { Driver } from '../../src/drivers/types.js';
import type { AccountContext } from '../../src/services/auth.js';

interface RecordedEvent {
  accountId: string;
  // §eg.7 expanded the session webhook-event union with
  // 'session.egress_capability_changed'. V-090 suite only fires
  // completed/failed but type stays in lockstep with the service.
  eventType: 'session.completed' | 'session.failed' | 'session.egress_capability_changed';
  data: Record<string, unknown>;
}

function buildCtx(): AccountContext {
  return {
    account: {
      id: 'acc-uuid-test',
      email: 'tester@driftstack.local',
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    apiKey: {
      id: 'key-uuid-test',
      accountId: 'acc-uuid-test',
      name: 'tester',
      keyPrefix: 'ds_test_xxxx',
      keyHash: 'fake',
      scopes: ['read', 'write'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    rateLimitOverrides: {},
    teams: [],
    webSession: null,
  };
}

class StubRepo implements SessionRepo {
  private readonly sessions = new Map<string, SessionRecord>();
  readonly events: SessionEventInput[] = [];
  /** Opt-in (default null): when set, insertSession /
   *  insertSessionIfUnderLimit reject with it.
   *  Used to exercise the create() driver-session orphan rollback. */
  throwOnInsert: Error | null = null;
  /** Opt-in (default false): when true, insertSessionIfUnderLimit returns null
   *  (simulates the atomic cap guard rejecting a concurrent-race loser) —
   *  exercises the create() over-cap orphan rollback + ConcurrencyLimitError. */
  overCapOnInsert = false;
  /** Opt-in (default null): when set, setSessionDriverSessionId rejects with it
   *  — simulates a post-dispatch DB-write failure AFTER the worker is live.
   *  Exercises the create() post-dispatch slot-release path. */
  throwOnSetDriverSessionId: Error | null = null;
  /** Opt-in (default null): when set, recordEvent rejects for the matching
   *  event type — exercises the create() best-effort created-event guard (a
   *  post-success event write must not fail the request + leak the live session). */
  throwOnRecordEventType: { type: string; error: Error } | null = null;

  insertSession(input: NewSessionInput): Promise<SessionRecord> {
    if (this.throwOnInsert !== null) return Promise.reject(this.throwOnInsert);
    const id = `sess-${this.sessions.size.toString().padStart(4, '0')}`;
    const now = new Date();
    const row: SessionRecord = {
      id,
      accountId: input.accountId,
      apiKeyId: input.apiKeyId,
      driverSessionId: input.driverSessionId,
      status: 'creating',
      archetype: input.archetype,
      purpose: input.purpose,
      label: input.label,
      metadata: input.metadata,
      egressCapabilities: null,
      egressCapabilityReport: null,
      createdAt: now,
      updatedAt: now,
      lastStateAt: null,
      destroyedAt: null,
    };
    this.sessions.set(id, row);
    return Promise.resolve(row);
  }
  insertSessionIfUnderLimit(input: NewSessionInput, limit: number): Promise<SessionRecord | null> {
    if (this.throwOnInsert !== null) return Promise.reject(this.throwOnInsert);
    if (this.overCapOnInsert) return Promise.resolve(null);
    let active = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === input.accountId && s.destroyedAt === null) active += 1;
    }
    if (active >= limit) return Promise.resolve(null);
    return this.insertSession(input);
  }
  setSessionDriverSessionId(id: string, driverSessionId: string): Promise<void> {
    if (this.throwOnSetDriverSessionId !== null) {
      return Promise.reject(this.throwOnSetDriverSessionId);
    }
    const r = this.sessions.get(id);
    if (r) this.sessions.set(id, { ...r, driverSessionId, updatedAt: new Date() });
    return Promise.resolve();
  }
  findSession(id: string, accountId: string): Promise<SessionRecord | null> {
    const r = this.sessions.get(id);
    if (!r || r.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(r);
  }
  findSessionUnscoped(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }
  // Terminal statuses ('destroyed', 'errored') are STICKY — mirrors the Drizzle
  // repo's notInArray(status, ['destroyed','errored']) WHERE clause so service
  // tests exercise the real concurrent-destroy resurrection guard: a write onto
  // an already-terminal row is a silent no-op.
  updateSessionStatus(
    id: string,
    status: SessionRecord['status'],
    extra?: { lastStateAt?: Date; destroyedAt?: Date },
  ): Promise<void> {
    const r = this.sessions.get(id);
    if (!r || r.status === 'destroyed' || r.status === 'errored') return Promise.resolve();
    this.sessions.set(id, {
      ...r,
      status,
      ...(extra?.lastStateAt !== undefined ? { lastStateAt: extra.lastStateAt } : {}),
      ...(extra?.destroyedAt !== undefined ? { destroyedAt: extra.destroyedAt } : {}),
    });
    return Promise.resolve();
  }
  countActiveSessions(_accountId: string): Promise<number> {
    return Promise.resolve(0);
  }
  countAllByStatus(): Promise<Record<SessionRecord['status'], number>> {
    return Promise.resolve({ creating: 0, ready: 0, busy: 0, destroyed: 0, errored: 0 });
  }
  listActiveByAccount(): Promise<SessionRecord[]> {
    return Promise.resolve([]);
  }
  listSessions(): Promise<{ items: SessionRecord[]; nextCursor: string | null }> {
    return Promise.resolve({ items: [], nextCursor: null });
  }
  listAllSessions(): Promise<{ items: SessionRecord[]; nextCursor: string | null }> {
    return Promise.resolve({ items: [], nextCursor: null });
  }
  // 6.g — duration auto-destroy sweep query. Not exercised by the V-090
  // driver-failure suite; provided to satisfy the SessionRepo interface.
  listExpiredForAutoDestroy(): Promise<SessionRecord[]> {
    return Promise.resolve([]);
  }
  recordEvent(input: SessionEventInput): Promise<void> {
    if (this.throwOnRecordEventType !== null && this.throwOnRecordEventType.type === input.type) {
      return Promise.reject(this.throwOnRecordEventType.error);
    }
    this.events.push(input);
    return Promise.resolve();
  }

  // §eg.1.b — egress capability report. Not exercised by the V-090
  // driver-failure suite; provided to satisfy the SessionRepo interface
  // after the Wave 29-400 §10 egress wave extended it.
  setEgressCapabilityReport(_args: {
    sessionId: string;
    derived: unknown;
    raw: Record<string, unknown>;
  }): Promise<SessionRecord | null> {
    return Promise.resolve(null);
  }

  /** Test seam. */
  read(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  /** Test seam: synchronously plant a terminal state on a row, standing in for
   *  a CONCURRENT destroy()/error-capture that raced in during a slow box round-
   *  trip. Bypasses the terminal-sticky guard (this IS the concurrent writer). */
  forceTerminal(id: string, status: 'destroyed' | 'errored', destroyedAt: Date): void {
    const r = this.sessions.get(id);
    if (r) this.sessions.set(id, { ...r, status, destroyedAt });
  }
}

class ThrowingDriver implements Driver {
  private nextId = 0;
  private throwOnNext: { name: string; message: string } | null = null;
  /** Records every driver session id passed to destroy() — lets the
   *  create-rollback test assert the orphaned driver session was reaped. */
  readonly destroyedIds: string[] = [];

  /** Opt-in: when set, the NEXT createSession() rejects (simulates a worker-
   *  dispatch failure AFTER the reservation slot was taken). */
  private throwOnCreate: Error | null = null;

  /** Opt-in: when set, the NEXT destroy() rejects (simulates a driver/network
   *  fault on teardown — exercises the destroy() slot-release backstop, #4). */
  private throwOnDestroy: Error | null = null;

  /** Opt-in: runs at the START of getState() — a seam to simulate a CONCURRENT
   *  destroy landing during the box round-trip (before getState's stale write-
   *  back), exercising the resurrection guard. */
  onGetState: (() => void) | null = null;

  primeNextThrow(args: { name: string; message: string }): void {
    this.throwOnNext = args;
  }

  primeCreateThrow(err: Error): void {
    this.throwOnCreate = err;
  }

  primeDestroyThrow(err: Error): void {
    this.throwOnDestroy = err;
  }

  private throwIfArmed(): void {
    if (this.throwOnNext === null) return;
    const t = this.throwOnNext;
    this.throwOnNext = null;
    const err = new Error(t.message);
    err.name = t.name;
    throw err;
  }

  createSession(): Promise<{ driverSessionId: string }> {
    if (this.throwOnCreate !== null) {
      const err = this.throwOnCreate;
      this.throwOnCreate = null;
      return Promise.reject(err);
    }
    this.nextId += 1;
    return Promise.resolve({ driverSessionId: `mock-${this.nextId.toString()}` });
  }
  navigate(): Promise<{ url: string; finalUrl: string; status: number; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({
      url: 'about:blank',
      finalUrl: 'about:blank',
      status: 200,
      durationMs: 1,
    });
  }
  interact(): Promise<{ durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ durationMs: 1 });
  }
  guiInput(): Promise<{ durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ durationMs: 1 });
  }
  wait(): Promise<{ satisfied: boolean; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ satisfied: true, durationMs: 1 });
  }
  getState(): Promise<{
    url: string | null;
    title: string | null;
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    pageState: null;
    capturedAt: Date;
  }> {
    if (this.onGetState !== null) this.onGetState();
    this.throwIfArmed();
    return Promise.resolve({
      url: null,
      title: null,
      cookies: [],
      localStorage: {},
      pageState: null,
      capturedAt: new Date(),
    });
  }
  capture(): Promise<{
    kind: 'screenshot' | 'pdf' | 'dom_snapshot';
    data: string;
    encoding: 'base64' | 'utf8';
    byteSize: number;
    durationMs: number;
  }> {
    this.throwIfArmed();
    return Promise.resolve({
      kind: 'screenshot',
      data: 'AAAA',
      encoding: 'base64',
      byteSize: 4,
      durationMs: 1,
    });
  }
  extract(): Promise<{ value: Record<string, unknown>; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ value: { x: 'mock' }, durationMs: 1 });
  }
  search(): Promise<{ submitted: boolean; resultsVisible?: boolean; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ submitted: true, durationMs: 1 });
  }
  login(): Promise<{ loggedIn: boolean; postLoginUrl?: string; durationMs: number }> {
    this.throwIfArmed();
    return Promise.resolve({ loggedIn: true, durationMs: 1 });
  }
  destroy(driverSessionId: string): Promise<void> {
    this.destroyedIds.push(driverSessionId);
    if (this.throwOnDestroy !== null) {
      const err = this.throwOnDestroy;
      this.throwOnDestroy = null;
      return Promise.reject(err);
    }
    return Promise.resolve();
  }
}

interface LoggedError {
  obj: Record<string, unknown>;
  msg: string;
}

function buildService(): {
  service: SessionsService;
  repo: StubRepo;
  driver: ThrowingDriver;
  webhookEvents: RecordedEvent[];
  loggedErrors: LoggedError[];
} {
  const repo = new StubRepo();
  const driver = new ThrowingDriver();
  const webhookEvents: RecordedEvent[] = [];
  const loggedErrors: LoggedError[] = [];
  const service = new SessionsService({
    repo,
    driver,
    webhooks: {
      enqueueEvent: (accountId, eventType, data) => {
        webhookEvents.push({ accountId, eventType, data });
        return Promise.resolve(1);
      },
    },
    logger: {
      error: (obj, msg) => {
        loggedErrors.push({ obj, msg });
      },
    },
  });
  return { service, repo, driver, webhookEvents, loggedErrors };
}

describe('SessionsService — V-090 driver-failure capture', () => {
  it('navigate driver throw → session.errored + session.failed webhook + re-throw', async () => {
    const { service, repo, driver, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });

    driver.primeNextThrow({ name: 'DriverError', message: 'WebKit handle gone' });

    let caught: unknown;
    try {
      await service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('WebKit handle gone');

    const updated = repo.read(session.id);
    expect(updated?.status).toBe('errored');
    expect(updated?.destroyedAt).toBeInstanceOf(Date);

    const erroredEvent = repo.events.find((e) => e.type === 'errored');
    expect(erroredEvent).toBeDefined();
    expect((erroredEvent?.payload as { operation: string } | null)?.operation).toBe('navigate');

    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]?.eventType).toBe('session.failed');
    expect((webhookEvents[0]?.data as { operation: string }).operation).toBe('navigate');
    expect(webhookEvents[0]?.data.session_id).toBe(`ses_${session.id}`);
  });

  it('subsequent op on errored session 410s without re-firing webhook', async () => {
    const { service, repo, driver, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });

    // First failure
    driver.primeNextThrow({ name: 'DriverError', message: 'first fail' });
    await expect(
      service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' }),
    ).rejects.toThrow();

    expect(webhookEvents).toHaveLength(1);

    // Subsequent op on the same session → SessionDestroyedError
    let caught: unknown;
    try {
      await service.interact(ctx, session.id, { action: { kind: 'tap', selector: 'button' } });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).name).toBe('SessionDestroyedError');

    // No second webhook event
    expect(webhookEvents).toHaveLength(1);
    expect(repo.read(session.id)?.status).toBe('errored');
  });

  it('interact / wait / capture / state — each produces session.failed on driver throw', async () => {
    for (const op of [
      'interact',
      'wait',
      'capture',
      'state',
      'extract',
      'search',
      'login',
    ] as const) {
      const { service, repo, driver, webhookEvents } = buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
      driver.primeNextThrow({ name: 'DriverError', message: `${op} boom` });

      try {
        if (op === 'interact') {
          await service.interact(ctx, session.id, { action: { kind: 'tap', selector: 'b' } });
        } else if (op === 'wait') {
          await service.wait(ctx, session.id, {
            condition: { kind: 'selector', selector: 'b' },
          });
        } else if (op === 'capture') {
          await service.capture(ctx, session.id, { kind: 'screenshot', full_page: false });
        } else if (op === 'extract') {
          await service.extract(ctx, session.id, {
            extractions: [{ name: 'x', selector: '.x', type: 'text' }],
          });
        } else if (op === 'search') {
          await service.search(ctx, session.id, { query: 'q', submit: true });
        } else if (op === 'login') {
          await service.login(ctx, session.id, { username: 'u', password: 'p' });
        } else {
          await service.getState(ctx, session.id);
        }
      } catch {
        // expected
      }

      expect(webhookEvents).toHaveLength(1);
      expect(webhookEvents[0]?.eventType).toBe('session.failed');
      const webhookOp = (webhookEvents[0]?.data as { operation: string }).operation;
      // capture / state map to capture / state_capture in the operation
      // tag respectively
      const expectedOp = op === 'state' ? 'state_capture' : op;
      expect(webhookOp).toBe(expectedOp);
      expect(repo.read(session.id)?.status).toBe('errored');
    }
  });

  it('create: a DB reservation-insert failure spins NO worker (the slot is reserved before dispatch)', async () => {
    // DoS hardening — the reservation insert now runs BEFORE driver.createSession.
    // When it throws, no worker was ever spun, so there is nothing to orphan or
    // tear down. The ORIGINAL insert error still propagates.
    const { service, driver, repo } = buildService();
    const ctx = buildCtx();
    const insertErr = new Error('DB insertSession failed');
    repo.throwOnInsert = insertErr;

    let caught: unknown;
    try {
      await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(insertErr);
    // No driver session was spun — createSession never ran (reserve-first).
    expect(driver.destroyedIds).toEqual([]);
  });

  it('create: the atomic cap guard returning null (over cap) spins NO worker + throws ConcurrencyLimitError', async () => {
    // DoS hardening — the atomic cap check is the FIRST step now. Over the cap
    // it returns null BEFORE driver.createSession, so an over-cap create never
    // spins a worker (the whole point of the fix: no worker to orphan, no
    // best-effort teardown to fail). The cap error surfaces, not a 500.
    const { service, driver, repo } = buildService();
    const ctx = buildCtx();
    repo.overCapOnInsert = true;

    let caught: unknown;
    try {
      await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConcurrencyLimitError);
    // No worker spun for an over-cap create.
    expect(driver.destroyedIds).toEqual([]);
  });

  it('create: a worker-DISPATCH failure (after the slot is reserved) releases the reservation row so it stops counting against the cap', async () => {
    // The slot is reserved, then driver.createSession throws. The reservation
    // row must be released (status errored + destroyedAt) so it stops counting
    // against the cap; the dispatch error propagates.
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const driverThrow = new Error('worker dispatch failed');
    driver.primeCreateThrow(driverThrow);

    let caught: unknown;
    try {
      await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(driverThrow);
    // The reservation row (sess-0000) was released (errored + destroyedAt) so
    // it no longer counts against the cap — no leaked slot.
    const reserved = repo.read('sess-0000');
    expect(reserved?.status).toBe('errored');
    expect(reserved?.destroyedAt).toBeInstanceOf(Date);
  });

  it('create: a POST-dispatch DB-write failure releases the slot + tears down the orphaned worker + loud-logs', async () => {
    // Billing-integrity hardening — the worker dispatch SUCCEEDED, then the
    // setSessionDriverSessionId write throws. Without a guard the row would be
    // stuck at status=creating, destroyedAt=NULL forever, leaking a concurrency
    // slot (paid tiers have no minute-cap so the duration sweeper never reaps
    // it; the worker is live so the disconnect reaper won't either).
    const { service, repo, driver, loggedErrors } = buildService();
    const ctx = buildCtx();
    const writeErr = new Error('post-dispatch DB write failed');
    repo.throwOnSetDriverSessionId = writeErr;

    let caught: unknown;
    try {
      await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    } catch (e) {
      caught = e;
    }
    // The original write error propagates.
    expect(caught).toBe(writeErr);
    // The reserved row was released so it stops counting against the cap.
    const reserved = repo.read('sess-0000');
    expect(reserved?.status).toBe('errored');
    expect(reserved?.destroyedAt).toBeInstanceOf(Date);
    // The now-orphaned live worker was torn down (nothing else would).
    expect(driver.destroyedIds).toEqual(['mock-1']);
    // The leak was logged loudly with the account + session ids.
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]?.obj.event).toBe('post_dispatch_bind_failed');
    expect(loggedErrors[0]?.obj.account_id).toBe('acc-uuid-test');
    expect(loggedErrors[0]?.obj.session_id).toBe('sess-0000');
  });

  it('create: a SUCCESSFUL reservation + dispatch spins exactly one worker, no teardown', async () => {
    const { service, driver } = buildService();
    const ctx = buildCtx();
    await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    // No teardown on the happy path — the session is live + tracked.
    expect(driver.destroyedIds).toEqual([]);
  });

  it('destroy: a driver.destroy() throw STILL releases the slot (row marked destroyed) + re-throws (#4)', async () => {
    // Legacy /v1/sessions destroy had no backstop: if driver.destroy() threw,
    // updateSessionStatus('destroyed') never ran, so the row stayed non-terminal
    // (counts as active) forever — and the paid-tier surface has no backstop
    // reaper (null minute-cap → autoDestroyExpired never sweeps it). The slot
    // must be released even when the driver faults.
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    const destroyErr = new Error('driver teardown faulted');
    driver.primeDestroyThrow(destroyErr);

    let caught: unknown;
    try {
      await service.destroy(ctx, session.id);
    } catch (e) {
      caught = e;
    }
    // The driver error propagates (the caller learns the teardown faulted)…
    expect(caught).toBe(destroyErr);
    // …but the row was marked terminal so the concurrency slot is RELEASED.
    const after = repo.read(session.id);
    expect(after?.status).toBe('destroyed');
    expect(after?.destroyedAt).toBeInstanceOf(Date);
  });

  it('successful ops do NOT emit session.failed', async () => {
    const { service, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });

    await service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' });
    await service.getState(ctx, session.id);
    await service.destroy(ctx, session.id);

    // Only session.completed should fire (from destroy).
    expect(webhookEvents.map((e) => e.eventType)).toEqual(['session.completed']);
  });
});

describe('SessionsService — terminal-state resurrection guard', () => {
  it('getState() does NOT resurrect a row destroyed mid box round-trip (concurrent-destroy race)', async () => {
    // getState reads status='ready' (requireOwned), awaits the box round-trip,
    // then writes the STALE 'ready' back. If a concurrent destroy marked the row
    // 'destroyed' during the round-trip, the terminal-sticky guard must reject
    // that write-back — otherwise the row flips back to 'ready' (destroyedAt left
    // set) → use-after-destroy + re-inclusion in the sweeps.
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });

    const destroyedAt = new Date();
    // Land the concurrent destroy DURING the box round-trip, after requireOwned
    // already captured status='ready' but before getState's stale write-back.
    driver.onGetState = () => {
      repo.forceTerminal(session.id, 'destroyed', destroyedAt);
    };

    await service.getState(ctx, session.id);

    const after = repo.read(session.id);
    // The row STAYS destroyed — the stale 'ready' write-back was a no-op.
    expect(after?.status).toBe('destroyed');
    expect(after?.destroyedAt).toEqual(destroyedAt);
  });

  it('updateSessionStatus is terminal-sticky (no resurrection; no destroyed→errored / errored→destroyed flip; normal transitions still apply)', async () => {
    // The load-bearing repo-level guarantee behind every service-level race in
    // this suite. Mirrors the Drizzle notInArray WHERE clause.
    const { service, repo } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    expect(repo.read(session.id)?.status).toBe('ready');

    // (a) NORMAL transition still applies: ready → destroyed.
    const destroyedAt = new Date('2026-06-01T00:00:00Z');
    await repo.updateSessionStatus(session.id, 'destroyed', { destroyedAt });
    expect(repo.read(session.id)?.status).toBe('destroyed');
    expect(repo.read(session.id)?.destroyedAt).toEqual(destroyedAt);

    // (b) A non-terminal write onto a destroyed row is a NO-OP (no resurrection);
    // destroyedAt stays intact.
    await repo.updateSessionStatus(session.id, 'ready');
    expect(repo.read(session.id)?.status).toBe('destroyed');
    expect(repo.read(session.id)?.destroyedAt).toEqual(destroyedAt);

    // (c) A terminal write onto a DIFFERENT terminal state is a NO-OP (no
    // destroyed→errored flip / no double-teardown churn).
    await repo.updateSessionStatus(session.id, 'errored', { destroyedAt: new Date() });
    expect(repo.read(session.id)?.status).toBe('destroyed');
    expect(repo.read(session.id)?.destroyedAt).toEqual(destroyedAt);

    // (d) Symmetric: an errored row does not accept a 'destroyed' write.
    const errored = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    repo.forceTerminal(errored.id, 'errored', new Date('2026-06-02T00:00:00Z'));
    await repo.updateSessionStatus(errored.id, 'destroyed', { destroyedAt: new Date() });
    expect(repo.read(errored.id)?.status).toBe('errored');
  });

  it('create() still resolves when the best-effort created-event write fails (live session not leaked as a 500)', async () => {
    // The session is fully created (status ready, worker live) BEFORE the
    // created-event write. A DB blip on that write must NOT surface as a raw 500
    // — that would leak the live session while the caller believes create failed.
    const { service, repo, driver, loggedErrors } = buildService();
    const ctx = buildCtx();
    repo.throwOnRecordEventType = {
      type: 'created',
      error: new Error('created-event write failed'),
    };

    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });

    // create resolved successfully with a live 'ready' session.
    expect(session.status).toBe('ready');
    expect(session.id).toBeTruthy();
    // The worker was NOT torn down (the create succeeded).
    expect(driver.destroyedIds).toEqual([]);
    // The row is live + non-terminal.
    expect(repo.read(session.id)?.status).toBe('ready');
    // The event failure was logged best-effort (not surfaced to the caller).
    expect(loggedErrors.some((e) => e.obj.event === 'created_event_record_failed')).toBe(true);
  });
});
