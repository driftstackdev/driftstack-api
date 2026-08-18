// V-534.BV — unit tests for readApiErrorMessage.

import { describe, expect, it, vi } from 'vitest';
import { fixedApiErrorMessage, readApiErrorMessage } from '../../src/lib/api-errors';
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

  it('CRITICAL a proxy failure names WHICH failure, because the four mean different things to a customer. All four used to render "The proxy could not be verified. Check its details and try again." — which sends someone whose credentials were rejected to go and inspect a proxy that is answering perfectly, and tells someone whose provider refused the tunnel the same. The server has always sent the discriminator in `reason`; the client threw it away. Measured on a real launch failure: reason=egress_blocked, host gate.nodemaven.com, and the customer-visible text said nothing about egress.', () => {
    const t = 'https://errors.driftstack.dev/proxy-validation-failed';
    expect(fixedApiErrorMessage(t, 422, 'auth_failed')).toMatch(
      /rejected the username and password/i,
    );
    expect(fixedApiErrorMessage(t, 422, 'unreachable')).toMatch(/did not answer/i);
    expect(fixedApiErrorMessage(t, 422, 'timeout')).toMatch(/too slow/i);
    expect(fixedApiErrorMessage(t, 422, 'egress_blocked')).toMatch(/could not reach the internet/i);
    // All four must be DISTINCT — a mapping that collapses any two is the bug.
    const all = (['unreachable', 'auth_failed', 'timeout', 'egress_blocked'] as const).map((r) =>
      fixedApiErrorMessage(t, 422, r),
    );
    expect(new Set(all).size, 'each reason needs its own copy').toBe(4);
  });

  it('CRITICAL an absent or unknown reason still gets the safe generic copy, and no server prose is ever rendered. The reason is accepted only when it matches the documented enum — anything else falls back, so a server that starts sending a new value cannot put arbitrary text in front of a customer.', async () => {
    const t = 'https://errors.driftstack.dev/proxy-validation-failed';
    expect(fixedApiErrorMessage(t, 422)).toMatch(/could not be verified/i);
    const res = {
      status: 422,
      json: () =>
        Promise.resolve({ type: t, reason: 'sudden_new_value', detail: 'RAW SERVER PROSE' }),
    } as unknown as Response;
    const msg = await readApiErrorMessage(res);
    expect(msg, 'an unknown reason falls back').toMatch(/could not be verified/i);
    expect(msg, 'server prose is never reflected').not.toMatch(/RAW SERVER PROSE/);
  });
});
