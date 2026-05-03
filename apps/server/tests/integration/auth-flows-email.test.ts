// V-085: integration tests for the auth-flow → Postmark wiring.
//
// The default integration fixture uses a no-op email service (Postmark
// config null). These tests construct a parallel flow against a stub
// Postmark client to verify the actual send path fires for each
// auth-flow trigger (signup verification email, magic-link request,
// password-reset request).

import { describe, expect, it } from 'vitest';
import { createTestLogger } from '../../src/lib/logger.js';
import { AuthFlowsService, type AuthFlowsRepo } from '../../src/services/auth-flows.js';
import { createEmailService, type PostmarkSendApi } from '../../src/services/email.js';
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
    verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
    magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
    passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
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
    expect(calls[0]?.text).toContain('https://app.driftstack.local/auth/verify-email?token=');
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
    expect(calls[0]?.text).toContain('https://app.driftstack.local/auth/password-reset?token=');
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
