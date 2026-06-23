// audit M1 — isCrossNodeSpoof: drop a fleet frame only on a CONFIRMED cross-node
// mismatch (owning node set AND differs). NULL node_id (legacy / manual) and an
// absent reportingNodeId (legacy caller) are both permissive so a legitimate
// relay never regresses. Same predicate the terminal-close guard uses.

import { describe, expect, it } from 'vitest';
import { isCrossNodeSpoof } from '../../src/services/fleet-session-ownership.js';

describe('isCrossNodeSpoof', () => {
  it('TRUE — owning node set and differs from the reporting node (the spoof case)', () => {
    expect(isCrossNodeSpoof('node-1', 'node-evil')).toBe(true);
  });

  it('FALSE — owning node matches the reporting node', () => {
    expect(isCrossNodeSpoof('node-1', 'node-1')).toBe(false);
  });

  it('FALSE — NULL owning node (legacy / never-dispatched / manual session) is allowed', () => {
    expect(isCrossNodeSpoof(null, 'node-1')).toBe(false);
  });

  it('FALSE — undefined owning node is allowed (treated like NULL)', () => {
    expect(isCrossNodeSpoof(undefined, 'node-1')).toBe(false);
  });

  it('FALSE — absent reportingNodeId (legacy caller / no gate wired) never gates', () => {
    expect(isCrossNodeSpoof('node-1', undefined)).toBe(false);
  });
});
