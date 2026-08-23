// V-1365 — what a duplicated request header ACTUALLY becomes, measured on a socket.
//
// Two shared header parsers, `lib/idempotency-key.ts` and
// `lib/effective-account-header.ts`, each narrow the header with the same expression —
// `Array.isArray(raw) ? raw[0] : raw` — and each used to describe that line as the
// duplicate-header path, resolving a repeated header to its first value. Both
// descriptions were frozen by content-parity pins, and one of those pins justified the
// line with a threat model about an attacker appending a second header value to force an
// account scope. The unit arm that read like coverage of it handed the parser a
// hand-built `[a, b]`. That proves the parser can handle an array. Nothing proved an
// array is what arrives.
//
// It is not. Node's HTTP parser puts only `set-cookie` in an array. A short list of headers
// (authorization, host, content-type, …) discards duplicates so the FIRST value wins;
// everything else — including both headers above — is JOINED with `', '` into one string.
// So the array branch is unreachable for these two headers on the wire, and "first wins" is
// not what either of them does.
//
// The outcomes are still fail-closed, and this file pins them so they stay that way, because
// neither is fail-closed by design:
//   - Idempotency-Key: `key-one, key-two` contains a space, so the ASCII contract rejects
//     it → 400. The SPACE in the separator is doing the work.
//   - X-Driftstack-Account: `acc_A, acc_B` still starts with `acc_`, so it passes the format
//     check and is refused one step later, by the membership lookup → 403.
//
// ⚠️ This file listens on a real socket, and it has to. `app.inject()` accepts an array and
// joins it with `,` — NO space — which the idempotency contract accepts as a VALID key. An
// inject-based version of this test therefore exercises the accepting path while production
// takes the rejecting one. The last arm pins that divergence so the next person does not
// rewrite this file the easy way.

import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import Fastify from 'fastify';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture | undefined;

afterEach(async () => {
  if (fx !== undefined) await fx.cleanup();
  fx = undefined;
});

interface RawResponse {
  status: number;
  body: string;
}

/**
 * Send a request whose header list we control byte for byte. `fetch` and `inject` both
 * normalise duplicates before Node's parser sees them, which is precisely what is under test.
 */
async function sendRaw(
  port: number,
  requestLine: string,
  headers: string[],
  body = '',
): Promise<RawResponse> {
  const lines = [requestLine, 'Host: 127.0.0.1', ...headers, 'Connection: close'];
  if (body.length > 0) {
    lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
  }
  const raw = [...lines, '', body].join('\r\n');

  const wire = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    let buffer = '';
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error('raw request timed out'));
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(buffer));
    socket.on('error', reject);
  });

  const headerEnd = wire.indexOf('\r\n\r\n');
  const status = Number(wire.slice(0, wire.indexOf('\r\n')).split(' ')[1]);
  return { status, body: wire.slice(headerEnd + 4) };
}

async function listen(app: TestAppFixture['app']): Promise<number> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  return address.port;
}

async function sessionCount(fixture: TestAppFixture): Promise<number> {
  const listed = await fixture.app.inject({
    method: 'GET',
    url: '/v1/agent-sessions',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
  });
  expect(listed.statusCode, 'listing agent sessions').toBe(200);
  return listed.json<{ data: unknown[] }>().data.length;
}

