// Signing a device out — the routes that do it have no behavioural test.
//
// `routes/account-web-sessions.ts` is referenced by three test files and all
// three are source-text pins (content-parity + cross-source invariants). Nothing
// invokes these routes. They are the customer's own security controls: "sign out
// this device" and "sign out everywhere", reached from the dashboard by someone
// who often believes a session is compromised.
//
// Three properties carry the weight, and each is a guard against doing the WRONG
// amount of revoking:
//
//   ?keep=current required   a bare DELETE on the collection is refused with 400.
//                            The route's own words: "Pass it explicitly to
//                            confirm intent." Without it, any call that reaches
//                            the collection endpoint — a stray client retry, a
//                            copied curl, a dashboard bug — signs the customer
//                            out of every device at once.
//   no current → refuse      an API-key caller has no "current" session to keep,
//                            so bulk revoke is refused rather than guessed. The
//                            guess would be to revoke everything, which is
//                            exactly the outcome the parameter exists to make
//                            deliberate.
//   audit never blocks       the audit emit is wrapped so "audit failures must
//                            not break session revocation". This is the one that
//                            matters most in the moment it fires: a customer
//                            revoking what they think is a stolen session, while
//                            the audit store happens to be down, must still get
//                            the revocation.
//
// Also pinned: a malformed session id is a 400, not a 500. The id goes to a
// Postgres uuid column, and the route's own comment records that an earlier
// looser pattern passed junk straight through and 500'd.
//
// Driven through a lightweight Fastify harness with a stub service, because the
// audit-failure and no-current-session arms need dependencies that misbehave on
// demand — neither is reachable through the fully-wired fixture.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAccountWebSessionsRoutes } from '../../src/routes/account-web-sessions.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CURRENT_WEB_SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION = '33333333-3333-4333-8333-333333333333';

interface Calls {
  revokeOne: Array<{ accountId: string; sessionId: string }>;
  revokeAllExcept: Array<{ accountId: string; keepId: string }>;
  audits: number;
}

interface HarnessOpts {
  /** `wsk_`-prefixed key id ⇒ a dashboard web session. Anything else ⇒ API key. */
  apiKeyId?: string;
  revokeOneResult?: boolean;
  revokeAllResult?: number;
  auditThrows?: boolean;
  omitAudit?: boolean;
}

async function buildHarness(
  opts: HarnessOpts = {},
): Promise<{ app: FastifyInstance; calls: Calls }> {
  const calls: Calls = { revokeOne: [], revokeAllExcept: [], audits: 0 };
  const app: FastifyInstance = Fastify({ logger: false });
  registerErrorHandler(app);
  app.decorate('requireAuth', (request: { account?: unknown }) => {
    request.account = {
      account: { id: ACCOUNT_ID },
      apiKey: { id: opts.apiKeyId ?? `wsk_${CURRENT_WEB_SESSION}` },
      teams: [],
    };
    return Promise.resolve();
  });
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());

  const service = {
    listActiveWebSessions: () => Promise.resolve([]),
    revokeWebSessionForAccount: (accountId: string, sessionId: string) => {
      calls.revokeOne.push({ accountId, sessionId });
      return Promise.resolve(opts.revokeOneResult ?? true);
    },
    revokeAllWebSessionsExceptCurrent: (accountId: string, keepId: string) => {
      calls.revokeAllExcept.push({ accountId, keepId });
      return Promise.resolve(opts.revokeAllResult ?? 3);
    },
  };
  const accountAudit = {
    record: () => {
      calls.audits += 1;
      return opts.auditThrows === true
        ? Promise.reject(new Error('audit store unavailable'))
        : Promise.resolve();
    },
  };

  registerAccountWebSessionsRoutes(app, {
    service: service as unknown as never,
    ...(opts.omitAudit === true ? {} : { accountAudit: accountAudit as unknown as never }),
  });
  await app.ready();
  return { app, calls };
}

