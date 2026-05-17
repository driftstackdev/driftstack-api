// v2-#11.5 — ByokAnthropicRotationReminderService.tickOnce unit tests.
//
// Mirrors v2-#10.5 webhook-rotation-reminder.test.ts. Pins:
//   1. Empty query → no email + no mark + reminded=0.
//   2. Match → fires email + marks sent.
//   3. Email failure swallowed; mark still fires.
//   4. markReminderSent failure → not counted (next tick retries).
//   5. accountEmail null → email skipped + mark still fires.
//   6. perTickLimit honored.

import { describe, expect, it, vi } from 'vitest';
import {
  ByokAnthropicRotationReminderService,
  type ByokAnthropicReminderRow,
  type ByokAnthropicRotationReminderRepo,
} from '../../src/services/byok-anthropic-rotation-reminder.js';
import type { EmailService } from '../../src/services/email.js';

const NOW = new Date('2026-05-18T00:00:00Z');
const SEVENTY_DAYS_AGO = new Date(NOW.getTime() - 70 * 24 * 60 * 60 * 1000);

function makeRow(overrides: Partial<ByokAnthropicReminderRow> = {}): ByokAnthropicReminderRow {
  return {
    accountId: 'acc_1',
    accountEmail: 'customer@example.com',
    byokAnthropicApiKeySetAt: SEVENTY_DAYS_AGO,
    byokAnthropicApiKeyLastReminderSentAt: null,
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
  } as unknown as Parameters<typeof ByokAnthropicRotationReminderService>[2];
}

function makeFakeEmail(): { svc: EmailService; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const svc = {
    isConfigured: true,
    sendByokAnthropicKeyRotationReminder: (args: Record<string, unknown>) => {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as EmailService;
  return { svc, calls };
}

function makeFakeRepo(eligible: ByokAnthropicReminderRow[]): {
  repo: ByokAnthropicRotationReminderRepo;
  marked: string[];
} {
  const marked: string[] = [];
  const repo = {
    findAccountsNeedingRotationReminder: (args: {
      now: Date;
      thresholdDays: number;
      cooldownDays: number;
      limit: number;
    }) => Promise.resolve(eligible.slice(0, args.limit)),
    markReminderSent: (args: { accountId: string; now: Date }) => {
      marked.push(args.accountId);
      return Promise.resolve();
    },
  };
  return { repo, marked };
}

describe('v2-#11.5 ByokAnthropicRotationReminderService.tickOnce', () => {
  it('empty match → no email + no mark + reminded=0', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([]);
    const svc = new ByokAnthropicRotationReminderService(repo, emailSvc, makeFakeLogger());
    const result = await svc.tickOnce(NOW);
    expect(result.reminded).toBe(0);
    expect(calls).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('match → fires reminder + marks sent + reminded=1', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([makeRow()]);
    const svc = new ByokAnthropicRotationReminderService(repo, emailSvc, makeFakeLogger());
    const result = await svc.tickOnce(NOW);
    expect(result.reminded).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.to).toBe('customer@example.com');
    expect(call.ageDays).toBe(70);
    expect(call.rotateBy).toBeInstanceOf(Date);
    expect(marked).toEqual(['acc_1']);
  });

  it('email failure swallowed — mark still fires', async () => {
    const failingEmail = {
      isConfigured: true,
      sendByokAnthropicKeyRotationReminder: () => Promise.reject(new Error('postmark down')),
    } as unknown as EmailService;
    const { repo, marked } = makeFakeRepo([makeRow()]);
    const svc = new ByokAnthropicRotationReminderService(repo, failingEmail, makeFakeLogger());
    const result = await svc.tickOnce(NOW);
    expect(result.reminded).toBe(1);
    expect(marked).toEqual(['acc_1']);
  });

  it('markReminderSent failure → not counted; next tick retries', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const repo = {
      findAccountsNeedingRotationReminder: () => Promise.resolve([makeRow()]),
      markReminderSent: () => Promise.reject(new Error('db down')),
    };
    const svc = new ByokAnthropicRotationReminderService(repo, emailSvc, makeFakeLogger());
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(1);
    expect(result.reminded).toBe(0);
  });

  it('accountEmail null → email skipped + mark still fires', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const { repo, marked } = makeFakeRepo([makeRow({ accountEmail: null })]);
    const svc = new ByokAnthropicRotationReminderService(repo, emailSvc, makeFakeLogger());
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(0);
    expect(marked).toEqual(['acc_1']);
    expect(result.reminded).toBe(1);
  });

  it('perTickLimit honored', async () => {
    const { svc: emailSvc, calls } = makeFakeEmail();
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ accountId: `acc_${i}` }));
    const { repo, marked } = makeFakeRepo(rows);
    const svc = new ByokAnthropicRotationReminderService(repo, emailSvc, makeFakeLogger(), {
      perTickLimit: 2,
    });
    const result = await svc.tickOnce(NOW);
    expect(calls).toHaveLength(2);
    expect(marked).toEqual(['acc_0', 'acc_1']);
    expect(result.reminded).toBe(2);
  });
});
