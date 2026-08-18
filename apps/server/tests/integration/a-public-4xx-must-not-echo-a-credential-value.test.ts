// The unauthenticated OAuth token endpoint puts Zod's serialized issue list into
// `detail`, and for some issue kinds that list contains the value the caller sent.
//
// Found by measuring the duplicated-definition census: `parseOrThrow` is copied into
// six route files and four of them do `throw new BadRequestError(result.error.message)`.
// Three are gated entirely on `driftstack_internal_admin`. The fourth is `oauth.ts`,
// whose five `requireScope` calls all name that admin scope — and whose token and
// authorize endpoints have no scope gate at all. A file's scope calls do not describe
// its ungated routes, which is how a first draft of this guard nearly shipped with
// "all four are admin-only" as its premise.
//
// ── measured, not assumed ─────────────────────────────────────────────────────
//
// POST /v1/oauth/token with a bogus grant_type, unauthenticated:
//
//   detail: [ { "received": "MARKER_GRANT_9z", "code": "invalid_literal",
//               "expected": "authorization_code", "path": ["grant_type"] }, … ]
//
// So `invalid_literal` and `invalid_enum_value` echo the submitted value verbatim,
// while `too_small` carries only `minimum`, and `invalid_type` carries only the type
// name (`"received": "undefined"` for a missing field). The echo is real and it is on
// a public endpoint.
//
// ⚠️ What it is NOT, because the first read of this went the other way twice today.
// No credential is exposed today: on this schema the only literal is `grant_type`,
// and `client_secret` / `code` / `code_verifier` are plain strings, so their failures
// are `too_small` or `invalid_type` and their values never reach the body. A wrong
// secret is an auth failure, not a schema failure, so it never passes through here at
// all. This is not written up as a live credential leak, because it is not one.
//
// What it is: `error-handler-4xx-does-not-echo-submitted-values` states the doctrine
// — "when the client's input IS a credential, describing it is the leak" — and proves
// it for Fastify's framework 4xx by driving AJV and the JSON parser. Nothing covered
// this application-level path, on the one public surface that uses the raw form. The
// distance between "safe" and "leaking" here is one schema edit: make any credential
// field a literal or an enum and its value starts appearing in an unauthenticated
// response body. That edit is what these arms exist to fail on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './_helpers/build-test-app.js';

let fx: Awaited<ReturnType<typeof buildTestApp>>;

/** Distinctive enough that finding one in a response body is unambiguous. */
const SECRET = 'zq7marker4client9secret';
const AUTH_CODE = 'zq7marker4authorization9code';
const VERIFIER = 'zq7marker4code9verifier';

beforeAll(async () => {
  fx = await buildTestApp({ withOauthStore: true });
});

afterAll(async () => {
  await fx.app.close();
});

/** A token request that fails SCHEMA validation, carrying marker credentials. */
async function tokenRequest(overrides: Record<string, unknown>): Promise<{
  status: number;
  body: string;
}> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/oauth/token',
    payload: {
      grant_type: 'authorization_code',
      code: AUTH_CODE,
      client_id: 'marker-client',
      client_secret: SECRET,
      code_verifier: VERIFIER,
      redirect_uri: 'https://app.test.local/cb',
      ...overrides,
    },
  });
  return { status: res.statusCode, body: res.body };
}

describe('a public 4xx must not echo a credential value', () => {
  it('CRITICAL the endpoint really is unauthenticated and really returns a Zod-shaped detail, so the arms below are not vacuous. A first version of this reasoning assumed the route was admin-gated because every requireScope in its file names the admin scope; its token endpoint has no gate, which is exactly why this arm asserts the shape rather than trusting the read.', async () => {
    // No authorization header anywhere in this file.
    const { status, body } = await tokenRequest({ code_verifier: 'too-short' });
    expect(status, 'the token endpoint no longer 400s on a schema failure').toBe(400);
    // Plain substrings, not a regex: the body is JSON whose `detail` is itself
    // serialized JSON, so every quote arrives double-escaped and a regex written
    // against the readable shape silently matches nothing.
    expect(body, 'detail is no longer the serialized zod issue list').toContain('too_small');
    expect(body, 'the failing field is no longer named in detail').toContain('code_verifier');
    expect(body, 'the RFC 6749 error code is gone').toMatch(/"error":\s*"invalid_request"/);
  });

  it('CRITICAL a submitted client_secret never appears in the response. It is a plain string today, so its failures carry only a length or a type — but the whole distance between that and an unauthenticated body containing the secret is one schema edit to a literal or an enum, which is what this fails on.', async () => {
    // Fail validation on a DIFFERENT field so the secret is present and valid-shaped
    // — a request that fails ON the secret would prove less, because the interesting
    // case is the secret riding along while something else is rejected.
    const { body } = await tokenRequest({ redirect_uri: 'not a url' });
    expect(body, 'the submitted client_secret was echoed in a public 4xx').not.toContain(SECRET);
  });

  it('CRITICAL a submitted authorization code never appears in the response. The code IS a credential — it exchanges for an access token — and it is the field most likely to be pasted into a bug report along with the error body.', async () => {
    const { body } = await tokenRequest({ redirect_uri: 'not a url' });
    expect(body, 'the submitted authorization code was echoed in a public 4xx').not.toContain(
      AUTH_CODE,
    );
  });

  it('CRITICAL a submitted code_verifier never appears in the response. PKCE only works while the verifier stays private between the client and the token request; echoing it into an error body defeats the exchange it protects.', async () => {
    const { body } = await tokenRequest({ redirect_uri: 'not a url' });
    expect(body, 'the submitted code_verifier was echoed in a public 4xx').not.toContain(VERIFIER);
  });

  it('the non-credential literal field IS echoed, and that is recorded rather than asserted away. grant_type comes back as `"received": "<what you sent>"`, which is the mechanism the arms above exist to keep away from credential fields — pinning it here means a reader can see WHY those arms are not paranoia, and a change that stopped echoing anything would flag this arm rather than silently making the others vacuous.', async () => {
    const { body } = await tokenRequest({ grant_type: 'zq7marker4grant9type' });
    expect(body, 'the literal-mismatch echo is gone — the arms above may now be vacuous').toContain(
      'zq7marker4grant9type',
    );
  });
});
