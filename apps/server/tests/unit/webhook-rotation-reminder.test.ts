// v2-#10.5 — WebhookRotationReminderService.tickOnce unit tests.
//
// Pins:
//   1. Empty query → no email + no markReminderSent + reminded=0.
//   2. Match → email fires + markReminderSent → reminded count
//      increments per match.
//   3. Email failure swallowed — markReminderSent still called.
//   4. markReminderSent failure → reminder not counted (next tick
//      re-attempts naturally because cooldown query still includes it).
//   5. accountEmail null → email skipped + markReminderSent still
//      fires (so the row doesn't loop forever on every tick).
//   6. perTickLimit honored — bounds the email burst.

import { describe, expect, it, vi } from 'vitest';
import {
  WebhookRotationReminderService,
  type WebhookRotationReminderRepo,
} from '../../src/services/webhook-rotation-reminder.js';
import type { EmailService } from '../../src/services/email.js';
import type { WebhookEndpointRow } from '../../src/services/webhooks.js';

const NOW = new Date('2026-05-18T00:00:00Z');
const SIXTY_DAYS_AGO = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
const SEVENTY_DAYS_AGO = new Date(NOW.getTime() - 70 * 24 * 60 * 60 * 1000);

type EligibleRow = WebhookEndpointRow & { accountEmail: string | null };

function makeRow(overrides: Partial<EligibleRow> = {}): EligibleRow {
  return {
    id: 'whk_1',
    accountId: 'acc_1',
    url: 'https://hooks.example/customer',
    secret: 'whsec_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrefix: 'whsec_v1_aa',
    secretPrev: null,
    secretPrevExpiresAt: null,
    secretCreatedAt: SEVENTY_DAYS_AGO,
    lastReminderSentAt: null,
    // Arc 3 sub-slice 28.1 (v2-#28) server-initiated force-rotation
    // fields — null on customer-initiated rotation-reminder paths.
    graceWindowEndsAt: null,
    forceRotatedAt: null,
    events: ['session.completed'],
    description: null,
    active: true,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    disabledAt: null,
    createdAt: SEVENTY_DAYS_AGO,
    updatedAt: SEVENTY_DAYS_AGO,
    accountEmail: 'customer@example.com',
    ...overrides,
  };
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
  } as unknown as ConstructorParameters<typeof WebhookRotationReminderService>[2];
}

function makeFakeEmail(): { svc: EmailService; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const svc = {
    isConfigured: true,
    sendWebhookSecretRotationReminder: (args: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as EmailService;
  return { svc, calls };
}

function makeFakeRepo(eligible: EligibleRow[]): {
  repo: WebhookRotationReminderRepo;
  marked: string[];
} {
  const marked: string[] = [];
  const repo = {
    findEndpointsNeedingRotationReminder: (_args: {
      now: Date;
      thresholdDays: number;
      cooldownDays: number;
      limit: number;
    }) => Promise.resolve(eligible.slice(0, _args.limit)),
    markReminderSent: (args: { endpointId: string; now: Date }) => {
      marked.push(args.endpointId);
      return Promise.resolve();
    },
  };
  return { repo, marked };
}

describe('v2-#10.5 WebhookRotationReminderService.tickOnce', () => {
  it('empty match → no email + no mark + reminded=0', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([]);
    const svc = new WebhookRotationReminderService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.reminded).toBe(0);
    expect(calls).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('match → fires reminder email + marks sent + reminded=1', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([makeRow()]);
    const svc = new WebhookRotationReminderService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.reminded).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.to).toBe('customer@example.com');
    expect(call.endpointUrl).toBe('https://hooks.example/customer');
    expect(call.secretPrefix).toBe('whsec_v1_aa');
    expect(call.ageDays).toBe(70);
    expect(call.rotateBy).toBeInstanceOf(Date);
    expect(marked).toEqual(['whk_1']);
  });

  it('email failure swallowed — markReminderSent still called + reminded counted', async () => {
    const failingEmail = {
      isConfigured: true,
      sendWebhookSecretRotationReminder: () => Promise.reject(new Error('postmark down')),
    } as unknown as EmailService;
    const { repo, marked } = makeFakeRepo([makeRow()]);
    const svc = new WebhookRotationReminderService(repo, failingEmail, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.reminded).toBe(1);
    expect(marked).toEqual(['whk_1']);
  });

  it('markReminderSent failure → not counted; next tick retries', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const repo = {
      findEndpointsNeedingRotationReminder: () => Promise.resolve([makeRow()]),
      markReminderSent: () => Promise.reject(new Error('db down')),
    };
    const svc = new WebhookRotationReminderService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(1);
    expect(result.reminded).toBe(0);
  });

  it("accountEmail null → email skipped + markReminderSent still fires (don't loop forever)", async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([makeRow({ accountEmail: null })]);
    const svc = new WebhookRotationReminderService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(marked).toEqual(['whk_1']);
    expect(result.reminded).toBe(1);
  });

  it('perTickLimit honored — first N rows processed, rest deferred', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const rows: EligibleRow[] = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `whk_${i}`, secretCreatedAt: SIXTY_DAYS_AGO }),
    );
    const { repo, marked } = makeFakeRepo(rows);
    const svc = new WebhookRotationReminderService(repo, emailSvc, makeFakeLogger(), {
      perTickLimit: 2,
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(2);
    expect(marked).toEqual(['whk_0', 'whk_1']);
    expect(result.reminded).toBe(2);
  });
});
