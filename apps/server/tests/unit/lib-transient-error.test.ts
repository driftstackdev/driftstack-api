// C5 — isTransientInfraError classification. Only known retry-safe transient
// infra failures (Postgres connectivity/contention, network timeouts) return
// true; everything else (validation, deterministic code bugs) returns false so
// the Stripe dispatcher keeps its default swallow rather than a retry storm.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTransientInfraError } from '../../src/lib/transient-error.js';

function withCode(code: string): Error {
  const e = new Error('boom') as Error & { code: string };
  e.code = code;
  return e;
}

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/lib/transient-error.ts'),
  'utf8',
);

/** Members of a source-declared `new Set([...])` or `[...]` literal. */
function members(name: string): string[] {
  const block = new RegExp(`${name}\\s*=\\s*(?:new Set\\()?\\[([\\s\\S]*?)\\]`).exec(SOURCE);
  expect(block, `the ${name} literal could not be located`).not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/'([0-9A-Za-z_]+)'/g)].map((m) => m[1]!);
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

// The allowlist is enforced whole.
//
// The arms above sample it: 14 of the 25 declared members are named, and 11 are
// not — CONNECTION_ENDED, EPIPE, ENOTFOUND, EHOSTUNREACH, ENETUNREACH, the four
// UND_ERR_* body/header/socket codes, 57P02 and the TimeoutError/SocketError
// names. Any one of them can be deleted from the source set with the whole
// suite green.
//
// The cost of that is asymmetric, which is why sampling is not enough here. A
// member lost means a REAL transient failure is classified permanent, and
// stripe-webhooks.ts:417 then takes the swallow branch: it logs, returns
// `error:<name>`, and handle() writes the processed_stripe_events ledger row.
// That row is the durable "we have seen this" record, so Stripe's ~3-day retry
// window never reopens. A one-second Postgres blip or a DNS hiccup during
// checkout.session.completed leaves a customer who has paid sitting on the old
// tier, with no automated recovery and nothing that looks like an outage.
//
// The undici codes are not decorative: the dispatch path reaches outbound HTTP,
// so a socket or headers timeout is an ordinary way for this to fire.
//
// Two properties, pinned separately because they fail differently:
//
//   honoured   every member the source declares classifies transient. Derived
//              from the literals, so a code added later is covered on arrival.
//   declared   the sets still contain the members they have. The derived arm
//              CANNOT see a deletion — it builds its cases FROM the sets, so a
//              removed code is never constructed and never asserted. Measured,
//              not assumed: with the members below not named, deleting EPIPE
//              leaves this file green.
describe('C5 the transient allowlist is enforced whole, not sampled', () => {
  const declared = {
    TRANSIENT_CODES: [
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECT_TIMEOUT',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ],
    TRANSIENT_SQLSTATE_EXACT: ['57P01', '57P02', '57P03', '40001', '40P01', '55P03'],
    TRANSIENT_NAMES: ['AbortError', 'TimeoutError', 'ConnectTimeoutError', 'SocketError'],
    TRANSIENT_SQLSTATE_PREFIXES: ['08', '53'],
  } as const;

  for (const [name, expected] of Object.entries(declared)) {
    it(`CRITICAL ${name} still declares every member it had`, () => {
      expect(
        expected.filter((m) => !members(name).includes(m)),
        `${name} lost a member. Nothing else in this file can see that — the arms below build ` +
          'their cases from the set itself — so a genuine transient failure would start being ' +
          'classified permanent, the Stripe dispatcher would record the event as processed, and ' +
          'the retry window would never reopen. Removing one is a deliberate act; if that is the ' +
          'intent, remove it here too',
      ).toEqual([]);
    });
  }

  it('CRITICAL every declared code and name classifies as transient', () => {
    const codes = [...members('TRANSIENT_CODES'), ...members('TRANSIENT_SQLSTATE_EXACT')];
    const prefixed = members('TRANSIENT_SQLSTATE_PREFIXES').map((p) => `${p}000`);
    expect(codes.length + prefixed.length, 'the source sets parsed empty').toBeGreaterThanOrEqual(
      20,
    );

    const missedCodes = [...codes, ...prefixed].filter((c) => !isTransientInfraError(withCode(c)));
    expect(
      missedCodes,
      'a code the allowlist declares is not actually classified transient. The set says retry, the ' +
        'function says swallow, and the customer is the one who finds out',
    ).toEqual([]);

    const missedNames = members('TRANSIENT_NAMES').filter(
      (n) => !isTransientInfraError(Object.assign(new Error('x'), { name: n })),
    );
    expect(missedNames, 'a name the allowlist declares is not classified transient').toEqual([]);
  });

  it('CRITICAL the cause walk reaches the full documented depth', () => {
    // `err` plus three causes. drizzle wraps once and undici wraps once, so a
    // drizzle error carrying an undici socket failure is already two deep; the
    // bound is what stops a cyclic chain, not a claim that deeper is impossible.
    const deep = new Error('outer') as Error & { cause: unknown };
    deep.cause = Object.assign(new Error('mid'), {
      cause: Object.assign(new Error('inner'), { cause: withCode('UND_ERR_SOCKET') }),
    });
    expect(
      isTransientInfraError(deep),
      'a transient failure three wrappers deep was read as permanent, so the retry never happens',
    ).toBe(true);
  });
});
