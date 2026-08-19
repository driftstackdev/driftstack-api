// V-942 — the one identifier support asks customers to quote was declared nowhere.
//
// `middleware/request-id.ts` sets `x-request-id` on EVERY response, CORS exposes
// it so a browser can read it, and FIVE customer pages tell people to include it
// when contacting support — quickstart, quickstart-curl, and all three SDK
// quickstarts, each phrased as "the request ID from any error response". The
// published document declared it zero times. A generated client had no typed way
// to reach the field its own documentation tells the customer to find.
//
// Same entry, second gap: `middleware/ip-rate-limit.ts` sends BOTH the IETF
// `RateLimit-*` trio and the older `X-RateLimit-*` aliases, and CORS exposes both.
// The document declared only the IETF names — while the `X-RateLimit-Bucket`
// description said, in prose, "sent alongside the X-RateLimit-* aliases of the
// three headers above". A header acknowledged inside another header's description
// is exactly the state V-941 found for Content-Disposition: mentioned, unusable.
//
// THREE ends are asserted, not two. The document, the middleware that sends it,
// and the customer pages that promise it. Any pair alone rots: declare it and stop
// sending it and the contract lies; send it and drop the docs and nobody knows to
// look; keep the docs and drop the declaration and we are back where this started.
//
// SCOPE: X-Request-Id is declared on the shared ERROR responses, which is where
// the documented workflow points. Success responses carry it too and are not
// declared — a stated remainder, because covering them means editing every 2xx
// block in openapi.ts. The count arm below floors at the error-response volume so
// the remainder cannot be mistaken for full coverage.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SPEC = resolve(REPO_ROOT, 'packages/sdk-python/openapi.json');
const REQUEST_ID_MW = resolve(REPO_ROOT, 'apps/server/src/middleware/request-id.ts');
const RATE_LIMIT_MW = resolve(REPO_ROOT, 'apps/server/src/middleware/ip-rate-limit.ts');

/** Customer pages that tell people to quote the request id to support. */
const PROMISING_DOCS = [
  'apps/docs/src/pages/quickstart.md',
  'apps/docs/src/pages/quickstart-curl.md',
  'apps/docs/src/pages/sdk/typescript-quickstart.md',
  'apps/docs/src/pages/sdk/python-quickstart.md',
  'apps/docs/src/pages/sdk/go-quickstart.md',
] as const;

interface SpecShape {
  paths: Record<
    string,
    Record<string, { responses?: Record<string, { headers?: Record<string, unknown> }> }>
  >;
}

/** How many responses declare a given header. */
function declaredCount(header: string): number {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as SpecShape;
  let n = 0;
  for (const ops of Object.values(spec.paths)) {
    for (const op of Object.values(ops)) {
      for (const r of Object.values(op.responses ?? {})) {
        if (Object.keys(r.headers ?? {}).includes(header)) n += 1;
      }
    }
  }
  return n;
}

describe('V-942 the header support asks for is in the contract', () => {
  it('CRITICAL the middleware still sends x-request-id on every response. The declaration arms below are compared against this; declaring a header nothing sends is the same untruth as sending one nothing declares, just pointed the other way.', () => {
    expect(
      readFileSync(REQUEST_ID_MW, 'utf8'),
      'the request-id middleware sets the header',
    ).toMatch(/reply\.header\('x-request-id', request\.id\)/);
  });

  it('CRITICAL the document declares X-Request-Id on its error responses. Five customer pages send people looking for it there, so a client generated from the document has to be able to see it.', () => {
    expect(declaredCount('X-Request-Id'), 'responses declaring X-Request-Id').toBeGreaterThan(800);
  });

  it('CRITICAL the customer pages still promise it. If the docs stop naming the header, this guard is pinning a contract nobody was told to use — and if they keep naming it while the declaration goes, we are back to the original defect. The promise is half the reason the declaration has to exist.', () => {
    for (const rel of PROMISING_DOCS) {
      expect(
        readFileSync(resolve(REPO_ROOT, rel), 'utf8'),
        `${rel} still tells the customer to quote the request id`,
      ).toMatch(/x-request-id/i);
    }
  });

  it('CRITICAL both rate-limit header families are declared, because both are sent. The middleware writes the IETF trio and the older X-RateLimit-* aliases, and CORS exposes both; the aliases used to exist only inside another header’s description.', () => {
    for (const h of [
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
      'X-RateLimit-Bucket',
    ]) {
      expect(declaredCount(h), `responses declaring ${h}`).toBeGreaterThan(200);
    }
    const mw = readFileSync(RATE_LIMIT_MW, 'utf8');
    expect(mw, 'the middleware sends the legacy alias').toMatch(
      /reply\.header\('x-ratelimit-limit'/,
    );
    expect(mw, 'and the IETF name').toMatch(/reply\.header\('ratelimit-limit'/);
  });
});
