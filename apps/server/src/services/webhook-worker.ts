// Webhook delivery worker.
//
// Long-running loop:
//   1. Claim pending deliveries whose nextAttemptAt is past — into a bounded
//      POOL: a slot that frees claims again at once (see `drain`)
//   2. For each: build the signed POST, send via fetch, observe response
//   3. On 2xx → recordDelivered (resets endpoint.consecutiveFailures)
//   4. On non-2xx / network / timeout → recordRetry (if attempts < MAX) or
//      recordDlq (if attempts == MAX). Only recordDlq bumps
//      endpoint.consecutiveFailures: that counter is a per-DELIVERY signal, and
//      a retry is an attempt WITHIN one delivery.
//   5. If endpoint.consecutiveFailures crosses the auto-disable threshold,
//      mark the endpoint disabled.
//   A delivery whose endpoint is PAUSED is deferred — back to pending, nothing
//   spent — and one whose endpoint is deleted is dead-lettered.
//
// The loop is process-local; in production we'd run one worker per app
// instance and rely on SELECT...FOR UPDATE SKIP LOCKED to coordinate
// (already in DrizzleWebhooksRepo.claim).

import type { Logger } from '../lib/logger.js';
import { sliceWithoutSplittingSurrogate } from '../lib/bounded-text.js';
import { METRIC_NAMES } from './metrics-registry.js';
import { redactText } from '../lib/redact-url.js';
import { signWebhookPayload } from '../lib/webhook-signing.js';
import { ssrfGuardedFetch } from '../lib/ssrf-guarded-fetch.js';
import {
  customerSafeWebhookPayload,
  unmappedEgressWarnings,
} from './customer-safe-egress-warnings.js';
import type { WebhookDeliveryRow, WebhookEndpointRow, WebhooksRepo } from './webhooks.js';

export interface WebhookWorkerConfig {
  repo: WebhooksRepo;
  logger: Logger;
  /** Override the global fetch (test seam). */
  fetch?: typeof fetch;
  /** Override sleep — useful for tight test loops. */
  sleep?: (ms: number) => Promise<void>;
  /** Override "now" — useful for deterministic backoff tests. */
  now?: () => Date;
  /**
   * Optional metrics registry.
   *
   * The webhook delivery counters were registered at boot and emitted ONLY from
   * DurableWebhookWorker, which is wired nowhere — so in production they could
   * never increment. A dashboard showed a flat zero, which is indistinguishable
   * from "no webhooks are configured", and a total delivery outage would have
   * produced no signal at all. This is the worker bootstrap actually runs.
   */
  metrics?: {
    inc: (name: string, labels?: Readonly<Record<string, string>>, delta?: number) => void;
  };
  /** Per-attempt delivery timeout (ms). Default 10s. */
  deliveryTimeoutMs?: number;
  /** Empty-claim sleep (ms). Default 2s. */
  idleSleepMs?: number;
  /**
   * Batch size per `tickOnce` claim, and the POOL size of `drain` — the most
   * deliveries in flight at once. Default 25.
   */
  batchSize?: number;
}

const MAX_ATTEMPTS = 6; // attempt indices 0..5 (initial + 5 retries); DLQ when the next index would be 6

/**
 * Backoff schedule per attempt-index AFTER a failure. Index = the next
 * attempt number (1 = first retry … 5 = fifth/last retry, scheduled
 * 60 min out). The next index after 5 is 6, which trips the DLQ boundary
 * instead of scheduling a 7th try.
 *   1: 1 min
 *   2: 5 min
 *   3: 15 min
 *   4: 30 min
 *   5: 60 min
 */
const BACKOFF_MS_BY_ATTEMPT: Record<number, number> = {
  1: 60_000,
  2: 5 * 60_000,
  3: 15 * 60_000,
  4: 30 * 60_000,
  5: 60 * 60_000,
};

const AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES = 50;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_SLEEP_MS = 2_000;
const DEFAULT_BATCH_SIZE = 25;
// `run()`'s drain bounds — the same ceilings bootstrap's poller pins at its call
// site (20 batches' worth of deliveries, and a budget well inside the 60 s poll).
const DEFAULT_DRAIN_MAX_DELIVERIES = 500;
const DEFAULT_DRAIN_BUDGET_MS = 30_000;
// Cap how much of a non-2xx response body we buffer for the failure excerpt.
// `response.text()` buffers the ENTIRE body before slicing — a misbehaving or
// malicious customer endpoint can stream a huge body, or a Content-Encoding
// decompression bomb (the undici advisory), exhausting memory within the
// delivery timeout. readExcerpt reads at most this many bytes off the decoded
// body stream then cancels, bounding memory by SIZE (the AbortController already
// bounds it by TIME). Outbound deliveries POST to UNTRUSTED customer endpoints,
// so this is a required defense for the wired worker.
const MAX_RESPONSE_READ_BYTES = 64 * 1024;
const EXCERPT_MAX_CHARS = 4096;
const TRANSPORT_ERROR_MAX_CHARS = 500;

/**
 * Drain the ready queue through a bounded POOL of delivery slots.
 *
 * Webhooks audit #2 (2026-09-24). This used to drive `tickOnce` batch by batch:
 * claim 25, `Promise.allSettled` them, claim the next 25. A batch lasted as long
 * as its SLOWEST delivery, so one endpoint answering 200 after ten seconds —
 * slow but succeeding, so never backed off, with a backlog whose rows are always
 * the oldest — set the length of every batch, and the 30 s budget ran about
 * three batches a minute instead of twenty, for every account on the
 * deployment. The audit measured it: with one 1.5 s endpoint and a 3 s budget,
 * 40 of 200 fast deliveries went out instead of all of them.
 *
 * Now each slot that frees claims again at once, so a straggler holds only its
 * own slots — and the claim counts an endpoint's deliveries already in flight
 * against its per-endpoint cap, so it never holds more than that share.
 *
 * Stop conditions:
 *   - a claim that comes back SHORT with nothing in flight means nothing is
 *     ready — the queue is drained. A short claim WHILE deliveries are in flight
 *     is not: the capped endpoints may become claimable as they settle, so the
 *     pool waits for a slot and claims again. (The claim returns fewer than asked
 *     whenever ready work is concentrated on few endpoints — the normal shape of
 *     a backlog — which is why a partial claim never ends the drain on its own.)
 *   - `maxDeliveries` bounds how many one drain claims, and `budgetMs` how long
 *     it keeps CLAIMING, so a hot queue cannot monopolise the process. Deliveries
 *     already started always run to their outcome (each is bounded by the
 *     per-attempt timeout) before the drain returns, so the caller's
 *     no-overlap guard still covers them.
 *
 * Cannot spin: every claimed row is marked in_flight and settles to delivered,
 * dlq, deferred (a paused endpoint, which the claim then skips) or pending with a
 * FUTURE next_attempt_at, so it leaves the ready set.
 *
 * @returns how many claims ran and how many deliveries they took in total.
 */
