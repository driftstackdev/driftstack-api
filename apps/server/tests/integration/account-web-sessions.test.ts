// V-355 — integration tests for /v1/account/web-sessions list + revoke.
//
// These exercise the customer-dashboard "Active sign-ins" surface:
// listing the calling account's active web sessions, revoking one by
// id, and bulk-revoking everything except the caller's current session.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface SignupResponse {
  verification_email_expires_at: string;
  debug_token?: string;
}

interface SessionEnvelope {
  session: { token: string; expires_at: string; account_id: string };
}

interface ListWebSessionsResponse {
  data: Array<{
    id: string;
    os: string;
    browser: string;
    last_used_at: string;
    expires_at: string;
    current: boolean;
  }>;
}

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

async function signupVerifyAndSession(
  fixture: TestAppFixture,
  email: string,
  password: string,
  userAgent: string,
): Promise<{ token: string; sessionId: string }> {
  const signup = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    headers: { 'user-agent': userAgent },
    payload: { email, password },
  });
  const token = signup.json<SignupResponse>().debug_token;
  if (!token) throw new Error('debug_token missing — fixture should expose it');
  const verify = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    headers: { 'user-agent': userAgent },
    payload: { token },
  });
  expect(verify.statusCode).toBe(200);
  const session = verify.json<SessionEnvelope>().session;
  return { token: session.token, sessionId: session.account_id };
}

async function loginAgain(
  fixture: TestAppFixture,
  email: string,
  password: string,
  userAgent: string,
): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'user-agent': userAgent },
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json<SessionEnvelope>().session.token;
}

describe('GET /v1/account/web-sessions (V-355)', () => {
  it("200 lists the caller's active sessions with current marked", async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'lister@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15',
    );
    // A second sign-in from a different UA so we can confirm both rows
    // appear.
    await loginAgain(
      fx,
      'lister@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
    );

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<ListWebSessionsResponse>();
    expect(body.data.length).toBe(2);

    const current = body.data.filter((d) => d.current);
    expect(current.length).toBe(1);
    expect(current[0]?.os).toBe('macOS');
    expect(current[0]?.browser).toBe('Safari');

    const other = body.data.find((d) => !d.current);
    expect(other?.os).toBe('Windows');
    expect(other?.browser).toBe('Chrome');

    // ids should be `wsess_`-prefixed.
    expect(body.data.every((d) => d.id.startsWith('wsess_'))).toBe(true);
  });

  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /v1/account/web-sessions/:id (V-355)', () => {
  it('204 revokes a session and removes it from subsequent list', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'revoker@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );
    await loginAgain(
      fx,
      'revoker@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Windows) Chrome',
    );

    const list1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${a.token}` },
    });
    const other = list1.json<ListWebSessionsResponse>().data.find((d) => !d.current);
    expect(other).toBeDefined();

    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/web-sessions/${other!.id}`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(del.statusCode).toBe(204);

    const list2 = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(list2.json<ListWebSessionsResponse>().data.length).toBe(1);

    // The revocation is audited (account.web_session_revoked, security-relevant).
    const log = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/audit-log?action=account.web_session_revoked&limit=10',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(log.statusCode).toBe(200);
    const entries = log.json<{
      data: Array<{ action: string; target_resource_id: string | null }>;
    }>().data;
    expect(entries.some((e) => e.target_resource_id === other!.id)).toBe(true);
  });

  it('400 on malformed id', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'badid@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/web-sessions/not-an-id',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 when session belongs to a different account', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'a@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );
    const _b = await signupVerifyAndSession(
      fx,
      'b@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Windows) Chrome',
    );

    // Fetch B's session id via B's own token, then try to delete it
    // as A. Should 404 (we don't leak that the id exists at all).
    const bList = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${_b.token}` },
    });
    const bId = bList.json<ListWebSessionsResponse>().data[0]?.id;
    expect(bId).toBeDefined();

    const cross = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/account/web-sessions/${bId}`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(cross.statusCode).toBe(404);
  });
});

describe('DELETE /v1/account/web-sessions?keep=current (V-355)', () => {
  it('200 revokes every other session, keeps the current one alive', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'bulkrevoker@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );
    const otherToken = await loginAgain(
      fx,
      'bulkrevoker@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Windows) Chrome',
    );
    const yetAnother = await loginAgain(
      fx,
      'bulkrevoker@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Linux) Firefox',
    );

    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/web-sessions?keep=current',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ revoked: number }>();
    expect(body.revoked).toBe(2);

    // a.token still works.
    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<ListWebSessionsResponse>().data.length).toBe(1);

    // The other tokens are now revoked — auth-cache invalidation +
    // the underlying revocation row mean any next request 401s.
    for (const tok of [otherToken, yetAnother]) {
      const probe = await fx.app.inject({
        method: 'GET',
        url: '/v1/account/web-sessions',
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(probe.statusCode).toBe(401);
    }
  });

  // V-1368 — `keep` is read off request.query with no schema, and a repeated query key
  // parses to an ARRAY. `.toLowerCase()` is not a method on an array, so the confirmation
  // check throws a TypeError instead of comparing anything.
  it('CRITICAL a REPEATED ?keep is a 400, not a 500. The repeat parses to an array and the confirmation read calls .toLowerCase() on it; that is a TypeError surfacing as an internal error on a customer endpoint, for a request the route should simply refuse. Nothing is revoked either way — this is about answering correctly, not about the sessions.', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'dupkeep@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );
    await loginAgain(
      fx,
      'dupkeep@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Windows) Chrome',
    );

    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/web-sessions?keep=current&keep=current',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode, `repeated ?keep answered ${String(res.statusCode)}: ${res.body}`).toBe(
      400,
    );

    const list = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(
      list.json<ListWebSessionsResponse>().data.length,
      'a refused bulk revoke must leave both sessions alive',
    ).toBe(2);
  });

  it('CRITICAL the confirmation stays case-insensitive on a single value, so the fix above did not tighten what one ?keep may say', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'casekeep@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );
    await loginAgain(
      fx,
      'casekeep@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Windows) Chrome',
    );

    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/web-sessions?keep=CURRENT',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode, `?keep=CURRENT should still confirm: ${res.body}`).toBe(200);
    expect(res.json<{ revoked: number }>().revoked).toBe(1);
  });

  it('400 without ?keep=current to force explicit confirmation', async () => {
    fx = await buildTestApp();
    const a = await signupVerifyAndSession(
      fx,
      'noconfirm@driftstack.local',
      'correct horse battery staple',
      'Mozilla/5.0 (Macintosh) Safari',
    );

    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/web-sessions',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 when caller is API-key authed (no current web session)', async () => {
    fx = await buildTestApp();
    // The default fixture seeds an API key, NOT a web session. Calling
    // bulk-revoke on this auth path should refuse — there's no
    // "current" session to keep.
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/web-sessions?keep=current',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
