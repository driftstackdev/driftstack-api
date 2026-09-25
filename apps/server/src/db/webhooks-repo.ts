// Drizzle-backed implementation of WebhooksRepo.

import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { WebhookEventTypeSchema } from '@driftstack/api-types';
import {
  decodeDeliveryCursor,
  encodeDeliveryCursor,
  type DeliveryCursor,
} from '../lib/keyset-cursor.js';
import {
  convertWebhookSecretToV2,
  encryptWebhookSecret,
  readWebhookSecret,
  WEBHOOK_SECRET_V2_PREFIX,
  type WebhookSecretEncryptionContext,
} from '../lib/webhook-secret-encryption.js';
import type {
  EndpointDeliveryCounts,
  ListDeliveriesPage,
  NewWebhookDeliveryInput,
  NewWebhookEndpointInput,
  WebhookDeliveryRow,
  WebhookDeliveryStatus,
  WebhookEndpointRow,
  WebhookEventType,
  WebhooksRepo,
} from '../services/webhooks.js';
import { webhookEventPayload } from '../services/webhooks.js';
import type { Database } from './client.js';
import { accounts, webhookDeliveries, webhookEndpoints } from './schema.js';
import { verifyBootEncryptionKey } from '../lib/boot-key-verification.js';

// V-173.R — an in_flight row whose `updated_at` is older than this has no
// live worker on it (the claimer crashed/deployed mid-delivery); the claim
// reclaims it. 5 min ≫ the 10s per-attempt delivery timeout, so a slow (not
// crashed) delivery is never reclaimed out from under an active worker.
// V-1269 — exported so the in-memory double can reclaim on the SAME window. The double had no
// reclaim at all: it filtered `status === 'pending'`, so a delivery left `in_flight` by a crashed
// worker was stuck forever there while production re-claims it after this window. A test could
// assert "a stuck delivery is never retried" against the double and be wrong about production.
export const RECLAIM_STALE_IN_FLIGHT_MS = 5 * 60 * 1000;
const MAX_WEBHOOK_SECRET_MIGRATION_BATCH = 500;
const WEBHOOK_SECRET_V2_STORAGE_PATTERN = `^${WEBHOOK_SECRET_V2_PREFIX}[A-Za-z0-9+/]{88}$`;

const HISTORICAL_SILENT_WEBHOOK_EVENTS = new Set(['quota.warning_80pct', 'quota.exceeded']);

/**
 * The per-account advisory-lock key every endpoint-cap decision takes — the
 * create and the resume must serialise against EACH OTHER, so they share it.
 */
function endpointCapLockKey(accountId: string): string {
  return `webhook-endpoint-create:${accountId}`;
}

type EndpointPatch = Parameters<WebhooksRepo['updateEndpoint']>[0];

/** The SET clause of an endpoint patch: only the fields the caller supplied. */
function endpointPatchSet(input: EndpointPatch): Record<string, unknown> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.url !== undefined) set.url = input.url;
  if (input.events !== undefined) set.events = input.events;
  if (input.description !== undefined) set.description = input.description;
  if (input.active !== undefined) set.active = input.active;
  return set;
}

function webhookSecretsAreV2(): SQL {
  return sql`(
    ${webhookEndpoints.secret} ~ ${WEBHOOK_SECRET_V2_STORAGE_PATTERN}
    AND (${webhookEndpoints.secretPrev} IS NULL OR ${webhookEndpoints.secretPrev} ~ ${WEBHOOK_SECRET_V2_STORAGE_PATTERN})
  )`;
}

function webhookSecretsAreNotV2(): SQL {
  return sql`NOT (${webhookSecretsAreV2()})`;
}

/**
 * The PostgreSQL enum retains two never-emitted quota values for migration
 * compatibility. They are not part of the current customer contract and must
 * be removed whenever a persisted endpoint is materialized. Any other unknown
 * value fails closed through the canonical schema instead of being cast.
 */
export function sanitizePersistedWebhookEvents(events: readonly string[]): WebhookEventType[] {
  return events
    .filter((event) => !HISTORICAL_SILENT_WEBHOOK_EVENTS.has(event))
    .map((event) => WebhookEventTypeSchema.parse(event));
}

/**
 * Composite (created_at DESC, id DESC) keyset predicate for the delivery
 * listings (#125). Returns undefined for the first page. For a legacy
 * created_at-only cursor (id null) it keeps the old strict-less-than on
 * created_at; for a full cursor it uses `created_at < T OR (created_at = T AND
 * id < lastId)` so no row sharing the boundary millisecond is skipped.
 */
function deliveryKeysetCondition(cursor: DeliveryCursor | null): ReturnType<typeof or> | undefined {
  if (cursor === null) return undefined;
  if (cursor.id === null) return lt(webhookDeliveries.createdAt, cursor.createdAt);
  return or(
    lt(webhookDeliveries.createdAt, cursor.createdAt),
    and(eq(webhookDeliveries.createdAt, cursor.createdAt), lt(webhookDeliveries.id, cursor.id)),
  );
}

/** A transaction another repository holds open. */
export type WebhookOutboxTx = Parameters<Parameters<Database['db']['transaction']>[0]>[0];

/**
 * Queue one event for every subscribed endpoint of the account INSIDE a caller's
 * transaction, so the delivery rows commit with the state change that raised
 * the event, or not at all (webhooks audit #5).
 *
 * The case it exists for: the IPN handler used to commit a crypto order as
 * `paid` and queue `crypto.order.paid` in a separate step, swallowing a failure.
 * The provider's retry finds the order already paid and does not fire the event
 * again, so a connection reset between the two lost it for good.
 *
 * Deliberately needs no signing-secret key: it reads endpoint ids, never the
 * endpoint rows `DrizzleWebhooksRepo` decrypts, so a repository without the key
 * can call it. Same selection as `listEndpointsSubscribedTo` (not deleted —
 * paused ones included — and subscribed), same envelope as `enqueueEvent`, one
 * multi-row INSERT. Returns how many deliveries were queued.
 */
export async function enqueueWebhookEventInTransaction(
  tx: WebhookOutboxTx,
  event: { accountId: string; eventType: WebhookEventType; data: Record<string, unknown> },
): Promise<number> {
  const endpoints = await tx
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.accountId, event.accountId),
        isNull(webhookEndpoints.disabledAt),
        sql`${webhookEndpoints.events} @> ARRAY[${event.eventType}]::webhook_event_type[]`,
      ),
    )
    .orderBy(asc(webhookEndpoints.id));
  if (endpoints.length === 0) return 0;
  const { eventId, payload } = webhookEventPayload(event.eventType, event.data);
  const rows = await tx
    .insert(webhookDeliveries)
    .values(
      endpoints.map((endpoint) => ({
        webhookId: endpoint.id,
        eventId,
        eventType: event.eventType,
        payload,
      })),
    )
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}

