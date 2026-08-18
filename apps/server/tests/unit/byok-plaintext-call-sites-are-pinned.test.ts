// Where a customer's Anthropic key gets decrypted, and where the /test result
// can say anything about it.
//
// The key is a customer secret we hold. It is stored encrypted
// (`accounts.byok_anthropic_api_key_ciphertext`, bytea — there is no plaintext
// column), the dashboard read returns metadata only, and the audit rows carry no
// key fingerprint by the Q2 verdict. The only way the plaintext exists in
// process at all is `BYOKAnthropicService.getPlaintext`.
//
// Two call sites, both deliberate: the AgentRuntime path in
// routes/agent-sessions.ts, and `POST /v1/account/me/byok-anthropic-key/test`,
// which needs the real key to ask Anthropic whether it works. The service header
// used to say "the AgentRuntime call site ONLY", which had stopped being true.
//
// A third call site is a new place the secret can escape. That should be a
// decision someone makes, not a diff nobody reads — so the set is pinned by
// FILE, not by count: a new file decrypting the key fails here.
//
// The second half guards the /test response, because that is the one endpoint
// that holds the plaintext and then answers a customer. It returns `{ ok }` or
// `{ ok, reason }`, and every `reason` is one of five fixed constants. Nothing
// interpolates an upstream error — if it ever did, an Anthropic error echoing
// the request could put key material in a customer-visible field.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');
const SERVICE = 'services/byok-anthropic.ts';

/** Files allowed to decrypt a customer key, and why. */
const ALLOWED_DECRYPT_SITES = new Map<string, string>([
  ['routes/agent-sessions.ts', 'the AgentRuntime path — the key is sent to Anthropic for the turn'],
  [
    'routes/account-byok-anthropic.ts',
    'POST …/byok-anthropic-key/test — needs the real key to ask Anthropic whether it works',
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Non-comment lines: a mention in prose is not a call. */
function codeLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

function decryptCallSites(): string[] {
  return walk(SRC)
    .map((f) => f.slice(SRC.length + 1))
    .filter((rel) => rel !== SERVICE)
    .filter((rel) => /\.getPlaintext\(/.test(codeLines(resolve(SRC, rel))))
    .sort();
}

describe('the BYOK plaintext stays where it was decided to go', () => {
  const sites = decryptCallSites();

  it('CRITICAL the scan can see a real call site, so an empty result means none', () => {
    // This asserts a set EQUALS a list, so a scan reading nothing would report
    // an empty set and quietly drop every allowed site at once. Probed by name.
    expect(sites, 'the AgentRuntime call site is missing — the scan is broken').toContain(
      'routes/agent-sessions.ts',
    );
    expect(
      /getPlaintext/.test(readFileSync(resolve(SRC, SERVICE), 'utf8')),
      'the service no longer declares getPlaintext — this file is pinning nothing',
    ).toBe(true);
  });

  it('CRITICAL no file decrypts a customer key except the two that were agreed', () => {
    const unexpected = sites.filter((f) => !ALLOWED_DECRYPT_SITES.has(f));
    expect(
      unexpected,
      'this file decrypts a customer’s Anthropic key. That is a new place the secret exists in ' +
        'process, and a new place it can reach a log, a response or an upstream request. If it is ' +
        'deliberate, add it to ALLOWED_DECRYPT_SITES with the reason',
    ).toEqual([]);
  });

  it('CRITICAL every allowed site still decrypts, so the list cannot rot', () => {
    const gone = [...ALLOWED_DECRYPT_SITES.keys()].filter((f) => !sites.includes(f)).sort();
    expect(
      gone,
      'an ALLOWED_DECRYPT_SITES entry no longer calls getPlaintext — it stopped being a decision ' +
        'and became a stale exemption',
    ).toEqual([]);
  });

  it('CRITICAL the /test reason is a fixed constant, never upstream text', () => {
    // The endpoint that holds the plaintext and then answers the customer. Every
    // failure reason must be one of the module's own constants; interpolating an
    // upstream body or error is how key material reaches a customer field.
    const tester = codeLines(resolve(SRC, 'services/anthropic-key-tester.ts'));
    // Two false starts here, both mine: matching `reason:` also caught the TYPE
    // declaration (`reason: string`), and a shape-matching regex rejected the
    // legitimate `controller.signal.aborted ? TIMEOUT_REASON : NETWORK_REASON`
    // because the condition contains dots. So this asserts the PROPERTY rather
    // than a shape: every value must name a *_REASON constant, and must not
    // interpolate — no template literal, no quoted string, no error/body text.
    const assigned = [...tester.matchAll(/reason:\s*([^,\n}]+)/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((v) => v !== 'string');
    expect(assigned.length, 'no reason assignments found — the scan is broken').toBeGreaterThan(3);
    const notConstant = assigned.filter(
      (v) => !/_REASON\b/.test(v) || /[`'"]|\.message|\bbody\b|\btext\b/.test(v),
    );
    expect(
      notConstant,
      'a /test failure reason is built from something other than a fixed constant. That field is ' +
        'returned to the customer while the plaintext key is in scope',
    ).toEqual([]);
  });
});
