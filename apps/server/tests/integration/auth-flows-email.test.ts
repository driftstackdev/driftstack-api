// V-085: integration tests for the auth-flow → Postmark wiring.
//
// The default integration fixture uses a no-op email service (Postmark
// config null). These tests construct a parallel flow against a stub
// Postmark client to verify the actual send path fires for each
// auth-flow trigger (signup verification email, magic-link request,
// password-reset request).

import { describe, expect, it } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import {
  AuthFlowsService,
  AuthFlowError,
  type AuthFlowsRepo,
} from '../../src/services/auth-flows.js';
import { createEmailService, type PostmarkSendApi } from '../../src/services/email.js';
import type { EmailPreferencesService } from '../../src/services/email-preferences.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';

interface StubSendCall {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function makeStubPostmark(): { client: PostmarkSendApi; calls: StubSendCall[] } {
  const calls: StubSendCall[] = [];
  const client: PostmarkSendApi = {
    sendEmail(input) {
      calls.push({
        to: input.To,
        subject: input.Subject,
        text: input.TextBody,
        html: input.HtmlBody,
      });
      return Promise.resolve({ MessageID: 'stub-message-id' });
    },
  };
  return { client, calls };
}

function makeService(repo: AuthFlowsRepo, postmark: PostmarkSendApi): AuthFlowsService {
  const logger = createTestLogger();
  const email = createEmailService({
    config: {
      apiToken: 'stub-token',
      from: 'noreply@driftstack.local',
      replyTo: 'support@driftstack.local',
    },
    logger,
    client: postmark,
  });
  return new AuthFlowsService(repo, email, logger, {
    verifyEmailUrl: 'https://app.driftstack.local/verify-email',
    magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
    passwordResetUrl: 'https://app.driftstack.local/reset-password',
    exposeDebugToken: true,
  });
}

async function flushEmailQueue(): Promise<void> {
  // sendSignupVerification + friends are fire-and-forget via `void
  // this.email.sendXyz(...)`. Awaiting a microtask is enough for the
  // promise to resolve through the synchronous stub.
  await Promise.resolve();
}

describe('AuthFlowsService → Postmark integration (V-085)', () => {
  it('signup fires sendSignupVerification with the verify URL', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    const result = await service.signup({
      email: 'newuser@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: '127.0.0.1',
    });

    await flushEmailQueue();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe('newuser@driftstack.local');
    expect(calls[0]?.subject).toBe('Verify your Driftstack account');
    expect(calls[0]?.text).toContain('https://app.driftstack.local/verify-email?token=');
    expect(calls[0]?.text).toContain(result.debugToken!);
  });

  it('magic-link request fires the email when the email matches an account', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    await service.signup({
      email: 'returning@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    calls.length = 0; // clear the signup-verify email

    const result = await service.requestMagicLink({
      email: 'returning@driftstack.local',
      requestedFromIp: null,
    });

    await flushEmailQueue();
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(1);
    // Magic-link reuses the signup-verification template at scaffolding
    // time (V-079 reuses sendSignupVerification for both flows). When the
    // template diverges, this assertion gets updated.
    expect(calls[0]?.to).toBe('returning@driftstack.local');
    expect(calls[0]?.text).toContain('https://app.driftstack.local/auth/magic-link?token=');
  });

  it('routes every Gmail-alias credential to the stored account address, never the requester spelling', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    await service.signup({
      email: 'stored.alias@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    calls.length = 0;

    const requesterAlias = 'storedalias+anonymous-request@gmail.com';
    const resend = await service.resendSignupVerification({
      email: requesterAlias,
      requestedFromIp: null,
    });
    const magic = await service.requestMagicLink({
      email: requesterAlias,
      requestedFromIp: null,
    });
    const reset = await service.requestPasswordReset({
      email: requesterAlias,
      requestedFromIp: null,
    });

    await flushEmailQueue();
    expect(resend.sent).toBe(true);
    expect(magic.sent).toBe(true);
    expect(reset.sent).toBe(true);
    expect(calls.map((call) => call.to)).toEqual([
      'stored.alias@gmail.com',
      'stored.alias@gmail.com',
      'stored.alias@gmail.com',
    ]);
    expect(calls.some((call) => call.to === requesterAlias)).toBe(false);
  });

  it('does not resolve a non-Gmail +address to a different base mailbox', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    await service.signup({
      email: 'victim@distinct-mailbox.test',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    calls.length = 0;

    const distinctMailbox = 'victim+attacker@distinct-mailbox.test';
    const resend = await service.resendSignupVerification({
      email: distinctMailbox,
      requestedFromIp: null,
    });
    const magic = await service.requestMagicLink({
      email: distinctMailbox,
      requestedFromIp: null,
    });
    const reset = await service.requestPasswordReset({
      email: distinctMailbox,
      requestedFromIp: null,
    });

    await flushEmailQueue();
    expect(resend.sent).toBe(false);
    expect(magic.sent).toBe(false);
    expect(reset.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('magic-link single-use under concurrency: two simultaneous consumes of the same token → exactly one session, one InvalidAuthToken', async () => {
    // Regression for the find-then-consume race: both requests pass
    // findActiveAuthToken (token still active), but the atomic conditional
    // consume (returns whether THIS call claimed it) must let only one proceed
    // — otherwise one magic link mints two web sessions. Deterministic with the
    // in-memory repo: both finds resolve, then the first consume claims the row
    // and the second sees it already consumed.
    const repo = new InMemoryAuthFlowsRepo();
    const { client } = makeStubPostmark();
    const service = makeService(repo, client);

    await service.signup({
      email: 'race@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const req = await service.requestMagicLink({
      email: 'race@driftstack.local',
      requestedFromIp: null,
    });
    const token = req.debugToken;
    expect(token).not.toBeNull();

    const results = await Promise.allSettled([
      service.consumeMagicLink({ token: token!, issuedFromIp: null, userAgent: null }),
      service.consumeMagicLink({ token: token!, issuedFromIp: null, userAgent: null }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AuthFlowError);
  });

  it('magic-link request silently no-ops when email is unknown', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    const result = await service.requestMagicLink({
      email: 'ghost@driftstack.local',
      requestedFromIp: null,
    });
    await flushEmailQueue();
    expect(result.sent).toBe(false);
    expect(result.debugToken).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('password-reset request fires the password-reset template', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    await service.signup({
      email: 'resetter@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    calls.length = 0;

    const result = await service.requestPasswordReset({
      email: 'resetter@driftstack.local',
      requestedFromIp: null,
    });
    await flushEmailQueue();
    expect(result.sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('Reset your Driftstack password');
    expect(calls[0]?.text).toContain('https://app.driftstack.local/reset-password?token=');
  });

  it('password-reset silently no-ops when email is unknown', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);

    const result = await service.requestPasswordReset({
      email: 'unknown@driftstack.local',
      requestedFromIp: null,
    });
    await flushEmailQueue();
    expect(result.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('email send failure does not break the auth flow', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const failingClient: PostmarkSendApi = {
      sendEmail() {
        return Promise.reject(new Error('Postmark unreachable'));
      },
    };
    const service = makeService(repo, failingClient);

    // Signup must still succeed (account row created, verify token issued)
    // even when the Postmark send rejects — that's the fire-and-forget
    // contract.
    const result = await service.signup({
      email: 'flaky-postmark@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    await flushEmailQueue();

    expect(result.account.id).toBeDefined();
    expect(result.debugToken).toBeDefined();
  });
});

describe('AuthFlowsService signup — concurrent same-email race', () => {
  function make23505(): Error {
    return Object.assign(
      new Error('duplicate key value violates unique constraint "accounts_email_unique"'),
      { code: '23505', constraint_name: 'accounts_email_unique' },
    );
  }

  it('translates a same-email 23505 (race loser) into email_already_registered, not a 500', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    // The findAccountByEmail pre-check misses (empty store), but a sibling
    // request committed first → createAccount hits accounts_email_unique.
    repo.createAccount = () => Promise.reject(make23505());
    const { client } = makeStubPostmark();
    const service = makeService(repo, client);

    await expect(
      service.signup({
        email: 'race@driftstack.local',
        password: 'correct horse battery staple',
        requestedFromIp: '127.0.0.1',
      }),
    ).rejects.toMatchObject({ code: 'email_already_registered' });
  });

  it('re-throws a non-email-constraint error (the catch is precise, not a catch-all)', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    repo.createAccount = () => Promise.reject(new Error('db exploded'));
    const { client } = makeStubPostmark();
    const service = makeService(repo, client);

    await expect(
      service.signup({
        email: 'other@driftstack.local',
        password: 'correct horse battery staple',
        requestedFromIp: '127.0.0.1',
      }),
    ).rejects.toThrow('db exploded');
  });
});

describe('C9 — signup-welcome fires once on first verify + honors opt-out', () => {
  // The welcome send chains two awaits (shouldSend → sendSignupWelcome); drain
  // generously so a would-be send definitely lands before we assert.
  async function drain(): Promise<void> {
    await new Promise((r) => setTimeout(r, 5));
  }

  it('the first verification sends exactly one welcome email', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);
    const signup = await service.signup({
      email: 'welcome@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    calls.length = 0; // drop the signup-verification email
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: '127.0.0.1',
      userAgent: 'test',
    });
    await drain();
    expect(calls).toHaveLength(1); // the welcome
  });

  it('the first verification retires every outstanding sibling token', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const service = makeService(repo, client);
    const signup = await service.signup({
      email: 'reverify@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    // Resend leaves both links eligible until either one wins.
    const resend = await service.resendSignupVerification({
      email: 'reverify@driftstack.local',
      requestedFromIp: null,
    });
    calls.length = 0;
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    await drain();
    expect(calls).toHaveLength(1); // first verify → one welcome
    calls.length = 0;
    // The first link's family claim retired the resend sibling, so it cannot
    // act as a lingering passwordless-login credential.
    await expect(
      service.verifyEmail({
        token: resend.debugToken as string,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    await drain();
    expect(calls).toHaveLength(0);
  });

  it("honors the 'signup-welcome' opt-out (no welcome when preferences.shouldSend is false)", async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const { client, calls } = makeStubPostmark();
    const logger = createTestLogger();
    const email = createEmailService({
      config: {
        apiToken: 'stub-token',
        from: 'noreply@driftstack.local',
        replyTo: 'support@driftstack.local',
      },
      logger,
      client,
    });
    const prefs = {
      shouldSend: (_accountId: string, eventType: string): Promise<boolean> =>
        Promise.resolve(eventType !== 'signup-welcome'),
    } as unknown as EmailPreferencesService;
    const service = new AuthFlowsService(
      repo,
      email,
      logger,
      {
        verifyEmailUrl: 'https://app.driftstack.local/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/reset-password',
        exposeDebugToken: true,
      },
      null, // authCache
      null, // accountAudit
      null, // mfa
      null, // mfaChallenges
      prefs, // C9 — email preferences
    );
    const signup = await service.signup({
      email: 'optout@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    calls.length = 0;
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    await drain();
    expect(calls).toHaveLength(0); // opted out → no welcome
  });
});
