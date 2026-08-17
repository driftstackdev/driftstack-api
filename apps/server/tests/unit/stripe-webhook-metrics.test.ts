// Arc 7 obs.8 — `driftstack_stripe_webhook_total{outcome}` counter
// emitted by the /v1/webhooks/stripe route. Sweeps both pre-dispatch
// reject paths (missing signature, empty body, signature_invalid,
// malformed_event) and dispatch outcomes (handled / duplicate /
// ignored / error) against a real Fastify instance.

import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerStripeWebhookRoutes } from '../../src/routes/webhooks-stripe.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import { signStripePayload } from '../../src/lib/stripe-signing.js';
import type {
  StripeEvent,
  StripeWebhooksService,
  DispatchOutcome,
} from '../../src/services/stripe-webhooks.js';

const SECRET = 'whsec_test_dummy';

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.stripeWebhookTotal, 'Stripe webhook receiver outcomes.', [
    'outcome',
  ]);
  return m;
}

function makeService(behaviour: 'duplicate' | DispatchOutcome): StripeWebhooksService {
  return {
    handle: () => Promise.resolve(behaviour),
  } as unknown as StripeWebhooksService;
}

/**
 * A service whose handle() REJECTS. Per C5 this models a TRANSIENT infra error
 * — the only kind dispatch rethrows; a permanent handler error is swallowed and
 * recorded inside dispatch and never reaches the route's catch.
 */
function makeThrowingService(): StripeWebhooksService {
  return {
    handle: () => Promise.reject(new Error('postgres connection terminated')),
  } as unknown as StripeWebhooksService;
}

async function buildApp(args: {
  metrics?: MetricsRegistry;
  serviceOutcome?: 'duplicate' | DispatchOutcome;
  serviceThrows?: boolean;
}) {
  const app = Fastify();
  registerStripeWebhookRoutes(app, {
    service:
      args.serviceThrows === true
        ? makeThrowingService()
        : makeService(args.serviceOutcome ?? 'handled'),
    signingSecret: SECRET,
    logger: {
      warn: () => {},

      info: () => {},

      error: () => {},

      debug: () => {},

      child: () => ({}) as never,
    } as never,
    ...(args.metrics !== undefined ? { metrics: args.metrics } : {}),
  });
  await app.ready();
  return app;
}

const VALID_EVENT: StripeEvent = {
  id: 'evt_x',
  type: 'customer.subscription.updated',
  data: { object: {} },
};

const VALID_EVENT_JSON = JSON.stringify(VALID_EVENT);

describe('Arc 7 obs.8 — stripe_webhook_total counter', () => {
  let metrics: MetricsRegistry;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    metrics = makeRegistry();
    app = undefined;
  });

  it('outcome="signature_missing" when the Stripe-Signature header is absent', async () => {
    app = await buildApp({ metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(401);
    expect(
      metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'signature_missing' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="signature_invalid" when the signature is wrong', async () => {
    app = await buildApp({ metrics });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': 't=1000,v1=00ff',
      },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(401);
    expect(
      metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'signature_invalid' }),
    ).toBe(1);
    await app.close();
  });

  it('outcome="handled" on a verified event whose service.handle returns "handled"', async () => {
    app = await buildApp({ metrics, serviceOutcome: 'handled' });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'handled' })).toBe(1);
    await app.close();
  });

  it('outcome="duplicate" when the service detected a replay', async () => {
    app = await buildApp({ metrics, serviceOutcome: 'duplicate' });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'duplicate' })).toBe(1);
    await app.close();
  });

  it('outcome="ignored" when the service returns "ignored" (event-type not handled)', async () => {
    app = await buildApp({ metrics, serviceOutcome: 'ignored' });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'ignored' })).toBe(1);
    await app.close();
  });

  it('outcome="error" when the service returns an error:<msg> string (cardinality cap)', async () => {
    app = await buildApp({ metrics, serviceOutcome: 'error:some specific failure mode' });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'error' })).toBe(1);
    // Sanity: the dynamic tail did NOT leak into the label set.
    expect(
      metrics.getValue(METRIC_NAMES.stripeWebhookTotal, {
        outcome: 'error:some specific failure mode',
      }),
    ).toBe(0);
    await app.close();
  });

  it('omitting metrics is a silent no-op (does not throw)', async () => {
    app = await buildApp({ serviceOutcome: 'handled' });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('Prometheus exposition format includes the new metric', async () => {
    app = await buildApp({ metrics });
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: VALID_EVENT_JSON,
    });
    const rendered = metrics.render();
    expect(rendered).toContain('# TYPE driftstack_stripe_webhook_total counter');
    expect(rendered).toMatch(/driftstack_stripe_webhook_total\{outcome="signature_missing"\} 1/);
    await app.close();
  });

  // ── C5: a transient infra error must NOT be acknowledged ────────────────
  // Every arm above returns 200, which is right: Stripe treats non-2xx as a
  // delivery failure and retries, and a redelivery loop on every "ignored"
  // event type would be worse than useless. The one deliberate exception is a
  // transient infra error, and it is the exception that protects revenue —
  // dispatch writes no ledger row for it, so a 500 makes Stripe re-deliver
  // inside its ~3-day window and the retry cleanly re-processes the event. Turn
  // that 500 into a 200 and Stripe records the event as delivered, never sends
  // it again, and a paying customer stays un-upgraded because of a one-second
  // blip. No arm exercised this path: nothing made handle() reject.

  it('CRITICAL a transient handler error is NOT acknowledged as received', async () => {
    app = await buildApp({ metrics, serviceThrows: true });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(
      res.statusCode,
      'a transient infra error was acknowledged with a 2xx. Stripe then marks the event delivered ' +
        'and never retries, so the subscription change is lost permanently and the customer stays ' +
        'on the wrong tier',
    ).toBe(500);
    expect(res.body, 'the failing response still claimed the event was received').not.toContain(
      '"received":true',
    );
    await app.close();
  });

  it('CRITICAL a transient handler error is counted separately from a permanent one', async () => {
    app = await buildApp({ metrics, serviceThrows: true });
    const sig = signStripePayload({ rawBody: VALID_EVENT_JSON, secret: SECRET });
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      payload: VALID_EVENT_JSON,
    });
    expect(
      metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'handler_transient_error' }),
      'the retryable failure was not counted under its own label — on a dashboard it becomes ' +
        'indistinguishable from a permanent handler error, which is the one you do NOT chase',
    ).toBe(1);
    expect(
      metrics.getValue(METRIC_NAMES.stripeWebhookTotal, { outcome: 'handled' }),
      'a failed dispatch was also counted as handled',
    ).toBe(0);
    await app.close();
  });
});
