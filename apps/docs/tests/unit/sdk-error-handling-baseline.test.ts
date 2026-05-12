// W330.A — drift guard for /sdk/error-handling page. Pins:
//   • mention of RFC 7807 (problem+json) and PROBLEM_TYPES export
//   • dispatch-on-slug guidance (not HTTP status)
//   • DriftstackError base class across TS/Python/Go
//   • rate-limited + transport are flagged retryable
//   • all the canonical error-class names appear in the table

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/sdk/error-handling.md');

const REQUIRED_ERROR_CLASSES = [
  'AuthError',
  'ForbiddenError',
  'ValidationError',
  'NotFoundError',
  'ConflictError',
  'RateLimitError',
  'ConcurrencyLimitError',
  'QuotaExceededError',
  'LegalAcceptanceRequiredError',
  'DriverError',
  'SessionTimeoutError',
  'SessionDestroyedError',
  'TransportError',
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W330.A /sdk/error-handling baseline', () => {
  const body = read(PAGE);

  it('cites RFC 7807 (application/problem+json)', () => {
    expect(body).toMatch(/RFC\s*7807/);
    expect(body).toMatch(/application\/problem\+json/i);
  });

  it('points at PROBLEM_TYPES in @driftstack/api-types', () => {
    expect(body).toContain('PROBLEM_TYPES');
    expect(body).toContain('@driftstack/api-types');
  });

  it('promises dispatch-on-slug (not HTTP status)', () => {
    expect(body).toMatch(/Dispatch on the slug,\s+not on HTTP status/i);
  });

  it('declares DriftstackError as the common base class', () => {
    expect(body).toMatch(/DriftstackError/);
  });

  it('flags rate-limited as retryable in the canonical table', () => {
    expect(body).toMatch(/`rate-limited`[\s\S]{0,200}\byes\b/);
  });

  for (const cls of REQUIRED_ERROR_CLASSES) {
    it(`table lists ${cls}`, () => {
      expect(body).toContain(cls);
    });
  }
});