describe('a request header sent twice', () => {
  it('CRITICAL arrives JOINED into one string, not as an array — and "first wins" holds only for the headers Node special-cases. Measured on a socket against a bare Fastify instance, because this is a property of the HTTP parser rather than of our routes. Both shared parsers document the opposite, so their array branch cannot execute for the headers they read.', async () => {
    const probe = Fastify();
    probe.post('/probe', (request) => ({
      idempotency: request.headers['idempotency-key'] ?? null,
      idempotencyIsArray: Array.isArray(request.headers['idempotency-key']),
      account: request.headers['x-driftstack-account'] ?? null,
      accountIsArray: Array.isArray(request.headers['x-driftstack-account']),
      authorization: request.headers.authorization ?? null,
    }));
    await probe.listen({ host: '127.0.0.1', port: 0 });
    const address = probe.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP address');

    try {
      const response = await sendRaw(
        address.port,
        'POST /probe HTTP/1.1',
        [
          'Idempotency-Key: key-one',
          'Idempotency-Key: key-two',
          'X-Driftstack-Account: acc_11111111-1111-4111-8111-111111111111',
          'X-Driftstack-Account: acc_22222222-2222-4222-8222-222222222222',
          'Authorization: Bearer first',
          'Authorization: Bearer second',
        ],
        '{}',
      );
      expect(response.status, `the probe answered: ${response.body}`).toBe(200);
      const seen = JSON.parse(response.body) as Record<string, unknown>;

      expect(seen.idempotencyIsArray, 'Idempotency-Key did NOT arrive as an array').toBe(false);
      expect(seen.accountIsArray, 'X-Driftstack-Account did NOT arrive as an array').toBe(false);
      expect(seen.idempotency, 'both values, joined with a comma AND a space').toBe(
        'key-one, key-two',
      );
      expect(seen.account, 'both values, joined — not the first one').toBe(
        'acc_11111111-1111-4111-8111-111111111111, acc_22222222-2222-4222-8222-222222222222',
      );
      // The contrast that makes the claim falsifiable rather than a bare assertion:
      // authorization IS on Node's discard-duplicates list, so first-wins is real there.
      expect(seen.authorization, 'authorization is special-cased, so here first really wins').toBe(
        'Bearer first',
      );
    } finally {
      await probe.close();
    }
  });

  it('CRITICAL a duplicated Idempotency-Key is REFUSED by POST /v1/agent-sessions rather than deduped under the first value, and no session is created. The joined string carries a space, which the ASCII contract rejects — so the refusal rests on the separator, not on anything that noticed the duplication.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const port = await listen(fx.app);
    const before = await sessionCount(fx);

    const response = await sendRaw(
      port,
      'POST /v1/agent-sessions HTTP/1.1',
      [
        `Authorization: Bearer ${fx.plaintext}`,
        'Idempotency-Key: key-one',
        'Idempotency-Key: key-two',
      ],
      '{}',
    );

    expect(response.status, `duplicated key was not refused: ${response.body}`).toBe(400);
    expect(await sessionCount(fx), 'a refused request must not have minted a session').toBe(before);
  });

  it('CRITICAL the same request with the header sent ONCE is accepted. Without this control the arm above is satisfied by a route that 400s every create, which would read as a working guard and be a broken endpoint.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const port = await listen(fx.app);

    const response = await sendRaw(
      port,
      'POST /v1/agent-sessions HTTP/1.1',
      [`Authorization: Bearer ${fx.plaintext}`, 'Idempotency-Key: key-one'],
      '{}',
    );
    expect(response.status, `a single key should be accepted: ${response.body}`).toBe(201);
  });

  it('CRITICAL a duplicated X-Driftstack-Account is refused rather than resolved to the FIRST value. The joined string keeps the acc_ prefix, so it clears the format check and is stopped one step later by the membership lookup — a different line than the one the pinned threat model names.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const port = await listen(fx.app);
    const self = `acc_${fx.accountId}`;

    const duplicated = await sendRaw(port, 'GET /v1/account/me/organization HTTP/1.1', [
      `Authorization: Bearer ${fx.plaintext}`,
      `X-Driftstack-Account: ${self}`,
      'X-Driftstack-Account: acc_22222222-2222-4222-8222-222222222222',
    ]);
    expect(duplicated.status, `first-wins would have made this a 200: ${duplicated.body}`).toBe(
      403,
    );

    const once = await sendRaw(port, 'GET /v1/account/me/organization HTTP/1.1', [
      `Authorization: Bearer ${fx.plaintext}`,
      `X-Driftstack-Account: ${self}`,
    ]);
    expect(once.status, `and the single-header control is allowed: ${once.body}`).toBe(200);
  });

  it('CRITICAL app.inject() cannot stand in for the wire here: it joins a duplicated value with a comma and NO space, which the idempotency contract ACCEPTS. An inject-based version of this file would exercise the accepting path while production takes the rejecting one — the reason these arms open a socket.', async () => {
    fx = await buildTestApp({ enableAgentRuntime: true });
    const injected = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': ['key-one', 'key-two'],
      },
      payload: {},
    });
    expect(
      injected.statusCode,
      `inject joins without a space, so the parser sees a well-formed key: ${injected.body}`,
    ).toBe(201);
  });
});
