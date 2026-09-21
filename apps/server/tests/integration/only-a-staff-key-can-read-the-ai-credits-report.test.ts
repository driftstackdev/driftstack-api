// The AI-credits shadow report and cutover census — who may read them, and
// whether they exist at all.
//
// Both are staff surfaces over a feature customers have not been told about.
// Two things follow, and the second is the one easy to miss:
//
//   · an ordinary customer key is refused, and the refusal carries none of the
//     numbers — a 403 that leaked the cohort counts would be the disclosure the
//     gate exists to prevent;
//   · with `DRIFTSTACK_AI_CREDITS_MODE` off the routes are NOT REGISTERED. Not
//     "registered and refusing": a 403 from a path says the path is there, and a
//     dark feature should not answer for a surface it has nothing to say about.
//     The production default is off, so this is the posture on every deployment
//     today.

import { afterEach, describe, expect, it } from 'vitest';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture | null = null;

afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

const REPORT = '/v1/admin/ai-credits/shadow-report';
const CENSUS = '/v1/admin/ai-credits/census';

const CENSUS_ANSWER = {
  cohorts: [
    { cohort: 'C0' as const, accounts: 3, alreadyMoved: 1 },
    { cohort: 'C1' as const, accounts: 0, alreadyMoved: 0 },
    { cohort: 'C2' as const, accounts: 0, alreadyMoved: 0 },
    { cohort: 'C3' as const, accounts: 0, alreadyMoved: 0 },
    { cohort: 'C4' as const, accounts: 0, alreadyMoved: 0 },
  ],
  accounts: 3,
  alreadyMoved: 1,
};

/**
 * A credits runtime whose report answers from memory.
 *
 * The SQL is proved against a real database by its own two files; what is under
 * test here is the route — its gate, its window parsing, and whether it exists.
 */
function creditsRuntime(): AiCreditsRuntime {
  const unused = <T>(): Promise<T> =>
    Promise.reject(new Error('the credits route must not reach the turn path'));
  return {
    mode: 'shadow',
    bootId: 'boot-admin-route-test',
    reservations: {
      reserve: unused,
      settle: unused,
      planCall: unused,
      admitCall: unused,
      markSent: unused,
      settleCall: unused,
    },
    leaseKeeper: { add: () => undefined, remove: () => undefined, liveCount: () => 0 },
    report: {
      shadowReport: (args) =>
        Promise.resolve({
          window: { since: args.since.toISOString(), until: args.until.toISOString() },
          markup: 2,
          rows: [],
          wouldRefuse: [],
        }),
      census: () => Promise.resolve(CENSUS_ANSWER),
    },
  };
}

describe('only a staff key can read the AI-credits report', () => {
  for (const url of [REPORT, CENSUS]) {
    it(`CRITICAL ${url} refuses an unauthenticated caller with 401`, async () => {
      fx = await buildTestApp({ aiCredits: creditsRuntime() });
      const res = await fx.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain('cohort');
      expect(res.body).not.toContain('markup');
    });

    it(`CRITICAL ${url} refuses a valid ordinary customer key with 403, and leaks nothing in the refusal`, async () => {
      fx = await buildTestApp({ aiCredits: creditsRuntime(), scopes: ['read', 'write'] });
      const res = await fx.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain('cohort');
      expect(res.body).not.toContain('markup');
      expect(res.body).not.toContain('C0');
    });

    it(`CRITICAL with the mode off, ${url} does not exist — the route is not registered, so it 404s rather than announcing itself with a 403`, async () => {
      fx = await buildTestApp({});
      const res = await fx.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(404);
    });
  }

  it('serves the census to a staff key', async () => {
    fx = await buildTestApp({ aiCredits: creditsRuntime() });
    const res = await fx.app.inject({
      method: 'GET',
      url: CENSUS,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(CENSUS_ANSWER);
  });

  it('the shadow report’s window is the one the caller asked for, in days', async () => {
    fx = await buildTestApp({ aiCredits: creditsRuntime() });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${REPORT}?window_days=3`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ window: { since: string; until: string }; markup: number }>();
    const spanDays =
      (Date.parse(body.window.until) - Date.parse(body.window.since)) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBe(3);
    expect(body.markup).toBe(2);
  });

  it('CRITICAL a window wider than the report will scan is refused, rather than silently answering about a narrower one. A number whose label says 90 days and whose value covers 7 is worse than an error.', async () => {
    fx = await buildTestApp({ aiCredits: creditsRuntime() });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${REPORT}?window_days=90`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('window_days');
  });
});
