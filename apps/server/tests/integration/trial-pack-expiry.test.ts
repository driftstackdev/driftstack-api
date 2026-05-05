// V-202d — integration tests for the trial-pack expiry job pipeline.
//
// Pipeline:
//   1. Customer purchases trial pack → checkout.session.completed (mode=payment)
//   2. StripeWebhooksService.handleCheckoutCompleted enqueues a
//      trial_pack.expired job at run_at = expiresAt
//   3. ScheduledJobsService.processTick(now) at >= run_at claims + dispatches
//   4. Handler delegates to lifecycle.emit({ kind: 'subscription.trial_pack_expired' })
//   5. Lifecycle dispatcher sends sendTrialPackExpired email (opt-out aware)
//
// These tests cover the wire-level behavior end-to-end. Per-handler
// unit tests for the dispatcher live in tests/unit/account-lifecycle.test.ts;
// per-service unit tests for the scheduler live in
// tests/unit/scheduled-jobs.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { signStripePayload } from '../../src/lib/stripe-signing.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function buildCheckoutEvent(args: {
  eventId: string;
  stripeCustomerId: string;
  clientReferenceId: string;
}): string {
  return JSON.stringify({
    id: args.eventId,
    object: 'event',
    type: 'checkout.session.completed',
    api_version: '2024-12-18.acacia',
    created: nowSec(),
    livemode: false,
    data: {
      object: {
        id: 'cs_test_trial_pack',
        mode: 'payment',
        customer: args.stripeCustomerId,
        client_reference_id: args.clientReferenceId,
      },
    },
  });
}

async function postEvent(fx: TestAppFixture, raw: string): Promise<{ outcome: string }> {
  const sig = signStripePayload({ rawBody: raw, secret: fx.stripeWebhookSigningSecret });
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/webhooks/stripe',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ outcome: string }>();
}

describe('V-202d — trial-pack expiry job pipeline', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('purchase enqueues a trial_pack.expired job at trial_pack_expires_at', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });

    const raw = buildCheckoutEvent({
      eventId: 'evt_v202d_purchase',
      stripeCustomerId: 'cus_test_default',
      clientReferenceId: fx.accountId,
    });
    await postEvent(fx, raw);

    const all = fx.scheduledJobsRepo.all();
    expect(all).toHaveLength(1);
    const job = all[0]!;
    expect(job.jobType).toBe('trial_pack.expired');
    expect(job.accountId).toBe(fx.accountId);
    expect(job.completedAt).toBeNull();
    // run_at should be ~14 days out (default trial-pack window).
    const expectedExpiry = Date.now() + 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(job.runAt.getTime() - expectedExpiry)).toBeLessThan(60_000);
  });

  it('processTick before run_at does NOT pick up the job', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    await postEvent(
      fx,
      buildCheckoutEvent({
        eventId: 'evt_v202d_too_early',
        stripeCustomerId: 'cus_test_default',
        clientReferenceId: fx.accountId,
      }),
    );

    const result = await fx.scheduledJobsService.processTick(new Date());
    expect(result.processed).toBe(0);
    const all = fx.scheduledJobsRepo.all();
    expect(all[0]?.completedAt).toBeNull();
  });

  it('processTick at or after run_at completes the job', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    await postEvent(
      fx,
      buildCheckoutEvent({
        eventId: 'evt_v202d_due',
        stripeCustomerId: 'cus_test_default',
        clientReferenceId: fx.accountId,
      }),
    );

    const job = fx.scheduledJobsRepo.all()[0]!;
    // Tick at exactly run_at + 1ms — should pick up + complete.
    const tickAt = new Date(job.runAt.getTime() + 1);
    const result = await fx.scheduledJobsService.processTick(tickAt);
    expect(result.processed).toBe(1);
    const after = fx.scheduledJobsRepo.read(job.id);
    expect(after?.completedAt).toBeInstanceOf(Date);
  });

  it('completed job is not re-picked on subsequent ticks', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    await postEvent(
      fx,
      buildCheckoutEvent({
        eventId: 'evt_v202d_idempotent',
        stripeCustomerId: 'cus_test_default',
        clientReferenceId: fx.accountId,
      }),
    );
    const job = fx.scheduledJobsRepo.all()[0]!;
    const tickAt = new Date(job.runAt.getTime() + 1);
    await fx.scheduledJobsService.processTick(tickAt);
    // Second tick — should claim 0 jobs (the one we processed is completed).
    const second = await fx.scheduledJobsService.processTick(new Date(tickAt.getTime() + 1000));
    expect(second.processed).toBe(0);
  });

  it('duplicate purchase webhook does not enqueue a second job', async () => {
    fx = await buildTestApp({ tier: 'trial_pack' });
    await postEvent(
      fx,
      buildCheckoutEvent({
        eventId: 'evt_v202d_first',
        stripeCustomerId: 'cus_test_default',
        clientReferenceId: fx.accountId,
      }),
    );
    // The Stripe-event ledger short-circuits the second post via `hasEvent`,
    // so this is trivially deduplicated. Run a different event id instead
    // to exercise the dedupOnAccountAndType path inside the enqueue:
    await postEvent(
      fx,
      buildCheckoutEvent({
        eventId: 'evt_v202d_second',
        stripeCustomerId: 'cus_test_default',
        clientReferenceId: fx.accountId,
      }),
    );
    expect(fx.scheduledJobsRepo.all()).toHaveLength(1);
  });
});
