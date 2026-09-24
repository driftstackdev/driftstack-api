// A webhook event that cannot be queued is logged, at error, with its type and account.
//
// Webhooks audit #5 (2026-09-24, plausible). Every `enqueueEvent` caller treats
// the webhook as best-effort — the state change it reports has already
// committed, and failing the request (or an IPN ack) over it would be worse —
// and almost every catch was empty. The audit's scenario: an IPN commits a
// crypto order as `paid`, the connection resets on the delivery insert, the
// error is swallowed; NowPayments re-sends the IPN, but an already-paid order
// "does not fire the event again". The customer never gets `crypto.order.paid`,
// and nothing anywhere says so.
//
// Every caller now logs the loss at ERROR with the event type and the account
// (`logLostWebhookEvent`); the two services that had no logger were given one. Driven through the real callers with
// a sink that rejects; the last arm is the roster of call sites, so a new
// caller cannot quietly bring an empty catch back.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import { makeChallengeRelay } from '../../src/services/challenge-relay.js';
import { makeProfileSaveFailedRelay } from '../../src/services/profile-save-failed-relay.js';
import { CryptoOrdersService, InMemoryCryptoOrdersRepo } from '../../src/services/crypto-orders.js';
import { SessionsService } from '../../src/services/sessions.js';
import { AuthFlowsService, type AuthFlowsRepo } from '../../src/services/auth-flows.js';
import type { EmailService } from '../../src/services/email.js';
import type { Driver } from '../../src/drivers/types.js';
import { ApiKeysService, type ApiKeysRepo } from '../../src/services/api-keys.js';
import { TeamMembersService, type TeamMembersRepo } from '../../src/services/team-members.js';
import type { AccountContext, ApiKeyRow } from '../../src/services/auth.js';
import { InMemorySessionsRepo } from '../integration/_helpers/in-memory-sessions-repo.js';

interface Logged {
  obj: Record<string, unknown>;
  msg: string;
}

function capturingLogger(): { logger: Logger; errors: Logged[] } {
  const errors: Logged[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: (obj: Record<string, unknown>, msg: string) => {
      errors.push({ obj, msg });
    },
  } as unknown as Logger;
  return { logger, errors };
}

const rejectingWebhooks = {
  enqueueEvent: (): Promise<number> => Promise.reject(new Error('connection reset')),
};

