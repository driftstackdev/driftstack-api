// Arc 3 sub-slice 28.2 (v2-#28) — WebhookSecretForceRotationService tests.

import { describe, expect, it, vi } from 'vitest';
import { WebhookSecretForceRotationService } from '../../src/services/webhook-secret-force-rotation.js';
import { InMemoryWebhooksRepo } from '../integration/_helpers/in-memory-webhooks-repo.js';
import type { EmailService } from '../../src/services/email.js';

function makeFakeEmail(): { svc: EmailService; sends: Array<Record<string, unknown>> } {
  const sends: Array<Record<string, unknown>> = [];
  const svc = {
    isConfigured: true,
    // Arc 3 sub-slice 28.4 — distinct send method for the force-
    // rotation template.
    sendWebhookSecretForceRotated: (args: Record<string, unknown>) => {
      sends.push(args);
      return Promise.resolve();
    },
  } as unknown as EmailService;
  return { svc, sends };
}

function makeFakeLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: () => makeFakeLogger(),
  } as unknown as Parameters<typeof WebhookSecretForceRotationService>[2];
}

// NOW is wall-clock-adjacent so insertEndpoint's `new Date()` falls
// inside the 91-day window; the aged row is backdated past 91d.
const NOW = new Date(Date.now() + 60_000); // 1m in the future, beyond insertEndpoint's `now`
const NINETY_TWO_DAYS_AGO = new Date(NOW.getTime() - 92 * 24 * 60 * 60 * 1000);

describe('Arc 3 v2-#28 sub-slice 28.2 WebhookSecretForceRotationService', () => {
  it('rotates only endpoints whose secret_created_at is past 91 days AND force_rotated_at IS NULL', async () => {
    const repo = new InMemoryWebhooksRepo();
    const fresh = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook-fresh',
      secret: 'whsec_fresh',
      secretPrefix: 'whsec_fres',
      events: ['session.completed'],
      description: null,
    });
    const aged = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook-aged',
      secret: 'whsec_aged',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    // Backdate the aged endpoint past 91 days.
    const agedRow = await repo.findEndpoint(aged.id, 'acc_1');
    if (agedRow) {
      // The InMemory repo stores rows by reference; mutate in place.
      (agedRow as { secretCreatedAt: Date }).secretCreatedAt = NINETY_TWO_DAYS_AGO;
    }

    const { svc: emailSvc } = makeFakeEmail();
    const svc = new WebhookSecretForceRotationService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.rotated).toBe(1);
    // Email is sent only when the joined account row carries an
    // email; the in-memory variant doesn't (the Drizzle path joins
    // accounts.email). Rotation persistence + count is the part
    // this test pins.

    // The aged endpoint's secret should have changed; grace window
    // populated; forceRotatedAt stamped.
    const after = await repo.findEndpoint(aged.id, 'acc_1');
    expect(after?.secret).not.toBe('whsec_aged');
    expect(after?.forceRotatedAt).toEqual(NOW);
    expect(after?.graceWindowEndsAt).toEqual(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000));
    // Fresh endpoint untouched.
    const freshAfter = await repo.findEndpoint(fresh.id, 'acc_1');
    expect(freshAfter?.secret).toBe('whsec_fresh');
  });

  it('second tick is a no-op — force_rotated_at filter prevents re-rotation', async () => {
    const repo = new InMemoryWebhooksRepo();
    const aged = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook',
      secret: 'whsec_aged',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    const agedRow = await repo.findEndpoint(aged.id, 'acc_1');
    if (agedRow) {
      (agedRow as { secretCreatedAt: Date }).secretCreatedAt = NINETY_TWO_DAYS_AGO;
    }
    const { svc: emailSvc } = makeFakeEmail();
    const svc = new WebhookSecretForceRotationService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const first = await svc.tickOnce(NOW);
    expect(first.rotated).toBe(1);
    // Tick again with the same `now` — should be a no-op since
    // force_rotated_at is now set.
    const second = await svc.tickOnce(NOW);
    expect(second.rotated).toBe(0);
  });

  it('email send failure is swallowed — rotation still persists', async () => {
    const repo = new InMemoryWebhooksRepo();
    const aged = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook',
      secret: 'whsec_aged',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    const agedRow = await repo.findEndpoint(aged.id, 'acc_1');
    if (agedRow) {
      (agedRow as { secretCreatedAt: Date }).secretCreatedAt = NINETY_TWO_DAYS_AGO;
    }
    const failingEmail = {
      isConfigured: true,
      sendWebhookSecretForceRotated: () => Promise.reject(new Error('postmark down')),
    } as unknown as EmailService;
    const svc = new WebhookSecretForceRotationService(repo, failingEmail, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.rotated).toBe(1);
    const after = await repo.findEndpoint(aged.id, 'acc_1');
    expect(after?.forceRotatedAt).toEqual(NOW);
  });
});
