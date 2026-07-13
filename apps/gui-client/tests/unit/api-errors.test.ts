// V-534.BV — unit tests for readApiErrorMessage.

import { describe, expect, it, vi } from 'vitest';
import { readApiErrorMessage } from '../../src/lib/api-errors';
import { DIAGNOSTIC_JSON_MAX_BYTES } from '../../src/lib/read-bounded-json';

function makeResponse(body: unknown, status = 400): Response {
  return {
    status,
    headers: new Headers(),
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
      headers: new Headers(),
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response;
    expect(await readApiErrorMessage(res)).toBe('HTTP 502');
  });

  it('ignores non-string detail/title fields', async () => {
    const res = makeResponse({ detail: 42, title: null }, 418);
    expect(await readApiErrorMessage(res)).toBe('HTTP 418');
  });

  it('rejects a declared oversized error before pulling or reflecting its body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const res = new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
      status: 502,
      headers: { 'content-length': String(DIAGNOSTIC_JSON_MAX_BYTES + 1) },
    });

    await expect(readApiErrorMessage(res)).resolves.toBe('HTTP 502');
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a chunked oversized error without reflecting upstream text', async () => {
    const cancel = vi.fn();
    let sent = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return;
          sent = true;
          controller.enqueue(new Uint8Array(DIAGNOSTIC_JSON_MAX_BYTES + 1));
        },
        cancel,
      }),
      { status: 503 },
    );

    await expect(readApiErrorMessage(res)).resolves.toBe('HTTP 503');
    expect(cancel).toHaveBeenCalledOnce();
  });
});
