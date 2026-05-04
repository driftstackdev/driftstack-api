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