export async function drainWebhookDeliveries<T>(args: {
  /** Claim up to `slots` ready deliveries. */
  claim: (slots: number) => Promise<readonly T[]>;
  /** Deliver one claimed row to its outcome. A rejection is contained. */
  deliver: (row: T) => Promise<unknown>;
  /** Pool size: the most deliveries in flight at once. */
  concurrency: number;
  /** The most deliveries one drain claims. */
  maxDeliveries: number;
  /** Stop claiming once this much wall-clock time has passed. */
  budgetMs: number;
  now?: () => number;
  /** Told about a delivery that rejected despite its own error boundary. */
  onDeliverError?: (row: T, err: unknown) => void;
}): Promise<{ claims: number; claimed: number }> {
  const now = args.now ?? ((): number => Date.now());
  const startedAt = now();
  const inFlight = new Set<Promise<void>>();
  let claims = 0;
  let claimed = 0;

  const start = (row: T): void => {
    const slot: Promise<void> = Promise.resolve()
      .then(() => args.deliver(row))
      .then(
        () => undefined,
        (err: unknown) => {
          try {
            args.onDeliverError?.(row, err);
          } catch {
            // Reporting is best-effort; it must not strand the slot.
          }
        },
      )
      .finally(() => {
        inFlight.delete(slot);
      });
    inFlight.add(slot);
  };

  try {
    for (;;) {
      const free = args.concurrency - inFlight.size;
      const quota = args.maxDeliveries - claimed;
      const mayClaim = free > 0 && quota > 0 && now() - startedAt < args.budgetMs;
      if (mayClaim) {
        const want = Math.min(free, quota);
        const rows = await args.claim(want);
        claims += 1;
        claimed += rows.length;
        for (const row of rows) start(row);
        // Every slot asked for was filled: go round (the loop then waits for one to free).
        if (rows.length === want) continue;
        // Short, with nothing in flight: nothing is ready. The queue is drained.
        if (inFlight.size === 0) break;
      } else if (inFlight.size === 0) {
        // Out of budget or quota, and everything started has finished.
        break;
      }
      // Wait for a slot to free, then claim again.
      await Promise.race(inFlight);
    }
  } finally {
    // A claim that threw must not leave deliveries running past the drain: the
    // caller's no-overlap guard is released when this returns.
    await Promise.allSettled([...inFlight]);
  }
  return { claims, claimed };
}

export class WebhookDeliveryWorker {
  private running = false;

  constructor(private readonly config: WebhookWorkerConfig) {}

  /**
   * Start the loop. Returns when stop() is called.
   *
   * V-1389 — delegates instead of repeating claim-and-deliver. The two had drifted: this
   * loop still used `Promise.all`, the form V-781 replaced below because one escaping
   * rejection discards every other outcome in the tick, and it counted no metrics at all —
   * both delivery counters would have stayed flat under it.
   *
   * It delegates to `drain`, the pool bootstrap's poller runs (webhooks audit #2), rather
   * than to the batch `tickOnce`, for the same reason: nothing calls `run()` today, and it
   * is the obvious entry point for whoever wires this next — it must not bring back the
   * batch a single straggler can hold up.
   */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const sleep = this.config.sleep ?? defaultSleep;
    const idleSleepMs = this.config.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;

