// Integration tests for the V-079 auth-flow surface (/v1/auth/*).
//
// Uses Fastify's `inject` against the in-memory fixture; no real
// Postgres / Redis / Postmark touched. The fixture exposes the
// auth-flows debug-token path so the consume endpoints can be
// exercised without scraping email.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { createTestLogger } from '../../src/lib/logger.js';
import { createEmailService } from '../../src/services/email.js';
import { AuthFlowError, AuthFlowsService } from '../../src/services/auth-flows.js';
import {
  InMemoryMfaChallengeStore,
  MAX_MFA_CHALLENGE_ATTEMPTS,
  redisKey as mfaChallengeKey,
} from '../../src/services/mfa-challenge-store.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';

function makeDirectService(repo = new InMemoryAuthFlowsRepo()): {
  repo: InMemoryAuthFlowsRepo;
  service: AuthFlowsService;
} {
  const logger = createTestLogger();
  const email = createEmailService({ config: null, logger });
  const service = new AuthFlowsService(repo, email, logger, {
    verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
    magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
    passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
    exposeDebugToken: true,
  });
  return { repo, service };
}

function makeMfaDirectService(): {
  repo: InMemoryAuthFlowsRepo;
  service: AuthFlowsService;
  challenges: InMemoryMfaChallengeStore;
  getStatus: ReturnType<typeof vi.fn>;
} {
  const repo = new InMemoryAuthFlowsRepo();
  const logger = createTestLogger();
  const email = createEmailService({ config: null, logger });
  const challenges = new InMemoryMfaChallengeStore();
  const getStatus = vi.fn().mockResolvedValue({
    enrolled: true,
    enrolledAt: new Date(),
    lastUsedAt: null,
    unusedRecoveryCodes: 10,
  });
  const service = new AuthFlowsService(
    repo,
    email,
    logger,
    {
      verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
      magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
      passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
      exposeDebugToken: true,
    },
    null,
    null,
    { getStatus } as never,
    challenges,
  );
  return { repo, service, challenges, getStatus };
}

interface SignupResponse {
  verification_email_expires_at: string;
  debug_token?: string;
}

interface SessionEnvelope {
  session: {
    token: string;
    expires_at: string;
    account_id: string;
  };
}

describe('POST /v1/auth/signup', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 issues a verification token and returns the expiry', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'newuser@driftstack.local',
        password: 'correct horse battery staple',
        name: 'New User',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<SignupResponse>();
    expect(body.verification_email_expires_at).toBeDefined();
    expect(body.debug_token).toBeDefined();
    expect(body.debug_token!.length).toBeGreaterThanOrEqual(32);
  });

  it('409 EmailAlreadyRegistered when the email already has an account', async () => {
    fx = await buildTestApp();
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'dup@driftstack.local', password: 'correct horse battery staple' },
    });
    expect(first.statusCode).toBe(200);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'dup@driftstack.local', password: 'correct horse battery staple' },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json<{ type: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.EmailAlreadyRegistered);
  });

  it('400 ValidationFailed for short passwords', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'ok@driftstack.local', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ type: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  // Security fix 2026-06-30 — bundled_llm_consent / bundled_llm_monthly_cap_usd_cents
  // used to be settable directly on this unauthenticated body, letting a
  // fresh no-card free-tier account self-declare up to the $10,000/month
  // company-funded bundled-LLM spend cap. Both fields are now absent from
  // SignupRequestSchema entirely (see api-types-auth-content-parity.test.ts
  // + signup-flow-cross-source-invariant.test.ts for the schema-shape pins);
  // this test proves the end-to-end behavioural consequence: even when an
  // attacker still sends the fields, they never reach the account-creation
  // call, so the new account always gets the safe column defaults.
  it('200 succeeds but IGNORES bundled_llm_consent / bundled_llm_monthly_cap_usd_cents in the body — the fields never reach createAccount', async () => {
    fx = await buildTestApp();
    const createAccountSpy = vi.spyOn(fx.authFlowsRepo, 'createAccount');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'attacker@driftstack.local',
        password: 'correct horse battery staple',
        bundled_llm_consent: true,
        bundled_llm_monthly_cap_usd_cents: 1_000_000,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(createAccountSpy).toHaveBeenCalledTimes(1);
    const callArgs = createAccountSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs).not.toHaveProperty('bundledLlmConsent');
    expect(callArgs).not.toHaveProperty('bundledLlmMonthlyCapUsdCents');
  });
});