/** The one line every caller must write for a lost event. */
function lostEventLines(errors: Logged[]): Array<{ eventType: unknown; accountId: unknown }> {
  return errors
    .filter((e) => e.obj.event === 'webhook_event_not_queued')
    .map((e) => ({ eventType: e.obj.event_type, accountId: e.obj.account_id }));
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('a webhook event that cannot be queued is logged with its type and account', () => {
  it('CRITICAL crypto.order.paid — the audit’s scenario: the order stays paid, and the lost event is logged at error', async () => {
    const { logger, errors } = capturingLogger();
    const svc = new CryptoOrdersService({
      repo: new InMemoryCryptoOrdersRepo(),
      webhooks: rejectingWebhooks,
      logger,
    });
    await svc.create({
      order_id: 'ord_lost',
      account_id: 'acc_paid',
      product: 'api_starter_monthly',
      price_cents: 999,
      price_currency: 'EUR',
    });
    const updated = await svc.applyIpnStatus({
      order_id: 'ord_lost',
      payment_id: 'np_lost',
      provider_status: 'finished',
    });
    expect(updated?.status).toBe('paid');
    expect(lostEventLines(errors)).toEqual([
      { eventType: 'crypto.order.paid', accountId: 'acc_paid' },
    ]);
  });

  it('CRITICAL crypto.order.failed is logged the same way', async () => {
    const { logger, errors } = capturingLogger();
    const svc = new CryptoOrdersService({
      repo: new InMemoryCryptoOrdersRepo(),
      webhooks: rejectingWebhooks,
      logger,
    });
    await svc.create({
      order_id: 'ord_fail',
      account_id: 'acc_failed',
      product: 'api_starter_monthly',
      price_cents: 999,
      price_currency: 'EUR',
    });
    await svc.applyIpnStatus({
      order_id: 'ord_fail',
      payment_id: 'np_f',
      provider_status: 'failed',
    });
    expect(lostEventLines(errors)).toEqual([
      { eventType: 'crypto.order.failed', accountId: 'acc_failed' },
    ]);
  });

  it('CRITICAL session.completed from a destroy is logged per lost event, and the sessions are still destroyed', async () => {
    const { logger, errors } = capturingLogger();
    const repo = new InMemorySessionsRepo();
    const driver = { destroy: () => Promise.resolve() } as unknown as Driver;
    const sessions = new SessionsService({ repo, driver, webhooks: rejectingWebhooks, logger });
    const now = new Date('2026-09-24T12:00:00.000Z');
    repo.seedSession({
      accountId: 'acc-s',
      status: 'ready',
      createdAt: now,
      driverSessionId: 'd1',
    });
    repo.seedSession({
      accountId: 'acc-s',
      status: 'ready',
      createdAt: now,
      driverSessionId: 'd2',
    });

    expect(await sessions.destroyAllForAccount('acc-s')).toBe(2);
    expect(lostEventLines(errors)).toEqual([
      { eventType: 'session.completed', accountId: 'acc-s' },
      { eventType: 'session.completed', accountId: 'acc-s' },
    ]);
  });

  it('CRITICAL api_key.revoked after a password reset is logged at ERROR (it was a warn with no event type or account)', async () => {
    const { logger, errors } = capturingLogger();
    const repo = {
      revokeCredentialsAfterPasswordReset: () =>
        Promise.resolve({ webSessions: 0, deviceKeys: [{ id: 'k1', name: 'Desktop client' }] }),
    } as unknown as AuthFlowsRepo;
    const flows = new AuthFlowsService(
      repo,
      {} as EmailService,
      logger,
      {
        verifyEmailUrl: 'https://x.test/v',
        magicLinkUrl: 'https://x.test/m',
        passwordResetUrl: 'https://x.test/r',
        exposeDebugToken: false,
      },
      null,
      null,
      null,
      null,
      null,
      rejectingWebhooks,
    );
    const reset = flows as unknown as {
      revokeSessionsAfterPasswordReset(a: string, k: string | null, now: Date): Promise<number>;
    };
    await reset.revokeSessionsAfterPasswordReset('acc-reset', null, new Date());
    expect(lostEventLines(errors)).toEqual([
      { eventType: 'api_key.revoked', accountId: 'acc-reset' },
    ]);
  });

  it('CRITICAL api_key.revoked from a direct revoke is logged — the revoke itself still succeeds', async () => {
    const { logger, errors } = capturingLogger();
    const key = {
      id: 'k-direct',
      accountId: 'acc-keys',
      name: 'ci',
      revokedAt: new Date('2026-09-24T10:00:00.000Z'),
    } as unknown as ApiKeyRow;
    const repo = {
      revokeApiKeyAtomic: () => Promise.resolve({ kind: 'revoked' as const, key }),
    } as unknown as ApiKeysRepo;
    const svc = new ApiKeysService(repo, null, rejectingWebhooks, null, null, logger);
    const ctx = {
      account: { id: 'acc-keys' },
      apiKey: { id: 'key_owner', scopes: ['account_owner'] },
    } as unknown as AccountContext;

    expect(await svc.revoke(ctx, 'k-direct')).toBe(true);
    expect(lostEventLines(errors)).toEqual([
      { eventType: 'api_key.revoked', accountId: 'acc-keys' },
    ]);
  });

  it('CRITICAL api_key.revoked for each key a team-member removal revokes is logged against the owner', async () => {
    const { logger, errors } = capturingLogger();
    const repo = {
      removeMemberWithInvites: () =>
        Promise.resolve({
          memberAccountId: 'acc-member',
          revokedApiKeyIds: ['k1', 'k2'],
          revokedApiKeys: [
            { id: 'k1', name: 'ci' },
            { id: 'k2', name: 'etl' },
          ],
          revokedAt: new Date('2026-09-24T10:00:00.000Z'),
        }),
    } as unknown as TeamMembersRepo;
    const svc = new TeamMembersService(
      repo,
      {} as EmailService,
      { dashboardBaseUrl: 'https://app.test' },
      null,
      null,
      rejectingWebhooks,
      logger,
    );

    expect(await svc.removeMember({ membershipId: 'mem_1', ownerAccountId: 'acc-owner' })).toBe(
      true,
    );
    expect(lostEventLines(errors)).toEqual([
      { eventType: 'api_key.revoked', accountId: 'acc-owner' },
      { eventType: 'api_key.revoked', accountId: 'acc-owner' },
    ]);
  });

  it('CRITICAL the two harness relays log the lost event with the account, not only the session', async () => {
    const challenge = capturingLogger();
    makeChallengeRelay(
      { get: () => Promise.resolve({ accountId: 'acc-c', nodeId: 'node-1' }) },
      rejectingWebhooks,
      challenge.logger,
    )(
      {
        type: 'challengeDetected',
        sessionId: 'ses_1',
        challengeId: 'chl_1',
        challenge: { type: 'datadome', confidence: 0.9 },
      },
      'node-1',
    );
    const profile = capturingLogger();
    makeProfileSaveFailedRelay(
      {
        get: () => Promise.resolve({ accountId: 'acc-p', nodeId: 'node-1', profileId: 'prof_1' }),
      },
      rejectingWebhooks,
      profile.logger,
    )(
      {
        type: 'profileSaveFailed',
        sessionId: 'agt_1',
        profile_id: 'prof_1',
        reason: 'upload_failed',
      },
      'node-1',
    );
    await flush();
    await flush();
    expect(lostEventLines(challenge.errors)).toEqual([
      { eventType: 'session.challenge_detected', accountId: 'acc-c' },
    ]);
    expect(lostEventLines(profile.errors)).toEqual([
      { eventType: 'session.profile_save_failed', accountId: 'acc-p' },
    ]);
  });

  it('CRITICAL every awaited enqueueEvent call site logs a loss with logLostWebhookEvent', () => {
    const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

    const sites: Array<{ file: string; logs: boolean }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const src = readFileSync(full, 'utf8');
          const rel = full.slice(SRC.length + 1);
          for (const m of src.matchAll(/await\s+[\w.]*enqueueEvent\(/g)) {
            // The catch that handles THIS call: the first `catch` after it.
            const after = src.slice(m.index);
            const catchAt = after.search(/\bcatch\b/);
            const handler = catchAt === -1 ? '' : after.slice(catchAt, catchAt + 700);
            sites.push({ file: rel, logs: handler.includes('logLostWebhookEvent(') });
          }
        }
      }
    };
    walk(SRC);

    // Positive control: the scan really found the callers (sessions alone has five).
    expect(sites.length, 'the scan found too few enqueueEvent call sites').toBeGreaterThanOrEqual(
      10,
    );
    const silent = [...new Set(sites.filter((s) => !s.logs).map((s) => s.file))].sort();
    expect(silent, 'enqueueEvent call sites whose catch does not log the lost event').toEqual([]);
  });
});
