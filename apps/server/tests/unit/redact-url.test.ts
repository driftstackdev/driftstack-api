// V-494 follow-up — credential-bearing query params (the SSE ?ds_token=,
// the OAuth ?code=, etc.) must never reach a log line or Sentry event in
// plaintext. redactUrlQueryTokens / redactQueryString strip those values
// while preserving the path + benign params. See lib/redact-url.ts.
//
// GDPR/data-minimization follow-up — customer email addresses are personal
// data and must never reach a log line in plaintext either. maskEmail()
// covers that (below), plus call-site pins on every service that logs a
// customer email (email.ts send/failure, auth-flows.ts magic-link/password-
// reset unknown-email no-ops, incident-notifications.ts fan-out failure) so
// a future call site that forgets to mask is caught here, not in prod logs.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../src/lib/logger.js';
import {
  redactUrlQueryTokens,
  redactQueryString,
  redactText,
  redactUrlUserinfo,
  maskEmail,
} from '../../src/lib/redact-url.js';
import {
  createEmailService,
  type EmailService,
  type PostmarkSendApi,
} from '../../src/services/email.js';
import { AuthFlowsService } from '../../src/services/auth-flows.js';
import { IncidentNotificationsService } from '../../src/services/incident-notifications.js';
import type { StatusSubscribersService } from '../../src/services/status-subscribers.js';
import { InMemoryAuthFlowsRepo } from '../integration/_helpers/in-memory-auth-flows-repo.js';

// Mirrors tests/unit/email.test.ts's makeLogger — a spy-backed Logger so
// call sites can be asserted against without a real pino instance.
function makeSpyLogger(): Logger {
  const fns = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  return {
    ...fns,
    level: 'info',
    silent: () => {},
    child: () => makeSpyLogger(),
  } as unknown as Logger;
}

/** True iff any argument logged in any spy call contains a raw, unmasked
 *  occurrence of `email` (i.e. the bug this test suite guards against). */
function loggedRawEmail(logger: Logger, email: string): boolean {
  const spies = [logger.info, logger.warn, logger.error] as unknown as ReturnType<typeof vi.fn>[];
  return spies.some((spy) =>
    spy.mock.calls.some((call: unknown[]) =>
      call.some((arg) => JSON.stringify(arg).includes(email)),
    ),
  );
}

describe('redactUrlQueryTokens', () => {
  it('redacts the SSE ds_token while keeping the path', () => {
    const out = redactUrlQueryTokens('/v1/agent-sessions/abc/events?ds_token=sk-live-SECRET');
    expect(out).not.toContain('sk-live-SECRET');
    expect(out).toContain('/v1/agent-sessions/abc/events');
    expect(out.toLowerCase()).toContain('ds_token=');
  });

  it('redacts the OAuth single-use code and signed state token', () => {
    const out = redactUrlQueryTokens(
      '/v1/auth/oauth-client/callback?code=AUTHCODE123&state=STATE_SECRET&keep=ok',
    );
    expect(out).not.toContain('AUTHCODE123');
    expect(out).not.toContain('STATE_SECRET');
    expect(out).toContain('keep=ok');
  });

  it('leaves a token-free URL byte-for-byte unchanged (no needless re-encoding)', () => {
    const url = '/v1/sessions?limit=20&cursor=abc';
    expect(redactUrlQueryTokens(url)).toBe(url);
  });

  it('leaves a URL with no query unchanged', () => {
    expect(redactUrlQueryTokens('/v1/whoami')).toBe('/v1/whoami');
  });

  it('redacts multiple sensitive params (token + api_key) in one URL', () => {
    const out = redactUrlQueryTokens('/x?token=AAA&keep=1&api_key=BBB');
    expect(out).not.toContain('AAA');
    expect(out).not.toContain('BBB');
    expect(out).toContain('keep=1');
  });

  it('redacts OAuth state and auth-material aliases while keeping public PKCE challenge', () => {
    const out = redactUrlQueryTokens(
      '/callback?state=STATE_SECRET&session_token=SESSION_SECRET&debug_token=DEBUG_SECRET&challenge_token=CHALLENGE_SECRET&code_verifier=VERIFIER_SECRET&code_challenge=PUBLIC_CHALLENGE',
    );
    expect(out).not.toMatch(
      /STATE_SECRET|SESSION_SECRET|DEBUG_SECRET|CHALLENGE_SECRET|VERIFIER_SECRET/,
    );
    expect(out).toContain('code_challenge=PUBLIC_CHALLENGE');
  });

  it('matches sensitive keys case-insensitively', () => {
    const out = redactUrlQueryTokens('/x?DS_TOKEN=SECRET');
    expect(out).not.toContain('SECRET');
  });

  it('handles empty / non-string input defensively', () => {
    expect(redactUrlQueryTokens('')).toBe('');
    // @ts-expect-error — defensive runtime guard for a non-string.
    expect(redactUrlQueryTokens(undefined)).toBe(undefined);
  });
});

