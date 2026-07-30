import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import type { LoginResult } from '../../src/drivers/types.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx !== undefined) await fx.cleanup();
  fx = undefined;
});

function auth(fixture: TestAppFixture): { authorization: string } {
  return { authorization: `Bearer ${fixture.plaintext}` };
}

async function createSession(fixture: TestAppFixture): Promise<string> {
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: auth(fixture),
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ id: string }>().id;
}

function makeRealLoginTestDouble(fixture: TestAppFixture, result: unknown): void {
  // Every shipped Driver deliberately declares a non-real capability. This is
  // the sole explicit test-only double that opts into the future FleetDriver
  // contract so HTTP result-shape coverage cannot accidentally activate mock.
  Object.defineProperty(fixture.driver, 'loginCapability', {
    configurable: true,
    value: 'real',
  });
  vi.spyOn(fixture.driver, 'login').mockResolvedValueOnce(result as LoginResult);
}

describe('POST /v1/sessions/:id/login — fail-closed capability', () => {
  it.each([
    ['simulation', false],
    ['missing', true],
  ] as const)(
    'returns 503 for %s capability before lookup, claim, driver call, or event',
    async (_label, removeCapability) => {
      fx = await buildTestApp();
      const sessionId = await createSession(fx);
      if (removeCapability) {
        Object.defineProperty(fx.driver, 'loginCapability', {
          configurable: true,
          value: undefined,
        });
      }
      const rawSessionId = sessionId.replace(/^ses_/, '');
      const rowBefore = await fx.sessionsRepo.findSession(rawSessionId, fx.accountId);
      expect(rowBefore).not.toBeNull();
      const lookup = vi.spyOn(fx.sessionsRepo, 'findSession');
      const claim = vi.spyOn(fx.sessionsRepo, 'claimSessionOperation');
      const settle = vi.spyOn(fx.sessionsRepo, 'settleSessionOperation');
      const fail = vi.spyOn(fx.sessionsRepo, 'failSessionOperation');
      const updateStatus = vi.spyOn(fx.sessionsRepo, 'updateSessionStatus');
      const touchLastState = vi.spyOn(fx.sessionsRepo, 'touchSessionLastStateAt');
      const recordEvent = vi.spyOn(fx.sessionsRepo, 'recordEvent');
      const login = vi.spyOn(fx.driver, 'login');
      const webhook = vi.spyOn(fx.webhooksService, 'enqueueEvent');
      const notification = vi.spyOn(fx.notificationEventBus, 'publish');
      const customerAudit = vi.spyOn(fx.accountAuditRepo, 'insert');
      const eventsBefore = fx.sessionsRepo.getEvents();
      const customerAuditsBefore = fx.accountAuditRepo.getAll();

      const response = await fx.app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/login`,
        headers: auth(fx),
        payload: { username: 'user@example.com', password: 'never-submit' },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json<{ type: string }>().type).toBe(PROBLEM_TYPES.DriverNotIntegrated);
      expect(lookup).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(settle).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(touchLastState).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalled();
      expect(login).not.toHaveBeenCalled();
      expect(webhook).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
      expect(customerAudit).not.toHaveBeenCalled();
      expect(fx.sessionsRepo.getEvents()).toEqual(eventsBefore);
      expect(fx.accountAuditRepo.getAll()).toEqual(customerAuditsBefore);
      const rowAfter = await fx.sessionsRepo.findSession(rawSessionId, fx.accountId);
      expect(rowAfter).toMatchObject({
        status: 'ready',
        updatedAt: rowBefore?.updatedAt,
        lastStateAt: rowBefore?.lastStateAt,
        destroyedAt: rowBefore?.destroyedAt,
      });
    },
  );

  it.each<{
    label: string;
    driverResult: LoginResult;
    wireResult: Record<string, unknown>;
  }>([
    {
      label: 'submitted assessment',
      driverResult: {
        submitted: true,
        credentialsTruncated: false,
        loggedIn: false,
        postLoginUrl: 'https://example.com/login?error=1',
        durationMs: 599_999,
      },
      wireResult: {
        submitted: true,
        credentials_truncated: false,
        logged_in: false,
        post_login_url: 'https://example.com/login?error=1',
        duration_ms: 599_999,
      },
    },
    {
      label: 'zero-submit truncation',
      driverResult: {
        submitted: false,
        credentialsTruncated: true,
        loggedIn: false,
        durationMs: 600_000,
      },
      wireResult: {
        submitted: false,
        credentials_truncated: true,
        logged_in: false,
        duration_ms: 600_000,
      },
    },
  ])('returns the exact $label branch only for a real-capability double', async (testCase) => {
    fx = await buildTestApp();
    const sessionId = await createSession(fx);
    makeRealLoginTestDouble(fx, testCase.driverResult);

    const response = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/login`,
      headers: auth(fx),
      payload: { username: 'user@example.com', password: 'never-echo' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toEqual(testCase.wireResult);
    expect(response.body).not.toContain('user@example.com');
    expect(response.body).not.toContain('never-echo');
  });

  it.each([
    {
      label: 'contradictory submission flags',
      result: {
        submitted: true,
        credentialsTruncated: true,
        loggedIn: true,
        durationMs: 1,
      },
    },
    {
      label: 'URL on a zero-submit refusal',
      result: {
        submitted: false,
        credentialsTruncated: true,
        loggedIn: false,
        postLoginUrl: 'https://hostile.example/should-not-survive',
        durationMs: 1,
      },
    },
    {
      label: 'missing assessment field',
      result: { submitted: true, credentialsTruncated: false, durationMs: 1 },
    },
    {
      label: 'negative duration',
      result: {
        submitted: true,
        credentialsTruncated: false,
        loggedIn: true,
        durationMs: -1,
      },
    },
    {
      label: 'duration beyond the producer deadline',
      result: {
        submitted: true,
        credentialsTruncated: false,
        loggedIn: true,
        durationMs: 600_001,
      },
    },
    {
      label: 'unknown credential-shaped field',
      result: {
        submitted: true,
        credentialsTruncated: false,
        loggedIn: true,
        durationMs: 1,
        password: 'must-not-reflect',
      },
    },
  ])('rejects a hostile real-driver result: $label', async ({ result }) => {
    fx = await buildTestApp();
    const sessionId = await createSession(fx);
    const rawSessionId = sessionId.replace(/^ses_/, '');
    makeRealLoginTestDouble(fx, result);
    const destroy = vi.spyOn(fx.driver, 'destroy');

    const response = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/login`,
      headers: auth(fx),
      payload: { username: 'user@example.com', password: 'never-reflect' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json<{ type: string }>().type).toBe(PROBLEM_TYPES.DriverError);
    expect(response.body).not.toContain('user@example.com');
    expect(response.body).not.toContain('never-reflect');
    expect(response.body).not.toContain('must-not-reflect');
    expect(response.body).not.toContain('hostile.example');
    expect(await fx.sessionsRepo.findSession(rawSessionId, fx.accountId)).toMatchObject({
      status: 'errored',
      destroyedAt: expect.any(Date),
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(fx.sessionsRepo.getEvents().filter((event) => event.type === 'errored')).toHaveLength(1);
    expect(
      fx.sessionsRepo
        .getEvents()
        .filter((event) => event.type !== 'created' && event.type !== 'errored'),
    ).toEqual([]);
  });
});
