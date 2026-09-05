// Sessions service — orchestrates DB writes and driver calls behind the
// public session API. Decoupled from Drizzle via SessionRepo interface;
// decoupled from the actual WebKit substrate via the Driver interface.
//
// Every method takes an AccountContext and enforces account-scoped ownership
// — a session belongs to exactly one account, and only that account's keys
// can operate on it.
//
// EXCEPT five, each scoped another way rather than left unscoped. Counted
// 2026-08-28: 15 of the 20 methods on this class take the context.
//   - autoDestroyExpired — acts on a SessionRecord the duration sweeper has
//     already fetched.
//   - destroyAllForAccount(accountId) — scoped by its explicit argument;
//     reached only from admin suspend/reclaim.
//   - ingestEgressCapabilityReport — bound one layer out, in
//     session-capability-report-relay.ts: a frame is dropped unless the
//     reporting node IS the session's live owner node, and the id forwarded
//     here comes from the RESOLVED record, never from the frame.
//   - persistPostSuccessObservability — private; its accountId comes from a
//     record the caller already authorized.
//   - findOwnedSessionLite(accountId, sessionId) — scoped by argument, and
//     currently has no callers.
// The blanket wording predates all five, and an audit goes wrong in either
// direction without this note: trusting the sentence above skips five
// methods, while reading only the signatures accuses
// ingestEgressCapabilityReport, whose enforcement is not in this file.

