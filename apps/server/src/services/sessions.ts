// Sessions service — orchestrates DB writes and driver calls behind the
// public session API. Decoupled from Drizzle via SessionRepo interface;
// decoupled from the actual WebKit substrate via the Driver interface.
//
// Every method takes an AccountContext and enforces account-scoped ownership
// — a session belongs to exactly one account, and only that account's keys
// can operate on it.

import {
  DEFAULT_SESSION_PURPOSE,
  LOCKED_ARCHETYPE_ID,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  type AccountTier,
  type CaptureKind,
  type CaptureRequest,
  type CreateSessionRequest,
  type InteractRequest,
  type NavigateRequest,
  type SessionPurpose,
  type WaitRequest,
} from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import type { Driver } from '../drivers/types.js';
import type { GUIInputRequest } from '../schemas/gui-input.js';
import { ConcurrencyLimitError, NotFoundError, SessionDestroyedError } from '../lib/errors.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';

// ───────────────────────────────────────────────────────────────────────────
// Concurrent session limits + profile count limits per tier
// ───────────────────────────────────────────────────────────────────────────

// Single source of truth lives in api-types
// (TIER_CONCURRENT_SESSION_LIMITS, V-156). Helper kept here so
// existing call sites don't churn.
export function concurrentSessionLimitFor(tier: AccountTier): number {
  return TIER_CONCURRENT_SESSION_LIMITS[tier];
}