    while (this.running) {
      const { claimed } = await this.drain({
        maxDeliveries: DEFAULT_DRAIN_MAX_DELIVERIES,
        budgetMs: DEFAULT_DRAIN_BUDGET_MS,
      });
      if (claimed === 0) await sleep(idleSleepMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Drain the ready queue through a pool of `batchSize` delivery slots — what
   * bootstrap's poller runs. See `drainWebhookDeliveries` for why it is a pool
   * and when it stops. Every outcome is counted exactly as `tickOnce` counts it.
   */
  async drain(opts: {
    maxDeliveries: number;
    budgetMs: number;
  }): Promise<{ claims: number; claimed: number }> {
    return drainWebhookDeliveries<WebhookDeliveryRow>({
      claim: (slots) => this.config.repo.claim({ batchSize: slots, now: this.now() }),
      deliver: async (delivery) => {
        this.countOutcome(await this.deliver(delivery));
      },
      concurrency: this.config.batchSize ?? DEFAULT_BATCH_SIZE,
      maxDeliveries: opts.maxDeliveries,
      budgetMs: opts.budgetMs,
      onDeliverError: (delivery, err) => {
        this.config.logger.error(
          {
            deliveryId: delivery.id,
            err: { message: err instanceof Error ? err.message : String(err) },
          },
          'webhook delivery escaped its own error boundary — the drain continues',
        );
      },
    });
  }

  /**
   * Tick once: claim + deliver one BATCH synchronously. The production path is
   * `drain` (a pool); this remains for tests and one-shot callers, and it waits
   * for the batch's slowest delivery by construction.
   */
  async tickOnce(): Promise<{ claimed: number; outcomes: DeliveryOutcome[] }> {
    const claimed = await this.config.repo.claim({
      batchSize: this.config.batchSize ?? DEFAULT_BATCH_SIZE,
      now: this.now(),
    });
    // V-781 — allSettled, not all. `deliver` now has its own error boundary, so a rejection
    // here should be impossible; using allSettled means that if one ever does escape it costs
    // that single delivery rather than discarding every other outcome in the tick and skipping
    // the metrics entirely, which is what `Promise.all` did.
    const settled = await Promise.allSettled(claimed.map((d) => this.deliver(d)));
    const outcomes: DeliveryOutcome[] = [];
    for (const [i, r] of settled.entries()) {
      if (r.status === 'fulfilled') {
        outcomes.push(r.value);
        continue;
      }
      this.config.logger.error(
        {
          deliveryId: claimed[i]?.id,
          err: { message: r.reason instanceof Error ? r.reason.message : String(r.reason) },
        },
        'webhook delivery escaped its own error boundary — the batch continues',
      );
    }
    // Counted HERE rather than at each recordDelivered/recordRetry/recordDlq
    // call: every delivery funnels through this array exactly once, so one site
    // cannot drift out of step with another as the delivery paths change.
    for (const outcome of outcomes) this.countOutcome(outcome);
    return { claimed: claimed.length, outcomes };
  }

  /**
   * Record one delivery outcome on both counters.
   *
   * `attempt` carries every attempt; `terminal` only the states a delivery
   * stops in, so a DLQ rate can be read without subtracting retries from
   * attempts. Never throws — telemetry must not break delivery.
   */
  private countOutcome(outcome: DeliveryOutcome): void {
    const metrics = this.config.metrics;
    if (metrics === undefined) return;
    // A deferred delivery (paused endpoint) was not attempted at all.
    if (outcome.kind === 'deferred') return;
    try {
      const attemptOutcome = outcome.kind === 'delivered' ? 'success' : 'http_error';
      metrics.inc(METRIC_NAMES.webhookDeliveryAttemptTotal, { outcome: attemptOutcome });
      if (outcome.kind !== 'retry') {
        metrics.inc(METRIC_NAMES.webhookDeliveryTerminalTotal, {
          terminal_state: outcome.kind === 'delivered' ? 'delivered' : 'dlq',
        });
      }
    } catch {
      // Observability is allowed to be missing; it is not allowed to be
      // load-bearing for the delivery it observes.
    }
  }

  /**
   * V-781 — the per-delivery error boundary.
   *
   * `deliverInner` awaits several things BEFORE any `record*` write — the endpoint lookup
   * first. A throw there (an endpoint secret that will not decrypt under this process's key is
   * the realistic one) left the row `in_flight` with `attempts` UNCHANGED. `attempts` is written
   * only by `recordRetry`, so the row could never reach `nextAttemptIndex >= MAX_ATTEMPTS`,
   * never reach the DLQ, and never appear in the DLQ list. The >5-minute stale-reclaim arm then
   * re-claimed it and the same throw repeated — forever.
   *
   * Worse, it was not confined to that row: the batch used `Promise.all`, so one rejection
   * discarded every other delivery's outcome in the tick and skipped `countOutcome` entirely.
   * One undeliverable row silently degraded OTHER tenants' webhooks and the metrics that would
   * have shown it.
   *
   * The recovery must go through `recordRetry` / `recordDlq` rather than a raw UPDATE: both are
   * fenced on `status='in_flight'`, which is what keeps them safe against the stale-reclaim
   * overlap.
   */
  private async deliver(delivery: WebhookDeliveryRow): Promise<DeliveryOutcome> {
    try {
      return await this.deliverInner(delivery);
    } catch (err) {
      return await this.recoverFromUnexpectedThrow(delivery, err);
    }
  }

  /**
   * Apply the ordinary attempt budget to a delivery that threw before it could report an
   * outcome. Deliberately mirrors `handleOutcome`'s retry/DLQ split — same `attempts + 1`,
   * same MAX_ATTEMPTS boundary, same backoff table — so an unexpected failure ages out exactly
   * like an ordinary one instead of living forever.
   *
   * `maybeAutoDisable` is NOT called here: the endpoint may be precisely what could not be
   * loaded, and disabling an endpoint on the strength of an error we could not attribute to it
   * would punish a customer for our own decrypt failure.
   */
  private async recoverFromUnexpectedThrow(
    delivery: WebhookDeliveryRow,
    err: unknown,
  ): Promise<DeliveryOutcome> {
    const at = this.now();
    const lastError = `unexpected delivery error: ${err instanceof Error ? err.message : String(err)}`;
    const nextAttemptIndex = delivery.attempts + 1;

    try {
      if (nextAttemptIndex >= MAX_ATTEMPTS) {
        await this.config.repo.recordDlq(delivery.id, {
          responseStatus: null,
          responseExcerpt: null,
          lastError,
          at,
        });
        this.config.logger.error(
          {
            deliveryId: delivery.id,
            webhookId: delivery.webhookId,
            attempts: nextAttemptIndex,
            lastError,
          },
          'webhook delivery → DLQ after an unexpected error (max attempts)',
        );
        return { kind: 'dlq', delivery };
      }

      const backoffMs = BACKOFF_MS_BY_ATTEMPT[nextAttemptIndex] ?? 60_000;
      const jitterMs = Math.floor(Math.random() * backoffMs * 0.15);
      const nextAttemptAt = new Date(at.getTime() + backoffMs + jitterMs);
      await this.config.repo.recordRetry(delivery.id, {
        responseStatus: null,
        responseExcerpt: null,
        lastError,
        attempts: nextAttemptIndex,
        nextAttemptAt,
      });
      this.config.logger.error(
        {
          deliveryId: delivery.id,
          webhookId: delivery.webhookId,
          attempts: nextAttemptIndex,
          nextAttemptAt: nextAttemptAt.toISOString(),
          lastError,
        },
        'webhook delivery threw unexpectedly — scheduled for retry',
      );
      return { kind: 'retry', delivery, nextAttemptAt };
    } catch (writeErr) {
      // The recovery write itself failed. Nothing further is safe to do for this row — the
      // stale-reclaim will pick it up — but it must be loud, because this is the one path that
      // can still strand a delivery in_flight.
      this.config.logger.error(
        {
          deliveryId: delivery.id,
          webhookId: delivery.webhookId,
          originalError: lastError,
          err: { message: writeErr instanceof Error ? writeErr.message : String(writeErr) },
        },
        'webhook delivery error-boundary write FAILED — row stays in_flight for stale reclaim',
      );
      return { kind: 'retry', delivery, nextAttemptAt: at };
    }
  }

  private async deliverInner(delivery: WebhookDeliveryRow): Promise<DeliveryOutcome> {
    // Default to the SSRF-guarded fetch: outbound deliveries connect only to
    // public IPs (connection-time DNS pin via undici lookup, rejecting a
    // hostname that resolves to a private/internal target). Tests inject
    // config.fetch and bypass the dispatcher.
    const fetchImpl = this.config.fetch ?? ssrfGuardedFetch;
    const timeout = this.config.deliveryTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Look up the endpoint to get the current secret + active flag.
    // claim returns the delivery row but not the endpoint; we fetch the
    // endpoint by id (worker-only path, not account-scoped). Single SELECT
    // per delivery — could be batched in a future optimisation.
    const endpoint = await this.config.repo.findEndpointById(delivery.webhookId);

    // Fallback: endpoint deleted (or disabled after too many failures) between
    // enqueue and claim. Treat as DLQ — there's no recoverable path.
    if (!endpoint || endpoint.disabledAt !== null) {
      await this.config.repo.recordDlq(delivery.id, {
        responseStatus: null,
        responseExcerpt: null,
        lastError: 'endpoint disabled or deleted between enqueue and claim',
        at: this.now(),
      });
      this.config.logger.warn(
        { deliveryId: delivery.id, webhookId: delivery.webhookId },
        'webhook delivery → DLQ (endpoint missing/disabled)',
      );
      return { kind: 'dlq', delivery };
    }

    // Webhooks audit #3 — a PAUSED endpoint (active=false, disabled_at unset)
    // defers: the delivery goes back to pending with nothing spent — no
    // attempt, no failure counted toward auto-disable — and the claim leaves it
    // alone until the endpoint is resumed. This used to share the branch above,
    // so pausing "for maintenance", as the docs suggest, dead-lettered every
    // queued delivery and counted each one as a failed delivery; after resume
    // the first failure tombstoned the endpoint. The claim already skips a
    // paused endpoint's rows, so this catches only a pause that landed between
    // the claim and this lookup.
    if (!endpoint.active) {
      await this.config.repo.recordDeferred(delivery.id);
      this.config.logger.info(
        { deliveryId: delivery.id, webhookId: delivery.webhookId },
        'webhook delivery deferred (endpoint paused)',
      );
      return { kind: 'deferred', delivery };
    }

    // ⛔ THE LAST HOP IS WHERE "MAP ON THE WAY OUT" HAS TO HAPPEN for a webhook.
    // `delivery.payload` is a SERIALIZED COPY written at enqueue time, not a
    // value re-derived per read like `sessions.egress_capabilities` — so a
    // `session.egress_capability_changed` row enqueued before the public
    // vocabulary landed still holds the INTERNAL list, device-supplied
    // `safeguard_failed:<layer>` and all. Three paths re-send exactly that row:
    // the customer's own `POST /v1/webhook-deliveries/:id/replay`, an operator's
    // admin replay (which posts to the CUSTOMER's endpoint), and the ordinary
    // retry of a row that was pending when the mapping deployed. Mapping at the
    // enqueue call site reaches none of them; this reaches all three, and stands
    // as the second line for a future enqueue path that forgets to map.
    //
    // Unchanged by default: any other event type comes back as the same
    // reference and is serialized byte-identically.
    const safe = customerSafeWebhookPayload(delivery.eventType, delivery.payload);
    if (safe.unmapped.length > 0) {
      unmappedEgressWarnings.record(safe.unmapped, {
        warn: (obj, msg) => {
          this.config.logger.warn(obj, msg);
        },
      });
    }
    const body = JSON.stringify(safe.payload);
    // v2-#20 — Honour the rotation grace window. When the customer
    // rotates via POST /v1/webhooks/:id/rotate-secret, the old secret
    // is parked at `secretPrev` with `secretPrevExpiresAt` = now +
    // graceMs. Outbound deliveries during the window MUST dual-sign so
    // the customer's verifier (still configured with the old secret)
    // accepts the payload while they roll the new secret across their
    // infra. Past expiry, we stop emitting the prev signature so a
    // stale leaked secret can no longer authenticate replays.
    const nowMs = this.now().getTime();
    const dualSign =
      endpoint.secretPrev !== null &&
      endpoint.secretPrevExpiresAt !== null &&
      endpoint.secretPrevExpiresAt.getTime() > nowMs;
    const sigHeader = signWebhookPayload({
      body,
      secret: endpoint.secret,
      ...(dualSign && endpoint.secretPrev !== null ? { secretPrev: endpoint.secretPrev } : {}),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // V-093: wall-clock duration of the actual fetch call. Excludes
    // body serialization + signing (negligible) but includes DNS +
    // TCP + TLS + HTTP exchange. Reported via Date.now() rather than
    // perf.now() because we already use Date for this.now() and the
    // reporting precision is ~1ms which is fine.
    const fetchStartMs = Date.now();
    let response: Response | null = null;
    let networkError: Error | null = null;
    let responseExcerpt: string | null = null;
    try {
      response = await fetchImpl(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-driftstack-signature': sigHeader,
          'x-driftstack-event-id': delivery.eventId,
          'x-driftstack-event-type': delivery.eventType,
          'user-agent': 'driftstack-webhooks/1.0',
        },
        body,
        signal: controller.signal,
        // SSRF hardening — do NOT follow redirects to a customer-controlled
        // endpoint (create-time validation only enforces https://; a 3xx to
        // an internal target like http://169.254.169.254 would bypass it).
        // A 30x surfaces as a failed delivery. See
        // the internal 2026-05-31 webhook SSRF outbound-target notes.
        redirect: 'error',
      });
      // Read the failure-response excerpt HERE, before the finally clears the
      // abort timer — `response.text()` streams the body, and a malicious /
      // misbehaving endpoint can send headers then stall the body indefinitely.
      // Done in handleOutcome (post-clearTimeout) the read was bounded only by
      // undici's ~300s default, not our `timeout`, tying up a delivery slot.
      // Inside the try the same AbortController.signal that bounds the fetch
      // also bounds the body read; readExcerpt swallows the resulting AbortError
      // → null excerpt, and the non-2xx response is still recorded as a failure.
      // A 2xx body is irrelevant, but it still MUST be cancelled while the
      // timer is armed. Leaving it unread lets a customer return success
      // headers plus an endless body and retain a socket after we record the
      // delivery as complete.
      if (!response.ok) {
        responseExcerpt = await readExcerpt(response);
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch (err) {
      networkError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - fetchStartMs;

    return this.handleOutcome(
      delivery,
      endpoint,
      response,
      responseExcerpt,
      networkError,
      durationMs,
    );
  }

  private async handleOutcome(
    delivery: WebhookDeliveryRow,
    endpoint: WebhookEndpointRow,
    response: Response | null,
    responseExcerpt: string | null,
    networkError: Error | null,
    durationMs: number,
  ): Promise<DeliveryOutcome> {
    const at = this.now();

    if (response && response.ok) {
      await this.config.repo.recordDelivered(delivery.id, {
        responseStatus: response.status,
        at,
      });
      this.config.logger.info(
        {
          deliveryId: delivery.id,
          webhookId: endpoint.id,
          status: response.status,
          attempt: delivery.attempts + 1,
          duration_ms: durationMs,
        },
        'webhook delivered',
      );
      return { kind: 'delivered', delivery, status: response.status };
    }

    const responseStatus = response?.status ?? null;
    const lastError = networkError ? safeTransportError(networkError) : null;

    const nextAttemptIndex = delivery.attempts + 1;

    if (nextAttemptIndex >= MAX_ATTEMPTS) {
      await this.config.repo.recordDlq(delivery.id, {
        responseStatus,
        // Webhooks audit #8 — the final attempt's body with the final
        // attempt's status; without it the DLQ row kept an earlier attempt's.
        responseExcerpt,
        lastError,
        at,
      });
      this.config.logger.warn(
        {
          deliveryId: delivery.id,
          webhookId: endpoint.id,
          status: responseStatus,
          attempts: nextAttemptIndex,
          lastError,
          duration_ms: durationMs,
        },
        'webhook delivery → DLQ (max attempts)',
      );
      // Auto-disable check
      await this.maybeAutoDisable(endpoint.id, at);
      return { kind: 'dlq', delivery };
    }

    const backoffMs = BACKOFF_MS_BY_ATTEMPT[nextAttemptIndex] ?? 60_000;
    const jitterMs = Math.floor(Math.random() * backoffMs * 0.15);
    const nextAttemptAt = new Date(at.getTime() + backoffMs + jitterMs);

    await this.config.repo.recordRetry(delivery.id, {
      responseStatus,
      responseExcerpt,
      lastError,
      attempts: nextAttemptIndex,
      nextAttemptAt,
    });
    this.config.logger.warn(
      {
        deliveryId: delivery.id,
        webhookId: endpoint.id,
        status: responseStatus,
        attempts: nextAttemptIndex,
        nextAttemptAt: nextAttemptAt.toISOString(),
        duration_ms: durationMs,
      },
      'webhook delivery scheduled for retry',
    );
    // Auto-disable check, also on the RETRY path — but defensively, not because a retry can
    // cross the threshold. recordRetry does NOT bump consecutiveFailures (a retry is an attempt
    // within one delivery, not a failed delivery), so the count this re-reads is whatever the DLQ
    // path last committed. It stays because the re-read is cheap and idempotent and catches an
    // endpoint already at the threshold that an earlier disable missed. This comment used to say
    // recordRetry bumped the counter — true before the repo was fixed, wrong since — and the
    // in-memory double agreed with the comment rather than with the repo, so every arm covering
    // this path was calibrated against a counter production does not keep.
    await this.maybeAutoDisable(endpoint.id, at);
    return { kind: 'retry', delivery, nextAttemptAt };
  }

  /**
   * Auto-disable an endpoint once its consecutive-failure count crosses the
   * threshold. Re-reads the endpoint's CURRENT consecutiveFailures rather than
   * the claim-time snapshot captured by deliver(): deliveries run
   * concurrently (a pool in `drain`, a batch in `tickOnce`), so two+ failures
   * for the SAME endpoint would otherwise each evaluate `snapshot + 1 >=
   * threshold` against the identical earlier count — double-counting off a
   * stale base and disabling at the wrong count. recordDlq has already committed its +1 (in its own
   * transaction, fenced on in_flight) before this runs, so the re-read observes
   * every committed increment and the threshold is checked against the live
   * counter — counting each concurrent failed DELIVERY once. recordRetry commits
   * no increment, so it cannot move this count at all. The
   * disable UPDATE is idempotent + scoped to this one endpoint id, so a
   * redundant call from a sibling delivery in the same batch is harmless.
   */
  private async maybeAutoDisable(endpointId: string, at: Date): Promise<void> {
    const current = await this.config.repo.findEndpointById(endpointId);
    // Already disabled (by a sibling delivery, or deleted) → nothing to do.
    if (!current || current.disabledAt !== null) return;
    if (current.consecutiveFailures >= AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES) {
      await this.config.repo.disableEndpoint(endpointId, at);
    }
  }

  private now(): Date {
    return this.config.now ? this.config.now() : new Date();
  }
}

export type DeliveryOutcome =
  | { kind: 'delivered'; delivery: WebhookDeliveryRow; status: number }
  | { kind: 'retry'; delivery: WebhookDeliveryRow; nextAttemptAt: Date }
  | { kind: 'dlq'; delivery: WebhookDeliveryRow }
  /** The endpoint is paused: back to pending, nothing attempted or counted. */
  | { kind: 'deferred'; delivery: WebhookDeliveryRow };

async function readExcerpt(response: Response): Promise<string | null> {
  try {
    const body = response.body;
    // Some non-undici Response shapes (e.g. test doubles) expose only text();
    // fall back to it — still abort-bounded in TIME. Production undici responses
    // always carry a ReadableStream body, so the SIZE cap below applies in prod.
    if (!body) {
      const text = await response.text();
      return sliceWithoutSplittingSurrogate(text, EXCERPT_MAX_CHARS);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < MAX_RESPONSE_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          const remaining = MAX_RESPONSE_READ_BYTES - total;
          const bytesToKeep = Math.min(value.length, remaining);
          // `slice`, not `subarray`: a view would retain the entire backing
          // buffer when one decompressed chunk is much larger than the cap.
          chunks.push(value.slice(0, bytesToKeep));
          total += bytesToKeep;
        }
      }
    } finally {
      // Stop downloading the rest — releases the connection and halts a huge
      // body / decompression bomb early instead of buffering it all.
      await reader.cancel().catch(() => undefined);
    }
    return sliceWithoutSplittingSurrogate(
      Buffer.concat(chunks, total).toString('utf8'),
      EXCERPT_MAX_CHARS,
    );
  } catch {
    return null;
  }
}

function safeTransportError(error: Error): string {
  if (error.name === 'AbortError') return 'timeout';
  // This value is persisted and later logged as a normal field, so it cannot
  // rely on Pino's `err` serializer. Bound before redaction to avoid processing
  // an attacker-sized exception, then bound again because replacement markers
  // can be longer than the credential they replace.
  const bounded = sliceWithoutSplittingSurrogate(error.message, TRANSPORT_ERROR_MAX_CHARS);
  return sliceWithoutSplittingSurrogate(
    redactText(bounded) || 'transport failure',
    TRANSPORT_ERROR_MAX_CHARS,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