describe('AuthFlowsService.signup — email dedup canonicalization (security fix 2026-06-30)', () => {
  // A Gmail signup using a `+tag` suffix or dot-variant of an
  // address that's ALREADY registered lands in the exact same real inbox
  // as the existing account — without this canonicalization, one mailbox
  // could mint unlimited "distinct" verified free-tier accounts.

  it('rejects a Gmail +tag variant of an already-registered address (attacker@gmail.com exists → attacker+1@gmail.com blocked)', async () => {
    const { service } = makeDirectService();
    await service.signup({
      email: 'attacker@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const err = await service
      .signup({
        email: 'attacker+1@gmail.com',
        password: 'correct horse battery staple',
        requestedFromIp: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).code).toBe('email_already_registered');
  });

  it('rejects a Gmail dot-variant of an already-registered address (attacker@gmail.com exists → a.ttacker@gmail.com blocked)', async () => {
    const { service } = makeDirectService();
    await service.signup({
      email: 'attacker@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const err = await service
      .signup({
        email: 'a.ttacker@gmail.com',
        password: 'correct horse battery staple',
        requestedFromIp: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).code).toBe('email_already_registered');
  });

  it('does NOT dot-strip for a non-Gmail domain — a dotted Outlook address and its dot-stripped form register as DISTINCT accounts (Gmail-only quirk must not generalize)', async () => {
    const { service, repo } = makeDirectService();
    await service.signup({
      email: 'attacker.name@outlook.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    // Would collide under Gmail-style dot-stripping — must succeed here.
    const second = await service.signup({
      email: 'attackername@outlook.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    expect(second.account.email).toBe('attackername@outlook.com');
    expect(await repo.findAccountByEmail('attacker.name@outlook.com')).not.toBeNull();
    expect(await repo.findAccountByEmail('attackername@outlook.com')).not.toBeNull();
  });

  it('does NOT strip +tag for a non-Gmail domain — RFC 5233 subaddressing is provider-controlled and the two literal mailboxes remain distinct', async () => {
    const { service, repo } = makeDirectService();
    await service.signup({
      email: 'attacker@outlook.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const second = await service.signup({
      email: 'attacker+promo@outlook.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    expect(second.account.email).toBe('attacker+promo@outlook.com');
    expect(await repo.findAccountByEmail('attacker@outlook.com')).not.toBeNull();
    expect(await repo.findAccountByEmail('attacker+promo@outlook.com')).not.toBeNull();
  });

  // ── REVERSE-ordering regression tests (2026-07-01 fix) ──────────────
  //
  // The original 2026-06-30 fix only re-canonicalized the INCOMING signup
  // email and looked it up against the literal accounts.email column, via
  // `if (canonicalEmail !== email) findAccountByEmail(canonicalEmail)`.
  // That ONLY catches the ordering where the bare/canonical address was
  // registered FIRST and a variant signs up second — because the second
  // lookup searches for the LITERAL canonical string in the email column,
  // which is only present if that exact string was what got stored.
  //
  // The realistic abuse ordering is the opposite: a variant registers
  // FIRST (e.g. attacker+1@gmail.com — note this is already its OWN
  // canonical form once its +tag is stripped, i.e. canonicalizing it
  // yields 'attacker@gmail.com', a string that was NEVER stored), then a
  // second variant or the bare address signs up — sailing through
  // completely untouched under the old logic. These tests pin that this
  // ordering is now ALSO rejected (via accounts.canonical_email +
  // findAccountByCanonicalEmail, migration 0096).

  it('REVERSE ORDER — rejects the bare address when a Gmail +tag variant was registered FIRST (attacker+1@gmail.com exists → attacker@gmail.com blocked)', async () => {
    const { service } = makeDirectService();
    await service.signup({
      email: 'attacker+1@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const err = await service
      .signup({
        email: 'attacker@gmail.com',
        password: 'correct horse battery staple',
        requestedFromIp: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).code).toBe('email_already_registered');
  });

  it('REVERSE ORDER — rejects a SECOND, DIFFERENT +tag variant when a first +tag variant was registered FIRST and neither is the bare canonical form (attacker+1@gmail.com exists → attacker+2@gmail.com blocked) — the realistic abuse ordering', async () => {
    const { service } = makeDirectService();
    await service.signup({
      email: 'attacker+1@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const err = await service
      .signup({
        email: 'attacker+2@gmail.com',
        password: 'correct horse battery staple',
        requestedFromIp: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).code).toBe('email_already_registered');
  });

  it('REVERSE ORDER — rejects the bare address when a Gmail dot-variant was registered FIRST (a.ttacker@gmail.com exists → attacker@gmail.com blocked)', async () => {
    const { service } = makeDirectService();
    await service.signup({
      email: 'a.ttacker@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const err = await service
      .signup({
        email: 'attacker@gmail.com',
        password: 'correct horse battery staple',
        requestedFromIp: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).code).toBe('email_already_registered');
  });

  it('REVERSE ORDER — rejects a Gmail dot-variant when a DIFFERENT dot-variant was registered FIRST, neither is the bare form (a.ttacker@gmail.com exists → att.acker@gmail.com blocked)', async () => {
    const { service } = makeDirectService();
    await service.signup({
      email: 'a.ttacker@gmail.com',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });

    const err = await service
      .signup({
        email: 'att.acker@gmail.com',
        password: 'correct horse battery staple',
        requestedFromIp: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFlowError);
    expect((err as AuthFlowError).code).toBe('email_already_registered');
  });
});

describe('POST /v1/auth/verify-email', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 consumes the signup-verify token and returns a web session', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'verifier@driftstack.local', password: 'correct horse battery staple' },
    });
    const token = signup.json<SignupResponse>().debug_token!;

    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json<SessionEnvelope>();
    expect(body.session.token).toBeDefined();
    expect(body.session.account_id).toMatch(/^acc_[0-9a-f-]{36}$/);
    expect(new Date(body.session.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('400 InvalidAuthToken on a bogus token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: 'a'.repeat(43) },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ type: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.InvalidAuthToken);
  });

  it('400 InvalidAuthToken when the same token is used twice', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'twice@driftstack.local', password: 'correct horse battery staple' },
    });
    const token = signup.json<SignupResponse>().debug_token!;

    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(first.statusCode).toBe(200);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(second.statusCode).toBe(400);
    expect(second.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidAuthToken);
  });

  it('two different outstanding verification links racing mint exactly one session', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'verify-family@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const firstToken = signup.json<SignupResponse>().debug_token!;
    const resend = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'verify-family@driftstack.local' },
    });
    const secondToken = resend.json<{ debug_token: string }>().debug_token;

    const results = await Promise.all(
      [firstToken, secondToken].map((token) =>
        fx.app.inject({
          method: 'POST',
          url: '/v1/auth/verify-email',
          payload: { token },
        }),
      ),
    );

    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    const loser = results.find((response) => response.statusCode !== 200);
    expect(loser?.statusCode).toBe(400);
    expect(loser?.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidAuthToken);
  });

  it('a suspended account cannot mint a session through an outstanding verification link', async () => {
    const { service, repo } = makeDirectService();
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const signup = await service.signup({
      email: 'suspended-verify@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, status: 'suspended' });

    await expect(
      service.verifyEmail({
        token: signup.debugToken as string,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(insertSession).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/login', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  async function signupAndVerify(
    fixture: TestAppFixture,
    email: string,
    password: string,
  ): Promise<void> {
    const signup = await fixture.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password },
    });
    const token = signup.json<SignupResponse>().debug_token!;
    await fixture.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
  }

  it('200 returns a fresh web session on correct password', async () => {
    fx = await buildTestApp();
    await signupAndVerify(fx, 'login@driftstack.local', 'correct horse battery staple');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'login@driftstack.local', password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<SessionEnvelope>();
    expect(body.session.token).toBeDefined();
    expect(body.session.account_id).toMatch(/^acc_/);
  });

  it('401 InvalidCredentials on wrong password', async () => {
    fx = await buildTestApp();
    await signupAndVerify(fx, 'wrongpass@driftstack.local', 'correct horse battery staple');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'wrongpass@driftstack.local', password: 'totally wrong password!!!' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidCredentials);
  });

  it('401 InvalidCredentials on unknown email', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nonexistent@driftstack.local', password: 'correct horse battery staple' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidCredentials);
  });

  it('403 EmailNotVerified when password is correct but email unverified', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'unverified@driftstack.local', password: 'correct horse battery staple' },
    });
    // Note: skip verify step.

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'unverified@driftstack.local', password: 'correct horse battery staple' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.EmailNotVerified);
  });

  // Audit fix 2026-07-01: signup dedup already treats a Gmail dot-variant as
  // the SAME account (canonicalizeEmailForDedup) — login must recognize that
  // too, or a customer who signs up with one variant and later types an
  // equivalent-but-different one (same Gmail inbox) gets locked out with
  // "invalid credentials" even though they have the right password.
  it('200 logs in with a Gmail dot-variant of the address used at signup (same inbox, different literal string)', async () => {
    fx = await buildTestApp();
    await signupAndVerify(fx, 'log.in@gmail.com', 'correct horse battery staple');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'login@gmail.com', password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<SessionEnvelope>();
    expect(body.session.token).toBeDefined();
  });

  it('401 InvalidCredentials on the Gmail dot-variant path with the WRONG password (canonical fallback still requires the real password)', async () => {
    fx = await buildTestApp();
    await signupAndVerify(fx, 'log.in.two@gmail.com', 'correct horse battery staple');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'logintwo@gmail.com', password: 'totally wrong password!!!' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidCredentials);
  });
});

// #187 — self-service resend of the signup-verification email.
describe('POST /v1/auth/resend-verification', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns shape-stable response for unknown email (no enumeration)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'ghost@driftstack.local' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sent: boolean; expires_at: string; debug_token?: string }>();
    expect(body.sent).toBe(true);
    expect(body.expires_at).toBeDefined();
    expect(body.debug_token).toBeUndefined();
  });

  it('200 returns shape-stable response for already-verified email (no enumeration)', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'verified@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const verifyToken = signup.json<{ debug_token: string }>().debug_token;
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'verified@driftstack.local' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sent: boolean; debug_token?: string }>();
    expect(body.sent).toBe(true);
    // Already verified: no token should be returned even in debug mode.
    expect(body.debug_token).toBeUndefined();
  });

  it('200 for unverified email mints a fresh, usable verify token', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'resend@driftstack.local',
        password: 'correct horse battery staple',
      },
    });

    const req = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'resend@driftstack.local' },
    });
    const freshToken = req.json<{ debug_token: string }>().debug_token;
    expect(freshToken).toBeDefined();

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: freshToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionEnvelope>();
    expect(body.session.token).toBeDefined();
  });

  // Audit fix 2026-07-01: same canonical-fallback closing the Gmail
  // dot-variant lockout gap as login (see that describe block).
  it('mints a usable verify token when requested with a Gmail dot-variant of the signup address', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 're.send@gmail.com', password: 'correct horse battery staple' },
    });

    const req = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      payload: { email: 'resend@gmail.com' },
    });
    const freshToken = req.json<{ debug_token: string }>().debug_token;
    expect(freshToken).toBeDefined();

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: freshToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionEnvelope>().session.token).toBeDefined();
  });
});

