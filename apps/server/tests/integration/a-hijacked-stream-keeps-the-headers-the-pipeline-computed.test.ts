// A hijacked stream carries what the pipeline already decided.
//
// `GET /v1/account/me/notifications` calls `reply.hijack()` and writes its own
// headers with `reply.raw.writeHead`. That hands the socket to the route, so
// Fastify never flushes its header store and no `onSend` hook runs. Every
// header decided upstream is computed and then dropped on the floor.
//
// The route already knew this about ONE hook. There is a comment on the CORS
// line saying the hijack bypasses `@fastify/cors`'s onSend hook, so it sets
// Access-Control-Allow-Origin by hand. The same reasoning was never carried to
// the rest, and two things went missing:
//
//   x-request-id      set by an onSend hook. So the one response a customer is
//                     most likely to report — a long-lived stream that dropped,
//                     which is exactly the failure that is hard to reproduce —
//                     was the only one with no id to quote to support.
//   rate-limit set    this route runs `app.rateLimit('global')`, so the request
//                     spends a real bucket token. The limiter wrote
//                     remaining/limit/reset onto the reply and the hijack
//                     discarded them, leaving the client blind to a bucket it
//                     is actually paying into.
//
// MEASURED before fixing, by diffing a live stream's headers against an
// ordinary response from the same app: twelve names differed, and after
// discounting the ones that legitimately cannot appear on a stream
// (`content-length`) or that differed only because the comparison used two
// transports, the eight above were the real loss.
//
// This test drives a REAL socket. `app.inject` cannot see a hijacked reply —
// light-my-request never gets the completion the route no longer sends — so the
// app is listened on an ephemeral port and the stream opened with fetch, read
// for its headers, then aborted. That is more machinery than an inject-based
// test, and it is the only way to observe the thing that was broken.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) {
    try {
      await fx.app.close();
    } catch {
      // Already closed by the test body; cleanup below is what matters.
    }
    await fx.cleanup();
  }
});

interface Probe {
  status: number;
  streamHeaders: Record<string, string>;
  plainHeaders: Record<string, unknown>;
}

/** Opens the SSE stream over a real socket and returns its response headers. */
async function probeStream(): Promise<Probe> {
  fx = await buildTestApp({ tier: 'api_builder' });
  await fx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = fx.app.server.address() as { port: number };

  const abort = new AbortController();
  try {
    const res = await fetch(
      `http://127.0.0.1:${String(address.port)}/v1/account/me/notifications`,
      { headers: { authorization: `Bearer ${fx.plaintext}` }, signal: abort.signal },
    );
    const streamHeaders = Object.fromEntries(res.headers.entries());

    const plain = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    return { status: res.status, streamHeaders, plainHeaders: plain.headers };
  } finally {
    abort.abort();
  }
}

describe('a hijacked stream keeps the headers the pipeline computed', () => {
  it('CRITICAL the probe actually opened the STREAM. Every assertion below reads headers off this response, and a 404 or a 401 would carry x-request-id perfectly well through the ordinary send path — reporting the hijack fixed while never exercising it. An earlier version of this probe hit a mistyped URL and measured exactly that.', async () => {
    const probe = await probeStream();
    expect(probe.status, 'the stream opened').toBe(200);
    expect(probe.streamHeaders['content-type'], 'and it is the event stream').toMatch(
      /text\/event-stream/,
    );
  }, 60_000);

  it('CRITICAL the stream carries a request id. This is the response a customer is most likely to bring to support — a long-lived connection that dropped — and it was the only one with no correlation id on it.', async () => {
    const probe = await probeStream();
    expect(probe.streamHeaders['x-request-id'], 'the stream has a request id').toBeDefined();
    expect(
      String(probe.streamHeaders['x-request-id']).length,
      'and it is non-empty',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('CRITICAL the stream reports the rate-limit bucket it just spent from. The route runs app.rateLimit(global), so the connection costs a real token; without these the client pays into a bucket it cannot see, and finds out at the refusal.', async () => {
    const probe = await probeStream();
    for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'ratelimit-limit']) {
      expect(probe.streamHeaders[name], `${name} is present`).toBeDefined();
    }
    const remaining = Number(probe.streamHeaders['x-ratelimit-remaining']);
    expect(Number.isFinite(remaining), 'remaining is numeric').toBe(true);
    expect(remaining, 'and non-negative').toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('CRITICAL the stream is not missing headers an ordinary response gets. The specific names above are the ones that went missing this time; this arm compares the SETS, so a future onSend hook whose output the hijack drops fails here even though nothing in this file names it.', async () => {
    const probe = await probeStream();
    const stream = new Set(Object.keys(probe.streamHeaders).map((h) => h.toLowerCase()));
    const plain = new Set(Object.keys(probe.plainHeaders).map((h) => h.toLowerCase()));

    // Legitimately absent from a stream, or an artefact of comparing a real
    // socket against inject rather than a real difference in what is set:
    //   content-length  a stream has no length
    //   vary / CORS     negotiated per request; the probe sends no Origin,
    //                   and inject and fetch differ in what they echo
    const EXPECTED_ABSENT = new Set([
      'content-length',
      'vary',
      'access-control-allow-credentials',
      'access-control-expose-headers',
    ]);

    const missing = [...plain].filter((h) => !stream.has(h) && !EXPECTED_ABSENT.has(h)).sort();
    expect(
      missing,
      'header(s) an ordinary response carries that the hijacked stream lost:',
    ).toEqual([]);
  }, 60_000);
});
