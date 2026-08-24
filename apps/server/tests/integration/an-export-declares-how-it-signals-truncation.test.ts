// A truncated export says so somewhere a generated client can read.
//
// `GET /v1/account/audit-log/export` stops at 10,000 rows. When it does, the
// caller is holding a PARTIAL audit log that looks exactly like a complete one.
//
// How that is signalled depends on the format, and only one of the two ways was
// reachable from the published contract:
//
//   format=json   the envelope carries a `truncated` boolean, and the schema
//                 declares it. A generated client sees it.
//   format=csv    a CSV attachment has nowhere to put a field, so the ONLY
//                 signal is the `x-driftstack-export-truncated` response
//                 header — which the spec described in the response
//                 DESCRIPTION and never declared.
//
// So a client built from the spec could request a CSV export, receive 10,000 of
// 40,000 rows, and have no typed way to find out. Prose in a description is
// documentation for a person; a code generator reads `headers`.
//
// That is the shape worth naming, because it recurred: someone knew the header
// mattered enough to write a sentence about it, and put the sentence where a
// generator cannot use it. The crypto-order `Idempotent-Replayed` header had
// exactly the same history and is fixed in the same change.
//
// WHAT THIS ASSERTS. The mechanism that carries the signal: the header is
// declared, and it is present on a real export with the honest value `false`.
// A header that is absent when nothing was truncated would be indistinguishable
// from one that is absent when something was, which is the actual hazard — so
// "always sent" is a property under test in its own right.
//
// V-1417 — this block used to say the true branch was out of reach, on the
// grounds that 10,001 audit rows cost more than the claim was worth. That was an
// estimate, and measuring it disagreed: the audit repo behind `buildTestApp` is
// in-memory, so seeding 10,001 rows AND running the fully paginated export takes
// about a third of a second. The arm at the end of this file drives it. Coverage
// had been unambiguous that nothing did — `truncated ? 'true' : 'false'` appears
// twice, once per format, and both read `[0, n]`: the string `'true'` had never
// been produced by either branch.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(HERE, '..', '..', '..', '..', 'packages', 'sdk-python', 'openapi.json');
const EXPORT_PATH = '/v1/account/audit-log/export';

/** Header names the spec declares on a given path/method/status. */
function declaredHeaders(path: string, method: string, status: string): string[] {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as {
    paths?: Record<string, Record<string, { responses?: Record<string, { headers?: object }> }>>;
  };
  return Object.keys(spec.paths?.[path]?.[method]?.responses?.[status]?.headers ?? {}).map((h) =>
    h.toLowerCase(),
  );
}

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (f: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${f.plaintext}`,
});

describe('an export declares how it signals truncation', () => {
  it('CRITICAL the spec declares the truncation header on the export. Every assertion below compares against this declaration, and an empty one agrees with anything — the whole defect was a header the server sent and the spec never named, so a guard that stopped reading the declaration would report the gap closed while it reopened.', () => {
    const declared = declaredHeaders(EXPORT_PATH, 'get', '200');
    expect(declared, 'the truncation header is declared').toContain(
      'x-driftstack-export-truncated',
    );
    expect(declared, 'and the attachment filename header').toContain('content-disposition');
  });

  it('CRITICAL a CSV export sends the truncation header, always. For format=csv this is the only signal there is — the attachment has nowhere to carry a field — so a client that received 10,000 of 40,000 rows would otherwise process a partial audit log as a complete one.', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${EXPORT_PATH}?format=csv`,
      headers: auth(fx),
    });

    expect(res.statusCode, 'the export succeeded').toBe(200);
    expect(String(res.headers['content-type']), 'and came back as CSV').toMatch(/text\/csv/);
    expect(
      res.headers['x-driftstack-export-truncated'],
      'the truncation header is present even when nothing was truncated',
    ).toBe('false');
  });

  it('CRITICAL the JSON export sends it too, alongside the body field. The envelope has a `truncated` field, so the header is redundant here — but a header present on one format and absent on the other is worse than either, because a client cannot tell "not truncated" from "this format does not tell you".', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${EXPORT_PATH}?format=json`,
      headers: auth(fx),
    });

    expect(res.statusCode, 'the export succeeded').toBe(200);
    expect(res.headers['x-driftstack-export-truncated'], 'header present').toBe('false');
    expect(res.json<{ truncated?: boolean }>().truncated, 'and the body agrees with it').toBe(
      false,
    );
  });

  it('CRITICAL every header the export declares is one it actually sends. The other direction: a declared-but-absent header is a promise a generated client types as available and then reads as undefined, which is how the JSON-only `truncated` field misled anyone reading the schema for CSV.', async () => {
    const declared = declaredHeaders(EXPORT_PATH, 'get', '200');
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: `${EXPORT_PATH}?format=csv`,
      headers: auth(fx),
    });

    const sent = new Set(Object.keys(res.headers).map((h) => h.toLowerCase()));
    const absent = declared.filter((h) => !sent.has(h)).sort();
    expect(absent, 'header(s) the export schema declares that the response did not send:').toEqual(
      [],
    );
  });

  // V-1417 — the true branch, which the note at the top of this file used to
  // place out of reach. `truncated` is `all.length >= EXPORT_MAX_ROWS` with the
  // cap at 10,000, so the signal only means anything if it flips, and neither
  // format had ever produced it. A customer exporting a large log and receiving
  // a silently partial one is the hazard the header exists for; until now the
  // suite only proved the header is always PRESENT, never that it is ever TRUE.
  it.each([
    ['json', 'application/json'],
    ['csv', 'text/csv'],
  ])(
    'CRITICAL a log past the 10,000-row cap reports truncated=true on format=%s. Seeding 10,001 rows and running the fully paginated export costs about a third of a second against the in-memory repo, which is what makes this arm affordable where the estimate said it was not.',
    async (format, contentType) => {
      fx = await buildTestApp();
      for (let i = 0; i < 10_001; i++) {
        await fx.accountAuditRepo.insert({
          accountId: fx.accountId,
          actorType: 'customer',
          actorAccountId: fx.accountId,
          actorKeyId: fx.apiKeyId,
          action: 'api_key.minted',
        });
      }

      const res = await fx.app.inject({
        method: 'GET',
        url: `/v1/account/audit-log/export?format=${format}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(contentType);
      expect(
        res.headers['x-driftstack-export-truncated'],
        'the only truncation signal a CSV client can read, and the one this file exists for',
      ).toBe('true');

      if (format === 'json') {
        const body = res.json<{ truncated: boolean; row_count: number }>();
        expect(body.truncated, 'the envelope field must agree with the header').toBe(true);
        expect(body.row_count, 'the export stops AT the cap, it does not overshoot it').toBe(
          10_000,
        );
      }
    },
    120_000,
  );
});
