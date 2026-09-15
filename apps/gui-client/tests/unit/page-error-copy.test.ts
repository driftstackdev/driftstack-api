// GUI UX pass (Wave 1) — unit tests for pageErrorCopy. The live-session surface
// must NEVER show a raw transport code (e.g. a cryptic -1004) to the operator; the
// default branch collapses any raw harness message to a friendly generic line, and
// HTTP statuses get plain "what happened" copy that still keeps the (user-meaningful)
// number.

import { describe, expect, it } from 'vitest';
import { pageErrorCopy, pageErrorInfoEqual } from '../../src/lib/page-error-copy';

describe('pageErrorCopy', () => {
  it('gives friendly per-kind copy for the known kinds', () => {
    expect(pageErrorCopy({ kind: 'dns' })).toMatch(/couldn't find this site/i);
    expect(pageErrorCopy({ kind: 'tls' })).toMatch(/secure connection failed/i);
    expect(pageErrorCopy({ kind: 'timeout' })).toMatch(/too long to respond/i);
    expect(pageErrorCopy({ kind: 'net' })).toMatch(/network error/i);
  });

  it('leads HTTP errors with plain copy but keeps the meaningful status', () => {
    expect(pageErrorCopy({ kind: 'http', http_status: 404 })).toMatch(/wasn't found \(404\)/i);
    expect(pageErrorCopy({ kind: 'http', http_status: 403 })).toMatch(/denied \(403\)/i);
    expect(pageErrorCopy({ kind: 'http', http_status: 401 })).toMatch(/sign in \(401\)/i);
    expect(pageErrorCopy({ kind: 'http', http_status: 429 })).toMatch(/rate-limiting/i);
    expect(pageErrorCopy({ kind: 'http', http_status: 503 })).toMatch(/having problems.*HTTP 503/i);
    // An unusual status still gets human-led copy.
    expect(pageErrorCopy({ kind: 'http', http_status: 418 })).toMatch(/couldn't load this page/i);
  });

  it('NEVER leaks a raw harness message on an unrecognized kind (the -1004 guard)', () => {
    const copy = pageErrorCopy({ kind: 'mystery', message: 'NSURLErrorDomain -1004' });
    expect(copy).toMatch(/couldn't be loaded/i);
    expect(copy).not.toMatch(/-1004/);
    expect(copy).not.toMatch(/NSURLErrorDomain/);
  });

  it('falls back to the generic line when there is no kind and no message', () => {
    expect(pageErrorCopy({})).toMatch(/couldn't be loaded/i);
  });

  it('compares poll snapshots by their meaningful fields', () => {
    expect(
      pageErrorInfoEqual(
        { kind: 'http', http_status: 503, message: 'upstream unavailable' },
        { kind: 'http', http_status: 503, message: 'upstream unavailable' },
      ),
    ).toBe(true);
    expect(
      pageErrorInfoEqual({ kind: 'dns', message: 'first' }, { kind: 'dns', message: 'next' }),
    ).toBe(false);
    expect(
      pageErrorInfoEqual({ kind: 'http', http_status: 502 }, { kind: 'http', http_status: 503 }),
    ).toBe(false);
  });
});
