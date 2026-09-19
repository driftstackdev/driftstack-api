// Which refusals leave an Idempotency-Key free, decided in one place.
//
// The message route stores the first definite result of a keyed request and
// replays it, so a task can never run twice. A refusal raised before the turn did
// anything is released instead, so "wait and try again" with the same key works.
// The route-level behaviour of each refusal is proved in
// tests/integration/a-refusal-that-did-no-work-leaves-the-idempotency-key-free.
//
// This file pins the DEFINITION: the one predicate, the two facts it reads, and
// the interlock that makes a mistake cost a retry rather than a second run.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConflictError, InternalError, RateLimitedError } from '../../src/lib/errors.js';
import {
  agentMessageRefusalDidNoWork,
  markRefusedBeforeAnyWorkForTest,
} from '../../src/routes/agent-sessions.js';
import {
  turnWasDeclinedBeforeItStarted,
  type RunTurnResult,
} from '../../src/services/agent-runtime.js';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTE = codeOnly(
  readFileSync(resolve(HERE, '..', '..', 'src', 'routes', 'agent-sessions.ts'), 'utf8'),
);
const RUNTIME = codeOnly(
  readFileSync(resolve(HERE, '..', '..', 'src', 'services', 'agent-runtime.ts'), 'utf8'),
);

