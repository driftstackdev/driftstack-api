// The documented unknown-fields contract is read out of the source that emits it.
//
// `x-driftstack-unknown-fields` shipped without a word of customer documentation.
// The header exists so a client can SEE that a field it sent was ignored, which
// only works if a client knows to look — so the docs are not decoration here,
// they are the delivery. api/versioning.md now carries the contract.
//
// A docs page describing numbers that live in code is the shape that rots
// quietly: `MAX_REPORTED` becomes 25, the page still says 10, and nothing is
// wrong until a customer relies on it. So the page is not pinned to its own
// text — the values are read from `unknown-request-fields.ts` and the page must
// contain THOSE. Change the constant and this fails, naming the page to update.
//
// Scope: the facts with a machine-checkable source (header name, both caps, the
// permissive-parse and unauthenticated-exclusion decisions). The prose framing
// around them is the versioning page's own content-parity pin's business.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { UNKNOWN_FIELDS_HEADER } from '../../src/lib/unknown-request-fields.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const SOURCE = resolve(REPO_ROOT, 'apps/server/src/lib/unknown-request-fields.ts');
const DOC = resolve(REPO_ROOT, 'apps/docs/src/pages/api/versioning.md');

const source = (): string => readFileSync(SOURCE, 'utf8');
const doc = (): string => readFileSync(DOC, 'utf8');

/** Read a numeric constant out of the emitter rather than restating it here. */
function constant(name: string): number {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(source());
  expect(m, `${name} could not be read from unknown-request-fields.ts`).not.toBeNull();
  return Number(m?.[1]);
}

describe('the documented unknown-fields contract matches the code that emits it', () => {
  it('CRITICAL the constants were actually parsed, so a green is not a failed read', () => {
    // Both checks below compare against these numbers. If the regex stopped
    // matching, they would compare against NaN and pass on any page text.
    expect(constant('MAX_REPORTED'), 'MAX_REPORTED parsed').toBeGreaterThan(0);
    expect(constant('MAX_KEY_CHARS'), 'MAX_KEY_CHARS parsed').toBeGreaterThan(0);
  });

  it('CRITICAL the page names the header the server actually sets', () => {
    // Imported, not restated: a rename of the exported constant lands here.
    expect(
      doc(),
      'the versioning page documents a header name the server does not send, so a customer ' +
        'following the docs would watch for a header that never arrives',
    ).toContain(UNKNOWN_FIELDS_HEADER);
  });

  it('CRITICAL the documented caps are the caps the emitter enforces', () => {
    const reported = constant('MAX_REPORTED');
    const keyChars = constant('MAX_KEY_CHARS');
    expect(
      doc(),
      `the emitter caps the header at ${reported} keys; api/versioning.md documents a different ` +
        'number. Update the page — a customer sizing a parser on the documented cap would be wrong',
    ).toContain(`At most ${reported} keys`);
    expect(
      doc(),
      `the emitter truncates each key at ${keyChars} characters; api/versioning.md documents a ` +
        'different number',
    ).toContain(`${keyChars} characters`);
  });

  it('CRITICAL the page documents the percent-encoding, and its worked example is the value the encoder really produces. V-950 — the page used to promise "the request succeeds exactly as if it had not been sent" while a field name carrying an emoji or a non-Latin script answered 500, so this pins the claim to the code from both ends. The example is computed here rather than transcribed: a documented value nothing can produce is fiction that reads as a contract.', () => {
    expect(
      source(),
      'the emitter no longer renders reported keys header-safe, so a field name with a character ' +
        'outside U+0000–U+00FF — or a CR, LF or NUL — makes reply.header throw and answers 500 on a ' +
        'request that used to succeed',
    ).toContain('headerSafeText(');
    expect(
      doc(),
      'the emitter percent-encodes reported key names; the page does not say so, so a customer ' +
        'displaying the header verbatim would show %XX escapes with no explanation',
    ).toContain('Percent-encoded');

    // The page walks `field-不明`. Compute what the emitter would send for it.
    const example = `field-${String.fromCodePoint(0x4e0d, 0x660e)}`;
    expect(doc(), 'the page states an encoded example the encoder does not produce').toContain(
      encodeURIComponent(example),
    );
    expect(
      doc(),
      'and it still shows the name being encoded, so the pair reads as a mapping',
    ).toContain(example);
  });

  it('CRITICAL the two behavioural decisions the page states still hold in code', () => {
    // Reporting-not-rejecting: the page tells customers nothing breaks if they
    // send an extra field. That is only true while the helper returns the keys
    // instead of throwing — it imports ValidationError, so rejecting is one edit
    // away, and that edit would make the page actively wrong.
    expect(
      source(),
      'reportUnknownRequestFields no longer returns the unknown keys — if it now rejects, the ' +
        'versioning page’s "reporting, never rejecting" promise is false',
    ).toContain('return unknown;');
    // The unauthenticated exclusion is a disclosure decision, documented as such.
    expect(
      source(),
      'the deliberate exclusion of unauthenticated auth endpoints is no longer stated at the ' +
        'helper, so the page documents a boundary the code may no longer keep',
    ).toContain('Deliberately NOT applied to unauthenticated auth endpoints');
  });

  it('CRITICAL the worked example is a real route with a real field', () => {
    // The page walks through PATCH /v1/account/me dropping a mistyped
    // `timezonee`. That example is only honest while `timezone` is a field the
    // schema declares — otherwise the "correct" spelling would ALSO be reported
    // and the example teaches the wrong lesson.
    const routes = readFileSync(resolve(REPO_ROOT, 'apps/server/src/routes/account-me.ts'), 'utf8');
    expect(doc(), 'the worked example no longer names the route it walks through').toContain(
      'PATCH /v1/account/me',
    );
    expect(
      routes,
      'the account-me route no longer reports unknown fields, so the page’s worked example ' +
        'describes behaviour that route no longer has',
    ).toMatch(/parseRequestBodyReportingUnknown|reportUnknownRequestFields/);
    expect(
      routes,
      '`timezone` is no longer a declared field on PATCH /v1/account/me, so the example’s ' +
        'contrast between timezone and timezonee no longer holds',
    ).toContain('timezone');
  });
});
