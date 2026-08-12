// V-758 — the AUP §5.2 promise that suspension pauses billing, made true.
//
// Before this, `suspend()` had NO billing dependency of any kind and `pause_collection`
// appeared nowhere in the codebase except an explanatory comment. A suspended account kept
// renewing a flat monthly subscription (up to $1,499/mo) for the documented 30-day window
// while `auth.ts` 403'd every authenticated request — and the customer had been told
// billing pauses, so they would not expect the charge, and the API still reported the
// subscription active so they could not detect it.
//
// The decision to implement rather than amend the AUP: it is published, binding copy, and
// deleting a customer-favourable promise is a downgrade of a commitment. Charging for a
// service that refuses every request is also hard to defend under EU consumer protection.
//
// Three things this pins that are easy to get wrong:
//  1. RESUME MUST EXIST. Pausing without ever clearing the pause leaves a reinstated
//     customer permanently unbilled — a worse defect than the one the pause fixes.
//  2. Failure must be LOUD but must NOT fail the suspension. The status change is already
//     committed; a Stripe outage must not leave an un-suspended violator. But this is the
//     one reclaim step whose silent failure costs the customer money, so it goes through
//     the named `account_reclaim_failed` alarm.
//  3. An account with no subscription is a NORMAL outcome, not an error — free tier and
//     never-subscribed accounts must not produce alarms on every suspension.

import { describe, expect, it, vi } from 'vitest';
import {
  AccountsAdminService,
  type AccountsAdminRepo,
  type BillingCollectionPauser,
} from '../../src/services/admin-accounts.js';
import type { AccountContext } from '../../src/services/auth.js';

const NOW = new Date('2026-08-12T00:00:00.000Z');

function ctx(): AccountContext {
  return {
    account: { id: 'acc_admin', tier: 'enterprise', status: 'active' },
    apiKey: { id: 'key_admin', scopes: ['driftstack_internal_admin'] },
    teams: [],
    rateLimitOverrides: {},
  } as unknown as AccountContext;
}

function row(status: string) {
  return { id: 'acc_1', tier: 'api_scale', status, createdAt: NOW, updatedAt: NOW } as never;
}

function makeRepo(): AccountsAdminRepo {
  return {
    setStatus: (_id: string, status: string) => Promise.resolve(row(status)),
  } as unknown as AccountsAdminRepo;
}

function makeLogger(): { logger: never; errors: Array<Record<string, unknown>> } {
  const errors: Array<Record<string, unknown>> = [];
  const logger = {
    error: (obj: Record<string, unknown>) => {
      errors.push(obj);
    },
  } as unknown as never;
  return { logger, errors };
}

/** Build the service with only the billing dep wired — the other reclaimers stay null. */
function svcWith(pauser: BillingCollectionPauser | null, logger?: never) {
  return new AccountsAdminService(
    makeRepo(),
    null,
    null,
    null,
    null,
    null,
    logger ?? undefined,
    pauser,
  );
}

describe('suspension pauses billing (V-758)', () => {
  it('suspend() pauses collection for the suspended account', async () => {
    const pause = vi.fn(() => Promise.resolve('paused' as const));
    const resume = vi.fn(() => Promise.resolve('resumed' as const));
    const svc = svcWith({ pauseCollectionForAccount: pause, resumeCollectionForAccount: resume });

    const out = await svc.suspend(ctx(), 'acc_1');

    expect(out.status).toBe('suspended');
    expect(pause).toHaveBeenCalledWith('acc_1');
    expect(resume).not.toHaveBeenCalled();
  });

  it('CRITICAL unsuspend() resumes collection — pausing without resuming would leave a reinstated customer permanently unbilled', async () => {
    const pause = vi.fn(() => Promise.resolve('paused' as const));
    const resume = vi.fn(() => Promise.resolve('resumed' as const));
    const svc = svcWith({ pauseCollectionForAccount: pause, resumeCollectionForAccount: resume });

    const out = await svc.unsuspend(ctx(), 'acc_1');

    expect(out.status).toBe('active');
    expect(resume).toHaveBeenCalledWith('acc_1');
    expect(pause).not.toHaveBeenCalled();
  });

  it('a Stripe failure does NOT fail the suspension, but IS alarmed with the step named', async () => {
    const { logger, errors } = makeLogger();
    const svc = svcWith(
      {
        pauseCollectionForAccount: () => Promise.reject(new Error('stripe 503')),
        resumeCollectionForAccount: () => Promise.resolve('resumed' as const),
      },
      logger,
    );

    // The violator stays suspended even though billing could not be paused — the status
    // change is already committed and must not be undone by a payment-provider outage.
    const out = await svc.suspend(ctx(), 'acc_1');
    expect(out.status).toBe('suspended');

    // ...but it is not silent: this is the reclaim whose quiet failure costs money.
    const alarm = errors.find((e) => e.event === 'account_reclaim_failed');
    expect(alarm, 'a failed billing pause must raise account_reclaim_failed').toBeDefined();
    expect(alarm?.step).toBe('billing_pause');
    expect(alarm?.account_id).toBe('acc_1');
  });

  it('a failed RESUME is alarmed too — otherwise a reinstated customer gets silent free service', async () => {
    const { logger, errors } = makeLogger();
    const svc = svcWith(
      {
        pauseCollectionForAccount: () => Promise.resolve('paused' as const),
        resumeCollectionForAccount: () => Promise.reject(new Error('stripe 503')),
      },
      logger,
    );

    const out = await svc.unsuspend(ctx(), 'acc_1');
    expect(out.status).toBe('active');
    expect(errors.find((e) => e.event === 'account_reclaim_failed')?.step).toBe('billing_resume');
  });

  it('an account with no subscription is a normal outcome, not an alarm', async () => {
    const { logger, errors } = makeLogger();
    const svc = svcWith(
      {
        pauseCollectionForAccount: () => Promise.resolve('no_subscription' as const),
        resumeCollectionForAccount: () => Promise.resolve('no_subscription' as const),
      },
      logger,
    );

    await svc.suspend(ctx(), 'acc_1');
    await svc.unsuspend(ctx(), 'acc_1');

    // Free-tier and never-subscribed accounts are the common case; alarming on them would
    // train an operator to ignore the alarm that matters.
    expect(errors.filter((e) => e.event === 'account_reclaim_failed')).toEqual([]);
  });

  it('with no billing dep wired at all, suspension behaves exactly as before', async () => {
    const { logger, errors } = makeLogger();
    const svc = svcWith(null, logger);

    expect((await svc.suspend(ctx(), 'acc_1')).status).toBe('suspended');
    expect((await svc.unsuspend(ctx(), 'acc_1')).status).toBe('active');
    expect(errors).toEqual([]);
  });
});
