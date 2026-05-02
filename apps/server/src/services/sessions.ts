// Sessions service — orchestrates DB writes and driver calls behind the
// public session API. Decoupled from Drizzle via SessionRepo interface;
// decoupled from the actual WebKit substrate via the Driver interface.
//
// Every method takes an AccountContext and enforces account-scoped ownership
// — a session belongs to exactly one account, and only that account's keys
// can operate on it.

import type {
  AccountTier,
  CaptureKind,
  CaptureRequest,
  CreateSessionRequest,
  InteractRequest,
  NavigateRequest,
  WaitRequest,
} from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import type { Driver } from '../drivers/types.js';
import { ConcurrencyLimitError, NotFoundError, SessionDestroyedError } from '../lib/errors.js';

// ───────────────────────────────────────────────────────────────────────────
// Concurrent session limits per tier
// ───────────────────────────────────────────────────────────────────────────

const TIER_CONCURRENT_SESSION_LIMITS: Record<AccountTier, number> = {
  free: 1,
  starter: 5,
  pro: 20,
  enterprise: 100,
};

export function concurrentSessionLimitFor(tier: AccountTier): number {
  return TIER_CONCURRENT_SESSION_LIMITS[tier];
}

// ───────────────────────────────────────────────────────────────────────────
// Repository interface
// ───────────────────────────────────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  accountId: string;
  apiKeyId: string;
  driverSessionId: string;
  status: 'creating' | 'ready' | 'busy' | 'destroyed' | 'errored';
  archetype: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  lastStateAt: Date | null;
  destroyedAt: Date | null;
}

export interface NewSessionInput {
  accountId: string;
  apiKeyId: string;
  driverSessionId: string;
  archetype: string;
  label: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SessionEventInput {
  sessionId: string;
  type:
    | 'created'
    | 'navigated'
    | 'interacted'
    | 'waited'
    | 'state_captured'
    | 'screenshot_captured'
    | 'destroyed'
    | 'errored';
  payload: Record<string, unknown> | null;
  durationMs: number | null;
}

export interface SessionListPage {
  items: SessionRecord[];
  /** Cursor for the next page; null when this is the last page. */
  nextCursor: string | null;
}

export interface SessionRepo {
  insertSession(input: NewSessionInput): Promise<SessionRecord>;
  /** Find a session by id, scoped to the supplied account. */
  findSession(id: string, accountId: string): Promise<SessionRecord | null>;
  updateSessionStatus(
    id: string,
    status: SessionRecord['status'],
    extra?: { lastStateAt?: Date; destroyedAt?: Date },
  ): Promise<void>;
  countActiveSessions(accountId: string): Promise<number>;
  listSessions(
    accountId: string,
    opts: { limit: number; cursor?: string },
  ): Promise<SessionListPage>;
  recordEvent(input: SessionEventInput): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export interface SessionsServiceDeps {
  repo: SessionRepo;
  driver: Driver;
}

export class SessionsService {
  constructor(private readonly deps: SessionsServiceDeps) {}

  async create(ctx: AccountContext, body: CreateSessionRequest): Promise<SessionRecord> {
    const limit = concurrentSessionLimitFor(ctx.account.tier);
    const active = await this.deps.repo.countActiveSessions(ctx.account.id);
    if (active >= limit) {
      throw new ConcurrencyLimitError(active, limit);
    }

    const archetype = body.archetype ?? 'iphone16pro_ios26_4_1';
    const driverResult = await this.deps.driver.createSession({
      archetype,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });

    const record = await this.deps.repo.insertSession({
      accountId: ctx.account.id,
      apiKeyId: ctx.apiKey.id,
      driverSessionId: driverResult.driverSessionId,
      archetype,
      label: body.label ?? null,
      metadata: body.metadata ?? null,
    });

    await this.deps.repo.updateSessionStatus(record.id, 'ready');
    await this.deps.repo.recordEvent({
      sessionId: record.id,
      type: 'created',
      payload: { archetype, driver_session_id: driverResult.driverSessionId },
      durationMs: null,
    });

    return { ...record, status: 'ready' };
  }