describe('redactQueryString (bare query, no leading ?)', () => {
  it('redacts ds_token in a bare query string (Sentry query_string shape)', () => {
    const out = redactQueryString('ds_token=SECRET&foo=bar');
    expect(out).not.toContain('SECRET');
    expect(out).toContain('foo=bar');
  });

  it('leaves a token-free bare query unchanged', () => {
    expect(redactQueryString('limit=20&cursor=abc')).toBe('limit=20&cursor=abc');
  });
});

describe('redactText — free-text (exception/breadcrumb/message) credential redaction', () => {
  it('redacts a credential query param embedded mid-sentence, preserving surrounding prose', () => {
    const out = redactText(
      'Failed to fetch https://api.driftstack.dev/v1/account/me/notifications?ds_token=ds_live_SECRET retrying',
    );
    expect(out).not.toContain('ds_live_SECRET');
    expect(out).toContain('ds_token=[redacted]');
    expect(out).toContain('Failed to fetch'); // prose intact
    expect(out).toContain('retrying'); // trailing prose intact (url-parser would have eaten it)
  });

  it('redacts a Bearer token in free text', () => {
    const out = redactText('upstream rejected: Authorization: Bearer sk-live-DEADBEEF (401)');
    expect(out).not.toContain('sk-live-DEADBEEF');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('(401)');
  });

  it('redacts the complete RFC 6750 bearer b64token alphabet including + / ~ and = padding', () => {
    const out = redactText('upstream rejected Bearer abc.DEF_ghi~jkl+DEEPSECRET/== (401)');
    expect(out).not.toContain('DEEPSECRET');
    expect(out).not.toContain('+');
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('(401)');
  });

  it('redacts Basic base64 credentials in free text without consuming ordinary basic-auth prose', () => {
    const encoded = 'YWxpY2U6aHVudGVyMg=='; // alice:hunter2
    const out = redactText(`proxy replied Authorization: Basic ${encoded} (407)`);
    expect(out).not.toContain(encoded);
    expect(out).toContain('Basic [redacted]');
    expect(out).toContain('(407)');
    expect(redactText('basic auth failed before credentials were sent')).toBe(
      'basic auth failed before credentials were sent',
    );
  });

  it('redacts the OAuth ?code= and multiple params', () => {
    const out = redactText(
      'cb https://x/y?code=AUTHCODE&state=STATE_SECRET&access_token=TT&keep=ok done',
    );
    expect(out).not.toContain('AUTHCODE');
    expect(out).not.toContain('TT');
    expect(out).toContain('code=[redacted]');
    expect(out).toContain('access_token=[redacted]');
    expect(out).not.toContain('STATE_SECRET');
    expect(out).toContain('keep=ok'); // benign param kept
    expect(out).toContain('done');
  });

  it('redacts an OAuth-implicit token in a URL FRAGMENT (the #-led first param leaks otherwise)', () => {
    // A landing URL with a fragment token can surface in an error message /
    // stack that the logger + Sentry pass through redactText. The fragment's
    // FIRST param is `#`-led, not `?`/`&`-led, so it would leak without `#` in
    // the delimiter class while `&`-joined params got redacted.
    const out = redactText(
      'navigate failed at https://app.example/cb#access_token=LEAKA&id_token=LEAKB',
    );
    expect(out).not.toContain('LEAKA'); // #-led fragment token redacted
    expect(out).not.toContain('LEAKB'); // &-joined fragment token redacted
    expect(out).toContain('access_token=[redacted]');
    expect(out).toContain('id_token=[redacted]');
    expect(out).toContain('navigate failed at'); // prose intact
  });

  it('redacts OAuth state and PKCE verifier embedded in free diagnostic text', () => {
    const out = redactText(
      'callback https://app.invalid/cb?state=STATE_SECRET&code_verifier=VERIFIER_SECRET&code_challenge=PUBLIC_CHALLENGE failed',
    );
    expect(out).not.toContain('STATE_SECRET');
    expect(out).not.toContain('VERIFIER_SECRET');
    expect(out).toContain('code_challenge=PUBLIC_CHALLENGE');
  });

  it('does not redact a non-secret fragment / anchor', () => {
    expect(redactText('see https://docs.example/page#section-two for details')).toBe(
      'see https://docs.example/page#section-two for details',
    );
  });

  it('leaves token-free text unchanged', () => {
    expect(redactText('connection reset by peer (ECONNRESET)')).toBe(
      'connection reset by peer (ECONNRESET)',
    );
    expect(redactText('')).toBe('');
  });
});

