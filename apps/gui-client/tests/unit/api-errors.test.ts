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
  it('maps a stable problem type without reflecting detail', async () => {
    const res = makeResponse({
      type: 'https://errors.driftstack.dev/bad-request',
      detail: 'created_before must be greater than created_after at /private/query.ts',
    });
    expect(await readApiErrorMessage(res)).toBe(
      'Some information was not accepted. Check your input and try again.',
    );
  });

  it('classifies an untyped body by status without reflecting title', async () => {
    const res = makeResponse({ title: 'Bad Request' });
    expect(await readApiErrorMessage(res)).toBe(
      'The request could not be completed. Check your input and try again.',
    );
  });

  it('maps a non-JSON service error to fixed retry copy', async () => {
    const res = {
      status: 502,
      headers: new Headers(),
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response;
    expect(await readApiErrorMessage(res)).toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
  });

  it('ignores non-string and hostile diagnostic fields', async () => {
    const res = makeResponse({ detail: 42, title: null }, 418);
    expect(await readApiErrorMessage(res)).toBe(
      'The request could not be completed. Check your input and try again.',
    );
  });

  it('provides fixed actionable copy for auth, limits, and profile conflicts', async () => {
    await expect(
      readApiErrorMessage(makeResponse({ type: 'https://errors.driftstack.dev/invalid-key' }, 401)),
    ).resolves.toBe('Your sign-in or API key was not accepted. Check Settings and try again.');
    await expect(
      readApiErrorMessage(
        makeResponse({ type: 'https://errors.driftstack.dev/concurrency-limit' }, 429),
      ),
    ).resolves.toBe(
      'A usage limit was reached. Wait a moment or review your plan, then try again.',
    );
    await expect(
      readApiErrorMessage(
        makeResponse({ type: 'https://errors.driftstack.dev/profile-in-use' }, 409),
      ),
    ).resolves.toBe('End the profile’s other live session before launching it again.');
  });

  it('does not trust a lookalike or unknown problem namespace', async () => {
    const res = makeResponse(
      {
        type: 'https://attacker.invalid/invalid-key',
        detail: 'api-key=secret internal-host.local /private/key.json',
        title: 'SHOW ME',
      },
      400,
    );
    const message = await readApiErrorMessage(res);
    expect(message).toBe('The request could not be completed. Check your input and try again.');
    expect(message).not.toMatch(/secret|internal-host|private|SHOW ME/i);
  });

  it('treats inherited object keys as unknown problem types', async () => {
    const res = makeResponse(
      {
        type: 'https://errors.driftstack.dev/__proto__',
        detail: 'prototype-shaped diagnostic must not be reflected',
      },
      400,
    );
    await expect(readApiErrorMessage(res)).resolves.toBe(
      'The request could not be completed. Check your input and try again.',
    );
  });

  it('rejects a declared oversized error before pulling or reflecting its body', async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const res = new Response(new ReadableStream<Uint8Array>({ pull, cancel }), {
      status: 502,
      headers: { 'content-length': String(DIAGNOSTIC_JSON_MAX_BYTES + 1) },
    });

    await expect(readApiErrorMessage(res)).resolves.toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
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

    await expect(readApiErrorMessage(res)).resolves.toBe(
      'The service is temporarily unavailable. Try again shortly.',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
});
