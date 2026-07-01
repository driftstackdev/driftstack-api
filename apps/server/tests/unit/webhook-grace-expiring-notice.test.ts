// Arc 3 sub-slice 28.5 follow-up — WebhookGraceExpiringNoticeService.tickOnce
// unit tests.
//
// Pins:
//   1. Empty query → no email + no markGraceExpiringNotified + notified=0.
//   2. Match → email fires + markGraceExpiringNotified → notified count
//      increments per match.
//   3. Already-notified endpoint is never returned by the repo query in the
//      first place (findEndpointsNeedingGraceExpiringNotice filters on
//      graceExpiringNotifiedAt IS NULL) — modelled here by a fake repo that
//      excludes already-notified rows, mirroring the real Drizzle query.
//   4. Email failure → NOT marked notified (so the very next tick retries),
//      unlike WebhookRotationReminderService which marks unconditionally.
//   5. accountEmail null → email skipped + NOT marked (retries next tick).
//   6. perTickLimit honored — bounds the email burst.

import { describe, expect, it, vi } from 'vitest';
import {
  WebhookGraceExpiringNoticeService,
  type WebhookGraceExpiringNoticeRepo,
} from '../../src/services/webhook-grace-expiring-notice.js';
import type { EmailService } from '../../src/services/email.js';
import type { WebhookEndpointRow } from '../../src/services/webhooks.js';

const NOW = new Date('2026-06-30T00:00:00Z');
const IN_12_HOURS = new Date(NOW.getTime() + 12 * 60 * 60 * 1000);

type EligibleRow = WebhookEndpointRow & {
  accountEmail: string | null;
  graceExpiringNotifiedAt?: Date | null;
};

function makeRow(overrides: Partial<EligibleRow> = {}): EligibleRow {
  return {
    id: 'whk_1',
    accountId: 'acc_1',
    url: 'https://hooks.example/customer',
    secret: 'whsec_v2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    secretPrefix: 'whsec_v2_bb',
    secretPrev: 'whsec_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    secretPrevExpiresAt: IN_12_HOURS,
    secretCreatedAt: NOW,
    lastReminderSentAt: null,
    // Arc 3 sub-slice 28.1 (v2-#28) — server-initiated force-rotation
    // grace window; this is the field the sweep keys off.
    graceWindowEndsAt: IN_12_HOURS,
    forceRotatedAt: NOW,
    events: ['session.completed'],
    description: null,
    active: true,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    disabledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
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
  } as unknown as ConstructorParameters<typeof WebhookGraceExpiringNoticeService>[2];
}

function makeFakeEmail(): { svc: EmailService; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const svc = {
    isConfigured: true,
    sendWebhookSecretGraceExpiring: (args: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as EmailService;
  return { svc, calls };
}

// Mirrors the real Drizzle query's `graceExpiringNotifiedAt IS NULL` filter —
// an already-notified row is excluded from the eligible set entirely, not
// returned-then-skipped.
function makeFakeRepo(eligible: EligibleRow[]): {
  repo: WebhookGraceExpiringNoticeRepo;
  marked: string[];
} {
  const marked: string[] = [];
  const repo = {
    findEndpointsNeedingGraceExpiringNotice: (_args: {
      now: Date;
      windowHours: number;
      limit: number;
    }) =>
      Promise.resolve(
        eligible.filter((r) => r.graceExpiringNotifiedAt == null).slice(0, _args.limit),
      ),
    markGraceExpiringNotified: (args: { endpointId: string; now: Date }) => {
      marked.push(args.endpointId);
      return Promise.resolve();
    },
  };
  return { repo, marked };
}

describe('Arc 3 sub-slice 28.5 follow-up WebhookGraceExpiringNoticeService.tickOnce', () => {
  it('empty match → no email + no mark + notified=0', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([]);
    const svc = new WebhookGraceExpiringNoticeService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.notified).toBe(0);
    expect(calls).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('eligible endpoint → fires grace-expiring email + marks notified + notified=1', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([makeRow()]);
    const svc = new WebhookGraceExpiringNoticeService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.notified).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.to).toBe('customer@example.com');
    expect(call.endpointUrl).toBe('https://hooks.example/customer');
    expect(call.secretPrefix).toBe('whsec_v2_bb');
    expect(call.graceWindowEndsAt).toBe(IN_12_HOURS);
    expect(marked).toEqual(['whk_1']);
  });

  it('already-notified endpoint is skipped (excluded by the eligibility query itself)', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([
      makeRow({ id: 'whk_already', graceExpiringNotifiedAt: new Date(NOW.getTime() - 1000) }),
    ]);
    const svc = new WebhookGraceExpiringNoticeService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.notified).toBe(0);
    expect(calls).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('email send failure → NOT marked notified, so the next tick naturally retries', async () => {
    const failingEmail = {
      isConfigured: true,
      sendWebhookSecretGraceExpiring: () => Promise.reject(new Error('postmark down')),
    } as unknown as EmailService;
    const { repo, marked } = makeFakeRepo([makeRow()]);
    const svc = new WebhookGraceExpiringNoticeService(repo, failingEmail, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(result.notified).toBe(0);
    expect(marked).toHaveLength(0);
  });

  it('accountEmail null → email skipped + NOT marked notified (retries next tick)', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([makeRow({ accountEmail: null })]);
    const svc = new WebhookGraceExpiringNoticeService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(result.notified).toBe(0);
  });

  it('perTickLimit honored — first N rows processed, rest deferred', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const rows: EligibleRow[] = Array.from({ length: 5 }, (_, i) => makeRow({ id: `whk_${i}` }));
    const { repo, marked } = makeFakeRepo(rows);
    const svc = new WebhookGraceExpiringNoticeService(repo, emailSvc, makeFakeLogger(), {
      perTickLimit: 2,
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(2);
    expect(marked).toEqual(['whk_0', 'whk_1']);
    expect(result.notified).toBe(2);
  });

  it('markGraceExpiringNotified failure after a successful send → not counted (send still happened; next tick may re-send)', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const repo = {
      findEndpointsNeedingGraceExpiringNotice: () => Promise.resolve([makeRow()]),
      markGraceExpiringNotified: () => Promise.reject(new Error('db down')),
    };
    const svc = new WebhookGraceExpiringNoticeService(repo, emailSvc, makeFakeLogger(), {
      dashboardUrl: 'https://app.driftstack.test',
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(1);
    expect(result.notified).toBe(0);
  });
});
