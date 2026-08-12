// The API returns 429 for two unrelated reasons, and a client must be able to
// tell them apart. One is worth retrying automatically; the other never is.
//
//   rate-limited      — too many requests. Clears on its own. Carries
//                       `Retry-After`, and the SDKs back off and retry.
//   concurrency-limit — every session slot the tier allows is in use. Does NOT
//                       clear on its own: it clears when the customer destroys
//                       a session. Carries NO `Retry-After`, deliberately.
//
// That distinction is load-bearing across three layers. The docs state it twice
// and in both directions — "Retry-After carries the wait time" for rate limits,
// and for the concurrency cap "Unlike rate-limit 429s there is no Retry-After
// header — capacity frees when one of your sessions ends". The error catalogue
// marks one retryable and the other not. All three SDKs branch on the problem
// TYPE rather than the status, so `concurrency-limit` becomes
// ConcurrencyLimitError and `isRetryable` returns false for it.
//
// A blanket "add Retry-After to every 429" is exactly the kind of tidying that
// looks like an improvement and breaks this: it would contradict published
// guidance customers follow, and hand a retry hint to a condition that no amount
// of waiting resolves.
//
// The presence half is already covered — auth.test.ts and the observability
// counters assert a rate-limit 429 carries the header. The ABSENCE half was
// not. The two `toBeUndefined` assertions elsewhere in the suite are about 403
// responses for a suspended or missing owner, not about this 429 at all.
//
// Both 429s have to be genuinely provoked for any of this to mean anything. A
// probe that never reaches the limit satisfies "no Retry-After" perfectly while
// proving nothing, so the type of each response is asserted before its headers
// are judged.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

const RATE_LIMITED = 'https://errors.driftstack.dev/rate-limited';
const CONCURRENCY_LIMIT = 'https://errors.driftstack.dev/concurrency-limit';

interface Problem {
  type?: string;
  retry_after_seconds?: number;
}

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('the two 429 families stay distinguishable', () => {
  it('CRITICAL the concurrency 429 carries NO Retry-After. Waiting does not free a session slot — destroying one does — so a retry hint here would send every SDK into a backoff loop against a condition that cannot expire. The tier and the count are in the body instead, which is what a caller can actually act on.', async () => {
    // api_starter permits 2 concurrent sessions, so the third is refused.
    // Free is deliberately not used: it has no API access at all and answers
    // 403, which would look like a passing absence check having never reached
    // the limit.
    fx = await buildTestApp({ tier: 'api_starter', scopes: ['read', 'write', 'account_owner'] });
    const headers = { authorization: `Bearer ${fx.plaintext}` };
    const create = async () =>
      fx.app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: {} });

    expect((await create()).statusCode, 'first session fits the cap').toBe(201);
    expect((await create()).statusCode, 'second session fits the cap').toBe(201);
    const refused = await create();

    // Prove the limit was actually reached before judging the headers.
    expect(refused.statusCode, 'the third create is refused').toBe(429);
    expect(refused.json<Problem>().type, 'refused for CONCURRENCY, not rate').toBe(
      CONCURRENCY_LIMIT,
    );

    expect(
      refused.headers['retry-after'],
      'a concurrency 429 must not carry Retry-After — the docs promise its absence and the SDKs rely on the type, not the status',
    ).toBeUndefined();
    expect(
      refused.json<Problem>().retry_after_seconds,
      'nor the body field, which would be the same hint by another name',
    ).toBeUndefined();
  }, 180_000);

  it('CRITICAL the rate-limit 429 carries Retry-After, and the header agrees with the body. They are not two independent producers: the error handler derives the header FROM the body extension, so this guards that single derivation rather than a race between two writers. Mutating the derivation to skew by seven seconds is what proves the assertion live — skewing any of the eight header lines in the two rate-limit middlewares changes nothing on this path, which is worth knowing before assuming where the value comes from.', async () => {
    fx = await buildTestApp({ tier: 'api_starter', scopes: ['read', 'write', 'account_owner'] });
    // passwordResetRequest is an IP bucket of capacity 3: small enough to
    // exhaust deterministically, and unauthenticated so no account budget is
    // involved.
    let refused: Awaited<ReturnType<typeof fx.app.inject>> | null = null;
    for (let i = 0; i < 12 && refused === null; i += 1) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/request',
        payload: { email: 'retry-after-probe@example.com' },
      });
      if (res.statusCode === 429) refused = res;
    }

    expect(refused, 'the bucket was exhausted within 12 attempts').not.toBeNull();
    expect(refused!.json<Problem>().type, 'refused for RATE, not concurrency').toBe(RATE_LIMITED);

    const header = refused!.headers['retry-after'];
    expect(header, 'a rate-limit 429 carries Retry-After').toBeDefined();
    const seconds = refused!.json<Problem>().retry_after_seconds;
    expect(seconds, 'and the machine-readable body field').toBeDefined();
    expect(
      Number(header),
      'header and body must name the same wait, or two clients wait differently for one refusal',
    ).toBe(seconds);
    expect(Number(header), 'and it is a positive number of SECONDS').toBeGreaterThan(0);
  }, 180_000);
});