export class DrizzleWebhooksRepo implements WebhooksRepo {
  private readonly secretEncryptionKeyBase64: string | undefined;

  /**
   * Reports a row whose stored secret could not be decrypted during a
   * cross-account sweep. The sweep skips that row and continues; without this
   * the skip would be silent, which is the other way to lose a reminder.
   */
  private readonly onUndecryptableSecret?: (info: {
    endpointId: string;
    accountId: string;
    error: unknown;
  }) => void;

  constructor(
    private readonly database: Database,
    options: {
      secretEncryptionKeyBase64?: string;
      onUndecryptableSecret?: (info: {
        endpointId: string;
        accountId: string;
        error: unknown;
      }) => void;
    } = {},
  ) {
    this.secretEncryptionKeyBase64 = options.secretEncryptionKeyBase64;
    this.onUndecryptableSecret = options.onUndecryptableSecret;
  }

  private requireEncryptionKey(): string {
    if (this.secretEncryptionKeyBase64 === undefined) {
      throw new Error('Webhook secret encryption key is unavailable.');
    }
    return this.secretEncryptionKeyBase64;
  }

  private encryptForStorage(plaintext: string, context: WebhookSecretEncryptionContext): string {
    return encryptWebhookSecret(plaintext, this.requireEncryptionKey(), context);
  }

  /**
   * Bootstrap-only no-DDL bridge to record-bound v2. It authenticates a v2
   * successor probe, prevalidates the complete page before its first write,
   * and exact-CASes both old secret slots without moving endpoint metadata.
   */
  async encryptLegacySecrets(
    limit = MAX_WEBHOOK_SECRET_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WEBHOOK_SECRET_MIGRATION_BATCH) {
      throw new Error(
        `Webhook secret migration limit must be an integer from 1 to ` +
          `${MAX_WEBHOOK_SECRET_MIGRATION_BATCH.toString()}.`,
      );
    }
    const encryptionKey = this.requireEncryptionKey();

    const [v2Probe] = await this.database.db
      .select({
        id: webhookEndpoints.id,
        accountId: webhookEndpoints.accountId,
        secret: webhookEndpoints.secret,
        secretPrev: webhookEndpoints.secretPrev,
      })
      .from(webhookEndpoints)
      .where(webhookSecretsAreV2())
      .orderBy(asc(webhookEndpoints.id))
      .limit(1);
    if (v2Probe !== undefined) {
      const context = { accountId: v2Probe.accountId, endpointId: v2Probe.id };
      verifyBootEncryptionKey('Webhook signing secrets', 'MFA_ENCRYPTION_KEY', () => {
        readWebhookSecret(v2Probe.secret, encryptionKey, context);
        if (v2Probe.secretPrev !== null) {
          readWebhookSecret(v2Probe.secretPrev, encryptionKey, context);
        }
      });
    }

    const rows = await this.database.db
      .select({
        id: webhookEndpoints.id,
        accountId: webhookEndpoints.accountId,
        secret: webhookEndpoints.secret,
        secretPrev: webhookEndpoints.secretPrev,
      })
      .from(webhookEndpoints)
      .where(webhookSecretsAreNotV2())
      .orderBy(asc(webhookEndpoints.id))
      .limit(limit);

    const prepared = rows.map((row) => {
      const context = { accountId: row.accountId, endpointId: row.id };
      return {
        row,
        secret: convertWebhookSecretToV2(row.secret, encryptionKey, context),
        secretPrev:
          row.secretPrev === null
            ? null
            : convertWebhookSecretToV2(row.secretPrev, encryptionKey, context),
      };
    });

