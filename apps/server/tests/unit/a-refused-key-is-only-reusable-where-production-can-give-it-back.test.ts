// A refused key is only reusable where production can give it back.
//
// The message route gives an Idempotency-Key back when a keyed message is
// refused before it did any work, so the same key can run once the cause is
// gone. It can only do that when its receipts store has a `release()`:
//
//   the store every integration test runs on   InMemoryAgentTurnReceiptsRepo   has one
//   the store production runs on               DrizzleAgentTurnReceiptsRepo    does not, yet
//
// So today one request has two answers. On the test app the refusal frees the
// key. In production the refusal is STORED, exactly as before, and the same key
// replays it for ever. Every test of the release behaviour is green on a store
// production does not run, and nothing else in the suite can see that: the
// interface marks `release` optional, so both stores type-check.
//
// The harm is in what a customer is TOLD. "Wait, then send again with the same
// key" is right on the test app and an endless replay in production — and one of
// the released refusals is a 429 with a Retry-After, which reads as an invitation
// to do exactly that. "Send again with a NEW key" is right on both: a refusal
// that did no work can never run a task twice, whichever key comes next.
//
// This file turns that into a declared, two-sided fact:
//
//   1. anything the test store can do that the production store cannot is named
//      in KNOWN_GAPS, or this fails;
//   2. a named gap that production has since closed (or the test store has since
//      lost) fails until its entry is removed, so the list cannot outlive its
//      reason;
//   3. while `release` is a named gap, the customer documentation and all three
//      SDKs still tell a customer to send a refused message again with a NEW key.
//
// To describe same-key reuse to customers: land `release()` on the production
// store first (its doc comment on the interface says what it must and must not
// delete), remove the entry below, and arm 3 stops applying.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO, rel), 'utf8');

const TEST_STORE = {
  file: 'apps/server/src/services/agent-turn-receipts.ts',
  className: 'InMemoryAgentTurnReceiptsRepo',
};
const PRODUCTION_STORE = {
  file: 'apps/server/src/db/agent-turn-receipts-repo.ts',
  className: 'DrizzleAgentTurnReceiptsRepo',
};

/**
 * What the test store can do that the production store cannot, and what has to
 * stay true for customers until it can.
 */
// 2026-09-19: `release()` landed on the production store the same day, with a
// read-only completion fallback so a retried completion after a release can never
// plant a phantom reservation. No gap remains; the map stays so the arms keep
// holding the two stores together.
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map([]);