describe('POST /v1/auth/magic-link', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 request returns shape-stable response even for unknown email', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      payload: { email: 'ghost@driftstack.local' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sent: boolean; expires_at: string; debug_token?: string }>();
    expect(body.sent).toBe(true);
    expect(body.expires_at).toBeDefined();
    // Unknown email: no token should be returned even in debug mode.
    expect(body.debug_token).toBeUndefined();
  });

  it('200 consume after request issues a session', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'magic@driftstack.local', password: 'correct horse battery staple' },
    });

    const req = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      payload: { email: 'magic@driftstack.local' },
    });
    const token = req.json<{ debug_token: string }>().debug_token;
    expect(token).toBeDefined();

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionEnvelope>();
    expect(body.session.token).toBeDefined();
  });

  it('successful consume invalidates every older outstanding magic link', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'magic-siblings@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const firstRequest = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      payload: { email: 'magic-siblings@driftstack.local' },
    });
    const secondRequest = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      payload: { email: 'magic-siblings@driftstack.local' },
    });
    const firstToken = firstRequest.json<{ debug_token: string }>().debug_token;
    const secondToken = secondRequest.json<{ debug_token: string }>().debug_token;

    const winner = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token: secondToken },
    });
    expect(winner.statusCode).toBe(200);

    const stale = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token: firstToken },
    });
    expect(stale.statusCode).not.toBe(200);
  });

  it('two different magic links racing can mint only one session', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'magic-race@driftstack.local', password: 'correct horse battery staple' },
    });
    const requests = await Promise.all(
      [0, 1].map(() =>
        fx.app.inject({
          method: 'POST',
          url: '/v1/auth/magic-link/request',
          payload: { email: 'magic-race@driftstack.local' },
        }),
      ),
    );
    const tokens = requests.map((response) => response.json<{ debug_token: string }>().debug_token);
    const consumes = await Promise.all(
      tokens.map((token) =>
        fx.app.inject({
          method: 'POST',
          url: '/v1/auth/magic-link/consume',
          payload: { token },
        }),
      ),
    );
    expect(consumes.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(consumes.filter((response) => response.statusCode !== 200)).toHaveLength(1);
  });

  // Audit fix 2026-07-01: same canonical-fallback closing the Gmail
  // dot-variant lockout gap as login (see that describe block).
  it('issues a consumable magic link when requested with a Gmail dot-variant of the signup address', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'ma.gic@gmail.com', password: 'correct horse battery staple' },
    });

    const req = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      payload: { email: 'magic@gmail.com' },
    });
    const token = req.json<{ debug_token: string }>().debug_token;
    expect(token).toBeDefined();

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionEnvelope>().session.token).toBeDefined();
  });
});