describe('userinfo credential redaction (scheme://user:pass@host)', () => {
  it('redacts user:pass@ userinfo in a full URL, keeping scheme + host', () => {
    expect(redactUrlUserinfo('https://alice:hunter2@host.example/path')).toBe(
      'https://[redacted]@host.example/path',
    );
    expect(redactUrlUserinfo('socks5://u:p@proxy.internal:1080')).toBe(
      'socks5://[redacted]@proxy.internal:1080',
    );
  });

  it('redacts a bare username-only userinfo too (over-redaction in logs is safe)', () => {
    expect(redactUrlUserinfo('https://tokenish@host/x')).toBe('https://[redacted]@host/x');
  });

  it('leaves userinfo-free URLs + a query-embedded @ + mailto untouched', () => {
    expect(redactUrlUserinfo('https://host/path?x=1')).toBe('https://host/path?x=1');
    // a query-embedded @ (email) is NOT userinfo — the host's `/`/`?` stop the class
    expect(redactUrlUserinfo('https://host/?email=a@b.com')).toBe('https://host/?email=a@b.com');
    // mailto: has no `//` → not matched
    expect(redactUrlUserinfo('mailto:user@host.com')).toBe('mailto:user@host.com');
    expect(redactUrlUserinfo('')).toBe('');
  });

  it('redactText scrubs userinfo creds embedded in an error message, prose intact', () => {
    const out = redactText(
      'proxy connect failed for socks5://bob:s3cret@p.example:1080 (ETIMEDOUT)',
    );
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('bob:s3cret');
    expect(out).toContain('socks5://[redacted]@p.example:1080');
    expect(out).toContain('ETIMEDOUT'); // prose intact
  });

  it('redactUrlQueryTokens redacts BOTH userinfo and a query token in one full URL', () => {
    const out = redactUrlQueryTokens('https://u:p@host/cb?code=AUTH&state=STATE_SECRET&keep=ok');
    expect(out).not.toContain('u:p@');
    expect(out).not.toContain('AUTH');
    expect(out).toContain('https://[redacted]@host/cb'); // userinfo: plain replace
    expect(out).toContain('code=%5Bredacted%5D'); // query value: URL-encoded by URLSearchParams
    expect(out).not.toContain('STATE_SECRET');
    expect(out).toContain('keep=ok');
  });

  it('redactUrlQueryTokens redacts userinfo even with no query present', () => {
    expect(redactUrlQueryTokens('https://u:p@host/path')).toBe('https://[redacted]@host/path');
  });
});

describe('maskEmail (GDPR/data-minimization — customer email addresses in logs)', () => {
  it('keeps the first local-part character + full domain, masks the rest', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@example.com');
    expect(maskEmail('a@b.com')).toBe('a***@b.com');
  });

  it('never re-emits the original local part or a raw @-joined address', () => {
    const out = maskEmail('mike-3-20022001@hotmail.com');
    expect(out).toBe('m***@hotmail.com');
    expect(out).not.toContain('mike-3-20022001');
  });

  it('preserves the domain byte-for-byte (support/ops still need to see which domain)', () => {
    expect(maskEmail('x@sub.driftstack.dev')).toBe('x***@sub.driftstack.dev');
  });

  it('masks a single-character local part (still 1 char + ***)', () => {
    expect(maskEmail('q@example.com')).toBe('q***@example.com');
  });

  it('falls back to a wholesale redaction for malformed input (no @, empty local/domain)', () => {
    expect(maskEmail('not-an-email')).toBe('[redacted-email]');
    expect(maskEmail('@example.com')).toBe('[redacted-email]'); // empty local part
    expect(maskEmail('user@')).toBe('[redacted-email]'); // empty domain
  });

  it('handles empty / non-string input defensively', () => {
    expect(maskEmail('')).toBe('');
    // @ts-expect-error — defensive runtime guard for a non-string.
    expect(maskEmail(undefined)).toBe(undefined);
  });
});

