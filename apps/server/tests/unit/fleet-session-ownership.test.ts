// audit M1 — authenticated fleet frames require exact session-node ownership.
// NULL/undefined node_id means no fleet node owns the session and must fail
// closed; only an absent reportingNodeId keeps legacy non-registry behavior.

import { describe, expect, it } from 'vitest';
import { isCrossNodeSpoof } from '../../src/services/fleet-session-ownership.js';

describe('isCrossNodeSpoof', () => {
  it('TRUE — owning node set and differs from the reporting node (the spoof case)', () => {
    expect(isCrossNodeSpoof('node-1', 'node-evil')).toBe(true);
  });

  it('FALSE — owning node matches the reporting node', () => {
    expect(isCrossNodeSpoof('node-1', 'node-1')).toBe(false);
  });

  it('TRUE — NULL owning node cannot authorize an authenticated reporting node', () => {
    expect(isCrossNodeSpoof(null, 'node-1')).toBe(true);
  });

  it('TRUE — undefined owning node cannot authorize an authenticated reporting node', () => {
    expect(isCrossNodeSpoof(undefined, 'node-1')).toBe(true);
  });

  it('FALSE — absent reportingNodeId (legacy caller / no gate wired) never gates', () => {
    expect(isCrossNodeSpoof('node-1', undefined)).toBe(false);
  });
});
