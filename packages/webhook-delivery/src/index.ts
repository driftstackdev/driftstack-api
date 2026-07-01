// @driftstack/webhook-delivery public surface.

export type {
  DeliveryAttempt,
  DeliveryConfig,
  DeliveryEndpoint,
  DeliveryPayload,
  DeliveryRecord,
  DeliveryStatus,
  DlqEntry,
} from './types.js';

export type {
  DeliveryQueue,
  DlqManager,
  EnqueueDeliveryOpts,
  ListDeliveriesOpts,
  ListDeliveriesPage,
  RequeueDlqOpts,
  WebhookDeliveryService,
} from './interfaces.js';

export { MockDlqManager, MockWebhookDeliveryService } from './mock.js';

export {
  BACKOFF_MS_BY_ATTEMPT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DLQ_ENTRIES,
  DEFAULT_TIMEOUT_MS,
  InMemoryDlqManager,
  InMemoryWebhookDeliveryService,
  createInMemoryWebhookDelivery,
  isLiteralUnsafeWebhookHost,
  signPayload,
  type InMemoryWebhookDeliveryDeps,
  type InMemoryWebhookDeliveryHandles,
  type ProcessTickResult,
} from './in-memory.js';
