import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import type { SearchResult } from '../../src/drivers/types.js';
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

function makeRealSearchTestDouble(fixture: TestAppFixture, result: unknown): void {
  Object.defineProperty(fixture.driver, 'searchCapability', {
    configurable: true,
    value: 'real',
  });
  vi.spyOn(fixture.driver, 'search').mockResolvedValueOnce(result as SearchResult);
}

describe('POST /v1/sessions/:id/search — fail-closed capability', () => {
  it.each([
    ['simulation', false],
    ['missing', true],
  ] as const)(
    'returns 503 for %s capability before lookup, claim, driver call, or event',
    async (_label, removeCapability) => {
      fx = await buildTestApp();
      const sessionId = await createSession(fx);
      if (removeCapability) {
        Object.defineProperty(fx.driver, 'searchCapability', {
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
      const search = vi.spyOn(fx.driver, 'search');
      const webhook = vi.spyOn(fx.webhooksService, 'enqueueEvent');
      const notification = vi.spyOn(fx.notificationEventBus, 'publish');
      const customerAudit = vi.spyOn(fx.accountAuditRepo, 'insert');
      const eventsBefore = fx.sessionsRepo.getEvents();
      const customerAuditsBefore = fx.accountAuditRepo.getAll();

      const response = await fx.app.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/search`,
        headers: auth(fx),
        payload: { query: 'driftstack' },
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
      expect(search).not.toHaveBeenCalled();
      expect(webhook).not.toHaveBeenCalled();
      expect(notification).not.toHaveBeenCalled();
      expect(customerAudit).not.toHaveBeenCalled();
      expect(fx.sessionsRepo.getEvents()).toEqual(eventsBefore);
      expect(fx.accountAuditRepo.getAll()).toEqual(customerAuditsBefore);
      expect(await fx.sessionsRepo.findSession(rawSessionId, fx.accountId)).toMatchObject({
        status: 'ready',
        updatedAt: rowBefore?.updatedAt,
        lastStateAt: rowBefore?.lastStateAt,
        destroyedAt: rowBefore?.destroyedAt,
      });
    },
  );

  it('rejects a query beyond the exact 10,000-character public bound before claim', async () => {
    fx = await buildTestApp();
    const sessionId = await createSession(fx);
    const claim = vi.spyOn(fx.sessionsRepo, 'claimSessionOperation');
    const search = vi.spyOn(fx.driver, 'search');

    const response = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/search`,
      headers: auth(fx),
      payload: { query: 'q'.repeat(10_001) },
    });

    expect(response.statusCode).toBe(400);
    expect(claim).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each<{
    label: string;
    driverResult: SearchResult;
    wireResult: Record<string, unknown>;
    payload?: Record<string, unknown>;
  }>([
    {
      label: 'normal submitted assessment',
      driverResult: {
        submitted: true,
        queryTruncated: false,
        resultsVisible: false,
        durationMs: 599_999,
      },
      wireResult: {
        submitted: true,
        query_truncated: false,
        results_visible: false,
        duration_ms: 599_999,
      },
      payload: { query: 'driftstack', wait_for_results_selector: '#results' },
    },
    {
      label: 'zero-submit truncation',
      driverResult: {
        submitted: false,
        queryTruncated: true,
        durationMs: 600_000,
      },
      wireResult: {
        submitted: false,
        query_truncated: true,
        duration_ms: 600_000,
      },
    },
  ])('returns the exact $label branch only for a real-capability double', async (testCase) => {
    fx = await buildTestApp();
    const sessionId = await createSession(fx);
    makeRealSearchTestDouble(fx, testCase.driverResult);

    const response = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/search`,
      headers: auth(fx),
      payload: testCase.payload ?? { query: 'driftstack' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toEqual(testCase.wireResult);
    expect(response.body).not.toContain('driftstack');
  });

  it.each([
    {
      label: 'contradictory submission flags',
      result: { submitted: true, queryTruncated: true, durationMs: 1 },
    },
    {
      label: 'visibility on a zero-submit refusal',
      result: {
        submitted: false,
        queryTruncated: true,
        resultsVisible: false,
        durationMs: 1,
      },
    },
    {
      label: 'missing truncation discriminator',
      result: { submitted: true, durationMs: 1 },
    },
    {
      label: 'negative duration',
      result: { submitted: true, queryTruncated: false, durationMs: -1 },
    },
    {
      label: 'duration beyond the producer deadline',
      result: { submitted: true, queryTruncated: false, durationMs: 600_001 },
    },
    {
      label: 'unknown query-shaped field',
      result: {
        submitted: true,
        queryTruncated: false,
        durationMs: 1,
        query: 'must-not-reflect',
      },
    },
    {
      label: 'submission result disagrees with the request',
      result: { submitted: false, queryTruncated: false, durationMs: 1 },
    },
    {
      label: 'visibility appears without a requested wait selector',
      result: {
        submitted: true,
        queryTruncated: false,
        resultsVisible: false,
        durationMs: 1,
      },
    },
    {
      label: 'visibility is missing for a requested wait selector',
      result: { submitted: true, queryTruncated: false, durationMs: 1 },
      payload: { query: 'never-reflect', wait_for_results_selector: '#results' },
    },
  ])('rejects a hostile real-driver result: $label', async ({ result, payload }) => {
    fx = await buildTestApp();
    const sessionId = await createSession(fx);
    const rawSessionId = sessionId.replace(/^ses_/, '');
    makeRealSearchTestDouble(fx, result);
    const destroy = vi.spyOn(fx.driver, 'destroy');

    const response = await fx.app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/search`,
      headers: auth(fx),
      payload: payload ?? { query: 'never-reflect' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json<{ type: string }>().type).toBe(PROBLEM_TYPES.DriverError);
    expect(response.body).not.toContain('never-reflect');
    expect(response.body).not.toContain('must-not-reflect');
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
