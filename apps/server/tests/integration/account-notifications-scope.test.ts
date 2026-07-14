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

  it('returns a correlated problem at connection 11 and reuses capacity after disconnect', async () => {
    fx = await buildTestApp();
    const address = await fx.app.listen({ host: '127.0.0.1', port: 0 });
    const controllers: AbortController[] = [];
    const streamResponses: Response[] = [];
    const authorization = `Bearer ${fx.plaintext}`;

    try {
      for (let i = 0; i < 10; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await fetch(`${address}/v1/account/me/notifications`, {
          headers: { authorization },
          signal: controller.signal,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        streamResponses.push(response);
      }

      const denied = await fetch(`${address}/v1/account/me/notifications`, {
        headers: { authorization, connection: 'close' },
      });
      expect(denied.status).toBe(429);
      expect(denied.headers.get('retry-after')).toBe('30');
      expect(denied.headers.get('content-type')).toContain('application/problem+json');
      const problem = (await denied.json()) as Record<string, unknown>;
      expect(problem).toMatchObject({
        type: 'https://errors.driftstack.dev/rate-limited',
        title: 'Too Many Requests',
        status: 429,
        detail: 'At most 10 concurrent notification streams are allowed per account.',
        retry_after_seconds: 30,
      });
      expect(problem['instance']).toBe(denied.headers.get('x-request-id'));

      controllers.shift()!.abort();

      let replacementAccepted = false;
      for (let attempt = 0; attempt < 20 && !replacementAccepted; attempt++) {
        const controller = new AbortController();
        const replacement = await fetch(`${address}/v1/account/me/notifications`, {
          headers: { authorization, connection: 'close' },
          signal: controller.signal,
        });
        if (replacement.status === 200) {
          controllers.push(controller);
          streamResponses.push(replacement);
          replacementAccepted = true;
        } else {
          controller.abort();
          await replacement.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(replacementAccepted).toBe(true);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled(
        streamResponses.map(async (response) => {
          await response.body?.cancel();
        }),
      );
    }
  });
});