describe('email.ts call sites never log a raw customer email', () => {
  const config = {
    apiToken: 'token',
    from: 'no-reply@driftstack.dev',
    replyTo: 'support@driftstack.dev',
  };

  function makeStubClient(): PostmarkSendApi {
    return { sendEmail: () => Promise.resolve({}) };
  }

  it('"email sent" log masks the `to` field on a successful send', async () => {
    const logger = makeSpyLogger();
    const svc = createEmailService({ config, logger, client: makeStubClient() });
    await svc.sendSignupVerification({
      to: 'victim@example.com',
      link: 'https://x',
      expiresAt: new Date('2026-05-03T12:00:00Z'),
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'v***@example.com' }),
      'email sent',
    );
    expect(loggedRawEmail(logger, 'victim@example.com')).toBe(false);
  });

  it('"email send failed" log masks the `to` field on a failed send', async () => {
    const logger = makeSpyLogger();
    const failingClient: PostmarkSendApi = {
      sendEmail: () => Promise.reject(new Error('boom')),
    };
    const svc = createEmailService({ config, logger, client: failingClient });
    await svc.sendSignupVerification({
      to: 'victim@example.com',
      link: 'https://x',
      expiresAt: new Date('2026-05-03T12:00:00Z'),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'v***@example.com' }),
      'email send failed (fire-and-forget)',
    );
    expect(loggedRawEmail(logger, 'victim@example.com')).toBe(false);
  });
});

describe('auth-flows.ts call sites never log a raw customer email', () => {
  function makeService(logger: Logger): AuthFlowsService {
    const email = createEmailService({ config: null, logger });
    return new AuthFlowsService(new InMemoryAuthFlowsRepo(), email, logger, {
      verifyEmailUrl: 'https://app.driftstack.local/auth/verify-email',
      magicLinkUrl: 'https://app.driftstack.local/auth/magic-link',
      passwordResetUrl: 'https://app.driftstack.local/auth/password-reset',
      exposeDebugToken: true,
    });
  }

  it('magic-link "unknown email" no-op log masks the `email` field', async () => {
    const logger = makeSpyLogger();
    const svc = makeService(logger);
    await svc.requestMagicLink({ email: 'victim@example.com', requestedFromIp: '127.0.0.1' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'v***@example.com' }),
      'magic-link requested for unknown email — no-op',
    );
    expect(loggedRawEmail(logger, 'victim@example.com')).toBe(false);
  });

  it('password-reset "unknown email" no-op log masks the `email` field', async () => {
    const logger = makeSpyLogger();
    const svc = makeService(logger);
    await svc.requestPasswordReset({ email: 'victim@example.com', requestedFromIp: '127.0.0.1' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'v***@example.com' }),
      'password-reset requested for unknown email — no-op',
    );
    expect(loggedRawEmail(logger, 'victim@example.com')).toBe(false);
  });
});

describe('incident-notifications.ts call site never logs a raw customer email', () => {
  it('per-recipient send-failure log masks the `email` field', async () => {
    const logger = makeSpyLogger();
    const subscribers = {
      listConfirmed: () =>
        Promise.resolve([
          {
            id: 'sub-1',
            email: 'victim@example.com',
            confirmTokenHash: null,
            confirmExpiresAt: null,
            confirmedAt: new Date('2026-01-01T00:00:00Z'),
            unsubscribeTokenHash: 'hash',
            unsubscribedAt: null,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      rotateUnsubscribeToken: () => Promise.resolve('unsub-plaintext'),
    } as unknown as StatusSubscribersService;
    // A no-op EmailService (config: null) satisfies the full interface;
    // override just the one method under test to reject, to exercise the
    // fan-out failure branch (logger.warn) in isolation.
    const noopEmail = createEmailService({ config: null, logger });
    const failingEmail: EmailService = {
      ...noopEmail,
      sendStatusIncidentNotification: () => Promise.reject(new Error('postmark down')),
    };
    const svc = new IncidentNotificationsService(subscribers, failingEmail, logger, {
      statusPageBaseUrl: 'https://status.driftstack.dev',
    });
    await svc.notifyCreated(
      {
        id: 'inc-1',
        title: 'API degraded',
        description: 'desc',
        severity: 'major',
        status: 'investigating',
        affectedComponents: ['api'],
        public: true,
        startedAt: new Date('2026-01-02T00:00:00Z'),
        resolvedAt: null,
        createdByAdminId: null,
        createdByAdminKeyId: null,
        autoProbeTarget: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        id: 'upd-1',
        incidentId: 'inc-1',
        message: 'investigating',
        status: 'investigating',
        postedByAdminId: null,
        postedByAdminKeyId: null,
        postedAt: new Date('2026-01-02T00:00:00Z'),
      },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'v***@example.com' }),
      'incident notification email failed',
    );
    expect(loggedRawEmail(logger, 'victim@example.com')).toBe(false);
  });
});
