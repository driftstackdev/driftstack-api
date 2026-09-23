// S14 audit fix #4 — `GET /v1/account/me/ai`'s `blocked_reason` must agree with
// what a task actually gets from `CreditReservationsService.reserve()`.
//
// Two ways it did not:
//   · ORDER. `reserve()` asks, in order: the model, the task cap, debt, then the
//     balance against the model's minimum to start. The GET asked debt BEFORE
//     the task cap, so an account in debt with three tasks running read `debt`
//     while `reserve()` answered `tasks_in_flight` (429).
//   · THRESHOLD. The GET called the balance blocking only at `<= 0`; `reserve()`
//     refuses anything under the model's minimum to start, so 1 µcr read
//     "not blocked" while every task was refused for `balance`.
//
// The GET is not per-model, so its threshold is the SMALLEST minimum among the
// models the account can run on credits right now: below it no task can start,
// at or above it at least one can.
//
// The order is declared ONCE, as `CREDIT_RESERVE_REFUSAL_ORDER` beside
// `reserveEnforce`, and `deriveAiState` walks that array. The last describe
// block pins the declaration to the SOURCE of `reserveEnforce` — the order its
// checks actually run in, read, not assumed — and checks the state service
// keeps no copy of its own.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_AI_TASKS_IN_FLIGHT } from '@driftstack/api-types';
import { deriveAiState, type DeriveAiStateInputs } from '../../src/services/ai-account-state.js';
import { CREDIT_RESERVE_REFUSAL_ORDER as RESERVE_REFUSAL_ORDER } from '../../src/services/credit-reservations.js';

const MICRO = 1_000_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(HERE, '..', '..', 'src');

function input(over: Partial<DeriveAiStateInputs> = {}): DeriveAiStateInputs {
  return {
    aiIncluded: true,
    ownKeyAllowed: true,
    aiSource: 'credits',
    ownKeyUsable: false,
    debtMicro: 0,
    tasksInFlight: 0,
    availableMicro: 100 * MICRO,
    minStartMicro: 3 * MICRO,
    ...over,
  };
}

describe('the order: the task cap, then debt, then the balance — reserve()’s order', () => {
  it('CRITICAL debt AND three tasks running reads tasks_in_flight, which is what reserve() answers (429)', () => {
    expect(
      deriveAiState(input({ debtMicro: 5 * MICRO, tasksInFlight: MAX_AI_TASKS_IN_FLIGHT })),
    ).toEqual({ effectiveSource: 'credits', blockedReason: 'tasks_in_flight' });
  });

  it('debt still wins over an empty balance', () => {
    expect(deriveAiState(input({ debtMicro: 1, availableMicro: 0 }))).toEqual({
      effectiveSource: 'credits',
      blockedReason: 'debt',
    });
  });

  it('the task cap still wins over an empty balance', () => {
    expect(
      deriveAiState(input({ tasksInFlight: MAX_AI_TASKS_IN_FLIGHT, availableMicro: 0 })),
    ).toEqual({ effectiveSource: 'credits', blockedReason: 'tasks_in_flight' });
  });

  it('for EVERY adjacent pair in the mirrored order, the earlier check wins when both fail', () => {
    const failing: Record<(typeof RESERVE_REFUSAL_ORDER)[number], Partial<DeriveAiStateInputs>> = {
      model: { minStartMicro: null },
      tasks_in_flight: { tasksInFlight: MAX_AI_TASKS_IN_FLIGHT },
      debt: { debtMicro: MICRO },
      balance: { availableMicro: 1 },
    };
    const reasonOf: Record<(typeof RESERVE_REFUSAL_ORDER)[number], string> = {
      model: 'no_credits',
      tasks_in_flight: 'tasks_in_flight',
      debt: 'debt',
      balance: 'no_credits',
    };
    for (let i = 0; i + 1 < RESERVE_REFUSAL_ORDER.length; i += 1) {
      const first = RESERVE_REFUSAL_ORDER[i];
      const second = RESERVE_REFUSAL_ORDER[i + 1];
      if (first === undefined || second === undefined) throw new Error('order has a hole');
      const got = deriveAiState(input({ ...failing[second], ...failing[first] })).blockedReason;
      expect(got, `${first} before ${second}`).toBe(reasonOf[first]);
    }
  });
});

