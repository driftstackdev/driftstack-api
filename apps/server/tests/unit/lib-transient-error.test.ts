// C5 — isTransientInfraError classification. Only known retry-safe transient
// infra failures (Postgres connectivity/contention, network timeouts) return
// true; everything else (validation, deterministic code bugs) returns false so
// the Stripe dispatcher keeps its default swallow rather than a retry storm.

import { describe, expect, it } from 'vitest';
import { isTransientInfraError } from '../../src/lib/transient-error.js';

function withCode(code: string): Error {
  const e = new Error('boom') as Error & { code: string };
  e.code = code;
  return e;
}

describe('C5 isTransientInfraError — transient (true)', () => {
  const transient: Array<[string, unknown]> = [
    ['pg connection_exception 08006', withCode('08006')],
    ['pg 08001', withCode('08001')],
    ['pg insufficient_resources 53300', withCode('53300')],
    ['pg admin_shutdown 57P01', withCode('57P01')],
    ['pg cannot_connect_now 57P03', withCode('57P03')],
    ['pg serialization_failure 40001', withCode('40001')],
    ['pg deadlock_detected 40P01', withCode('40P01')],
    ['pg lock_not_available 55P03', withCode('55P03')],
    ['postgres-js CONNECTION_CLOSED', withCode('CONNECTION_CLOSED')],
    ['postgres-js CONNECT_TIMEOUT', withCode('CONNECT_TIMEOUT')],
    ['node ECONNRESET', withCode('ECONNRESET')],
    ['node ETIMEDOUT', withCode('ETIMEDOUT')],
    ['node EAI_AGAIN', withCode('EAI_AGAIN')],
    ['undici UND_ERR_CONNECT_TIMEOUT', withCode('UND_ERR_CONNECT_TIMEOUT')],
    ['AbortError by name', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['ConnectTimeoutError by name', Object.assign(new Error('t'), { name: 'ConnectTimeoutError' })],
  ];
  for (const [label, err] of transient) {
    it(label, () => expect(isTransientInfraError(err)).toBe(true));
  }

  it('finds a transient code wrapped under .cause (drizzle 0.45 shape)', () => {
    const wrapped = new Error('DrizzleQueryError') as Error & { cause: unknown };
    wrapped.cause = withCode('08006');
    expect(isTransientInfraError(wrapped)).toBe(true);
  });

  it('finds a transient errno under .cause (undici "fetch failed" shape)', () => {
    const outer = new TypeError('fetch failed') as TypeError & { cause: unknown };
    outer.cause = withCode('ECONNREFUSED');
    expect(isTransientInfraError(outer)).toBe(true);
  });
});

describe('C5 isTransientInfraError — NOT transient (false)', () => {
  const permanent: Array<[string, unknown]> = [
    ['pg unique_violation 23505', withCode('23505')],
    ['pg not_null_violation 23502', withCode('23502')],
    ['plain TypeError', new TypeError('x.y is not a function')],
    ['plain Error no code', new Error('nope')],
    ['string throw', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['unrelated errno EACCES', withCode('EACCES')],
    ['a 5-char non-transient sqlstate 22001', withCode('22001')],
  ];
  for (const [label, err] of permanent) {
    it(label, () => expect(isTransientInfraError(err)).toBe(false));
  }

  it('does not loop forever on a self-referential cause chain', () => {
    const e = new Error('cycle') as Error & { cause: unknown };
    e.cause = e;
    expect(isTransientInfraError(e)).toBe(false);
  });
});
