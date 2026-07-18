// V-090: unit tests for SessionsService.runWithFailureCapture.
//
// Driver throws → session marked 'errored' + destroyedAt set + 'errored'
// session_event recorded + session.failed webhook fired. Subsequent
// operations on the same session 410 SessionDestroyed (founder-approved
// semantic).

import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_DESTROY_DRIVER_TIMEOUT_MS,
  SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS,
  SessionsService,
  type SessionsServiceDeps,
} from '../../src/services/sessions.js';
import { ConcurrencyLimitError, SessionDestroyedError } from '../../src/lib/errors.js';
import type {
  SessionRepo,
  SessionRecord,
  SessionEventInput,
  NewSessionInput,
  SessionOperationClaimResult,
  SerializedSessionDestroyInput,
  SerializedSessionDestroyResult,
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

interface RecordedLifecycleEvent {
  accountId: string;
  event:
    | { kind: 'session.failed.first'; sessionId: string; errorMessage: string }
    | { kind: 'session.success.first'; sessionId: string };
}

type RecordedNotification = Parameters<
  NonNullable<SessionsServiceDeps['notifications']>['publish']
>[0];

const PRIVATE_SENTINEL = 'PRIVATE_SESSION_PAYLOAD_91c7f0';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type AccountAuditInput = Parameters<NonNullable<SessionsServiceDeps['accountAudit']>['record']>[0];

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
  private readonly sessionMutationTails = new Map<string, Promise<void>>();
  readonly events: SessionEventInput[] = [];
  /** Opt-in (default null): when set, insertSession /
   *  insertSessionIfUnderLimit reject with it.
   *  Used to exercise the create() driver-session orphan rollback. */
  throwOnInsert: Error | null = null;
  /** Opt-in (default false): when true, insertSessionIfUnderLimit returns null
   *  (simulates the atomic cap guard rejecting a concurrent-race loser) —
   *  exercises the create() over-cap orphan rollback + ConcurrencyLimitError. */
  overCapOnInsert = false;
  /** Opt-in (default null): when set, activateSessionReservation rejects with it
   *  — simulates a post-dispatch DB-write failure AFTER the worker is live.
   *  Exercises the create() post-dispatch slot-release path. */
  throwOnActivateSessionReservation: Error | null = null;
  /** Opt-in (default null): when set, recordEvent rejects for the matching
   *  event type — exercises the create() best-effort created-event guard (a
   *  post-success event write must not fail the request + leak the live session). */
  throwOnRecordEventType: { type: string; error: Error } | null = null;
  /** Opt-in: prove a synchronous repository throw is contained too. */
  throwSynchronouslyOnRecordEventType: { type: string; error: Error } | null = null;
  /** Opt-in: hold one event write past the detached watchdog. */
  holdOnRecordEventType: { type: string; deferred: Deferred<void> } | null = null;
  readonly recordEventAttempts: SessionEventInput[] = [];
  /** Opt-in: fail one matching status write after a successful state capture. */
  throwOnUpdateSessionStatus: { status: SessionRecord['status']; error: Error } | null = null;
  /** Opt-in: hold one state-status write past the detached watchdog. */
  holdOnUpdateSessionStatus: {
    status: SessionRecord['status'];
    deferred: Deferred<void>;
  } | null = null;
  readonly updateSessionStatusAttempts: Array<{
    id: string;
    status: SessionRecord['status'];
    extra?: { lastStateAt?: Date; destroyedAt?: Date };
  }> = [];
  throwOnClaimSessionOperation: Error | null = null;
  throwOnSettleSessionOperation: Error | null = null;
  throwOnFailSessionOperation: Error | null = null;
  throwOnTouchSessionLastStateAt: Error | null = null;
  holdOnTouchSessionLastStateAt: Deferred<void> | null = null;
  readonly touchSessionLastStateAtAttempts: Array<{
    id: string;
    accountId: string;
    driverSessionId: string;
    lastStateAt: Date;
  }> = [];

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
  activateSessionReservation(input: {
    id: string;
    reservationDriverSessionId: string;
    driverSessionId: string;
  }): Promise<SessionRecord | null> {
    if (this.throwOnActivateSessionReservation !== null) {
      return Promise.reject(this.throwOnActivateSessionReservation);
    }
    const r = this.sessions.get(input.id);
    if (
      !r ||
      r.driverSessionId !== input.reservationDriverSessionId ||
      r.status !== 'creating' ||
      r.destroyedAt !== null
    ) {
      return Promise.resolve(null);
    }
    const updated: SessionRecord = {
      ...r,
      driverSessionId: input.driverSessionId,
      status: 'ready',
      updatedAt: new Date(),
    };
    this.sessions.set(input.id, updated);
    return Promise.resolve(updated);
  }
  claimSessionOperation(id: string, accountId: string): Promise<SessionOperationClaimResult> {
    if (this.throwOnClaimSessionOperation !== null) {
      return Promise.reject(this.throwOnClaimSessionOperation);
    }
    return this.withSessionMutationLock(id, () => {
      const current = this.sessions.get(id);
      if (!current || current.accountId !== accountId) return { kind: 'not_found' };
      if (
        current.status === 'destroyed' ||
        current.status === 'errored' ||
        current.destroyedAt !== null
      ) {
        return { kind: 'terminal', session: current };
      }
      if (current.status === 'creating' || current.status === 'busy') {
        return { kind: 'conflict', status: current.status };
      }
      const claimed: SessionRecord = { ...current, status: 'busy', updatedAt: new Date() };
      this.sessions.set(id, claimed);
      return { kind: 'claimed', session: claimed };
    });
  }
  settleSessionOperation(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
  }): Promise<boolean> {
    if (this.throwOnSettleSessionOperation !== null) {
      return Promise.reject(this.throwOnSettleSessionOperation);
    }
    return this.withSessionMutationLock(input.id, () => {
      const current = this.sessions.get(input.id);
      if (
        !current ||
        current.accountId !== input.accountId ||
        current.driverSessionId !== input.driverSessionId ||
        current.status !== 'busy' ||
        current.destroyedAt !== null
      ) {
        return false;
      }
      this.sessions.set(input.id, { ...current, status: 'ready', updatedAt: new Date() });
      return true;
    });
  }
  failSessionOperation(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
    erroredAt: Date;
  }): Promise<SessionRecord | null> {
    if (this.throwOnFailSessionOperation !== null) {
      return Promise.reject(this.throwOnFailSessionOperation);
    }
    return this.withSessionMutationLock(input.id, () => {
      const current = this.sessions.get(input.id);
      if (
        !current ||
        current.accountId !== input.accountId ||
        current.driverSessionId !== input.driverSessionId ||
        current.status !== 'busy' ||
        current.destroyedAt !== null
      ) {
        return null;
      }
      const failed: SessionRecord = {
        ...current,
        status: 'errored',
        destroyedAt: input.erroredAt,
        updatedAt: new Date(),
      };
      this.sessions.set(input.id, failed);
      return failed;
    });
  }
  touchSessionLastStateAt(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
    lastStateAt: Date;
  }): Promise<void> {
    this.touchSessionLastStateAtAttempts.push(input);
    if (this.throwOnTouchSessionLastStateAt !== null) {
      return Promise.reject(this.throwOnTouchSessionLastStateAt);
    }
    const apply = (): Promise<void> =>
      this.withSessionMutationLock(input.id, () => {
        const current = this.sessions.get(input.id);
        if (
          !current ||
          current.accountId !== input.accountId ||
          current.driverSessionId !== input.driverSessionId ||
          current.status === 'destroyed' ||
          current.status === 'errored' ||
          current.destroyedAt !== null
        ) {
          return;
        }
        const lastStateAt =
          current.lastStateAt !== null && current.lastStateAt > input.lastStateAt
            ? current.lastStateAt
            : input.lastStateAt;
        this.sessions.set(input.id, { ...current, lastStateAt, updatedAt: new Date() });
      });
    if (this.holdOnTouchSessionLastStateAt !== null) {
      return this.holdOnTouchSessionLastStateAt.promise.then(apply);
    }
    return apply();
  }
  findSession(id: string, accountId: string): Promise<SessionRecord | null> {
    const r = this.sessions.get(id);
    if (!r || r.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve(r);
  }
  findSessionUnscoped(id: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(id) ?? null);
  }
  async destroySessionSerialized(
    input: SerializedSessionDestroyInput,
    destroyDriverSession: (session: SessionRecord) => Promise<void>,
  ): Promise<SerializedSessionDestroyResult> {
    return this.withSessionMutationLock(input.id, async () => {
      const current = this.sessions.get(input.id);
      if (!current || (input.accountId !== null && current.accountId !== input.accountId)) {
        return { kind: 'not_found' };
      }
      if (current.status === 'destroyed' || current.status === 'errored') {
        return { kind: 'already_terminal', session: current };
      }
      if (current.destroyedAt !== null) {
        throw new Error('destroySessionSerialized found a non-terminal row with destroyedAt');
      }

      try {
        await destroyDriverSession(current);
      } catch (error) {
        const failed: SessionRecord = {
          ...current,
          status: 'destroyed',
          destroyedAt: input.destroyedAt,
          updatedAt: new Date(),
        };
        this.sessions.set(input.id, failed);
        return { kind: 'driver_error', session: failed, error };
      }

      const updated: SessionRecord = {
        ...current,
        status: 'destroyed',
        destroyedAt: input.destroyedAt,
        updatedAt: new Date(),
      };
      this.sessions.set(input.id, updated);
      try {
        await this.recordEvent({ sessionId: updated.id, ...input.event });
      } catch (error) {
        this.sessions.set(input.id, current);
        throw error;
      }
      return { kind: 'destroyed', session: updated };
    });
  }
  private async withSessionMutationLock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.sessionMutationTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.sessionMutationTails.set(id, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionMutationTails.get(id) === tail) this.sessionMutationTails.delete(id);
    }
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
    this.updateSessionStatusAttempts.push({
      id,
      status,
      ...(extra === undefined ? {} : { extra }),
    });
    if (this.throwOnUpdateSessionStatus?.status === status) {
      return Promise.reject(this.throwOnUpdateSessionStatus.error);
    }
    const apply = (): void => {
      const r = this.sessions.get(id);
      if (!r || r.status === 'busy' || r.status === 'destroyed' || r.status === 'errored') return;
      this.sessions.set(id, {
        ...r,
        status,
        ...(extra?.lastStateAt !== undefined ? { lastStateAt: extra.lastStateAt } : {}),
        ...(extra?.destroyedAt !== undefined ? { destroyedAt: extra.destroyedAt } : {}),
      });
    };
    if (this.holdOnUpdateSessionStatus?.status === status) {
      return this.holdOnUpdateSessionStatus.deferred.promise.then(apply);
    }
    apply();
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
  listSessions(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: SessionRecord[]; nextCursor: string | null }> {
    const ordered = [...this.sessions.values()]
      .filter((session) => session.accountId === accountId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      );
    const cursorIndex =
      opts.cursor === undefined ? -1 : ordered.findIndex((session) => session.id === opts.cursor);
    const offset = cursorIndex < 0 ? 0 : cursorIndex + 1;
    const page = ordered.slice(offset, offset + opts.limit + 1);
    const hasMore = page.length > opts.limit;
    const items = hasMore ? page.slice(0, opts.limit) : page;
    return Promise.resolve({
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    });
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
    this.recordEventAttempts.push(input);
    if (
      this.throwSynchronouslyOnRecordEventType !== null &&
      this.throwSynchronouslyOnRecordEventType.type === input.type
    ) {
      throw this.throwSynchronouslyOnRecordEventType.error;
    }
    if (this.throwOnRecordEventType !== null && this.throwOnRecordEventType.type === input.type) {
      return Promise.reject(this.throwOnRecordEventType.error);
    }
    if (this.holdOnRecordEventType?.type === input.type) {
      return this.holdOnRecordEventType.deferred.promise.then(() => {
        this.events.push(input);
      });
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
  readonly createdIds: string[] = [];
  /** Exact non-lifecycle operation calls, used to prove no post-success replay. */
  readonly operationCalls: string[] = [];
  capturedAt = new Date('2026-07-15T17:45:00.000Z');

  /** Opt-in: when set, the NEXT createSession() rejects (simulates a worker-
   *  dispatch failure AFTER the reservation slot was taken). */
  private throwOnCreate: Error | null = null;
  private holdOnCreate: Deferred<void> | null = null;

  /** Opt-in: when set, the NEXT destroy() rejects (simulates a driver/network
   *  fault on teardown — exercises the destroy() slot-release backstop, #4). */
  private throwOnDestroy: Error | null = null;
  private hangOnDestroy = false;
  private holdOnOperation: { operation: string; deferred: Deferred<void> } | null = null;

  /** Runs after a real driver id is allocated but before createSession resolves. */
  onCreateSession: ((driverSessionId: string) => void) | null = null;

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

  primeCreateHold(gate: Deferred<void>): void {
    this.holdOnCreate = gate;
  }

  primeOperationHold(operation: string, gate: Deferred<void>): void {
    this.holdOnOperation = { operation, deferred: gate };
  }

  primeDestroyThrow(err: Error): void {
    this.throwOnDestroy = err;
  }

  primeDestroyHang(): void {
    this.hangOnDestroy = true;
  }

  private throwIfArmed(): void {
    if (this.throwOnNext === null) return;
    const t = this.throwOnNext;
    this.throwOnNext = null;
    const err = new Error(t.message);
    err.name = t.name;
    throw err;
  }

  private waitIfHeld(operation: string): Promise<void> {
    if (this.holdOnOperation?.operation !== operation) return Promise.resolve();
    const gate = this.holdOnOperation.deferred;
    this.holdOnOperation = null;
    return gate.promise;
  }

  createSession(): Promise<{ driverSessionId: string }> {
    if (this.throwOnCreate !== null) {
      const err = this.throwOnCreate;
      this.throwOnCreate = null;
      return Promise.reject(err);
    }
    this.nextId += 1;
    const driverSessionId = `mock-${this.nextId.toString()}`;
    this.createdIds.push(driverSessionId);
    this.onCreateSession?.(driverSessionId);
    if (this.holdOnCreate !== null) {
      const gate = this.holdOnCreate;
      this.holdOnCreate = null;
      return gate.promise.then(() => ({ driverSessionId }));
    }
    return Promise.resolve({ driverSessionId });
  }
  navigate(): Promise<{ url: string; finalUrl: string; status: number; durationMs: number }> {
    this.operationCalls.push('navigate');
    this.throwIfArmed();
    return this.waitIfHeld('navigate').then(() => ({
      url: 'about:blank',
      finalUrl: 'about:blank',
      status: 200,
      durationMs: 1,
    }));
  }
  interact(): Promise<{ durationMs: number }> {
    this.operationCalls.push('interact');
    this.throwIfArmed();
    return this.waitIfHeld('interact').then(() => ({ durationMs: 1 }));
  }
  guiInput(): Promise<{ durationMs: number }> {
    this.operationCalls.push('gui_input');
    this.throwIfArmed();
    return this.waitIfHeld('gui_input').then(() => ({ durationMs: 1 }));
  }
  wait(): Promise<{ satisfied: boolean; durationMs: number }> {
    this.operationCalls.push('wait');
    this.throwIfArmed();
    return this.waitIfHeld('wait').then(() => ({ satisfied: true, durationMs: 1 }));
  }
  getState(): Promise<{
    url: string | null;
    title: string | null;
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    pageState: null;
    capturedAt: Date;
  }> {
    this.operationCalls.push('state_capture');
    if (this.onGetState !== null) this.onGetState();
    this.throwIfArmed();
    return this.waitIfHeld('state_capture').then(() => ({
      url: null,
      title: null,
      cookies: [],
      localStorage: {},
      pageState: null,
      capturedAt: this.capturedAt,
    }));
  }
  capture(): Promise<{
    kind: 'screenshot' | 'pdf' | 'dom_snapshot';
    data: string;
    encoding: 'base64' | 'utf8';
    byteSize: number;
    durationMs: number;
  }> {
    this.operationCalls.push('capture');
    this.throwIfArmed();
    return this.waitIfHeld('capture').then(() => ({
      kind: 'screenshot' as const,
      data: 'AAAA',
      encoding: 'base64' as const,
      byteSize: 4,
      durationMs: 1,
    }));
  }
  extract(): Promise<{ value: Record<string, unknown>; durationMs: number }> {
    this.operationCalls.push('extract');
    this.throwIfArmed();
    return this.waitIfHeld('extract').then(() => ({ value: { x: 'mock' }, durationMs: 1 }));
  }
  search(): Promise<{ submitted: boolean; resultsVisible?: boolean; durationMs: number }> {
    this.operationCalls.push('search');
    this.throwIfArmed();
    return this.waitIfHeld('search').then(() => ({ submitted: true, durationMs: 1 }));
  }
  login(): Promise<{ loggedIn: boolean; postLoginUrl?: string; durationMs: number }> {
    this.operationCalls.push('login');
    this.throwIfArmed();
    return this.waitIfHeld('login').then(() => ({ loggedIn: true, durationMs: 1 }));
  }
  destroy(driverSessionId: string): Promise<void> {
    this.destroyedIds.push(driverSessionId);
    if (this.hangOnDestroy) {
      this.hangOnDestroy = false;
      return new Promise(() => {});
    }
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

function buildService(
  opts: {
    loggerThrows?: boolean;
    accountAuditRecord?: (input: AccountAuditInput) => Promise<unknown>;
  } = {},
): {
  service: SessionsService;
  repo: StubRepo;
  driver: ThrowingDriver;
  webhookEvents: RecordedEvent[];
  lifecycleEvents: RecordedLifecycleEvent[];
  notifications: RecordedNotification[];
  loggedErrors: LoggedError[];
  accountAuditInputs: AccountAuditInput[];
} {
  const repo = new StubRepo();
  const driver = new ThrowingDriver();
  const webhookEvents: RecordedEvent[] = [];
  const lifecycleEvents: RecordedLifecycleEvent[] = [];
  const notifications: RecordedNotification[] = [];
  const loggedErrors: LoggedError[] = [];
  const accountAuditInputs: AccountAuditInput[] = [];
  const service = new SessionsService({
    repo,
    driver,
    webhooks: {
      enqueueEvent: (accountId, eventType, data) => {
        webhookEvents.push({ accountId, eventType, data });
        return Promise.resolve(1);
      },
    },
    accountLifecycle: {
      emit: (accountId, event) => {
        lifecycleEvents.push({ accountId, event });
        return Promise.resolve();
      },
    },
    notifications: {
      publish: (event) => {
        notifications.push(event);
      },
    },
    ...(opts.accountAuditRecord === undefined
      ? {}
      : {
          accountAudit: {
            record: (input: AccountAuditInput) => {
              accountAuditInputs.push(input);
              return opts.accountAuditRecord?.(input) ?? Promise.resolve();
            },
          },
        }),
    logger: {
      error: (obj, msg) => {
        loggedErrors.push({ obj, msg });
        if (opts.loggerThrows === true) throw new Error('logger sink failed');
      },
    },
  });
  return {
    service,
    repo,
    driver,
    webhookEvents,
    lifecycleEvents,
    notifications,
    loggedErrors,
    accountAuditInputs,
  };
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
    expect(erroredEvent?.payload).toEqual({
      operation: 'navigate',
      failure_class: 'driver_error',
    });

    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0]?.eventType).toBe('session.failed');
    expect(webhookEvents[0]?.data).toEqual({
      duration_ms: expect.any(Number),
      operation: 'navigate',
      error_name: 'DriverError',
      error_message: 'The browser operation failed.',
    });
    expect(webhookEvents[0]?.data).not.toHaveProperty('session_id');
    expect(JSON.stringify({ events: repo.events, webhookEvents })).not.toContain(
      'WebKit handle gone',
    );
  });

  it('retains only closed failure metadata while rethrowing the original diagnostic unchanged', async () => {
    const { service, repo, driver, webhookEvents, lifecycleEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    const rawMessage =
      'fetch https://user:pass@customer.example/hook?token=tok_live_secret ' +
      'https://customer.example/cb#access_token=fragment_secret ' +
      'Bearer bearer.secret+/== Basic dXNlcjpwYXNz ' +
      'x'.repeat(2_000);
    const rawName = 'DriverError Bearer bmFtZS1zZWNyZXQ=';
    driver.primeNextThrow({ name: rawName, message: rawMessage });

    let caught: unknown;
    try {
      await service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(rawMessage);
    expect((caught as Error).name).toBe(rawName);

    const stored = repo.events.find((event) => event.type === 'errored')?.payload;
    expect(stored).toEqual({ operation: 'navigate', failure_class: 'unknown' });
    for (const secret of [
      'user:pass',
      'tok_live_secret',
      'fragment_secret',
      'bearer.secret',
      'dXNlcjpwYXNz',
      'bmFtZS1zZWNyZXQ',
    ]) {
      expect(JSON.stringify(repo.events)).not.toContain(secret);
      expect(JSON.stringify(webhookEvents)).not.toContain(secret);
      expect(JSON.stringify(lifecycleEvents)).not.toContain(secret);
    }

    expect(webhookEvents[0]?.data).toMatchObject({
      operation: 'navigate',
      error_name: 'UnknownError',
      error_message: 'The session operation failed.',
    });
    expect(lifecycleEvents[0]?.event).toMatchObject({
      kind: 'session.failed.first',
      errorMessage: 'The session operation failed.',
    });
  });

  it('returns exact driver results while every successful event write keeps only closed metadata', async () => {
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });

    const navigationResult = {
      url: `https://customer.example/private/${PRIVATE_SENTINEL}`,
      finalUrl: `https://customer.example/final?token=${PRIVATE_SENTINEL}`,
      status: 201,
      durationMs: 7,
    };
    vi.spyOn(driver, 'navigate').mockResolvedValueOnce(navigationResult);
    await expect(
      service.navigate(ctx, session.id, {
        url: `https://user:${PRIVATE_SENTINEL}@customer.example/start/${PRIVATE_SENTINEL}`,
        wait_until: 'load',
      }),
    ).resolves.toEqual(navigationResult);

    await service.interact(ctx, session.id, {
      action: {
        kind: 'type',
        selector: `#${PRIVATE_SENTINEL}`,
        text: PRIVATE_SENTINEL,
        delay_ms: 25,
        sensitive: true,
      },
    });
    await service.guiInput(ctx, session.id, {
      action: { kind: 'type_focused', text: PRIVATE_SENTINEL, delay_ms: 15 },
    });
    await service.wait(ctx, session.id, {
      condition: { kind: 'url_matches', pattern: PRIVATE_SENTINEL },
    });

    const stateResult = {
      url: `https://state.example/private/${PRIVATE_SENTINEL}`,
      title: PRIVATE_SENTINEL,
      cookies: [{ name: 'auth', value: PRIVATE_SENTINEL }],
      localStorage: { token: PRIVATE_SENTINEL },
      pageState: null,
      capturedAt: driver.capturedAt,
    };
    vi.spyOn(driver, 'getState').mockResolvedValueOnce(stateResult);
    await expect(service.getState(ctx, session.id)).resolves.toEqual(stateResult);

    const captureResult = {
      kind: 'screenshot' as const,
      data: PRIVATE_SENTINEL,
      encoding: 'base64' as const,
      byteSize: 128,
      durationMs: 9,
    };
    vi.spyOn(driver, 'capture').mockResolvedValueOnce(captureResult);
    await expect(
      service.capture(ctx, session.id, { kind: 'screenshot', full_page: false }),
    ).resolves.toEqual(captureResult);

    expect(
      repo.events.map(({ type, payload, durationMs }) => ({ type, payload, durationMs })),
    ).toEqual([
      {
        type: 'created',
        payload: {
          archetype: 'iphone16pro_ios18_7_safari26_4',
          purpose: 'production_customer',
        },
        durationMs: null,
      },
      {
        type: 'navigated',
        payload: {
          requested_origin: 'https://customer.example',
          final_origin: 'https://customer.example',
          status: 201,
        },
        durationMs: 7,
      },
      {
        type: 'interacted',
        payload: { action_kind: 'type', sensitive: true, delay_ms: 25 },
        durationMs: 1,
      },
      {
        type: 'gui_input',
        payload: { action_kind: 'type_focused', delay_ms: 15 },
        durationMs: 1,
      },
      {
        type: 'waited',
        payload: { condition_kind: 'url_matches', satisfied: true },
        durationMs: 1,
      },
      {
        type: 'state_captured',
        payload: { source: 'page_state', origin: 'https://state.example' },
        durationMs: null,
      },
      {
        type: 'screenshot_captured',
        payload: { kind: 'screenshot', byte_size: 128 },
        durationMs: 9,
      },
    ]);
    expect(JSON.stringify(repo.events)).not.toContain(PRIVATE_SENTINEL);
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

  it('post-success event failures preserve each authoritative driver result without replay or terminalization', async () => {
    const cases: ReadonlyArray<{
      operation: string;
      eventType: SessionEventInput['type'];
      run: (service: SessionsService, ctx: AccountContext, sessionId: string) => Promise<unknown>;
      expected: (driver: ThrowingDriver) => unknown;
    }> = [
      {
        operation: 'navigate',
        eventType: 'navigated',
        run: (service, ctx, sessionId) =>
          service.navigate(ctx, sessionId, {
            url: 'https://example.com',
            wait_until: 'load',
          }),
        expected: () => ({
          url: 'about:blank',
          finalUrl: 'about:blank',
          status: 200,
          durationMs: 1,
        }),
      },
      {
        operation: 'interact',
        eventType: 'interacted',
        run: (service, ctx, sessionId) =>
          service.interact(ctx, sessionId, {
            action: { kind: 'tap', selector: 'button[type=submit]' },
          }),
        expected: () => ({ durationMs: 1 }),
      },
      {
        operation: 'gui_input',
        eventType: 'gui_input',
        run: (service, ctx, sessionId) =>
          service.guiInput(ctx, sessionId, { action: { kind: 'tap_at', x: 12, y: 34 } }),
        expected: () => ({ durationMs: 1 }),
      },
      {
        operation: 'wait',
        eventType: 'waited',
        run: (service, ctx, sessionId) =>
          service.wait(ctx, sessionId, {
            condition: { kind: 'selector', selector: '#ready' },
          }),
        expected: () => ({ satisfied: true, durationMs: 1 }),
      },
      {
        operation: 'state_capture',
        eventType: 'state_captured',
        run: (service, ctx, sessionId) => service.getState(ctx, sessionId),
        expected: (driver) => ({
          url: null,
          title: null,
          cookies: [],
          localStorage: {},
          pageState: null,
          capturedAt: driver.capturedAt,
        }),
      },
      {
        operation: 'capture',
        eventType: 'screenshot_captured',
        run: (service, ctx, sessionId) =>
          service.capture(ctx, sessionId, { kind: 'screenshot', full_page: false }),
        expected: () => ({
          kind: 'screenshot',
          data: 'AAAA',
          encoding: 'base64',
          byteSize: 4,
          durationMs: 1,
        }),
      },
    ];

    for (const testCase of cases) {
      const { service, repo, driver, webhookEvents, lifecycleEvents, loggedErrors } =
        buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      const persistenceError = new Error(
        'write failed for https://user:pass@example.com/a?token=event_secret',
      );
      persistenceError.name = 'PersistenceError Bearer bmFtZS1zZWNyZXQ=';
      repo.throwOnRecordEventType = { type: testCase.eventType, error: persistenceError };

      const result = await testCase.run(service, ctx, session.id);

      expect(result).toEqual(testCase.expected(driver));
      expect(driver.operationCalls).toEqual([testCase.operation]);
      expect(driver.destroyedIds).toEqual([]);
      expect(repo.read(session.id)).toMatchObject({ status: 'ready', destroyedAt: null });
      expect(webhookEvents).toEqual([]);
      expect(lifecycleEvents).toEqual([]);
      expect(repo.events.some((event) => event.type === 'errored')).toBe(false);
      await vi.waitFor(() => expect(loggedErrors).toHaveLength(1));
      expect(loggedErrors[0]?.obj).toMatchObject({
        event: 'post_success_persistence_failed',
        account_id: session.accountId,
        session_id: session.id,
        operation: testCase.operation,
        persistence: 'event',
      });
      expect(loggedErrors[0]?.obj.error_name).toBe('PostSuccessPersistenceError');
      expect(loggedErrors[0]?.obj).not.toHaveProperty('error_message');
      const diagnostic = JSON.stringify(loggedErrors[0]?.obj);
      for (const secret of ['user:pass', 'event_secret', 'bmFtZS1zZWNyZXQ=']) {
        expect(diagnostic).not.toContain(secret);
      }
      if (testCase.operation === 'state_capture') {
        expect(repo.read(session.id)?.lastStateAt).toEqual(driver.capturedAt);
      }
    }
  });

  it('getState timestamp-touch failure still returns the captured state and attempts its event once', async () => {
    const { service, repo, driver, webhookEvents, lifecycleEvents, loggedErrors } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    repo.throwOnTouchSessionLastStateAt = new Error('last-state timestamp store failed');

    const state = await service.getState(ctx, session.id);

    expect(state).toEqual({
      url: null,
      title: null,
      cookies: [],
      localStorage: {},
      pageState: null,
      capturedAt: driver.capturedAt,
    });
    expect(driver.operationCalls).toEqual(['state_capture']);
    expect(driver.destroyedIds).toEqual([]);
    expect(repo.read(session.id)).toMatchObject({
      status: 'ready',
      destroyedAt: null,
      lastStateAt: null,
    });
    expect(repo.events.filter((event) => event.type === 'state_captured')).toHaveLength(1);
    expect(repo.events.filter((event) => event.type === 'errored')).toHaveLength(0);
    expect(webhookEvents).toEqual([]);
    expect(lifecycleEvents).toEqual([]);
    await vi.waitFor(() => expect(loggedErrors).toHaveLength(1));
    expect(loggedErrors[0]?.obj).toMatchObject({
      event: 'post_success_persistence_failed',
      operation: 'state_capture',
      persistence: 'status',
    });
  });

  it('a throwing diagnostic sink cannot convert a committed interaction into a replayable failure', async () => {
    const { service, repo, driver, webhookEvents, lifecycleEvents } = buildService({
      loggerThrows: true,
    });
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    repo.throwOnRecordEventType = {
      type: 'interacted',
      error: new Error('interaction event store failed'),
    };

    await expect(
      service.interact(ctx, session.id, { action: { kind: 'tap', selector: '#once' } }),
    ).resolves.toEqual({ durationMs: 1 });
    expect(driver.operationCalls).toEqual(['interact']);
    expect(driver.destroyedIds).toEqual([]);
    expect(repo.read(session.id)).toMatchObject({ status: 'ready', destroyedAt: null });
    expect(repo.events.filter((event) => event.type === 'errored')).toHaveLength(0);
    expect(webhookEvents).toEqual([]);
    expect(lifecycleEvents).toEqual([]);
  });

  it('a hostile non-string Error.name cannot reject the detached diagnostic monitor', async () => {
    const { service, repo, driver, loggedErrors } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const hostileError = new Error('must not escape the monitor');
    Object.defineProperty(hostileError, 'name', { value: Symbol('hostile-name') });
    repo.throwOnRecordEventType = { type: 'interacted', error: hostileError };

    await expect(
      service.interact(ctx, session.id, { action: { kind: 'tap', selector: '#once' } }),
    ).resolves.toEqual({ durationMs: 1 });
    await vi.waitFor(() => expect(loggedErrors).toHaveLength(1));

    expect(loggedErrors[0]?.obj).toMatchObject({
      event: 'post_success_persistence_failed',
      operation: 'interact',
      persistence: 'event',
      error_name: 'PostSuccessPersistenceError',
    });
    expect(driver.operationCalls).toEqual(['interact']);
    expect(driver.destroyedIds).toEqual([]);
  });

  it('unrefs the detached watchdog so a held observability write cannot keep the process alive', async () => {
    const { service, repo } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const held = deferred<void>();
    repo.holdOnRecordEventType = { type: 'interacted', deferred: held };
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      await service.interact(ctx, session.id, {
        action: { kind: 'tap', selector: '#once' },
      });

      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      const timer = timeoutSpy.mock.results[0]?.value as ReturnType<typeof setTimeout> | undefined;
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
    } finally {
      timeoutSpy.mockRestore();
      held.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it('a held post-success event cannot withhold or replay the authoritative result and emits one bounded timeout diagnostic', async () => {
    vi.useFakeTimers();
    try {
      const { service, repo, driver, webhookEvents, lifecycleEvents, loggedErrors } =
        buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);

      const held = deferred<void>();
      repo.holdOnRecordEventType = { type: 'interacted', deferred: held };

      await expect(
        service.interact(ctx, session.id, {
          action: { kind: 'tap', selector: '#exactly-once' },
        }),
      ).resolves.toEqual({ durationMs: 1 });

      expect(driver.operationCalls).toEqual(['interact']);
      expect(repo.recordEventAttempts.filter((event) => event.type === 'interacted')).toHaveLength(
        1,
      );
      expect(loggedErrors).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS - 1);
      expect(loggedErrors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(loggedErrors).toHaveLength(1);
      expect(loggedErrors[0]?.obj).toMatchObject({
        event: 'post_success_persistence_timed_out',
        account_id: session.accountId,
        session_id: session.id,
        operation: 'interact',
        persistence: 'event',
        error_name: 'PostSuccessPersistenceTimeout',
      });
      expect(vi.getTimerCount()).toBe(0);

      const lateError = new Error('late rejection with event_secret');
      lateError.name = 'LatePersistenceError';
      held.reject(lateError);
      await vi.advanceTimersByTimeAsync(0);

      expect(loggedErrors).toHaveLength(1);
      expect(driver.operationCalls).toEqual(['interact']);
      expect(driver.destroyedIds).toEqual([]);
      expect(repo.read(session.id)).toMatchObject({ status: 'ready', destroyedAt: null });
      expect(repo.events.filter((event) => event.type === 'errored')).toHaveLength(0);
      expect(webhookEvents).toEqual([]);
      expect(lifecycleEvents).toEqual([]);
      expect(JSON.stringify(loggedErrors)).not.toContain('event_secret');
    } finally {
      vi.useRealTimers();
    }
  });

  it('successful, rejected, and synchronously-throwing writes all settle detached monitors exactly once', async () => {
    vi.useFakeTimers();
    try {
      const { service, repo, driver, loggedErrors } = buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);

      const successful = deferred<void>();
      repo.holdOnRecordEventType = { type: 'interacted', deferred: successful };
      await expect(
        service.interact(ctx, session.id, { action: { kind: 'tap', selector: '#success' } }),
      ).resolves.toEqual({ durationMs: 1 });
      expect(vi.getTimerCount()).toBe(1);
      successful.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(loggedErrors).toEqual([]);

      const rejected = deferred<void>();
      repo.holdOnRecordEventType = { type: 'waited', deferred: rejected };
      await expect(
        service.wait(ctx, session.id, { condition: { kind: 'selector', selector: '#ready' } }),
      ).resolves.toEqual({ satisfied: true, durationMs: 1 });
      const rejectedError = new Error('rejected promptly');
      rejectedError.name = 'PromptPersistenceError';
      rejected.reject(rejectedError);
      await vi.advanceTimersByTimeAsync(0);
      expect(loggedErrors).toHaveLength(1);
      expect(loggedErrors[0]?.obj).toMatchObject({
        event: 'post_success_persistence_failed',
        operation: 'wait',
        persistence: 'event',
        error_name: 'PostSuccessPersistenceError',
      });
      expect(vi.getTimerCount()).toBe(0);

      repo.holdOnRecordEventType = null;
      const synchronousError = new Error('synchronous repository throw');
      synchronousError.name = 'SynchronousPersistenceError';
      repo.throwSynchronouslyOnRecordEventType = {
        type: 'screenshot_captured',
        error: synchronousError,
      };
      await expect(
        service.capture(ctx, session.id, { kind: 'screenshot', full_page: false }),
      ).resolves.toMatchObject({ kind: 'screenshot', byteSize: 4 });
      await vi.advanceTimersByTimeAsync(0);
      expect(loggedErrors).toHaveLength(2);
      expect(loggedErrors[1]?.obj).toMatchObject({
        event: 'post_success_persistence_failed',
        operation: 'capture',
        persistence: 'event',
        error_name: 'PostSuccessPersistenceError',
      });
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS * 2);
      expect(loggedErrors).toHaveLength(2);
      expect(driver.operationCalls).toEqual(['interact', 'wait', 'capture']);
      expect(driver.destroyedIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getState admits its timestamp touch and event independently without withholding captured state', async () => {
    vi.useFakeTimers();
    try {
      const { service, repo, driver, webhookEvents, lifecycleEvents, loggedErrors } =
        buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await vi.advanceTimersByTimeAsync(0);

      const heldStatus = deferred<void>();
      const heldEvent = deferred<void>();
      repo.holdOnTouchSessionLastStateAt = heldStatus;
      repo.holdOnRecordEventType = { type: 'state_captured', deferred: heldEvent };

      await expect(service.getState(ctx, session.id)).resolves.toEqual({
        url: null,
        title: null,
        cookies: [],
        localStorage: {},
        pageState: null,
        capturedAt: driver.capturedAt,
      });
      expect(
        repo.touchSessionLastStateAtAttempts.filter(
          (attempt) => attempt.lastStateAt.getTime() === driver.capturedAt.getTime(),
        ),
      ).toHaveLength(1);
      expect(
        repo.recordEventAttempts.filter((event) => event.type === 'state_captured'),
      ).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS);
      expect(loggedErrors).toHaveLength(2);
      expect(loggedErrors.map((entry) => entry.obj.persistence).sort()).toEqual([
        'event',
        'status',
      ]);
      expect(vi.getTimerCount()).toBe(0);

      heldStatus.resolve();
      heldEvent.reject(new Error('late state-event rejection'));
      await vi.advanceTimersByTimeAsync(0);
      expect(loggedErrors).toHaveLength(2);
      expect(repo.read(session.id)).toMatchObject({
        status: 'ready',
        destroyedAt: null,
        lastStateAt: driver.capturedAt,
      });
      expect(driver.operationCalls).toEqual(['state_capture']);
      expect(driver.destroyedIds).toEqual([]);
      expect(webhookEvents).toEqual([]);
      expect(lifecycleEvents).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('create returns one ready worker while created-event and account-audit writes remain held', async () => {
    vi.useFakeTimers();
    try {
      const heldEvent = deferred<void>();
      const heldAudit = deferred<unknown>();
      const { service, repo, driver, accountAuditInputs, loggedErrors } = buildService({
        accountAuditRecord: () => heldAudit.promise,
      });
      const ctx = buildCtx();
      repo.holdOnRecordEventType = { type: 'created', deferred: heldEvent };

      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });

      expect(session).toMatchObject({ status: 'ready', driverSessionId: 'mock-1' });
      expect(driver.createdIds).toEqual(['mock-1']);
      expect(driver.destroyedIds).toEqual([]);
      expect(repo.read(session.id)).toMatchObject({
        status: 'ready',
        driverSessionId: 'mock-1',
        destroyedAt: null,
      });
      expect(repo.recordEventAttempts.filter((event) => event.type === 'created')).toHaveLength(1);
      expect(accountAuditInputs).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS);
      expect(loggedErrors).toHaveLength(2);
      expect(loggedErrors.map((entry) => entry.obj.persistence).sort()).toEqual([
        'account_audit',
        'event',
      ]);
      expect(vi.getTimerCount()).toBe(0);

      heldEvent.resolve();
      heldAudit.reject(new Error('late audit rejection'));
      await vi.advanceTimersByTimeAsync(0);
      expect(loggedErrors).toHaveLength(2);
      expect(driver.createdIds).toEqual(['mock-1']);
      expect(driver.destroyedIds).toEqual([]);
      expect(repo.events.filter((event) => event.type === 'created')).toHaveLength(1);
      expect(repo.events.filter((event) => event.type === 'errored')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing diagnostic sink is contained even when the detached watchdog expires', async () => {
    vi.useFakeTimers();
    try {
      const { service, repo, driver, loggedErrors } = buildService({ loggerThrows: true });
      const ctx = buildCtx();
      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      await vi.advanceTimersByTimeAsync(0);
      const held = deferred<void>();
      repo.holdOnRecordEventType = { type: 'interacted', deferred: held };

      await expect(
        service.interact(ctx, session.id, { action: { kind: 'tap', selector: '#once' } }),
      ).resolves.toEqual({ durationMs: 1 });
      await vi.advanceTimersByTimeAsync(SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS);
      expect(loggedErrors).toHaveLength(1);
      expect(driver.operationCalls).toEqual(['interact']);
      expect(driver.destroyedIds).toEqual([]);

      held.reject(new Error('late failure after throwing logger'));
      await vi.advanceTimersByTimeAsync(0);
      expect(loggedErrors).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
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
    // activateSessionReservation write throws. Without a guard the row would be
    // stuck at status=creating, destroyedAt=NULL forever, leaking a concurrency
    // slot (paid tiers have no minute-cap so the duration sweeper never reaps
    // it; the worker is live so the disconnect reaper won't either).
    const { service, repo, driver, loggedErrors } = buildService();
    const ctx = buildCtx();
    const writeErr = new Error('post-dispatch DB write failed');
    repo.throwOnActivateSessionReservation = writeErr;

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

  it('create: a hung cleanup after activation-store failure is bounded and preserves the original store error', async () => {
    vi.useFakeTimers();
    try {
      const { service, repo, driver } = buildService();
      const ctx = buildCtx();
      const writeErr = new Error('activation store failed');
      repo.throwOnActivateSessionReservation = writeErr;
      driver.primeDestroyHang();

      const rejection = expect(
        service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' }),
      ).rejects.toBe(writeErr);
      await vi.advanceTimersByTimeAsync(SESSION_DESTROY_DRIVER_TIMEOUT_MS);
      await rejection;

      expect(repo.read('sess-0000')).toMatchObject({ status: 'errored' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('create: a SUCCESSFUL reservation + dispatch spins exactly one worker, no teardown', async () => {
    const { service, driver, repo } = buildService();
    const ctx = buildCtx();
    const created = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    // No teardown on the happy path — the session is live + tracked.
    expect(driver.destroyedIds).toEqual([]);
    expect(created.status).toBe('ready');
    expect(created.driverSessionId).toBe('mock-1');
    expect(repo.read(created.id)).toMatchObject({ status: 'ready', driverSessionId: 'mock-1' });
  });

  it('create: a destroy that wins during slow dispatch keeps the terminal reservation immutable, reaps the real worker, and never publishes ready', async () => {
    const { service, driver, repo } = buildService();
    const ctx = buildCtx();
    const destroyedAt = new Date('2026-07-14T23:37:00.000Z');

    driver.onCreateSession = () => {
      // The reservation is synchronously visible before driver dispatch. Stand
      // in for admin/suspension/duration/customer destroy winning while the
      // driver is starting, before create can activate the row.
      repo.forceTerminal('sess-0000', 'destroyed', destroyedAt);
    };

    await expect(
      service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' }),
    ).rejects.toBeInstanceOf(SessionDestroyedError);

    const terminal = repo.read('sess-0000');
    expect(terminal).toMatchObject({ status: 'destroyed', destroyedAt });
    expect(terminal?.driverSessionId).toMatch(/^reserving:/);
    expect(driver.destroyedIds).toEqual(['mock-1']);
    expect(repo.events.filter((event) => event.type === 'created')).toHaveLength(0);
  });

  it('destroy: a driver.destroy() throw STILL releases the slot (row marked destroyed) + re-throws (#4)', async () => {
    // Legacy /v1/sessions destroy had no backstop: if driver.destroy() threw,
    // updateSessionStatus('destroyed') never ran, so the row stayed non-terminal
    // (counts as active) forever — and the paid-tier surface has no backstop
    // reaper (null minute-cap → autoDestroyExpired never sweeps it). The slot
    // must be released even when the driver faults.
    const { service, repo, driver, webhookEvents } = buildService();
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
    // A failed driver callback is not a successful destroy: no destroyed event
    // or session.completed fan-out is emitted, but the terminal row makes a
    // retry idempotent and prevents another uncertain driver call.
    expect(repo.events.filter((event) => event.type === 'destroyed')).toHaveLength(0);
    expect(webhookEvents.filter((event) => event.eventType === 'session.completed')).toHaveLength(
      0,
    );
    await expect(service.destroy(ctx, session.id)).resolves.toBeUndefined();
    expect(driver.destroyedIds).toHaveLength(1);
  });

  it('destroy: an event-write failure rolls back terminal state; an idempotent driver retry commits status + one event', async () => {
    const { service, repo, driver, webhookEvents } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    const eventError = new Error('destroyed event write failed');
    repo.throwOnRecordEventType = { type: 'destroyed', error: eventError };

    await expect(service.destroy(ctx, session.id)).rejects.toBe(eventError);
    expect(repo.read(session.id)?.status).toBe('ready');
    expect(repo.read(session.id)?.destroyedAt).toBeNull();
    expect(repo.events.filter((event) => event.type === 'destroyed')).toHaveLength(0);
    expect(webhookEvents.filter((event) => event.eventType === 'session.completed')).toHaveLength(
      0,
    );

    repo.throwOnRecordEventType = null;
    await service.destroy(ctx, session.id);
    expect(driver.destroyedIds).toHaveLength(2);
    expect(repo.read(session.id)?.status).toBe('destroyed');
    expect(repo.events.filter((event) => event.type === 'destroyed')).toHaveLength(1);
    expect(webhookEvents.filter((event) => event.eventType === 'session.completed')).toHaveLength(
      1,
    );
  });

  it('destroy: a hung driver is bounded so terminal release commits and waiters cannot hold the lock forever', async () => {
    vi.useFakeTimers();
    try {
      const { service, repo, driver, webhookEvents } = buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
      driver.primeDestroyHang();

      const rejection = expect(service.destroy(ctx, session.id)).rejects.toThrow(
        'Session driver destroy timed out.',
      );
      await vi.advanceTimersByTimeAsync(SESSION_DESTROY_DRIVER_TIMEOUT_MS);
      await rejection;

      expect(repo.read(session.id)?.status).toBe('destroyed');
      expect(repo.read(session.id)?.destroyedAt).toBeInstanceOf(Date);
      expect(repo.events.filter((event) => event.type === 'destroyed')).toHaveLength(0);
      expect(webhookEvents.filter((event) => event.eventType === 'session.completed')).toHaveLength(
        0,
      );
    } finally {
      vi.useRealTimers();
    }
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

describe('SessionsService — one atomic owner per direct driver operation', () => {
  it('one held owner rejects all other eight operations before dispatch, then releases a successor', async () => {
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const held = deferred<void>();
    driver.primeOperationHold('navigate', held);
    const owner = service.navigate(ctx, session.id, {
      url: 'https://example.com',
      wait_until: 'load',
    });
    await vi.waitFor(() => expect(repo.read(session.id)?.status).toBe('busy'));
    await repo.updateSessionStatus(session.id, 'ready');
    expect(repo.read(session.id)?.status).toBe('busy');

    const contenders: Array<() => Promise<unknown>> = [
      () =>
        service.interact(ctx, session.id, {
          action: { kind: 'tap', selector: '#submit' },
        }),
      () => service.guiInput(ctx, session.id, { action: { kind: 'tap_at', x: 1, y: 2 } }),
      () => service.wait(ctx, session.id, { condition: { kind: 'selector', selector: '#ready' } }),
      () => service.getState(ctx, session.id),
      () => service.capture(ctx, session.id, { kind: 'screenshot', full_page: false }),
      () =>
        service.extract(ctx, session.id, {
          extractions: [{ name: 'title', selector: 'h1', type: 'text' }],
        }),
      () => service.search(ctx, session.id, { query: 'driftstack', submit: true }),
      () => service.login(ctx, session.id, { username: 'user', password: 'secret' }),
    ];
    for (const contender of contenders) {
      await expect(contender()).rejects.toMatchObject({ name: 'ConflictError', status: 409 });
    }
    expect(driver.operationCalls).toEqual(['navigate']);
    expect(repo.read(session.id)?.status).toBe('busy');

    held.resolve();
    await expect(owner).resolves.toMatchObject({ status: 200 });
    expect(repo.read(session.id)?.status).toBe('ready');
    expect(repo.events.filter((event) => event.type === 'navigated')).toHaveLength(1);

    await expect(
      service.interact(ctx, session.id, { action: { kind: 'tap', selector: '#successor' } }),
    ).resolves.toEqual({ durationMs: 1 });
    expect(driver.operationCalls).toEqual(['navigate', 'interact']);
    expect(repo.read(session.id)?.status).toBe('ready');
  });

  it('a visible creating reservation rejects direct work with zero operation dispatch', async () => {
    const { service, repo, driver, webhookEvents, notifications } = buildService();
    const ctx = buildCtx();
    const heldCreate = deferred<void>();
    driver.primeCreateHold(heldCreate);
    const creating = service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });
    await vi.waitFor(async () => {
      await expect(service.list(ctx, { limit: 10 })).resolves.toMatchObject({
        items: [
          {
            id: 'sess-0000',
            status: 'creating',
            driverSessionId: expect.stringMatching(/^reserving:/),
          },
        ],
        nextCursor: null,
      });
    });

    await expect(
      service.navigate(ctx, 'sess-0000', { url: 'https://example.com', wait_until: 'load' }),
    ).rejects.toMatchObject({ name: 'ConflictError', status: 409 });
    expect(driver.operationCalls).toEqual([]);
    expect(repo.events.filter((event) => event.type === 'errored')).toEqual([]);
    expect(webhookEvents).toEqual([]);
    expect(notifications).toEqual([]);

    heldCreate.resolve();
    await expect(creating).resolves.toMatchObject({ id: 'sess-0000', status: 'ready' });
  });

  it('missing and cross-account ids are indistinguishable while terminal rows return 410', async () => {
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const foreignCtx: AccountContext = {
      ...ctx,
      account: { ...ctx.account, id: 'acc-foreign' },
      apiKey: { ...ctx.apiKey, id: 'key-foreign', accountId: 'acc-foreign' },
    };
    const capture = async (promise: Promise<unknown>): Promise<Record<string, unknown>> => {
      try {
        await promise;
        throw new Error('expected rejection');
      } catch (error) {
        const value = error as {
          name?: string;
          status?: number;
          type?: string;
          title?: string;
          detail?: string;
        };
        return {
          name: value.name,
          status: value.status,
          type: value.type,
          title: value.title,
          detail: value.detail,
        };
      }
    };
    const missing = await capture(
      service.navigate(
        ctx,
        session.id,
        { url: 'https://example.com', wait_until: 'load' },
        {
          effectiveAccountId: 'acc-missing',
        },
      ),
    );
    const foreign = await capture(
      service.navigate(foreignCtx, session.id, {
        url: 'https://example.com',
        wait_until: 'load',
      }),
    );
    expect(foreign).toEqual(missing);
    expect(missing).toMatchObject({ name: 'NotFoundError', status: 404 });
    expect(driver.operationCalls).toEqual([]);

    repo.forceTerminal(session.id, 'destroyed', new Date());
    await expect(
      service.navigate(ctx, session.id, { url: 'https://example.com', wait_until: 'load' }),
    ).rejects.toBeInstanceOf(SessionDestroyedError);
    expect(driver.operationCalls).toEqual([]);
  });

  it('failure-first elects exactly one terminal teardown and makes a later close inert', async () => {
    const { service, repo, driver, webhookEvents, lifecycleEvents, notifications } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const held = deferred<void>();
    driver.primeOperationHold('navigate', held);
    const owner = service.navigate(ctx, session.id, {
      url: 'https://example.com',
      wait_until: 'load',
    });
    await vi.waitFor(() => expect(repo.read(session.id)?.status).toBe('busy'));
    const driverError = new Error('held driver failed');
    driverError.name = 'DriverError';
    held.reject(driverError);
    await expect(owner).rejects.toBe(driverError);

    expect(repo.read(session.id)).toMatchObject({ status: 'errored' });
    expect(driver.destroyedIds).toEqual([session.driverSessionId]);
    expect(repo.events.filter((event) => event.type === 'errored')).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(webhookEvents.map((event) => event.eventType)).toEqual(['session.failed']);
    expect(lifecycleEvents).toHaveLength(1);

    await expect(service.destroy(ctx, session.id)).resolves.toBeUndefined();
    expect(driver.destroyedIds).toEqual([session.driverSessionId]);
    expect(repo.events.filter((event) => event.type === 'destroyed')).toHaveLength(0);
    expect(webhookEvents.map((event) => event.eventType)).toEqual(['session.failed']);
  });

  for (const tail of ['success', 'failure'] as const) {
    it(`close-first suppresses a late ${tail} tail with no second teardown or stale observability`, async () => {
      const { service, repo, driver, webhookEvents, lifecycleEvents, notifications } =
        buildService();
      const ctx = buildCtx();
      const session = await service.create(ctx, {
        archetype: 'iphone16pro_ios18_7_safari26_4',
      });
      const held = deferred<void>();
      driver.primeOperationHold('navigate', held);
      const owner = service.navigate(ctx, session.id, {
        url: 'https://example.com',
        wait_until: 'load',
      });
      await vi.waitFor(() => expect(repo.read(session.id)?.status).toBe('busy'));

      await service.destroy(ctx, session.id);
      if (tail === 'success') held.resolve();
      else {
        const oldError = new Error('old driver failure');
        oldError.name = 'DriverError';
        held.reject(oldError);
      }
      await expect(owner).rejects.toBeInstanceOf(SessionDestroyedError);

      expect(repo.read(session.id)?.status).toBe('destroyed');
      expect(driver.destroyedIds).toEqual([session.driverSessionId]);
      expect(repo.events.filter((event) => event.type === 'destroyed')).toHaveLength(1);
      expect(repo.events.filter((event) => event.type === 'navigated')).toHaveLength(0);
      expect(repo.events.filter((event) => event.type === 'errored')).toHaveLength(0);
      expect(notifications).toEqual([]);
      expect(lifecycleEvents.map((entry) => entry.event.kind)).toEqual(['session.success.first']);
      expect(webhookEvents.map((event) => event.eventType)).toEqual(['session.completed']);
    });
  }

  it('a delayed state timestamp touch is monotonic and cannot release a successor owner', async () => {
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const oldCapturedAt = new Date('2026-07-17T10:00:00.000Z');
    driver.capturedAt = oldCapturedAt;
    const heldTouch = deferred<void>();
    repo.holdOnTouchSessionLastStateAt = heldTouch;
    await service.getState(ctx, session.id);
    await vi.waitFor(() => expect(repo.touchSessionLastStateAtAttempts).toHaveLength(1));
    repo.holdOnTouchSessionLastStateAt = null;

    const heldNavigate = deferred<void>();
    driver.primeOperationHold('navigate', heldNavigate);
    const successor = service.navigate(ctx, session.id, {
      url: 'https://example.com',
      wait_until: 'load',
    });
    await vi.waitFor(() => expect(repo.read(session.id)?.status).toBe('busy'));
    heldTouch.resolve();
    await vi.waitFor(() => expect(repo.read(session.id)?.lastStateAt).toEqual(oldCapturedAt));
    expect(repo.read(session.id)?.status).toBe('busy');
    heldNavigate.resolve();
    await successor;
    expect(repo.read(session.id)?.status).toBe('ready');

    const newer = new Date('2026-07-17T11:00:00.000Z');
    await repo.touchSessionLastStateAt({
      id: session.id,
      accountId: session.accountId,
      driverSessionId: session.driverSessionId,
      lastStateAt: newer,
    });
    await repo.touchSessionLastStateAt({
      id: session.id,
      accountId: session.accountId,
      driverSessionId: session.driverSessionId,
      lastStateAt: oldCapturedAt,
    });
    expect(repo.read(session.id)?.lastStateAt).toEqual(newer);
  });

  it('claim, success-settlement and failure-election database errors never become failure fanout', async () => {
    const claimCase = buildService();
    const ctx = buildCtx();
    const claimSession = await claimCase.service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const claimError = new Error('claim database unavailable');
    claimCase.repo.throwOnClaimSessionOperation = claimError;
    await expect(
      claimCase.service.navigate(ctx, claimSession.id, {
        url: 'https://example.com',
        wait_until: 'load',
      }),
    ).rejects.toBe(claimError);
    expect(claimCase.driver.operationCalls).toEqual([]);
    expect(claimCase.driver.destroyedIds).toEqual([]);

    const settleCase = buildService();
    const settleSession = await settleCase.service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const settleError = new Error('settlement database unavailable');
    settleCase.repo.throwOnSettleSessionOperation = settleError;
    await expect(
      settleCase.service.navigate(ctx, settleSession.id, {
        url: 'https://example.com',
        wait_until: 'load',
      }),
    ).rejects.toBe(settleError);
    expect(settleCase.repo.read(settleSession.id)?.status).toBe('busy');
    expect(settleCase.driver.operationCalls).toEqual(['navigate']);
    expect(settleCase.driver.destroyedIds).toEqual([]);
    expect(settleCase.repo.events.filter((event) => event.type !== 'created')).toEqual([]);
    expect(settleCase.webhookEvents).toEqual([]);

    const failureCase = buildService();
    const failureSession = await failureCase.service.create(ctx, {
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const electionError = new Error('failure election database unavailable');
    failureCase.repo.throwOnFailSessionOperation = electionError;
    failureCase.driver.primeNextThrow({ name: 'DriverError', message: 'driver failed first' });
    await expect(
      failureCase.service.navigate(ctx, failureSession.id, {
        url: 'https://example.com',
        wait_until: 'load',
      }),
    ).rejects.toBe(electionError);
    expect(failureCase.repo.read(failureSession.id)?.status).toBe('busy');
    expect(failureCase.driver.destroyedIds).toEqual([]);
    expect(failureCase.repo.events.filter((event) => event.type !== 'created')).toEqual([]);
    expect(failureCase.webhookEvents).toEqual([]);
    expect(failureCase.lifecycleEvents).toEqual([]);
    expect(failureCase.notifications).toEqual([]);
  });
});

describe('SessionsService — terminal-state resurrection guard', () => {
  it('getState close-winner suppresses the stale success tail and never resurrects the row', async () => {
    const { service, repo, driver } = buildService();
    const ctx = buildCtx();
    const session = await service.create(ctx, { archetype: 'iphone16pro_ios18_7_safari26_4' });

    const destroyedAt = new Date();
    // Land the terminal winner after the operation claimed busy but before its
    // owner settlement. The stale capture must return 410 and publish nothing.
    driver.onGetState = () => {
      repo.forceTerminal(session.id, 'destroyed', destroyedAt);
    };

    await expect(service.getState(ctx, session.id)).rejects.toBeInstanceOf(SessionDestroyedError);

    const after = repo.read(session.id);
    expect(after?.status).toBe('destroyed');
    expect(after?.destroyedAt).toEqual(destroyedAt);
    expect(repo.touchSessionLastStateAtAttempts).toEqual([]);
    expect(repo.events.filter((event) => event.type === 'state_captured')).toHaveLength(0);
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
    await vi.waitFor(() => expect(loggedErrors).toHaveLength(1));
    expect(loggedErrors[0]?.obj).toMatchObject({
      event: 'post_success_persistence_failed',
      operation: 'create',
      persistence: 'event',
    });
  });
});
