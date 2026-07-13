// Drizzle-backed implementation of WebhooksRepo.

import { and, desc, eq, gt, isNotNull, isNull, lte, lt, ne, or, sql } from 'drizzle-orm';
import {
  decodeDeliveryCursor,
  encodeDeliveryCursor,
  type DeliveryCursor,
} from '../lib/keyset-cursor.js';
import {
  encryptWebhookSecret,
  isEncryptedWebhookSecret,
  readWebhookSecret,
  WEBHOOK_SECRET_ENVELOPE_PREFIX,
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
import type { Database } from './client.js';
import { accounts, webhookDeliveries, webhookEndpoints } from './schema.js';

// V-173.R — an in_flight row whose `updated_at` is older than this has no
// live worker on it (the claimer crashed/deployed mid-delivery); the claim
// reclaims it. 5 min ≫ the 10s per-attempt delivery timeout, so a slow (not
// crashed) delivery is never reclaimed out from under an active worker.
const RECLAIM_STALE_IN_FLIGHT_MS = 5 * 60 * 1000;

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

export class DrizzleWebhooksRepo implements WebhooksRepo {
  private readonly secretEncryptionKeyBase64: string | undefined;

  constructor(
    private readonly database: Database,
    options: { secretEncryptionKeyBase64?: string } = {},
  ) {
    this.secretEncryptionKeyBase64 = options.secretEncryptionKeyBase64;
  }

  private encryptForStorage(plaintext: string): string {
    if (this.secretEncryptionKeyBase64 === undefined) {
      throw new Error('Webhook secret encryption key is unavailable.');
    }
    return encryptWebhookSecret(plaintext, this.secretEncryptionKeyBase64);
  }

  private async encryptLegacyRow(row: {
    id: string;
    secret: string;
    secretPrev: string | null;
  }): Promise<boolean> {
    const secret = isEncryptedWebhookSecret(row.secret)
      ? row.secret
      : this.encryptForStorage(row.secret);
    const secretPrev =
      row.secretPrev === null || isEncryptedWebhookSecret(row.secretPrev)
        ? row.secretPrev
        : this.encryptForStorage(row.secretPrev);
    if (secret === row.secret && secretPrev === row.secretPrev) return false;
    const prevMatches =
      row.secretPrev === null
        ? isNull(webhookEndpoints.secretPrev)
        : eq(webhookEndpoints.secretPrev, row.secretPrev);
    const updated = await this.database.db
      .update(webhookEndpoints)
      .set({ secret, secretPrev })
      .where(
        and(eq(webhookEndpoints.id, row.id), eq(webhookEndpoints.secret, row.secret), prevMatches),
      )
      .returning({ id: webhookEndpoints.id });
    return updated.length === 1;
  }

  /**
   * Bounded, compare-and-set legacy upgrader. It never clobbers a concurrent
   * rotation: both current and previous values must still equal the selected
   * snapshot. Repeated bootstrap ticks drain old plaintext rows without a
   * table rewrite or long-held lock.
   */
  async encryptLegacySecrets(limit = 500): Promise<{ scanned: number; converted: number }> {
    if (this.secretEncryptionKeyBase64 === undefined) {
      throw new Error('Webhook secret encryption key is unavailable.');
    }
    const legacyPrefixPattern = `${WEBHOOK_SECRET_ENVELOPE_PREFIX}%`;
    // Boot-time key verification: authenticate at least one existing envelope
    // before workers start. A syntactically valid but wrong deployment key must
    // fail startup instead of silently turning every delivery into retries.
    const [encryptedProbe] = await this.database.db
      .select({
        secret: webhookEndpoints.secret,
        secretPrev: webhookEndpoints.secretPrev,
      })
      .from(webhookEndpoints)
      .where(
        or(
          sql`${webhookEndpoints.secret} LIKE ${legacyPrefixPattern}`,
          sql`${webhookEndpoints.secretPrev} LIKE ${legacyPrefixPattern}`,
        ),
      )
      .limit(1);
    if (encryptedProbe) {
      if (isEncryptedWebhookSecret(encryptedProbe.secret)) {
        readWebhookSecret(encryptedProbe.secret, this.secretEncryptionKeyBase64);
      }
      if (
        encryptedProbe.secretPrev !== null &&
        isEncryptedWebhookSecret(encryptedProbe.secretPrev)
      ) {
        readWebhookSecret(encryptedProbe.secretPrev, this.secretEncryptionKeyBase64);
      }
    }
    const rows = await this.database.db
      .select({
        id: webhookEndpoints.id,
        secret: webhookEndpoints.secret,
        secretPrev: webhookEndpoints.secretPrev,
      })
      .from(webhookEndpoints)
      .where(
        or(
          sql`${webhookEndpoints.secret} NOT LIKE ${legacyPrefixPattern}`,
          and(
            isNotNull(webhookEndpoints.secretPrev),
            sql`${webhookEndpoints.secretPrev} NOT LIKE ${legacyPrefixPattern}`,
          ),
        ),
      )
      .limit(limit);
    let converted = 0;
    for (const row of rows) {
      if (await this.encryptLegacyRow(row)) converted += 1;
    }
    return { scanned: rows.length, converted };
  }

  private async encryptEndpointLegacySecrets(id: string): Promise<void> {
    const [row] = await this.database.db
      .select({
        id: webhookEndpoints.id,
        secret: webhookEndpoints.secret,
        secretPrev: webhookEndpoints.secretPrev,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, id))
      .limit(1);
    if (row) await this.encryptLegacyRow(row);
  }

  async insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow> {
    const [row] = await this.database.db
      .insert(webhookEndpoints)
      .values({
        accountId: input.accountId,
        url: input.url,
        secret: this.encryptForStorage(input.secret),
        secretPrefix: input.secretPrefix,
        events: input.events,
        description: input.description,
      })
      .returning();
    if (!row) throw new Error('insertEndpoint returned no row');
    return toEndpointRow(row, this.secretEncryptionKeyBase64);
  }

  // Atomic "insert only if under the active-endpoint cap" — closes the
  // count-then-insert TOCTOU in WebhooksService.create (a bare
  // countActiveEndpoints + insertEndpoint lets N concurrent creates all pass a
  // stale count and exceed the cap). A per-account advisory lock (xact-scoped →
  // auto-released on commit/rollback) serialises concurrent creates for the
  // SAME account so the count + insert are atomic; different accounts hash to
  // different lock keys (no cross-account contention). Returns null when already
  // at/over the limit. Mirrors SessionsRepo.insertSessionIfUnderLimit.
  async insertEndpointIfUnderLimit(
    input: NewWebhookEndpointInput,
    limit: number,
  ): Promise<WebhookEndpointRow | null> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`webhook-endpoint-create:${input.accountId}`}))`,
      );
      const [countRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(webhookEndpoints)
        .where(
          and(eq(webhookEndpoints.accountId, input.accountId), eq(webhookEndpoints.active, true)),
        );
      if ((countRow?.count ?? 0) >= limit) return null;
      const [row] = await tx
        .insert(webhookEndpoints)
        .values({
          accountId: input.accountId,
          url: input.url,
          secret: this.encryptForStorage(input.secret),
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

  async updateEndpoint(input: {
    id: string;
    accountId: string;
    url?: string;
    events?: WebhookEventType[];
    description?: string | null;
    active?: boolean;
  }): Promise<WebhookEndpointRow | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.url !== undefined) set.url = input.url;
    if (input.events !== undefined) set.events = input.events;
    if (input.description !== undefined) set.description = input.description;
    if (input.active !== undefined) set.active = input.active;
    // Account-scoped + not-disabled — disabled rows are tombstones.
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set(set)
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

  async rotateSecret(input: {
    id: string;
    accountId: string;
    newSecret: string;
    newPrefix: string;
    graceExpiresAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    // Upgrade a legacy current/previous value before the atomic SQL copy below,
    // so rotation can never move a plaintext active key into secret_prev.
    await this.encryptEndpointLegacySecrets(input.id);
    // postgres-js cannot bind a raw Date interpolated inside sql``. Drizzle
    // handles Date values in typed .set(), but these CASE/WHERE fragments are
    // raw SQL, so bind an ISO string and cast explicitly to timestamptz.
    const nowIso = input.now.toISOString();
    // Single UPDATE: copy current secret/prefix INTO the prev slot,
    // overwrite current with the new pair, set the grace expiry.
    // No SELECT-then-UPDATE race — Postgres reads the row's current
    // values at UPDATE time.
    //
    // V-359.G — guard against a SECOND *customer* rotation while a prior
    // customer rotation is STILL inside its dual-sign grace window.
    // Without the guard the new rotation would copy the *current*
    // (already-new) secret into secret_prev, silently discarding the
    // ORIGINAL secret the customer is still rolling across their verifier
    // infra — breaking inbound HMAC verification for the first new secret.
    // The WHERE only matches when no live customer grace window is in
    // flight (secret_prev_expires_at IS NULL or already elapsed), so the
    // destructive copy can never clobber a still-valid secret_prev. The
    // guard rides on the rotation UPDATE itself, so it stays atomic (no
    // SELECT-then-UPDATE race introduced).
    //
    // A server-initiated FORCE-rotation (force_rotated_at IS NOT NULL)
    // does NOT block: that window is the server migrating the customer
    // OFF an aged secret, and a customer manually rotating in response is
    // exactly the intended escape hatch (sub-slice 28.7 — it must clear
    // force_rotated_at + grace_window_ends_at). Only a prior *customer*
    // rotation (force_rotated_at IS NULL) opens a guarded window.
    const [row] = await this.database.db
      .update(webhookEndpoints)
      .set({
        secret: this.encryptForStorage(input.newSecret),
        secretPrefix: input.newPrefix,
        // Normally the outgoing current secret moves INTO the prev slot for the
        // dual-sign grace. EXCEPTION (V-359.G.2, Fable audit 2026-07-03): when
        // this rotation is running under a still-live FORCE-rotation grace
        // window (forceRotatedAt set, secret_prev_expires_at in the future), the
        // current `secret` is the SERVER's force-rotated value — which the
        // customer only ever received as a 12-char prefix and never deployed —
        // while secret_prev holds the secret the customer ACTUALLY has live. Do
        // NOT clobber that with the un-deployed force secret, or the worker would
        // dual-sign {new, force} and BOTH would fail the customer's verifier
        // (still on the original). Preserve the customer's live secret in the
        // grace slot so the new secret rolls out without breaking verification.
        secretPrev: sql`CASE WHEN ${webhookEndpoints.forceRotatedAt} IS NOT NULL AND ${webhookEndpoints.secretPrevExpiresAt} > ${nowIso}::timestamptz THEN ${webhookEndpoints.secretPrev} ELSE ${webhookEndpoints.secret} END`,
        secretPrevExpiresAt: input.graceExpiresAt,
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
          // V-359.G — only rotate when no prior *customer* grace window
          // is live. A force-rotation window (force_rotated_at NOT NULL)
          // is exempt so the customer's escape-hatch rotation proceeds.
          sql`(${webhookEndpoints.secretPrevExpiresAt} IS NULL OR ${webhookEndpoints.secretPrevExpiresAt} <= ${nowIso}::timestamptz OR ${webhookEndpoints.forceRotatedAt} IS NOT NULL)`,
        ),
      )
      .returning();
    if (row) return toEndpointRow(row, this.secretEncryptionKeyBase64);

    // The guarded UPDATE matched nothing. Distinguish a still-in-flight
    // grace window (no-op: return the UNCHANGED in-flight row so the
    // caller sees the original secret_prev preserved, NOT a spurious
    // not-found) from a genuinely absent / disabled endpoint (null).
    // This read runs only on the rare miss path and is NOT part of the
    // rotation write, so it does not reintroduce a rotation race.
    const [existing] = await this.database.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.id, input.id),
          eq(webhookEndpoints.accountId, input.accountId),
          isNull(webhookEndpoints.disabledAt),
        ),
      )
      .limit(1);
    return existing ? toEndpointRow(existing, this.secretEncryptionKeyBase64) : null;
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
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      url: r.url,
      secret: readWebhookSecret(r.secret, this.secretEncryptionKeyBase64),
      secretPrefix: r.secretPrefix,
      secretPrev:
        r.secretPrev !== null
          ? readWebhookSecret(r.secretPrev, this.secretEncryptionKeyBase64)
          : null,
      secretPrevExpiresAt: r.secretPrevExpiresAt,
      secretCreatedAt: r.secretCreatedAt,
      lastReminderSentAt: r.lastReminderSentAt,
      graceWindowEndsAt: r.graceWindowEndsAt,
      forceRotatedAt: r.forceRotatedAt,
      events: r.events,
      description: r.description,
      active: r.active,
      consecutiveFailures: r.consecutiveFailures,
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
      disabledAt: r.disabledAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      accountEmail: r.accountEmail,
    }));
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
          // Date interpolated directly — see docs/internal/
          // drizzle-date-param-workaround.md (a raw-sql Date param silently
          // crashes via drizzle's transparentParser OID swap; gt/lte handle
          // Date params correctly, matching findEndpointsNeedingForceRotation's
          // lt(...) sibling call above).
          gt(webhookEndpoints.graceWindowEndsAt, args.now),
          lte(webhookEndpoints.graceWindowEndsAt, horizon),
        ),
      )
      .orderBy(webhookEndpoints.graceWindowEndsAt)
      .limit(args.limit);
    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      url: r.url,
      secret: readWebhookSecret(r.secret, this.secretEncryptionKeyBase64),
      secretPrefix: r.secretPrefix,
      secretPrev:
        r.secretPrev !== null
          ? readWebhookSecret(r.secretPrev, this.secretEncryptionKeyBase64)
          : null,
      secretPrevExpiresAt: r.secretPrevExpiresAt,
      secretCreatedAt: r.secretCreatedAt,
      lastReminderSentAt: r.lastReminderSentAt,
      graceWindowEndsAt: r.graceWindowEndsAt,
      forceRotatedAt: r.forceRotatedAt,
      events: r.events,
      description: r.description,
      active: r.active,
      consecutiveFailures: r.consecutiveFailures,
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
      disabledAt: r.disabledAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      accountEmail: r.accountEmail,
    }));
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
    // Same legacy-upgrade fence as customer rotation: the SQL copy into
    // secret_prev must only ever copy an encrypted active value.
    await this.encryptEndpointLegacySecrets(input.id);
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
        secret: this.encryptForStorage(input.newSecret),
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
      .where(and(eq(webhookEndpoints.id, input.id), isNull(webhookEndpoints.disabledAt)))
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
          eq(webhookEndpoints.active, true),
          // events @> ARRAY[<eventType>] — every endpoint whose events array
          // contains the eventType.
          sql`${webhookEndpoints.events} @> ARRAY[${eventType}]::webhook_event_type[]`,
        ),
      );
    return rows.map((row) => toEndpointRow(row, this.secretEncryptionKeyBase64));
  }

  async claim(opts: { batchSize: number; now: Date }): Promise<WebhookDeliveryRow[]> {
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
      WITH claimed AS (
        SELECT id FROM webhook_deliveries
        WHERE (status = 'pending' AND next_attempt_at <= ${nowIso}::timestamptz)
           OR (status = 'in_flight' AND updated_at <= ${staleBeforeIso}::timestamptz)
        ORDER BY next_attempt_at ASC
        LIMIT ${opts.batchSize}
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
          consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
          lastFailureAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(webhookEndpoints.id, updated.webhookId));
    });
  }

  async recordDlq(
    deliveryId: string,
    opts: { responseStatus: number | null; lastError: string | null; at: Date },
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(webhookDeliveries)
        .set({
          status: 'dlq',
          lastResponseStatus: opts.responseStatus,
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
  return {
    id: r.id,
    accountId: r.accountId,
    url: r.url,
    secret: readWebhookSecret(r.secret, secretEncryptionKeyBase64),
    secretPrefix: r.secretPrefix,
    secretPrev:
      r.secretPrev !== null ? readWebhookSecret(r.secretPrev, secretEncryptionKeyBase64) : null,
    secretPrevExpiresAt: r.secretPrevExpiresAt,
    secretCreatedAt: r.secretCreatedAt,
    lastReminderSentAt: r.lastReminderSentAt,
    // Arc 3 sub-slice 28.1 (v2-#28) — force-rotation columns.
    graceWindowEndsAt: r.graceWindowEndsAt,
    forceRotatedAt: r.forceRotatedAt,
    events: r.events,
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
    eventType: r.eventType,
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
