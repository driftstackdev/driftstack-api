// Webhooks service — manages subscriptions and the event-emission /
// delivery-row-enqueue paths. The actual HTTP delivery happens in the
// WebhookDeliveryWorker (apps/server/src/services/webhook-worker.ts).
//
// All methods take an AccountContext and enforce account-scoped ownership.
// `enqueueEvent` is called from inside other services (sessions, api-keys,
// usage) when an event-worthy thing happens; it fans out one delivery row
// per subscribed endpoint.

import { randomUUID } from 'node:crypto';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import { generateWebhookSecret, webhookSecretPrefix } from '../lib/webhook-signing.js';
import { projectSessionFailedData } from '../lib/session-event-metadata.js';
import type { AccountContext } from './auth.js';
import type { AccountAuditService } from './account-audit.js';

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type WebhookEventType =
  | 'session.completed'
  | 'session.failed'
  | 'api_key.revoked'
  // V-356 — synthetic event sent only via POST /v1/webhooks/:id/test.
  // Customers cannot subscribe to it (Zod schemas reject it) — the
  // test endpoint dispatches regardless of subscription.
  | 'test.ping'
  // Arc 5 EGRESS eg.7 — fires when the harness emits an
  // egress.capability_report event for a SOCKS5 session and the
  // control plane ingests it. Migration 0055 ALTERs the pgEnum.
  | 'session.egress_capability_changed'
  // 2026-05-22 — V-666 crypto-order events (migration 0064).
  // Fired by CryptoOrdersService.applyIpnStatus on the
  // pending/confirming/partial → paid|failed terminal transitions.
  | 'crypto.order.paid'
  | 'crypto.order.failed'
  // W393 — challenge-handling. Fired when the harness ChallengeDetector flags a
  // bot-check + the control plane relays it to the customer (session.challenge_
  // detected webhook + transcript SSE). Migration 0070 ALTERs the pgEnum.
  | 'session.challenge_detected'
  // W1364 / 2026-06-12 — profile save-back failed at session teardown; the
  // control plane relays the harness profileSaveFailed frame so customers
  // relying on persisted profile state know not to trust the next restore.
  // Terminal (no retry path); the session itself stays succeeded. Migration
  // 0073 ALTERs the pgEnum.
  | 'session.profile_save_failed';

export type WebhookDeliveryStatus = 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dlq';

export interface WebhookEndpointRow {
  id: string;
  accountId: string;
  url: string;
  /** Plaintext only in the in-process repository result; encrypted at rest. */
  secret: string;
  secretPrefix: string;
  /** V-359 — previous signing secret during the rotation grace
   *  period. Null when no rotation in flight or grace expired. The
   *  worker dual-signs every outbound delivery with both `secret`
   *  and `secretPrev` while `secretPrevExpiresAt > now`. */
  secretPrev: string | null;
  secretPrevExpiresAt: Date | null;
  /** v2-#10 — when the active secret was minted. Drives the 90d
   *  rotation reminder banner + email. Reset on every rotate. */
  secretCreatedAt: Date;
  /** v2-#10 — dedupe for the daily reminder job. Null = never sent. */
  lastReminderSentAt: Date | null;
  /** Arc 3 sub-slice 28.1 (v2-#28) — 7-day server-initiated grace
   *  deadline. Distinct from secretPrevExpiresAt (V-359 24h customer-
   *  initiated). Null when no server-side force-rotation in flight. */
  graceWindowEndsAt: Date | null;
  /** Arc 3 sub-slice 28.1 (v2-#28) — stamped when the 91-day auto-
   *  rotation fired. Used by the sweep to skip already-rotated rows.
   *  Reset to null on the next customer-initiated rotation. */
  forceRotatedAt: Date | null;
  events: WebhookEventType[];
  description: string | null;
  active: boolean;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastResponseStatus: number | null;
  lastResponseExcerpt: string | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWebhookEndpointInput {
  accountId: string;
  url: string;
  secret: string;
  secretPrefix: string;
  events: WebhookEventType[];
  description: string | null;
}

export interface NewWebhookDeliveryInput {
  webhookId: string;
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  /** Optional: when first attempt should run. Default = now. */
  nextAttemptAt?: Date;
}

export interface ListDeliveriesPage {
  items: WebhookDeliveryRow[];
  nextCursor: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Repo interface
// ───────────────────────────────────────────────────────────────────────────

/** V-185 — aggregate counts per endpoint. delivered + failed + dlq. */
export interface EndpointDeliveryCounts {
  delivered: number;
  failed: number;
  dlq: number;
}

export interface WebhooksRepo {
  // Management
  insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow>;
  /**
   * Atomic insert-if-under-cap: insert the endpoint only if the account has
   * fewer than `limit` endpoints that are not deleted — PAUSED ONES COUNT
   * (webhooks audit #4) — else return null. The count + insert happen under a
   * per-account advisory xact lock so concurrent creates can't all pass a
   * stale count and exceed the cap (the count-then-insert TOCTOU).
   * Mirrors SessionsRepo.insertSessionIfUnderLimit /
   * AgentSessionsRepo.createIfUnderActiveCap.
   */
  insertEndpointIfUnderLimit(
    input: NewWebhookEndpointInput,
    limit: number,
  ): Promise<WebhookEndpointRow | null>;
  listEndpoints(accountId: string): Promise<WebhookEndpointRow[]>;
  findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null>;
  countActiveEndpoints(accountId: string): Promise<number>;
  /** Soft-delete: set disabled_at + active=false. */
  disableEndpoint(id: string, at: Date): Promise<void>;
  /**
   * V-351 — patch endpoint fields. Pass `undefined` for any field
   * to leave it unchanged. Returns the updated row, or null when
   * the row was not found / owned by a different account. Cannot
   * be used to RE-enable a disabled endpoint (disabledAt is sticky;
   * disabled rows are tombstones for audit purposes — customer
   * mints a fresh endpoint instead).
   */
  updateEndpoint(input: {
    id: string;
    accountId: string;
    url?: string;
    events?: WebhookEventType[];
    description?: string | null;
    active?: boolean;
  }): Promise<WebhookEndpointRow | null>;

