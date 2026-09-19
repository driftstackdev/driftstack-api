// A Stop that could not be confirmed is tellable from AI not being enabled.
//
// `POST /v1/agent-sessions/{id}/stop` can answer 503 `feature-unavailable` for
// two unrelated reasons:
//
//   - AI is not enabled on this deployment. Calling again changes nothing.
//   - the stop could not be CONFIRMED just now: whether a turn is running could
//     not be established, so neither "stopped" nor "nothing to stop" would be
//     true. Calling again is exactly what a program should do — the agent may
//     still be working on the page.
//
// Same status, same type, and until now only the sentence told them apart. The
// second case now carries `stop_unconfirmed: true`. ADDITIVE: the type and the
// status are unchanged, so every released SDK raises what it always raised
// (FeatureUnavailableError) and a program reads the flag from the error's
// extension fields.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  stop_unconfirmed?: boolean;
}

describe('a Stop that could not be confirmed is tellable from AI not being enabled', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fx) await fx.cleanup();
  });

  const stop = (id: string) =>
    fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/stop`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });

  it('CRITICAL when the stop could not be confirmed, the 503 carries stop_unconfirmed: true, with the type, status and sentence it always had', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    vi.spyOn(AgentRuntime.prototype, 'requestTurnStop').mockRejectedValue(
      new Error('could not be asked in time'),
    );

    const res = await stop(id);
    expect(res.statusCode).toBe(503);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.FeatureUnavailable);
    expect(body.title).toBe('Feature unavailable');
    expect(body.detail).toBe('We could not confirm the stop just now. Try again in a moment.');
    expect(body.stop_unconfirmed).toBe(true);
    // It never claims either outcome it could not establish.
    expect(res.body).not.toMatch(/no_turn_running|stop_requested/);
  });

  it('when AI is not enabled, the 503 is the same type and carries no stop_unconfirmed: calling again would change nothing', async () => {
    fx = await buildTestApp({});
    const res = await stop('agt_00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(503);
    const body = res.json<Problem>();
    expect(body.type).toBe(PROBLEM_TYPES.FeatureUnavailable);
    expect(body).not.toHaveProperty('stop_unconfirmed');
  });

  it('a stop that WAS confirmed is unchanged: 200 no_turn_running with no extra field', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await stop(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'no_turn_running', session_id: id });
  });
});
