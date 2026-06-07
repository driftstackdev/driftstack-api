// Webhook delivery worker.
//
// Long-running loop:
//   1. Claim a batch of pending deliveries whose nextAttemptAt is past
//   2. For each: build the signed POST, send via fetch, observe response
//   3. On 2xx → recordDelivered (resets endpoint.consecutiveFailures)
//   4. On non-2xx / network / timeout → recordRetry (if attempts < MAX) or
//      recordDlq (if attempts == MAX). Both bump endpoint.consecutiveFailures.
//   5. If endpoint.consecutiveFailures crosses the auto-disable threshold,
//      mark the endpoint disabled.
//
// The loop is process-local; in production we'd run one worker per app
// instance and rely on SELECT...FOR UPDATE SKIP LOCKED to coordinate
// (already in DrizzleWebhooksRepo.claim).

import type { Logger } from '../lib/logger.js';
import { signWebhookPayload } from '../lib/webhook-signing.js';
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
  /** Per-attempt delivery timeout (ms). Default 10s. */
  deliveryTimeoutMs?: number;
  /** Empty-claim sleep (ms). Default 2s. */
  idleSleepMs?: number;
  /** Batch size per claim. Default 25. */
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

export class WebhookDeliveryWorker {
  private running = false;

  constructor(private readonly config: WebhookWorkerConfig) {}

  /** Start the loop. Returns when stop() is called. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const sleep = this.config.sleep ?? defaultSleep;
    const idleSleepMs = this.config.idleSleepMs ?? DEFAULT_IDLE_SLEEP_MS;

    while (this.running) {
      const claimed = await this.config.repo.claim({
        batchSize: this.config.batchSize ?? DEFAULT_BATCH_SIZE,
        now: this.now(),
      });
      if (claimed.length === 0) {
        await sleep(idleSleepMs);
        continue;
      }
      await Promise.all(claimed.map((d) => this.deliver(d)));
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Tick once: claim + deliver one batch synchronously. Used in tests. */
  async tickOnce(): Promise<{ claimed: number; outcomes: DeliveryOutcome[] }> {
    const claimed = await this.config.repo.claim({
      batchSize: this.config.batchSize ?? DEFAULT_BATCH_SIZE,
      now: this.now(),
    });
    const outcomes = await Promise.all(claimed.map((d) => this.deliver(d)));
    return { claimed: claimed.length, outcomes };
  }

  private async deliver(delivery: WebhookDeliveryRow): Promise<DeliveryOutcome> {
    const fetchImpl = this.config.fetch ?? fetch;
    const timeout = this.config.deliveryTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Look up the endpoint to get the current secret + active flag.
    // claim returns the delivery row but not the endpoint; we fetch the
    // endpoint by id (worker-only path, not account-scoped). Single SELECT
    // per delivery — could be batched in a future optimisation.
    const endpoint = await this.config.repo.findEndpointById(delivery.webhookId);

    // Fallback: endpoint not in subscriber set (might have been deleted /
    // disabled between enqueue and claim). Treat as DLQ — there's no
    // recoverable path.
    if (!endpoint || !endpoint.active || endpoint.disabledAt !== null) {
      await this.config.repo.recordDlq(delivery.id, {
        responseStatus: null,
        lastError: 'endpoint disabled or deleted between enqueue and claim',
        at: this.now(),
      });
      this.config.logger.warn(
        { deliveryId: delivery.id, webhookId: delivery.webhookId },
        'webhook delivery → DLQ (endpoint missing/disabled)',
      );
      return { kind: 'dlq', delivery };
    }

    const body = JSON.stringify(delivery.payload);
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
        // docs/internal/2026-05-31-webhook-ssrf-outbound-target.md.
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
      // 2xx responses never read the body (status is enough), so the happy path
      // is unchanged. See the fetch-body-read-timeout class fix (stripe/oauth).
      if (!response.ok) {
        responseExcerpt = await readExcerpt(response);
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
    const lastError = networkError
      ? networkError.name === 'AbortError'
        ? 'timeout'
        : networkError.message
      : null;

    const nextAttemptIndex = delivery.attempts + 1;

    if (nextAttemptIndex >= MAX_ATTEMPTS) {
      await this.config.repo.recordDlq(delivery.id, {
        responseStatus,
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
      if (endpoint.consecutiveFailures + 1 >= AUTO_DISABLE_AFTER_CONSECUTIVE_FAILURES) {
        await this.config.repo.disableEndpoint(endpoint.id, at);
      }
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
    return { kind: 'retry', delivery, nextAttemptAt };
  }

  private now(): Date {
    return this.config.now ? this.config.now() : new Date();
  }
}

export type DeliveryOutcome =
  | { kind: 'delivered'; delivery: WebhookDeliveryRow; status: number }
  | { kind: 'retry'; delivery: WebhookDeliveryRow; nextAttemptAt: Date }
  | { kind: 'dlq'; delivery: WebhookDeliveryRow };

async function readExcerpt(response: Response): Promise<string | null> {
  try {
    const body = response.body;
    // Some non-undici Response shapes (e.g. test doubles) expose only text();
    // fall back to it — still abort-bounded in TIME. Production undici responses
    // always carry a ReadableStream body, so the SIZE cap below applies in prod.
    if (!body) {
      const text = await response.text();
      return text.slice(0, EXCERPT_MAX_CHARS);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < MAX_RESPONSE_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          chunks.push(value);
          total += value.length;
        }
      }
    } finally {
      // Stop downloading the rest — releases the connection and halts a huge
      // body / decompression bomb early instead of buffering it all.
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks)
      .subarray(0, MAX_RESPONSE_READ_BYTES)
      .toString('utf8')
      .slice(0, EXCERPT_MAX_CHARS);
  } catch {
    return null;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