  /**
   * Webhooks audit #4 — `updateEndpoint` for a patch that may RESUME a paused
   * endpoint. Under the same per-account advisory lock as
   * `insertEndpointIfUnderLimit`, a paused → active transition is refused
   * (`overLimit: true`, nothing written) when the account's OTHER endpoints
   * that are not deleted already number `limit` or more. Any other patch
   * applies exactly as `updateEndpoint` does; `row: null` means not found /
   * not owned / deleted.
   */
  updateEndpointIfUnderLimit(
    input: {
      id: string;
      accountId: string;
      url?: string;
      events?: WebhookEventType[];
      description?: string | null;
      active?: boolean;
    },
    limit: number,
  ): Promise<{ row: WebhookEndpointRow | null; overLimit: boolean }>;

  /**
   * V-359 — rotate the signing secret. Sets `secret = newSecret`,
   * `secret_prefix = newPrefix`, and the grace slot:
   *   - no live grace window → `secret_prev = oldSecret`,
   *     `secret_prev_expires_at = graceExpiresAt`;
   *   - a live CUSTOMER grace window (webhooks audit #7) → `secret_prev` and
   *     its expiry are KEPT: the rotation replaces only the current secret;
   *   - a live server FORCE-rotation window → `secret_prev` (the secret the
   *     customer runs) is kept with a fresh `graceExpiresAt`.
   * Returns the updated row, or null when the endpoint isn't found / not owned
   * by the account / deleted. Caller is responsible for the admin-scope gate.
   */
  rotateSecret(input: {
    id: string;
    accountId: string;
    newSecret: string;
    newPrefix: string;
    graceExpiresAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null>;

  /**
   * v2-#29 — null out `secret_prev` + `secret_prev_expires_at` on every
   * row whose grace window has elapsed. v2-#20's worker fix already
   * stops emitting the prev signature past expiry, so this is purely a
   * data-hygiene sweep: a leaked DB snapshot should not retain even the
   * expired ciphertext envelope past its useful lifetime. Returns
   * the count of rows cleared for telemetry.
   */
  clearStaleSecretPrev(args: { now: Date }): Promise<{ cleared: number }>;

  /**
   * Arc 3 sub-slice 28.2 (v2-#28) — find endpoints whose active secret
   * has crossed the 91-day age threshold AND haven't been force-rotated
   * already this cycle. The caller (WebhookSecretForceRotationService)
   * iterates the result + calls forceRotate per row. limit bounds the
   * per-tick burst for telemetry / blast-radius.
   */
  findEndpointsNeedingForceRotation(args: {
    now: Date;
    thresholdDays: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>>;

  /**
   * Arc 3 sub-slice 28.2 (v2-#28) — server-initiated force rotation.
   * Identical to rotateSecret except: writes secret_prev /
   * secret_prev_expires_at AS WELL AS the new grace_window_ends_at +
   * force_rotated_at fields. Returns the row + the fresh plaintext
   * secret. The reminder email (sub-slice 28.4) is the only mechanism
   * the customer learns the new value.
   */
  forceRotateSecret(args: {
    id: string;
    newSecret: string;
    newPrefix: string;
    graceWindowEndsAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null>;

  /**
   * V-185 — aggregate per-endpoint delivery counts (delivered, failed,
   * dlq) for an account. One GROUP BY query in Drizzle; iterates the
   * in-memory map in tests. Returns a Map keyed by endpoint id (uuid,
   * NOT prefixed). Endpoints with zero deliveries return zeros.
   */
  deliveryCountsByEndpoint(accountId: string): Promise<Map<string, EndpointDeliveryCounts>>;

  // Event emission. Returns the inserted delivery row's id (the same id the
  // deliveries-list + replay routes key off — `wdl_<id>`), so a test-event
  // caller can hand back a delivery_id that actually resolves.
  enqueueDelivery(input: NewWebhookDeliveryInput): Promise<string>;
  /**
   * Webhooks audit #5 — one event's fan-out as ONE multi-row insert: every row
   * is written or none is. Returns the inserted ids in input order.
   */
  enqueueDeliveries(inputs: readonly NewWebhookDeliveryInput[]): Promise<string[]>;
  /**
   * Every endpoint of the account subscribed to `eventType` that is not
   * DELETED — paused ones included, so an event raised during a pause is
   * queued and held for the endpoint (webhooks audit #3).
   */
  listEndpointsSubscribedTo(
    accountId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookEndpointRow[]>;

  // Worker
  /**
   * Atomic claim using SELECT...FOR UPDATE SKIP LOCKED. Never claims a PAUSED
   * endpoint's deliveries (webhooks audit #3).
   */
  claim(opts: { batchSize: number; now: Date }): Promise<WebhookDeliveryRow[]>;
  /** Look up an endpoint by id without account-scope (worker-only). */
  findEndpointById(id: string): Promise<WebhookEndpointRow | null>;
  /**
   * Webhooks audit #3 — put an in_flight delivery back to `pending` without
   * spending an attempt or touching the endpoint: its endpoint was paused
   * between the claim and the delivery. Fenced on in_flight.
   */
  recordDeferred(deliveryId: string): Promise<void>;
  recordDelivered(deliveryId: string, opts: { responseStatus: number; at: Date }): Promise<void>;
  recordRetry(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt: string | null;
      lastError: string | null;
      attempts: number;
      nextAttemptAt: Date;
    },
  ): Promise<void>;
  /**
   * `responseExcerpt` is the FINAL attempt's body (webhooks audit #8); omitted
   * or null, the row's excerpt is cleared rather than left holding an earlier
   * attempt's.
   */
  recordDlq(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt?: string | null;
      lastError: string | null;
      at: Date;
    },
  ): Promise<void>;

  listDeliveriesForEndpoint(
    endpointId: string,
    accountId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage>;

  // Admin / operational tooling
  /** Look up a delivery by id WITHOUT account-scope. Admin-only callers. */
  findDeliveryById(deliveryId: string): Promise<WebhookDeliveryRow | null>;
  /**
   * List dlq deliveries across all accounts, paginated by createdAt DESC.
   *
   * V-512 — optional `endpointId` drills into one webhook endpoint's
   * DLQ rows (uuid; the route layer strips the `webhook_endpoint_`
   * prefix before forwarding). When unset, returns rows across every
   * account.
   */
  listDlqDeliveries(opts: {
    limit: number;
    cursor?: string;
    endpointId?: string;
  }): Promise<ListDeliveriesPage>;
  /** Total count of deliveries currently in DLQ across all accounts. */
  countDlqDeliveries(): Promise<number>;
  /**
   * Reset a delivery to status='pending' so the worker picks it up.
   * Resets attempts to 0 and nextAttemptAt to `at`. Returns the updated
   * row, or null if the delivery doesn't exist.
   */
  resetDeliveryToPending(deliveryId: string, at: Date): Promise<WebhookDeliveryRow | null>;
  /**
   * 2026-05-22 — hard-delete a delivery row. Only meaningful from the
   * admin DLQ surface (irrecoverable; the payload is gone). Returns
   * true if a row was deleted, false if no row matched (already
   * discarded by a concurrent operator, or wrong id). Implementations
   * MUST refuse to delete rows whose status !== 'dlq' (callers should
   * use requeue / replay for active deliveries).
   */
  deleteDelivery(deliveryId: string): Promise<boolean>;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

const MAX_ENDPOINTS_PER_ACCOUNT = 10;

export interface CreateWebhookInput {
  url: string;
  events: WebhookEventType[];
  description: string | null;
}

export interface CreatedWebhookEndpoint {
  row: WebhookEndpointRow;
  /** Plaintext signing secret. Returned ONCE; never retrievable later. */
  plaintextSecret: string;
}

export class WebhooksService {
  constructor(
    private readonly repo: WebhooksRepo,
    /**
     * V-225 — optional customer-facing audit log. When wired, emits
     * webhook_endpoint.created / webhook_endpoint.deleted entries.
     * Best-effort; failures never break the CRUD path.
     */
    private readonly accountAudit: AccountAuditService | null = null,
  ) {}

  /**
   * V-735 — `accountId` is the account the row BELONGS to (the owner under a
   * team-scoped write); `ctx` supplies only the ACTOR. It used to hardcode
   * `accountId: ctx.account.id`, so a team admin's change to the OWNER's webhook
   * endpoint — create, update, delete, or SECRET ROTATION — landed in the
   * member's own audit log and left no trace in the owner's. The owner could not
   * see changes to their own webhook configuration, which is the one place that
   * record has to exist.
   *
   * `replayDeliveryAsCustomer` already had the right shape (row on the effective
   * account, actor on the caller); this helper is now consistent with it.
   */
  private async emitAuditBestEffort(
    ctx: AccountContext,
    accountId: string,
    action:
      | 'webhook_endpoint.created'
      | 'webhook_endpoint.updated'
      | 'webhook_endpoint.deleted'
      | 'webhook_endpoint.secret_rotated',
    targetResourceId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.accountAudit === null) return;
    try {
      await this.accountAudit.record({
        accountId,
        actorType: 'customer',
        actorAccountId: ctx.account.id,
        actorKeyId: ctx.apiKey.id,
        action,
        targetResourceId,
        payload,
      });
    } catch {
      /* best-effort — audit failures don't break the CRUD path */
    }
  }

  async create(
    ctx: AccountContext,
    input: CreateWebhookInput,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<CreatedWebhookEndpoint> {
    // V-174 — webhook management is account_owner-level (web sessions carry
    // account_owner; the legacy admin alias satisfies it). ALWAYS checked, also on a
    // team-scoped request: the route's team-admin gate decides WHOSE endpoints the
    // caller may manage, the key's scope decides WHETHER it may manage endpoints at
    // all. Webhooks audit #1 (2026-09-24): skipping it on act-as let a team admin's
    // `read:sessions` key create an endpoint on the owner — plaintext secret and the
    // owner's event stream — and rotate or delete the owner's (every write below
    // shares this rule, as ApiKeysService does).
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;

    const url = parseHttpsUrl(input.url);
    if (input.events.length === 0) {
      throw new ConflictError('events must contain at least one event type.');
    }

    const plaintextSecret = generateWebhookSecret();
    const secretPrefix = webhookSecretPrefix(plaintextSecret);

    // Atomic count-then-insert under a per-account advisory lock — closes the
    // count-then-insert TOCTOU (concurrent creates all passing a stale count
    // and exceeding the cap). Null → already at/over the limit.
    const row = await this.repo.insertEndpointIfUnderLimit(
      {
        accountId,
        url,
        secret: plaintextSecret,
        secretPrefix,
        events: input.events,
        description: input.description,
      },
      MAX_ENDPOINTS_PER_ACCOUNT,
    );
    if (row === null) {
      throw new ConflictError(
        `This account already has ${MAX_ENDPOINTS_PER_ACCOUNT.toString()} webhook endpoints, the most it can have. ` +
          'Paused endpoints count toward the limit; delete one to add another.',
      );
    }

    await this.emitAuditBestEffort(
      ctx,
      accountId,
      'webhook_endpoint.created',
      `webhook_endpoint_${row.id}`,
      {
        url: url.toString(),
        events: input.events,
      },
    );

    return { row, plaintextSecret };
  }

  async list(ctx: AccountContext): Promise<WebhookEndpointRow[]> {
    // V-553.B-21 — declared `async` (not a plain function returning a
    // Promise) so the scope check's throw becomes a rejected Promise
    // rather than a synchronous exception raised while the caller is
    // still constructing the call expression — matches every other
    // scope-gated method on this service (create/get/update/delete/…).
    throwIfMissingScope(ctx, 'read:webhooks');
    return this.repo.listEndpoints(ctx.account.id);
  }

  /**
   * V-185 — list endpoints + per-endpoint aggregate delivery counts
   * (delivered / failed / dlq). Customer dashboard /webhooks page
   * consumes this via /v1/webhooks; no separate endpoint needed.
   */
  /**
   * V-1603 — one endpoint plus its delivery counts.
   *
   * `GET /v1/webhooks/{id}` and `PATCH /v1/webhooks/{id}` publish
   * `delivery_counts` in the same schema the list route does, and both returned
   * the zero default of `publicEndpoint` because neither passed a counts
   * argument. A customer reading the list saw real numbers and the same endpoint
   * opened on its own reported nothing delivered, nothing failed and nothing in
   * the DLQ.
   *
   * Scoped exactly as `listWithCounts` is: the scope gate first, then the
   * effective-account redirection, so a team member reading an owner's endpoint
   * gets the owner's counts rather than their own empty map.
   */
  async getWithCounts(
    ctx: AccountContext,
    id: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ endpoint: WebhookEndpointRow; counts: EndpointDeliveryCounts }> {
    const endpoint = await this.get(ctx, id, opts);
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const countsMap = await this.repo.deliveryCountsByEndpoint(accountId);
    return {
      endpoint,
      counts: countsMap.get(endpoint.id) ?? { delivered: 0, failed: 0, dlq: 0 },
    };
  }

  async listWithCounts(
    ctx: AccountContext,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<Array<{ endpoint: WebhookEndpointRow; counts: EndpointDeliveryCounts }>> {
    // V-553.B-21 — read:webhooks (or a satisfying broad scope) gate.
    // Independent of the effectiveAccountId team redirection below —
    // team-scoping decides WHICH account's rows come back, not
    // whether this key may read webhooks at all.
    throwIfMissingScope(ctx, 'read:webhooks');
    // V-330f — when effectiveAccountId is set, lists the OWNER's
    // endpoints. Read-only; both 'member' and 'admin' roles allowed.
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const [endpoints, countsMap] = await Promise.all([
      this.repo.listEndpoints(accountId),
      this.repo.deliveryCountsByEndpoint(accountId),
    ]);
    return endpoints.map((endpoint) => ({
      endpoint,
      counts: countsMap.get(endpoint.id) ?? { delivered: 0, failed: 0, dlq: 0 },
    }));
  }

  async get(
    ctx: AccountContext,
    id: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<WebhookEndpointRow> {
    throwIfMissingScope(ctx, 'read:webhooks');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const row = await this.repo.findEndpoint(id, accountId);
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    return row;
  }

  /**
   * V-351 — partial-update an existing endpoint. Mirror of create()
   * for the V-326e5 admin-only-on-team gate; trusts the route layer
   * when effectiveAccountId is set. Cannot re-enable a soft-deleted
   * endpoint (the repo enforces this — disabledAt is sticky).
   */
  async update(
    ctx: AccountContext,
    id: string,
    input: {
      url?: string;
      events?: WebhookEventType[];
      description?: string | null;
      active?: boolean;
    },
    opts: { effectiveAccountId?: string } = {},
  ): Promise<WebhookEndpointRow> {
    // V-174 + webhooks audit #1 — account_owner always, act-as or not. See create().
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const before = await this.repo.findEndpoint(id, accountId);
    if (!before) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    if (before.disabledAt !== null) {
      throw new ConflictError('Cannot update a disabled endpoint. Mint a fresh one instead.');
    }
    if (input.events !== undefined && input.events.length === 0) {
      throw new ConflictError('events must contain at least one event type.');
    }
    const url = input.url !== undefined ? parseHttpsUrl(input.url) : undefined;
    const repoInput: {
      id: string;
      accountId: string;
      url?: string;
      events?: WebhookEventType[];
      description?: string | null;
      active?: boolean;
    } = { id, accountId };
    if (url !== undefined) repoInput.url = url;
    if (input.events !== undefined) repoInput.events = input.events;
    if (input.description !== undefined) repoInput.description = input.description;
    if (input.active !== undefined) repoInput.active = input.active;
    // Webhooks audit #4 — resuming is a cap decision. A paused endpoint still
    // counts toward the cap, so within it a resume always fits; this refuses
    // only an account already past the cap (one that paused its way there
    // before paused endpoints counted). The repo reads the row's state under the
    // create lock, so only a real paused → active transition is checked.
    let updated: WebhookEndpointRow | null;
    if (input.active === true) {
      const result = await this.repo.updateEndpointIfUnderLimit(
        repoInput,
        MAX_ENDPOINTS_PER_ACCOUNT,
      );
      if (result.overLimit) {
        throw new ConflictError(
          `This account already has ${MAX_ENDPOINTS_PER_ACCOUNT.toString()} other webhook endpoints, the most it can have, so this one stays paused. ` +
            'Paused endpoints count toward the limit; delete one to resume this one.',
        );
      }
      updated = result.row;
    } else {
      updated = await this.repo.updateEndpoint(repoInput);
    }
    if (!updated) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);

    await this.emitAuditBestEffort(
      ctx,
      accountId,
      'webhook_endpoint.updated',
      `webhook_endpoint_${id}`,
      {
        url: url ? url.toString() : before.url,
        events: input.events ?? before.events,
        description: input.description ?? before.description,
        active: input.active ?? before.active,
      },
    );

    return updated;
  }

  /**
   * V-359 — rotate the signing secret with a 24h grace. Returns the
   * fresh plaintext secret ONCE alongside the updated row. Worker
   * dual-signs every outbound delivery with both `secret` and
   * `secretPrev` while `secretPrevExpiresAt > now`, so the customer
   * can roll the new secret across their verifier infra without a
   * window of dropped deliveries.
   *
   * Same gate as create / update / delete: `account_owner` scope
   * when self-account (V-174); route-side team-admin gate when
   * targeting a team owner via `effectiveAccountId`.
   *
   * A second rotation while a prior rotation's grace window is still live
   * (webhooks audit #7) replaces only the CURRENT secret: the original secret
   * stays in the grace slot with its original expiry, so the customer's live
   * verifier keeps working, and a customer who lost the new secret can get
   * another. It used to be refused with 409 — a status the docs gave only for
   * a deleted endpoint — for up to 24 hours.
   */
  async rotateSecret(
    ctx: AccountContext,
    id: string,
    opts: { effectiveAccountId?: string; graceMs?: number } = {},
  ): Promise<{ row: WebhookEndpointRow; plaintextSecret: string }> {
    // V-174 + webhooks audit #1 — account_owner always, act-as or not. See create().
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const before = await this.repo.findEndpoint(id, accountId);
    if (!before) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    if (before.disabledAt !== null) {
      throw new ConflictError('Cannot rotate the secret on a disabled endpoint.');
    }

    const newSecret = generateWebhookSecret();
    const newPrefix = webhookSecretPrefix(newSecret);
    const now = new Date();
    const graceMs = opts.graceMs ?? 24 * 60 * 60 * 1000; // 24h default
    const graceExpiresAt = new Date(now.getTime() + graceMs);

    const row = await this.repo.rotateSecret({
      id,
      accountId,
      newSecret,
      newPrefix,
      graceExpiresAt,
      now,
    });
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);

    // Never hand back a secret that was not persisted: a plaintext nothing
    // verifies against would break the customer's verifier with no error. The
    // rotation UPDATE is unconditional on a live endpoint now, so this cannot
    // happen short of a repo defect — which is why it is a 500, not a 409.
    if (row.secret !== newSecret) {
      throw new Error('webhook secret rotation returned a row without the new secret');
    }

    await this.emitAuditBestEffort(
      ctx,
      accountId,
      'webhook_endpoint.secret_rotated',
      `webhook_endpoint_${id}`,
      {
        new_secret_prefix: newPrefix,
        old_secret_prefix: before.secretPrefix,
        // The window the row actually carries: a second rotation inside a live
        // grace window keeps the original expiry rather than opening a new one.
        grace_expires_at: (row.secretPrevExpiresAt ?? graceExpiresAt).toISOString(),
      },
    );

    return { row, plaintextSecret: newSecret };
  }

  async delete(
    ctx: AccountContext,
    id: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<void> {
    // V-174 + webhooks audit #1 — account_owner always; the team-admin gate
    // (route) only decides whose endpoint. See create().
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const row = await this.disableLiveEndpoint(id, accountId);
    if (row === null) return; // idempotent — no audit emit on no-op
    await this.emitAuditBestEffort(
      ctx,
      accountId,
      'webhook_endpoint.deleted',
      `webhook_endpoint_${id}`,
      {
        url: row.url,
      },
    );
  }

  /** Disable one endpoint of the account; null when it already was (a no-op). */
  private async disableLiveEndpoint(
    id: string,
    accountId: string,
  ): Promise<WebhookEndpointRow | null> {
    const row = await this.repo.findEndpoint(id, accountId);
    if (!row) throw new NotFoundError(`Webhook endpoint "${id}" not found.`);
    if (row.disabledAt !== null) return null;
    await this.repo.disableEndpoint(id, new Date());
    return row;
  }

  /**
   * GDPR Article 17 — bulk-disable every non-disabled webhook endpoint
   * for the account. Backs AccountsAdminService.deleteAccount(); shares
   * delete()'s disable step, skipping delete()'s account_owner check — the
   * caller here is always the admin account-deletion flow, which has checked
   * driftstack_internal_admin just below.
   *
   * Recorded on the account's log as `staff`, naming no key: this is a staff
   * termination, and it used to go through delete() and be written as a
   * `customer` deletion carrying the staff member's ids.
   */
  async deleteAllForAccount(ctx: AccountContext, accountId: string): Promise<number> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const endpoints = await this.repo.listEndpoints(accountId);
    let n = 0;
    for (const endpoint of endpoints) {
      if (endpoint.disabledAt !== null) continue;
      const row = await this.disableLiveEndpoint(endpoint.id, accountId);
      if (row !== null && this.accountAudit !== null) {
        try {
          await this.accountAudit.record({
            accountId,
            actorType: 'staff',
            actorAccountId: ctx.account.id,
            actorKeyId: null,
            action: 'webhook_endpoint.deleted',
            targetResourceId: `webhook_endpoint_${endpoint.id}`,
            payload: { url: row.url },
          });
        } catch {
          /* best-effort — audit failures don't break the reclaim */
        }
      }
      n++;
    }
    return n;
  }

  async listDeliveries(
    ctx: AccountContext,
    endpointId: string,
    opts: {
      limit: number;
      cursor?: string;
      status?: WebhookDeliveryStatus;
      effectiveAccountId?: string;
    },
  ): Promise<ListDeliveriesPage> {
    // Reading delivery history (event payloads + endpoint response excerpts) is a
    // read:webhooks operation — gate it like list()/get()/listWithCounts() so a
    // narrowly-scoped key can't page delivery data it wasn't granted (audit
    // 2026-07-02; the sibling reads all enforce this, this one was the oversight).
    throwIfMissingScope(ctx, 'read:webhooks');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    // A sub-resource listing must not imply that its parent exists. Without
    // this check the route answered 200 with an empty page for an endpoint
    // that does not exist — indistinguishable from a real endpoint that has
    // never fired, so a customer debugging a mistyped id was shown "no
    // deliveries" instead of "no such webhook". It also contradicted the 404
    // the route's own contract documents. `get()` above resolves the same id
    // and throws; this read was the one that did not.
    const endpoint = await this.repo.findEndpoint(endpointId, accountId);
    if (!endpoint) throw new NotFoundError(`Webhook endpoint "${endpointId}" not found.`);
    return this.repo.listDeliveriesForEndpoint(endpointId, accountId, opts);
  }

  /**
   * V-307 — customer self-service replay. Looks up the delivery, then
   * the owning endpoint (must belong to the effective account — the
   * caller's own, or the team owner's when acting-as), then resets
   * the delivery to pending so the worker re-fires it. Audit emitted
   * via accountAudit.
   *
   * Differs from the admin replayDelivery (line ~351) in that:
   *   - account_owner scope (not admin)
   *   - account-scoped lookup (404s if delivery or endpoint isn't owned)
   *   - emits webhook_delivery.replayed customer audit (not admin audit).
   */
  async replayDeliveryAsCustomer(
    ctx: AccountContext,
    deliveryId: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<WebhookDeliveryRow> {
    // S32 2026-07-07 (frontend audit) — replay was the ONLY delivery surface that
    // ignored team act-as: the dashboard sends x-driftstack-account and
    // listDeliveries honours it, but replay scoped the ownership lookup
    // to the member's own account, so every replay of a team-visible
    // delivery 404'd. Mirrors create()/listDeliveries(): the ownership lookup
    // uses the effective account, and the key must still carry account_owner
    // (webhooks audit #1 — the team role says whose delivery, not what the key
    // may do).
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const delivery = await this.repo.findDeliveryById(deliveryId);
    if (!delivery) {
      throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    }
    // Account-scope check: the owning endpoint must belong to the
    // effective account (the owner in act-as mode).
    const endpoint = await this.repo.findEndpoint(delivery.webhookId, accountId);
    if (!endpoint) {
      throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    }
    // Webhooks audit #9 — the reset is fenced OUT of in_flight (resetting a row
    // a worker holds would send it twice), and that fenced miss used to surface
    // as 404 "not found" for a delivery the customer can see in their own list.
    // It is theirs and it exists: say it is being attempted. Checked again after
    // the reset, because a worker can claim it in between.
    if (delivery.status === 'in_flight') throw inFlightReplayConflict(deliveryId);
    const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
    if (!updated) {
      const current = await this.repo.findDeliveryById(deliveryId);
      if (current?.status === 'in_flight') throw inFlightReplayConflict(deliveryId);
      throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    }

    // V-216 — record customer audit entry. Best-effort.
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          accountId,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'webhook_delivery.replayed',
          targetResourceId: `wdl_${deliveryId}`,
          payload: {
            endpoint_id: `whk_${delivery.webhookId}`,
            event_type: delivery.eventType,
          },
        });
      } catch {
        /* swallow */
      }
    }
    return updated;
  }

  /**
   * V-356 — enqueue a one-off `test.ping` delivery to a single
   * endpoint, regardless of subscription. Used by POST
   * /v1/webhooks/:id/test so the customer can confirm their handler
   * is reachable + signature-verifies before relying on it for real
   * events.
   *
   * Disabled endpoints (active=false OR disabled_at!=null) are
   * rejected with a BadRequestError — testing against an endpoint
   * that's been auto-paused for failures would just look broken.
   */
  async sendTestEvent(
    ctx: AccountContext,
    endpointId: string,
    opts: { effectiveAccountId?: string } = {},
  ): Promise<{ deliveryId: string; eventId: string }> {
    // account_owner scope (plus the route's team-admin gate on act-as) — same
    // posture as create/update (V-174), since "send test event" can be used to
    // fish for endpoint-state.
    // V-174 + webhooks audit #1 — account_owner always, act-as or not. See create().
    throwIfMissingScope(ctx, 'account_owner');
    const accountId = opts.effectiveAccountId ?? ctx.account.id;
    const row = await this.repo.findEndpoint(endpointId, accountId);
    if (!row) {
      throw new NotFoundError(`Webhook endpoint "${endpointId}" not found.`);
    }
    if (!row.active || row.disabledAt !== null) {
      throw new BadRequestError(
        'This endpoint is paused. Re-enable it before sending a test event.',
      );
    }

    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const payload = {
      id: eventId,
      type: 'test.ping' as WebhookEventType,
      created_at: createdAt,
      data: {
        message: 'Test event from the Driftstack dashboard.',
        endpoint_id: `whk_${endpointId}`,
        triggered_by_account_id: `acc_${ctx.account.id}`,
      },
    };

    // The REAL delivery row id (DB-generated PK), not the eventId — so the
    // returned delivery_id resolves in the deliveries list + replay routes
    // (which key off `wdl_${row.id}`). The eventId is a separate column.
    const deliveryId = await this.repo.enqueueDelivery({
      webhookId: endpointId,
      eventId,
      eventType: 'test.ping',
      payload,
    });

    // Best-effort audit emit so the customer's audit log shows the
    // operator who fired the test event. Reuse the
    // webhook_delivery.replayed action — the semantics are the same
    // (operator-triggered delivery on an existing endpoint).
    if (this.accountAudit) {
      try {
        await this.accountAudit.record({
          // V-735 — the row belongs to the OWNER under a team-scoped write; only
          // the actor is the caller. This synthetic delivery fires against the
          // owner's endpoint, so the owner's log is where it has to appear.
          accountId,
          actorType: 'customer',
          actorAccountId: ctx.account.id,
          actorKeyId: ctx.apiKey.id,
          action: 'webhook_delivery.replayed',
          targetResourceId: `webhook_endpoint_${endpointId}`,
          payload: {
            endpoint_id: `whk_${endpointId}`,
            event_type: 'test.ping',
            via: 'send_test_event',
          },
        });
      } catch {
        /* swallow */
      }
    }

    return { deliveryId, eventId };
  }

  /**
   * Fan out a single event into per-endpoint delivery rows. Returns the
   * number of deliveries enqueued (zero if no endpoint subscribes to the
   * event type — useful for caller-side logging).
   *
   * A PAUSED endpoint gets its row too (webhooks audit #3): the claim holds it
   * until the endpoint is resumed. Only a deleted endpoint is skipped.
   *
   * Webhooks audit #5 — all rows go in ONE multi-row insert, so the event
   * reaches every subscribed endpoint or none; it was one insert per endpoint,
   * and a failure part-way delivered the event to some endpoints only. A
   * failure propagates: callers catch it (the state change it reports has
   * already happened) and log it with `logLostWebhookEvent`.
   */
  async enqueueEvent(
    accountId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<number> {
    const endpoints = await this.repo.listEndpointsSubscribedTo(accountId, eventType);
    // Defence in depth: the repo already leaves deleted endpoints out.
    const live = endpoints.filter((ep) => ep.disabledAt === null);
    if (live.length === 0) return 0;

    const { eventId, payload } = webhookEventPayload(eventType, data);
    const ids = await this.repo.enqueueDeliveries(
      live.map((ep) => ({ webhookId: ep.id, eventId, eventType, payload })),
    );
    return ids.length;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Admin / operational tooling service. Admin-only callers; bypasses
// account-scoping (an admin can replay any account's delivery and list
// the cross-account DLQ). Audit logging is the route's responsibility.
// ───────────────────────────────────────────────────────────────────────────

export class WebhooksAdminService {
  constructor(private readonly repo: WebhooksRepo) {}

  async getDelivery(ctx: AccountContext, deliveryId: string): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const row = await this.repo.findDeliveryById(deliveryId);
    if (!row) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    return row;
  }

  /**
   * Replay any delivery (regardless of current status) — sets it back
   * to 'pending' with attempts=0 and nextAttemptAt=now. Used for
   * /webhook-deliveries/:id/replay.
   */
  async replayDelivery(ctx: AccountContext, deliveryId: string): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
    if (!updated) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    return updated;
  }

  /**
   * Requeue a DLQ delivery. Same DB op as replayDelivery, but rejects
   * if the target isn't currently in DLQ — the audit-log distinction
   * matters even though the underlying mutation is identical.
   */
  async requeueFromDlq(ctx: AccountContext, deliveryId: string): Promise<WebhookDeliveryRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const current = await this.repo.findDeliveryById(deliveryId);
    if (!current) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    if (current.status !== 'dlq') {
      throw new ConflictError(
        `Webhook delivery "${deliveryId}" is not in DLQ (status=${current.status}). Use /webhook-deliveries/:id/replay to re-fire deliveries that aren't in DLQ.`,
      );
    }
    const updated = await this.repo.resetDeliveryToPending(deliveryId, new Date());
    // NOT guaranteed non-null, despite the row having been found above. The reset
    // is status-fenced (`status != 'in_flight'`), and a DLQ row can be hard-deleted
    // by `discardFromDlq` in the same window — either leaves `updated` null. So this
    // is a live race guard rather than a type-narrowing formality, and deleting it
    // would return null where the signature promises a row. Covered by the
    // "discarded between the DLQ check and the reset" arm in webhooks-admin-service.
    if (!updated)
      throw new NotFoundError(`Webhook delivery "${deliveryId}" disappeared mid-requeue.`);
    return updated;
  }

  /**
   * 2026-05-22 — hard-delete a DLQ row. The payload is unrecoverable
   * after this; the admin-panel UI MUST confirm with the operator
   * before invoking. Restricted to status='dlq' rows so an operator
   * can't accidentally nuke an in-flight delivery. Returns the
   * deleted row's id (useful for the audit log entry).
   */
  async discardFromDlq(ctx: AccountContext, deliveryId: string): Promise<{ discarded_id: string }> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const current = await this.repo.findDeliveryById(deliveryId);
    if (!current) throw new NotFoundError(`Webhook delivery "${deliveryId}" not found.`);
    if (current.status !== 'dlq') {
      throw new ConflictError(
        `Webhook delivery "${deliveryId}" is not in DLQ (status=${current.status}). Only DLQ rows can be discarded.`,
      );
    }
    const ok = await this.repo.deleteDelivery(deliveryId);
    if (!ok) throw new NotFoundError(`Webhook delivery "${deliveryId}" disappeared mid-discard.`);
    return { discarded_id: deliveryId };
  }

  listDlq(
    ctx: AccountContext,
    opts: { limit: number; cursor?: string; endpointId?: string },
  ): Promise<ListDeliveriesPage> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.listDlqDeliveries(opts);
  }

  countDlq(ctx: AccountContext): Promise<number> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.countDlqDeliveries();
  }
}

// ───────────────────────────────────────────────────────────────────────────

/**
 * The envelope every delivery of one event carries: `{ id, type, created_at,
 * data }`, with `session.failed` closed to its published fields. Shared by
 * `enqueueEvent` and the in-transaction writer (`enqueueWebhookEventInTransaction`
 * in db/webhooks-repo.ts), so an event queued either way looks the same to the
 * customer.
 */
export function webhookEventPayload(
  eventType: WebhookEventType,
  data: Record<string, unknown>,
): { eventId: string; payload: Record<string, unknown> } {
  const closedData = eventType === 'session.failed' ? projectSessionFailedData(data) : data;
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  return {
    eventId,
    payload: { id: eventId, type: eventType, created_at: createdAt, data: closedData },
  };
}

function inFlightReplayConflict(deliveryId: string): ConflictError {
  return new ConflictError(
    `Webhook delivery "wdl_${deliveryId}" is being attempted right now, so it cannot be replayed yet. ` +
      'Check its status again in a few minutes: if it is not delivered by then, replay it.',
  );
}

/**
 * Webhooks audit #5 — the one log line for an event that could not be queued.
 *
 * Every `enqueueEvent` caller treats the webhook as best-effort: the state
 * change it reports has already committed, and failing the customer's request
 * (or an IPN ack) over it would be worse. But the catches swallowed the failure
 * silently, so an event lost to a connection reset — `crypto.order.paid`, whose
 * provider retry "does not fire the event again" — left no trace at all. Error
 * level, because no endpoint will ever receive that event.
 *
 * Never throws: it runs inside the caller's catch.
 */
export function logLostWebhookEvent(
  logger: { error?: (obj: Record<string, unknown>, msg: string) => void } | null | undefined,
  args: {
    component: string;
    accountId: string;
    eventType: WebhookEventType;
    err: unknown;
    context?: Record<string, unknown>;
  },
): void {
  try {
    logger?.error?.(
      {
        component: args.component,
        event: 'webhook_event_not_queued',
        event_type: args.eventType,
        account_id: args.accountId,
        ...args.context,
        err: args.err,
      },
      `${args.eventType} webhook could not be queued — no endpoint will receive this event`,
    );
  } catch {
    // A throwing logger must not turn a lost webhook into a failed request.
  }
}

function parseHttpsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConflictError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new ConflictError('Webhook URL must use https:// — http:// is rejected for security.');
  }
  return url.toString();
}
