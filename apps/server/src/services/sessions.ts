// Sessions service — orchestrates DB writes and driver calls behind the
// public session API. Decoupled from Drizzle via SessionRepo interface;
// decoupled from the actual WebKit substrate via the Driver interface.
//
// Every method takes an AccountContext and enforces account-scoped ownership
// — a session belongs to exactly one account, and only that account's keys
// can operate on it.

import {
  DEFAULT_BEHAVIORAL_PROFILE,
  DEFAULT_SESSION_PURPOSE,
  LOCKED_ARCHETYPE_ID,
  MAX_SESSION_MINUTES_PER_TIER,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  type AccountTier,
  type CaptureKind,
  type CaptureRequest,
  type ExtractRequest,
  type SearchRequest,
  type SessionLoginRequest,
  type CreateSessionRequest,
  type InteractRequest,
  type NavigateRequest,
  type PageState,
  type SessionPurpose,
  type WaitRequest,
} from '@driftstack/api-types';
import { randomUUID } from 'node:crypto';
import type { AccountContext } from './auth.js';
import type { Driver } from '../drivers/types.js';
import type { GUIInputRequest } from '../schemas/gui-input.js';
import {
  BadRequestError,
  ConcurrencyLimitError,
  NotFoundError,
  SessionDestroyedError,
} from '../lib/errors.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import { redactText } from '../lib/redact-url.js';

const SESSION_FAILURE_MESSAGE_MAX_CHARS = 500;
const SESSION_FAILURE_NAME_MAX_CHARS = 100;

function safeSessionFailureDiagnostic(value: string, maxChars: number, fallback: string): string {
  // Driver errors cross durable + customer-visible boundaries below. Bound
  // before redaction to avoid processing attacker-sized diagnostics, then
  // bound again because replacement markers can expand short credentials.
  const bounded = value.slice(0, maxChars);
  return (redactText(bounded) || fallback).slice(0, maxChars);
}

function unknownFailureMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown driver failure';
  }
}

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

