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
import type { AuthCache } from '../../src/services/auth-cache.js';
import {
  AuthFlowError,
  AuthFlowsService,
  type VerifyEmailResult,
  type WebSessionRow,
} from '../../src/services/auth-flows.js';
import {
  InMemoryMfaChallengeStore,
  MAX_MFA_CHALLENGE_ATTEMPTS,
  generateChallengeToken,
  redisKey as mfaChallengeKey,
} from '../../src/services/mfa-challenge-store.js';
import { InMemoryAuthFlowsRepo } from './_helpers/in-memory-auth-flows-repo.js';

/** V-720 — verifyEmail returns `session | mfa_required`. The fixtures below use
 *  accounts with no enrolled second factor, so they narrow to the session
 *  branch; the challenge branch has its own dedicated test. Written as an
 *  assertion function so it narrows the existing const in place rather than
 *  forcing every call site to re-indent. */
function assertVerifiedSession(
  result: VerifyEmailResult,
): asserts result is Extract<VerifyEmailResult, { kind: 'session' }> {
  if (result.kind !== 'session') {
    throw new Error(`expected verify-email to mint a session, got ${result.kind}`);
  }
}

class PasswordResetBeforeSessionInsertRepo extends InMemoryAuthFlowsRepo {
  private resetBeforeNextInsert = false;

  armPasswordResetBeforeNextInsert(): void {
    this.resetBeforeNextInsert = true;
  }

  override async insertWebSession(args: {
    accountId: string;
    tokenHash: string;
    authEpoch: number;
    expiresAt: Date;
    issuedFromIp: string | null;
    userAgent: string | null;
  }): Promise<WebSessionRow | null> {
    if (this.resetBeforeNextInsert) {
      this.resetBeforeNextInsert = false;
      await this.setPassword(args.accountId, 'reset-won-password-hash');
      await this.revokeAllWebSessionsForAccount(args.accountId, new Date());
    }
    return super.insertWebSession(args);
  }
}

function makeDirectService(
  repo = new InMemoryAuthFlowsRepo(),
  authCache: AuthCache | null = null,
): {
  repo: InMemoryAuthFlowsRepo;
  service: AuthFlowsService;
} {
  const logger = createTestLogger();
  const email = createEmailService({ config: null, logger });
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
    authCache,
  );
  return { repo, service };
}

