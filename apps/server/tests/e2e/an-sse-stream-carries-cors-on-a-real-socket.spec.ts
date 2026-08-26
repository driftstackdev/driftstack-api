// A hijacked SSE reply must carry Access-Control-Allow-Origin — asserted on a
// REAL SOCKET, because every existing guard on this reads source text.
//
// ⛔ THIS DEFECT HAS SHIPPED TWICE. `lib/cors-allow.ts` records the first:
// founder-reported on `/v1/account/me/notifications`, 2026-06-11, fixed by
// introducing `sseCorsHeaders`. It then recurred at `agent-sessions.ts:5201`
// (P-4) and took AI automation down completely — every message failed with
// `TypeError: Load failed`, which names neither CORS nor the route.
//
// The mechanism is the same both times and it is invisible to a normal reply:
// @fastify/cors sets ACAO in an onSend hook, and `reply.raw.writeHead()` writes
// straight to the socket, bypassing hooks. `hijackedReplyHeaders` is a
// deliberate seven-name allow-list that excludes ACAO, so EVERY SSE route must
// answer the origin question itself. Miss it and the stream 200s, the server
// logs nothing, and the browser silently refuses to hand the body to JS.
//
// ⚠️ WHAT WAS ALREADY GUARDED, AND WHY IT IS NOT THIS. `cors-allow.test.ts`
// derives the hijack sites by grepping `reply.raw.writeHead(` and asserts each
// one's source contains a `sseCorsHeaders` call. That is a good guard and it
// would have caught P-4. It cannot see a header that is present in source and
// absent on the wire — a hook that strips it, a helper whose return shape
// changes, a writeHead whose spread order overwrites it. Source-grepping is how
// both occurrences were eventually FOUND; it is not evidence about a response.
//
// ⛔ BOUNDARY, stated because a partial guard reads as a total one: FOUR hijack
// sites exist across three route files, and this spec covers TWO of them —
// `/v1/status/stream` and `/v1/account/me/notifications`. The two in
// `agent-sessions.ts` (`:3556` and `:5201`, the P-4 site itself) are NOT covered
// here: reaching them needs a dispatched agent session on a live mac node, and
// no e2e spec creates an agent session at all — measured across all 40 `.spec.ts`
// files in this directory, zero mention agent-sessions. So this spec is evidence
// about the MECHANISM those two share, and is not verification of P-4.
//
// ⚠️ The harness runs `permissiveCors: true`, so this cannot exercise the
// allow-list — a refused origin has no e2e coverage anywhere. That posture is
// correct for THIS defect, whose signature is the header being absent outright,
// and it buys a clean positive control: on a permissive server a normal reply
// always reflects, so an SSE reply that does not is unambiguous.

import { test, expect } from '@playwright/test';
import http from 'node:http';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

const ORIGIN = 'http://localhost:1420';

interface HeadResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Read the status line and headers, then destroy the socket.
 *
 * ⛔ Deliberately not Playwright's `request.get`, and not `fetch`: both wait for
 * a complete body, and an SSE body never completes. The route holds the
 * connection open with heartbeat comments forever, so a normal client hangs
 * until the test times out — which reads as a broken test rather than a stream
 * doing exactly what a stream does. Reading headers off the raw response is also
 * the closest available thing to what the browser does before it decides whether
 * to hand the stream to JS.
 */
function headersOnly(url: string, headers: Record<string, string>): Promise<HeadResult> {
  return new Promise<HeadResult>((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
      res.destroy();
      req.destroy();
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`timed out waiting for response headers from ${url}`));
    });
    req.end();
  });
}

test('CRITICAL POSITIVE CONTROL a normal reply on this server reflects the origin, so a passing SSE arm below is not vacuous', async ({
  request,
}) => {
  // `/v1/account/me` rather than a status route: it is the most exercised normal
  // reply in this suite, so if it stops reflecting, the cause is CORS and not
  // this route. (`/v1/status/sla` was the first choice and answers 500 against a
  // database with no probe rows — see W-19.)
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: { Origin: ORIGIN, Authorization: `Bearer ${seed.plaintext}` },
  });
  expect(res.status()).toBe(200);
  expect(
    res.headers()['access-control-allow-origin'],
    'the hooked path reflects — the server IS answering CORS',
  ).toBe(ORIGIN);
});

test('CRITICAL the public status stream carries ACAO on the wire, not just in source', async () => {
  const res = await headersOnly(`${server.baseUrl}/v1/status/stream`, { Origin: ORIGIN });

  expect(res.status).toBe(200);
  // Prove we are actually looking at a hijacked stream and not an error reply
  // that took the normal path — the normal path would carry ACAO for free and
  // the assertion below would mean nothing.
  expect(String(res.headers['content-type'])).toContain('text/event-stream');
  expect(
    res.headers['access-control-allow-origin'],
    'a hijacked SSE reply must set ACAO itself; @fastify/cors never sees it',
  ).toBe(ORIGIN);
});

test('CRITICAL the authenticated notifications stream carries ACAO — the route the first occurrence was reported on', async () => {
  const seed = await seedAccount(server.client);
  const url = `${server.baseUrl}/v1/account/me/notifications?ds_token=${encodeURIComponent(seed.plaintext)}`;
  const res = await headersOnly(url, { Origin: ORIGIN, Accept: 'text/event-stream' });

  expect(res.status).toBe(200);
  expect(String(res.headers['content-type'])).toContain('text/event-stream');
  expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
});

test('a reflected ACAO is paired with `vary: origin`, without which a cache can serve one origin the header minted for another', async () => {
  const res = await headersOnly(`${server.baseUrl}/v1/status/stream`, { Origin: ORIGIN });

  // ⛔ These two preconditions are not ceremony — WITHOUT THEM THIS ARM PASSED
  // AGAINST A 404. On its first run the route was not registered at all, and a
  // 404 takes the NORMAL reply path, where @fastify/cors sets `vary: Origin`
  // for free. So the arm asserted a header it was never testing, on a response
  // from a route that did not exist, and reported green.
  //
  // That is the whole failure mode this file exists to argue against, reproduced
  // inside the file itself on the first attempt: a header assertion means
  // nothing until you have proven WHICH path produced the response.
  expect(res.status, 'the route must exist, or the normal path answers for it').toBe(200);
  expect(String(res.headers['content-type'])).toContain('text/event-stream');

  expect(String(res.headers['vary']).toLowerCase()).toContain('origin');
});
