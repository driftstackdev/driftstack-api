// V-164 — first real implementation of @driftstack/webhook-delivery.
//
// Distinct from V-144's mock (which short-circuits every enqueue to
// `delivered`): this implementation actually exercises the retry
// curve, the state machine (pending → in_flight → delivered | dlq),
// signature signing, and DLQ promotion. Storage is in-memory
// (Map-backed) — sufficient for unit tests, GUI-client integration
// tests, and small self-hosted single-process workloads.
//
// What it does NOT do (out of scope for V-164):
//   - Persistence across process restarts (Postgres-backed impl
//     drops in behind the same interface — see V-144 V-log Next).
//   - SELECT...FOR UPDATE SKIP LOCKED concurrency (single-process).
//   - Cross-region replication.
//
// Backoff curve mirrors apps/server/src/services/webhook-worker.ts:
// 1min / 5min / 15min / 30min / 60min between attempts. Max 5
// retries (6 attempts total including initial); 6th failure → DLQ.

import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  DlqManager,
  EnqueueDeliveryOpts,
  ListDeliveriesOpts,
  ListDeliveriesPage,
  RequeueDlqOpts,
  WebhookDeliveryService,
} from './interfaces.js';
import type {
  DeliveryAttempt,
  DeliveryEndpoint,
  DeliveryPayload,
  DeliveryRecord,
  DeliveryStatus,
  DlqEntry,
} from './types.js';

/** Backoff schedule matching apps/server/src/services/webhook-worker.ts. */
export const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = {
  1: 60_000,
  2: 5 * 60_000,
  3: 15 * 60_000,
  4: 30 * 60_000,
  5: 60 * 60_000,
};

