// V-534.BV — unit tests for readApiErrorMessage.

import { describe, expect, it } from 'vitest';
import { readApiErrorMessage } from '../../src/lib/api-errors';

function makeResponse(body: unknown, status = 400): Response {
  return {
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('V-534.BV readApiErrorMessage', () => {
  it('returns detail when present', async () => {
    const res = makeResponse({ detail: 'created_before must be greater than created_after.' });
    expect(await readApiErrorMessage(res)).toBe(
      'created_before must be greater than created_after.',
    );
  });

  it('falls back to title when detail is missing', async () => {
    const res = makeResponse({ title: 'Bad Request' });
    expect(await readApiErrorMessage(res)).toBe('Bad Request');
  });

  it('falls back to HTTP <status> when body is not problem+json', async () => {
    const res = {
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response;
    expect(await readApiErrorMessage(res)).toBe('HTTP 502');
  });

  it('ignores non-string detail/title fields', async () => {
    const res = makeResponse({ detail: 42, title: null }, 418);
    expect(await readApiErrorMessage(res)).toBe('HTTP 418');
  });
});
