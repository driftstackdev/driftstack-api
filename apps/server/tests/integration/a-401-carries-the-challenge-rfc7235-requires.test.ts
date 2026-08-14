// A 401 carries the challenge RFC 7235 requires.
//
// RFC 7235 §3.1: "The server generating a 401 response MUST send a
// WWW-Authenticate header field containing at least one challenge."
//
// One route did. `/metrics` sets `Bearer realm="metrics"` before throwing, and
// two tests hold it there. Every other 401 the API can return — 218 paths
// declare one — omitted the header entirely. So the conformance was not a
// policy anyone had decided; it was a single route someone happened to look at.
//
// What it costs in practice is modest and worth stating honestly rather than
// inflating: a Bearer API's clients already know the scheme, and no browser
// prompts on a Bearer challenge the way it does for Basic. The header matters to
// the layers that read it generically — standards-conformant HTTP libraries,
// proxies, API gateways and scanners that decide how to authenticate from the
// challenge rather than from documentation.
//
// The fix goes in `replyWithProblem`, the single funnel every problem response
// passes through, so it cannot be added to some 401s and forgotten on others —
// which is exactly how the API arrived at one route out of 219.
//
// IT DOES NOT OVERWRITE AN EXISTING CHALLENGE, and that condition is the
// interesting part. `/metrics` sets its realm-specific header and THEN throws,
// so the error funnel sees the same reply object with the header already on it.
// An unconditional set would replace `Bearer realm="metrics"` with a bare
// `Bearer` and quietly weaken a more specific challenge while appearing to add
// conformance. A route that says something more precise keeps saying it.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', '..', '..', 'packages', 'sdk-python', 'openapi.json');

/** Header names the spec declares on the 401 of a given path+method. */
function declaredOn401(path: string, method: string): string[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths?: Record<string, Record<string, { responses?: Record<string, { headers?: object }> }>>;
  };
  return Object.keys(spec.paths?.[path]?.[method]?.responses?.['401']?.headers ?? {}).map((h) =>
    h.toLowerCase(),
  );
}

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('a 401 carries the challenge RFC 7235 requires', () => {
  it('CRITICAL an ordinary 401 is reachable. Every assertion below reads a header off a 401 response — if the request came back 200 or 403, reading an absent header would look identical to reading one that is correctly absent.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ds_live_not_a_real_key' },
    });
    expect(res.statusCode, 'a bad key is refused with 401').toBe(401);
  });

  it('CRITICAL the 401 carries a WWW-Authenticate challenge. RFC 7235 §3.1 makes this a MUST, and 218 paths declare a 401 while exactly one route was sending it.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me',
      headers: { authorization: 'Bearer ds_live_not_a_real_key' },
    });
    expect(res.statusCode, 'still a 401').toBe(401);
    expect(res.headers['www-authenticate'], 'the challenge is present').toBeDefined();
    expect(String(res.headers['www-authenticate']), 'and names the Bearer scheme').toMatch(
      /^Bearer\b/,
    );
  });

  it('CRITICAL a missing Authorization header gets the challenge too. This is the case the header exists FOR: a client that sent no credentials learns from the challenge how to authenticate, rather than from documentation it may not have.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/v1/account/me' });
    expect(res.statusCode, 'no credentials is a 401').toBe(401);
    expect(String(res.headers['www-authenticate'] ?? ''), 'challenge present').toMatch(/^Bearer\b/);
  });

  it('CRITICAL the spec DECLARES the challenge it now sends. Fixing the conformance without declaring the header would only move the gap — from a header the server fails to send, to one it sends that no generated client can see, which is the defect the 429 header work had just closed.', async () => {
    const declared = declaredOn401('/v1/account/me', 'get');
    expect(declared, 'the 401 schema declares the challenge').toContain('www-authenticate');

    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({ method: 'GET', url: '/v1/account/me' });
    const sent = new Set(Object.keys(res.headers).map((h) => h.toLowerCase()));
    const absent = declared.filter((h) => !sent.has(h)).sort();
    expect(absent, 'header(s) the 401 schema declares that the refusal did not send:').toEqual([]);
  });
});