describe('AuthFlowsService recovery authentication — enrolled MFA', () => {
  it('fails closed instead of bypassing enrolled MFA when the challenge store is unavailable', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const logger = createTestLogger();
    const email = createEmailService({ config: null, logger });
    const service = new AuthFlowsService(
      repo,
      email,
      logger,
      {
        verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
        exposeDebugToken: true,
      },
      null,
      null,
      {
        getStatus: () => Promise.resolve({ enrolled: true }),
      } as never,
      null,
    );
    const signup = await service.signup({
      email: 'mfa-store-down@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, emailVerifiedAt: new Date() });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    await expect(
      service.login({
        email: signup.account.email,
        password: 'correct horse battery staple',
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('turns a consumed magic link into an IP-bound MFA challenge without minting a session', async () => {
    const { repo, service, challenges, getStatus } = makeMfaDirectService();
    const signup = await service.signup({
      email: 'mfa-magic@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const request = await service.requestMagicLink({
      email: signup.account.email,
      requestedFromIp: '203.0.113.4',
    });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    const result = await service.consumeMagicLink({
      token: request.debugToken as string,
      issuedFromIp: '203.0.113.4',
      userAgent: 'recovery-browser',
    });

    expect(result.kind).toBe('mfa_required');
    if (result.kind !== 'mfa_required') throw new Error('expected MFA challenge');
    expect(
      JSON.parse(String(await challenges.peek(mfaChallengeKey(result.challengeToken)))),
    ).toMatchObject({
      account_id: signup.account.id,
      source_ip: '203.0.113.4',
      issued_user_agent: 'recovery-browser',
    });
    expect(result.challengeExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(getStatus).toHaveBeenCalledWith(signup.account.id);
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('changes the password, revokes every old session, and returns MFA without minting a replacement', async () => {
    const { repo, service, challenges, getStatus } = makeMfaDirectService();
    const signup = await service.signup({
      email: 'mfa-reset@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const expiresAt = new Date(Date.now() + 60_000);
    await repo.insertWebSession({
      accountId: signup.account.id,
      tokenHash: 'old-session-one',
      expiresAt,
      issuedFromIp: null,
      userAgent: 'old-browser-one',
    });
    await repo.insertWebSession({
      accountId: signup.account.id,
      tokenHash: 'old-session-two',
      expiresAt,
      issuedFromIp: null,
      userAgent: 'old-browser-two',
    });
    const reset = await service.requestPasswordReset({
      email: signup.account.email,
      requestedFromIp: '203.0.113.5',
    });
    const setPassword = vi.spyOn(repo, 'setPassword');
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const revokeAll = vi.spyOn(repo, 'revokeAllWebSessionsForAccount');

    const result = await service.confirmPasswordReset({
      token: reset.debugToken as string,
      newPassword: 'the new password still needs MFA!!',
      issuedFromIp: '203.0.113.5',
      userAgent: 'reset-browser',
    });

    expect(result.kind).toBe('mfa_required');
    if (result.kind !== 'mfa_required') throw new Error('expected MFA challenge');
    expect(
      JSON.parse(String(await challenges.peek(mfaChallengeKey(result.challengeToken)))),
    ).toMatchObject({
      account_id: signup.account.id,
      source_ip: '203.0.113.5',
      issued_user_agent: 'reset-browser',
    });
    expect(getStatus).toHaveBeenCalledWith(signup.account.id);
    expect(setPassword).toHaveBeenCalledTimes(1);
    expect(revokeAll).toHaveBeenCalledWith(signup.account.id, expect.any(Date));
    expect(await repo.listActiveWebSessionsForAccount(signup.account.id, new Date())).toEqual([]);
    expect(insertSession).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/password-reset', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 request returns shape-stable response even for unknown email', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'unknown@driftstack.local' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sent: boolean; debug_token?: string }>();
    expect(body.sent).toBe(true);
    expect(body.debug_token).toBeUndefined();
  });

  it('200 confirm rotates the password and issues a session', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'reset@driftstack.local', password: 'correct horse battery staple' },
    });

    const req = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'reset@driftstack.local' },
    });
    const token = req.json<{ debug_token: string }>().debug_token;

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, new_password: 'totally different password!!' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionEnvelope>();
    expect(body.session.token).toBeDefined();

    // Old password no longer works.
    // (Verify-email step skipped — confirmPasswordReset issues a session
    // even without prior verification, since clicking the email already
    // demonstrates ownership. Login still requires a verified email
    // though, so this round-trip uses the issued session token instead.)
  });

  it('successful confirm invalidates every older outstanding reset link', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'reset-siblings@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const firstRequest = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'reset-siblings@driftstack.local' },
    });
    const secondRequest = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'reset-siblings@driftstack.local' },
    });
    const firstToken = firstRequest.json<{ debug_token: string }>().debug_token;
    const secondToken = secondRequest.json<{ debug_token: string }>().debug_token;

    const winner = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token: secondToken, new_password: 'the winning replacement password!!' },
    });
    expect(winner.statusCode).toBe(200);

    const stale = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token: firstToken, new_password: 'stale reset must never land!!' },
    });
    expect(stale.statusCode).not.toBe(200);
  });

  it('two different reset links racing can change the password only once', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'reset-race@driftstack.local', password: 'correct horse battery staple' },
    });
    const requests = await Promise.all(
      [0, 1].map(() =>
        fx.app.inject({
          method: 'POST',
          url: '/v1/auth/password-reset/request',
          payload: { email: 'reset-race@driftstack.local' },
        }),
      ),
    );
    const tokens = requests.map((response) => response.json<{ debug_token: string }>().debug_token);

    const confirms = await Promise.all(
      tokens.map((token, index) =>
        fx.app.inject({
          method: 'POST',
          url: '/v1/auth/password-reset/confirm',
          payload: { token, new_password: `concurrent replacement password ${index}!!` },
        }),
      ),
    );
    expect(confirms.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(confirms.filter((response) => response.statusCode !== 200)).toHaveLength(1);
  });

  // Audit fix 2026-07-01: same canonical-fallback closing the Gmail
  // dot-variant lockout gap as login (see that describe block).
  it('issues a usable reset token when requested with a Gmail dot-variant of the signup address', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 're.set@gmail.com', password: 'correct horse battery staple' },
    });

    const req = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'reset@gmail.com' },
    });
    const token = req.json<{ debug_token: string }>().debug_token;
    expect(token).toBeDefined();

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, new_password: 'totally different password!!' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionEnvelope>().session.token).toBeDefined();
  });

  it('confirm REVOKES every other web session (compromise-recovery) and keeps the just-issued one', async () => {
    fx = await buildTestApp();
    // A verified account with TWO live web sessions (the "attacker-held" + the user's).
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'reset-revoke@driftstack.local', password: 'correct horse battery staple' },
    });
    const verifyToken = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    const sessionA = verify.json<SessionEnvelope>().session.token;
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'reset-revoke@driftstack.local', password: 'correct horse battery staple' },
    });
    const sessionB = login.json<SessionEnvelope>().session.token;

    // Reset the password.
    const reqReset = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'reset-revoke@driftstack.local' },
    });
    const resetToken = reqReset.json<{ debug_token: string }>().debug_token;
    const confirm = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token: resetToken, new_password: 'an entirely different passphrase!!' },
    });
    expect(confirm.statusCode).toBe(200);
    const sessionC = confirm.json<SessionEnvelope>().session.token;

    // Both PRE-reset sessions are now revoked (probe via /refresh, which only
    // succeeds for a live session). Before the fix these stayed valid →
    // a stolen session survived the victim's reset.
    for (const stale of [sessionA, sessionB]) {
      const probe = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { token: stale },
      });
      expect(probe.statusCode, 'pre-reset session must be revoked').not.toBe(200);
    }
    // ...while the session issued BY the reset stays valid.
    const fresh = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { token: sessionC },
    });
    expect(fresh.statusCode).toBe(200);
  });

  it('a suspended account cannot use an outstanding reset link to change its password or mint a session', async () => {
    const { service, repo } = makeDirectService();
    const signup = await service.signup({
      email: 'suspended-reset@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const reset = await service.requestPasswordReset({
      email: signup.account.email,
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, status: 'suspended' });
    const setPassword = vi.spyOn(repo, 'setPassword');
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    await expect(
      service.confirmPasswordReset({
        token: reset.debugToken as string,
        newPassword: 'a replacement that must never land!!',
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(setPassword).not.toHaveBeenCalled();
    expect(insertSession).not.toHaveBeenCalled();
  });
});

describe('POST /v1/auth/refresh + /v1/auth/logout', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('refresh rotates the session token; old token becomes invalid', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'rotator@driftstack.local', password: 'correct horse battery staple' },
    });
    const verifyToken = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    const oldSession = verify.json<SessionEnvelope>().session.token;

    const refresh = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { token: oldSession },
    });
    expect(refresh.statusCode).toBe(200);
    const newSession = refresh.json<SessionEnvelope>().session.token;
    expect(newSession).not.toBe(oldSession);

    // Old token is now revoked.
    const reused = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { token: oldSession },
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidAuthToken);
  });

  it('logout revokes the session — refresh on the same token then 400s', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'logger-out@driftstack.local', password: 'correct horse battery staple' },
    });
    const verifyToken = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    const sessionToken = verify.json<SessionEnvelope>().session.token;

    const logout = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { token: sessionToken },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json<{ ok: boolean }>().ok).toBe(true);

    const refreshAfter = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { token: sessionToken },
    });
    expect(refreshAfter.statusCode).toBe(400);
    expect(refreshAfter.json<{ type: string }>().type).toBe(PROBLEM_TYPES.InvalidAuthToken);
  });

  it('logout on already-revoked token still 200 (idempotent)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { token: 'a'.repeat(43) },
    });
    expect(res.statusCode).toBe(200);
  });
});