describe('which refusals leave an Idempotency-Key free', () => {
  it('a refusal marked at its throw site did no work when the turn was never handed to the runtime, or the runtime declined before starting', () => {
    const refusal = markRefusedBeforeAnyWorkForTest(new RateLimitedError(1, 'too many turns'));
    expect(agentMessageRefusalDidNoWork(refusal, { turn: 'not-handed-to-the-runtime' })).toBe(true);
    expect(agentMessageRefusalDidNoWork(refusal, { turn: 'declined-before-it-started' })).toBe(
      true,
    );
  });

  it('CRITICAL the interlock: once the turn STARTED, nothing did "no work" — not even a marked refusal. A wrong mark can cost a retry; it can never run a task twice', () => {
    const refusal = markRefusedBeforeAnyWorkForTest(new RateLimitedError(1, 'too many turns'));
    expect(agentMessageRefusalDidNoWork(refusal, { turn: 'started' })).toBe(false);
  });

  it('an UNMARKED problem is final however early it was raised: a closed or paused session, a control conflict, an unexpected fault', () => {
    const early = { turn: 'not-handed-to-the-runtime' } as const;
    expect(agentMessageRefusalDidNoWork(new ConflictError('Agent session is closed.'), early)).toBe(
      false,
    );
    expect(agentMessageRefusalDidNoWork(new InternalError(), early)).toBe(false);
    expect(agentMessageRefusalDidNoWork(new Error('storage went away'), early)).toBe(false);
    expect(agentMessageRefusalDidNoWork(undefined, early)).toBe(false);
    // The mark is on the OBJECT, not the class: another error of a marked class
    // is not marked.
    markRefusedBeforeAnyWorkForTest(new RateLimitedError(1));
    expect(agentMessageRefusalDidNoWork(new RateLimitedError(1), early)).toBe(false);
  });

  it('the runtime says which of its answers come before the turn starts: exactly turn-in-progress and account-turn-limit, and no other kind', () => {
    const session = {} as RunTurnResult['session'];
    const byKind: Record<RunTurnResult['kind'], boolean> = {
      'turn-in-progress': true,
      'account-turn-limit': true,
      'plan-executed': false,
      clarify: false,
      refuse: false,
      'session-closed': false,
      'ai-control-unavailable': false,
      stopped: false,
      'logged-manual': false,
    };
    for (const [kind, declined] of Object.entries(byKind)) {
      expect(
        turnWasDeclinedBeforeItStarted({ kind, session } as unknown as RunTurnResult),
        kind,
      ).toBe(declined);
    }
  });

  it('CRITICAL the runtime gives those two answers ONLY before the turn takes its slot: a "still running" or "too many running" answer returned from inside a started turn would release the key of a turn that had already written, planned or acted', () => {
    // turnWasDeclinedBeforeItStarted is a claim about a KIND. It is true only
    // while every return of that kind sits at the top of runTurn, ahead of the
    // line that makes the session busy. This pins that, so the claim cannot go
    // stale silently when the runtime changes.
    const entry = RUNTIME.indexOf('async runTurn(args: RunTurnArgs)');
    const slotTaken = RUNTIME.indexOf('this.activeTurnSessionIds.add(args.agentSessionId)');
    expect(entry).toBeGreaterThan(-1);
    expect(slotTaken).toBeGreaterThan(entry);
    const declined = [
      ...RUNTIME.matchAll(/return \{\s*kind: '(turn-in-progress|account-turn-limit)'/g),
    ];
    // Two checks for a busy session (before and after the authority read), and
    // one for the account's running-turns limit.
    expect(declined.map((m) => m[1])).toEqual([
      'turn-in-progress',
      'turn-in-progress',
      'account-turn-limit',
    ]);
    for (const match of declined) {
      expect(match.index, `${match[1] ?? ''} is answered before the turn starts`).toBeGreaterThan(
        entry,
      );
      expect(match.index, `${match[1] ?? ''} is answered before the turn starts`).toBeLessThan(
        slotTaken,
      );
    }
    // And no result of either kind is built any other way (a spread, a variable).
    expect([...RUNTIME.matchAll(/kind: 'turn-in-progress',/g)]).toHaveLength(2);
    expect([...RUNTIME.matchAll(/kind: 'account-turn-limit',/g)]).toHaveLength(1);
  });

  it('CRITICAL the route marks exactly the refusals it lists, and completes a receipt only when the predicate says work may have started. Marking another refusal is a deliberate act: it changes what a retry with the same key does, so the count moves with the list in the route’s own comment', () => {
    // Ten throw sites for the eight refusals: "another turn is running" is thrown
    // on both the AI lane and the manual-note lane, and the own-key-only model
    // refusal on both of Driftstack's key legs.
    const marks = [...ROUTE.matchAll(/throw refusedBeforeAnyWork\(/g)];
    expect(marks).toHaveLength(10);
    // Nothing marks a refusal except a throw site: every call of the marker is
    // one of the throws counted above. (Its declaration is generic, so it is not
    // spelled `refusedBeforeAnyWork(`; the test seam is an alias, not a call.)
    expect([...ROUTE.matchAll(/refusedBeforeAnyWork\(/g)]).toHaveLength(marks.length);
    expect(ROUTE).toMatch(/function refusedBeforeAnyWork<E extends ApiError>\(refusal: E\): E \{/);
    // The decision is made in ONE place, from the predicate.
    expect([...ROUTE.matchAll(/agentMessageRefusalDidNoWork\(/g)]).toHaveLength(2); // declaration + the one call
    expect(ROUTE).toMatch(
      /if \(agentMessageRefusalDidNoWork\(error, attempt\) && agentTurnReceipts\.release !== undefined\) \{\s*try \{\s*await agentTurnReceipts\.release\(receiptArgs\);\s*\} catch \(releaseError\) \{/,
    );
    // `started` is written BEFORE the runtime is called, so a throw from inside
    // the turn can only ever read as started.
    const started = ROUTE.indexOf("attempt.turn = 'started'");
    const call = ROUTE.indexOf('await runtime.runTurn(args)', started);
    expect(started).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(started);
    expect(ROUTE.slice(started, call)).not.toMatch(/await /);
    // And the runtime is called from nowhere else in the message path.
    expect([...ROUTE.matchAll(/runtime\.runTurn\(/g)]).toHaveLength(1);
  });

  it('CRITICAL a release, once attempted, is the last thing the request does to its receipt — whether it succeeded or failed. A failed release may have landed, and the key may already be a retry’s, so the refusal is answered and never stored "instead"', () => {
    // The behaviour (a retry that took the freed key keeps its reservation) is
    // proved in tests/integration/giving-an-idempotency-key-back-is-the-last-
    // thing-a-refused-request-does-to-it. This pins the shape that guarantees it:
    // the block that attempts a release ends in `return terminal`, OUTSIDE the
    // try, so neither arm can reach the `complete` below it.
    const attemptAt = ROUTE.indexOf('await agentTurnReceipts.release(receiptArgs);');
    const completeAt = ROUTE.indexOf('await agentTurnReceipts.complete(', attemptAt);
    expect(attemptAt).toBeGreaterThan(-1);
    expect(completeAt).toBeGreaterThan(attemptAt);
    const afterTheAttempt = ROUTE.slice(attemptAt, completeAt);
    // try { release } catch { log } return terminal; } }   — and nothing else.
    expect(afterTheAttempt).toMatch(
      /^await agentTurnReceipts\.release\(receiptArgs\);\s*\} catch \(releaseError\) \{\s*req\.log\.warn\(/,
    );
    expect(afterTheAttempt).toMatch(/\);\s*\}\s*return terminal;\s*\}\s*\}\s*$/);
    expect([...afterTheAttempt.matchAll(/return terminal;/g)]).toHaveLength(1);
    // The receipt is written in exactly one place, and released in exactly one.
    expect([...ROUTE.matchAll(/agentTurnReceipts\.complete\(/g)]).toHaveLength(1);
    expect([...ROUTE.matchAll(/agentTurnReceipts\.release\(/g)]).toHaveLength(1);
  });
});
