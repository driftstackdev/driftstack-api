// The advance warning before a daily limit is one a client can discover.
//
// `POST /v1/auth/signup` is the only route with a per-IP DAILY ceiling — 25 in a
// rolling 24 hours, layered on top of the per-minute burst gate. A 2026-07-01
// security audit added `x-ratelimit-daily-remaining` and
// `x-ratelimit-daily-reset` for a specific reason, quoted from the middleware:
// without them "a high-volume-IP customer got zero advance warning before the
// abrupt 429 on request #(capacity + 1) — only the terminal denial set
// retry-after".
//
// The headers shipped. They were then published nowhere — not the OpenAPI spec,
// not the docs site, not any of the three SDKs. A warning nobody can discover
// does not do the job it was added to do, and the audit finding was only half
// closed: the signal exists, the ability to act on it does not.
//
// SCOPE, because overstating this would be easy. Exactly ONE bucket has a daily
// ceiling — `DAILY_IP_CEILINGS` holds a single entry, `auth-ip:signup`. So the
// headers are declared on signup alone and deliberately NOT folded into the
// shared 4xx helper: putting them on every route would advertise a limit the
// other 200-odd paths do not enforce, which is the same class of untruth as
// leaving a real header undeclared, pointed the other way.
//
// The interesting property is that they arrive on a SUCCESSFUL signup. A header
// that only appeared on the refusal would be exactly the situation the audit
// found — you learn the limit exists at the moment it stops you.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', '..', '..', 'packages', 'sdk-python', 'openapi.json');

/** Header names the spec declares on the signup 200. */
function declaredOnSignup(): string[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths?: Record<string, Record<string, { responses?: Record<string, { headers?: object }> }>>;
  };
  return Object.keys(
    spec.paths?.['/v1/auth/signup']?.['post']?.responses?.['200']?.headers ?? {},
  ).map((h) => h.toLowerCase());
}

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('signup declares its daily IP-ceiling headers', () => {
  it('CRITICAL the spec declares both daily headers on the signup 200. Every comparison below is against this declaration, and an empty one agrees with anything — the defect being closed is a header the server sends that the contract never named, so a guard that stopped reading the declaration would report it fixed while it regressed.', () => {
    const declared = declaredOnSignup();
    expect(declared, 'the remaining counter is declared').toContain('x-ratelimit-daily-remaining');
    expect(declared, 'and the reset time').toContain('x-ratelimit-daily-reset');
  });

  it('CRITICAL a SUCCESSFUL signup carries the daily headers. This is the whole point of the audit finding: headers that appeared only on the refusal would tell a customer the limit exists at the moment it stops them, which is not advance warning.', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `daily-header-probe-${String(Date.now())}@example.test`,
        password: 'a-long-unique-passphrase-for-this-test',
        name: 'Header Probe',
      },
    });

    expect(res.statusCode, 'the signup was accepted').toBe(200);
    const remaining = Number(res.headers['x-ratelimit-daily-remaining']);
    expect(Number.isFinite(remaining), 'remaining is a number').toBe(true);
    expect(remaining, 'and is below the 25/day ceiling having just spent one').toBeLessThan(25);
    expect(remaining, 'while still non-negative').toBeGreaterThanOrEqual(0);

    const reset = Number(res.headers['x-ratelimit-daily-reset']);
    expect(Number.isFinite(reset), 'reset is a number').toBe(true);
    expect(reset, 'and is a future unix time in SECONDS, not milliseconds').toBeGreaterThan(
      Math.floor(Date.now() / 1000),
    );
    expect(reset, 'no more than a day out, since the window is 24h').toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000) + 24 * 60 * 60 + 60,
    );
  });

  it('CRITICAL every header the signup 200 declares is one it actually sends. The other direction: a declared-but-absent header is a promise a generated client types as available and reads as undefined, and here it would be a limit-tracking field that silently never updates.', async () => {
    const declared = declaredOnSignup();
    fx = await buildTestApp({ tier: 'free' });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: `daily-header-probe2-${String(Date.now())}@example.test`,
        password: 'a-long-unique-passphrase-for-this-test',
        name: 'Header Probe',
      },
    });

    const sent = new Set(Object.keys(res.headers).map((h) => h.toLowerCase()));
    const absent = declared.filter((h) => !sent.has(h)).sort();
    expect(absent, 'header(s) the signup 200 declares that the response did not send:').toEqual([]);
  });
});