function makeMfaDirectService(): {
  repo: InMemoryAuthFlowsRepo;
  service: AuthFlowsService;
  challenges: InMemoryMfaChallengeStore;
  getStatus: ReturnType<typeof vi.fn>;
  verifyCode: ReturnType<typeof vi.fn>;
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
  const verifyCode = vi.fn().mockResolvedValue('totp');
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
    null,
    null,
    { getStatus, verifyCode } as never,
    challenges,
  );
  return { repo, service, challenges, getStatus, verifyCode };
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

  // ─── "a suspended account cannot mint a session", through its other doors ──
  //
  // The property is enforced at several sites in auth-flows.ts, one per way in,
  // plus a shared chokepoint in `issueWebSession` (:1560) whose own comment says
  // callers may keep their local checks for flow clarity but none can
  // accidentally mint a 30-day row for a suspended account.
  //
  // Cold sites at HEAD, from a v8 coverage run — the only instrument that could
  // tell. `account_suspended` appears in three test files, so a grep for the
  // CODE reports the property covered while individual doors stand open: one
  // covered site satisfies a whole-code grep.
  //
  // ⭐ Every arm asserts `insertWebSession` was NEVER CALLED, not merely that a
  // refusal was thrown. The property is "no session exists afterwards"; the
  // error code is only how it is reported. A build that minted the session and
  // then threw would satisfy an error-code assertion and still be the bug.
  //
  // LEDGER — control 75/75, and three of the six results are not what the arms
  // were written expecting:
  //
  //   login stops checking status (:915)              1 red  (this arm)
  //   login refuses only DELETED, admitting suspended 1 red  (this arm)
  //   magic link stops checking status (:1126)        SURVIVES
  //   reset's status check removed (:1211)            1 red  (a PRE-EXISTING arm)
  //   the null-write verdict ignored (:1215)          1 red  (this arm)
  //   the shared chokepoint removed (:1560)           1 red  (a PRE-EXISTING arm)
  //
  // ⚠️ The magic-link survivor is correct and is NOT a coverage gap. The arm does
  // execute :1126 — it is simply not the only thing standing between a suspended
  // account and a session, because :1560 catches it too. That redundancy is
  // deliberate and documented at the chokepoint.
  //
  // ⚠️ The reset result is the useful one. The first draft of that arm was a
  // strict duplicate of 'a suspended account cannot use an outstanding reset
  // link…' — same spies, same assertions — and reading the coverage list as
  // "the reset door is cold" is what produced it. The cold line was :1215, the
  // verdict AFTER the write, not :1211, the check before it. The mutation is
  // what exposed the overlap: it reddened a test I had not written.
  //
  // ⚠️ And the chokepoint mutation reds `consumes but does not replace a
  // suspended account refresh token` — a door with no local check of its own,
  // which is what makes :1560 load-bearing rather than belt-and-braces.

  it('a suspended account cannot mint a session by logging in with the CORRECT password', async () => {
    const { service, repo } = makeDirectService();
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const password = 'correct horse battery staple';
    const signup = await service.signup({
      email: 'suspended-login@driftstack.local',
      password,
      requestedFromIp: null,
    });
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    insertSession.mockClear();
    repo.seedAccount({ ...signup.account, status: 'suspended' });

    // The correct password on purpose. A wrong one is refused earlier as
    // `invalid_credentials` and would prove nothing about the status check —
    // the source says so directly: state checks come AFTER authentication so a
    // suspended account is indistinguishable to an unauthenticated prober.
    await expect(
      service.login({
        email: 'suspended-login@driftstack.local',
        password,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('a suspended account cannot mint a session through a magic link issued while it was active', async () => {
    const { service, repo } = makeDirectService();
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const signup = await service.signup({
      email: 'suspended-magic@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    const link = await service.requestMagicLink({
      email: 'suspended-magic@driftstack.local',
      requestedFromIp: null,
    });
    insertSession.mockClear();

    // Suspended AFTER the link was issued, which is the realistic order:
    // suspension is a response to something, and any link already in the
    // mailbox outlives it.
    repo.seedAccount({ ...signup.account, status: 'suspended' });

    await expect(
      service.consumeMagicLink({
        token: link.debugToken as string,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'account_suspended' });
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('a password reset whose account disappears BETWEEN the status check and the write is refused', async () => {
    const { service, repo } = makeDirectService();
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const signup = await service.signup({
      email: 'reset-vanishes@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    const reset = await service.requestPasswordReset({
      email: 'reset-vanishes@driftstack.local',
      requestedFromIp: null,
    });
    insertSession.mockClear();

    // ⚠️ This is NOT the door the arm above covers. The status check at :1211 is
    // already exercised by 'a suspended account cannot use an outstanding reset
    // link…'; a first draft of this arm duplicated it exactly, spies and all,
    // and the mutation ledger is what exposed the overlap — the mutation reddened
    // that pre-existing test as well as mine.
    //
    // The genuinely cold line is the one AFTER the write: `setPassword` returning
    // null. That is the account being suspended or deleted in the window between
    // the check passing and the UPDATE landing — the window the check itself
    // cannot close, which is why the write is conditional and its result is
    // re-examined. Driving it needs the repo to report the miss, because no
    // ordering of client calls can reliably hit a window this narrow.
    vi.spyOn(repo, 'setPassword').mockResolvedValue(null);

    await expect(
      service.confirmPasswordReset({
        token: reset.debugToken as string,
        newPassword: 'a different sufficiently long password',
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'account_suspended' });

    // The point of the branch: a conditional write that matched nothing must not
    // be followed by a session. Reporting the refusal is not enough on its own.
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
        verifyEmailUrl: 'https://app.driftstack.local/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/reset-password',
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

  // V-720 — verify-email was the ONE session-minting flow with no MFA branch,
  // so a live signup link minted a full session on an MFA-enrolled account:
  // possession of the inbox defeated the second factor, which is the exact
  // threat MFA backstops. Reachable inside the 30-minute signupVerification TTL
  // because consumeMagicLink marks the email verified and mints a session of
  // its own, letting the owner enrol MFA while the original signup token is
  // still live and unconsumed.
  it('turns a consumed verification link into an MFA challenge without minting a session, while still verifying the email', async () => {
    const { repo, service, challenges, getStatus } = makeMfaDirectService();
    const signup = await service.signup({
      email: 'mfa-verify-email@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    const result = await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: '203.0.113.7',
      userAgent: 'inbox-browser',
    });

    expect(result.kind).toBe('mfa_required');
    if (result.kind !== 'mfa_required') throw new Error('expected MFA challenge');
    expect(
      JSON.parse(String(await challenges.peek(mfaChallengeKey(result.challengeToken)))),
    ).toMatchObject({
      account_id: signup.account.id,
      source_ip: '203.0.113.7',
      issued_user_agent: 'inbox-browser',
    });
    expect(result.challengeExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(getStatus).toHaveBeenCalledWith(signup.account.id);
    // The bypass itself: no session may exist until the second factor lands.
    expect(insertSession).not.toHaveBeenCalled();
    // ...but the link DID prove mailbox control, so verification still sticks.
    // Only the session waits.
    expect((await repo.findAccountById(signup.account.id))?.emailVerifiedAt).toBeInstanceOf(Date);
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
      authEpoch: signup.account.authEpoch,
      expiresAt,
      issuedFromIp: null,
      userAgent: 'old-browser-one',
    });
    await repo.insertWebSession({
      accountId: signup.account.id,
      tokenHash: 'old-session-two',
      authEpoch: signup.account.authEpoch,
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

// MUTATION-PROVED against services/auth-flows.ts — control 72/72 here, 28/28 on
// services-auth-flows-content-parity:
//
//                                                   here    parity pin
//   the single-use claim stops refusing the loser   1 red     1 red
//   a challenge with neither code nor recovery      1 red     green
//   the mid-flight status pre-check removed        SURVIVES   green
//   the pre-check narrowed to `=== 'deleted'`      SURVIVES   green
//
// ⚠️ The two survivors are NOT gaps in these arms, and the check that settled it
// is worth recording. `issueWebSession` — called a few lines later — repeats
// `if (account.status !== 'active') throw new AuthFlowError('account_suspended')`
// at auth-flows.ts:1560. So the pre-check inside completeMfaChallenge is a
// fail-fast over an authoritative check, and removing it produces the identical
// error with the identical code. There is no observable difference for any
// caller, so no behavioural test can distinguish it — the same shape as the
// profile tier-cap pre-check in profiles-service.
//
// The security property these arms assert — a suspended or deleted account
// cannot complete MFA and receive a session — is therefore ENFORCED, just one
// layer down from where it is written. That is worth knowing before anyone
// "cleans up" the later check believing the earlier one covers it.

describe('AuthFlowsService.completeMfaChallenge — single-use and mid-flight account state', () => {
  /** Log in far enough to hold a live MFA challenge token. */
  async function challengeFor(email: string): Promise<{
    repo: InMemoryAuthFlowsRepo;
    service: AuthFlowsService;
    challenges: InMemoryMfaChallengeStore;
    token: string;
    accountId: string;
  }> {
    const { repo, service, challenges } = makeMfaDirectService();
    const signup = await service.signup({
      email,
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, emailVerifiedAt: new Date() });
    const login = await service.login({
      email: signup.account.email,
      password: 'correct horse battery staple',
      issuedFromIp: '203.0.113.9',
      userAgent: 'browser',
    });
    if (login.kind !== 'mfa_required') throw new Error('expected MFA challenge');
    return { repo, service, challenges, token: login.challengeToken, accountId: signup.account.id };
  }

  const consume = (service: AuthFlowsService, token: string): Promise<unknown> =>
    service.completeMfaChallenge({
      challengeToken: token,
      code: '123456',
      sourceIp: '203.0.113.9',
      userAgent: 'browser',
    });

  it('CRITICAL two requests racing the SAME valid code mint exactly one session. The claim is an atomic GETDEL, and the loser must not mint a second session — sequential reuse is already caught by the peek, so this is the concurrent window, and losing it turns one MFA code into as many sessions as an attacker can fire in parallel.', async () => {
    const { service, token } = await challengeFor('mfa-race@driftstack.local');
    const [a, b] = await Promise.allSettled([consume(service, token), consume(service, token)]);
    const won = [a, b].filter((r) => r.status === 'fulfilled');
    const lost = [a, b].filter((r) => r.status === 'rejected');
    expect(won.length, 'exactly one session minted').toBe(1);
    expect(lost.length, 'and exactly one refusal').toBe(1);
    expect(
      (lost[0] as PromiseRejectedResult).reason,
      'the loser is told the token was already used, not given a session',
    ).toMatchObject({ code: 'invalid_auth_token' });
  });

  it('CRITICAL an account SUSPENDED between challenge issue and consume cannot complete MFA. The window is real: the token outlives the login that issued it, and suspension is how billing failure and policy enforcement stop an account. Passing the second factor is not the same as still being allowed in.', async () => {
    const { repo, service, token, accountId } = await challengeFor('mfa-suspend@driftstack.local');
    const live = await repo.findAccountById(accountId);
    repo.seedAccount({ ...live!, status: 'suspended' });
    await expect(consume(service, token)).rejects.toMatchObject({ code: 'account_suspended' });
  });

  it("CRITICAL an account DELETED between issue and consume cannot complete MFA either. Note the refusal is the SAME `account_suspended` code as suspension: this path checks `status !== 'active'` and does not distinguish them, unlike the API-key and web-session paths where deleted answers InvalidKeyError so it cannot be told apart from a bad credential. That asymmetry is defensible here — a caller completing MFA has already presented this account's password, so the account's existence is not news to them — and it is pinned so the collapse is a decision rather than an accident.", async () => {
    const { repo, service, token, accountId } = await challengeFor('mfa-delete@driftstack.local');
    const live = await repo.findAccountById(accountId);
    repo.seedAccount({ ...live!, status: 'deleted' });
    await expect(consume(service, token)).rejects.toMatchObject({ code: 'account_suspended' });
  });

  it('CRITICAL a challenge with NEITHER a code nor a recovery code is refused before the token is touched. Without it an empty body reaches the verifier with nothing to verify, and the challenge token is spent on a request that never presented a second factor.', async () => {
    const { service, challenges, token } = await challengeFor('mfa-nocode@driftstack.local');
    await expect(
      service.completeMfaChallenge({
        challengeToken: token,
        sourceIp: '203.0.113.9',
        userAgent: 'browser',
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    expect(
      await challenges.peek(mfaChallengeKey(token)),
      'and the token survives for a real attempt',
    ).not.toBeNull();
  });
});

describe('AuthFlowsService.completeMfaChallenge — fail-closed challenge integrity', () => {
  it('rejects an unavailable attempt IP when the challenge was issued from a known IP without consuming the legitimate retry', async () => {
    const { repo, service, challenges, verifyCode } = makeMfaDirectService();
    const signup = await service.signup({
      email: 'mfa-ip-bound@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, emailVerifiedAt: new Date() });
    const login = await service.login({
      email: signup.account.email,
      password: 'correct horse battery staple',
      issuedFromIp: '203.0.113.9',
      userAgent: 'bound-browser',
    });
    expect(login.kind).toBe('mfa_required');
    if (login.kind !== 'mfa_required') throw new Error('expected MFA challenge');

    await expect(
      service.completeMfaChallenge({
        challengeToken: login.challengeToken,
        code: '123456',
        sourceIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    expect(verifyCode).not.toHaveBeenCalled();
    expect(await challenges.peek(mfaChallengeKey(login.challengeToken))).not.toBeNull();

    await expect(
      service.completeMfaChallenge({
        challengeToken: login.challengeToken,
        code: '123456',
        sourceIp: '203.0.113.9',
        userAgent: null,
      }),
    ).resolves.toMatchObject({ via: 'totp' });
  });

  it.each([
    ['invalid JSON', '{not-json'],
    [
      'invalid field types',
      JSON.stringify({
        account_id: null,
        email: 'customer@driftstack.local',
        source_ip: '203.0.113.9',
        issued_at: 'now',
        issued_user_agent: null,
      }),
    ],
  ])('consumes %s without calling the verifier or minting a session', async (_label, raw) => {
    const { repo, service, challenges, verifyCode } = makeMfaDirectService();
    const challengeToken = generateChallengeToken();
    await challenges.set(mfaChallengeKey(challengeToken), raw, 60);
    const insertSession = vi.spyOn(repo, 'insertWebSession');

    await expect(
      service.completeMfaChallenge({
        challengeToken,
        code: '123456',
        sourceIp: '203.0.113.9',
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    expect(await challenges.peek(mfaChallengeKey(challengeToken))).toBeNull();
    expect(verifyCode).not.toHaveBeenCalled();
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

  it('invalidates cached account auth even when there are no older session rows to revoke', async () => {
    const invalidateAccount = vi.fn().mockResolvedValue(undefined);
    const authCache = { invalidateAccount } as unknown as AuthCache;
    const { service } = makeDirectService(new InMemoryAuthFlowsRepo(), authCache);
    const signup = await service.signup({
      email: 'reset-cache-fence@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const reset = await service.requestPasswordReset({
      email: signup.account.email,
      requestedFromIp: null,
    });

    await expect(
      service.confirmPasswordReset({
        token: reset.debugToken as string,
        newPassword: 'an entirely different cache-fenced passphrase!!',
        issuedFromIp: null,
        userAgent: null,
      }),
    ).resolves.toMatchObject({ kind: 'session' });
    expect(invalidateAccount).toHaveBeenCalledTimes(1);
    expect(invalidateAccount).toHaveBeenCalledWith(signup.account.id);
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
  it('cannot insert a successor after password reset changes the account epoch and sweeps sessions', async () => {
    const repo = new PasswordResetBeforeSessionInsertRepo();
    const { service } = makeDirectService(repo);
    const signup = await service.signup({
      email: 'reset-refresh-race@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    const verify = await service.verifyEmail({
      token: signup.debugToken!,
      issuedFromIp: null,
      userAgent: null,
    });
    assertVerifiedSession(verify);
    repo.armPasswordResetBeforeNextInsert();

    await expect(
      service.refreshSession({
        token: verify.session.plaintext,
        issuedFromIp: '203.0.113.90',
        userAgent: 'stolen-browser',
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });

    expect(await repo.listActiveWebSessionsForAccount(verify.account.id, new Date())).toEqual([]);
    expect((await repo.findAccountById(verify.account.id))?.authEpoch).toBe(1);
  });

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
    assertVerifiedSession(verify);
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
    assertVerifiedSession(verify);
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
    assertVerifiedSession(verify);

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
    assertVerifiedSession(verify);
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
    assertVerifiedSession(verifyA);
    assertVerifiedSession(verifyB);
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
        verifyEmailUrl: 'https://app.driftstack.local/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/reset-password',
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
        verifyEmailUrl: 'https://app.driftstack.local/verify-email',
        magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
        passwordResetUrl: 'https://app.driftstack.local/reset-password',
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

// ─── MFA must fail CLOSED when the server is not wired for it ───────────────
//
// Two refusals, both cold at HEAD (v8 coverage), both guarding the same
// inversion: on a deployment where the MFA service is absent, "MFA is not
// configured" must never be treated as "MFA is satisfied".
//
//   auth-flows.ts:960   completeMfaChallenge, when mfa OR the challenge store is missing
//   auth-flows.ts:1336  stepUpReauth, when mfa is missing
//
// Reachable without any new seam: `makeDirectService()` has always constructed
// the service with both left null. Nothing had ever called these two methods on
// it.
//
// ⚠️ Why this is not a theoretical configuration. A challenge is issued by one
// process and consumed by another request, so the two can land on different
// instances — a rolling deploy, or one replica that came up without the MFA env.
// login() only issues a challenge when `this.mfa` is wired, so the token cannot
// originate here; it can very easily ARRIVE here. And stepUpReauth is what
// satisfies `requireMfaFresh`, so a version that returned success instead of
// refusing would let a caller clear the step-up gate having proved nothing.
//
// ⭐ The compound guard is why there are three challenge arms rather than one.
// `if (!this.mfa || !this.mfaChallenges)` has TWO conditions, and
// `makeDirectService()` leaves BOTH null — so an arm built on it is refused by
// either half and cannot tell which did the work. Each half needs a fixture that
// isolates it, and the ledger shows both narrowings caught by exactly one arm.
//
// LEDGER — control 79/79:
//
//   challenge guard removed entirely        3 red
//   NARROWED to the mfa half only           1 red
//   NARROWED to the store half only         1 red
//   challenge guard refuses ALWAYS          6 red
//   step-up guard removed                   1 red
//   step-up guard refuses ALWAYS            5 red
//
// The last two rows of each pair are the anti-vacuity check, and they are not
// mine — 6 and 5 PRE-EXISTING MFA arms red when the guard refuses everything.
// That is what stops these three arms from being satisfied by a build that
// simply never completes a challenge. Without it, "it threw" proves nothing.
//
// ⚠️ Measured, not designed: the store-half narrowing SURVIVED until the third
// arm existed. Both halves looked covered by the first arm because it happened
// to trip both at once — the same "one fixture trips two halves of a guard, so
// it discriminates neither" trap as the VPN host/config guards.
describe('MFA fails closed when the server is not wired for it', () => {
  it('completeMfaChallenge refuses outright when no MFA service is wired', async () => {
    const { service } = makeDirectService();
    await expect(
      service.completeMfaChallenge({
        challengeToken: 'a'.repeat(43),
        code: '123456',
        sourceIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    await expect(
      service.completeMfaChallenge({
        challengeToken: 'a'.repeat(43),
        code: '123456',
        sourceIp: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/MFA challenge not available on this server/i);
  });

  it('completeMfaChallenge refuses when MFA is wired but the challenge STORE is missing', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const logger = createTestLogger();
    const email = createEmailService({ config: null, logger });
    // Wired for MFA, no challenge store — the half of the guard that a
    // narrowing to `if (!this.mfa)` alone would silently admit.
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
      null,
      null,
      { getStatus: vi.fn(), verifyCode: vi.fn() } as never,
      null,
    );

    await expect(
      service.completeMfaChallenge({
        challengeToken: 'a'.repeat(43),
        code: '123456',
        sourceIp: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/MFA challenge not available on this server/i);
  });

  it('completeMfaChallenge refuses when the challenge store is wired but MFA is NOT', async () => {
    const repo = new InMemoryAuthFlowsRepo();
    const logger = createTestLogger();
    const email = createEmailService({ config: null, logger });
    // The mirror image of the arm above. Both halves of
    // `!this.mfa || !this.mfaChallenges` need their own fixture, because
    // `makeDirectService()` leaves BOTH null — so an arm built on it is refused
    // by either half and cannot tell which one did the work. Measured: narrowing
    // the guard to the store half alone survived until this arm existed.
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
      null,
      null,
      null,
      new InMemoryMfaChallengeStore(),
    );

    await expect(
      service.completeMfaChallenge({
        challengeToken: 'a'.repeat(43),
        code: '123456',
        sourceIp: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/MFA challenge not available on this server/i);
  });

  it('stepUpReauth refuses when no MFA service is wired, so the freshness gate cannot be cleared', async () => {
    const { service } = makeDirectService();
    await expect(
      service.stepUpReauth({
        accountId: '00000000-0000-4000-8000-000000000001',
        sessionId: '00000000-0000-4000-8000-000000000002',
        input: '123456',
      }),
    ).rejects.toThrow(/MFA step-up not available on this server/i);
  });
});

// ─── the two signup races, and the catch that must stay precise ────────────
//
// `signup()` pre-checks the literal email AND the canonical (alias-folded) one,
// then inserts. Two concurrent signups can both pass a pre-check before either
// commits, so the unique indexes are the real arbiters and the loser arrives as
// a Postgres 23505. Both translations were cold at HEAD:
//
//   accounts_email_unique            two signups for the SAME literal address
//   accounts_canonical_email_unique  two signups for DIFFERENT alias variants
//                                    of the same mailbox (user+1@ / user+2@)
//
// The second is the one that carries weight. Alias folding is what stops one
// mailbox minting unlimited "distinct" free accounts, and the pre-check cannot
// enforce it under concurrency — only the index can. A loser that surfaced as an
// uncaught 500 would also be a loser the caller may retry into a different
// outcome, so the translation is the difference between "this mailbox already
// has an account" and a server fault.
//
// ⭐ The third arm is what keeps the catch honest. It must translate THESE two
// constraints, not every 23505 that happens to pass through — a unique violation
// from an unrelated index is a real fault and must stay one. A catch-all here
// would convert genuine database bugs into a cheerful 409 for the rest of time.
//
// LEDGER — control 82/82, each mutation caught by exactly one arm:
//
//   literal-race translation removed              1 red
//   canonical-race translation removed            1 red
//   catch-all: ANY 23505 becomes the 409          1 red
//   canonical arm keyed on the WRONG constraint   1 red
//
// The last two are the ones a deletion-only ledger would miss. The catch-all
// leaves both races handled and every assertion about them green; only the
// unrelated-index arm notices. And keying the canonical branch on the literal
// constraint name leaves the code reading correctly — two branches, two
// `isUniqueViolation` calls, the right error — while the canonical race falls
// through to a 500. Alias folding would then hold in every sequential test and
// fail exactly when two variants of one mailbox arrive together, which is the
// only time it is load-bearing.
describe('signup translates a lost insert race, precisely', () => {
  function unique23505(constraint: string): Error {
    return Object.assign(
      new Error(`duplicate key value violates unique constraint "${constraint}"`),
      {
        code: '23505',
        constraint_name: constraint,
      },
    );
  }

  async function signupWithInsertFailure(constraint: string): Promise<unknown> {
    const { service, repo } = makeDirectService();
    vi.spyOn(repo, 'createAccount').mockRejectedValue(unique23505(constraint));
    return service.signup({
      email: 'race@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
  }

  it('the literal-email race loses as email_already_registered, not a 500', async () => {
    await expect(signupWithInsertFailure('accounts_email_unique')).rejects.toMatchObject({
      code: 'email_already_registered',
    });
  });

  it('the canonical-email race loses the same way, so alias folding holds under concurrency', async () => {
    await expect(signupWithInsertFailure('accounts_canonical_email_unique')).rejects.toMatchObject({
      code: 'email_already_registered',
    });
  });

  it('a 23505 from an UNRELATED index is re-thrown untouched, so the catch cannot mask a real fault', async () => {
    // Same SQLSTATE, different constraint. If this became
    // email_already_registered, every unique-violation bug in any future index
    // touched by signup would be reported to the customer as "that email is
    // taken" and never surface as the fault it is.
    await expect(signupWithInsertFailure('accounts_slug_unique')).rejects.not.toMatchObject({
      code: 'email_already_registered',
    });
    await expect(signupWithInsertFailure('accounts_slug_unique')).rejects.toThrow(
      /duplicate key value/i,
    );
  });
});

// ─── losing the single-use token compare-and-swap ───────────────────────────
//
// `verifyEmail` and `confirmPasswordReset` both claim their whole token FAMILY
// in one conditional UPDATE — `consumeAuthTokenFamily` — and both refuse when it
// reports the claim was lost. Neither refusal had ever executed.
//
// ⚠️ Measured before writing these, by ignoring each verdict in turn: the whole
// auth-flows file stayed green at 82/82 both times. The concurrent-verify arm
// further up does NOT reach them, and cannot: the winner finishes before the
// loser starts, so the loser's `findActiveAuthToken` already returns null and it
// is refused by the pre-check. Both sites answer `invalid_auth_token`, so even a
// genuinely interleaved race could not be attributed from outside. Same shape as
// the OAuth authorize pre-check and its atomic sibling.
//
// So the repo reports the loss directly. What the guards protect is worth being
// precise about: the pre-check is an early-exit for the ordinary case, and the
// UPDATE is the only thing that serialises TWO DIFFERENT LIVE TOKENS of the same
// family — a second verification email, or a reset requested twice. Without it
// both callers proceed, and the source says what that costs: two sessions minted
// from one link, or two password writes whose session issuance mutually revokes
// the other into a lockout.
//
// LEDGER — control 84/84:
//
//   email_verify verdict ignored     1 red
//   password_reset verdict ignored   1 red
//   email_verify verdict INVERTED   27 red
//
// The inversion is the anti-vacuity row and it is not mine: 27 pre-existing arms
// red when a WON claim is treated as lost. That is what stops these two from
// being satisfied by a build that refuses every verification — "it threw" is not
// the property, "it threw only when the claim was lost" is.
describe('a lost single-use token claim is refused, and nothing is written', () => {
  it('verifyEmail mints NO session when the family claim is lost', async () => {
    const { service, repo } = makeDirectService();
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const signup = await service.signup({
      email: 'verify-race@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    insertSession.mockClear();
    // The token is still live — findActiveAuthToken succeeds — and the atomic
    // claim is what fails. That ordering is the whole point: a test that made the
    // token invalid instead would be refused one line earlier and prove nothing.
    vi.spyOn(repo, 'consumeAuthTokenFamily').mockResolvedValue(false);

    await expect(
      service.verifyEmail({
        token: signup.debugToken as string,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('confirmPasswordReset writes NO password and mints NO session when the family claim is lost', async () => {
    const { service, repo } = makeDirectService();
    const signup = await service.signup({
      email: 'reset-race@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    const reset = await service.requestPasswordReset({
      email: 'reset-race@driftstack.local',
      requestedFromIp: null,
    });
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    const setPassword = vi.spyOn(repo, 'setPassword');
    vi.spyOn(repo, 'consumeAuthTokenFamily').mockResolvedValue(false);

    await expect(
      service.confirmPasswordReset({
        token: reset.debugToken as string,
        newPassword: 'a different sufficiently long password',
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_auth_token' });

    // ⭐ Two assertions because the guard sits ABOVE both effects. A build that
    // moved it below `setPassword` would still refuse — same error, same status —
    // having already overwritten the credential of an account whose reset link
    // lost its race. The thrown error cannot see that; the spy can.
    expect(setPassword).not.toHaveBeenCalled();
    expect(insertSession).not.toHaveBeenCalled();
  });
});

// ─── the account disappears between issuing a token and redeeming it ────────
//
// Two guards refuse a session when the account row is gone by the time the
// second half of a flow runs:
//
//   auth-flows.ts:1040  completeMfaChallenge — "Account is no longer active."
//   auth-flows.ts:1546  requireAccount       — "account vanished mid-flow"
//
// ⚠️ Both were uncovered, measured rather than assumed: ignoring each verdict in
// turn left 231 tests across 15 auth / MFA / web-session files green. The second
// one's own comment says "this should not happen in practice", which is exactly
// the kind of guard that rots — nobody writes a test for a branch the source
// describes as impossible, and nobody notices when a refactor makes it
// reachable.
//
// They are not interchangeable. `:1040` sits on the MFA completion path and is
// reached with a VALID challenge token; `:1546` is a shared helper behind the
// magic-link and password-reset paths. Each needs its own flow to be driven.
//
// ⭐ Both arms assert `insertWebSession` was never called, not just that a
// refusal was thrown. "No session exists for an account that does not exist" is
// the property; the error is how it is reported. And both are session-MINTING
// paths — a build that let either through would hand out a 30-day credential
// bound to an account id nothing else in the system can resolve.
//
// LEDGER — control 86/86:
//
//   :1040 vanished-account guard ignored    1 red
//   :1546 requireAccount guard ignored      1 red
//   :1040 INVERTED (refuses a LIVE account) 5 red
//
// The inversion is the anti-vacuity row and those 5 are pre-existing arms: they
// red when a present account is treated as missing. Without that row, both arms
// above would be satisfied by a build that refused every challenge.
describe('a vanished account cannot complete a flow it started', () => {
  it('completeMfaChallenge refuses when the account is gone by the time the code arrives', async () => {
    // Built inline rather than through the describe-scoped `challengeFor`
    // helper above, which is not in scope here.
    const { repo, service } = makeMfaDirectService();
    const signup = await service.signup({
      email: 'mfa-vanish@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    repo.seedAccount({ ...signup.account, emailVerifiedAt: new Date() });
    const login = await service.login({
      email: signup.account.email,
      password: 'correct horse battery staple',
      issuedFromIp: '203.0.113.9',
      userAgent: 'browser',
    });
    if (login.kind !== 'mfa_required') throw new Error('expected an MFA challenge');
    const token = login.challengeToken;
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    // Gone AFTER the challenge was issued. The challenge token itself stays
    // valid — the account behind it is what disappeared, which is the only way
    // to reach this branch rather than the already-used one above it.
    vi.spyOn(repo, 'findAccountById').mockResolvedValue(null);

    await expect(
      service.completeMfaChallenge({
        challengeToken: token,
        code: '123456',
        sourceIp: '203.0.113.9',
        userAgent: 'browser',
      }),
    ).rejects.toThrow(/account is no longer active/i);
    expect(insertSession).not.toHaveBeenCalled();
  });

  it('consumeMagicLink refuses when the account is gone by the time the link is clicked', async () => {
    const { service, repo } = makeDirectService();
    const signup = await service.signup({
      email: 'magic-vanish@driftstack.local',
      password: 'correct horse battery staple',
      requestedFromIp: null,
    });
    await service.verifyEmail({
      token: signup.debugToken as string,
      issuedFromIp: null,
      userAgent: null,
    });
    const link = await service.requestMagicLink({
      email: 'magic-vanish@driftstack.local',
      requestedFromIp: null,
    });
    const insertSession = vi.spyOn(repo, 'insertWebSession');
    // The link is live and its family claim will succeed; only the account
    // lookup that follows comes back empty.
    vi.spyOn(repo, 'findAccountById').mockResolvedValue(null);

    await expect(
      service.consumeMagicLink({
        token: link.debugToken as string,
        issuedFromIp: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/account vanished mid-flow/i);
    expect(insertSession).not.toHaveBeenCalled();
  });
});

// ─── a suspended account is not SENT an actionable auth email ──────────────
//
// The guard-condition census found `account.status !== 'active'` at nine sites
// in this service. Neutralizing each (making the refusal unreachable) showed
// most are redundant with the `issueWebSession` chokepoint — a suspended account
// cannot end up with a session even if a door-local check is removed.
//
// ⭐ These two are the exception, and that is why they matter. `requestMagicLink`
// and `requestPasswordReset` do not mint anything: they SEND. Suppression here
// is the only thing standing between a suspended account and a working sign-in
// link in its inbox, and no session-minting chokepoint can cover it — the email
// has already left.
//
// Both return `{ sent: false }` rather than an error, deliberately: telling an
// unauthenticated caller "that account is suspended" would turn either endpoint
// into an account-state oracle. So the assertion cannot be on the response
// alone — it has to be that NO MAIL WAS PRODUCED.
//
// LEDGER — control 88/88:
//
//   :1079 magic-link suppression neutralized   1 red
//   :1163 reset suppression neutralized        1 red
//
// ⚠️ Two methodological notes, both mistakes caught here rather than shipped.
//
// The census probe was run first with an INVERTING mutation (`!== 'NEVER'`, so
// the guard always fires) and every one of the nine status guards reddened —
// which reads like "all covered" and is not that question at all. Inverting
// tests whether a guard is CONSULTED; neutralizing tests whether its refusal is
// EXERCISED. Re-run neutralized, four of six were cold.
//
// And the first version of these arms read `repo.sentEmails`, which does not
// exist — `?? 0` made both sides zero and the assertion vacuous while green. The
// second version fabricated an account row for `seedAccount`, which is keyed by
// id, so the real account stayed active and the arm failed loudly instead. Only
// reading the row back and suspending THAT one drives the branch.
describe('auth emails are suppressed for a suspended account', () => {
  let fxs: TestAppFixture;

  afterEach(async () => {
    if (fxs) await fxs.cleanup();
  });

  async function suspendedThenAsk(
    url: string,
  ): Promise<{ status: number; mailsBefore: number; mailsAfter: number }> {
    fxs = await buildTestApp();
    const email = 'suppressed@driftstack.local';
    const signup = await fxs.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password: 'correct horse battery staple' },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    await fxs.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: signup.json<{ debug_token: string }>().debug_token },
    });
    // Suspend through the repo the routes actually read. seedAccount is keyed
    // by id, so the row has to be read back first — a fabricated row lands under
    // a different key and leaves the real account active, which is exactly how
    // the first version of this arm reported mail it should not have seen.
    const row = await fxs.authFlowsRepo.findAccountByEmail(email);
    expect(row, 'the signed-up account must be readable before suspending it').not.toBeNull();
    fxs.authFlowsRepo.seedAccount({ ...row!, status: 'suspended' });

    const before = fxs.emailSends.length;
    const res = await fxs.app.inject({ method: 'POST', url, payload: { email } });
    return { status: res.statusCode, mailsBefore: before, mailsAfter: fxs.emailSends.length };
  }

  it('CRITICAL no magic-link mail is produced for a suspended account. The response deliberately does not say why — telling an unauthenticated caller "suspended" would make this an account-state oracle — so the mailbox, not the status, is what the assertion has to read.', async () => {
    const r = await suspendedThenAsk('/v1/auth/magic-link/request');
    expect(r.mailsAfter, 'no magic-link mail was produced').toBe(r.mailsBefore);
  });

  it('CRITICAL no password-reset mail is produced for a suspended account either — the sibling copy of the same suppression, and the only guard standing between a suspended account and a working sign-in link', async () => {
    const r = await suspendedThenAsk('/v1/auth/password-reset/request');
    expect(r.mailsAfter, 'no reset mail was produced').toBe(r.mailsBefore);
  });
});