/** Default per-attempt delivery timeout (10s). */
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Default max attempts before DLQ. */
export const DEFAULT_MAX_ATTEMPTS = 6; // initial + 5 retries (backoff[5] = 60 min); DLQ on the 6th
const RESPONSE_READ_MAX_BYTES = 64 * 1024;
const RESPONSE_EXCERPT_MAX_CHARS = 200;
const TRANSPORT_ERROR_MAX_CHARS = 500;
const TRANSPORT_TOKEN_RE =
  /([?&#](?:ds_token|access_token|refresh_token|id_token|api_key|apikey|client_secret|token|secret|password|signature|code)=)[^&\s"'`]+/gi;
const TRANSPORT_BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const TRANSPORT_BASIC_RE = /(basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi;
const TRANSPORT_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]+@/gi;
/**
 * Default cap on `store.dlq`'s size (WD-4, LOW-severity audit finding,
 * 2026-07). Without a cap, an endpoint that fails forever accumulates one DLQ
 * row per event, unbounded, for the life of the process. Oldest-evicted (same
 * convention as `apps/server/src/services/session-page-state-store.ts` /
 * `session-liveness-store.ts`) once the cap is exceeded. 10,000 is chosen as
 * "clearly generous for a self-hosted single-process workload" — a
 * permanently-broken endpoint would need ten thousand distinct failed events
 * before the oldest postmortem row starts rotating out; that's already a
 * signal the endpoint should have been disabled long before this cap matters.
 *
 * Deliberately NOT a circuit-breaker: this bounds MEMORY only. There is still
 * no logic that tracks an endpoint's repeated terminal failures across
 * separate deliveries to auto-disable it — every new event for a
 * permanently-broken endpoint is independently retried to exhaustion and
 * DLQ'd. That auto-disable gap is a real, separate feature (a design
 * decision, not a bug fix) and is intentionally left undone here — tracked as
 * a known follow-up, not silently dropped.
 */
export const DEFAULT_MAX_DLQ_ENTRIES = 10_000;

export interface InMemoryWebhookDeliveryDeps {
  /**
   * Test seam — defaults to plain `globalThis.fetch`.
   *
   * ⚠️ PRODUCTION CALLERS MUST INJECT AN SSRF-GUARDED FETCH. The plain-fetch
   * default has NO protection against DNS rebinding (a hostname that resolves
   * to a public address at endpoint-registration time but to a
   * private/loopback/metadata address by the time a retry fires — up to an
   * hour-plus later per `BACKOFF_MS_BY_ATTEMPT` — connects straight to it).
   * This package is a dependency-free library (`packages/*` cannot import
   * from `apps/server`), so it cannot ship that guard itself. The default
   * here is for TESTS AND LOCAL DEV ONLY. Production wiring must pass a
   * connect-time-guarded implementation — e.g. `apps/server`'s
   * `ssrfGuardedFetch` (`apps/server/src/lib/ssrf-guarded-fetch.ts`), which
   * classifies/rejects private/reserved resolved addresses via a custom
   * undici dispatcher at the actual TCP-connect DNS lookup. As cheap
   * defense-in-depth against the narrower "customer registers a URL with a
   * literal internal IP" case, every send is also checked against
   * {@link isLiteralUnsafeWebhookHost} regardless of which `fetch` is
   * injected — but that check is NOT a DNS-rebind fix; it only catches a
   * literal IP in the URL itself.
   */
  fetch?: typeof fetch;
  /** Test seam — defaults to () => Date.now(). */
  now?: () => number;
  /** Lookup an endpoint by id. The delivery service does not own endpoint storage. */
  getEndpoint: (endpointId: string) => DeliveryEndpoint | null;
  /**
   * Cap on the number of DLQ entries retained in memory. Defaults to
   * {@link DEFAULT_MAX_DLQ_ENTRIES}. Oldest entry is evicted once the cap is
   * exceeded. See {@link DEFAULT_MAX_DLQ_ENTRIES}'s doc comment for the
   * reasoning + the explicitly-deferred auto-disable/circuit-breaker gap.
   */
  maxDlqEntries?: number;
}

/**
 * Outcome of one process() tick. Returned for test inspection.
 */
export interface ProcessTickResult {
  /** Records pulled this tick. */
  pulled: number;
  /** Records that succeeded (status → delivered). */
  delivered: number;
  /** Records that failed but stayed in the queue (retry scheduled). */
  retried: number;
  /** Records that hit max attempts and entered DLQ. */
  dlqed: number;
}

interface QueueEntry {
  record: DeliveryRecord;
  endpointId: string;
  /** Cached for fast access in deliver(). */
  accountId: string;
  /** Lease expiry — null when not currently in_flight. */
  leasedUntilMs: number | null;
}

/**
 * Shared state between InMemoryWebhookDeliveryService + InMemoryDlqManager.
 * The two services hold the same maps so that DLQ promotion in delivery
 * is visible to the DLQ admin surface, and replay() / requeue() can
 * round-trip between them.
 *
 * Construct via {@link createInMemoryWebhookDelivery} which returns the
 * pair already wired against the same shared store.
 */
export interface SharedDeliveryStore {
  queue: Map<string, QueueEntry>;
  dlq: Map<string, DlqEntry>;
  /** Test-visible shared id counter for stable ids across calls. */
  idCounter: { value: number };
}

export interface InMemoryWebhookDeliveryHandles {
  deliveries: InMemoryWebhookDeliveryService;
  dlq: InMemoryDlqManager;
  /** Process one tick of the delivery loop. */
  processTick(opts?: { batchSize?: number; leaseDurationMs?: number }): Promise<ProcessTickResult>;
}

/**
 * Construct an in-memory webhook delivery system. Returns the
 * WebhookDeliveryService + DlqManager pair plus a `processTick`
 * method that drives the delivery loop one batch at a time.
 *
 * Production deployments would replace this with a Postgres-backed
 * implementation behind the same two interfaces.
 */
export function createInMemoryWebhookDelivery(
  deps: InMemoryWebhookDeliveryDeps,
): InMemoryWebhookDeliveryHandles {
  const store: SharedDeliveryStore = {
    queue: new Map(),
    dlq: new Map(),
    idCounter: { value: 0 },
  };
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const now = deps.now ?? (() => Date.now());
  const maxDlqEntries = deps.maxDlqEntries ?? DEFAULT_MAX_DLQ_ENTRIES;

  const deliveries = new InMemoryWebhookDeliveryService(store, deps.getEndpoint, now);
  const dlq = new InMemoryDlqManager(store, deps.getEndpoint, now);
  const worker = new DeliveryWorker(store, deps.getEndpoint, fetchFn, now, maxDlqEntries);

  return {
    deliveries,
    dlq,
    processTick: (opts) => worker.processTick(opts),
  };
}

/**
 * Implementation of {@link WebhookDeliveryService} backed by the in-memory
 * shared store. Use {@link createInMemoryWebhookDelivery} rather than
 * constructing directly — that wires the matching DlqManager + worker.
 */
export class InMemoryWebhookDeliveryService implements WebhookDeliveryService {
  constructor(
    private readonly store: SharedDeliveryStore,
    private readonly getEndpoint: (endpointId: string) => DeliveryEndpoint | null,
    private readonly now: () => number,
  ) {}

  // ────────────── WebhookDeliveryService ──────────────

  enqueue(opts: EnqueueDeliveryOpts): Promise<DeliveryRecord> {
    const id = nextId(this.store);
    const now = this.now();
    const record: DeliveryRecord = {
      id,
      endpointId: opts.endpoint.id,
      payload: opts.payload,
      status: 'pending',
      attempts: [],
      nextAttemptAtMs: now,
      createdAtMs: now,
      completedAtMs: null,
    };
    this.store.queue.set(id, {
      record,
      endpointId: opts.endpoint.id,
      accountId: opts.endpoint.accountId,
      leasedUntilMs: null,
    });
    return Promise.resolve(record);
  }

  get(deliveryId: string): Promise<DeliveryRecord | null> {
    const entry = this.store.queue.get(deliveryId);
    return Promise.resolve(entry?.record ?? null);
  }

  list(opts: ListDeliveriesOpts): Promise<ListDeliveriesPage> {
    const limit = Math.min(opts.limit ?? 50, 200);
    let entries = Array.from(this.store.queue.values()).filter(
      (e) => e.endpointId === opts.endpointId,
    );
    if (opts.status !== undefined) {
      entries = entries.filter((e) => e.record.status === opts.status);
    }
    // Newest-first ordering by createdAtMs; ties broken by id.
    entries.sort((a, b) => {
      if (a.record.createdAtMs !== b.record.createdAtMs) {
        return b.record.createdAtMs - a.record.createdAtMs;
      }
      return a.record.id.localeCompare(b.record.id);
    });
    if (opts.cursor !== undefined) {
      const idx = entries.findIndex((e) => e.record.id === opts.cursor);
      if (idx >= 0) entries = entries.slice(idx + 1);
    }
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page[page.length - 1]?.record.id ?? null) : null;
    return Promise.resolve({
      data: page.map((e) => e.record),
      nextCursor,
    });
  }

  replay(deliveryId: string): Promise<DeliveryRecord> {
    return Promise.resolve(replayShared(this.store, this.getEndpoint, this.now, deliveryId));
  }
}

/**
 * Implementation of {@link DlqManager} backed by the in-memory shared store.
 * Use {@link createInMemoryWebhookDelivery} rather than constructing directly.
 */
export class InMemoryDlqManager implements DlqManager {
  constructor(
    private readonly store: SharedDeliveryStore,
    private readonly getEndpoint: (endpointId: string) => DeliveryEndpoint | null,
    private readonly now: () => number,
  ) {}

  list(opts: {
    accountId?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ data: readonly DlqEntry[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    let entries = Array.from(this.store.dlq.values());
    if (opts.accountId !== undefined) {
      entries = entries.filter((e) => e.accountId === opts.accountId);
    }
    entries.sort((a, b) => b.enteredDlqAtMs - a.enteredDlqAtMs);
    if (opts.cursor !== undefined) {
      const idx = entries.findIndex((e) => e.deliveryId === opts.cursor);
      if (idx >= 0) entries = entries.slice(idx + 1);
    }
    const page = entries.slice(0, limit);
    const nextCursor = entries.length > limit ? (page[page.length - 1]?.deliveryId ?? null) : null;
    return Promise.resolve({ data: page, nextCursor });
  }

  get(deliveryId: string): Promise<DlqEntry | null> {
    return Promise.resolve(this.store.dlq.get(deliveryId) ?? null);
  }

  requeue(opts: RequeueDlqOpts): Promise<DeliveryRecord> {
    return Promise.resolve(replayShared(this.store, this.getEndpoint, this.now, opts.deliveryId));
  }

  discard(deliveryId: string): Promise<void> {
    this.store.dlq.delete(deliveryId);
    return Promise.resolve();
  }
}

/**
 * Shared replay path used by both WebhookDeliveryService.replay and
 * DlqManager.requeue. Re-arms an active queue record OR re-enqueues
 * a DLQ entry, preserving the attempt history for postmortem.
 */
function replayShared(
  store: SharedDeliveryStore,
  getEndpoint: (endpointId: string) => DeliveryEndpoint | null,
  now: () => number,
  deliveryId: string,
): DeliveryRecord {
  const entry = store.queue.get(deliveryId);
  if (entry !== undefined) {
    // WD-1 (HIGH, audit 2026-07) — status guard. Without this, replay()/
    // requeue() would unconditionally rewrite whatever's currently in the
    // queue — including a delivery that is `in_flight` RIGHT NOW (a live
    // outstanding HTTP attempt with an active lease). Clobbering that clears
    // the lease and re-arms the record as due-now, so the very next
    // processTick() re-claims it and fires a SECOND concurrent live HTTP POST
    // to the customer's endpoint (a real double-delivery), with both
    // concurrent attempts computing the same stale `attempts.length` and both
    // logging as `attempt: 1` — corrupting the attempt history the backoff/
    // maxAttempts accounting depends on. Per the WebhookDeliveryService.replay
    // doc (interfaces.ts), replay is scoped to a 'failed' or 'delivered'
    // delivery only — reject 'pending' (already queued; nothing to replay)
    // and 'in_flight' (live lease) outright rather than silently no-op.
    if (entry.record.status !== 'delivered' && entry.record.status !== 'failed') {
      throw new Error(
        `replay: delivery ${deliveryId} has status '${entry.record.status}' — replay is only ` +
          `allowed for 'failed' or 'delivered' deliveries ('in_flight' has a live attempt lease; ` +
          `'pending' is already queued)`,
      );
    }
    const replayed: DeliveryRecord = {
      ...entry.record,
      status: 'pending',
      attempts: entry.record.attempts,
      nextAttemptAtMs: now(),
      completedAtMs: null,
    };
    entry.record = replayed;
    entry.leasedUntilMs = null;
    return replayed;
  }
  const dlqEntry = store.dlq.get(deliveryId);
  if (dlqEntry !== undefined) {
    const endpoint = getEndpoint(dlqEntry.endpointId);
    if (endpoint === null) {
      throw new Error(`replay: endpoint ${dlqEntry.endpointId} not found`);
    }
    const reenqueued: DeliveryRecord = {
      id: dlqEntry.deliveryId,
      endpointId: dlqEntry.endpointId,
      payload: dlqEntry.payload,
      status: 'pending',
      attempts: dlqEntry.attempts,
      nextAttemptAtMs: now(),
      createdAtMs: now(),
      completedAtMs: null,
    };
    store.queue.set(dlqEntry.deliveryId, {
      record: reenqueued,
      endpointId: dlqEntry.endpointId,
      accountId: dlqEntry.accountId,
      leasedUntilMs: null,
    });
    store.dlq.delete(dlqEntry.deliveryId);
    return reenqueued;
  }
  throw new Error(`replay: delivery ${deliveryId} not found`);
}

function nextId(store: SharedDeliveryStore): string {
  store.idCounter.value += 1;
  return `wdl_${store.idCounter.value.toString().padStart(8, '0')}`;
}

/**
 * Internal worker — drives the delivery loop. Not exported. Production
 * deployments would replace this with a Postgres-backed worker that
 * uses SELECT...FOR UPDATE SKIP LOCKED for cross-process coordination.
 */
class DeliveryWorker {
  constructor(
    private readonly store: SharedDeliveryStore,
    private readonly getEndpoint: (endpointId: string) => DeliveryEndpoint | null,
    private readonly fetchFn: typeof fetch,
    private readonly now: () => number,
    private readonly maxDlqEntries: number,
  ) {}

  /**
   * Process up to `batchSize` due deliveries. Each delivery is sent
   * via fetch with the v1 signature. Outcome updates the record state
   * machine: 2xx → delivered; non-2xx / network / timeout → retry
   * (with backoff) or DLQ (if at max attempts).
   *
   * Lease pattern: claimed records get `leasedUntilMs = now + leaseMs`.
   * If the worker crashes mid-delivery, the lease expires and the
   * record is reclaimed by the next tick.
   */
  async processTick(
    opts: { batchSize?: number; leaseDurationMs?: number } = {},
  ): Promise<ProcessTickResult> {
    const batchSize = opts.batchSize ?? 25;
    const leaseDurationMs = opts.leaseDurationMs ?? 30_000;
    const now = this.now();

    const due = Array.from(this.store.queue.values())
      .filter((e) => {
        const pendingDue =
          e.record.status === 'pending' &&
          e.record.nextAttemptAtMs !== null &&
          e.record.nextAttemptAtMs <= now &&
          (e.leasedUntilMs === null || e.leasedUntilMs <= now);
        // V-173.R — reclaim a STUCK in_flight row whose lease has expired: the
        // worker that claimed it died/hung mid-delivery, so the delivery would
        // otherwise be lost (status stays in_flight, never re-pulled). The lease
        // (leaseDurationMs ≫ the per-attempt timeout) is the staleness signal.
        const stuckInFlight =
          e.record.status === 'in_flight' && e.leasedUntilMs !== null && e.leasedUntilMs <= now;
        return pendingDue || stuckInFlight;
      })
      .slice(0, batchSize);

    for (const entry of due) {
      entry.leasedUntilMs = now + leaseDurationMs;
      entry.record = { ...entry.record, status: 'in_flight' };
    }

    let delivered = 0;
    let retried = 0;
    let dlqed = 0;

    for (const entry of due) {
      const outcome = await this.deliver(entry);
      if (outcome === 'delivered') delivered++;
      else if (outcome === 'dlqed') dlqed++;
      else retried++;
    }

    return { pulled: due.length, delivered, retried, dlqed };
  }

  private async deliver(entry: QueueEntry): Promise<'delivered' | 'retried' | 'dlqed'> {
    const endpoint = this.getEndpoint(entry.endpointId);
    if (endpoint === null) {
      const attempt: DeliveryAttempt = {
        attempt: entry.record.attempts.length + 1,
        completedAtMs: this.now(),
        responseStatus: null,
        responseExcerpt: null,
        durationMs: 0,
        outcome: 'transport_error',
        errorMessage: 'endpoint not found at delivery time',
      };
      this.recordAttempt(entry, attempt, true);
      return 'dlqed';
    }

    // WD-3 (MEDIUM, audit 2026-07) — `endpoint.active` (types.ts) is documented
    // "Disabled endpoints skip the queue", but until now nothing here read it:
    // `deliver()` re-fetches the live endpoint every attempt (to pick up
    // current config) yet never inspected `.active`, so a disabled endpoint
    // kept retrying/DLQ'ing on its normal backoff curve like an active one.
    // Mirrors the endpoint-not-found branch above (same attempt shape,
    // immediate DLQ) — matches the sibling production worker's treatment
    // (apps/server/src/services/webhook-worker.ts), which treats
    // `!endpoint.active` the same as endpoint-not-found.
    if (!endpoint.active) {
      const attempt: DeliveryAttempt = {
        attempt: entry.record.attempts.length + 1,
        completedAtMs: this.now(),
        responseStatus: null,
        responseExcerpt: null,
        durationMs: 0,
        outcome: 'transport_error',
        errorMessage: 'endpoint disabled between enqueue and claim',
      };
      this.recordAttempt(entry, attempt, true);
      return 'dlqed';
    }

    const cfg = endpoint.config ?? {};
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxAttempts = cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    const startedMs = this.now();
    const attemptNumber = entry.record.attempts.length + 1;
    let attempt: DeliveryAttempt;

    try {
      const response = await this.fetchWithTimeout(endpoint, entry.record.payload, timeoutMs);
      const durationMs = this.now() - startedMs;
      attempt = {
        attempt: attemptNumber,
        completedAtMs: this.now(),
        responseStatus: response.status,
        responseExcerpt: response.excerpt,
        durationMs,
        outcome: response.ok ? 'success' : 'http_error',
        errorMessage: response.ok ? null : `HTTP ${response.status.toString()}`,
      };
    } catch (err) {
      const durationMs = this.now() - startedMs;
      const error = err instanceof Error ? err : new Error(String(err));
      const isTimeout = error.name === 'AbortError' || error.name === 'TimeoutError';
      attempt = {
        attempt: attemptNumber,
        completedAtMs: this.now(),
        responseStatus: null,
        responseExcerpt: null,
        durationMs,
        outcome: isTimeout ? 'timeout' : 'transport_error',
        errorMessage: safeTransportError(error),
      };
    }

    if (attempt.outcome === 'success') {
      this.recordAttempt(entry, attempt, false);
      return 'delivered';
    }
    if (attemptNumber >= maxAttempts) {
      this.recordAttempt(entry, attempt, true);
      return 'dlqed';
    }
    this.recordAttempt(entry, attempt, false);
    return 'retried';
  }

  private recordAttempt(entry: QueueEntry, attempt: DeliveryAttempt, toDlq: boolean): void {
    const newAttempts = [...entry.record.attempts, attempt];
    const now = this.now();

    if (attempt.outcome === 'success') {
      entry.record = {
        ...entry.record,
        status: 'delivered',
        attempts: newAttempts,
        nextAttemptAtMs: null,
        completedAtMs: now,
      };
      entry.leasedUntilMs = null;
      return;
    }

    if (toDlq) {
      const dlqEntry: DlqEntry = {
        deliveryId: entry.record.id,
        endpointId: entry.endpointId,
        accountId: entry.accountId,
        payload: entry.record.payload,
        totalAttempts: newAttempts.length,
        attempts: newAttempts,
        enteredDlqAtMs: now,
        reason: dlqReasonFromAttempts(newAttempts),
      };
      this.store.dlq.set(entry.record.id, dlqEntry);
      // WD-4 (LOW, audit 2026-07) — size-cap eviction. `store.dlq` is a plain
      // Map with no cap/TTL/pruning otherwise, so an endpoint that fails
      // forever would accumulate one row per event, unbounded, for the life
      // of the process. Oldest-evicted: Map iteration order is insertion
      // order, and dlq entries are only ever inserted here (never
      // re-inserted/reordered — requeue() deletes the entry outright rather
      // than re-adding it), so `.keys().next().value` is genuinely the
      // oldest-entered row. Same convention as
      // `apps/server/src/services/session-page-state-store.ts` /
      // `session-liveness-store.ts`. See DEFAULT_MAX_DLQ_ENTRIES's doc
      // comment: this bounds MEMORY only — auto-disabling a permanently-
      // failing endpoint (a circuit breaker) is a separate, intentionally
      // deferred feature, not addressed here.
      if (this.store.dlq.size > this.maxDlqEntries) {
        const oldest = this.store.dlq.keys().next().value;
        if (oldest !== undefined) this.store.dlq.delete(oldest);
      }
      entry.record = {
        ...entry.record,
        status: 'dlq',
        attempts: newAttempts,
        nextAttemptAtMs: null,
        completedAtMs: now,
      };
      this.store.queue.delete(entry.record.id);
      return;
    }

    const backoffMs = BACKOFF_MS_BY_ATTEMPT[attempt.attempt] ?? 60 * 60_000;
    const nextStatus: DeliveryStatus = 'pending';
    entry.record = {
      ...entry.record,
      status: nextStatus,
      attempts: newAttempts,
      nextAttemptAtMs: now + backoffMs,
      completedAtMs: null,
    };
    entry.leasedUntilMs = null;
  }

  private async fetchWithTimeout(
    endpoint: DeliveryEndpoint,
    payload: DeliveryPayload,
    timeoutMs: number,
  ): Promise<{ status: number; ok: boolean; excerpt: string | null }> {
    // WD-2 (MEDIUM, audit 2026-07) — cheap defense-in-depth pre-connect check,
    // independent of whichever `fetchFn` was injected: reject outright if the
    // endpoint URL's host is ITSELF a literal private/loopback/link-local IP
    // (e.g. a customer's registered URL is `https://169.254.169.254/steal`).
    // This is NOT a DNS-rebind fix — see isLiteralUnsafeWebhookHost's doc
    // comment + the loud warning on InMemoryWebhookDeliveryDeps.fetch for what
    // this does and doesn't cover, and why the full fix (connection-time IP
    // pinning) belongs in the injected fetch implementation, not this
    // dependency-free package.
    if (isLiteralUnsafeWebhookHost(endpoint.url)) {
      throw new Error(
        `SSRF defense-in-depth: refusing to deliver to ${endpoint.url} — host is a literal ` +
          `private/loopback/link-local IP address`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // #7 — sign with the CURRENT send time, not payload.emittedAtSec. The HMAC
      // timestamp must reflect when THIS attempt is sent: backoff can push a retry
      // an hour out, and the SDK's verifyWebhookSignature rejects timestamps
      // outside its tolerance window (default 300s). Re-stamping per attempt keeps
      // every retry's signature valid + matches the server worker (which signs
      // with Date.now() at delivery time).
      const sentAtSec = Math.floor(this.now() / 1000);
      const signature = signPayload(endpoint.signingSecret, payload, sentAtSec);
      const response = await this.fetchFn(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-driftstack-event-id': payload.eventId,
          'x-driftstack-event-type': payload.eventType,
          'x-driftstack-signature': signature,
        },
        body: payload.body,
        signal: controller.signal,
        // SSRF hardening — do NOT follow redirects. The endpoint URL is
        // customer-controlled and create-time validation only enforces
        // https://; following a 3xx would let `https://attacker → 30x →
        // http://169.254.169.254/` (or any internal target) bypass that
        // check. A well-behaved webhook receiver returns 2xx directly, so
        // a redirect surfaces as a failed attempt (matches Stripe). The
        // remaining direct-to-internal-IP / DNS-rebind layer is tracked in
        // docs/internal/2026-05-31-webhook-ssrf-outbound-target.md.
        redirect: 'error',
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { status: response.status, ok: true, excerpt: null };
      }
      return {
        status: response.status,
        ok: false,
        excerpt: await readResponseExcerpt(response),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readResponseExcerpt(response: Response): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let retainedBytes = 0;
  try {
    while (retainedBytes < RESPONSE_READ_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = RESPONSE_READ_MAX_BYTES - retainedBytes;
      const bytesToKeep = Math.min(value.byteLength, remaining);
      if (bytesToKeep > 0) {
        parts.push(decoder.decode(value.subarray(0, bytesToKeep), { stream: true }));
        retainedBytes += bytesToKeep;
      }
    }
    parts.push(decoder.decode());
    return parts.join('').slice(0, RESPONSE_EXCERPT_MAX_CHARS);
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function safeTransportError(error: Error): string {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'timeout';
  // This package deliberately has no apps/server dependency, so keep the
  // central redactText credential classes mirrored here and pinned by tests.
  const bounded = error.message.slice(0, TRANSPORT_ERROR_MAX_CHARS);
  return (
    bounded
      .replace(TRANSPORT_TOKEN_RE, '$1[redacted]')
      .replace(TRANSPORT_BEARER_RE, '$1[redacted]')
      .replace(TRANSPORT_BASIC_RE, '$1[redacted]')
      .replace(TRANSPORT_USERINFO_RE, '$1[redacted]@') || 'transport failure'
  ).slice(0, TRANSPORT_ERROR_MAX_CHARS);
}

/**
 * Build the canonical `x-driftstack-signature` header value:
 * Stripe-style `t=<sentAtSec>,v1=<hex>`, where the hex is
 * HMAC-SHA256 over `<sentAtSec>.<body>`. The single-header
 * `t=,v1=` shape is what the SDK's verifyWebhookSignature parses;
 * a bare hex would silently fail customer verification.
 *
 * #7 — `sentAtSec` defaults to `payload.emittedAtSec` for back-compat, but the
 * worker passes the CURRENT send time so each retry is re-stamped + re-signed.
 * The SDK rejects timestamps outside its tolerance window (default 300s), so a
 * retry that reuses the original emit time (backoff can be up to 60 min) would
 * fail verification. The timestamp + the HMAC use the SAME value, so the
 * customer's `<t>.<body>` recomputation always matches.
 */
export function signPayload(
  secret: string,
  payload: DeliveryPayload,
  sentAtSec: number = payload.emittedAtSec,
): string {
  const data = `${sentAtSec.toString()}.${payload.body}`;
  const hex = createHmac('sha256', secret).update(data, 'utf-8').digest('hex');
  return `t=${sentAtSec.toString()},v1=${hex}`;
}

function dlqReasonFromAttempts(attempts: readonly DeliveryAttempt[]): string {
  const last = attempts[attempts.length - 1]!;
  return `${attempts.length.toString()}× ${last.outcome}: ${last.errorMessage ?? '(no message)'}`;
}

/**
 * WD-2 (MEDIUM, audit 2026-07) — cheap, dependency-free, defense-in-depth
 * check: is `url`'s hostname ITSELF a literal private/loopback/link-local IP
 * address (or `localhost`)? Used by `DeliveryWorker.fetchWithTimeout` to
 * reject a send before ever calling the injected `fetchFn`, closing the
 * narrow "customer registers a URL with a literal internal IP" gap cheaply.
 *
 * Scope — read this before assuming it's "the" SSRF fix:
 *   - This is NOT a DNS-rebind defense. A HOSTNAME that resolves to a
 *     private/reserved address at delivery time (having been public when the
 *     endpoint was registered) sails straight through, because this never
 *     performs a DNS lookup — it only inspects the literal string in the URL.
 *     Closing that gap needs connection-time IP pinning in the actual fetch
 *     dispatcher (a bigger, dependency-heavier undertaking). Production
 *     callers close it by injecting a connect-time-guarded fetch — see the
 *     warning on {@link InMemoryWebhookDeliveryDeps.fetch}.
 *   - Deliberately minimal compared to the sibling
 *     `apps/server/src/lib/webhook-target-guard.ts` (which this package
 *     cannot import — `packages/*` has no dependency on `apps/server`): no
 *     `node:net` `BlockList`, no numeric/hex/octal IP-encoding detection, no
 *     IPv4-in-IPv6-embedding canonicalization. This package has no create-time
 *     endpoint-registration surface of its own (that validation lives in
 *     apps/server), so it only needs to catch the plain "URL host is a
 *     dotted-quad / standard IPv6 literal that's private/loopback/link-local"
 *     case as a cheap belt-and-suspenders check immediately before every send.
 */
export function isLiteralUnsafeWebhookHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false; // Unparseable URL — let the fetch call surface its own error.
  }
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost') return true;

  const family = isIP(host);
  if (family === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8 — "this host"
    if (a === 10) return true; // 10.0.0.0/8 — RFC1918 private
    if (a === 127) return true; // 127.0.0.0/8 — loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local / cloud metadata
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC1918 private
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  if (family === 6) {
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    if (host.startsWith('::ffff:')) return true; // IPv4-mapped (smuggles a private IPv4)
    if (host.startsWith('fe80:')) return true; // link-local
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique local (fc00::/7)
    return false;
  }
  return false; // A DNS name — resolved at connect time; out of scope here.
}
