// S13–S16 re-audit, round 1, finding 4 — the mirror of S16 audit #10.
//
// A rollback restores the legacy consent the cutover snapshotted, EXCEPT where
// the customer chose their own source while moved (`ai_source_set_by =
// 'customer'`): then the legacy consent is what that choice means,
// `ai_source !== 'own_key'`. S16 #10 fixed only one direction — own_key reads
// back as consent false — and kept the snapshot for every other customer
// choice. So an account moved as `own_key` (a stored key, consent off) whose
// customer then turned the credits fallback ON (`consent:true` on the old
// route, `ai_source` NULL; or `ai_source: 'credits'` on the new one) rolled
// back with consent FALSE: the customer's opt-in, discarded.
//
// A source the cutover (or an admin) set is not the customer's choice and
// keeps the snapshot, whatever it is.

import { describe, expect, it } from 'vitest';
import { legacyConsentOnRollback } from '../../src/services/credit-cutover.js';

describe('a rollback puts back the consent the customer chose while moved', () => {
  it('CRITICAL a customer who turned the fallback on (automatic) rolls back with consent true, over a false snapshot', () => {
    expect(legacyConsentOnRollback({ aiSource: null, aiSourceSetBy: 'customer' }, false)).toBe(
      true,
    );
  });

  it('CRITICAL a customer who chose credits rolls back with consent true, over a false snapshot', () => {
    expect(legacyConsentOnRollback({ aiSource: 'credits', aiSourceSetBy: 'customer' }, false)).toBe(
      true,
    );
  });

  it('a customer who chose their own key rolls back with consent false, over a true snapshot (S16 #10, unchanged)', () => {
    expect(legacyConsentOnRollback({ aiSource: 'own_key', aiSourceSetBy: 'customer' }, true)).toBe(
      false,
    );
  });

  it('whatever the snapshot says, a customer choice decides: every source, both snapshots', () => {
    for (const snapshot of [true, false]) {
      expect(legacyConsentOnRollback({ aiSource: null, aiSourceSetBy: 'customer' }, snapshot)).toBe(
        true,
      );
      expect(
        legacyConsentOnRollback({ aiSource: 'credits', aiSourceSetBy: 'customer' }, snapshot),
      ).toBe(true);
      expect(
        legacyConsentOnRollback({ aiSource: 'own_key', aiSourceSetBy: 'customer' }, snapshot),
      ).toBe(false);
    }
  });

  it('a source the cutover or an admin set is not a customer choice: the snapshot comes back, for every source', () => {
    for (const setBy of ['cutover', 'admin'] as const) {
      for (const aiSource of [null, 'credits', 'own_key'] as const) {
        for (const snapshot of [true, false]) {
          expect(
            legacyConsentOnRollback({ aiSource, aiSourceSetBy: setBy }, snapshot),
            `${setBy} ${String(aiSource)} snapshot=${String(snapshot)}`,
          ).toBe(snapshot);
        }
      }
    }
  });
});