    let converted = 0;
    for (const { row, secret, secretPrev } of prepared) {
      const updated = await this.database.db
        .update(webhookEndpoints)
        .set({ secret, secretPrev })
        .where(
          and(
            eq(webhookEndpoints.id, row.id),
            eq(webhookEndpoints.accountId, row.accountId),
            eq(webhookEndpoints.secret, row.secret),
            sql`${webhookEndpoints.secretPrev} IS NOT DISTINCT FROM ${row.secretPrev}`,
          ),
        )
        .returning({ id: webhookEndpoints.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(webhookEndpoints)
      .where(webhookSecretsAreNotV2());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

  async insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow> {
    const endpointId = randomUUID();
    const [row] = await this.database.db
      .insert(webhookEndpoints)
      .values({
        id: endpointId,
        accountId: input.accountId,
        url: input.url,
        secret: this.encryptForStorage(input.secret, {
          accountId: input.accountId,
          endpointId,
        }),
        secretPrefix: input.secretPrefix,
        events: input.events,
        description: input.description,
      })
      .returning();
    if (!row) throw new Error('insertEndpoint returned no row');
    return toEndpointRow(row, this.secretEncryptionKeyBase64);
  }

  // Atomic "insert only if under the endpoint cap" — closes the
  // count-then-insert TOCTOU in WebhooksService.create (a bare
  // countActiveEndpoints + insertEndpoint lets N concurrent creates all pass a
  // stale count and exceed the cap). A per-account advisory lock (xact-scoped →
  // auto-released on commit/rollback) serialises concurrent creates for the
  // SAME account so the count + insert are atomic; different accounts hash to
  // different lock keys (no cross-account contention). Returns null when already
  // at/over the limit. Mirrors SessionsRepo.insertSessionIfUnderLimit.
  //
  // Webhooks audit #4 (2026-09-24) — the count is every endpoint that is not
  // DELETED (`disabled_at IS NULL`), paused ones included. It counted
  // `active = true`, so pause one, create one, resume the first — repeated —
  // took an account to 20 endpoints under a cap of 10. Resuming is re-checked
  // under the same lock by updateEndpointIfUnderLimit.
  async insertEndpointIfUnderLimit(
    input: NewWebhookEndpointInput,
    limit: number,
  ): Promise<WebhookEndpointRow | null> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${endpointCapLockKey(input.accountId)}))`,
      );
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(webhookEndpoints)
        .where(
          and(eq(webhookEndpoints.accountId, input.accountId), isNull(webhookEndpoints.disabledAt)),
        );
      if ((countRow?.count ?? 0) >= limit) return null;
      const endpointId = randomUUID();
      const [row] = await tx
        .insert(webhookEndpoints)
        .values({
          id: endpointId,
          accountId: input.accountId,
          url: input.url,
          secret: this.encryptForStorage(input.secret, {
            accountId: input.accountId,
            endpointId,
          }),
          secretPrefix: input.secretPrefix,
          events: input.events,
          description: input.description,
        })
        .returning();
      if (!row) throw new Error('insertEndpointIfUnderLimit returned no row');
      return toEndpointRow(row, this.secretEncryptionKeyBase64);
    });
  }

  async listEndpoints(accountId: string): Promise<WebhookEndpointRow[]> {
    const rows = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.accountId, accountId))
      .orderBy(desc(webhookEndpoints.createdAt));
    return rows.map((row) => toEndpointRow(row, this.secretEncryptionKeyBase64));
  }

  async deliveryCountsByEndpoint(accountId: string): Promise<Map<string, EndpointDeliveryCounts>> {
    // GROUP BY endpoint_id + status — one row per (endpoint, status)
    // tuple. Only counts statuses we care about for the dashboard
    // surface; pending / in_flight aren't aggregated here.
    const rows = await this.database.db
      .select({
        webhookId: webhookDeliveries.webhookId,
        status: webhookDeliveries.status,
        cnt: sql<number>`count(*)::int`,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookDeliveries.webhookId, webhookEndpoints.id))
      .where(eq(webhookEndpoints.accountId, accountId))
      .groupBy(webhookDeliveries.webhookId, webhookDeliveries.status);

    const result = new Map<string, EndpointDeliveryCounts>();
    for (const r of rows) {
      const existing = result.get(r.webhookId) ?? { delivered: 0, failed: 0, dlq: 0 };
      if (r.status === 'delivered') existing.delivered = r.cnt;
      else if (r.status === 'failed') existing.failed = r.cnt;
      else if (r.status === 'dlq') existing.dlq = r.cnt;
      result.set(r.webhookId, existing);
    }
    return result;
  }

  async findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
      .limit(1);
    return row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null;
  }

  async findEndpointById(id: string): Promise<WebhookEndpointRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    return row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null;
  }

  async countActiveEndpoints(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.accountId, accountId), eq(webhookEndpoints.active, true)));
    return row?.count ?? 0;
  }

  async disableEndpoint(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(webhookEndpoints)
      .set({ active: false, disabledAt: at, updatedAt: new Date() })
      .where(eq(webhookEndpoints.id, id));
  }

  async updateEndpoint(input: EndpointPatch): Promise<WebhookEndpointRow | null> {
    // Account-scoped + not-disabled — disabled rows are tombstones.
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set(endpointPatchSet(input))
      .where(
        and(
          eq(webhookEndpoints.id, input.id),
          eq(webhookEndpoints.accountId, input.accountId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .returning();
    return row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null;
  }

  // Webhooks audit #4 — a patch that RESUMES a paused endpoint is a cap decision,
  // so it takes the same per-account advisory lock as create and re-checks the
  // cap against the row's state under that lock. Only the paused → active
  // transition is checked: every other patch (and `active: true` on an endpoint
  // already active) applies as updateEndpoint would. `overLimit` means nothing
  // was written.
  async updateEndpointIfUnderLimit(
    input: EndpointPatch,
    limit: number,
  ): Promise<{ row: WebhookEndpointRow | null; overLimit: boolean }> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${endpointCapLockKey(input.accountId)}))`,
      );
      const live = and(
        eq(webhookEndpoints.id, input.id),
        eq(webhookEndpoints.accountId, input.accountId),
        isNull(webhookEndpoints.disabledAt),
      );
      const [current] = await tx
        .select({ active: webhookEndpoints.active })
        .from(webhookEndpoints)
        .where(live)
        .limit(1);
      if (current === undefined) return { row: null, overLimit: false };
      if (input.active === true && !current.active) {
        const [others] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(webhookEndpoints)
          .where(
            and(
              eq(webhookEndpoints.accountId, input.accountId),
              isNull(webhookEndpoints.disabledAt),
              ne(webhookEndpoints.id, input.id),
            ),
          );
        if ((others?.count ?? 0) >= limit) return { row: null, overLimit: true };
      }
      const [row] = await tx
        .update(webhookEndpoints)
        .set(endpointPatchSet(input))
        .where(live)
        .returning();
      return {
        row: row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null,
        overLimit: false,
      };
    });
  }

  async rotateSecret(input: {
    id: string;
    accountId: string;
    newSecret: string;
    newPrefix: string;
    graceExpiresAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    // postgres-js cannot bind a raw Date interpolated inside sql``. Drizzle
    // handles Date values in typed .set(), but these CASE/WHERE fragments are
    // raw SQL, so bind an ISO string and cast explicitly to timestamptz.
    const nowIso = input.now.toISOString();
    const graceIso = input.graceExpiresAt.toISOString();
    // Single UPDATE: overwrite the current secret with the new pair and decide
    // the grace slot from the row's own values at UPDATE time — no
    // SELECT-then-UPDATE race, and concurrent rotations apply in turn.
    //
    // OUTSIDE a live grace window: the outgoing current secret moves into the
    // prev slot and a fresh window opens (`graceExpiresAt`).
    //
    // INSIDE a live grace window (secret_prev set, not yet expired) the prev
    // slot already holds the secret the customer's servers are verifying with,
    // and it is KEPT — this rotation replaces only the current secret:
    //
    //   - a second CUSTOMER rotation (webhooks audit #7, 2026-09-24) keeps the
    //     original secret AND its expiry. This used to be refused with 409
    //     (V-359.G), because copying the first new secret into the prev slot
    //     would discard the original one mid-rollout. Keeping the prev slot
    //     protects the original just as well, and lets a customer who lost the
    //     new secret — the docs' own advice is "rotate the secret" — get
    //     another one instead of waiting out the window.
    //   - a customer rotation under a live server FORCE-rotation window
    //     (V-359.G.2, audit 2026-07-03): the current secret is the
    //     server's force-rotated value, which the customer only ever saw as a
    //     12-char prefix and never deployed, while the prev slot holds the one
    //     they run. Keep that one, and give it a fresh customer window
    //     (`graceExpiresAt`) — the rotation clears the force bookkeeping below.
    const liveGrace = sql`(${webhookEndpoints.secretPrev} IS NOT NULL AND ${webhookEndpoints.secretPrevExpiresAt} > ${nowIso}::timestamptz)`;
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set({
        secret: this.encryptForStorage(input.newSecret, {
          accountId: input.accountId,
          endpointId: input.id,
        }),
        secretPrefix: input.newPrefix,
        secretPrev: sql`CASE WHEN ${liveGrace} THEN ${webhookEndpoints.secretPrev} ELSE ${webhookEndpoints.secret} END`,
        secretPrevExpiresAt: sql`CASE WHEN ${liveGrace} AND ${webhookEndpoints.forceRotatedAt} IS NULL THEN ${webhookEndpoints.secretPrevExpiresAt} ELSE ${graceIso}::timestamptz END`,
        // v2-#10 — new secret is fresh; reset the rotation clock so
        // the 90d nag starts over from this rotation. Also clear the
        // reminder dedupe column so the next rotation cycle can fire
        // reminders without being blocked by a stale send.
        secretCreatedAt: input.now,
        lastReminderSentAt: null,
        // Arc 3 sub-slice 28.1 (v2-#28) — reset force-rotation
        // bookkeeping so the 91-day clock restarts cleanly when the
        // customer rotates manually.
        forceRotatedAt: null,
        graceWindowEndsAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(webhookEndpoints.id, input.id),
          eq(webhookEndpoints.accountId, input.accountId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .returning();
    // No row: the endpoint does not exist, is another account's, or is deleted.
    return row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null;
  }

  async findEndpointsNeedingForceRotation(args: {
    now: Date;
    thresholdDays: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>> {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const cutoff = new Date(args.now.getTime() - args.thresholdDays * MS_PER_DAY);
    const rows = await this.database.db
      .select({
        id: webhookEndpoints.id,
        accountId: webhookEndpoints.accountId,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        secretPrefix: webhookEndpoints.secretPrefix,
        secretPrev: webhookEndpoints.secretPrev,
        secretPrevExpiresAt: webhookEndpoints.secretPrevExpiresAt,
        secretCreatedAt: webhookEndpoints.secretCreatedAt,
        lastReminderSentAt: webhookEndpoints.lastReminderSentAt,
        graceWindowEndsAt: webhookEndpoints.graceWindowEndsAt,
        forceRotatedAt: webhookEndpoints.forceRotatedAt,
        events: webhookEndpoints.events,
        description: webhookEndpoints.description,
        active: webhookEndpoints.active,
        consecutiveFailures: webhookEndpoints.consecutiveFailures,
        lastSuccessAt: webhookEndpoints.lastSuccessAt,
        lastFailureAt: webhookEndpoints.lastFailureAt,
        disabledAt: webhookEndpoints.disabledAt,
        createdAt: webhookEndpoints.createdAt,
        updatedAt: webhookEndpoints.updatedAt,
        accountEmail: accounts.email,
      })
      .from(webhookEndpoints)
      .innerJoin(accounts, eq(accounts.id, webhookEndpoints.accountId))
      .where(
        and(
          isNull(webhookEndpoints.disabledAt),
          isNull(webhookEndpoints.forceRotatedAt),
          lt(webhookEndpoints.secretCreatedAt, cutoff),
        ),
      )
      .orderBy(webhookEndpoints.secretCreatedAt)
      .limit(args.limit);
    return rows.flatMap((r) => {
      // Resolved OUTSIDE the try on purpose. A MISSING KEY is a deployment fault
      // affecting every row and must stay loud — swallowing it here turned a hard
      // failure into a silently empty sweep, the exact failure the "REFUSES rather
      // than returning ciphertext" arm forbids. Only a per-ROW failure is recoverable.
      const encryptionKey = this.requireEncryptionKey();
      try {
        return [
          {
            id: r.id,
            accountId: r.accountId,
            url: r.url,
            secret: readWebhookSecret(r.secret, encryptionKey, {
              accountId: r.accountId,
              endpointId: r.id,
            }),
            secretPrefix: r.secretPrefix,
            secretPrev:
              r.secretPrev !== null
                ? readWebhookSecret(r.secretPrev, encryptionKey, {
                    accountId: r.accountId,
                    endpointId: r.id,
                  })
                : null,
            secretPrevExpiresAt: r.secretPrevExpiresAt,
            secretCreatedAt: r.secretCreatedAt,
            lastReminderSentAt: r.lastReminderSentAt,
            graceWindowEndsAt: r.graceWindowEndsAt,
            forceRotatedAt: r.forceRotatedAt,
            events: sanitizePersistedWebhookEvents(r.events),
            description: r.description,
            active: r.active,
            consecutiveFailures: r.consecutiveFailures,
            lastSuccessAt: r.lastSuccessAt,
            lastFailureAt: r.lastFailureAt,
            disabledAt: r.disabledAt,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            accountEmail: r.accountEmail,
          },
        ];
      } catch (error) {
        // One row whose secret will not decrypt must not stop the sweep for
        // every other account. Skipping is reported, never silent.
        this.onUndecryptableSecret?.({
          endpointId: r.id,
          accountId: r.accountId,
          error,
        });
        return [];
      }
    });
  }

  /**
   * Arc 3 sub-slice 28.5 follow-up (v2-#28) — find endpoints whose
   * server-initiated grace window (graceWindowEndsAt) closes within
   * `windowHours` AND hasn't already closed AND haven't been sent the
   * "grace expiring" last-chance notice yet. Mirrors
   * findEndpointsNeedingForceRotation's shape/pattern: caller
   * (WebhookGraceExpiringNoticeService) iterates the result + calls
   * email.sendWebhookSecretGraceExpiring per row, marking
   * grace_expiring_notified_at only on a successful send.
   */
  async findEndpointsNeedingGraceExpiringNotice(args: {
    now: Date;
    windowHours: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>> {
    const MS_PER_HOUR = 60 * 60 * 1000;
    const horizon = new Date(args.now.getTime() + args.windowHours * MS_PER_HOUR);
    const rows = await this.database.db
      .select({
        id: webhookEndpoints.id,
        accountId: webhookEndpoints.accountId,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        secretPrefix: webhookEndpoints.secretPrefix,
        secretPrev: webhookEndpoints.secretPrev,
        secretPrevExpiresAt: webhookEndpoints.secretPrevExpiresAt,
        secretCreatedAt: webhookEndpoints.secretCreatedAt,
        lastReminderSentAt: webhookEndpoints.lastReminderSentAt,
        graceWindowEndsAt: webhookEndpoints.graceWindowEndsAt,
        forceRotatedAt: webhookEndpoints.forceRotatedAt,
        events: webhookEndpoints.events,
        description: webhookEndpoints.description,
        active: webhookEndpoints.active,
        consecutiveFailures: webhookEndpoints.consecutiveFailures,
        lastSuccessAt: webhookEndpoints.lastSuccessAt,
        lastFailureAt: webhookEndpoints.lastFailureAt,
        disabledAt: webhookEndpoints.disabledAt,
        createdAt: webhookEndpoints.createdAt,
        updatedAt: webhookEndpoints.updatedAt,
        accountEmail: accounts.email,
      })
      .from(webhookEndpoints)
      .innerJoin(accounts, eq(accounts.id, webhookEndpoints.accountId))
      .where(
        and(
          isNull(webhookEndpoints.disabledAt),
          isNotNull(webhookEndpoints.graceWindowEndsAt),
          isNull(webhookEndpoints.graceExpiringNotifiedAt),
          // graceWindowEndsAt within (now, now + windowHours] — not yet
          // expired (> now) and due within the notice horizon (<= horizon).
          // Uses drizzle's gt/lte helpers, NOT a raw `sql` template with a
          // Date interpolated directly — see the drizzle Date-param
          // workaround notes (a raw-sql Date param silently
          // crashes via drizzle's transparentParser OID swap; gt/lte handle
          // Date params correctly, matching findEndpointsNeedingForceRotation's
          // lt(...) sibling call above).
          gt(webhookEndpoints.graceWindowEndsAt, args.now),
          lte(webhookEndpoints.graceWindowEndsAt, horizon),
        ),
      )
      .orderBy(webhookEndpoints.graceWindowEndsAt)
      .limit(args.limit);
    return rows.flatMap((r) => {
      // Resolved OUTSIDE the try on purpose. A MISSING KEY is a deployment fault
      // affecting every row and must stay loud — swallowing it here turned a hard
      // failure into a silently empty sweep, the exact failure the "REFUSES rather
      // than returning ciphertext" arm forbids. Only a per-ROW failure is recoverable.
      const encryptionKey = this.requireEncryptionKey();
      try {
        return [
          {
            id: r.id,
            accountId: r.accountId,
            url: r.url,
            secret: readWebhookSecret(r.secret, encryptionKey, {
              accountId: r.accountId,
              endpointId: r.id,
            }),
            secretPrefix: r.secretPrefix,
            secretPrev:
              r.secretPrev !== null
                ? readWebhookSecret(r.secretPrev, encryptionKey, {
                    accountId: r.accountId,
                    endpointId: r.id,
                  })
                : null,
            secretPrevExpiresAt: r.secretPrevExpiresAt,
            secretCreatedAt: r.secretCreatedAt,
            lastReminderSentAt: r.lastReminderSentAt,
            graceWindowEndsAt: r.graceWindowEndsAt,
            forceRotatedAt: r.forceRotatedAt,
            events: sanitizePersistedWebhookEvents(r.events),
            description: r.description,
            active: r.active,
            consecutiveFailures: r.consecutiveFailures,
            lastSuccessAt: r.lastSuccessAt,
            lastFailureAt: r.lastFailureAt,
            disabledAt: r.disabledAt,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            accountEmail: r.accountEmail,
          },
        ];
      } catch (error) {
        // One row whose secret will not decrypt must not stop the sweep for
        // every other account. Skipping is reported, never silent.
        this.onUndecryptableSecret?.({
          endpointId: r.id,
          accountId: r.accountId,
          error,
        });
        return [];
      }
    });
  }

  /**
   * Arc 3 sub-slice 28.5 follow-up (v2-#28) — mark the grace-expiring
   * notice sent for one endpoint. Caller only invokes this AFTER a
   * successful email send (unlike markReminderSent, which fires
   * unconditionally) — a failed send leaves the column NULL so the
   * very next sweep tick retries it, rather than swallowing the
   * failure until the next ~91-day force-rotation cycle resets the
   * bookkeeping.
   *
   * Guarded write (post-launch-day fix): the caller snapshots eligible
   * endpoints once at the top of the sweep, then emails + marks
   * per-row — a live race window in which the endpoint gets disabled
   * (customer deletes it) or its account gets deleted between the
   * snapshot and this call. Mirrors rotateSecret / forceRotateSecret's
   * `isNull(disabledAt)` re-check + `.returning()` so the UPDATE only
   * touches a still-live row and the caller can tell a miss (null)
   * apart from a real update, instead of silently stamping
   * grace_expiring_notified_at on a tombstoned endpoint.
   */
  async markGraceExpiringNotified(args: {
    endpointId: string;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set({ graceExpiringNotifiedAt: args.now, updatedAt: args.now })
      .where(and(eq(webhookEndpoints.id, args.endpointId), isNull(webhookEndpoints.disabledAt)))
      .returning();
    return row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null;
  }

  async forceRotateSecret(input: {
    id: string;
    newSecret: string;
    newPrefix: string;
    graceWindowEndsAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    // The dormant force-rotation service does not carry accountId in its
    // established interface. Resolve the owning tuple before encrypting, then
    // exact-condition that same account on the UPDATE so a row replacement or
    // deletion cannot attach the new ciphertext to a different context.
    const [contextRow] = await this.database.db
      .select({ accountId: webhookEndpoints.accountId })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, input.id))
      .limit(1);
    if (contextRow === undefined) return null;
    // Mirrors rotateSecret (V-359 dual-sign path) PLUS writes the
    // sub-slice 28.1 columns. forceRotatedAt stamps the rotation
    // event so the daily sweep doesn't loop; graceWindowEndsAt is
    // the 7-day deadline (Q2=B) the validator (sub-slice 28.3) reads
    // to accept the prev secret for inbound HMAC verification.
    // graceExpiringNotifiedAt is reset to null (mirrors
    // lastReminderSentAt) so the sub-slice 28.5 follow-up "grace
    // expiring" notice can fire again for THIS new grace window —
    // without the reset, a stale non-null value from a PRIOR
    // force-rotation cycle would permanently block the notice for
    // every future cycle on this endpoint.
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set({
        secret: this.encryptForStorage(input.newSecret, {
          accountId: contextRow.accountId,
          endpointId: input.id,
        }),
        secretPrefix: input.newPrefix,
        secretPrev: sql`${webhookEndpoints.secret}`,
        secretPrevExpiresAt: input.graceWindowEndsAt,
        graceWindowEndsAt: input.graceWindowEndsAt,
        forceRotatedAt: input.now,
        secretCreatedAt: input.now,
        lastReminderSentAt: null,
        graceExpiringNotifiedAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(webhookEndpoints.id, input.id),
          eq(webhookEndpoints.accountId, contextRow.accountId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .returning();
    return row ? toEndpointRow(row, this.secretEncryptionKeyBase64) : null;
  }

  async clearStaleSecretPrev(args: { now: Date }): Promise<{ cleared: number }> {
    // v2-#29 — single UPDATE that nulls out secret_prev +
    // secret_prev_expires_at for every row whose grace window has
    // elapsed. The match clause keys on `secret_prev_expires_at <
    // now` AND `secret_prev IS NOT NULL` so rows that never rotated
    // (both fields null) aren't touched. Returns the cleared-row
    // count for telemetry.
    const rows = await this.database.db
      .update(webhookEndpoints)
      .set({ secretPrev: null, secretPrevExpiresAt: null })
      .where(
        and(
          isNotNull(webhookEndpoints.secretPrev),
          isNotNull(webhookEndpoints.secretPrevExpiresAt),
          lt(webhookEndpoints.secretPrevExpiresAt, args.now),
        ),
      )
      .returning({ id: webhookEndpoints.id });
    return { cleared: rows.length };
  }

  async enqueueDelivery(input: NewWebhookDeliveryInput): Promise<string> {
    // RETURNING the DB-generated primary key — the same `id` the deliveries-list
    // (`wdl_${row.id}`) + replay routes resolve against. The test-event path
    // returns this so its delivery_id is actually look-up-able (was returning the
    // eventId, which is a SEPARATE column → 404 on lookup/replay).
    const [row] = await this.database.db
      .insert(webhookDeliveries)
      .values({
        webhookId: input.webhookId,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: input.payload,
        ...(input.nextAttemptAt !== undefined ? { nextAttemptAt: input.nextAttemptAt } : {}),
      })
      .returning({ id: webhookDeliveries.id });
    if (row === undefined) {
      // An INSERT ... RETURNING always yields exactly one row; the guard is
      // purely to satisfy the type-narrowing (and would only fire on a driver
      // contract break, which we'd want surfaced).
      throw new Error('enqueueDelivery: INSERT returned no row');
    }
    return row.id;
  }

  // Webhooks audit #5 — one event's fan-out is ONE multi-row INSERT, so it is
  // atomic: either every subscribed endpoint gets its delivery row or none does.
  // It was one INSERT per endpoint, so a failure part-way left some endpoints
  // with the event and the rest without it, and nothing recorded which.
  async enqueueDeliveries(inputs: readonly NewWebhookDeliveryInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];
    const rows = await this.database.db
      .insert(webhookDeliveries)
      .values(
        inputs.map((input) => ({
          webhookId: input.webhookId,
          eventId: input.eventId,
          eventType: input.eventType,
          payload: input.payload,
          ...(input.nextAttemptAt !== undefined ? { nextAttemptAt: input.nextAttemptAt } : {}),
        })),
      )
      .returning({ id: webhookDeliveries.id });
    if (rows.length !== inputs.length) {
      throw new Error(
        `enqueueDeliveries: inserted ${rows.length.toString()} of ${inputs.length.toString()} rows`,
      );
    }
    return rows.map((r) => r.id);
  }

  // Webhooks audit #3 — every endpoint that is not DELETED, paused ones
  // included: an event raised while an endpoint is paused is queued for it and
  // held until it is resumed (the claim skips a paused endpoint's deliveries).
  // It selected `active = true`, so a pause silently dropped every event raised
  // during it.
  async listEndpointsSubscribedTo(
    accountId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookEndpointRow[]> {
    const rows = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.accountId, accountId),
          isNull(webhookEndpoints.disabledAt),
          // events @> ARRAY[<eventType>] — every endpoint whose events array
          // contains the eventType.
          sql`${webhookEndpoints.events} @> ARRAY[${eventType}]::webhook_event_type[]`,
        ),
      );
    return rows.map((row) => toEndpointRow(row, this.secretEncryptionKeyBase64));
  }

  async claim(opts: {
    batchSize: number;
    now: Date;
    /**
     * Most deliveries taken per ENDPOINT per claim. Default 5, so a batch of 25
     * always reaches at least five distinct endpoints however deep any single
     * endpoint's backlog runs.
     */
    perEndpointCap?: number;
  }): Promise<WebhookDeliveryRow[]> {
    const perEndpointCap = opts.perEndpointCap ?? 5;
    // Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED → UPDATE status = in_flight
    // → RETURNING. ISO-string the timestamp because postgres-js's
    // tagged-template binder rejects raw Date in this position.
    const nowIso = opts.now.toISOString();
    // V-173.R — also reclaim STALE in_flight rows. A worker that crashed /
    // was deployed mid-batch leaves rows stuck `in_flight` forever (they're
    // never re-selected → the webhook is silently lost, skipping all
    // retries). The claim sets `updated_at = NOW()`, so an in_flight row
    // whose `updated_at` is older than RECLAIM_STALE_IN_FLIGHT_MS has no live
    // worker on it — re-claim it. Threshold ≫ the per-attempt delivery
    // timeout so a merely-slow (not crashed) delivery isn't double-sent;
    // a re-delivery is acceptable anyway (webhooks are at-least-once,
    // event-id-dedupable). No new column needed — `updated_at` is the anchor.
    const staleBeforeIso = new Date(opts.now.getTime() - RECLAIM_STALE_IN_FLIGHT_MS).toISOString();
    const rows = await this.database.client<Record<string, unknown>[]>`
      WITH busy AS (
        -- Webhooks audit #2 (2026-09-24). The worker is a POOL now: a slot that
        -- frees claims again straight away, while other deliveries are still in
        -- flight. So the per-endpoint cap has to count what the endpoint ALREADY
        -- has in flight (claimed by any worker, not yet stale), or a slow
        -- endpoint's backlog — always the oldest rows — would be handed every
        -- slot as it frees, and the pool would fill with one straggler.
        SELECT webhook_id, count(*)::int AS n
        FROM webhook_deliveries
        WHERE status = 'in_flight' AND updated_at > ${staleBeforeIso}::timestamptz
        GROUP BY webhook_id
      ),
      due AS (
        -- FAIRNESS. A plain ORDER BY next_attempt_at LIMIT n is FIFO across the
        -- whole table, and an endpoint that is DOWN is the worst possible
        -- neighbour under that rule: its retries carry the OLDEST
        -- next_attempt_at, so they sort first and fill the claim — and each of
        -- those rows holds a delivery slot for the full per-attempt timeout
        -- while yielding nothing. One broken endpoint would therefore not merely
        -- delay every other customer's webhooks, it would stop them being
        -- attempted at all.
        --
        -- (2026-08-15: this said "delivers the batch SERIALLY", which has not
        -- been true since delivery moved to Promise.all. The fairness argument
        -- is unchanged — a batch full of one dead endpoint is wasted either way
        -- — but the readiness assessment read this comment and recorded a
        -- throughput ceiling 20× below the real one. A stale comment in a
        -- load-bearing query does not stay local.)
        --
        -- Ranking within each endpoint and taking at most perEndpointCap per
        -- claim bounds that. A backlogged endpoint still drains, one capped
        -- slice per tick, but never at the cost of starving the rest.
        --
        -- (2026-09-24: delivery is a bounded POOL, not a batch — a slot that
        -- frees claims again at once — so the cap counts the endpoint's
        -- deliveries already in flight (busy, above). A straggler holds at most
        -- perEndpointCap slots IN TOTAL, not perEndpointCap per claim.)
        --
        -- Webhooks audit #3 — a PAUSED endpoint's deliveries (active = false,
        -- disabled_at IS NULL) are not claimed at all: they wait, unattempted,
        -- until the endpoint is resumed. A DELETED endpoint's still are, so the
        -- worker can fail them terminally.
        SELECT id, webhook_id,
               row_number() OVER (PARTITION BY webhook_id ORDER BY next_attempt_at ASC) AS rn,
               next_attempt_at
        FROM webhook_deliveries
        WHERE ((status = 'pending' AND next_attempt_at <= ${nowIso}::timestamptz)
            OR (status = 'in_flight' AND updated_at <= ${staleBeforeIso}::timestamptz))
          AND webhook_id NOT IN (
            SELECT id FROM webhook_endpoints WHERE active = false AND disabled_at IS NULL
          )
      ),
      fair AS (
        SELECT due.id FROM due
        LEFT JOIN busy ON busy.webhook_id = due.webhook_id
        WHERE rn <= ${perEndpointCap} - COALESCE(busy.n, 0)
        ORDER BY due.next_attempt_at ASC
        LIMIT ${opts.batchSize}
      ),
      claimed AS (
        -- The lock is taken in a separate step because PostgreSQL forbids FOR
        -- UPDATE alongside a window function. SKIP LOCKED skips a row another
        -- worker holds right now.
        --
        -- Webhooks audit #6 (2026-09-24) — and the due/stale predicate is
        -- REPEATED here. The ranking above reads this statement's snapshot, so a
        -- row another worker claims and commits after that snapshot is no longer
        -- locked when this step reaches it; PostgreSQL then re-checks only THIS
        -- step's WHERE against the row's committed version. With just
        -- id IN (fair) that re-check passed and the row was claimed a second
        -- time (the audit: "W2 also returned X: true"). Now the committed
        -- in_flight version fails it and the row is dropped.
        SELECT id FROM webhook_deliveries
        WHERE id IN (SELECT id FROM fair)
          AND ((status = 'pending' AND next_attempt_at <= ${nowIso}::timestamptz)
            OR (status = 'in_flight' AND updated_at <= ${staleBeforeIso}::timestamptz))
        FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_deliveries
      SET status = 'in_flight', updated_at = NOW()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING *
    `;
    return rows.map(rawToDeliveryRow);
  }

  async recordDelivered(
    deliveryId: string,
    opts: { responseStatus: number; at: Date },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          lastResponseStatus: opts.responseStatus,
          deliveredAt: opts.at,
          updatedAt: new Date(),
        })
        // Fence on in_flight (review wjf04whfl #1): the worker only writes for a row
        // it claimed in_flight, so if a >5min-stalled worker's record* lands after
        // another tick reclaimed + finalized the row, this matches 0 rows → the
        // `if (!updated) return` below makes it a no-op. Without the fence a stale
        // write could resurrect a delivered row to DLQ + bump the endpoint failure
        // counter toward the spurious 50-failure auto-disable.
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'in_flight')))
        .returning({ webhookId: webhookDeliveries.webhookId });
      if (!updated) return;
      await tx
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: 0,
          lastSuccessAt: opts.at,
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  async recordRetry(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt: string | null;
      lastError: string | null;
      attempts: number;
      nextAttemptAt: Date;
    },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'pending',
          attempts: opts.attempts,
          nextAttemptAt: opts.nextAttemptAt,
          lastResponseStatus: opts.responseStatus,
          lastResponseExcerpt: opts.responseExcerpt,
          lastError: opts.lastError,
          updatedAt: new Date(),
        })
        // Fence on in_flight (review wjf04whfl #1): the worker only writes for a row
        // it claimed in_flight, so if a >5min-stalled worker's record* lands after
        // another tick reclaimed + finalized the row, this matches 0 rows → the
        // `if (!updated) return` below makes it a no-op. Without the fence a stale
        // write could resurrect a delivered row to DLQ + bump the endpoint failure
        // counter toward the spurious 50-failure auto-disable.
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'in_flight')))
        .returning({ webhookId: webhookDeliveries.webhookId });
      if (!updated) return;
      await tx
        .update(webhookEndpoints)
        .set({
          // NOT consecutiveFailures. That counter is a per-DELIVERY signal:
          // `consecutive_failures` "increments on each failed delivery"
          // (webhooks/endpoints.md) and the endpoint "is auto-disabled after 50
          // consecutive failed deliveries" (webhooks/events.md), which also tells
          // customers to monitor the field to catch a drifting endpoint before it
          // trips. A retry is an ATTEMPT within one delivery, and MAX_ATTEMPTS is
          // 6, so incrementing here counted one failed delivery up to six times —
          // the endpoint tombstoned after ~9 failed deliveries rather than 50, and
          // the tombstone is sticky (a new endpoint must be minted). A customer
          // watching the documented signal during a brief receiver outage lost the
          // endpoint permanently, roughly 6x sooner than the headroom they were
          // told they had. recordDlq owns the increment: that is the point at
          // which a DELIVERY has definitively failed.
          lastFailureAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  // Webhooks audit #3 — a delivery claimed for an endpoint that turned out to be
  // PAUSED goes back to `pending` untouched: no attempt spent, no response
  // recorded, and the endpoint's failure counter not moved. The claim skips a
  // paused endpoint's deliveries, so this only ever catches a pause that landed
  // between the claim and the delivery. Fenced on in_flight like the writers
  // below.
  async recordDeferred(deliveryId: string): Promise<void> {
    await this.database.db
      .update(webhookDeliveries)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'in_flight')));
  }

  async recordDlq(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt?: string | null;
      lastError: string | null;
      at: Date;
    },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'dlq',
          lastResponseStatus: opts.responseStatus,
          // Webhooks audit #8 — the FINAL attempt's body, or null when it got no
          // response. This column was left alone, so a DLQ row paired the last
          // attempt's status with the previous attempt's body.
          lastResponseExcerpt: opts.responseExcerpt ?? null,
          lastError: opts.lastError,
          updatedAt: opts.at,
        })
        // Fence on in_flight (review wjf04whfl #1): the worker only writes for a row
        // it claimed in_flight, so if a >5min-stalled worker's record* lands after
        // another tick reclaimed + finalized the row, this matches 0 rows → the
        // `if (!updated) return` below makes it a no-op. Without the fence a stale
        // write could resurrect a delivered row to DLQ + bump the endpoint failure
        // counter toward the spurious 50-failure auto-disable.
        .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'in_flight')))
        .returning({ webhookId: webhookDeliveries.webhookId });
      if (!updated) return;
      await tx
        .update(webhookEndpoints)
        .set({
          consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
          lastFailureAt: opts.at,
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  async findDeliveryById(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    const [row] = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
      .limit(1);
    return row ? toDeliveryRow(row) : null;
  }

  async listDlqDeliveries(opts: {
    limit: number;
    cursor?: string;
    endpointId?: string;
  }): Promise<ListDeliveriesPage> {
    // Composite (created_at, id) keyset — a created_at-only cursor silently
    // drops rows sharing the boundary millisecond (#125). decode → null on a
    // malformed created_at (first page); id:null preserves legacy created_at-
    // only cursors still in flight across the deploy.
    const cursor = decodeDeliveryCursor(opts.cursor);
    const filters = [eq(webhookDeliveries.status, 'dlq' as WebhookDeliveryStatus)];
    const keyset = deliveryKeysetCondition(cursor);
    if (keyset) filters.push(keyset);
    // V-512 — drill-down filter; uuid scoped to a single endpoint
    // (column is `webhook_id` at the schema level).
    if (opts.endpointId) filters.push(eq(webhookDeliveries.webhookId, opts.endpointId));

    const rows = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(...filters))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toDeliveryRow),
      nextCursor: hasMore && last ? encodeDeliveryCursor(last.createdAt, last.id) : null,
    };
  }

  async countDlqDeliveries(): Promise<number> {
    const [row] = await this.database.db
      .select({ cnt: sql<number>`count(*)::int` })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, 'dlq' as WebhookDeliveryStatus));
    return row?.cnt ?? 0;
  }

  // Backs THREE callers: customer self-service replay
  // (WebhooksService.replayDeliveryAsCustomer), admin replay
  // (WebhooksAdminService.replayDelivery — "regardless of current
  // status" by design, e.g. re-firing a 'delivered' or 'failed' row),
  // and admin DLQ-requeue (WebhooksAdminService.requeueFromDlq, which
  // already pre-checks status==='dlq' itself before calling this).
  // Because the first two intentionally reset a delivery from ANY
  // terminal/queued status, this can't fence on status='dlq' the way
  // deleteDelivery does below — that would break legitimate replays
  // of non-DLQ rows. What it CAN'T be allowed to do is stomp a row a
  // worker currently has claimed: claim() (above) atomically moves
  // pending rows to 'in_flight' and only record{Delivered,Retry,Dlq}
  // are allowed to finalize an in_flight row (those are fenced on
  // status='in_flight' themselves). An unguarded reset here would let
  // a replay land on an in_flight row mid-delivery, immediately
  // re-claimable by the next claim() tick while the original attempt
  // is still running — double-delivering the customer's endpoint and
  // silently dropping the original attempt's outcome. Fencing OUT
  // in_flight (rather than fencing IN dlq) preserves every legitimate
  // replay path while closing that race; a guarded miss is a no-op
  // (null), exactly like deleteDelivery's contract.
  async resetDeliveryToPending(deliveryId: string, at: Date): Promise<WebhookDeliveryRow | null> {
    const [row] = await this.database.db
      .update(webhookDeliveries)
      .set({
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        lastResponseStatus: null,
        lastResponseExcerpt: null,
        lastError: null,
        deliveredAt: null,
        updatedAt: at,
      })
      .where(and(eq(webhookDeliveries.id, deliveryId), ne(webhookDeliveries.status, 'in_flight')))
      .returning();
    return row ? toDeliveryRow(row) : null;
  }

  // 2026-05-22 — hard-delete a DLQ row. Service layer enforces the
  // status='dlq' precondition; the SQL DELETE here matches both id
  // AND status so a concurrent state change (e.g. a worker requeued
  // the row between the service's findDeliveryById and this call)
  // won't accidentally delete a non-DLQ delivery.
  async deleteDelivery(deliveryId: string): Promise<boolean> {
    const result = await this.database.db
      .delete(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.status, 'dlq')))
      .returning({ id: webhookDeliveries.id });
    return result.length > 0;
  }

  async listDeliveriesForEndpoint(
    endpointId: string,
    accountId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage> {
    // Verify ownership before listing.
    const owned = await this.findEndpoint(endpointId, accountId);
    if (!owned) return { items: [], nextCursor: null };

    // Composite (created_at, id) keyset — see listDlqDeliveries (#125): a
    // created_at-only cursor drops rows sharing the boundary millisecond.
    const cursor = decodeDeliveryCursor(opts.cursor);
    const filters = [eq(webhookDeliveries.webhookId, endpointId)];
    const keyset = deliveryKeysetCondition(cursor);
    if (keyset) filters.push(keyset);
    if (opts.status) filters.push(eq(webhookDeliveries.status, opts.status));

    const rows = await this.database.db
      .select()
      .from(webhookDeliveries)
      .where(and(...filters))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toDeliveryRow),
      nextCursor: hasMore && last ? encodeDeliveryCursor(last.createdAt, last.id) : null,
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────

function toEndpointRow(
  r: typeof webhookEndpoints.$inferSelect,
  secretEncryptionKeyBase64: string | undefined,
): WebhookEndpointRow {
  if (secretEncryptionKeyBase64 === undefined) {
    throw new Error('Webhook secret encryption key is unavailable.');
  }
  const context = { accountId: r.accountId, endpointId: r.id };
  return {
    id: r.id,
    accountId: r.accountId,
    url: r.url,
    secret: readWebhookSecret(r.secret, secretEncryptionKeyBase64, context),
    secretPrefix: r.secretPrefix,
    secretPrev:
      r.secretPrev !== null
        ? readWebhookSecret(r.secretPrev, secretEncryptionKeyBase64, context)
        : null,
    secretPrevExpiresAt: r.secretPrevExpiresAt,
    secretCreatedAt: r.secretCreatedAt,
    lastReminderSentAt: r.lastReminderSentAt,
    // Arc 3 sub-slice 28.1 (v2-#28) — force-rotation columns.
    graceWindowEndsAt: r.graceWindowEndsAt,
    forceRotatedAt: r.forceRotatedAt,
    events: sanitizePersistedWebhookEvents(r.events),
    description: r.description,
    active: r.active,
    consecutiveFailures: r.consecutiveFailures,
    lastSuccessAt: r.lastSuccessAt,
    lastFailureAt: r.lastFailureAt,
    disabledAt: r.disabledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toDeliveryRow(r: typeof webhookDeliveries.$inferSelect): WebhookDeliveryRow {
  return {
    id: r.id,
    webhookId: r.webhookId,
    eventId: r.eventId,
    eventType: WebhookEventTypeSchema.parse(r.eventType),
    payload: r.payload ?? {},
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    lastResponseStatus: r.lastResponseStatus,
    lastResponseExcerpt: r.lastResponseExcerpt,
    lastError: r.lastError,
    deliveredAt: r.deliveredAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Raw postgres-js rows returned from the CTE come as snake_case strings. */
function rawToDeliveryRow(r: Record<string, unknown>): WebhookDeliveryRow {
  return {
    id: r.id as string,
    webhookId: r.webhook_id as string,
    eventId: r.event_id as string,
    eventType: r.event_type as WebhookEventType,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    status: r.status as WebhookDeliveryStatus,
    attempts: Number(r.attempts),
    nextAttemptAt: new Date(r.next_attempt_at as string),
    lastResponseStatus:
      r.last_response_status === null || r.last_response_status === undefined
        ? null
        : Number(r.last_response_status),
    lastResponseExcerpt: (r.last_response_excerpt as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    deliveredAt: r.delivered_at ? new Date(r.delivered_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}
