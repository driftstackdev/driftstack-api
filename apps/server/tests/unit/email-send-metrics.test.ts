// Arc 7 obs.13 — `driftstack_email_send_total{template,outcome}`
// counter emitted by the Postmark-backed EmailService. Sweeps the
// ok path + the bounded classifyEmailError category set via a
// stub Postmark client.

import { describe, expect, it, beforeEach } from 'vitest';
import { createEmailService } from '../../src/services/email.js';
import type { PostmarkSendApi } from '../../src/services/email.js';
import { MetricsRegistry, METRIC_NAMES } from '../../src/services/metrics-registry.js';
import { createTestLogger } from '../../src/lib/logger.js';

function makeRegistry(): MetricsRegistry {
  const m = new MetricsRegistry();
  m.registerCounter(METRIC_NAMES.emailSendTotal, 'Outbound email send outcomes.', [
    'template',
    'outcome',
  ]);
  return m;
}

function makeStub(behaviour: 'ok' | { code: number } | { throw: Error }): PostmarkSendApi {
  return {
    sendEmail: () => {
      if (behaviour === 'ok') return Promise.resolve({});
      if ('code' in behaviour) {
        // classifyEmailError reads `code` (number) directly off the
        // thrown object. Postmark's SDK sets ErrorCode on its own
        // exception class; both are plumbed under the same numeric.
        const err = new Error(`Postmark ${behaviour.code.toString()}`) as Error & {
          code?: number;
        };
        err.code = behaviour.code;
        return Promise.reject(err);
      }
      return Promise.reject(behaviour.throw);
    },
  };
}

const POSTMARK_CONFIG = {
  apiToken: 'pmtoken_test',
  from: 'noreply@example.com',
  replyTo: 'support@example.com',
};

describe('Arc 7 obs.13 — email_send_total counter', () => {
  let metrics: MetricsRegistry;
  beforeEach(() => {
    metrics = makeRegistry();
  });

  it('outcome="ok" on a successful Postmark send', async () => {
    const svc = createEmailService({
      config: POSTMARK_CONFIG,
      logger: createTestLogger(),
      client: makeStub('ok'),
      metrics,
    });
    await svc.sendSignupVerification({
      to: 'alice@example.com',
      link: 'https://app/verify/x',
      expiresAt: new Date('2026-12-31'),
    });
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'signup-verification',
        outcome: 'ok',
      }),
    ).toBe(1);
  });

  it('outcome="pending-approval" on Postmark 412 (account pending approval)', async () => {
    const svc = createEmailService({
      config: POSTMARK_CONFIG,
      logger: createTestLogger(),
      client: makeStub({ code: 412 }),
      metrics,
    });
    await svc.sendSignupVerification({
      to: 'alice@example.com',
      link: 'https://app/verify/x',
      expiresAt: new Date('2026-12-31'),
    });
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'signup-verification',
        outcome: 'pending-approval',
      }),
    ).toBe(1);
    // Service swallows the error; the call returns successfully.
  });

  it('outcome="inactive-recipient" on Postmark 405', async () => {
    const svc = createEmailService({
      config: POSTMARK_CONFIG,
      logger: createTestLogger(),
      client: makeStub({ code: 405 }),
      metrics,
    });
    await svc.sendPasswordReset({
      to: 'inactive@example.com',
      link: 'https://app/reset/y',
      expiresAt: new Date('2026-12-31'),
    });
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'password-reset',
        outcome: 'inactive-recipient',
      }),
    ).toBe(1);
  });

  it('outcome="rate-limited" on Postmark 429', async () => {
    const svc = createEmailService({
      config: POSTMARK_CONFIG,
      logger: createTestLogger(),
      client: makeStub({ code: 429 }),
      metrics,
    });
    await svc.sendBillingReceipt({
      to: 'a@b.com',
      amountFormatted: '$29.00',
      period: '2026-05',
      invoiceUrl: 'https://x',
    });
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'billing-receipt',
        outcome: 'rate-limited',
      }),
    ).toBe(1);
  });

  it('different templates accumulate independently', async () => {
    const svc = createEmailService({
      config: POSTMARK_CONFIG,
      logger: createTestLogger(),
      client: makeStub('ok'),
      metrics,
    });
    await svc.sendSignupVerification({
      to: 'a@b.com',
      link: 'https://x',
      expiresAt: new Date('2026-12-31'),
    });
    await svc.sendPasswordReset({
      to: 'a@b.com',
      link: 'https://x',
      expiresAt: new Date('2026-12-31'),
    });
    await svc.sendPasswordReset({
      to: 'b@c.com',
      link: 'https://x',
      expiresAt: new Date('2026-12-31'),
    });
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'signup-verification',
        outcome: 'ok',
      }),
    ).toBe(1);
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'password-reset',
        outcome: 'ok',
      }),
    ).toBe(2);
  });

  it('omitting the metrics registry is a silent no-op', async () => {
    const svc = createEmailService({
      config: POSTMARK_CONFIG,
      logger: createTestLogger(),
      client: makeStub('ok'),
    });
    await expect(
      svc.sendSignupVerification({
        to: 'a@b.com',
        link: 'https://x',
        expiresAt: new Date('2026-12-31'),
      }),
    ).resolves.toBeUndefined();
  });

  it('no-op service (Postmark unconfigured) does not emit any counter', async () => {
    const svc = createEmailService({
      config: null,
      logger: createTestLogger(),
      metrics,
    });
    await svc.sendSignupVerification({
      to: 'a@b.com',
      link: 'https://x',
      expiresAt: new Date('2026-12-31'),
    });
    // No-op path returns immediately without touching the send()
    // function, so no metric is emitted.
    expect(
      metrics.getValue(METRIC_NAMES.emailSendTotal, {
        template: 'signup-verification',
        outcome: 'ok',
      }),
    ).toBe(0);
  });
});
