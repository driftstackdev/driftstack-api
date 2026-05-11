// V-553.B-7 — unit tests for V-204 EmailPreferencesService.
//
// Scope of coverage:
//   - default-opted-in synthesis: list returns one row per
//     OptOutableEmailEvent even when the repo has nothing stored
//   - persisted overrides: stored rows replace the default row
//   - set() pass-through and V-330d effectiveAccountId redirect
//   - shouldSend() gate semantics (default-opted-in)
//   - scope guard: 'account_owner' required on read + write

import { describe, expect, it, vi } from 'vitest';
import type { OptOutableEmailEvent, ApiKeyScope } from '@driftstack/api-types';
import {
  EmailPreferencesService,
  type EmailPreferenceRecord,
  type EmailPreferencesRepo,
} from '../../src/services/email-preferences.js';
import type { AccountContext } from '../../src/services/auth.js';

const ALL_EVENTS: OptOutableEmailEvent[] = [
  'signup-welcome',
  'session-failed-first',
  'session-success-first',
  'tier-changed',
  'trial-pack-purchased',
  'trial-pack-expired',
  'billing-receipt',
  'billing-renewal-reminder',
];

function ctxWithScopes(accountId: string, scopes: ApiKeyScope[]): AccountContext {
  return {
    account: { id: accountId },
    apiKey: { scopes },
  } as unknown as AccountContext;
}

function makeRepo(initial: EmailPreferenceRecord[] = []): {
  repo: EmailPreferencesRepo;
  listSpy: ReturnType<typeof vi.fn>;
  setSpy: ReturnType<typeof vi.fn>;
  isOptedOutSpy: ReturnType<typeof vi.fn>;
  rows: EmailPreferenceRecord[];
} {
  const rows: EmailPreferenceRecord[] = [...initial];
  const listSpy = vi.fn((accountId: string) =>
    Promise.resolve(rows.filter((r) => r.accountId === accountId)),
  );
  const setSpy = vi.fn((accountId: string, eventType: OptOutableEmailEvent, optedIn: boolean) => {
    const idx = rows.findIndex((r) => r.accountId === accountId && r.eventType === eventType);
    if (optedIn) {
      if (idx >= 0) rows.splice(idx, 1);
    } else if (idx >= 0) {
      rows[idx] = { accountId, eventType, optedIn, updatedAt: new Date() };
    } else {
      rows.push({ accountId, eventType, optedIn, updatedAt: new Date() });
    }
    return Promise.resolve();
  });
  const isOptedOutSpy = vi.fn((accountId: string, eventType: OptOutableEmailEvent) => {
    const row = rows.find((r) => r.accountId === accountId && r.eventType === eventType);
    return Promise.resolve(row ? !row.optedIn : false);
  });
  return {
    repo: { list: listSpy, set: setSpy, isOptedOut: isOptedOutSpy },
    listSpy,
    setSpy,
    isOptedOutSpy,
    rows,
  };
}