// Profile count limit per tier — enforced at the /v1/profiles
// creation gate. Single source of truth lives in api-types
// (PROFILES_PER_TIER, V-136). The api-types record uses the
// 'custom' sentinel for enterprise; this helper translates to
// null for the legacy null-means-unlimited contract that the
// /v1/profiles enforcement code expects.
export function profileLimitFor(tier: AccountTier): number | null {
  const limit = PROFILES_PER_TIER[tier];
  return limit === 'custom' ? null : limit;
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
  /** V-169 — harness purpose. */
  purpose: SessionPurpose;
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
  /** V-169 — harness purpose. Defaults applied at the service-layer. */
  purpose: SessionPurpose;
  label: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SessionEventInput {
  sessionId: string;
  type:
    | 'created'
    | 'navigated'
    | 'interacted'
    | 'gui_input'
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
  /** Find a session by id WITHOUT account scoping (admin force-actions only). */
  findSessionUnscoped(id: string): Promise<SessionRecord | null>;
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
  /**
   * Cross-account session list for admin operational tooling. Filters
   * by status (single value) and/or accountId. Cursor pagination by
   * createdAt DESC, mirroring listSessions().
   */
  listAllSessions(opts: {
    limit: number;
    cursor?: string;
    status?: SessionRecord['status'];
    accountId?: string;
  }): Promise<SessionListPage>;
  recordEvent(input: SessionEventInput): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export interface SessionsServiceDeps {
  repo: SessionRepo;
  driver: Driver;
  /** Optional: when wired, emits session.completed / session.failed events. */
  webhooks?: {
    enqueueEvent: (
      accountId: string,
      eventType: 'session.completed' | 'session.failed',
      data: Record<string, unknown>,
    ) => Promise<number>;
  } | null;
  /** V-216: optional customer-facing audit emitter. */
  accountAudit?: {
    record: (input: {
      accountId: string;
      actorType: 'customer' | 'system' | 'staff';
      actorAccountId?: string | null;
      actorKeyId?: string | null;
      action: 'session.created' | 'session.destroyed';
      targetResourceId?: string | null;
      payload?: Record<string, unknown> | null;
    }) => Promise<unknown>;
  } | null;
  /**
   * V-202c: optional lifecycle dispatcher. When wired, the first
   * session.failed for an account triggers `session-failed-first`
   * email (deduped via `accounts.first_failure_email_sent_at`).
   * Subsequent failures no-op at the dedup gate.
   * V-304a: also handles `session.success.first` for the activation
   * milestone email; same once-per-account dedup pattern.
   */
  accountLifecycle?: {
    emit: (
      accountId: string,
      event:
        | { kind: 'session.failed.first'; sessionId: string; errorMessage: string }
        | { kind: 'session.success.first'; sessionId: string },
    ) => Promise<void>;
  } | null;
}

export class SessionsService {
  constructor(private readonly deps: SessionsServiceDeps) {}

  async create(
    ctx: AccountContext,
    body: CreateSessionRequest,
    opts: { effectiveAccountId?: string; effectiveTier?: AccountTier } = {},
  ): Promise<SessionRecord> {
    // V-326e1 — when effectiveAccountId is set (route layer resolved
    // X-Driftstack-Account + verified the caller has 'admin' role on
    // the owner's team), the new session is OWNED by the team owner
    // and counts against the OWNER's concurrent cap. Tier-derived
    // limits use the owner's tier (route looks it up).
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const tier = opts.effectiveTier ?? ctx.account.tier;

    const limit = concurrentSessionLimitFor(tier);
    const active = await this.deps.repo.countActiveSessions(accountId);
    if (active >= limit) {
      throw new ConcurrencyLimitError(active, limit);
    }

    const archetype = body.archetype ?? LOCKED_ARCHETYPE_ID;
    const purpose: SessionPurpose = body.purpose ?? DEFAULT_SESSION_PURPOSE;
    const driverResult = await this.deps.driver.createSession({
      archetype,
      purpose,
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    });

    const record = await this.deps.repo.insertSession({
      accountId,
      // apiKey stays the member's — that's the actor; the owner's
      // audit log shows which member's key created the session.
      apiKeyId: ctx.apiKey.id,
      driverSessionId: driverResult.driverSessionId,
      archetype,
      purpose,
      label: body.label ?? null,
      metadata: body.metadata ?? null,
    });

    await this.deps.repo.updateSessionStatus(record.id, 'ready');
    await this.deps.repo.recordEvent({
      sessionId: record.id,
      type: 'created',
      payload: { archetype, purpose, driver_session_id: driverResult.driverSessionId },
      durationMs: null,
    });

    // V-216 — customer-facing audit entry.
    // V-326e1 — audit row goes on the OWNER's audit log (accountId
    // is the owner) but actor stays the member (so the audit reads
    // "Member X created session Y on team owner Z").
    if (this.deps.accountAudit) {
      try {
        await this.deps.accountAudit.record({
          accountId,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'session.created',
          targetResourceId: `ses_${record.id}`,
          payload: { archetype, purpose },
        });
      } catch {
        /* swallow */
      }
    }

    return { ...record, status: 'ready' };
  }

  async navigate(
    ctx: AccountContext,
    sessionId: string,
    body: NavigateRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{
    url: string;
    finalUrl: string;
    status: number;
    durationMs: number;
  }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    const result = await this.runWithFailureCapture(ctx, session, 'navigate', () =>
      this.deps.driver.navigate(session.driverSessionId, {
        url: body.url,
        timeoutMs: body.timeout_ms ?? 30_000,
        waitUntil: body.wait_until,
      }),
    );
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
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    const result = await this.runWithFailureCapture(ctx, session, 'interact', () =>
      this.deps.driver.interact(session.driverSessionId, {
        action: body.action,
        timeoutMs: body.timeout_ms ?? 10_000,
      }),
    );
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'interacted',
      payload: { action: body.action },
      durationMs: result.durationMs,
    });
    return result;
  }

  async guiInput(
    ctx: AccountContext,
    sessionId: string,
    body: GUIInputRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    const result = await this.runWithFailureCapture(ctx, session, 'gui_input', () =>
      this.deps.driver.guiInput(session.driverSessionId, {
        action: body.action,
        timeoutMs: body.timeout_ms ?? 10_000,
      }),
    );
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'gui_input',
      payload: { action: body.action },
      durationMs: result.durationMs,
    });
    return result;
  }

  async wait(
    ctx: AccountContext,
    sessionId: string,
    body: WaitRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ satisfied: boolean; durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    const result = await this.runWithFailureCapture(ctx, session, 'wait', () =>
      this.deps.driver.wait(session.driverSessionId, {
        condition: body.condition,
        timeoutMs: body.timeout_ms ?? 30_000,
      }),
    );
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
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{
    url: string | null;
    title: string | null;
    cookies: Array<Record<string, unknown>>;
    localStorage: Record<string, string>;
    capturedAt: Date;
  }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    const state = await this.runWithFailureCapture(ctx, session, 'state_capture', () =>
      this.deps.driver.getState(session.driverSessionId),
    );
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
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{
    kind: CaptureKind;
    data: string;
    encoding: 'base64' | 'utf8';
    byteSize: number;
    durationMs: number;
  }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    const result = await this.runWithFailureCapture(ctx, session, 'capture', () =>
      this.deps.driver.capture(session.driverSessionId, {
        kind: body.kind,
        fullPage: body.full_page,
      }),
    );
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

  async destroy(
    ctx: AccountContext,
    sessionId: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<void> {
    // V-167 — true idempotent destroy. Pre-V-167 this called requireOwned()
    // which threw SessionDestroyedError (HTTP 410) on already-destroyed
    // sessions before the early-return short-circuit could run. The
    // result was DELETE returning 410 on a destroyed session, which
    // breaks REST idempotency conventions + contradicted the comment
    // claim. Now: lookup directly + short-circuit on terminal status.
    // V-326e2 — when effectiveAccountId is set, the destroy targets
    // a session owned by the team OWNER. Route layer enforces
    // 'admin' role per Q1 before reaching here.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const session = await this.deps.repo.findSession(sessionId, accountId);
    if (!session) throw new NotFoundError(`Session "${sessionId}" not found.`);
    // Terminal-status no-ops. 'destroyed' is the obvious one; 'errored'
    // also short-circuits per V-090 (a failed session has nothing
    // useful left to destroy).
    if (session.status === 'destroyed' || session.status === 'errored') return;
    const destroyedAt = new Date();
    await this.deps.driver.destroy(session.driverSessionId);
    await this.deps.repo.updateSessionStatus(session.id, 'destroyed', { destroyedAt });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'destroyed',
      payload: null,
      durationMs: null,
    });

    // Emit session.completed webhook event (best-effort; failures here
    // never affect destroy correctness).
    // V-326e2 — webhook fan-out goes to the OWNER (so the owner's
    // configured webhooks receive the completion event).
    const durationMs = destroyedAt.getTime() - session.createdAt.getTime();
    if (this.deps.webhooks) {
      try {
        await this.deps.webhooks.enqueueEvent(accountId, 'session.completed', {
          session_id: `ses_${session.id}`,
          duration_ms: durationMs,
        });
      } catch {
        // Webhook enqueue is best-effort; never break the user-facing op.
      }
    }

    // V-304a — first-success activation email. Internal dedup via
    // first_success_email_sent_at column (lifecycle service races to
    // set; loser skips the email). Best-effort.
    // V-326e2 — first-success email goes to the OWNER's email since
    // it's the OWNER's first successful session that's milestoning.
    if (this.deps.accountLifecycle) {
      try {
        await this.deps.accountLifecycle.emit(accountId, {
          kind: 'session.success.first',
          sessionId: `ses_${session.id}`,
        });
      } catch {
        /* swallow */
      }
    }

    // V-216 — customer-facing audit entry.
    // V-326e2 — audit on the OWNER's log; actor stays the calling
    // member.
    if (this.deps.accountAudit) {
      try {
        await this.deps.accountAudit.record({
          accountId,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'session.destroyed',
          targetResourceId: `ses_${session.id}`,
          payload: { duration_ms: durationMs },
        });
      } catch {
        /* swallow */
      }
    }
  }

  async list(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string; effectiveAccountId?: string },
  ): Promise<SessionListPage> {
    // V-326d — when effectiveAccountId is set (route layer resolved
    // X-Driftstack-Account to a team owner the caller is a member of),
    // list the owner's sessions instead of the caller's. Otherwise
    // default to the caller's own account. Authorization is enforced
    // by the route — the resolver returns kind:'team' only when the
    // caller is actually a member, so by the time we get here the
    // override is already validated.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    return this.deps.repo.listSessions(accountId, opts);
  }

  /**
   * Cross-account list for the admin panel + ops tooling. Requires
   * driftstack_internal_admin scope (compat alias 'admin' also accepted
   * for legacy keys per V-174 migration).
   */
  async listAll(
    ctx: AccountContext,
    opts: {
      limit: number;
      cursor?: string;
      status?: SessionRecord['status'];
      accountId?: string;
    },
  ): Promise<SessionListPage> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.deps.repo.listAllSessions(opts);
  }

  /**
   * V-531.B — pure ownership check for routes that only need to know
   * "does this account own this session" without the driver side-effects
   * the existing `requireOwned` path triggers. Returns the row when
   * owned + not in a terminal state, null otherwise. Used by
   * /v1/sessions/:id/livekit-token to gate token minting.
   */
  async findOwnedSessionLite(accountId: string, sessionId: string): Promise<SessionRecord | null> {
    const session = await this.deps.repo.findSession(sessionId, accountId);
    if (session === null) return null;
    if (session.status === 'destroyed' || session.status === 'errored') return null;
    return session;
  }

  // ─────────────────────────────────────────────────────────────────────────

  private async requireOwned(
    ctx: AccountContext,
    sessionId: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<SessionRecord> {
    // V-326e3 — when effectiveAccountId is set, look up the session
    // on the OWNER's account (route layer has already enforced the
    // 'admin' role for write actions). Read actions (getState) allow
    // both 'member' and 'admin' roles per the V-330 read pattern.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const session = await this.deps.repo.findSession(sessionId, accountId);
    if (!session) throw new NotFoundError(`Session "${sessionId}" not found.`);
    // V-090 founder-approved semantic: a session that has entered the
    // 'errored' state behaves the same as 'destroyed' for the customer
    // — subsequent ops 410. The only useful op on a failed session is
    // a delete (idempotent destroy) which is allowed to short-circuit.
    if (session.status === 'destroyed' || session.status === 'errored') {
      throw new SessionDestroyedError();
    }
    return session;
  }

  /**
   * V-090: wrap a driver call so that on throw, we mark the session
   * `errored`, set destroyedAt, fire `session.failed` webhook event,
   * and re-throw the original error. The route layer catches the
   * re-throw and surfaces it as a DriverError / SessionTimeoutError
   * RFC 7807 problem.
   *
   * The webhook event fires ONLY on the first failure for this
   * session. Subsequent calls would 410 SessionDestroyed at
   * `requireOwned` before reaching here, so duplicate `session.failed`
   * emissions are not a risk.
   */
  private async runWithFailureCapture<T>(
    _ctx: AccountContext,
    session: SessionRecord,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const erroredAt = new Date();
      const errorMessage =
        err instanceof Error
          ? err.message
          : ((err as { toString?: () => string }).toString?.() ?? 'unknown driver failure');
      const errorName = err instanceof Error ? err.name : 'UnknownError';

      // Persist the failure state. Errors here are swallowed so the
      // original driver error still propagates to the caller — the DB
      // write is best-effort, the user-facing error wins.
      try {
        await this.deps.repo.updateSessionStatus(session.id, 'errored', {
          destroyedAt: erroredAt,
        });
      } catch {
        /* swallow — original error wins */
      }
      try {
        await this.deps.repo.recordEvent({
          sessionId: session.id,
          type: 'errored',
          payload: { operation, error_name: errorName, error_message: errorMessage },
          durationMs: null,
        });
      } catch {
        /* swallow */
      }

      // Emit session.failed webhook event. Same fire-and-forget posture
      // as session.completed in destroy().
      // V-326e3 — fan-out goes to the SESSION OWNER (session.accountId),
      // not the caller. When a member fails on an owner's session,
      // the owner's webhook subscription fires + the owner gets the
      // first-failure email. The caller is the actor; the resource's
      // owner is the audience.
      if (this.deps.webhooks) {
        const durationMs = erroredAt.getTime() - session.createdAt.getTime();
        try {
          await this.deps.webhooks.enqueueEvent(session.accountId, 'session.failed', {
            session_id: `ses_${session.id}`,
            duration_ms: durationMs,
            operation,
            error_name: errorName,
            error_message: errorMessage,
          });
        } catch {
          /* webhook enqueue is best-effort */
        }
      }

      // V-202c — dispatch the first-failure lifecycle event. Internal
      // dedup gate ensures exactly one email per account regardless of
      // how many failures fire concurrently across sessions. Best-effort:
      // a lifecycle dispatch failure must NEVER mask the original
      // driver error from the customer.
      if (this.deps.accountLifecycle) {
        try {
          await this.deps.accountLifecycle.emit(session.accountId, {
            kind: 'session.failed.first',
            sessionId: `ses_${session.id}`,
            errorMessage,
          });
        } catch {
          /* swallow — original error wins */
        }
      }

      throw err;
    }
  }
}
