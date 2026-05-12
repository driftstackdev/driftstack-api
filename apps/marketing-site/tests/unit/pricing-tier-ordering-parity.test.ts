// W285.B — drift guard for API_TIERS ordering. Marketing pricing
// page renders tiers in API_TIERS order; that order must follow:
// trial → manual (asc by capacity) → api (asc by capacity) →
// enterprise. Catches drift where a refactor reshuffles tiers and
// pricing rows display in the wrong sequence.

import { describe, expect, it } from 'vitest';
import { API_TIERS } from '../../src/data/pricing';

describe('W285.B API_TIERS sequencing', () => {
  const nonSelfHosted = API_TIERS.filter((t) => t.tierType !== 'self_hosted');

  it('first non-self-hosted tier is the trial pack', () => {
    expect(nonSelfHosted[0]?.id).toBe('trial_pack');
  });

  it('manual tiers precede api tiers', () => {
    const manualLast =
      nonSelfHosted.findLastIndex?.((t) => t.tierType === 'manual') ??
      (() => {
        // Polyfill for older runtimes.
        let i = -1;
        for (let k = 0; k < nonSelfHosted.length; k++) {
          if (nonSelfHosted[k]!.tierType === 'manual') i = k;
        }
        return i;
      })();
    const apiFirst = nonSelfHosted.findIndex((t) => t.tierType === 'api');
    expect(manualLast).toBeGreaterThan(-1);
    expect(apiFirst).toBeGreaterThan(-1);
    expect(manualLast).toBeLessThan(apiFirst);
  });

  it('enterprise tier is last in the non-self-hosted ladder', () => {
    expect(nonSelfHosted[nonSelfHosted.length - 1]?.id).toBe('enterprise');
  });

  it('manual ladder is ordered solo → team → agency', () => {
    const manuals = nonSelfHosted.filter((t) => t.tierType === 'manual').map((t) => t.id);
    expect(manuals).toEqual(['solo_manual', 'team_manual', 'agency_manual']);
  });

  it('api ladder is ordered starter → builder → scale → enterprise', () => {
    // Enterprise is the top of the api ladder (tierType: 'api' with
    // custom concurrency / negotiated commitment).
    const apis = nonSelfHosted.filter((t) => t.tierType === 'api').map((t) => t.id);
    expect(apis).toEqual(['api_starter', 'api_builder', 'api_scale', 'enterprise']);
  });
});
