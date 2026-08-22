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
  } as unknown as ConstructorParameters<typeof WebhookSecretForceRotationService>[2];
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
      secret: 'whsec_freshaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretPrefix: 'whsec_fres',
      events: ['session.completed'],
      description: null,
    });
    const aged = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook-aged',
      secret: 'whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    // Backdate the aged endpoint past 91 days.
    repo.backdateSecretCreatedAt(aged.id, NINETY_TWO_DAYS_AGO);

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
    expect(after?.secret).not.toBe('whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(after?.forceRotatedAt).toEqual(NOW);
    expect(after?.graceWindowEndsAt).toEqual(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000));
    // Fresh endpoint untouched.
    const freshAfter = await repo.findEndpoint(fresh.id, 'acc_1');
    expect(freshAfter?.secret).toBe('whsec_freshaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('second tick is a no-op — force_rotated_at filter prevents re-rotation', async () => {
    const repo = new InMemoryWebhooksRepo();
    const aged = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook',
      secret: 'whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    repo.backdateSecretCreatedAt(aged.id, NINETY_TWO_DAYS_AGO);
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

  // Arc 3 sub-slice 28.7 (v2-#28) — drift guard: customer-initiated
  // rotateSecret MUST clear force_rotated_at + grace_window_ends_at
  // so the 91-day clock restarts cleanly. Otherwise a customer who
  // manually rotates after a force-rotation event would carry stale
  // force-rotation bookkeeping forward + the next 91-day sweep would
  // skip them.
  it('v2-#28 sub-slice 28.7 customer-initiated rotateSecret resets force_rotated_at + grace_window_ends_at', async () => {
    const repo = new InMemoryWebhooksRepo();
    const ep = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook',
      secret: 'whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    repo.backdateSecretCreatedAt(ep.id, NINETY_TWO_DAYS_AGO);
    const { svc: emailSvc } = makeFakeEmail();
    const svc = new WebhookSecretForceRotationService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    await svc.tickOnce(NOW);
    const postForce = await repo.findEndpoint(ep.id, 'acc_1');
    expect(postForce?.forceRotatedAt).not.toBeNull();
    expect(postForce?.graceWindowEndsAt).not.toBeNull();
    // Force-rotation moves the customer's original (still-deployed) secret into
    // the grace slot; `secret` becomes the SERVER-minted force secret the
    // customer only ever received as a prefix (never deployed).
    expect(postForce?.secretPrev).toBe('whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const forceSecret = postForce?.secret;
    expect(forceSecret).not.toBe('whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    await repo.rotateSecret({
      id: ep.id,
      accountId: 'acc_1',
      newSecret: 'whsec_customer_rotated_value_padded_____',
      newPrefix: 'whsec_cust',
      graceExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      now: new Date(NOW.getTime() + 60_000),
    });
    const postManual = await repo.findEndpoint(ep.id, 'acc_1');
    expect(postManual?.forceRotatedAt).toBeNull();
    expect(postManual?.graceWindowEndsAt).toBeNull();
    // V-359.G.2 (Fable audit 2026-07-03) — the manual rotation during the still-
    // live force-rotation grace must PRESERVE the customer's original deployed
    // secret (whsec_aged) in the grace slot, NOT clobber it with the un-deployed
    // server force secret. Otherwise the worker would dual-sign {new, force} and
    // BOTH would fail the customer's verifier (still on whsec_aged) → dropped
    // deliveries until they finish rolling out the new secret.
    expect(postManual?.secret).toBe('whsec_customer_rotated_value_padded_____');
    expect(postManual?.secretPrev).toBe('whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(postManual?.secretPrev).not.toBe(forceSecret);
  });

  it('email send failure is swallowed — rotation still persists', async () => {
    const repo = new InMemoryWebhooksRepo();
    const aged = await repo.insertEndpoint({
      accountId: 'acc_1',
      url: 'https://customer.test/hook',
      secret: 'whsec_agedaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      secretPrefix: 'whsec_aged',
      events: ['session.completed'],
      description: null,
    });
    repo.backdateSecretCreatedAt(aged.id, NINETY_TWO_DAYS_AGO);
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
