// 2026-05-20 — auth-token sweeper unit test.
//
// Verifies the per-kind delete loop hits all three token tables with
// the correct retention cutoffs.

import { describe, expect, it } from 'vitest';
import {
  AUTH_TOKENS_SWEEP_JOB_TYPE,
  AuthTokensSweeperService,
  nextSweepRunAt,
} from '../../src/services/auth-flows-sweeper.js';
import type { AuthFlowKind, AuthFlowsRepo } from '../../src/services/auth-flows.js';

function mockRepo(): {
  repo: Pick<AuthFlowsRepo, 'deleteStaleAuthTokens'>;
  calls: Array<{ kind: AuthFlowKind; consumedBefore: Date; expiredBefore: Date }>;
  setResponse: (n: number) => void;
} {
  const calls: Array<{ kind: AuthFlowKind; consumedBefore: Date; expiredBefore: Date }> = [];
  let response = 0;
  return {
    calls,
    setResponse(n: number) {
      response = n;
    },
    repo: {
      deleteStaleAuthTokens(args) {
        calls.push(args);
        return Promise.resolve(response);
      },
    },
  };
}

describe('AuthTokensSweeperService', () => {
  it('sweeps all three token kinds (email_verify / magic_link / password_reset) per tick', async () => {
    const { repo, calls } = mockRepo();
    const svc = new AuthTokensSweeperService({ repo: repo as AuthFlowsRepo });
    const now = new Date('2026-05-20T00:00:00Z');
    await svc.tickOnce(now);

    expect(calls.map((c) => c.kind)).toEqual(['email_verify', 'magic_link', 'password_reset']);
  });

  it('uses 30d consumed-retention + 7d expired-retention by default', async () => {
    const { repo, calls } = mockRepo();
    const svc = new AuthTokensSweeperService({ repo: repo as AuthFlowsRepo });
    const now = new Date('2026-05-20T12:00:00Z');
    await svc.tickOnce(now);

    const first = calls[0]!;
    // 30 days before now.
    expect(first.consumedBefore.toISOString()).toBe('2026-04-20T12:00:00.000Z');
    // 7 days before now.
    expect(first.expiredBefore.toISOString()).toBe('2026-05-13T12:00:00.000Z');
  });

  it('honors injected retention overrides', async () => {
    const { repo, calls } = mockRepo();
    const svc = new AuthTokensSweeperService({
      repo: repo as AuthFlowsRepo,
      consumedRetentionDays: 1,
      expiredRetentionDays: 0,
    });
    const now = new Date('2026-05-20T12:00:00Z');
    await svc.tickOnce(now);

    const first = calls[0]!;
    expect(first.consumedBefore.toISOString()).toBe('2026-05-19T12:00:00.000Z');
    expect(first.expiredBefore.toISOString()).toBe('2026-05-20T12:00:00.000Z');
  });

  it('returns per-kind + total deletion counts', async () => {
    const { repo, setResponse } = mockRepo();
    setResponse(5);
    const svc = new AuthTokensSweeperService({ repo: repo as AuthFlowsRepo });
    const result = await svc.tickOnce(new Date('2026-05-20T00:00:00Z'));

    expect(result.deletedByKind).toEqual({
      email_verify: 5,
      magic_link: 5,
      password_reset: 5,
    });
    expect(result.totalDeleted).toBe(15);
  });

  it("AUTH_TOKENS_SWEEP_JOB_TYPE is 'auth_tokens.sweep' (matches the canonical 'resource.verb' admin-action convention)", () => {
    expect(AUTH_TOKENS_SWEEP_JOB_TYPE).toBe('auth_tokens.sweep');
  });

  it('nextSweepRunAt returns 03:00 UTC strictly after now (rolls to tomorrow when now is past 03:00 today)', () => {
    // 02:30 UTC → today 03:00.
    expect(nextSweepRunAt(new Date('2026-05-20T02:30:00Z')).toISOString()).toBe(
      '2026-05-20T03:00:00.000Z',
    );
    // 03:00 UTC exactly → roll to tomorrow (strictly after).
    expect(nextSweepRunAt(new Date('2026-05-20T03:00:00Z')).toISOString()).toBe(
      '2026-05-21T03:00:00.000Z',
    );
    // 10:00 UTC → tomorrow 03:00.
    expect(nextSweepRunAt(new Date('2026-05-20T10:00:00Z')).toISOString()).toBe(
      '2026-05-21T03:00:00.000Z',
    );
    // 23:59 UTC → tomorrow 03:00.
    expect(nextSweepRunAt(new Date('2026-05-20T23:59:00Z')).toISOString()).toBe(
      '2026-05-21T03:00:00.000Z',
    );
  });
});
