// V-950 — an unrecognised field name the reporter cannot put in a header.
//
// `unknown-request-fields.ts` bounds the reported key text by LENGTH and nothing
// else: `sliceWithoutSplittingSurrogate(k, 64)`, then `reply.header(…)`. A JSON
// object key can hold any Unicode, so the value handed to `reply.header` is
// caller-controlled text.
//
// Node refuses an invalid header value rather than writing it, so there is no
// header injection — the fake header in the CRLF case below never appears. What
// happens instead is that the refusal throws inside the handler and the request
// answers 500.
//
// That contradicts the module's own contract, stated in its header comment: "the
// request still succeeds exactly as before, and the unknown keys are reported …
// Nothing about the response body changes, so no existing integration can break
// on it." A request that used to return 200 now returns 500.
//
// The CRLF case is hostile and the 500 is arguably fine. The NON-ASCII cases are
// not hostile at all — a Japanese field name, or any mojibake from a mis-encoded
// client, is an ordinary mistyped field, which is the exact case this mechanism
// exists to handle gracefully. It is reachable on every route wired to the
// reporter.
//
// These arms pin the FIXED behaviour: the request succeeds, and the header either
// carries a sanitised rendering of the key or is omitted. They are written against
// the real route rather than a bare Fastify instance so the app's error handler,
// hooks and serialisers are all in the path.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

/** Field names that cannot go into an HTTP header verbatim. */
const UNSENDABLE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['CRLF and a fake header', `a${CR}${LF}x-injected: yes`],
  ['a bare newline', `a${LF}b`],
  ['a NUL byte', `a${NUL}b`],
  // Not hostile: a real field name in a non-Latin script.
  ['a non-Latin script', `field-${String.fromCodePoint(0x4e0d, 0x660e)}`],
  ['an emoji', `${String.fromCodePoint(0x1f642)}key`],
  // JSON.parse produces a lone surrogate from "\ud800" quite happily, and it is
  // the input that makes encodeURIComponent throw URIError — so the sanitiser
  // must survive its own worst case, not just the header's.
  ['a lone high surrogate', `a${String.fromCharCode(0xd800)}b`],
  ['a lone low surrogate', `a${String.fromCharCode(0xdc00)}b`],
];

describe('V-950 an unreportable field name does not break the request', () => {
  let fx: TestAppFixture | undefined;
  afterEach(async () => {
    if (fx) await fx.cleanup();
    fx = undefined;
  });

  it('CRITICAL a mistyped field whose NAME cannot go in a header still succeeds. The mechanism exists to make an ignored field visible without changing the answer; turning a 200 into a 500 is a bigger failure than the silence it replaced, and a non-Latin field name reaches it with no hostile intent at all.', async () => {
    fx = await buildTestApp();
    for (const [label, key] of UNSENDABLE_KEYS) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/profiles',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: { name: `unsendable-${UNSENDABLE_KEYS.findIndex((e) => e[1] === key)}`, [key]: 1 },
      });
      expect(res.statusCode, `${label} must not break the request`).toBe(200);
    }
  });

  it('CRITICAL nothing a caller sends is echoed into a header verbatim. The refusal Node performs is what prevents header injection today; once the value is sanitised instead of rejected, the sanitising is the only thing standing between a caller and a forged header, so it is asserted directly rather than inferred from a status code.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'injection-probe', [`a${CR}${LF}x-injected: yes`]: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-injected'], 'no forged header appeared').toBeUndefined();
    const reported = res.headers['x-driftstack-unknown-fields'];
    if (reported !== undefined) {
      expect(String(reported), 'the reported value carries no CR').not.toContain(CR);
      expect(String(reported), 'and no LF').not.toContain(LF);
    }
  });

  it('CRITICAL the ordinary case still reports, so the arms above are not passing because reporting stopped. An implementation that dropped the header entirely would satisfy every assertion above.', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/profiles',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { name: 'plain-typo', archetyp: 'iphone17_ios18_7_safari26_4' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-driftstack-unknown-fields']).toBe('archetyp');
  });
});
