// Security regression coverage for the mixed-resource account notification
// stream. Authentication alone is insufficient: a key scoped to one resource
// must not see billing, audit, incident, and session events from the shared
// per-account bus. Rejected requests must terminate before SSE headers/socket
// hijacking, including when browser EventSource uses the ds_token fallback.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const notifications = (fixture: TestAppFixture, queryToken = false) =>
  fixture.app.inject({
    method: 'GET',
    url: queryToken
      ? `/v1/account/me/notifications?ds_token=${encodeURIComponent(fixture.plaintext)}`
      : '/v1/account/me/notifications',
    ...(queryToken ? {} : { headers: { authorization: `Bearer ${fixture.plaintext}` } }),
  });

describe('broad read floor on GET /v1/account/me/notifications', () => {
  it.each(['read:sessions', 'read:webhooks', 'write', 'write:sessions'] as const)(
    '403 for unrelated/insufficient scope %s before opening SSE',
    async (scope) => {
      fx = await buildTestApp({ scopes: [scope] });
      const res = await notifications(fx);

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
      expect(res.json<{ detail: string }>().detail).toBe('This action requires the "read" scope.');
    },
  );

  it('applies the same broad-read floor to the EventSource ds_token fallback', async () => {
    fx = await buildTestApp({ scopes: ['read:webhooks'] });
    const res = await notifications(fx, true);

    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type'] ?? '').not.toContain('text/event-stream');
    expect(res.json<{ detail: string }>().detail).toBe('This action requires the "read" scope.');
  });
});
