// S14 — deriveAiState (services/ai-account-state.ts): `effective_source` and
// `blocked_reason` for `GET /v1/account/me/ai`. Pure: no database, no clock,
// no request. It composes `decideAiSource` (§4.3, tested on its own in
// decide-ai-source-picks-one-of-six-rules-in-order.test.ts) with the three
// checks that only matter once a task WOULD run on credits, in `reserve()`'s
// own order (S14 audit #4): the concurrency cap, debt, then the balance against
// the cheapest runnable model's minimum to start. The order and the threshold
// are pinned against `reserve()`'s source in
// the-ai-state-blocks-in-the-order-reserve-refuses-at-the-cheapest-models-minimum.test.ts.
//
// Each test fixes every input EXCEPT the one under test, so a failure names
// which rule regressed rather than "some combination of inputs changed".

import { describe, expect, it } from 'vitest';
import { MAX_AI_TASKS_IN_FLIGHT } from '@driftstack/api-types';
import { deriveAiState, type DeriveAiStateInputs } from '../../src/services/ai-account-state.js';

function input(over: Partial<DeriveAiStateInputs> = {}): DeriveAiStateInputs {
  return {
    aiIncluded: true,
    ownKeyAllowed: true,
    aiSource: 'credits',
    ownKeyUsable: false,
    debtMicro: 0,
    tasksInFlight: 0,
    availableMicro: 1_000_000,
    // A one-microcredit minimum keeps every arm below about the rule it names,
    // not the threshold (which has its own file — see the header).
    minStartMicro: 1,
    ...over,
  };
}

describe('deriveAiState — the plan gate wins over everything else', () => {
  it('CRITICAL ai_not_on_plan, with a healthy balance and no debt: the plan gate is asked first', () => {
    expect(deriveAiState(input({ aiIncluded: false }))).toEqual({
      effectiveSource: null,
      blockedReason: 'ai_not_on_plan',
    });
  });

  it('ai_not_on_plan wins even over debt — the plan check runs before any credits-specific one', () => {
    expect(deriveAiState(input({ aiIncluded: false, debtMicro: 5_000_000 }))).toEqual({
      effectiveSource: null,
      blockedReason: 'ai_not_on_plan',
    });
  });
});

describe('deriveAiState — own_key_missing (an explicit or automatic own-key choice with nothing usable)', () => {
  it('CRITICAL own_key_missing when the account chose own_key and the stored key is not usable', () => {
    expect(
      deriveAiState(input({ aiSource: 'own_key', ownKeyUsable: false, availableMicro: 9_000_000 })),
    ).toEqual({ effectiveSource: null, blockedReason: 'own_key_missing' });
  });

  it('own_key_missing wins over a healthy balance and zero debt — a chosen own key never falls back to credits', () => {
    expect(
      deriveAiState(
        input({
          aiSource: 'own_key',
          ownKeyUsable: false,
          availableMicro: 9_000_000,
          debtMicro: 0,
        }),
      ),
    ).toEqual({ effectiveSource: null, blockedReason: 'own_key_missing' });
  });

  it('resolves to own_key with no blocked_reason when the stored key IS usable', () => {
    expect(deriveAiState(input({ aiSource: 'own_key', ownKeyUsable: true }))).toEqual({
      effectiveSource: 'own_key',
      blockedReason: null,
    });
  });

  it('automatic (aiSource: null) resolves to own_key when the plan allows one and it is usable', () => {
    expect(
      deriveAiState(input({ aiSource: null, ownKeyAllowed: true, ownKeyUsable: true })),
    ).toEqual({ effectiveSource: 'own_key', blockedReason: null });
  });

  it('automatic falls through to credits when the plan forbids an own key, even with one usable on file', () => {
    expect(
      deriveAiState(input({ aiSource: null, ownKeyAllowed: false, ownKeyUsable: true })),
    ).toEqual({ effectiveSource: 'credits', blockedReason: null });
  });
});

