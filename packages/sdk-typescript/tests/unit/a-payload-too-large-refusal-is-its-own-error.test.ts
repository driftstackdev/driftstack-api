// A payload-too-large refusal reaches a program as its own error.
//
// Every 413 carries the `payload-too-large` problem type: a body over an
// endpoint's limit, or a file or cookie jar larger than the device running the
// session takes at once. The SDK surfaces it as PayloadTooLargeError, with the
// two sizes when the device is the limit, and — because a 413 used to arrive as
// `bad-request` — still as a BadRequestError, so an existing handler keeps
// catching it.

import { PROBLEM_TYPES } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  PayloadTooLargeError,
  errorFromProblem,
  isRetryable,
} from '../../src/errors.js';

describe('a payload-too-large refusal is its own error', () => {
  it('CRITICAL maps payload-too-large → PayloadTooLargeError with the device’s limit and the size sent', () => {
    const e = errorFromProblem(
      {
        type: PROBLEM_TYPES.PayloadTooLarge,
        title: 'Payload Too Large',
        status: 413,
        detail: 'This file is too large to send to this device (limit 2.95 MiB).',
        limit_bytes: 3_094_176,
        size_bytes: 5_242_880,
      },
      null,
    );
    expect(e).toBeInstanceOf(PayloadTooLargeError);
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e.status).toBe(413);
    expect(e.detail).toBe('This file is too large to send to this device (limit 2.95 MiB).');
    expect((e as PayloadTooLargeError).limitBytes).toBe(3_094_176);
    expect((e as PayloadTooLargeError).sizeBytes).toBe(5_242_880);
    expect(isRetryable(e)).toBe(false);
  });

  it('CRITICAL a 413 without the sizes (a body over the endpoint’s limit) leaves them undefined', () => {
    const e = errorFromProblem(
      { type: PROBLEM_TYPES.PayloadTooLarge, title: 'Payload Too Large', status: 413 },
      null,
    );
    expect(e).toBeInstanceOf(PayloadTooLargeError);
    expect((e as PayloadTooLargeError).limitBytes).toBeUndefined();
    expect((e as PayloadTooLargeError).sizeBytes).toBeUndefined();
  });
});
