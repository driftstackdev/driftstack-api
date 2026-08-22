// In-memory WebhooksRepo for integration tests.

import { randomUUID } from 'node:crypto';
import {
  decodeDeliveryCursor,
  encodeDeliveryCursor,
  type DeliveryCursor,
} from '../../../src/lib/keyset-cursor.js';
import { assertValidWebhookSecret } from '../../../src/lib/webhook-secret-encryption.js';
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
} from '../../../src/services/webhooks.js';
import { RECLAIM_STALE_IN_FLIGHT_MS } from '../../../src/db/webhooks-repo.js';

/** Mirror of DrizzleWebhooksRepo.deliveryKeysetCondition (#125): keep a delivery
 *  iff it sorts strictly AFTER the composite (created_at, id) cursor in DESC
 *  order. Legacy created_at-only cursor (id null) → created_at-only compare. */
function afterDeliveryCursor(r: WebhookDeliveryRow, cursor: DeliveryCursor | null): boolean {
  if (cursor === null) return true;
  const rt = r.createdAt.getTime();
  const ct = cursor.createdAt.getTime();
  if (cursor.id === null) return rt < ct;
  return rt < ct || (rt === ct && r.id < cursor.id);
}

/** (created_at DESC, id DESC) — mirrors the Drizzle orderBy tiebreak. */
function byCreatedThenIdDesc(a: WebhookDeliveryRow, b: WebhookDeliveryRow): number {
  const dt = b.createdAt.getTime() - a.createdAt.getTime();
  if (dt !== 0) return dt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// V-1274c — the three delivery-outcome writers FENCE on `in_flight`, matching the Drizzle repo's
// `.where(and(eq(id), eq(status, 'in_flight')))`. The worker only writes for a row it claimed, so a
// >5min-stalled worker's late `record*` must be a no-op once another tick has reclaimed and
// finalised that row. Without the fence a stale write resurrects a delivered row into DLQ and bumps
// the endpoint's failure counter toward the auto-disable threshold — which is the exact scenario
// the production comment says the fence exists to stop, and this double had no fence at all.
export class InMemoryWebhooksRepo implements WebhooksRepo {
  private readonly endpoints = new Map<string, WebhookEndpointRow>();
  private readonly deliveries = new Map<string, WebhookDeliveryRow>();

  insertEndpoint(input: NewWebhookEndpointInput): Promise<WebhookEndpointRow> {
    // V-1212 — the real repo refuses a secret that is not `whsec_` + 32 lowercase base32, so a
    // double accepting anything let unit tests build endpoints production would reject. Returned
    // as a REJECTION rather than a synchronous throw, because the Drizzle method is `async` and a
    // synchronous throw would need different handling at every call site — its own divergence.
    try {
      assertValidWebhookSecret(input.secret);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const now = new Date();
    const row: WebhookEndpointRow = {
      id: randomUUID(),
      accountId: input.accountId,
      url: input.url,
      secret: input.secret,
      secretPrefix: input.secretPrefix,
      secretPrev: null,
      secretPrevExpiresAt: null,
      secretCreatedAt: now,
      lastReminderSentAt: null,
      // Arc 3 sub-slice 28.1 (v2-#28) — server-initiated force-rotation
      // columns. Always null on fresh insert; sub-slice 28.2's daily
      // sweep populates them.
      graceWindowEndsAt: null,
      forceRotatedAt: null,
      events: input.events,
      description: input.description,
      active: true,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.endpoints.set(row.id, row);
    return Promise.resolve({ ...row });
  }

  insertEndpointIfUnderLimit(
    input: NewWebhookEndpointInput,
    limit: number,
  ): Promise<WebhookEndpointRow | null> {
    // Synchronous twin of the Drizzle advisory-lock atomic insert: count
    // active endpoints, refuse if at/over the cap, else insert. No await gap
    // here so there is no race to serialise (the lock matters only against a
    // real multi-connection Postgres — see db-webhooks-concurrency-drizzle).
    let active = 0;
    for (const r of this.endpoints.values()) {
      if (r.accountId === input.accountId && r.active) active += 1;
    }
    if (active >= limit) return Promise.resolve(null);
    return this.insertEndpoint(input);
  }

  listEndpoints(accountId: string): Promise<WebhookEndpointRow[]> {
    const rows = Array.from(this.endpoints.values())
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  deliveryCountsByEndpoint(accountId: string): Promise<Map<string, EndpointDeliveryCounts>> {
    const result = new Map<string, EndpointDeliveryCounts>();
    for (const d of this.deliveries.values()) {
      const ep = this.endpoints.get(d.webhookId);
      if (!ep || ep.accountId !== accountId) continue;
      const existing = result.get(d.webhookId) ?? { delivered: 0, failed: 0, dlq: 0 };
      if (d.status === 'delivered') existing.delivered += 1;
      else if (d.status === 'failed') existing.failed += 1;
      else if (d.status === 'dlq') existing.dlq += 1;
      result.set(d.webhookId, existing);
    }
    return Promise.resolve(result);
  }

  findEndpoint(id: string, accountId: string): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(id);
    if (!r || r.accountId !== accountId) return Promise.resolve(null);
    return Promise.resolve({ ...r });
  }

  findEndpointById(id: string): Promise<WebhookEndpointRow | null> {
    const row = this.endpoints.get(id);
    return Promise.resolve(row ? { ...row } : null);
  }

  countActiveEndpoints(accountId: string): Promise<number> {
    let n = 0;
    for (const r of this.endpoints.values()) {
      if (r.accountId === accountId && r.active) n += 1;
    }
    return Promise.resolve(n);
  }

  disableEndpoint(id: string, at: Date): Promise<void> {
    const r = this.endpoints.get(id);
    if (r) {
      this.endpoints.set(id, { ...r, active: false, disabledAt: at, updatedAt: at });
    }
    return Promise.resolve();
  }

  rotateSecret(input: {
    id: string;
    accountId: string;
    newSecret: string;
    newPrefix: string;
    graceExpiresAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(input.id);
    if (!r || r.accountId !== input.accountId || r.disabledAt !== null) {
      return Promise.resolve(null);
    }
    // V-359.G — mirror the Drizzle guard: a SECOND *customer* rotation
    // while a prior customer rotation is STILL inside its dual-sign grace
    // window must NOT clobber secret_prev (that would discard the ORIGINAL
    // secret the customer is still rolling). No-op: return the UNCHANGED
    // in-flight row. A server force-rotation window (forceRotatedAt set)
    // is exempt — the customer's escape-hatch rotation proceeds.
    if (
      r.secretPrevExpiresAt !== null &&
      r.secretPrevExpiresAt.getTime() > input.now.getTime() &&
      r.forceRotatedAt === null
    ) {
      return Promise.resolve({ ...r });
    }
    const updated: WebhookEndpointRow = {
      ...r,
      secret: input.newSecret,
      secretPrefix: input.newPrefix,
      // V-359.G.2 (Fable audit 2026-07-03) — mirror the Drizzle CASE: under a
      // still-live FORCE-rotation grace window the current `secret` is the
      // server's force-rotated value (customer got only the prefix, never
      // deployed it) while secret_prev holds the secret the customer actually
      // has live. Preserve that live secret in the grace slot instead of
      // clobbering it with the un-deployed force secret.
      secretPrev:
        r.forceRotatedAt !== null &&
        r.secretPrevExpiresAt !== null &&
        r.secretPrevExpiresAt.getTime() > input.now.getTime()
          ? r.secretPrev
          : r.secret,
      secretPrevExpiresAt: input.graceExpiresAt,
      secretCreatedAt: input.now,
      lastReminderSentAt: null,
      // Arc 3 sub-slice 28.7 (v2-#28) — reset force-rotation
      // bookkeeping so the 91-day clock restarts cleanly when the
      // customer rotates manually.
      forceRotatedAt: null,
      graceWindowEndsAt: null,
      updatedAt: input.now,
    };
    this.endpoints.set(input.id, updated);
    return Promise.resolve({ ...updated });
  }

  findEndpointsNeedingForceRotation(args: {
    now: Date;
    thresholdDays: number;
    limit: number;
  }): Promise<ReadonlyArray<WebhookEndpointRow & { accountEmail: string | null }>> {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const cutoff = new Date(args.now.getTime() - args.thresholdDays * MS_PER_DAY);
    const out: Array<WebhookEndpointRow & { accountEmail: string | null }> = [];
    for (const r of this.endpoints.values()) {
      if (r.disabledAt !== null) continue;
      if (r.forceRotatedAt !== null) continue;
      if (r.secretCreatedAt >= cutoff) continue;
      out.push({ ...r, accountEmail: null });
    }
    // V-1210 — mirrors DrizzleWebhooksRepo's `ORDER BY secret_created_at` BEFORE `limit`. Breaking
    // out of Map iteration at the limit filtered correctly and selected arbitrarily, so the
    // endpoints most overdue for rotation were the ones this could keep skipping. Order combined
    // with a limit is selection, not presentation.
    out.sort((a, b) => a.secretCreatedAt.getTime() - b.secretCreatedAt.getTime());
    return Promise.resolve(out.slice(0, args.limit));
  }

  forceRotateSecret(input: {
    id: string;
    newSecret: string;
    newPrefix: string;
    graceWindowEndsAt: Date;
    now: Date;
  }): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(input.id);
    if (!r || r.disabledAt !== null) return Promise.resolve(null);
    const updated: WebhookEndpointRow = {
      ...r,
      secret: input.newSecret,
      secretPrefix: input.newPrefix,
      secretPrev: r.secret,
      secretPrevExpiresAt: input.graceWindowEndsAt,
      graceWindowEndsAt: input.graceWindowEndsAt,
      forceRotatedAt: input.now,
      secretCreatedAt: input.now,
      lastReminderSentAt: null,
      updatedAt: input.now,
    };
    this.endpoints.set(input.id, updated);
    return Promise.resolve({ ...updated });
  }

  clearStaleSecretPrev(args: { now: Date }): Promise<{ cleared: number }> {
    let cleared = 0;
    for (const [id, r] of this.endpoints) {
      if (
        r.secretPrev !== null &&
        r.secretPrevExpiresAt !== null &&
        r.secretPrevExpiresAt.getTime() < args.now.getTime()
      ) {
        this.endpoints.set(id, {
          ...r,
          secretPrev: null,
          secretPrevExpiresAt: null,
        });
        cleared += 1;
      }
    }
    return Promise.resolve({ cleared });
  }

  updateEndpoint(input: {
    id: string;
    accountId: string;
    url?: string;
    events?: WebhookEventType[];
    description?: string | null;
    active?: boolean;
  }): Promise<WebhookEndpointRow | null> {
    const r = this.endpoints.get(input.id);
    if (!r || r.accountId !== input.accountId || r.disabledAt !== null) {
      return Promise.resolve(null);
    }
    const updated: WebhookEndpointRow = {
      ...r,
      url: input.url !== undefined ? input.url : r.url,
      events: input.events !== undefined ? input.events : r.events,
      description: input.description !== undefined ? input.description : r.description,
      active: input.active !== undefined ? input.active : r.active,
      updatedAt: new Date(),
    };
    this.endpoints.set(input.id, updated);
    return Promise.resolve({ ...updated });
  }

  enqueueDelivery(input: NewWebhookDeliveryInput): Promise<string> {
    const now = new Date();
    const row: WebhookDeliveryRow = {
      id: randomUUID(),
      webhookId: input.webhookId,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.nextAttemptAt ?? now,
      lastResponseStatus: null,
      lastResponseExcerpt: null,
      lastError: null,
      deliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deliveries.set(row.id, row);
    return Promise.resolve(row.id);
  }

  listEndpointsSubscribedTo(
    accountId: string,
    eventType: WebhookEventType,
  ): Promise<WebhookEndpointRow[]> {
    const rows = Array.from(this.endpoints.values()).filter(
      (r) => r.accountId === accountId && r.active && r.events.includes(eventType),
    );
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  claim(opts: { batchSize: number; now: Date }): Promise<WebhookDeliveryRow[]> {
    // V-1269 — eligible means pending-and-due OR a STALE in_flight row, matching
    // DrizzleWebhooksRepo. A worker that crashes mid-batch leaves rows `in_flight` with no live
    // worker on them; production re-claims those once `updatedAt` is older than
    // RECLAIM_STALE_IN_FLIGHT_MS, and without that here a stuck delivery is stuck forever — so
    // any test of crash recovery against this double asserted the opposite of production.
    const staleBefore = opts.now.getTime() - RECLAIM_STALE_IN_FLIGHT_MS;
    const eligible = Array.from(this.deliveries.values())
      .filter(
        (r) =>
          (r.status === 'pending' && r.nextAttemptAt.getTime() <= opts.now.getTime()) ||
          (r.status === 'in_flight' && r.updatedAt.getTime() < staleBefore),
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, opts.batchSize);
    for (const r of eligible) {
      this.deliveries.set(r.id, { ...r, status: 'in_flight', updatedAt: opts.now });
    }
    return Promise.resolve(eligible.map((r) => ({ ...r, status: 'in_flight' as const })));
  }

  recordDelivered(deliveryId: string, opts: { responseStatus: number; at: Date }): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (!row || row.status !== 'in_flight') return Promise.resolve();
    this.deliveries.set(deliveryId, {
      ...row,
      status: 'delivered',
      lastResponseStatus: opts.responseStatus,
      deliveredAt: opts.at,
      updatedAt: opts.at,
    });
    const ep = this.endpoints.get(row.webhookId);
    if (ep) {
      this.endpoints.set(ep.id, {
        ...ep,
        consecutiveFailures: 0,
        lastSuccessAt: opts.at,
        updatedAt: opts.at,
      });
    }
    return Promise.resolve();
  }

  recordRetry(
    deliveryId: string,
    opts: {
      responseStatus: number | null;
      responseExcerpt: string | null;
      lastError: string | null;
      attempts: number;
      nextAttemptAt: Date;
    },
  ): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (!row || row.status !== 'in_flight') return Promise.resolve();
    this.deliveries.set(deliveryId, {
      ...row,
      status: 'pending',
      attempts: opts.attempts,
      nextAttemptAt: opts.nextAttemptAt,
      lastResponseStatus: opts.responseStatus,
      lastResponseExcerpt: opts.responseExcerpt,
      lastError: opts.lastError,
      updatedAt: new Date(),
    });
    const ep = this.endpoints.get(row.webhookId);
    if (ep) {
      this.endpoints.set(ep.id, {
        ...ep,
        // NOT consecutiveFailures, and the reason is the whole finding. That counter is a
        // per-DELIVERY signal the docs tell customers to watch — "auto-disabled after 50
        // consecutive failed deliveries" — and a retry is an ATTEMPT within ONE delivery.
        // Production stopped incrementing here because with MAX_ATTEMPTS at 6 it counted a single
        // failed delivery up to six times, tombstoning an endpoint after roughly nine failed
        // deliveries instead of fifty, permanently and roughly 6x sooner than the customer was
        // told. This double kept the pre-fix behaviour, so every worker test standing on it was
        // calibrated against a counter production does not keep. recordDlq owns the increment.
        lastFailureAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  recordDlq(
    deliveryId: string,
    opts: { responseStatus: number | null; lastError: string | null; at: Date },
  ): Promise<void> {
    const row = this.deliveries.get(deliveryId);
    if (!row || row.status !== 'in_flight') return Promise.resolve();
    this.deliveries.set(deliveryId, {
      ...row,
      status: 'dlq',
      lastResponseStatus: opts.responseStatus,
      lastError: opts.lastError,
      updatedAt: opts.at,
    });
    const ep = this.endpoints.get(row.webhookId);
    if (ep) {
      this.endpoints.set(ep.id, {
        ...ep,
        consecutiveFailures: ep.consecutiveFailures + 1,
        lastFailureAt: opts.at,
        updatedAt: opts.at,
      });
    }
    return Promise.resolve();
  }

  findDeliveryById(deliveryId: string): Promise<WebhookDeliveryRow | null> {
    const row = this.deliveries.get(deliveryId);
    return Promise.resolve(row ? { ...row } : null);
  }

  listDlqDeliveries(opts: {
    limit: number;
    cursor?: string;
    endpointId?: string;
  }): Promise<ListDeliveriesPage> {
    // Composite (created_at, id) keyset — mirrors the Drizzle repo (#125).
    const cursor = decodeDeliveryCursor(opts.cursor);
    const all = Array.from(this.deliveries.values())
      .filter((r) => r.status === 'dlq')
      .filter((r) => afterDeliveryCursor(r, cursor))
      // V-512 — drill-down filter on endpoint id (the row's
      // webhookId is the foreign key into webhook_endpoints).
      .filter((r) => (opts.endpointId ? r.webhookId === opts.endpointId : true))
      .sort(byCreatedThenIdDesc);
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? encodeDeliveryCursor(last.createdAt, last.id) : null,
    });
  }

  countDlqDeliveries(): Promise<number> {
    let cnt = 0;
    for (const r of this.deliveries.values()) {
      if (r.status === 'dlq') cnt++;
    }
    return Promise.resolve(cnt);
  }

  // Mirrors the Drizzle repo's in_flight fence: a row a worker
  // currently has claimed (status='in_flight') can't be reset out
  // from under it — see the long comment on the Drizzle
  // implementation for why this fences OUT in_flight rather than
  // fencing IN status='dlq' (replay paths intentionally reset
  // non-DLQ rows too).
  resetDeliveryToPending(deliveryId: string, at: Date): Promise<WebhookDeliveryRow | null> {
    const row = this.deliveries.get(deliveryId);
    if (!row || row.status === 'in_flight') return Promise.resolve(null);
    const updated: WebhookDeliveryRow = {
      ...row,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      lastResponseStatus: null,
      lastResponseExcerpt: null,
      lastError: null,
      deliveredAt: null,
      updatedAt: at,
    };
    this.deliveries.set(deliveryId, updated);
    return Promise.resolve({ ...updated });
  }

  // 2026-05-22 — hard-delete a DLQ row. Mirrors the Drizzle repo's
  // status='dlq' precondition: matches by id AND status so a
  // concurrent state change can't accidentally drop an active
  // delivery in tests.
  deleteDelivery(deliveryId: string): Promise<boolean> {
    const row = this.deliveries.get(deliveryId);
    if (!row || row.status !== 'dlq') return Promise.resolve(false);
    this.deliveries.delete(deliveryId);
    return Promise.resolve(true);
  }

  listDeliveriesForEndpoint(
    endpointId: string,
    accountId: string,
    opts: { limit: number; cursor?: string; status?: WebhookDeliveryStatus },
  ): Promise<ListDeliveriesPage> {
    const ep = this.endpoints.get(endpointId);
    if (!ep || ep.accountId !== accountId) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    // Composite (created_at, id) keyset — mirrors the Drizzle repo (#125).
    const cursor = decodeDeliveryCursor(opts.cursor);
    const all = Array.from(this.deliveries.values())
      .filter((r) => r.webhookId === endpointId)
      .filter((r) => afterDeliveryCursor(r, cursor))
      .filter((r) => (opts.status ? r.status === opts.status : true))
      .sort(byCreatedThenIdDesc);
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? encodeDeliveryCursor(last.createdAt, last.id) : null,
    });
  }

  /** Test helper: read all delivery rows. */
  /**
   * Test-only — age an endpoint's secret. NOT on WebhooksRepo.
   *
   * V-1285 — `webhook-secret-force-rotation` used to backdate by mutating the row `findEndpoint`
   * handed back, under a comment saying the fixture "stores rows by reference; mutate in place".
   * That is an arrangement Postgres cannot support: a SELECT returns a copy, so the same test
   * against the real repo would age nothing and rotate nothing. The seam does the write the
   * fixture actually needs, and leaves the interface read free to return a snapshot.
   */
  backdateSecretCreatedAt(id: string, at: Date): void {
    const row = this.endpoints.get(id);
    if (row) this.endpoints.set(id, { ...row, secretCreatedAt: at });
  }

  getAllDeliveries(): WebhookDeliveryRow[] {
    return Array.from(this.deliveries.values());
  }
}