describe('the threshold: the cheapest runnable model’s minimum to start', () => {
  it('CRITICAL one microcredit, under a 3-credit minimum, is no_credits — reserve() refuses it for balance', () => {
    expect(deriveAiState(input({ availableMicro: 1 }))).toEqual({
      effectiveSource: 'credits',
      blockedReason: 'no_credits',
    });
  });

  it('CRITICAL one microcredit short of the minimum is still blocked', () => {
    expect(deriveAiState(input({ availableMicro: 3 * MICRO - 1 })).blockedReason).toBe(
      'no_credits',
    );
  });

  it('exactly the minimum is NOT blocked — reserve() refuses only `available < min_start`', () => {
    expect(deriveAiState(input({ availableMicro: 3 * MICRO })).blockedReason).toBeNull();
  });

  it('CRITICAL a card that prices no model the account can run blocks every credits task — never "not blocked"', () => {
    expect(deriveAiState(input({ minStartMicro: null, availableMicro: 100 * MICRO }))).toEqual({
      effectiveSource: 'credits',
      blockedReason: 'no_credits',
    });
  });

  it('none of this touches an own-key-funded account: it is never blocked by the balance or the minimum', () => {
    expect(
      deriveAiState(
        input({ aiSource: 'own_key', ownKeyUsable: true, availableMicro: 0, minStartMicro: null }),
      ),
    ).toEqual({ effectiveSource: 'own_key', blockedReason: null });
  });
});

/** The refusal reasons `reserveEnforce` returns, in source order. */
function reserveEnforceRefusalOrder(source: string): string[] {
  const start = source.indexOf('private async reserveEnforce(');
  if (start < 0) throw new Error('reserveEnforce not found in credit-reservations.ts');
  const end = source.indexOf('\n  private async ', start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  return [...body.matchAll(/this\.refused\(\s*tx,\s*input\.accountId,\s*'([a-z_]+)'/g)].map(
    (m) => m[1] ?? '',
  );
}

describe('the declared order is pinned to reserve()’s own source', () => {
  const source = readFileSync(resolve(SERVER_SRC, 'services/credit-reservations.ts'), 'utf8');

  it('CRITICAL CREDIT_RESERVE_REFUSAL_ORDER equals the order reserveEnforce asks its refusals in, read from the file', () => {
    const order = reserveEnforceRefusalOrder(source);
    // Non-vacuity: the reader found every refusal, not an empty list that
    // would equal an empty mirror.
    expect(order).toHaveLength(4);
    expect([...RESERVE_REFUSAL_ORDER]).toEqual(order);
  });

  it('CRITICAL the state service walks that declaration and keeps no copy of its own', () => {
    const state = readFileSync(resolve(SERVER_SRC, 'services/ai-account-state.ts'), 'utf8');
    expect(state).toContain('for (const check of CREDIT_RESERVE_REFUSAL_ORDER)');
    // A second literal list of the four refusals is how the two drifted.
    expect(state).not.toMatch(/\[\s*'model',\s*'tasks_in_flight'/);
  });

  it('the reader notices a reordering (negative control on a mutated copy)', () => {
    const swapped = source
      .replace("input.accountId, 'debt'", 'input.accountId, __DEBT__')
      .replace("input.accountId, 'tasks_in_flight'", "input.accountId, 'debt'")
      .replace('input.accountId, __DEBT__', "input.accountId, 'tasks_in_flight'");
    expect(reserveEnforceRefusalOrder(swapped)).toEqual([
      'model',
      'debt',
      'tasks_in_flight',
      'balance',
    ]);
    expect([...RESERVE_REFUSAL_ORDER]).not.toEqual(reserveEnforceRefusalOrder(swapped));
  });
});