describe('web session revocation routes', () => {
  it('CRITICAL revoking one device returns 204 and revokes exactly that session', async () => {
    const { app, calls } = await buildHarness();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/account/web-sessions/wsess_${OTHER_SESSION}`,
      });
      expect(res.statusCode).toBe(204);
      expect(calls.revokeOne, 'the revocation did not reach the service').toEqual([
        { accountId: ACCOUNT_ID, sessionId: OTHER_SESSION },
      ]);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL a session the account does not own is a 404, not a silent success', async () => {
    const { app } = await buildHarness({ revokeOneResult: false });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/account/web-sessions/wsess_${OTHER_SESSION}`,
      });
      expect(
        res.statusCode,
        'the service refused the revocation but the route reported success — the customer is told a ' +
          'device was signed out when it was not',
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL a malformed session id is a 400, not a 500', async () => {
    const { app } = await buildHarness();
    try {
      // Reaches a Postgres uuid column; the route's comment records that an
      // earlier looser pattern let junk through and 500'd.
      expect(
        (await app.inject({ method: 'DELETE', url: '/v1/account/web-sessions/wsess_nope' }))
          .statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: 'DELETE', url: '/v1/account/web-sessions/raw-id' })).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL an audit failure never blocks the revocation', async () => {
    const { app, calls } = await buildHarness({ auditThrows: true });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/account/web-sessions/wsess_${OTHER_SESSION}`,
      });
      expect(
        res.statusCode,
        'the audit store being down blocked a session revocation. This is the moment it matters ' +
          'least to be strict: the customer is signing out what they believe is a stolen session',
      ).toBe(204);
      expect(calls.audits, 'the audit was never attempted').toBe(1);
      expect(calls.revokeOne).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL bulk revoke without ?keep=current is refused', async () => {
    const { app, calls } = await buildHarness();
    try {
      const res = await app.inject({ method: 'DELETE', url: '/v1/account/web-sessions' });
      expect(
        res.statusCode,
        'a bare DELETE on the collection signed the customer out everywhere. The parameter exists ' +
          'so that outcome is always deliberate',
      ).toBe(400);
      expect(calls.revokeAllExcept, 'the service was called despite the refusal').toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL bulk revoke from a non-web-session caller is refused rather than guessed', async () => {
    // An API key has no "current" dashboard session to keep. Guessing would mean
    // revoking everything — the exact outcome ?keep=current exists to make explicit.
    const { app, calls } = await buildHarness({ apiKeyId: 'apk_not_a_web_session' });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/account/web-sessions?keep=current',
      });
      expect(res.statusCode).toBe(400);
      expect(
        calls.revokeAllExcept,
        'a caller with no current session triggered a bulk revoke — with nothing to keep, that ' +
          'signs the customer out of every device',
      ).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL bulk revoke keeps the calling session and reports the count', async () => {
    const { app, calls } = await buildHarness({ revokeAllResult: 4 });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/account/web-sessions?keep=current',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ revoked: number }>().revoked).toBe(4);
      expect(
        calls.revokeAllExcept,
        'the caller’s own session was not the one kept — a customer signing out other devices would ' +
          'be signed out too, from the very session they are using',
      ).toEqual([{ accountId: ACCOUNT_ID, keepId: CURRENT_WEB_SESSION }]);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL a bulk revoke that revoked nothing emits no audit row', async () => {
    const { app, calls } = await buildHarness({ revokeAllResult: 0 });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/account/web-sessions?keep=current',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ revoked: number }>().revoked).toBe(0);
      expect(
        calls.audits,
        'an audit row claimed a revocation that did not happen — the audit log is what an incident ' +
          'review reads',
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('CRITICAL revocation works with no audit service wired at all', async () => {
    const { app } = await buildHarness({ omitAudit: true });
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/account/web-sessions/wsess_${OTHER_SESSION}`,
      });
      expect(res.statusCode, 'an unwired audit dependency broke the revocation path').toBe(204);
    } finally {
      await app.close();
    }
  });
});