describe('V-553.B-7 EmailPreferencesService.list — default-opted-in synthesis', () => {
  it('returns one row per opt-outable event type when repo is empty', async () => {
    const { repo } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    const rows = await svc.list(ctxWithScopes('acc_1', ['account_owner']));
    expect(rows).toHaveLength(ALL_EVENTS.length);
    const seen = new Set(rows.map((r) => r.eventType));
    for (const ev of ALL_EVENTS) expect(seen.has(ev)).toBe(true);
    // Defaults are all opted-in.
    expect(rows.every((r) => r.optedIn)).toBe(true);
    // Defaults carry the epoch sentinel updatedAt so consumers can
    // tell "never customised" apart from a real change.
    expect(rows.every((r) => r.updatedAt.getTime() === 0)).toBe(true);
  });

  it('merges stored opt-outs over the default-opted-in synthesis', async () => {
    const stored: EmailPreferenceRecord = {
      accountId: 'acc_1',
      eventType: 'billing-receipt',
      optedIn: false,
      updatedAt: new Date('2026-05-01T00:00:00Z'),
    };
    const { repo } = makeRepo([stored]);
    const svc = new EmailPreferencesService(repo);
    const rows = await svc.list(ctxWithScopes('acc_1', ['account_owner']));
    expect(rows).toHaveLength(ALL_EVENTS.length);
    const persisted = rows.find((r) => r.eventType === 'billing-receipt');
    expect(persisted).toBeDefined();
    expect(persisted?.optedIn).toBe(false);
    expect(persisted?.updatedAt.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    // The other 7 events remain default-opted-in.
    const others = rows.filter((r) => r.eventType !== 'billing-receipt');
    expect(others.every((r) => r.optedIn)).toBe(true);
  });

  it('honours V-330d effectiveAccountId — lists OWNER preferences, not caller', async () => {
    const owner: EmailPreferenceRecord = {
      accountId: 'acc_owner',
      eventType: 'signup-welcome',
      optedIn: false,
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    };
    const { repo, listSpy } = makeRepo([owner]);
    const svc = new EmailPreferencesService(repo);
    const rows = await svc.list(ctxWithScopes('acc_member', ['account_owner']), {
      effectiveAccountId: 'acc_owner',
    });
    expect(listSpy).toHaveBeenCalledWith('acc_owner');
    const optedOut = rows.find((r) => r.eventType === 'signup-welcome');
    expect(optedOut?.optedIn).toBe(false);
  });

  it('throws when caller is missing the account_owner scope', async () => {
    const { repo } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    await expect(svc.list(ctxWithScopes('acc_1', ['read']))).rejects.toThrow(/account_owner/);
  });
});

describe('V-553.B-7 EmailPreferencesService.set', () => {
  it('writes through to the repo with (accountId, eventType, optedIn)', async () => {
    const { repo, setSpy } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    await svc.set(ctxWithScopes('acc_1', ['account_owner']), 'billing-receipt', false);
    expect(setSpy).toHaveBeenCalledWith('acc_1', 'billing-receipt', false);
  });

  it('routes V-330d effectiveAccountId writes to the OWNER account', async () => {
    const { repo, setSpy } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    await svc.set(ctxWithScopes('acc_member', ['account_owner']), 'tier-changed', false, {
      effectiveAccountId: 'acc_owner',
    });
    expect(setSpy).toHaveBeenCalledWith('acc_owner', 'tier-changed', false);
  });

  it('opt-in (optedIn=true) is forwarded — repo treats it as "delete row"', async () => {
    const { repo, setSpy, rows } = makeRepo([
      {
        accountId: 'acc_1',
        eventType: 'billing-receipt',
        optedIn: false,
        updatedAt: new Date('2026-05-01T00:00:00Z'),
      },
    ]);
    const svc = new EmailPreferencesService(repo);
    await svc.set(ctxWithScopes('acc_1', ['account_owner']), 'billing-receipt', true);
    expect(setSpy).toHaveBeenCalledWith('acc_1', 'billing-receipt', true);
    // The fake repo enforces the default-opted-in convention.
    expect(rows.find((r) => r.eventType === 'billing-receipt')).toBeUndefined();
  });

  it('throws when caller is missing the account_owner scope', async () => {
    const { repo } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    await expect(
      svc.set(ctxWithScopes('acc_1', ['write']), 'billing-receipt', false),
    ).rejects.toThrow(/account_owner/);
  });
});

describe('V-553.B-7 EmailPreferencesService.shouldSend', () => {
  it('returns true (opted-in) by default when no row exists', async () => {
    const { repo } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    await expect(svc.shouldSend('acc_1', 'signup-welcome')).resolves.toBe(true);
  });

  it('returns false when the customer has explicitly opted out', async () => {
    const { repo } = makeRepo([
      {
        accountId: 'acc_1',
        eventType: 'tier-changed',
        optedIn: false,
        updatedAt: new Date(),
      },
    ]);
    const svc = new EmailPreferencesService(repo);
    await expect(svc.shouldSend('acc_1', 'tier-changed')).resolves.toBe(false);
  });

  it('is service-internal — does not require an AccountContext / scope', async () => {
    // The gate is wired inside EmailService send methods which run
    // off the auth-cache pipeline. There is intentionally no scope
    // check here.
    const { repo, isOptedOutSpy } = makeRepo();
    const svc = new EmailPreferencesService(repo);
    await svc.shouldSend('acc_1', 'billing-receipt');
    expect(isOptedOutSpy).toHaveBeenCalledWith('acc_1', 'billing-receipt');
  });
});