// Security fix (2026-06-30 audit, MEDIUM): refreshSession previously did
// find-active-session (SELECT) → revoke (UPDATE) → mint (INSERT) with no
// atomic claim between the read and the mint — unlike every OTHER
// single-use-token flow in this file (verifyEmail / consumeMagicLink /
// confirmPasswordReset), which reject a concurrent race-loser via
// `consumeAuthToken`'s atomic UPDATE...RETURNING boolean.
// The service-local keyed lock prevents that within one instance. The repo's
// conditional revoke also returns an atomic winner signal so separate API
// processes cannot both mint. These tests construct AuthFlowsService directly
// (same pattern as the magic-link race-regression test in
// auth-flows-email.test.ts) so both boundaries are deterministic.
describe('AuthFlowsService.refreshSession — single-use under concurrency (security fix)', () => {
  it('consumes but does not replace a suspended account refresh token', async () => {
    const { repo, service } = makeDirectService();
    const signup = await service.signup({
      email: 'suspended-refresh@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const verify = await service.verifyEmail({
      token: signup.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });
    repo.seedAccount({ ...verify.account, status: 'suspended' });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    await expect(
      service.refreshSession({
        token: verify.session.plaintext,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(insertSession).not.toHaveBeenCalled();
    expect(await repo.listActiveWebSessionsForAccount(verify.account.id, new Date())).toHaveLength(
      0,
    );
  });

  it('two simultaneous refreshes of the same token: exactly one succeeds, one InvalidAuthToken', async () => {
    const { repo, service } = makeDirectService();
    const signup = await service.signup({
      email: 'refresh-race@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const verify = await service.verifyEmail({
      token: signup.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });
    const oldToken = verify.session.plaintext;

    const results = await Promise.allSettled([
      service.refreshSession({ token: oldToken, issuedFromIp: null, userAgent: null }),
      service.refreshSession({ token: oldToken, issuedFromIp: null, userAgent: null }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AuthFlowError);
    expect(((rejected[0] as PromiseRejectedResult).reason as AuthFlowError).code).toBe(
      'invalid_auth_token',
    );

    // Exactly one active session for the account survives the race — not
    // two. Before the fix, both racers would mint a fresh row here.
    const active = await repo.listActiveWebSessionsForAccount(verify.account.id, new Date());
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(verify.session.row.id); // the NEW row; old one revoked
  });

  it('two service instances sharing one repository still mint exactly one replacement', async () => {
    const sharedRepo = new InMemoryAuthFlowsRepo();
    const serviceA = makeDirectService(sharedRepo).service;
    const serviceB = makeDirectService(sharedRepo).service;
    const signup = await serviceA.signup({
      email: 'refresh-cross-process@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const verify = await serviceA.verifyEmail({
      token: signup.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });

    const results = await Promise.allSettled([
      serviceA.refreshSession({
        token: verify.session.plaintext,
        issuedFromIp: null,
        userAgent: null,
      }),
      serviceB.refreshSession({
        token: verify.session.plaintext,
        issuedFromIp: null,
        userAgent: null,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'invalid_auth_token',
    });
    expect(
      await sharedRepo.listActiveWebSessionsForAccount(verify.account.id, new Date()),
    ).toHaveLength(1);
  });

  it('sequential refreshes still both succeed (the lock is per-call, not a permanent hold)', async () => {
    const { service } = makeDirectService();
    const signup = await service.signup({
      email: 'refresh-sequential@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const verify = await service.verifyEmail({
      token: signup.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });
    const first = await service.refreshSession({
      token: verify.session.plaintext,
      issuedFromIp: null,
      userAgent: null,
    });
    const second = await service.refreshSession({
      token: first.session.plaintext,
      issuedFromIp: null,
      userAgent: null,
    });
    expect(second.session.plaintext).not.toBe(first.session.plaintext);
    expect(second.session.plaintext).not.toBe(verify.session.plaintext);
  });

  it('refreshing two DIFFERENT accounts concurrently does not block on each other', async () => {
    const { service } = makeDirectService();
    const signupA = await service.signup({
      email: 'refresh-a@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const signupB = await service.signup({
      email: 'refresh-b@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const verifyA = await service.verifyEmail({
      token: signupA.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });
    const verifyB = await service.verifyEmail({
      token: signupB.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });
    const [resultA, resultB] = await Promise.all([
      service.refreshSession({
        token: verifyA.session.plaintext,
        issuedFromIp: null,
        userAgent: null,
      }),
      service.refreshSession({
        token: verifyB.session.plaintext,
        issuedFromIp: null,
        userAgent: null,
      }),
    ]);
    expect(resultA.account.id).toBe(verifyA.account.id);
    expect(resultB.account.id).toBe(verifyB.account.id);
  });
});

describe('AuthFlowsService.issueOAuthWebSession — active-account containment', () => {
  it('returns the opaque null result and inserts nothing for a suspended account', async () => {
    const { repo, service } = makeDirectService();
    const signup = await service.signup({
      email: 'suspended-oauth@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, status: 'suspended' });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    await expect(
      service.issueOAuthWebSession({
        accountId: signup.account.id,
        issuedFromIp: null,
        userAgent: null,
        provider: 'google',
      }),
    ).resolves.toBeNull();
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('does not let a linked IDP bypass enrolled Driftstack MFA', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const logger = createTestLogger();
    const email = createEmailService({ config: null, logger });
    const getStatus = vi.fn().mockResolvedValue({
      enrolled: true,
      enrolledAt: new Date(),
      lastUsedAt: null,
      unusedRecoveryCodes: 10,
    });
    const mfa = { getStatus };
    const mfaChallenges = new InMemoryMfaChallengeStore();
    const service = new AuthFlowsService(
      repo,
      email,
      logger,
      {
        verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
        exposeDebugToken: true,
      },
      null,
      null,
      mfa as never,
      mfaChallenges,
    );
    const signup = await service.signup({
      email: 'mfa-oauth@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    const result = await service.issueOAuthWebSession({
      accountId: signup.account.id,
      issuedFromIp: '203.0.113.7',
      userAgent: 'oauth-browser',
      provider: 'github',
    });
    expect(result?.kind).toBe('mfa_required');
    if (result?.kind !== 'mfa_required') throw new Error('expected OAuth MFA challenge');
    const stored = await mfaChallenges.peek(mfaChallengeKey(result.challengeToken));
    expect(JSON.parse(String(stored))).toMatchObject({
      account_id: signup.account.id,
      source_ip: '203.0.113.7',
      issued_user_agent: 'oauth-browser',
    });
    expect(result.challengeExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(getStatus).toHaveBeenCalledWith(signup.account.id);
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('still returns a normal session result for an active account without MFA', async () => {
    const { repo, service } = makeDirectService();
    const signup = await service.signup({
      email: 'plain-oauth@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    const result = await service.issueOAuthWebSession({
      accountId: signup.account.id,
      issuedFromIp: null,
      userAgent: 'oauth-browser',
      provider: 'google',
    });
    expect(result?.kind).toBe('session');
    expect(insertSession).toHaveBeenCalledTimes(1);
  });
});

// Security fix (2026-06-30 audit, LOW): stepUpReauth (the already-
// authenticated MFA re-confirm gate, distinct from the login-path
// completeMfaChallenge above) had no per-account brute-force lockout,
// unlike its login-path sibling which bounds wrong-code guesses via
// `MAX_MFA_CHALLENGE_ATTEMPTS`. Its only throttle was the route's
// per-IP `loginGate`, bypassable by spreading guesses across source
// IPs. These tests construct AuthFlowsService directly with a
// controllable fake MfaService (the `verifyCode` surface is the only
// method stepUpReauth calls) so the attempt-counter logic can be
// exercised deterministically without real TOTP enrollment.
describe('AuthFlowsService.stepUpReauth — per-account attempt lockout (security fix)', () => {
  function makeStepUpService(verifyCodeResult: () => Promise<'totp' | 'recovery' | null>): {
    service: AuthFlowsService;
    callCount: () => number;
  } {
    const repo = new InMemoryAuthFlowsRepo();
    const logger = createTestLogger();
    const email = createEmailService({ config: null, logger });
    const mfaChallenges = new InMemoryMfaChallengeStore();
    let calls = 0;
    const fakeMfa = {
      verifyCode: () => {
        calls += 1;
        return verifyCodeResult();
      },
    } as never;
    const service = new AuthFlowsService(
      repo,
      email,
      logger,
      {
        verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
        exposeDebugToken: true,
      },
      null,
      null,
      fakeMfa,
      mfaChallenges,
    );
    return { service, callCount: () => calls };
  }

  it('locks out after MAX_MFA_CHALLENGE_ATTEMPTS wrong codes, refusing even a subsequently-correct code', async () => {
    let nextResult: 'totp' | 'recovery' | null = null;
    const { service, callCount } = makeStepUpService(() => Promise.resolve(nextResult));
    const accountId = 'acc_stepup_lockout';

    for (let i = 0; i < MAX_MFA_CHALLENGE_ATTEMPTS; i++) {
      await expect(
        service.stepUpReauth({ accountId, sessionId: 'sess_1', input: '000000' }),
      ).rejects.toThrow(/Code is invalid/);
    }
    expect(callCount()).toBe(MAX_MFA_CHALLENGE_ATTEMPTS);

    // The (MAX+1)th attempt is refused even though the code is now
    // "correct" — proving this is a real lockout (blocks the account),
    // not just a per-attempt rejection. verifyCode is never invoked for
    // this call (callCount doesn't increase).
    nextResult = 'totp';
    await expect(
      service.stepUpReauth({ accountId, sessionId: 'sess_1', input: '999999' }),
    ).rejects.toThrow(/Too many/);
    expect(callCount()).toBe(MAX_MFA_CHALLENGE_ATTEMPTS);
  });

  it('a correct code on the FIRST attempt succeeds (no false-positive lockout)', async () => {
    const { service, callCount } = makeStepUpService(() => Promise.resolve('totp'));
    const result = await service.stepUpReauth({
      accountId: 'acc_stepup_ok',
      sessionId: 'sess_1',
      input: '123456',
    });
    expect(result.via).toBe('totp');
    expect(callCount()).toBe(1);
  });

  it('does not count repeated successful proofs toward the failed-attempt cap', async () => {
    const { service, callCount } = makeStepUpService(() => Promise.resolve('totp'));
    for (let i = 0; i < MAX_MFA_CHALLENGE_ATTEMPTS + 2; i++) {
      await expect(
        service.stepUpReauth({
          accountId: 'acc_stepup_repeat_success',
          sessionId: 'sess_1',
          input: '123456',
        }),
      ).resolves.toMatchObject({ via: 'totp' });
    }
    expect(callCount()).toBe(MAX_MFA_CHALLENGE_ATTEMPTS + 2);
  });

  it('a valid proof after four failures releases its own slot but preserves the failures', async () => {
    let nextResult: 'totp' | 'recovery' | null = null;
    const { service, callCount } = makeStepUpService(() => Promise.resolve(nextResult));
    const args = { accountId: 'acc_stepup_mixed', sessionId: 'sess_1', input: '000000' };

    for (let i = 0; i < MAX_MFA_CHALLENGE_ATTEMPTS - 1; i++) {
      await expect(service.stepUpReauth(args)).rejects.toThrow(/Code is invalid/);
    }
    nextResult = 'totp';
    await expect(service.stepUpReauth(args)).resolves.toMatchObject({ via: 'totp' });
    nextResult = null;
    await expect(service.stepUpReauth(args)).rejects.toThrow(/Code is invalid/);
    await expect(service.stepUpReauth(args)).rejects.toThrow(/Too many/);
    expect(callCount()).toBe(MAX_MFA_CHALLENGE_ATTEMPTS + 1);
  });

  it('a different account is unaffected by another account being locked out', async () => {
    let nextResult: 'totp' | 'recovery' | null = null;
    const { service } = makeStepUpService(() => Promise.resolve(nextResult));

    for (let i = 0; i < MAX_MFA_CHALLENGE_ATTEMPTS; i++) {
      await expect(
        service.stepUpReauth({ accountId: 'acc_victim', sessionId: 'sess_1', input: '000000' }),
      ).rejects.toThrow(/Code is invalid/);
    }
    // acc_victim is now locked out.
    await expect(
      service.stepUpReauth({ accountId: 'acc_victim', sessionId: 'sess_1', input: '000000' }),
    ).rejects.toThrow(/Too many/);

    // A different account, same fake MFA service, succeeds normally.
    nextResult = 'recovery';
    const result = await service.stepUpReauth({
      accountId: 'acc_other',
      sessionId: 'sess_2',
      input: 'recovery-code',
    });
    expect(result.via).toBe('recovery');
  });
});

describe('V-224 — auth-flows emits customer-facing audit entries', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  interface AuditListResponse {
    data: Array<{
      action: string;
      actor_type: string;
      payload: Record<string, unknown> | null;
    }>;
    next_cursor: string | null;
  }

  async function listAudit(
    fixture: TestAppFixture,
    sessionToken: string,
  ): Promise<AuditListResponse> {
    const res = await fixture.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?limit=50',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<AuditListResponse>();
  }

  it('verify-email emits account.email_verified', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'audit-verify@driftstack.local', password: 'correct horse battery staple' },
    });
    const token = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    const sessionToken = verify.json<SessionEnvelope>().session.token;

    const log = await listAudit(fx, sessionToken);
    const verified = log.data.find((e) => e.action === 'account.email_verified');
    expect(verified).toBeDefined();
    expect(verified!.actor_type).toBe('customer');
  });

  it('login emits account.login', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'audit-login@driftstack.local', password: 'correct horse battery staple' },
    });
    const verifyToken = (
      await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        payload: {
          email: 'audit-login2@driftstack.local',
          password: 'correct horse battery staple',
        },
      })
    ).json<SignupResponse>().debug_token!;
    // Verify the second account so we can log in to it.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });

    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'audit-login2@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    expect(login.statusCode).toBe(200);
    const sessionToken = login.json<SessionEnvelope>().session.token;

    const log = await listAudit(fx, sessionToken);
    const loginEntry = log.data.find((e) => e.action === 'account.login');
    expect(loginEntry).toBeDefined();
    expect((loginEntry!.payload as { method?: string } | null)?.method).toBe('password');
  });

  it('password-reset/confirm emits account.password_changed', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'audit-reset@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const reqRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      payload: { email: 'audit-reset@driftstack.local' },
    });
    const resetToken = reqRes.json<{ debug_token: string }>().debug_token;
    const confirm = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token: resetToken, new_password: 'totally different password!!' },
    });
    const sessionToken = confirm.json<SessionEnvelope>().session.token;

    const log = await listAudit(fx, sessionToken);
    const changed = log.data.find((e) => e.action === 'account.password_changed');
    expect(changed).toBeDefined();
    expect((changed!.payload as { via?: string } | null)?.via).toBe('password_reset');
  });

  it('logout emits account.logout (visible on a fresh session)', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'audit-logout@driftstack.local', password: 'correct horse battery staple' },
    });
    const verifyToken = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    const firstSession = verify.json<SessionEnvelope>().session.token;

    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { token: firstSession },
    });

    // Log in again to get a fresh session token to read the audit log
    // (the previous one is now revoked).
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'audit-logout@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const newSession = login.json<SessionEnvelope>().session.token;

    const log = await listAudit(fx, newSession);
    const logoutEntry = log.data.find((e) => e.action === 'account.logout');
    expect(logoutEntry).toBeDefined();
  });
});