describe('deriveAiState — an own-key-funded turn is never blocked by debt, the task cap or the balance', () => {
  it('CRITICAL own_key with debt outstanding still resolves clean — debt only ever blocks CREDITS', () => {
    expect(
      deriveAiState(input({ aiSource: 'own_key', ownKeyUsable: true, debtMicro: 10_000_000 })),
    ).toEqual({ effectiveSource: 'own_key', blockedReason: null });
  });

  it('own_key at the task cap still resolves clean — the cap is a credit-reservation-slot concept', () => {
    expect(
      deriveAiState(
        input({
          aiSource: 'own_key',
          ownKeyUsable: true,
          tasksInFlight: MAX_AI_TASKS_IN_FLIGHT,
        }),
      ),
    ).toEqual({ effectiveSource: 'own_key', blockedReason: null });
  });

  it('own_key with a zero balance still resolves clean — no credits are ever spent', () => {
    expect(
      deriveAiState(input({ aiSource: 'own_key', ownKeyUsable: true, availableMicro: 0 })),
    ).toEqual({ effectiveSource: 'own_key', blockedReason: null });
  });
});

describe('deriveAiState — a credits-funded turn: the task cap, then debt, then the balance', () => {
  it('CRITICAL debt blocks a credits turn even with room in the balance and the task cap', () => {
    expect(
      deriveAiState(input({ aiSource: 'credits', debtMicro: 1, availableMicro: 9_000_000 })),
    ).toEqual({ effectiveSource: 'credits', blockedReason: 'debt' });
  });

  it('CRITICAL tasks_in_flight wins over debt when both would otherwise apply — reserve() asks the cap first and answers 429', () => {
    expect(
      deriveAiState(
        input({ aiSource: 'credits', debtMicro: 1, tasksInFlight: MAX_AI_TASKS_IN_FLIGHT }),
      ),
    ).toEqual({ effectiveSource: 'credits', blockedReason: 'tasks_in_flight' });
  });

  it('CRITICAL tasks_in_flight blocks a credits turn at the cap, with no debt and a healthy balance', () => {
    expect(
      deriveAiState(
        input({
          aiSource: 'credits',
          tasksInFlight: MAX_AI_TASKS_IN_FLIGHT,
          availableMicro: 9_000_000,
        }),
      ),
    ).toEqual({ effectiveSource: 'credits', blockedReason: 'tasks_in_flight' });
  });

  it('one below the cap is NOT blocked by tasks_in_flight — the boundary is exact', () => {
    expect(
      deriveAiState(input({ aiSource: 'credits', tasksInFlight: MAX_AI_TASKS_IN_FLIGHT - 1 })),
    ).toEqual({ effectiveSource: 'credits', blockedReason: null });
  });

  it('CRITICAL tasks_in_flight wins over no_credits when both would otherwise apply', () => {
    expect(
      deriveAiState(
        input({ aiSource: 'credits', tasksInFlight: MAX_AI_TASKS_IN_FLIGHT, availableMicro: 0 }),
      ),
    ).toEqual({ effectiveSource: 'credits', blockedReason: 'tasks_in_flight' });
  });

  it('CRITICAL no_credits when the balance is exactly zero, no debt, under the task cap', () => {
    expect(deriveAiState(input({ aiSource: 'credits', availableMicro: 0 }))).toEqual({
      effectiveSource: 'credits',
      blockedReason: 'no_credits',
    });
  });

  it('a balance exactly at the cheapest minimum to start is enough to NOT be no_credits', () => {
    expect(
      deriveAiState(input({ aiSource: 'credits', availableMicro: 1, minStartMicro: 1 })),
    ).toEqual({
      effectiveSource: 'credits',
      blockedReason: null,
    });
  });

  it('a negative available balance is still no_credits (defensive: never spendable)', () => {
    expect(deriveAiState(input({ aiSource: 'credits', availableMicro: -1 }))).toEqual({
      effectiveSource: 'credits',
      blockedReason: 'no_credits',
    });
  });

  it('nothing blocks a credits turn with room in every check', () => {
    expect(deriveAiState(input({ aiSource: 'credits' }))).toEqual({
      effectiveSource: 'credits',
      blockedReason: null,
    });
  });
});