// 6.g — max wall-clock minutes for a single session before auto-destroy.
// Single source of truth in api-types (MAX_SESSION_MINUTES_PER_TIER). `null`
// = unlimited (paid tiers); free is capped (20) so it reads as an evaluation
// tier without needing a daily-usage meter. The create gate + the duration
// sweep read this; `null` means no cap applies.
export function maxSessionMinutesFor(tier: AccountTier): number | null {
  return MAX_SESSION_MINUTES_PER_TIER[tier];
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
  /**
   * Harness-reported egress capabilities for SOCKS5 sessions (migration
   * 0045, cross-agent contract commit 7d5992d9; EG-WK-1.9 extension
   * 2026-05-17 adds dns_remote_resolve). Null until the harness emits
   * the `egress.capability_report` event after proxy wire-up; non-
   * SOCKS5 sessions stay null permanently.
   */
  egressCapabilities: {
    udp_associate: boolean;
    quic_route: 'proxy' | 'direct' | 'disabled';
    dns_remote_resolve: boolean;
    warnings: string[];
  } | null;
  /**
   * Arc 5 EGRESS eg.1 — RAW harness-emitted event payload (migration
   * 0054). Stored alongside the derived `egressCapabilities` view
   * for forensics + schema-evolution safety. Opaque JSON; consumers
   * MUST prefer `egressCapabilities` for typed access. Null until
   * the harness emits.
   */
  egressCapabilityReport: Record<string, unknown> | null;
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
  /**
   * Atomic insert-if-under-cap: insert the session only if the account has
   * fewer than `limit` active (non-destroyed) sessions, else return null —
   * the count + insert happen under a per-account lock so concurrent creates
   * can't all pass a stale count and exceed the tier cap (the create-path
   * TOCTOU). The slow driver.createSession runs BEFORE this call, never under
   * the lock.
   *
   * A3 finding #7 (W2979/W2980) — single-active-session-per-profile guard. When
   * `opts.profileId` is supplied, the same atomic transaction ALSO takes a per-
   * profile advisory lock + refuses a second bind against a NON-TERMINAL
   * (status NOT IN destroyed/errored AND destroyed_at IS NULL) session whose
   * `metadata->>'profile_id'` matches, for the same account — throwing
   * ProfileInUseError(activeSessionId) (the route maps it to a 409 with
   * `active_session_id`). Two concurrent profile-bound creates serialise on the
   * profile lock so exactly one binds, preventing the cross-node sealed-blob
   * clobber (both sessions restore the same blob → diverge → both save back). A
   * create with no profileId is never gated (fail-safe).
   */
  insertSessionIfUnderLimit(
    input: NewSessionInput,
    limit: number,
    opts?: { profileId?: string },
  ): Promise<SessionRecord | null>;
  /**
   * DoS hardening — bind the real driver session id onto a session row that
   * was inserted with a placeholder id to RESERVE its concurrency slot before
   * the (slow) worker dispatch. Called once the worker is live.
   */
  setSessionDriverSessionId(id: string, driverSessionId: string): Promise<void>;
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
  /**
   * Cross-account session count grouped by status — every SessionStatus
   * present, zero-filled. Powers the admin ops dashboard's session-stats
   * tile. System-scoped (no AccountContext; the route gates the scope).
   */
  countAllByStatus(): Promise<Record<SessionRecord['status'], number>>;
  /**
   * Every still-active session (status creating | ready | busy) for an
   * account. Drives the suspend-reclaim path (destroyAllForAccount);
   * system-scoped, no AccountContext.
   */
  listActiveByAccount(accountId: string): Promise<SessionRecord[]>;
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
  /**
   * 6.g — find active sessions that have exceeded their tier's wall-clock
   * duration cap and are eligible for auto-destroy.
   *
   * The cap source-of-truth is `maxSessionMinutesFor(tier)` (see the
   * SessionDurationSweeperService) — the SERVICE computes a per-capped-tier
   * cutoff and passes the `(tier, expiredBefore)` pairs here so the repo
   * never re-derives cap values. The repo's only job is "return ACTIVE
   * sessions whose account is on one of these tiers and whose createdAt is
   * strictly before that tier's cutoff". `status` is restricted to the
   * non-terminal set (`creating` / `ready` / `busy`) — destroyed/errored
   * rows are never returned. Returns at most `limit` rows (oldest first)
   * so a tick is bounded; the sweep re-runs each cadence to drain a backlog.
   */
  listExpiredForAutoDestroy(opts: {
    tierCutoffs: ReadonlyArray<{ tier: AccountTier; expiredBefore: Date }>;
    limit: number;
  }): Promise<SessionRecord[]>;
  recordEvent(input: SessionEventInput): Promise<void>;
  /**
   * Arc 5 EGRESS eg.1/eg.2 — persist the harness-emitted
   * `egress.capability_report` event. Stores BOTH the raw payload
   * (egress_capability_report column, migration 0054) for forensics
   * + the derived view (egress_capabilities column, migration 0045)
   * for SDK + dashboard consumption.
   *
   * Idempotent — repeat reports overwrite (the harness may emit
   * multiple times during a session's lifetime; we keep the latest).
   * Returns null when no session matches the id (the harness might
   * race ahead of the session-create on faulty deployments).
   */
  setEgressCapabilityReport(args: {
    sessionId: string;
    derived: {
      udp_associate: boolean;
      quic_route: 'proxy' | 'direct' | 'disabled';
      dns_remote_resolve: boolean;
      warnings: string[];
    };
    raw: Record<string, unknown>;
  }): Promise<SessionRecord | null>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export interface SessionsServiceDeps {
  repo: SessionRepo;
  driver: Driver;
  /** Optional: when wired, emits session.completed / session.failed /
   *  session.egress_capability_changed events. Arc 5 EGRESS eg.7
   *  extends the closed eventType union with the third value. */
  webhooks?: {
    enqueueEvent: (
      accountId: string,
      eventType: 'session.completed' | 'session.failed' | 'session.egress_capability_changed',
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
  /**
   * 2026-05-20 — optional NotificationEventBus publisher for the
   * v0 `session.errored` notification kind. When wired, every
   * transition to status='errored' fans out to subscribers (GUI
   * panel today; future SDK subscribers later). Best-effort: a
   * throwing publisher MUST NOT break the underlying error-handling
   * path — the audit log + webhook stay the durable trail.
   */
  notifications?: {
    publish: (event: {
      kind: 'session.errored';
      accountId: string;
      sessionId: string;
      errorClass: string;
      at: string;
    }) => void;
  } | null;
  /**
   * Billing-integrity hardening — optional structured logger. Used to
   * LOUD-log a post-dispatch slot-release (a DB write that fails AFTER
   * the worker is live would otherwise leak a `creating` row that
   * counts against the concurrent-session cap forever on capped-AND
   * uncapped tiers). Omitted ⇒ no log; the release still happens.
   */
  logger?: {
    error?: (obj: Record<string, unknown>, msg: string) => void;
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

    const archetype = body.archetype ?? LOCKED_ARCHETYPE_ID;
    const purpose: SessionPurpose = body.purpose ?? DEFAULT_SESSION_PURPOSE;
    // 2026-06-05 — behavioural persona, defaulted at the service like purpose
    // (the harness always gets a persona). Passed to the driver create-input;
    // not persisted (a create-time harness config, not a queryable column).
    const behavioralProfile = body.behavioral_profile ?? DEFAULT_BEHAVIORAL_PROFILE;

    // DoS hardening — RESERVE the cap slot atomically BEFORE spinning a real
    // browser worker. Previously driver.createSession (the costly op) ran
    // first and the atomic cap check came after, so N concurrent over-cap
    // creates each spun a worker and the losers were torn down only via a
    // best-effort destroy whose failure leaked a live worker (no reaper for
    // a DB-rowless worker). Now we insert the session row first — with a
    // placeholder driverSessionId, under the same per-account advisory lock
    // (insertSessionIfUnderLimit) — so an over-cap create is rejected with
    // ZERO worker spun. The real driver id is filled in after dispatch; on
    // dispatch failure the reservation row is marked destroyed so it stops
    // counting against the cap (and a DB-tracked row means even a missed
    // teardown is reapable, unlike the old orphan).
    // A3 finding #7 (W2979/W2980) — the route stamps the resolved profile binding
    // into metadata.profile_id (a bare uuid). Lift it out so the atomic reserve
    // can ALSO enforce the single-active-session-per-profile guard under the same
    // per-profile advisory lock. Absent (no profile-backed create) → no guard.
    const profileIdMeta = body.metadata?.['profile_id'];
    const profileId = typeof profileIdMeta === 'string' ? profileIdMeta : undefined;
    const reservationDriverId = `reserving:${randomUUID()}`;
    const reserved = await this.deps.repo.insertSessionIfUnderLimit(
      {
        accountId,
        // apiKey stays the member's — that's the actor; the owner's
        // audit log shows which member's key created the session.
        apiKeyId: ctx.apiKey.id,
        driverSessionId: reservationDriverId,
        archetype,
        purpose,
        label: body.label ?? null,
        metadata: body.metadata ?? null,
      },
      limit,
      profileId !== undefined ? { profileId } : {},
    );
    if (reserved === null) {
      // At/over the cap — no worker was spun. The count at this point is the
      // limit (the locked count rejected the insert).
      throw new ConcurrencyLimitError(limit, limit);
    }

    let driverResult: { driverSessionId: string };
    try {
      driverResult = await this.deps.driver.createSession({
        archetype,
        purpose,
        behavioralProfile,
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
      });
    } catch (err) {
      // Worker dispatch failed AFTER the slot was reserved. Release the
      // reservation row so it stops counting against the cap (mark destroyed,
      // not delete — keeps an auditable trail + matches the duration-sweep /
      // countActiveSessions destroyedAt semantics). Best-effort; a failure to
      // release must not mask the original dispatch error.
      await this.deps.repo
        .updateSessionStatus(reserved.id, 'errored', { destroyedAt: new Date() })
        .catch(() => {});
      throw err;
    }

    // Bind the real driver session id onto the reserved row now that the
    // worker is live, then advance to 'ready'.
    //
    // Billing-integrity hardening — these two writes run AFTER a successful
    // dispatch with NO guard previously. A throw here left the row stuck at
    // status='creating', destroyedAt=NULL forever: it keeps counting against
    // countActiveSessions, and on paid tiers (null minute-cap) the duration
    // sweeper never reaps it and the worker is live so the disconnect reaper
    // won't either → a permanently-leaked concurrency slot. Mirror the
    // dispatch-failure release path: on throw, release the reserved slot
    // (mark errored + destroyed), tear down the now-orphaned live worker,
    // LOUD-log, and rethrow the original error.
    let record: SessionRecord;
    try {
      await this.deps.repo.setSessionDriverSessionId(reserved.id, driverResult.driverSessionId);
      record = { ...reserved, driverSessionId: driverResult.driverSessionId };
      await this.deps.repo.updateSessionStatus(record.id, 'ready');
    } catch (err) {
      // Release the reserved slot so it stops counting against the cap.
      // Best-effort; a release failure must not mask the original error.
      await this.deps.repo
        .updateSessionStatus(reserved.id, 'errored', { destroyedAt: new Date() })
        .catch(() => {});
      // Tear down the orphaned live worker (the row is now a tombstone, so
      // nothing else will ever destroy it). Best-effort.
      await this.deps.driver.destroy(driverResult.driverSessionId).catch(() => {});
      try {
        this.deps.logger?.error?.(
          {
            component: 'sessions-service',
            event: 'post_dispatch_bind_failed',
            account_id: accountId,
            session_id: reserved.id,
            driver_session_id: driverResult.driverSessionId,
            err,
          },
          'session post-dispatch DB write failed — released the leaked concurrency slot + tore down the orphaned worker',
        );
      } catch {
        // Swallow; logging is best-effort.
      }
      throw err;
    }

    // Best-effort: the session is already fully created (status 'ready', worker
    // live). A post-hoc created-event write failure (DB blip) must NOT surface
    // as a raw 500 to the customer — that leaks a live session while the caller
    // believes create failed. Swallow + log, mirroring the accountAudit block
    // below (same posture: the session exists, an audit/event write can fail).
    try {
      await this.deps.repo.recordEvent({
        sessionId: record.id,
        type: 'created',
        payload: { archetype, purpose, driver_session_id: driverResult.driverSessionId },
        durationMs: null,
      });
    } catch (err) {
      try {
        this.deps.logger?.error?.(
          {
            component: 'sessions-service',
            event: 'created_event_record_failed',
            account_id: accountId,
            session_id: record.id,
            err,
          },
          'session created-event record failed — session is live; swallowed so create still succeeds',
        );
      } catch {
        // Swallow; logging is best-effort.
      }
    }

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
    // W487 — service-level scheme guard (defense-in-depth behind the schema
    // refine): the agent executor calls this service directly, so a prompt-
    // injected file:///ftp: navigate must be rejected HERE, not only at the
    // route schema. http/https only; IP blocklisting deliberately deferred to
    // driver wiring (customer-egress makes private IPs the customer's own).
    if (!/^https?:\/\//i.test(body.url)) {
      throw new BadRequestError('Only http:// and https:// URLs can be navigated.');
    }
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
    /** W615 — page lifecycle from the driver (null = nothing to report). */
    pageState: PageState | null;
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

  /** Read structured data from the page (harness `extract` intent, A3 W456).
   *  A read-op like capture but returns the extracted value map; no session
   *  event is recorded (it's a non-mutating read). */
  async extract(
    ctx: AccountContext,
    sessionId: string,
    body: ExtractRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ value: Record<string, unknown>; durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    return this.runWithFailureCapture(ctx, session, 'extract', () =>
      this.deps.driver.extract(session.driverSessionId, { extractions: body.extractions }),
    );
  }

  /** Find the search field, type the query realistically, submit (harness
   *  `search` intent, A3). A driver write-op; no session event recorded. */
  async search(
    ctx: AccountContext,
    sessionId: string,
    body: SearchRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ submitted: boolean; resultsVisible?: boolean; durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    return this.runWithFailureCapture(ctx, session, 'search', () =>
      this.deps.driver.search(session.driverSessionId, {
        query: body.query,
        ...(body.search_selector !== undefined ? { searchSelector: body.search_selector } : {}),
        submit: body.submit,
        ...(body.wait_for_results_selector !== undefined
          ? { waitForResultsSelector: body.wait_for_results_selector }
          : {}),
        ...(body.timeout_seconds !== undefined ? { timeoutSeconds: body.timeout_seconds } : {}),
      }),
    );
  }

  /** Heuristic credential login (harness `login` intent, A3). A driver
   *  write-op; no session event recorded. The password flows to the driver but
   *  is never logged (failure capture records only the operation label). */
  async login(
    ctx: AccountContext,
    sessionId: string,
    body: SessionLoginRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ loggedIn: boolean; postLoginUrl?: string; durationMs: number }> {
    const session = await this.requireOwned(ctx, sessionId, opts);
    return this.runWithFailureCapture(ctx, session, 'login', () =>
      this.deps.driver.login(session.driverSessionId, {
        username: body.username,
        password: body.password,
        ...(body.username_selector !== undefined
          ? { usernameSelector: body.username_selector }
          : {}),
        ...(body.password_selector !== undefined
          ? { passwordSelector: body.password_selector }
          : {}),
        ...(body.submit_selector !== undefined ? { submitSelector: body.submit_selector } : {}),
        ...(body.success_selector !== undefined ? { successSelector: body.success_selector } : {}),
        ...(body.timeout_seconds !== undefined ? { timeoutSeconds: body.timeout_seconds } : {}),
      }),
    );
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
    // Backstop: if driver.destroy() throws (driver/network fault), STILL release
    // the concurrency slot by marking the row terminal — otherwise the row stays
    // in a non-terminal status (counts as active) forever, and the legacy
    // /v1/sessions surface has no backstop reaper for paid tiers (null minute-cap
    // → autoDestroyExpired never sweeps it), so the slot is permanently consumed.
    // Mirror the create() dispatch-failure release. We mark 'destroyed' (not
    // 'errored') so this stays idempotent with a later successful destroy + the
    // session.completed fan-out below still reflects an intended teardown; the
    // original driver error is re-thrown so the caller sees the failure.
    try {
      await this.deps.driver.destroy(session.driverSessionId);
    } catch (err) {
      await this.deps.repo
        .updateSessionStatus(session.id, 'destroyed', { destroyedAt })
        .catch(() => {
          /* release is best-effort; don't mask the driver error */
        });
      throw err;
    }
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

  /**
   * 6.g — system-actor auto-destroy for the free-tier session-duration
   * sweep. Mirrors `destroy()`'s mechanics (driver.destroy → mark
   * destroyed → record event → best-effort webhook/audit) but takes a
   * pre-resolved SessionRecord instead of an AccountContext: the sweep is
   * a background job with no caller scope, so the customer-facing scope
   * checks + member/owner indirection in `destroy()` don't apply.
   *
   * Idempotent on terminal status (a row that raced to destroyed/errored
   * between the sweep query and this call is a no-op). The `destroyed`
   * event payload carries `reason: 'auto-destroyed: free-tier session
   * duration cap'` + the cap so the audit trail explains the closure.
   * Webhook + audit are best-effort — a failure there never blocks the
   * slot-freeing destroy.
   */
  async autoDestroyExpired(
    session: SessionRecord,
    opts: { maxMinutes: number },
  ): Promise<{ destroyed: boolean }> {
    // Re-read current status before acting. The duration sweeper lists
    // candidates then destroys them SERIALLY (each awaiting driver.destroy),
    // so a candidate can be manually destroyed by the customer SECONDS
    // after the list query. Guarding only on the stale passed-in status
    // would double-process it: a redundant driver.destroy, an overwritten
    // destroyedAt, and a DUPLICATE session.completed webhook + destroyed
    // event. A fresh read collapses that window to the read→destroy gap.
    // Scoped read by the session's own accountId (NOT findSessionUnscoped —
    // that's the admin-force-actions-only finder; this is the session owner).
    const current = await this.deps.repo.findSession(session.id, session.accountId);
    if (current === null || current.status === 'destroyed' || current.status === 'errored') {
      return { destroyed: false };
    }
    const reason = 'auto-destroyed: free-tier session duration cap';
    const destroyedAt = new Date();
    await this.deps.driver.destroy(session.driverSessionId);
    await this.deps.repo.updateSessionStatus(session.id, 'destroyed', { destroyedAt });
    await this.deps.repo.recordEvent({
      sessionId: session.id,
      type: 'destroyed',
      payload: { auto_destroyed: true, reason, max_session_minutes: opts.maxMinutes },
      durationMs: null,
    });

    const durationMs = destroyedAt.getTime() - session.createdAt.getTime();
    if (this.deps.webhooks) {
      try {
        await this.deps.webhooks.enqueueEvent(session.accountId, 'session.completed', {
          session_id: `ses_${session.id}`,
          duration_ms: durationMs,
          auto_destroyed: true,
          reason,
        });
      } catch {
        /* webhook enqueue is best-effort */
      }
    }
    if (this.deps.accountAudit) {
      try {
        await this.deps.accountAudit.record({
          accountId: session.accountId,
          actorType: 'system',
          action: 'session.destroyed',
          targetResourceId: `ses_${session.id}`,
          payload: { duration_ms: durationMs, auto_destroyed: true, reason },
        });
      } catch {
        /* swallow */
      }
    }
    return { destroyed: true };
  }

  /**
   * System-actor reclaim of every still-active session for an account,
   * used when the account is suspended so its browser sessions stop
   * consuming the driver instead of lingering until their duration cap.
   * Mirrors `autoDestroyExpired`'s per-session mechanics (driver destroy →
   * mark destroyed → record event → best-effort session.completed webhook
   * + system audit) with an 'account suspended' reason. No AccountContext:
   * the admin suspend path already authorized. Best-effort PER SESSION —
   * one driver/db failure never blocks reclaiming the rest; the duration
   * sweep mops up any straggler. Returns the count transitioned to destroyed.
   */
  async destroyAllForAccount(accountId: string): Promise<number> {
    const active = await this.deps.repo.listActiveByAccount(accountId);
    const reason = 'account suspended';
    let destroyed = 0;
    for (const session of active) {
      try {
        const destroyedAt = new Date();
        await this.deps.driver.destroy(session.driverSessionId);
        await this.deps.repo.updateSessionStatus(session.id, 'destroyed', { destroyedAt });
        await this.deps.repo.recordEvent({
          sessionId: session.id,
          type: 'destroyed',
          payload: { auto_destroyed: true, reason },
          durationMs: null,
        });
        destroyed += 1;
        const durationMs = destroyedAt.getTime() - session.createdAt.getTime();
        if (this.deps.webhooks) {
          try {
            await this.deps.webhooks.enqueueEvent(accountId, 'session.completed', {
              session_id: `ses_${session.id}`,
              duration_ms: durationMs,
              auto_destroyed: true,
              reason,
            });
          } catch {
            /* webhook enqueue is best-effort */
          }
        }
        if (this.deps.accountAudit) {
          try {
            await this.deps.accountAudit.record({
              accountId,
              actorType: 'system',
              action: 'session.destroyed',
              targetResourceId: `ses_${session.id}`,
              payload: { duration_ms: durationMs, auto_destroyed: true, reason },
            });
          } catch {
            /* swallow */
          }
        }
      } catch {
        // Best-effort per session — keep reclaiming the rest; the duration
        // sweep cleans up any straggler.
      }
    }
    return destroyed;
  }

  async list(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string; effectiveAccountId?: string },
  ): Promise<SessionListPage> {
    // V-553.B-21 — read:sessions (or a satisfying broad scope) gate.
    // Independent of the effectiveAccountId team redirection below —
    // team-scoping decides WHICH account's rows come back, not
    // whether this key may read sessions at all.
    throwIfMissingScope(ctx, 'read:sessions');
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
   * the exact driftstack_internal_admin scope. The legacy customer
   * 'admin' alias is deliberately insufficient for cross-account reads.
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
   * Cross-account session stats for the admin ops dashboard: count by
   * status (every status present, zero-filled), plus `active` (the
   * currently-running statuses creating + ready + busy) and `total`.
   * Requires the exact driftstack_internal_admin scope, same as listAll;
   * the legacy customer 'admin' alias is deliberately insufficient.
   */
  async statsForAdmin(ctx: AccountContext): Promise<{
    by_status: Record<SessionRecord['status'], number>;
    active: number;
    total: number;
  }> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const byStatus = await this.deps.repo.countAllByStatus();
    const active = byStatus.creating + byStatus.ready + byStatus.busy;
    const total = active + byStatus.destroyed + byStatus.errored;
    return { by_status: byStatus, active, total };
  }

  /**
   * Returns the session record for GET /v1/sessions/:id. Read-type
   * action — both 'member' and 'admin' roles are allowed (V-326e3
   * read pattern, mirrors getState). 404s if the caller doesn't own
   * the session or the session doesn't exist. Does NOT short-circuit
   * on terminal status — destroyed/errored sessions remain visible so
   * customers can inspect post-mortem (driver side-effects are skipped
   * because no driver call is made; this is a pure DB read).
   */
  async describe(
    ctx: AccountContext,
    sessionId: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<SessionRecord> {
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const session = await this.deps.repo.findSession(sessionId, accountId);
    if (!session) throw new NotFoundError(`Session "${sessionId}" not found.`);
    return session;
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
      const errorMessage = safeSessionFailureDiagnostic(
        unknownFailureMessage(err),
        SESSION_FAILURE_MESSAGE_MAX_CHARS,
        'unknown driver failure',
      );
      const errorName = safeSessionFailureDiagnostic(
        err instanceof Error ? err.name : 'UnknownError',
        SESSION_FAILURE_NAME_MAX_CHARS,
        'UnknownError',
      );

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
      // Tear down the LIVE driver/browser session. Marking the row 'errored' +
      // stamping destroyedAt frees the DB cap slot, but the duration sweeper only
      // reaps ACTIVE_SESSION_STATUSES (creating/ready/busy) and destroy() short-
      // circuits 'errored' — so without this the real browser leaks forever
      // (cost-to-serve) on EVERY transient driver error (audit wxzlp9yiz P1).
      // Best-effort, mirroring create()'s orphan guard; the original error wins.
      await this.deps.driver.destroy(session.driverSessionId).catch(() => {});
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

      // 2026-05-20 — publish session.errored to the GUI notification
      // bus. Best-effort: a throwing publisher must NOT mask the
      // original driver error (the customer-visible failure wins).
      // The audit log + webhook stay the durable trail; the bus is
      // an additive, low-latency surface for the panel toast.
      if (this.deps.notifications) {
        try {
          this.deps.notifications.publish({
            kind: 'session.errored',
            accountId: session.accountId,
            sessionId: session.id,
            errorClass: errorName,
            at: erroredAt.toISOString(),
          });
        } catch {
          /* swallow — original error wins */
        }
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

  /**
   * Arc 5 EGRESS eg.7.e — ingest a harness-emitted egress.capability_report.
   * Persists both the derived view + raw payload (repo handles the
   * atomic write) AND fires the session.egress_capability_changed
   * webhook so subscribers see the new capability state without
   * polling.
   *
   * Idempotent at the repo layer (repeat reports overwrite); the
   * webhook event fires on every successful persist. Returns null
   * when the session doesn't exist (harness race).
   *
   * Called from the ownership-gated capabilityReport WebSocket relay.
   * Also exposed for direct service-layer testing + admin tooling.
   * Best-effort webhook emit: a failure logs but doesn't
   * roll back the persist (matches the session.completed pattern).
   */
  async ingestEgressCapabilityReport(args: {
    sessionId: string;
    derived: {
      udp_associate: boolean;
      quic_route: 'proxy' | 'direct' | 'disabled';
      dns_remote_resolve: boolean;
      warnings: string[];
    };
    raw: Record<string, unknown>;
  }): Promise<SessionRecord | null> {
    const updated = await this.deps.repo.setEgressCapabilityReport(args);
    if (updated === null) return null;
    if (this.deps.webhooks) {
      try {
        await this.deps.webhooks.enqueueEvent(
          updated.accountId,
          'session.egress_capability_changed',
          {
            session_id: `ses_${updated.id}`,
            egress_capabilities: args.derived,
          },
        );
      } catch {
        /* webhook enqueue is best-effort — persist already succeeded */
      }
    }
    return updated;
  }
}
