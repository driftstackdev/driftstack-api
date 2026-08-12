// Every write endpoint reports failure as RFC 7807, across the population.
//
// All three SDKs parse errors through one path. sdk-typescript's http.ts turns
// a problem response into its typed error classes; the Python and Go clients do
// the equivalent. So a single route answering with a bare `{ error: ... }`, or
// with `content-type: application/json`, degrades error handling for every
// customer on every SDK — not just for that endpoint.
//
// Individual suites do assert problem+json for the routes they cover. What none
// of them could see is the POPULATION: whether the route added last week also
// does it. This drives all 52 parameterless writes with a deliberately invalid
// body and checks what comes back.
//
// One assertion needs its reasoning stated precisely, because the obvious
// version of it is wrong. The `status` member inside the body equals the HTTP
// status code TODAY for a structural reason: the central handler emits both
// from one value (`.code(problem.status) ... .send(problem)`), so they cannot
// disagree for any error that reaches it.
//
// What the assertion actually guards is the route that does NOT reach it — one
// that builds and sends its own error body instead of throwing. That route
// bypasses the handler entirely, and nothing else in the suite would notice: it
// is invisible per-endpoint (its own tests assert its own shape) and invisible
// to the spec (the contract says problem+json either way). All three SDKs read
// the typed error out of the BODY, so such a route would have them report a
// different failure than the one that happened.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;
let writes: Array<{ method: 'POST' | 'PATCH' | 'DELETE'; path: string }>;

interface Probe {
  route: string;
  status: number;
  contentType: string;
  body: Record<string, unknown>;
}

const probes: Probe[] = [];

beforeAll(async () => {
  fx = await buildTestApp({
    scopes: ['read', 'write', 'account_owner'],
    withOauthStore: true,
    enableAgentRuntime: true,
    enableByokAnthropic: true,
  });
  const spec = (await fx.app.inject({ method: 'GET', url: '/openapi.json' })).json<{
    paths?: Record<string, Record<string, unknown>>;
  }>();

  writes = [];
  for (const path of Object.keys(spec.paths ?? {})) {
    // Templated paths need a real resource id; a synthetic one exercises the
    // 404 branch rather than the validation branch and tells us less.
    if (path.includes('{')) continue;
    for (const method of ['post', 'patch', 'delete'] as const) {
      if (spec.paths?.[path]?.[method] === undefined) continue;
      writes.push({ method: method.toUpperCase() as 'POST', path });
    }
  }

  for (const { method, path } of writes) {
    const res = await fx.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { __definitely_not_a_valid_field__: 1 },
    });
    if (res.statusCode < 400) continue;
    let body: Record<string, unknown> = {};
    try {
      body = res.json<Record<string, unknown>>();
    } catch {
      body = { __unparseable__: res.body.slice(0, 80) };
    }
    probes.push({
      route: `${method} ${path}`,
      status: res.statusCode,
      contentType: String(res.headers['content-type']).split(';')[0] ?? '',
      body,
    });
  }
}, 120_000);

afterAll(async () => {
  await fx.app.close();
});

describe('every write endpoint reports failure as RFC 7807', () => {
  it('CRITICAL the sweep reached a real population of real error paths. Every assertion below reports an ABSENCE, so a sweep that provoked no errors — or only 401s — would satisfy all of them having proved nothing.', () => {
    expect(writes.length, 'parameterless write endpoints discovered').toBeGreaterThan(45);
    expect(probes.length, 'writes that actually produced an error').toBeGreaterThan(40);
    // Distinct statuses, so this is not one rejection path repeated 50 times.
    // Observed today: 400, 403, 404, 409, 503.
    expect(
      new Set(probes.map((p) => p.status)).size,
      'distinct error statuses exercised',
    ).toBeGreaterThan(3);
  });

  it('CRITICAL every error body is served as application/problem+json. A route answering application/json sends all three SDKs down their non-problem branch, so the customer loses the typed error for that call.', () => {
    expect(
      probes.filter((p) => p.contentType !== 'application/problem+json').map((p) => p.route),
      'route(s) not using the problem content type:',
    ).toEqual([]);
  });

  it('CRITICAL every error body carries the RFC 7807 members the SDKs read', () => {
    expect(
      probes
        .filter((p) => !['type', 'title', 'status'].every((k) => k in p.body))
        .map((p) => `${p.route} -> ${Object.keys(p.body).join(',')}`),
      'error body(ies) missing a required member:',
    ).toEqual([]);
  });

  it('CRITICAL the status INSIDE the body equals the HTTP status on the response. They agree structurally for anything that throws, so what this catches is a route that builds its own error reply and bypasses the handler — invisible per-endpoint and invisible to the spec, while every SDK reads the typed error out of the body.', () => {
    expect(
      probes
        .filter((p) => p.body['status'] !== p.status)
        .map(
          (p) => `${p.route}: HTTP ${String(p.status)} but body says ${String(p.body['status'])}`,
        ),
      'route(s) whose body disagrees with their own status code:',
    ).toEqual([]);
  });
});
