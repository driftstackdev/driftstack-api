// V-304a — first-session-success email orchestration tests.
//
// First successful session.destroyed (which translates to a webhook
// session.completed event) triggers the once-per-account activation
// email. Subsequent successful sessions don't email — the dashboard
// + webhooks take over.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

async function createAndDestroySession(fixture: TestAppFixture): Promise<void> {
  const create = await fixture.app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { ...headers, authorization: `Bearer ${fixture.plaintext}` },
    payload: {},
  });
  expect(create.statusCode).toBe(201);
  const sessionId = create.json<{ id: string }>().id;
  const destroy = await fixture.app.inject({
    method: 'DELETE',
    url: `/v1/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${fixture.plaintext}` },
  });
  expect(destroy.statusCode).toBe(204);
}

describe('Session-success-first email lifecycle', () => {
  it('fires session-success-first on the FIRST successful session', async () => {
    fx = await buildTestApp();
    const before = fx.emailSends.length;

    await createAndDestroySession(fx);

    const after = fx.emailSends.slice(before);
    const firstSuccess = after.filter((s) => s.template === 'session-success-first');
    expect(firstSuccess).toHaveLength(1);
  });

  it('does NOT fire on the second successful session (dedup)', async () => {
    fx = await buildTestApp();

    await createAndDestroySession(fx);
    const between = fx.emailSends.length;
    await createAndDestroySession(fx);

    const after = fx.emailSends.slice(between);
    expect(after.filter((s) => s.template === 'session-success-first')).toHaveLength(0);
  });

  it('marks firstSuccessEmailSentAt on the lifecycle row', async () => {
    fx = await buildTestApp();
    expect(fx.accountLifecycleRepo.read(fx.accountId)?.firstSuccessEmailSentAt).toBeNull();

    await createAndDestroySession(fx);

    const row = fx.accountLifecycleRepo.read(fx.accountId);
    expect(row?.firstSuccessEmailSentAt).not.toBeNull();
  });
});
