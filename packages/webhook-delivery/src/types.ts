// Webhook delivery system types — V-144 stub.
//
// Distinct from `@driftstack/api-types` `WebhookEndpoint` /
// `WebhookDelivery` shapes (which are the public-facing wire types
// that customers see in `/v1/webhooks/*` responses). This package
// models the INTERNAL delivery mechanics — queue, retry curve, DLQ
// management, signature payload — that the production system uses
// to actually push events out.
//
// Today this work happens directly in
// `apps/server/src/services/webhooks.ts` + `webhook-worker.ts`.
// V-144 lands the seam so a future "more sophisticated delivery
// system" (multi-region, batching, ordering guarantees, etc.) can
// drop in behind the same interface without touching the call sites.

/** Endpoint configuration the delivery system reads. */
export interface DeliveryEndpoint {
  /** Stable identifier — survives endpoint URL changes. */
  id: string;
  /** Account that owns the endpoint (for tenant isolation in the queue). */
  accountId: string;
  /** Target URL. https:// only; http:// rejected at registration time. */
  url: string;
  /** Subscribed event types. Empty = receives nothing. */
  eventTypes: readonly string[];
  /** Plaintext signing secret. Used to compute the v1 signature. */
  signingSecret: string;
  /** Whether the endpoint is currently active. Disabled endpoints skip the queue. */
  active: boolean;
  /** Optional per-endpoint delivery overrides (e.g. tighter timeout for slow customer endpoints). */
  config?: DeliveryConfig;
}

/** Per-endpoint config knobs. Override the system defaults sparingly. */
export interface DeliveryConfig {
  /** Per-attempt HTTP timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /**
   * Max attempts before DLQ. Default 6 (the initial delivery + 5
   * retries; see DEFAULT_MAX_ATTEMPTS). The retry backoff schedule is
   * the fixed BACKOFF_MS_BY_ATTEMPT table (1m / 5m / 15m / 30m / 60m),
   * not configurable per-endpoint.
   */
  maxAttempts?: number;
}

/** Per-event delivery payload as the queue reads it. */
export interface DeliveryPayload {
  /** Stable event id for dedupe across retries. */
  eventId: string;
  /** Event type (e.g. `'session.completed'`). */
  eventType: string;
  /** UNIX timestamp seconds when the event was emitted (NOT when delivery is attempted). */
  emittedAtSec: number;
  /** Serialized payload — the customer receives this body verbatim. */
  body: string;
}

/** Per-attempt outcome. Drives the retry curve + DLQ decision. */
export interface DeliveryAttempt {
  /** Attempt number (1-indexed). */
  attempt: number;
  /** UNIX timestamp ms when this attempt completed. */
  completedAtMs: number;
  /** HTTP status code returned by the endpoint, or null if the request never completed. */
  responseStatus: number | null;
  /** Excerpt of response body for debugging (first 200 chars). */
  responseExcerpt: string | null;
  /** Wall-clock duration of this attempt in ms. */
  durationMs: number;
  /** Surface-level outcome. `'transport_error'` = couldn't reach endpoint at all. */
  outcome: 'success' | 'http_error' | 'transport_error' | 'timeout';
  /** Free-text error reason when `outcome !== 'success'`. */
  errorMessage: string | null;
}

/** Queued delivery state machine. */
export type DeliveryStatus = 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dlq';

/** A delivery currently in the queue or recently completed. */
export interface DeliveryRecord {
  id: string;
  endpointId: string;
  payload: DeliveryPayload;
  status: DeliveryStatus;
  attempts: readonly DeliveryAttempt[];
  /** When the next attempt fires. null when status === 'delivered' / 'failed' / 'dlq'. */
  nextAttemptAtMs: number | null;
  /** When the record was first created in the queue. */
  createdAtMs: number;
  /** When the record reached a terminal status. */
  completedAtMs: number | null;
}

/** A row in the dead-letter queue. */
export interface DlqEntry {
  /** Same id as the originating DeliveryRecord. DLQ + active queue share the id space. */
  deliveryId: string;
  endpointId: string;
  accountId: string;
  payload: DeliveryPayload;
  /** Total attempts before landing in DLQ. */
  totalAttempts: number;
  /** Attempt log for postmortem. */
  attempts: readonly DeliveryAttempt[];
  /** When the record entered DLQ. */
  enteredDlqAtMs: number;
  /** Free-text reason for DLQ. Concise: e.g. `'5× transport_error: ECONNREFUSED'`. */
  reason: string;
}