import {
  DEFAULT_BEHAVIORAL_PROFILE,
  DEFAULT_SESSION_PURPOSE,
  defaultArchetypeIdForTier,
  MAX_SESSION_MINUTES_PER_TIER,
  PROFILES_PER_TIER,
  TIER_CONCURRENT_SESSION_LIMITS,
  isSelectableArchetypeId,
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
import {
  DriverLoginResultSchema,
  DriverSearchResultSchema,
  type Driver,
  type LoginResult,
  type SearchResult,
} from '../drivers/types.js';
import type { GUIInputRequest } from '../schemas/gui-input.js';
import {
  BadRequestError,
  ConcurrencyLimitError,
  ConflictError,
  DriverError,
  DriverNotIntegratedError,
  NotFoundError,
  SessionDestroyedError,
} from '../lib/errors.js';
import {
  requireArchetypeForTier,
  requireScope as throwIfMissingScope,
} from '../lib/errors-helpers.js';
import type { EffectiveOwner } from '../lib/effective-account-header.js';
import {
  classifySessionFailure,
  projectSessionEventMetadata,
  projectSessionFailedData,
  sessionFailureCopy,
} from '../lib/session-event-metadata.js';

export const SESSION_DESTROY_DRIVER_TIMEOUT_MS = 30_000;
export const SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS = 5_000;

type PostSuccessPersistenceOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed' }
  | { kind: 'timed_out' };

export async function destroyDriverSessionWithTimeout(
  destroy: () => Promise<void>,
  timeoutMs = SESSION_DESTROY_DRIVER_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Session driver destroy timed out.')), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([destroy(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

export interface SerializedSessionDestroyInput {
  id: string;
  /** Customer/system callers must supply the owner account. Admin force-actions
   *  must opt into the unscoped path explicitly with null. */
  accountId: string | null;
  destroyedAt: Date;
  event: Omit<SessionEventInput, 'sessionId' | 'type'> & { type: 'destroyed' };
}

export type SerializedSessionDestroyResult =
  | { kind: 'destroyed' | 'already_terminal'; session: SessionRecord }
  | { kind: 'driver_error'; session: SessionRecord; error: unknown }
  | { kind: 'not_found' };

export type SessionOperationClaimResult =
  | { kind: 'claimed'; session: SessionRecord }
  | { kind: 'conflict'; status: 'creating' | 'busy' }
  | { kind: 'terminal'; session: SessionRecord }
  | { kind: 'not_found' };

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
   * Atomically activate an exact create reservation after the slow driver
   * dispatch. Returns null when the reservation was removed, terminalized, or
   * replaced while the driver was starting. The real driver id and `ready`
   * status commit together so create can never publish a synthetic ready row.
   */
  activateSessionReservation(input: {
    id: string;
    reservationDriverSessionId: string;
    driverSessionId: string;
  }): Promise<SessionRecord | null>;
  /**
   * Atomically admit one live driver operation for an owned session. Only an
   * exact scoped `ready` row may become `busy`; creating/busy, terminal and
   * missing-or-foreign outcomes stay distinguishable without a read/claim gap.
   */
  claimSessionOperation(id: string, accountId: string): Promise<SessionOperationClaimResult>;
  /** Release the exact live operation slot after authoritative driver success. */
  settleSessionOperation(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
  }): Promise<boolean>;
  /** Elect the exact live operation as the sole terminal failure winner. */
  failSessionOperation(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
    erroredAt: Date;
  }): Promise<SessionRecord | null>;
  /** Persist a state-capture timestamp without changing operation ownership. */
  touchSessionLastStateAt(input: {
    id: string;
    accountId: string;
    driverSessionId: string;
    lastStateAt: Date;
  }): Promise<void>;
  /** Find a session by id, scoped to the supplied account. */
  findSession(id: string, accountId: string): Promise<SessionRecord | null>;
  /** Find a session by id WITHOUT account scoping (admin force-actions only). */
  findSessionUnscoped(id: string): Promise<SessionRecord | null>;
  /**
   * Serialize one terminal transition across processes while the supplied
   * idempotent driver callback runs. The successful status update and event
   * insert commit together; a driver failure commits only the terminal slot
   * release and is returned for the caller to rethrow.
   */
  destroySessionSerialized(
    input: SerializedSessionDestroyInput,
    destroyDriverSession: (session: SessionRecord) => Promise<void>,
  ): Promise<SerializedSessionDestroyResult>;
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
    opts: EffectiveOwner & {
      /** Internal: the route resolved this value from an existing owned profile row. */
      inheritedProfileArchetype?: boolean;
      /**
       * V-732 — the bare profile uuid the ROUTE validated and resolved to an
       * owned profile row. The single-live-session-per-profile guard keys on
       * this.
       *
       * It used to be lifted back out of `body.metadata.profile_id`, which is
       * customer-writable: `metadata` is documented as "an arbitrary JSON object
       * for the customer's own bookkeeping" and its schema is
       * `z.record(z.unknown())`. So a customer who never touched Driftstack
       * profiles but happened to keep their own `profile_id` key in metadata got
       * a hard `409 profile-in-use` on every session create after the first.
       * Round-tripping a control-plane decision through customer-controlled
       * input is the bug; the route already has the trustworthy value.
       */
      profileId?: string;
    } = {},
  ): Promise<SessionRecord> {
    // V-326e1 — when effectiveAccountId is set (route layer resolved
    // X-Driftstack-Account + verified the caller has 'admin' role on
    // the owner's team), the new session is OWNED by the team owner
    // and counts against the OWNER's concurrent cap. Tier-derived
    // limits use the owner's tier (route looks it up).
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const tier = opts.effectiveTier ?? ctx.account.tier;

    const limit = concurrentSessionLimitFor(tier);

    // P-15 (2026-09-05) — the SESSION door judges the device too. An omitted archetype
    // resolves PER TIER (a free account gets an entitled device, not the iPhone 17), and
    // unless the device was inherited from a profile — judged when that profile was
    // minted — it is judged here exactly as POST /v1/profiles judges it: unknown → 400,
    // a device outside the tier's entitlement → 403.
    const archetype = body.archetype ?? defaultArchetypeIdForTier(tier);
    if (!opts.inheritedProfileArchetype && !isSelectableArchetypeId(archetype)) {
      throw new BadRequestError(
        `Archetype "${archetype}" is not selectable. Use GET /v1/archetypes for accepted ids.`,
        { field: 'archetype' },
      );
    }
    if (!opts.inheritedProfileArchetype) requireArchetypeForTier(tier, archetype);
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
    // A3 finding #7 (W2979/W2980) — the atomic reserve ALSO enforces the
    // single-active-session-per-profile guard, under the same per-profile
    // advisory lock. Absent (no profile-backed create) → no guard.
    //
    // V-732 — taken from the ROUTE's validated binding, not from
    // `body.metadata.profile_id`. Metadata is customer-writable free-form
    // bookkeeping, so the old lift let a customer's own unrelated `profile_id`
    // key trigger a 409 profile-in-use on their second session. The route still
    // stamps metadata.profile_id for display; it just no longer decides
    // anything.
    const profileId = opts.profileId;
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
      // release must not mask the original dispatch error — but it is reported.
      // A release that fails leaves the row 'creating' with destroyedAt NULL:
      // no worker is live for the disconnect reaper to notice, and on tiers
      // with no minute cap the duration sweeper never reaps it either. The slot
      // then counts against the account's cap indefinitely, and while the
      // outcome was discarded that was indistinguishable from a clean release.
      const slotReleased = await this.deps.repo
        .updateSessionStatus(reserved.id, 'errored', { destroyedAt: new Date() })
        .then(() => true)
        .catch(() => false);
      if (!slotReleased) {
        try {
          this.deps.logger?.error?.(
            {
              component: 'sessions-service',
              event: 'dispatch_failure_slot_release_failed',
              account_id: accountId,
              session_id: reserved.id,
            },
            'worker dispatch failed and the reserved concurrency slot could not be released — it counts against the account cap until reconciled',
          );
        } catch {
          // Swallow; logging is best-effort and must not mask the dispatch error.
        }
      }
      throw err;
    }

    // Bind the real driver session id onto the reserved row now that the
    // worker is live AND advance it to 'ready' in one exact-reservation CAS.
    //
    // Billing-integrity hardening — this write runs AFTER a successful
    // dispatch. A throw here previously left the row stuck at
    // status='creating', destroyedAt=NULL forever: it keeps counting against
    // countActiveSessions, and on paid tiers (null minute-cap) the duration
    // sweeper never reaps it and the worker is live so the disconnect reaper
    // won't either → a permanently-leaked concurrency slot. Mirror the
    // dispatch-failure release path: on throw, release the reserved slot
    // (mark errored + destroyed), tear down the now-orphaned live worker,
    // LOUD-log, and rethrow the original error.
    let record: SessionRecord;
    try {
      const activated = await this.deps.repo.activateSessionReservation({
        id: reserved.id,
        reservationDriverSessionId: reservationDriverId,
        driverSessionId: driverResult.driverSessionId,
      });
      if (activated === null) {
        // A concurrent destroy/expiry/suspension won while the external driver
        // was starting. The terminal row is authoritative and MUST remain
        // untouched; tear down the now-unclaimed real worker and surface the
        // existing typed terminal response instead of fabricating a ready row.
        try {
          await destroyDriverSessionWithTimeout(() =>
            this.deps.driver.destroy(driverResult.driverSessionId),
          );
        } catch (cleanupError) {
          try {
            this.deps.logger?.error?.(
              {
                component: 'sessions-service',
                event: 'post_dispatch_activation_lost_cleanup_failed',
                account_id: accountId,
                session_id: reserved.id,
                driver_session_id: driverResult.driverSessionId,
                err: cleanupError,
              },
              'session reservation was terminalized during dispatch and real-worker cleanup failed',
            );
          } catch {
            // Swallow; logging is best-effort and the terminal response remains authoritative.
          }
        }
        throw new SessionDestroyedError();
      }
      record = activated;
    } catch (err) {
      if (err instanceof SessionDestroyedError) throw err;
      // Release the reserved slot so it stops counting against the cap.
      // Best-effort; a release failure must not mask the original error. It is
      // still REPORTED: a slot that was not released counts against the cap
      // forever, and discarding the outcome is what made that invisible.
      const slotReleased = await this.deps.repo
        .updateSessionStatus(reserved.id, 'errored', { destroyedAt: new Date() })
        .then(() => true)
        .catch(() => false);
      // Tear down the orphaned live worker (the row is now a tombstone, so
      // nothing else will ever destroy it). Best-effort, reported for the same
      // reason: a worker that survives this is a real browser billing us with
      // nothing left that will ever reap it.
      const workerDestroyed = await destroyDriverSessionWithTimeout(() =>
        this.deps.driver.destroy(driverResult.driverSessionId),
      )
        .then(() => true)
        .catch(() => false);
      try {
        this.deps.logger?.error?.(
          {
            component: 'sessions-service',
            event: 'post_dispatch_bind_failed',
            account_id: accountId,
            session_id: reserved.id,
            driver_session_id: driverResult.driverSessionId,
            slot_released: slotReleased,
            worker_destroyed: workerDestroyed,
            err,
          },
          // The old message asserted both cleanups succeeded, which the code
          // never checked. Reading "released … + tore down …" during an
          // incident rules out the leaked slot and the orphaned browser —
          // precisely the two states most likely to be true at that moment.
          slotReleased && workerDestroyed
            ? 'session post-dispatch DB write failed — released the leaked concurrency slot + tore down the orphaned worker'
            : 'session post-dispatch DB write failed AND cleanup did not fully succeed — see slot_released / worker_destroyed',
        );
      } catch {
        // Swallow; logging is best-effort.
      }
      throw err;
    }

    // The session is already ready and its worker is live. Event/audit writes
    // are detached observability: a rejection OR a non-settling pool/query
    // must not withhold the authoritative create response and invite a second
    // live session on caller retry.
    const createdEvent = projectSessionEventMetadata({
      type: 'created',
      payload: { archetype, purpose, driver_session_id: driverResult.driverSessionId },
      durationMs: null,
    });
    this.persistPostSuccessObservability(record.accountId, record.id, 'create', 'event', () =>
      this.deps.repo.recordEvent({
        sessionId: record.id,
        ...createdEvent,
      }),
    );

    // V-216 — customer-facing audit entry.
    // V-326e1 — audit row goes on the OWNER's audit log (accountId
    // is the owner) but actor stays the member (so the audit reads
    // "Member X created session Y on team owner Z").
    if (this.deps.accountAudit) {
      const accountAudit = this.deps.accountAudit;
      const accountAuditInput = {
        accountId,
        actorType: 'customer' as const,
        actorAccountId: ctx.account.id,
        actorKeyId: ctx.apiKey.id,
        action: 'session.created' as const,
        targetResourceId: `ses_${record.id}`,
        payload: { archetype, purpose },
      };
      this.persistPostSuccessObservability(
        record.accountId,
        record.id,
        'create',
        'account_audit',
        () => accountAudit.record(accountAuditInput),
      );
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
    const { session, result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'navigate',
      (claimed) =>
        this.deps.driver.navigate(claimed.driverSessionId, {
          url: body.url,
          timeoutMs: body.timeout_ms ?? 30_000,
          waitUntil: body.wait_until,
        }),
    );
    const event = projectSessionEventMetadata({
      type: 'navigated',
      payload: { url: body.url, final_url: result.finalUrl, status: result.status },
      durationMs: result.durationMs,
    });
    this.persistPostSuccessObservability(session.accountId, session.id, 'navigate', 'event', () =>
      this.deps.repo.recordEvent({
        sessionId: session.id,
        ...event,
      }),
    );
    return result;
  }

  async interact(
    ctx: AccountContext,
    sessionId: string,
    body: InteractRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ durationMs: number }> {
    const { session, result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'interact',
      (claimed) =>
        this.deps.driver.interact(claimed.driverSessionId, {
          action: body.action,
          timeoutMs: body.timeout_ms ?? 10_000,
        }),
    );
    const event = projectSessionEventMetadata({
      type: 'interacted',
      payload: { action: body.action },
      durationMs: result.durationMs,
    });
    this.persistPostSuccessObservability(session.accountId, session.id, 'interact', 'event', () =>
      this.deps.repo.recordEvent({ sessionId: session.id, ...event }),
    );
    return result;
  }

  async guiInput(
    ctx: AccountContext,
    sessionId: string,
    body: GUIInputRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ durationMs: number }> {
    const { session, result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'gui_input',
      (claimed) =>
        this.deps.driver.guiInput(claimed.driverSessionId, {
          action: body.action,
          timeoutMs: body.timeout_ms ?? 10_000,
        }),
    );
    const event = projectSessionEventMetadata({
      type: 'gui_input',
      payload: { action: body.action },
      durationMs: result.durationMs,
    });
    this.persistPostSuccessObservability(session.accountId, session.id, 'gui_input', 'event', () =>
      this.deps.repo.recordEvent({ sessionId: session.id, ...event }),
    );
    return result;
  }

  async wait(
    ctx: AccountContext,
    sessionId: string,
    body: WaitRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ satisfied: boolean; durationMs: number }> {
    const { session, result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'wait',
      (claimed) =>
        this.deps.driver.wait(claimed.driverSessionId, {
          condition: body.condition,
          timeoutMs: body.timeout_ms ?? 30_000,
        }),
    );
    const event = projectSessionEventMetadata({
      type: 'waited',
      payload: { condition: body.condition, satisfied: result.satisfied },
      durationMs: result.durationMs,
    });
    this.persistPostSuccessObservability(session.accountId, session.id, 'wait', 'event', () =>
      this.deps.repo.recordEvent({ sessionId: session.id, ...event }),
    );
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
    const { session, result: state } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'state_capture',
      (claimed) => this.deps.driver.getState(claimed.driverSessionId),
    );
    const capturedAt = state.capturedAt;
    this.persistPostSuccessObservability(
      session.accountId,
      session.id,
      'state_capture',
      'status',
      () =>
        this.deps.repo.touchSessionLastStateAt({
          id: session.id,
          accountId: session.accountId,
          driverSessionId: session.driverSessionId,
          lastStateAt: capturedAt,
        }),
    );
    const event = projectSessionEventMetadata({
      type: 'state_captured',
      payload: { url: state.url, title: state.title },
      durationMs: null,
    });
    this.persistPostSuccessObservability(
      session.accountId,
      session.id,
      'state_capture',
      'event',
      () => this.deps.repo.recordEvent({ sessionId: session.id, ...event }),
    );
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
    const { session, result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'capture',
      (claimed) =>
        this.deps.driver.capture(claimed.driverSessionId, {
          kind: body.kind,
          fullPage: body.full_page,
        }),
    );
    const event = projectSessionEventMetadata({
      type:
        body.kind === 'screenshot' || body.kind === 'pdf'
          ? 'screenshot_captured'
          : 'state_captured',
      payload: { kind: body.kind, byte_size: result.byteSize },
      durationMs: result.durationMs,
    });
    this.persistPostSuccessObservability(session.accountId, session.id, 'capture', 'event', () =>
      this.deps.repo.recordEvent({ sessionId: session.id, ...event }),
    );
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
    const { result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'extract',
      (claimed) =>
        this.deps.driver.extract(claimed.driverSessionId, { extractions: body.extractions }),
    );
    return result;
  }

  /** Find the search field, type the query realistically, submit (harness
   *  `search` intent, A3). A driver write-op; no session event recorded. */
  async search(
    ctx: AccountContext,
    sessionId: string,
    body: SearchRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<SearchResult> {
    if (this.deps.driver.searchCapability !== 'real') {
      throw new DriverNotIntegratedError();
    }
    const { result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'search',
      async (claimed) => {
        const rawResult = await this.deps.driver.search(claimed.driverSessionId, {
          query: body.query,
          ...(body.search_selector !== undefined ? { searchSelector: body.search_selector } : {}),
          submit: body.submit,
          ...(body.wait_for_results_selector !== undefined
            ? { waitForResultsSelector: body.wait_for_results_selector }
            : {}),
          ...(body.timeout_seconds !== undefined ? { timeoutSeconds: body.timeout_seconds } : {}),
        });
        const parsed = DriverSearchResultSchema.safeParse(rawResult);
        if (!parsed.success) {
          throw new DriverError('The browser driver returned an invalid search result.');
        }
        if (
          !parsed.data.queryTruncated &&
          (parsed.data.submitted !== body.submit ||
            (parsed.data.resultsVisible !== undefined) !==
              (body.wait_for_results_selector !== undefined))
        ) {
          throw new DriverError('The browser driver returned an invalid search result.');
        }
        return parsed.data;
      },
    );
    return result;
  }

  /** Heuristic credential login (harness `login` intent, A3). A driver
   *  write-op; no session event recorded. The password flows to the driver but
   *  is never logged (failure capture records only the operation label). */
  async login(
    ctx: AccountContext,
    sessionId: string,
    body: SessionLoginRequest,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<LoginResult> {
    // Direct login must never turn the deterministic mock (or an unavailable
    // local adapter) into a customer-visible synthetic credential submission.
    // Check before ownership lookup/operation claim so an inactive capability
    // has zero row, driver, event, or timing side effects. A future
    // authenticated FleetDriver must opt in explicitly with `real`.
    if (this.deps.driver.loginCapability !== 'real') {
      throw new DriverNotIntegratedError();
    }
    const { result } = await this.runWithFailureCapture(
      ctx,
      sessionId,
      opts,
      'login',
      async (claimed) => {
        const rawResult = await this.deps.driver.login(claimed.driverSessionId, {
          username: body.username,
          password: body.password,
          ...(body.username_selector !== undefined
            ? { usernameSelector: body.username_selector }
            : {}),
          ...(body.password_selector !== undefined
            ? { passwordSelector: body.password_selector }
            : {}),
          ...(body.submit_selector !== undefined ? { submitSelector: body.submit_selector } : {}),
          ...(body.success_selector !== undefined
            ? { successSelector: body.success_selector }
            : {}),
          ...(body.timeout_seconds !== undefined ? { timeoutSeconds: body.timeout_seconds } : {}),
        });
        const parsed = DriverLoginResultSchema.safeParse(rawResult);
        if (!parsed.success) {
          // Never reflect schema diagnostics: a hostile remote result could put
          // sensitive values in unknown fields. Classify the breach as a driver
          // failure so the exact claimed browser is terminalized and reaped.
          throw new DriverError('The browser driver returned an invalid login result.');
        }
        return parsed.data;
      },
    );
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
    // claim. The serialized repo primitive now owns lookup, terminal check,
    // driver teardown, terminal transition, and event insertion under one
    // per-session lock, so every concurrent destroy source shares one winner.
    // V-326e2 — when effectiveAccountId is set, the destroy targets
    // a session owned by the team OWNER. Route layer enforces
    // 'admin' role per Q1 before reaching here.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const destroyedAt = new Date();
    const destroyEvent = projectSessionEventMetadata({
      type: 'destroyed',
      payload: { reason_code: 'customer_request' },
      durationMs: null,
    });
    const outcome = await this.deps.repo.destroySessionSerialized(
      {
        id: sessionId,
        accountId,
        destroyedAt,
        event: destroyEvent,
      },
      (current) =>
        destroyDriverSessionWithTimeout(() => this.deps.driver.destroy(current.driverSessionId)),
    );
    if (outcome.kind === 'not_found') {
      throw new NotFoundError(`Session "${sessionId}" not found.`);
    }
    if (outcome.kind === 'already_terminal') return;
    if (outcome.kind === 'driver_error') throw outcome.error;

    const session = outcome.session;
    if (session.destroyedAt === null) {
      throw new Error('destroySessionSerialized returned destroyed without destroyedAt');
    }

    // Emit session.completed webhook event (best-effort; failures here
    // never affect destroy correctness).
    // V-326e2 — webhook fan-out goes to the OWNER (so the owner's
    // configured webhooks receive the completion event).
    const durationMs = session.destroyedAt.getTime() - session.createdAt.getTime();
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
   * event payload carries a closed duration-limit reason code + the cap
   * so the audit trail explains the closure without retaining free text.
   * Webhook + audit are best-effort — a failure there never blocks the
   * slot-freeing destroy.
   */
  async autoDestroyExpired(
    session: SessionRecord,
    opts: { maxMinutes: number },
  ): Promise<{ destroyed: boolean }> {
    const reason = 'auto-destroyed: free-tier session duration cap';
    const destroyedAt = new Date();
    const destroyEvent = projectSessionEventMetadata({
      type: 'destroyed',
      payload: {
        reason_code: 'duration_limit',
        auto_destroyed: true,
        max_session_minutes: opts.maxMinutes,
      },
      durationMs: null,
    });
    const outcome = await this.deps.repo.destroySessionSerialized(
      {
        id: session.id,
        accountId: session.accountId,
        destroyedAt,
        event: destroyEvent,
      },
      (current) =>
        destroyDriverSessionWithTimeout(() => this.deps.driver.destroy(current.driverSessionId)),
    );
    if (outcome.kind === 'not_found' || outcome.kind === 'already_terminal') {
      return { destroyed: false };
    }
    if (outcome.kind === 'driver_error') {
      // V-782 — the row is ALREADY terminal here. `destroySessionSerialized` commits
      // `status='destroyed'` and only then reports the driver failure, and
      // `listExpiredForAutoDestroy` filters on ACTIVE_SESSION_STATUSES
      // (creating|ready|busy), so a destroyed row is never returned again. The sweeper's
      // "will retry next tick" was therefore false: this is the LAST time anything looks at
      // this session.
      //
      // So the audit entry has to be written here rather than after the rethrow, or the one
      // auto-destroy that failed is the one with no record of having happened — precisely the
      // case an operator would go looking for. Flagged `driver_teardown_failed` so it is
      // distinguishable from a clean auto-destroy.
      //
      // Deliberately NOT emitting `session.completed`: a session whose teardown failed did not
      // complete, and that omission is pinned (sessions-failure.test.ts,
      // db-session-destroy-concurrency-drizzle.test.ts).
      if (this.deps.accountAudit) {
        try {
          await this.deps.accountAudit.record({
            accountId: outcome.session.accountId,
            actorType: 'system',
            action: 'session.destroyed',
            targetResourceId: `ses_${outcome.session.id}`,
            payload: { auto_destroyed: true, reason, driver_teardown_failed: true },
          });
        } catch {
          /* swallow — best-effort, exactly as on the success path below */
        }
      }
      throw outcome.error;
    }

    const destroyedSession = outcome.session;
    if (destroyedSession.destroyedAt === null) {
      throw new Error('destroySessionSerialized returned destroyed without destroyedAt');
    }
    const durationMs =
      destroyedSession.destroyedAt.getTime() - destroyedSession.createdAt.getTime();
    if (this.deps.webhooks) {
      try {
        await this.deps.webhooks.enqueueEvent(destroyedSession.accountId, 'session.completed', {
          session_id: `ses_${destroyedSession.id}`,
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
          accountId: destroyedSession.accountId,
          actorType: 'system',
          action: 'session.destroyed',
          targetResourceId: `ses_${destroyedSession.id}`,
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
    const destroyEvent = projectSessionEventMetadata({
      type: 'destroyed',
      payload: { reason_code: 'account_suspended', auto_destroyed: true },
      durationMs: null,
    });
    let destroyed = 0;
    for (const session of active) {
      try {
        const destroyedAt = new Date();
        const outcome = await this.deps.repo.destroySessionSerialized(
          {
            id: session.id,
            accountId,
            destroyedAt,
            event: destroyEvent,
          },
          (current) =>
            destroyDriverSessionWithTimeout(() =>
              this.deps.driver.destroy(current.driverSessionId),
            ),
        );
        if (
          outcome.kind === 'not_found' ||
          outcome.kind === 'already_terminal' ||
          outcome.kind === 'driver_error'
        ) {
          continue;
        }

        const destroyedSession = outcome.session;
        if (destroyedSession.destroyedAt === null) {
          throw new Error('destroySessionSerialized returned destroyed without destroyedAt');
        }
        destroyed += 1;
        const durationMs =
          destroyedSession.destroyedAt.getTime() - destroyedSession.createdAt.getTime();
        if (this.deps.webhooks) {
          try {
            await this.deps.webhooks.enqueueEvent(accountId, 'session.completed', {
              session_id: `ses_${destroyedSession.id}`,
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
              targetResourceId: `ses_${destroyedSession.id}`,
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
   * "does this account own this session" without claiming a direct driver
   * operation. Returns the row when
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

  /**
   * Once a driver call succeeds, its external browser outcome is authoritative.
   * Event/last-state/account-audit writes happen afterwards and are observability
   * only; awaiting their rejection or non-settlement would invite callers to
   * replay work that already happened. Start each write once, detach it from the
   * response, and monitor it with a bounded watchdog plus one fixed diagnostic.
   * Serialized destroy intentionally does not use this helper because its
   * terminal row and event share one atomic transaction.
   */
  private persistPostSuccessObservability(
    accountId: string,
    sessionId: string,
    operation: string,
    persistence: 'event' | 'status' | 'account_audit',
    persist: () => Promise<unknown>,
  ): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutOutcome = new Promise<PostSuccessPersistenceOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'timed_out' }),
        SESSION_POST_SUCCESS_PERSISTENCE_TIMEOUT_MS,
      );
      timer.unref();
    });
    let writeOutcome: Promise<PostSuccessPersistenceOutcome>;
    try {
      // Invoke synchronously so admission is ordered before the successful API
      // response becomes observable. Settlement remains deliberately detached.
      writeOutcome = Promise.resolve(persist()).then(
        () => ({ kind: 'succeeded' }),
        () => ({ kind: 'failed' }),
      );
    } catch {
      writeOutcome = Promise.resolve({ kind: 'failed' });
    }

    void Promise.race([writeOutcome, timeoutOutcome])
      .then((outcome) => {
        if (outcome.kind === 'succeeded') return;

        // A timeout says only that the outcome is unknown: the database
        // promise is not cancellable and may still commit later. Resolve both
        // promise branches so a late rejection is consumed and cannot create
        // a second diagnostic or an unhandled rejection.
        const timedOut = outcome.kind === 'timed_out';
        try {
          this.deps.logger?.error?.(
            {
              component: 'sessions-service',
              event: timedOut
                ? 'post_success_persistence_timed_out'
                : 'post_success_persistence_failed',
              account_id: accountId,
              session_id: sessionId,
              operation,
              persistence,
              error_name: timedOut
                ? 'PostSuccessPersistenceTimeout'
                : 'PostSuccessPersistenceError',
            },
            timedOut
              ? 'session post-success observability write timed out with unknown outcome; preserving authoritative driver success'
              : 'session post-success observability write failed; preserving authoritative driver success',
          );
        } catch {
          // Logging is best-effort; never turn committed browser work into an ambiguous failure.
        }
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      })
      .catch(() => {
        // The detached monitor itself is best-effort. Hostile runtime values or
        // instrumentation hooks must not become an unhandled rejection.
      });
  }

  /**
   * Claim exactly one direct driver operation, then settle only that claimed
   * busy slot. Repository failures live outside the driver catch so an
   * infrastructure failure is never reclassified as a browser failure. A
   * concurrent destroy/failure winner makes either settlement CAS lose; that
   * stale tail returns 410 and publishes no success/failure observability.
   */
  private async runWithFailureCapture<T>(
    ctx: AccountContext,
    sessionId: string,
    opts: { effectiveAccountId?: string },
    operation: string,
    fn: (session: SessionRecord) => Promise<T>,
  ): Promise<{ session: SessionRecord; result: T }> {
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const claim = await this.deps.repo.claimSessionOperation(sessionId, accountId);
    if (claim.kind === 'not_found') {
      throw new NotFoundError(`Session "${sessionId}" not found.`);
    }
    if (claim.kind === 'terminal') throw new SessionDestroyedError();
    if (claim.kind === 'conflict') {
      throw new ConflictError(
        `Session is ${claim.status}; direct driver operations require ready status.`,
        { session_status: claim.status },
      );
    }

    const session = claim.session;
    let result: T;
    try {
      result = await fn(session);
    } catch (err) {
      const erroredAt = new Date();
      const failureClass = classifySessionFailure(err);
      const failureCopy = sessionFailureCopy(failureClass);
      const errorEvent = projectSessionEventMetadata({
        type: 'errored',
        payload: { operation, failure_class: failureClass },
        durationMs: null,
      });

      // Elect the exact claimed busy row before ANY teardown or fan-out. A
      // close winner returns null; an infrastructure rejection propagates as
      // itself instead of being swallowed/misclassified as a driver failure.
      const failed = await this.deps.repo.failSessionOperation({
        id: session.id,
        accountId: session.accountId,
        driverSessionId: session.driverSessionId,
        erroredAt,
      });
      if (failed === null) throw new SessionDestroyedError();

      // Tear down the LIVE driver/browser session. Marking the row 'errored' +
      // stamping destroyedAt frees the DB cap slot, but the duration sweeper only
      // reaps ACTIVE_SESSION_STATUSES (creating/ready/busy) and destroy() short-
      // circuits 'errored' — so without this the real browser leaks forever
      // (cost-to-serve) on EVERY transient driver error (audit wxzlp9yiz P1).
      // Best-effort, mirroring create()'s orphan guard; the original error wins.
      // The outcome is captured rather than discarded: this teardown is the ONLY
      // thing that ever reaps the browser on this path, so a failure here is the
      // permanent leak the comment above describes — and discarding the result
      // made that leak indistinguishable from the healthy case in every signal
      // we have.
      const workerDestroyed = await destroyDriverSessionWithTimeout(() =>
        this.deps.driver.destroy(session.driverSessionId),
      )
        .then(() => true)
        .catch(() => false);
      if (!workerDestroyed) {
        try {
          this.deps.logger?.error?.(
            {
              component: 'sessions-service',
              event: 'errored_session_worker_teardown_failed',
              account_id: session.accountId,
              session_id: session.id,
              driver_session_id: session.driverSessionId,
              operation,
            },
            'session operation errored and the live worker could not be torn down — the browser is unreaped and nothing else will ever destroy it',
          );
        } catch {
          // Swallow; logging is best-effort and must not mask the driver error.
        }
      }
      try {
        await this.deps.repo.recordEvent({
          sessionId: session.id,
          ...errorEvent,
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
            errorClass: failureCopy.error_name,
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
        const failedData = projectSessionFailedData({
          session_id: `ses_${session.id}`,
          duration_ms: durationMs,
          operation,
          failure_class: failureClass,
        });
        try {
          await this.deps.webhooks.enqueueEvent(session.accountId, 'session.failed', failedData);
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
            errorMessage: failureCopy.error_message,
          });
        } catch {
          /* swallow — original error wins */
        }
      }

      throw err;
    }

    const settled = await this.deps.repo.settleSessionOperation({
      id: session.id,
      accountId: session.accountId,
      driverSessionId: session.driverSessionId,
    });
    if (!settled) throw new SessionDestroyedError();
    return { session: { ...session, status: 'ready' }, result };
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
