// "Proxy should be auto checked after creating a new profile. And after adding
// the new proxy." (owner item N-3.)
//
// A post-create probe already existed — and probed the wrong proxy. It read
// `proxies[0]`, the FIRST saved proxy from the parent render's closure, while
// the create had resolved a different one: the proxy the customer explicitly
// picked, or one minted inline via "+ Add new proxy…" that was not even in
// `proxies` yet. So the card got a probe result for a proxy the profile would
// never launch through, or none at all. The edit modal's inline add probed
// nothing.
//
// The decision is now a pure function of (resolved, first), and the probe is
// guarded once for both call sites because handleTestProxy has no single-flight
// of its own. These arms pin the decision, not the 6k-line view.

import { describe, it, expect } from 'vitest';
import { chooseAutoProbeTarget, shouldAutoProbe } from '../../src/views/ProfilesView';
import type { ProxyConfig } from '../../src/lib/proxies';

const px = (id: string): ProxyConfig =>
  ({
    id,
    label: id,
    scheme: 'socks5',
    host: '203.0.113.1',
    port: 1080,
    username: null,
    password: null,
  }) as unknown as ProxyConfig;

describe('the probe targets the proxy the profile will actually launch through', () => {
  it('prefers the RESOLVED proxy over the first saved one', () => {
    // The bug: `first` was always chosen. An explicit pick must win.
    const picked = px('picked');
    const first = px('first');
    expect(chooseAutoProbeTarget(picked, first)?.id).toBe('picked');
  });

  it('targets a proxy minted inline even though it is not in the saved list yet', () => {
    // The create modal mints via addProxy and passes the object out; the
    // parent's `proxies` has not refreshed. It must still be probed.
    const minted = px('minted-just-now');
    expect(chooseAutoProbeTarget(minted, px('first'))?.id).toBe('minted-just-now');
  });

  it('falls back to the first saved proxy for a "first available" profile', () => {
    // Vacuity control: null resolved (no explicit binding) is the one case
    // where `first` IS the right answer — it is what launch will use.
    expect(chooseAutoProbeTarget(null, px('first'))?.id).toBe('first');
    expect(chooseAutoProbeTarget(undefined, undefined)).toBeUndefined();
  });
});

describe('the probe is guarded once for both call sites', () => {
  it('skips a proxy that already has a cached result', () => {
    const p = px('cached');
    expect(shouldAutoProbe(p, { cached: { at: 1 } } as never, null)).toBe(false);
  });

  it('skips a proxy whose test is already in flight', () => {
    // Post-create and post-add can now target the same proxy; without this a
    // double probe races two writes into the shared cache.
    const p = px('busy');
    expect(shouldAutoProbe(p, {}, 'busy')).toBe(false);
  });

  it('probes an unprobed, idle proxy', () => {
    // Vacuity control for the two above.
    expect(shouldAutoProbe(px('fresh'), {}, null)).toBe(true);
    expect(shouldAutoProbe(px('fresh'), {}, 'some-other-id')).toBe(true);
  });
});
