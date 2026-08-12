// The verification function we publish to customers is executed, against a
// signature the server really produced.
//
// `apps/docs/src/pages/webhooks/events.md` carries a complete, copy-pasteable
// `verifyWebhook(secret, header, rawBody)` in a fenced block. Customers who do
// not use an SDK paste exactly that into their handler; it is the only thing
// standing between a forged POST and their system.
//
// `durable-webhook-signature-sdk-verify` already feeds a real emitted header
// into the SDK's verifier, and its header records why: the durable path once
// signed bare hex that the SDK silently rejected, which "would have broken
// every customer's signature verification on cutover". That covers the SDK
// path. The published snippet is a SECOND implementation, maintained by hand in
// a markdown file, and nothing executed it. A wrong separator, the wrong
// encoding, or a renamed header field would ship green and break every
// non-SDK customer at once — and their symptom is silent rejection of real
// deliveries, which reads to them like the API is broken.
//
// So the doc is the subject here rather than the reference. The block is
// extracted and evaluated. Pinning its text would only assert the file still
// says what it said; running it asserts the thing customers will actually do
// works against a real signature.
//
// The negative cases are what make the positive one mean anything: a verifier
// that returns true unconditionally satisfies "accepts a valid signature"
// perfectly. Each rejection below is a different reason a real handler must say
// no — a tampered body, the wrong secret, and a replayed timestamp outside the
// tolerance the snippet itself defines.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { signWebhookPayload } from '../../src/lib/webhook-signing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'apps',
  'docs',
  'src',
  'pages',
  'webhooks',
  'events.md',
);

type PublishedVerifier = (
  secret: string,
  header: string,
  rawBody: string,
  toleranceSec?: number,
) => boolean;

/**
 * Pull `verifyWebhook` out of the published markdown and make it callable.
 *
 * The snippet is CommonJS (`require('node:crypto')`), so it is given a real
 * `require` rather than being rewritten — rewriting it would mean testing an
 * adaptation instead of the thing on the page.
 */
function publishedVerifier(): PublishedVerifier {
  const md = readFileSync(DOC, 'utf8');
  const start = md.indexOf('```js', md.indexOf('function verifyWebhook') - 400);
  const end = md.indexOf('```', start + 5);
  expect(start, 'the verification snippet is still a ```js block in events.md').toBeGreaterThan(0);
  expect(end, 'the snippet block is terminated').toBeGreaterThan(start);
  const src = md.slice(md.indexOf('\n', start) + 1, end);
  expect(src, 'the block defines verifyWebhook').toContain('function verifyWebhook');

  const req = createRequire(import.meta.url);
  // Evaluating the published block is the point: the doc is the subject, not
  // a reference for a reimplementation.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function('require', 'Buffer', `${src}\nreturn verifyWebhook;`) as (
    r: NodeJS.Require,
    b: typeof Buffer,
  ) => PublishedVerifier;
  return factory(req, Buffer);
}

const SECRET = 'whsec_abcdefghijklmnopqrstuvwxyz234567';
const OTHER_SECRET = 'whsec_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz23';
const BODY = JSON.stringify({ id: 'evt_1', type: 'session.completed', data: { ok: true } });

describe('the webhook verifier published to customers actually verifies', () => {
  it('CRITICAL the snippet was extracted and is callable. Everything below runs THIS function, so a failed extraction would make the rest vacuous — and it would fail in the direction that looks like success.', () => {
    const verify = publishedVerifier();
    expect(typeof verify, 'verifyWebhook came out of the page as a function').toBe('function');
  });

  it('CRITICAL it accepts a header the SERVER produced. This is the whole contract: signWebhookPayload writes the header, the published code reads it, and neither knows about the other.', () => {
    const verify = publishedVerifier();
    const header = signWebhookPayload({ secret: SECRET, body: BODY });
    expect(verify(SECRET, header, BODY), 'a real delivery verifies').toBe(true);
  });

  it('CRITICAL it REJECTS a tampered body, the wrong secret, and a stale timestamp. Without these the case above proves nothing — a verifier that returns true unconditionally passes it.', () => {
    const verify = publishedVerifier();
    const header = signWebhookPayload({ secret: SECRET, body: BODY });

    expect(verify(SECRET, header, `${BODY} `), 'a body altered by one byte is refused').toBe(false);
    expect(verify(OTHER_SECRET, header, BODY), 'a signature from another secret is refused').toBe(
      false,
    );

    // The snippet defines its own replay window; sign far outside it.
    const stale = signWebhookPayload({
      secret: SECRET,
      body: BODY,
      timestampSec: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(verify(SECRET, stale, BODY), 'a delivery older than the tolerance is refused').toBe(
      false,
    );
    // ...and is accepted once the caller widens the window, proving the refusal
    // above came from the replay guard rather than from the signature failing.
    expect(
      verify(SECRET, stale, BODY, 7200),
      'the same delivery verifies with a wider window',
    ).toBe(true);
  });

  it('CRITICAL it accepts the OLD secret during a rotation grace window. The header carries two v1= entries then, and a customer who has not yet rolled their stored secret must keep verifying — that is the entire point of the grace window, and the snippet is what implements it on their side.', () => {
    const verify = publishedVerifier();
    const rotated = signWebhookPayload({ secret: OTHER_SECRET, body: BODY, secretPrev: SECRET });
    expect(rotated.match(/v1=/g)?.length, 'the header really carries two signatures').toBe(2);
    expect(verify(OTHER_SECRET, rotated, BODY), 'the new secret verifies').toBe(true);
    expect(verify(SECRET, rotated, BODY), 'and the old one still does').toBe(true);
  });
});