  async navigate(
    ctx: AccountContext,
    sessionId: string,
    body: NavigateRequest,
  ): Promise<{
    url: string;
    finalUrl: string;
    status: number;
    durationMs: number;
  }> {
    const session = await this.requireOwned(ctx, sessionId);
    const result = await this.deps.driver.navigate(session.driverSessionId, {
      url: body.url,
      timeoutMs: body.timeout_ms ?? 30_000,
      waitUntil: body.wait_until,
    });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'navigated',
      payload: { url: body.url, final_url: result.finalUrl, status: result.status },
      durationMs: result.durationMs,
    });
    return result;
  }

  async interact(
    ctx: AccountContext,
    sessionId: string,
    body: InteractRequest,
  ): Promise<{ durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId);
    const result = await this.deps.driver.interact(session.driverSessionId, {
      action: body.action,
      timeoutMs: body.timeout_ms ?? 10_000,
    });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'interacted',
      payload: { action: body.action },
      durationMs: result.durationMs,
    });
    return result;
  }

  async wait(
    ctx: AccountContext,
    sessionId: string,
    body: WaitRequest,
  ): Promise<{ satisfied: boolean; durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId);
    const result = await this.deps.driver.wait(session.driverSessionId, {
      condition: body.condition,
      timeoutMs: body.timeout_ms ?? 30_000,
    });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'waited',
      payload: { condition: body.condition, satisfied: result.satisfied },
      durationMs: result.durationMs,
    });
    return result;
  }

  async getState(
    ctx: AccountContext,
    sessionId: string,
  ): Promise<{
    url: string | null;
    title: string | null;
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    capturedAt: Date;
  }> {
    const session = await this.requireOwned(ctx, sessionId);
    const state = await this.deps.driver.getState(session.driverSessionId);
    await this.deps.repo.updateSessionStatus(session.id, session.status, {
      lastStateAt: state.capturedAt,
    });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'state_captured',
      payload: { url: state.url, title: state.title },
      durationMs: null,
    });
    return state;
  }

  async capture(
    ctx: AccountContext,
    sessionId: string,
    body: CaptureRequest,
  ): Promise<{
    kind: CaptureKind;
    data: string;
    encoding: 'base64' | 'utf8';
    byteSize: number;
    durationMs: number;
  }> {
    const session = await this.requireOwned(ctx, sessionId);
    const result = await this.deps.driver.capture(session.driverSessionId, {
      kind: body.kind,
      fullPage: body.full_page,
    });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type:
        body.kind === 'screenshot' || body.kind === 'pdf'
          ? 'screenshot_captured'
          : 'state_captured',
      payload: { kind: body.kind, byte_size: result.byteSize },
      durationMs: result.durationMs,
    });
    return result;
  }

  async destroy(ctx: AccountContext, sessionId: string): Promise<void> {
    const session = await this.requireOwned(ctx, sessionId);
    if (session.status === 'destroyed') return; // idempotent
    await this.deps.driver.destroy(session.driverSessionId);
    await this.deps.repo.updateSessionStatus(session.id, 'destroyed', {
      destroyedAt: new Date(),
    });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'destroyed',
      payload: null,
      durationMs: null,
    });
  }

  async list(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string },
  ): Promise<SessionListPage> {
    return this.deps.repo.listSessions(ctx.account.id, opts);
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async requireOwned(ctx: AccountContext, sessionId: string): Promise<SessionRecord> {
    const session = await this.deps.repo.findSession(sessionId, ctx.account.id);
    if (!session) throw new NotFoundError(`Session "${sessionId}" not found.`);
    if (session.status === 'destroyed') throw new SessionDestroyedError();
    return session;
  }
}