/** The public methods a class declares, from its source with comments stripped. */
function publicMethodsOf(source: string, className: string): string[] {
  const code = codeOnly(source);
  const start = code.indexOf(`export class ${className} `);
  if (start === -1) return [];
  const end = code.indexOf('\n}\n', start);
  const body = code.slice(start, end === -1 ? undefined : end);
  const methods = new Set<string>();
  for (const m of body.matchAll(/^ {2}(?:async )?([a-zA-Z_]\w*)\(/gm)) {
    const name = m[1];
    if (name !== undefined && name !== 'constructor') methods.add(name);
  }
  return [...methods].sort();
}

/** The two ways the declared list can be wrong. Pure, so both can be shown to fire. */
function gapProblems(
  testStore: readonly string[],
  productionStore: readonly string[],
  declared: ReadonlySet<string>,
): { undeclared: string[]; stale: string[] } {
  const production = new Set(productionStore);
  const gaps = testStore.filter((method) => !production.has(method));
  return {
    undeclared: gaps.filter((method) => !declared.has(method)),
    stale: [...declared].filter((method) => !gaps.includes(method)).sort(),
  };
}

/** Prose with comment markers, backticks and line breaks removed, lower-cased. */
function asSentences(text: string): string {
  return text
    .replace(/^\s*(?:\/\/|\*|#)\s?/gm, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const testStoreMethods = publicMethodsOf(read(TEST_STORE.file), TEST_STORE.className);
const productionStoreMethods = publicMethodsOf(
  read(PRODUCTION_STORE.file),
  PRODUCTION_STORE.className,
);

describe('a refused key is only reusable where production can give it back', () => {
  it('CRITICAL the scan found both stores and their methods, and production still runs the store this file reads. A scan that found nothing would report no gaps', () => {
    expect(testStoreMethods, 'the test store').toEqual(
      expect.arrayContaining(['reserve', 'complete']),
    );
    expect(productionStoreMethods, 'the production store').toEqual(
      expect.arrayContaining(['reserve', 'complete']),
    );
    expect(
      codeOnly(read('apps/server/src/lib/bootstrap.ts')),
      'bootstrap no longer constructs this store, so this file is reading the wrong one',
    ).toContain(`new ${PRODUCTION_STORE.className}(`);
    // The route releases only through the optional method, so a store without one
    // keeps the old behaviour rather than failing.
    expect(codeOnly(read('apps/server/src/routes/agent-sessions.ts'))).toMatch(
      /agentTurnReceipts\.release !== undefined/,
    );
  });

  it('the comparison can say all three things: a gap nobody declared, a declared gap that has closed, and nothing to report', () => {
    expect(gapProblems(['reserve', 'release'], ['reserve'], new Set())).toEqual({
      undeclared: ['release'],
      stale: [],
    });
    expect(
      gapProblems(['reserve', 'release'], ['reserve', 'release'], new Set(['release'])),
    ).toEqual({ undeclared: [], stale: ['release'] });
    expect(gapProblems(['reserve'], ['reserve'], new Set(['release']))).toEqual({
      undeclared: [],
      stale: ['release'],
    });
    expect(gapProblems(['reserve', 'release'], ['reserve'], new Set(['release']))).toEqual({
      undeclared: [],
      stale: [],
    });
  });

  it('CRITICAL everything the test store can do that production cannot is declared here, with what it means for customers. An undeclared one is a behaviour the integration tests prove and production does not have', () => {
    const { undeclared } = gapProblems(
      testStoreMethods,
      productionStoreMethods,
      new Set(KNOWN_GAPS.keys()),
    );
    expect(
      undeclared,
      `${TEST_STORE.className} offers these and ${PRODUCTION_STORE.className} does not. Add them to production, or declare them in KNOWN_GAPS with what customers must be told meanwhile:`,
    ).toEqual([]);
  });

  it('CRITICAL a declared gap that no longer exists is removed from the list. When production can release, this fails until the entry goes, and the rule below stops applying in the same change', () => {
    const { stale } = gapProblems(
      testStoreMethods,
      productionStoreMethods,
      new Set(KNOWN_GAPS.keys()),
    );
    expect(
      stale,
      'these are declared as gaps but production now has them (or the test store no longer does). Remove the entry:',
    ).toEqual([]);
  });

  it('CRITICAL while production cannot give a key back, customers are still told to send a refused message again with a NEW key, in the reference and in all three SDKs', () => {
    if (!KNOWN_GAPS.has('release')) {
      // The rule is lifted only by production gaining the method, never by
      // deleting the entry: with no entry, this is what has to be true instead.
      expect(productionStoreMethods, 'the production store').toContain('release');
      return;
    }
    const RULE = 'fix the cause or wait, then send with a new key';
    const sources = [
      'apps/docs/src/pages/reference/idempotency.md',
      'packages/sdk-typescript/src/resources/agent-sessions.ts',
      'packages/sdk-python/src/driftstack/resources/agent_sessions.py',
      'packages/sdk-go/agent_sessions.go',
    ];
    const missing = sources.filter((rel) => !asSentences(read(rel)).includes(RULE));
    expect(
      missing,
      `these no longer say "${RULE}". In production a refused keyed message is still stored and replayed for the same key (${PRODUCTION_STORE.className} has no release()), so "send it again with the same key" would loop on the stored refusal. Keep the new-key rule until release() lands on the production store:`,
    ).toEqual([]);
  });
});
